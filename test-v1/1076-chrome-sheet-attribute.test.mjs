import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('1076 production sheet reads distinguish no-value from failures at all three callers', {skip: process.platform !== 'darwin', timeout: 150000}, () => {
  const source = fs.readFileSync(path.join(root, 'native/ChromeHelperInstall.swift'), 'utf8');
  function method(from, to, optional = false) {
    const start = source.indexOf(from), end = source.indexOf(to, start);
    if (optional && start === -1) return '';
    assert.ok(start > 0 && end > start, from);
    return source.slice(start, end);
  }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chathand-1076-sheet-')));
  for (const name of ['home', 'tmp', 'cache']) fs.mkdirSync(path.join(dir, name));
  const cache = process.env.CHATHAND_TEST_SWIFT_CACHE || path.join(dir, 'cache');
  fs.mkdirSync(cache, {recursive: true});
  const env = {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(dir, 'home'),
    TMPDIR: path.join(dir, 'tmp'), CLANG_MODULE_CACHE_PATH: cache};
  const fixture = fs.readFileSync(path.join(root, 'test-v1/1076-chrome-sheet-attribute-checks.swift'), 'utf8')
    .replace('/* PRODUCTION_DIAGNOSTIC_TYPES */', method('enum ChromeInstallDetailCode:', '/// Chrome exposes version fields'))
    .replace('/* PRODUCTION_DIAGNOSTIC_READERS */', method('    private func installFailure(', '    private func windowInventory('))
    .replace('/* PRODUCTION_SHEET_ELEMENTS */', method('    private func sheetElements(', '    private func sheets()', true))
    .replace('/* PRODUCTION_SHEETS */', method('    private func sheets()', '    private func picker()'))
    .replace('/* PRODUCTION_INVENTORY */', method('    private func windowInventory(', '    private func captureTarget('))
    .replace('/* PRODUCTION_VISIBLE */', method('    private func extensionsPageVisible()', '    private func attr('));
  const file = path.join(dir, 'SheetFixture.swift'), binary = path.join(dir, 'checks');
  fs.writeFileSync(file, fixture);
  const compiled = spawnSync('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library',
    '-module-cache-path', cache, file, '-o', binary], {cwd: dir, env, encoding: 'utf8', timeout: 120000});
  assert.equal(compiled.status, 0, (compiled.error?.code ?? '') + compiled.stderr);
  const run = spawnSync(binary, [], {cwd: dir, env, encoding: 'utf8', timeout: 15000});
  assert.equal(run.status, 0, (run.error?.code ?? '') + run.stderr);
  assert.match(run.stdout, /PASS: \d+ production sheet attribute checks; no live AX/);
  console.log(run.stdout.trim());
});
