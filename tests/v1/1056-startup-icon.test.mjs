import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {refreshStartupIcon} from '../../app/v1/startup-icon.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chathand-1056-icon-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const appPath = path.join(dir, 'ChatHand.app'); fs.mkdirSync(appPath);
  const calls = [], remembered = [];
  return {appPath, build: 1056, previousBuild: 1055, platform: 'darwin', calls, remembered,
    run: async (program, args) => { calls.push({program, args}); return {}; },
    remember: build => remembered.push(build)};
}

test('changed build refreshes only its own App then remembers successful registration', async t => {
  const f = fixture(t); const result = await refreshStartupIcon(f);
  assert.equal(result.refreshed, true); assert.deepEqual(f.remembered, [1056]);
  assert.deepEqual(f.calls, [
    {program: '/usr/bin/touch', args: [f.appPath]},
    {program: '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', args: ['-f', f.appPath]},
  ]);
});
test('same build does not refresh again', async t => {
  const f = fixture(t); f.previousBuild = 1056;
  assert.equal((await refreshStartupIcon(f)).refreshed, false);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.remembered, []);
});
test('first installed launch refreshes; non-App and symlink targets do not', async t => {
  const f = fixture(t); f.previousBuild = undefined;
  assert.equal((await refreshStartupIcon(f)).refreshed, true);
  f.calls.length = 0;
  assert.equal((await refreshStartupIcon({...f, appPath: path.dirname(f.appPath)})).refreshed, false);
  const other = path.join(path.dirname(f.appPath), 'alias'); fs.mkdirSync(other);
  const link = path.join(other, 'ChatHand.app'); fs.symlinkSync(f.appPath, link);
  assert.equal((await refreshStartupIcon({...f, appPath: link})).refreshed, false);
  assert.deepEqual(f.calls, []);
});
test('registration failure is reported without remembering success or restarting Dock', async t => {
  const f = fixture(t), codes = [];
  f.run = async (program, args) => { f.calls.push({program, args}); if (f.calls.length === 2) throw Error('synthetic'); };
  const result = await refreshStartupIcon({...f, record: code => codes.push(code)});
  assert.equal(result.code, 'UPGRADE_ICON_REGISTER_FAILED');
  assert.deepEqual(codes, ['UPGRADE_ICON_REGISTER_FAILED']); assert.deepEqual(f.remembered, []);
  assert.equal(f.calls.length, 2);
});
