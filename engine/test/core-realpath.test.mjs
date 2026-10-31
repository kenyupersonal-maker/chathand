// Regression for macOS /var -> /private/var aliases. The symlink is explicit,
// so Linux catches the same bug even when its own /tmp is not a symlink.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {FileStore, digest} from '../src/core.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ken-realpath-'));
  t.after(() => fs.rmSync(base, {recursive:true, force:true}));
  const physical = path.join(fs.realpathSync(base), 'physical 中文 space');
  const alias = path.join(base, 'alias 路径');
  fs.mkdirSync(physical);
  fs.symlinkSync(physical, alias, 'dir');
  const root = path.join(physical, 'workspace');
  const state = path.join(physical, 'state');
  fs.mkdirSync(root);
  const aliasState = path.join(alias, 'state');
  assert.notEqual(path.resolve(alias), fs.realpathSync(alias), 'fixture must really contain an alias');
  return {base, physical, alias, root, state, aliasState};
}

const overlap = {code:'ROOT_STATE_OVERLAP'};

test('realpath: state and receipt directories use canonical parent paths', t => {
  const f = fixture(t);
  const store = new FileStore(f.root, f.aliasState);
  assert.equal(store.stateDir, fs.realpathSync(f.aliasState));
  assert.equal(store.opsDir, path.join(fs.realpathSync(f.aliasState), 'receipts'));
  assert.equal(store.auditFile, path.join(fs.realpathSync(f.aliasState), 'audit.jsonl'));
});

for (const [name, project] of [
  ['equal physical path', f => f.state],
  ['equal alias path', f => f.aliasState],
  ['ancestor path', f => f.physical],
  ['descendant path', f => path.join(f.state, 'child')],
]) {
  test('realpath: constructor rejects overlapping ' + name, t => {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.state, 'child'), {recursive:true});
    assert.throws(() => new FileStore(project(f), f.aliasState), overlap);
  });
}

for (const [name, project] of [
  ['equal physical path', f => f.state],
  ['equal alias path', f => f.aliasState],
  ['physical ancestor', f => f.physical],
  ['alias ancestor', f => f.alias],
  ['physical descendant', f => path.join(f.state, 'child')],
  ['alias descendant', f => path.join(f.aliasState, 'child')],
]) {
  test('realpath: setRoot rejects ' + name + ' without changing project', t => {
    const f = fixture(t);
    const store = new FileStore(f.root, f.aliasState);
    fs.mkdirSync(path.join(f.state, 'child'));
    assert.throws(() => store.setRoot(project(f)), overlap);
    assert.equal(store.root, fs.realpathSync(f.root));
    assert.equal(store.writesEnabled, false);
  });
}

test('realpath: disjoint project through an alias remains usable', t => {
  const f = fixture(t);
  const store = new FileStore(path.join(f.alias, 'workspace'), f.aliasState);
  fs.writeFileSync(path.join(f.root, 'hello.txt'), '正常项目\n');
  assert.equal(store.root, fs.realpathSync(f.root));
  assert.equal(store.read('hello.txt').content, '正常项目\n');
});

test('realpath: same string prefix is not directory overlap', t => {
  const f = fixture(t);
  const store = new FileStore(f.root, f.aliasState);
  for (const name of ['state-extra', 'state2', 'sta']) {
    const dir = path.join(f.physical, name);
    fs.mkdirSync(dir);
    store.setRoot(path.join(f.alias, name));
    assert.equal(store.root, fs.realpathSync(dir));
  }
});

test('realpath: missing state subdirectories are created before canonicalization', t => {
  const f = fixture(t);
  const nested = path.join(f.alias, 'new', 'nested', 'state');
  const store = new FileStore(f.root, nested);
  assert.equal(store.stateDir, fs.realpathSync(nested));
  assert.equal(fs.statSync(store.stateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(store.opsDir).mode & 0o777, 0o700);
});

test('realpath: state directory leaf symlink remains forbidden', t => {
  const f = fixture(t);
  fs.mkdirSync(f.state);
  const link = path.join(f.physical, 'state-link');
  fs.symlinkSync(f.state, link, 'dir');
  assert.throws(() => new FileStore(f.root, link), {code:'STATE_UNSAFE'});
});

test('realpath: receipt directory symlink remains forbidden', t => {
  const f = fixture(t);
  fs.mkdirSync(f.state);
  const outside = path.join(f.physical, 'other-receipts');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.state, 'receipts'), 'dir');
  assert.throws(() => new FileStore(f.root, f.aliasState), {code:'STATE_UNSAFE'});
});

test('realpath: backups and replay survive restart with alternate spelling', t => {
  const f = fixture(t);
  const first = new FileStore(f.root, f.aliasState);
  first.writesEnabled = true;
  fs.writeFileSync(path.join(f.root, 'document.txt'), 'before\n');
  first.write('document.txt', 'after\n', digest('before\n'), 'realpath_write01');
  const restarted = new FileStore(path.join(f.alias, 'workspace'), f.state);
  restarted.writesEnabled = true;
  assert.equal(restarted.write('document.txt', 'after\n', digest('before\n'), 'realpath_write01').replayed, true);
  restarted.restore('realpath_write01', 'realpath_restore01');
  assert.equal(restarted.read('document.txt').content, 'before\n');
  assert.equal(fs.statSync(path.join(f.state, 'receipts', 'realpath_write01.json')).mode & 0o777, 0o600);
});

test('realpath: multi-hop alias cannot select the same state directory', t => {
  const f = fixture(t);
  const second = path.join(f.base, 'second-alias');
  fs.symlinkSync(f.alias, second, 'dir');
  const store = new FileStore(f.root, path.join(second, 'state'));
  assert.throws(() => store.setRoot(f.aliasState), overlap);
});
