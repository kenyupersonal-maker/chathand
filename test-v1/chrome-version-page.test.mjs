import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('production Chrome version decoder supports rows/groups and rejects ambiguous or foreign evidence', {skip: process.platform !== 'darwin', timeout: 180000}, () => {
  const source = fs.readFileSync(path.join(root, 'native/ChromeHelperInstall.swift'), 'utf8');
  function method(from, to) {
    const start = source.indexOf(from), end = source.indexOf(to, start);
    assert.ok(start > 0 && end > start, from);
    return source.slice(start, end);
  }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chathand-version-page-')));
  for (const name of ['home', 'tmp', 'cache']) fs.mkdirSync(path.join(dir, name));
  const cache = process.env.CHATHAND_TEST_SWIFT_CACHE || path.join(dir, 'cache');
  fs.mkdirSync(cache, {recursive: true});
  const env = {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(dir, 'home'),
    TMPDIR: path.join(dir, 'tmp'), CLANG_MODULE_CACHE_PATH: cache};
  const fixture = fs.readFileSync(path.join(root, 'test-v1/chrome-version-page-checks.swift'), 'utf8')
    .replace('/* PRODUCTION_NODES */', method('    private func nodes(', '    private func unique('))
    .replace('/* PRODUCTION_ADDRESS */', method('    private func isAddress(', '    private func address()'))
    .replace('/* PRODUCTION_VERSION */', method('    private func versionEvidence(', '    func observe('));
  const main = fs.readFileSync(path.join(root, 'native/main.swift'), 'utf8');
  const start = main.indexOf('    private func observeChromeProfiles(');
  const end = main.indexOf('        api("/api/browser/extension/install/profiles"', start);
  assert.ok(start > 0 && end > start);
  // Keep production terminal ordering; replace only the outer scheduler and
  // permission/browser boundary with injected reader completion.
  const preparation = main.slice(start, end)
    .replace('private func observeChromeProfiles', 'func observeChromeProfiles')
    .replace('DispatchQueue.main.asyncAfter(deadline:.now()+10){', 'outerDeadline = {');
  assert.ok(preparation.includes('outerDeadline = {'));
  const file = path.join(dir, 'VersionFixture.swift'), binary = path.join(dir, 'checks');
  fs.writeFileSync(file, fixture.replace('/* PRODUCTION_PREPARATION */', preparation));
  const compiled = spawnSync('/usr/bin/xcrun', ['swiftc', '-swift-version', '5',
    '-DCHATHAND_INSTALL_PURE_TEST', '-module-cache-path', cache, '-parse-as-library',
    'native/LocalText.swift', 'native/ChromeHelperInstall.swift', file, '-o', binary],
  {cwd: root, env, encoding: 'utf8', timeout: 150000});
  assert.equal(compiled.status, 0, (compiled.error?.code ?? '') + compiled.stderr);
  const run = spawnSync(binary, [], {cwd: dir, env, encoding: 'utf8', timeout: 15000});
  assert.equal(run.status, 0, (run.error?.code ?? '') + run.stderr);
  assert.match(run.stdout, /PASS: \d+ production Chrome version decoder checks/);
  console.log(run.stdout.trim());
});
