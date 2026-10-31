import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {CredentialStore} from '../app/credentials.mjs';
import {BSiteHttpTransport} from '../app/v1/b-site-http-transport.mjs';
import {BSiteWsTransport} from '../app/v1/b-site-ws-transport.mjs';

function fixture(t, Transport = BSiteWsTransport) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chathand-site-scope-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const credentials = new CredentialStore(dir), writer = new CredentialStore(dir);
  const savedValue = {installation_id: crypto.randomUUID(), site_id: 'fixture-site',
    site_origin: 'https://fixture.invalid', owner_subject: 'fixture-owner',
    binding_id: 'fixture-binding', generation: 1, device_credential: 'fixture-device',
    private_pkcs8: 'fixture-private-key', result_key: 'fixture-result-key'};
  const machineValue = {site_id: savedValue.site_id, site_origin: savedValue.site_origin,
    bearer: 'fixture-machine-token'.padEnd(40, 'A')};
  const relay = {id: 'fixture-relay', session: {access_token: 'fixture-relay-token'}};
  for (const [section, value] of Object.entries({site_b: savedValue, site_b_machine: machineValue, relay}))
    credentials.set(section, value);
  const saved = credentials.get('site_b'), machine = credentials.get('site_b_machine');
  const transport = new Transport({installationId: saved.installation_id, credentials,
    localStore: {root: dir, route: () => ({configured: 1, ...savedValue})}, autoPoll: false});
  transport.running = true; transport.epoch = 1;
  const controller = transport.sessionController = new AbortController();
  transport.sessionMaterial = {saved, machine, revision: credentials.revisionOf(saved), controller};
  return {dir, credentials, writer, saved, machine, savedValue, machineValue, relay, transport, controller};
}

test('identical section writes preserve authenticated bytes/revision while stale CAS still rejects', t => {
  const f = fixture(t), revision = f.credentials.revision();
  const file = path.join(f.dir, 'credentials.json'), before = fs.readFileSync(file);
  f.credentials.set('relay', {session: {...f.relay.session}, id: f.relay.id});
  assert.equal(f.credentials.revision(), revision);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(f.credentials.status().verified, true);
  assert.equal(f.credentials.isCurrent(f.saved), true);
  f.writer.set('relay', {...f.relay, id: 'fixture-refreshed-relay'});
  assert.throws(() => f.credentials.set('site_b', f.saved), {code: 'CREDENTIAL_CONFLICT'});
});

for (const Transport of [BSiteHttpTransport, BSiteWsTransport])
test(Transport.name + ' keeps Site authority after unrelated relay/tunnel changes', t => {
  const f = fixture(t, Transport);
  let decrypts = 0, gets = 0;
  const read = f.credentials.readEncrypted.bind(f.credentials), get = f.credentials.get.bind(f.credentials);
  f.credentials.readEncrypted = () => { decrypts++; return read(); };
  f.credentials.get = (...args) => { gets++; return get(...args); };
  for (const section of ['relay', 'tunnel']) {
    f.writer.set(section, {fixture_token: 'fixture-refreshed-' + section});
    assert.equal(f.credentials.isCurrent(f.saved), false, 'whole-store CAS remains strict');
    f.transport.current(f.saved, 1);
    assert.equal(f.controller.signal.aborted, false);
    assert.equal(f.transport.machine(f.saved), f.machine.bearer);
    const before = decrypts;
    for (let i = 0; i < 30; i++) {
      f.transport.current(f.saved, 1); f.transport.machine(f.saved);
    }
    assert.equal(decrypts, before, 'scope proof is cached only for the current authenticated revision');
  }
  assert.equal(gets, 0, 'established session material remains usable');
  assert.equal(decrypts, 2, 'each new unrelated revision is authenticated once');
});

for (const field of Object.keys({
  device_credential: true,
  private_pkcs8: true,
  result_key: true,
  binding_id: true,
}))
test('same-generation Site ' + field + ' rotation fences the old session', t => {
  const f = fixture(t);
  f.writer.set('relay', {...f.relay, id: 'fixture-unrelated-refresh'});
  f.transport.current(f.saved, 1);
  f.writer.set('site_b', {...f.savedValue, [field]: 'fixture-rotated-' + field});
  assert.throws(() => f.transport.current(f.saved, 1), {code: 'B_LIFECYCLE_CHANGED'});
  assert.equal(f.controller.signal.aborted, true);
  assert.equal(f.transport.sessionMaterial, null);
});

for (const change of ['rotate-machine', 'remove-machine', 'remove-site', 'corrupt', 'unsafe-marker'])
test('relevant credential failure ' + change + ' never inherits an unrelated scope proof', t => {
  const f = fixture(t);
  f.writer.set('relay', {...f.relay, id: 'fixture-unrelated-refresh'});
  f.transport.current(f.saved, 1);
  if (change === 'rotate-machine') f.writer.set('site_b_machine', {...f.machineValue, bearer: 'fixture-rotated'.padEnd(40, 'B')});
  if (change === 'remove-machine') f.writer.remove('site_b_machine');
  if (change === 'remove-site') f.writer.remove('site_b');
  if (change === 'corrupt') fs.writeFileSync(path.join(f.dir, 'credentials.json'), '{"schema":1,"algorithm":"aes-256-gcm","tag":"bad"}');
  if (change === 'unsafe-marker') {
    fs.unlinkSync(path.join(f.dir, 'credential-revision.json'));
    fs.symlinkSync(path.join(f.dir, 'credentials.json'), path.join(f.dir, 'credential-revision.json'));
  }
  assert.throws(() => f.transport.current(f.saved, 1), {code: 'B_LIFECYCLE_CHANGED'});
  assert.equal(f.controller.signal.aborted, true);
  assert.equal(f.transport.sessionMaterial, null);
});

test('scoped proofs do not upgrade snapshots for a stale write or unknown credential objects', t => {
  const f = fixture(t);
  f.writer.set('relay', {fixture_token: 'fixture-refresh'});
  assert.equal(f.credentials.isCurrentScope(f.saved, ['site_b', 'site_b_machine']), true);
  assert.equal(f.credentials.isCurrent(f.saved), false);
  assert.throws(() => f.credentials.set('site_b', f.saved), {code: 'CREDENTIAL_CONFLICT'});
  assert.equal(f.credentials.isCurrentScope({...f.saved}, ['site_b', 'site_b_machine']), undefined);
});
