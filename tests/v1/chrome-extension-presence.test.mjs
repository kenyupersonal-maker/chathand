import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ChromeExtensionPresence} from '../../app/v1/chrome-extension-presence.mjs';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const entry = record => ({extensions: {settings: {[ID]: record}}});
function fixture(t, ids = ['Default'], options = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chathand-presence-')));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const root = path.join(home, 'Library/Application Support/Google/Chrome');
  fs.mkdirSync(root, {recursive: true});
  function write(profile, name, value) {
    const file = path.join(root, profile, name);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  }
  write('', 'Local State', {profile: {info_cache: Object.fromEntries(ids.map(id => [id, {name: 'Not retained'}]))}});
  let clock = 100_000;
  const reader = new ChromeExtensionPresence({home, extension_id: ID, now: () => clock, ...options});
  return {home, root, write, reader, tick: ms => { clock += ms; }, refresh: data => reader.refresh({optedIn: true, ...data})};
}

for (const [reasons, expected] of [[[], 'enabled'], [[1], 'disabled'], [0, 'enabled'], [1, 'disabled'], [32, 'disabled']]) {
  test(`disable_reasons ${JSON.stringify(reasons)} is ${expected}`, t => {
    const f = fixture(t);
    f.write('Default', 'Secure Preferences', entry({disable_reasons: reasons}));
    assert.equal(f.refresh().state, expected);
  });
}
for (const state of [0, 1]) {
  test(`legacy state ${state}`, t => {
    const f = fixture(t);
    f.write('Default', 'Secure Preferences', entry({state}));
    assert.equal(f.refresh().state, state ? 'enabled' : 'disabled');
  });
}
for (const record of [{disable_reasons: null}, {disable_reasons: '0', state: 1}, {disable_reasons: -1}, {disable_reasons: 0.5}, {state: '1'}, null]) {
  test(`malformed extension record ${JSON.stringify(record)} stays unknown`, t => {
    const f = fixture(t);
    f.write('Default', 'Secure Preferences', entry(record));
    f.write('Default', 'Preferences', entry({disable_reasons: []}));
    assert.equal(f.refresh().state, 'unknown');
  });
}

