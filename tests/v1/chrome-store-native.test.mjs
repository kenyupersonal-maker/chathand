import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('actual native store routing fences legacy entry, wrong targets, cancellation and dispatch receipts', {skip: process.platform !== 'darwin', timeout: 150000}, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chathand-store-native-')));
  for (const name of ['home', 'tmp', 'cache']) fs.mkdirSync(path.join(dir, name));
  const cache = process.env.CHATHAND_TEST_SWIFT_CACHE || path.join(dir, 'cache');
  fs.mkdirSync(cache, {recursive:true});
  const main = fs.readFileSync('native/main.swift', 'utf8');
  const start = main.indexOf('        // All former helper-folder and AX installer entries');
  const end = main.indexOf('        // Repair and setup share', start);
  assert.ok(start >= 0 && end > start, 'test must execute the production bridge block');
  const fixture = fs.readFileSync('tests/v1/chrome-store-native-checks.swift', 'utf8')
    .replace('// ACTUAL_STORE_DISPATCH', main.slice(start, end));
  const source = path.join(dir, 'Checks.swift'), binary = path.join(dir, 'checks');
  fs.writeFileSync(source, fixture);
  const env = {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(dir, 'home'), TMPDIR: path.join(dir, 'tmp'), CLANG_MODULE_CACHE_PATH: cache};
  const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-DCHATHAND_INSTALL_PURE_TEST', '-parse-as-library',
    '-module-cache-path', cache, 'native/LocalText.swift', 'native/ChromeHelperInstall.swift', source, '-o', binary],
    {env, encoding: 'utf8', timeout: 120000});
  assert.equal(build.status, 0, build.error?.message ?? build.stderr);
  const run = spawnSync(binary, [], {env, encoding: 'utf8', timeout: 15000});
  assert.equal(run.status, 0, run.error?.message ?? run.stderr);
  assert.match(run.stdout, /PASS: \d+ store native checks/);
  console.log(run.stdout.trim());
});