test('one enabled profile wins over disabled and unreadable profiles', t => {
  const f = fixture(t, ['Default', 'Profile 1', 'Profile 2']);
  f.write('Default', 'Secure Preferences', entry({disable_reasons: [1]}));
  f.write('Profile 1', 'Secure Preferences', entry({disable_reasons: []}));
  assert.equal(f.refresh().state, 'enabled');
});
test('disabled array and bitmask across all installed profiles', t => {
  const f = fixture(t, ['Default', 'Profile 7']);
  f.write('Default', 'Secure Preferences', entry({disable_reasons: [1]}));
  f.write('Profile 7', 'Secure Preferences', entry({disable_reasons: 2}));
  assert.equal(f.refresh().state, 'disabled');
});
test('known disabled is reported even when another profile cannot be read', t => {
  const f = fixture(t, ['Default', 'Profile 1']);
  f.write('Default', 'Secure Preferences', entry({disable_reasons: 1}));
  assert.equal(f.refresh().state, 'disabled');
});
test('complete readable records without the extension are missing', t => {
  const f = fixture(t, ['Default', 'Profile 7']);
  for (const id of ['Default', 'Profile 7']) {
    f.write(id, 'Secure Preferences', {});
    f.write(id, 'Preferences', {});
  }
  assert.equal(f.refresh().state, 'missing');
});
test('readable empty Secure Preferences with absent Preferences is missing', t => {
  const f = fixture(t);
  f.write('Default', 'Secure Preferences', {});
  assert.equal(f.refresh().state, 'missing');
});
test('unreadable profile and no match elsewhere are unknown', t => {
  const f = fixture(t, ['Default', 'Profile 1']);
  f.write('Default', 'Secure Preferences', {});
  assert.equal(f.refresh().state, 'unknown');
});
for (const secure of ['absent', 'malformed', 'no target']) {
  test(`Preferences fallback when Secure Preferences is ${secure}`, t => {
    const f = fixture(t);
    if (secure === 'malformed') f.write('Default', 'Secure Preferences', '{');
    if (secure === 'no target') f.write('Default', 'Secure Preferences', {});
    f.write('Default', 'Preferences', entry({disable_reasons: []}));
    assert.equal(f.refresh().state, 'enabled');
  });
}
test('Secure Preferences disabled is authoritative over stale Preferences enabled', t => {
  const f = fixture(t);
  f.write('Default', 'Secure Preferences', entry({disable_reasons: [1]}));
  f.write('Default', 'Preferences', entry({disable_reasons: []}));
  assert.equal(f.refresh().state, 'disabled');
});
for (const bad of ['symlink', 'oversized', 'json', 'directory']) {
  test(`rejects ${bad} Chrome records`, t => {
    const f = fixture(t);
    const file = f.write('Default', 'Secure Preferences', {});
    if (bad === 'json') fs.writeFileSync(file, '{');
    if (bad === 'oversized') fs.truncateSync(file, 16 * 1024 * 1024 + 1);
    if (bad === 'symlink') {
      const other = f.write('', 'Other', entry({disable_reasons: []}));
      fs.unlinkSync(file);
      fs.symlinkSync(other, file);
    }
    if (bad === 'directory') { fs.unlinkSync(file); fs.mkdirSync(file); }
    assert.equal(f.refresh().state, 'unknown');
  });
}
test('Local State symlink and malformed JSON are unknown', t => {
  const f = fixture(t);
  const file = path.join(f.root, 'Local State');
  fs.writeFileSync(file, '{');
  assert.equal(f.refresh().state, 'unknown');
  const other = f.write('', 'Other', {profile: {info_cache: {Default: {}}}});
  fs.unlinkSync(file);
  fs.symlinkSync(other, file);
  assert.equal(f.refresh({force: true}).state, 'unknown');
});
test('refuses realpath mismatch without opening the file', t => {
  let opens = 0;
  const io = {...fs, realpathSync: file => `${file}-other`, openSync: (...args) => { opens++; return fs.openSync(...args); }};
  const f = fixture(t, ['Default'], {io});
  assert.equal(f.refresh().state, 'unknown');
  assert.equal(opens, 0);
});
test('descriptor identity mismatch is rejected and closed before reading', t => {
  let reads = 0;
  let closes = 0;
  const io = {...fs,
    fstatSync: fd => { const stat = fs.fstatSync(fd); stat.ino++; return stat; },
    readFileSync: (...args) => { reads++; return fs.readFileSync(...args); },
    closeSync: fd => { closes++; fs.closeSync(fd); },
  };
  const f = fixture(t, ['Default'], {io});
  assert.equal(f.refresh().state, 'unknown');
  assert.equal(reads, 0);
  assert.equal(closes, 1);
});
test('permission failure is unknown and recovers on next scan', t => {
  let denied = true;
  const io = {...fs, openSync: (...args) => {
    if (denied && String(args[0]).endsWith('Secure Preferences')) throw Object.assign(new Error('denied'), {code: 'EACCES'});
    return fs.openSync(...args);
  }};
  const f = fixture(t, ['Default'], {io});
  f.write('Default', 'Secure Preferences', entry({disable_reasons: []}));
  assert.equal(f.refresh().state, 'unknown');
  denied = false;
  assert.equal(f.refresh({force: true}).state, 'enabled');
});
test('only whitelisted profile IDs are touched, limited to 100', t => {
  const touched = [];
  const io = {...fs, lstatSync: file => { touched.push(file); return fs.lstatSync(file); }};
  const ids = ['../escape', 'Profile 01', 'Profile -1', 'Profile 1000000', ...Array.from({length: 101}, (_, i) => `Profile ${i}`)];
  const f = fixture(t, ids, {io});
  for (let i = 0; i < 101; i++) f.write(`Profile ${i}`, 'Secure Preferences', {});
  assert.equal(f.refresh().state, 'unknown');
  assert.equal(touched.some(file => file.includes('Profile 100/')), false);
  assert.equal(touched.some(file => file.includes('escape') || file.includes('Profile 01/') || file.includes('Profile -1/')), false);
});
test('invalid and empty profile lists do not imply missing', t => {
  const f = fixture(t, []);
  assert.equal(f.refresh().state, 'unknown');
  f.write('', 'Local State', {profile: {info_cache: []}});
  assert.equal(f.refresh({force: true}).state, 'unknown');
});
test('opt-in and connection gates perform zero IO', () => {
  const io = new Proxy({}, {get() { assert.fail('must not touch IO'); }});
  const reader = new ChromeExtensionPresence({home: '/fixture', extension_id: ID, io});
  assert.equal(reader.refresh(), undefined);
  assert.equal(reader.refresh({optedIn: false, force: true}), undefined);
  assert.equal(reader.refresh({optedIn: true, connected: true, force: true}), undefined);
});
test('10 second throttle avoids all IO, unchanged metadata avoids reread, force bypasses throttle', t => {
  let reads = 0;
  let stats = 0;
  const io = {...fs,
    readFileSync: (...args) => { reads++; return fs.readFileSync(...args); },
    lstatSync: (...args) => { stats++; return fs.lstatSync(...args); },
  };
  const f = fixture(t, ['Default'], {io});
  const file = f.write('Default', 'Secure Preferences', entry({disable_reasons: []}));
  assert.equal(f.refresh().state, 'enabled');
  const initialReads = reads;
  const initialStats = stats;
  f.tick(9999);
  assert.equal(f.refresh({chromeRunning: true}).checked_at, 100_000);
  assert.equal(stats, initialStats);
  f.tick(1);
  assert.equal(f.refresh().checked_at, 110_000);
  assert.equal(reads, initialReads);
  assert.ok(stats > initialStats);
  fs.writeFileSync(file, JSON.stringify(entry({disable_reasons: [1, 2]})));
  assert.equal(f.refresh().state, 'enabled');
  assert.equal(f.refresh({force: true}).state, 'disabled');
  assert.equal(reads, initialReads + 1);
});
test('ctime changes trigger reparse even if size and mtime stay the same', t => {
  let offset = 0;
  let reads = 0;
  const change = stat => { stat.ctimeMs += offset; return stat; };
  const io = {...fs,
    lstatSync: file => change(fs.lstatSync(file)),
    fstatSync: fd => change(fs.fstatSync(fd)),
    readFileSync: (...args) => { reads++; return fs.readFileSync(...args); },
  };
  const f = fixture(t, ['Default'], {io});
  f.write('Default', 'Secure Preferences', entry({disable_reasons: []}));
  f.refresh();
  offset = 1;
  f.refresh({force: true});
  assert.equal(reads, 4);
});
test('stalled starts at continuous enabled/running observation and updates during throttle', t => {
  const f = fixture(t);
  f.write('Default', 'Secure Preferences', entry({disable_reasons: []}));
  assert.deepEqual(f.refresh(), {state: 'enabled', chrome_running: false, stalled: false, checked_at: 100_000});
  f.tick(1);
  assert.equal(f.refresh({chromeRunning: true}).stalled, false);
  f.tick(39_999);
  assert.equal(f.refresh({chromeRunning: true}).stalled, false);
  f.tick(1);
  assert.equal(f.refresh({chromeRunning: true}).stalled, true);
  assert.equal(f.refresh({chromeRunning: false}).stalled, false);
  assert.equal(f.refresh({chromeRunning: true}).stalled, false);
});
test('connection, opt-out, resetStalled and nonenabled state reset the timer', t => {
  const f = fixture(t);
  f.write('Default', 'Secure Preferences', entry({disable_reasons: []}));
  const running = () => f.refresh({chromeRunning: true});
  for (const clear of [
    () => f.refresh({connected: true}),
    () => f.reader.refresh({optedIn: false}),
    () => f.reader.resetStalled(),
    () => { f.write('Default', 'Secure Preferences', entry({disable_reasons: [1]})); f.refresh({force: true, chromeRunning: true}); f.write('Default', 'Secure Preferences', entry({disable_reasons: []})); },
  ]) {
    f.refresh({force: true, chromeRunning: true});
    f.tick(40_000);
    assert.equal(running().stalled, true);
    clear();
    assert.equal(f.refresh({force: true, chromeRunning: true}).stalled, false);
  }
});

for (const extension_id of [undefined, '', 'pending', '../outside']) {
  test(`invalid extension ID ${String(extension_id)} performs zero IO`, () => {
    const io = new Proxy({}, {get() { assert.fail('must not touch IO'); }});
    const reader = new ChromeExtensionPresence({home: '/fixture', extension_id, io, now: () => 5});
    assert.equal(reader.refresh(), undefined);
    assert.deepEqual(reader.refresh({optedIn: true}), {state: 'unknown', chrome_running: false, stalled: false, checked_at: 5});
  });
}
for (const failure of ['permission', 'malformed']) {
  test(`empty Secure Preferences with ${failure} Preferences stays unknown`, t => {
    const io = {...fs, openSync: (...args) => {
      if (failure === 'permission' && String(args[0]).endsWith('/Preferences')) throw Object.assign(new Error('denied'), {code: 'EACCES'});
      return fs.openSync(...args);
    }};
    const f = fixture(t, ['Default'], {io});
    f.write('Default', 'Secure Preferences', {});
    f.write('Default', 'Preferences', '{');
    assert.equal(f.refresh().state, 'unknown');
  });
}
test('metadata cache refreshes profile list after Local State changes', t => {
  const f = fixture(t);
  f.write('Default', 'Secure Preferences', {});
  assert.equal(f.refresh().state, 'missing');
  f.write('', 'Local State', {profile: {info_cache: {Default: {}, 'Profile 7': {}}}});
  f.write('Profile 7', 'Secure Preferences', entry({disable_reasons: []}));
  assert.equal(f.refresh({force: true}).state, 'enabled');
  f.write('', 'Local State', {profile: {info_cache: {Default: {}}}});
  assert.equal(f.refresh({force: true}).state, 'missing');
});
test('symlinked profile directory is rejected', t => {
  const f = fixture(t);
  const other = path.join(f.root, 'OtherProfile');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'Secure Preferences'), JSON.stringify(entry({disable_reasons: []})));
  fs.symlinkSync(other, path.join(f.root, 'Default'));
  assert.equal(f.refresh().state, 'unknown');
});
test('replacement during open is rejected even if the opened descriptor is valid', t => {
  let replaced = false;
  const io = {...fs, openSync: (file, flags) => {
    const descriptor = fs.openSync(file, flags);
    if (!replaced && file.endsWith('Secure Preferences')) {
      replaced = true;
      fs.renameSync(file, `${file}.old`);
      fs.writeFileSync(file, JSON.stringify(entry({disable_reasons: []})));
    }
    return descriptor;
  }};
  const f = fixture(t, ['Default'], {io});
  f.write('Default', 'Secure Preferences', entry({disable_reasons: [1]}));
  assert.equal(f.refresh().state, 'unknown');
  assert.equal(f.refresh({force: true}).state, 'enabled');
});

// Development Mac acceptance: enabling the extension updated it to 1092; Chrome
// kept its Secure Preferences record but removed disable_reasons and state.
for (const record of [{}, {manifest: {version: '1.0.0.1092'}, location: 1}]) {
  test(`installed record without either disable flag is enabled: ${JSON.stringify(record)}`, t => {
    const f = fixture(t);
    f.write('Default', 'Secure Preferences', entry(record));
    f.write('Default', 'Preferences', {});
    assert.equal(f.refresh().state, 'enabled');
  });
}
test('reenabling removes disable flags and refreshes from disabled to enabled', t => {
  const f = fixture(t);
  f.write('Default', 'Secure Preferences', entry({disable_reasons: [1]}));
  f.write('Default', 'Preferences', {});
  assert.equal(f.refresh().state, 'disabled');
  f.write('Default', 'Secure Preferences', entry({manifest: {version: '1.0.0.1092'}}));
  assert.equal(f.refresh({force: true}).state, 'enabled');
});
for (const state of [null, false, 2]) {
  test(`present invalid legacy state ${JSON.stringify(state)} stays unknown`, t => {
    const f = fixture(t);
    f.write('Default', 'Secure Preferences', entry({state}));
    assert.equal(f.refresh().state, 'unknown');
  });
}
