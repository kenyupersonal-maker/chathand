import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('1078 unsupported AXSheets uses only complete bounded reciprocal snapshots', {skip: process.platform !== 'darwin', timeout: 180000}, () => {
  const source = fs.readFileSync(path.join(root, 'native/ChromeHelperInstall.swift'), 'utf8');
  function method(from, to) {
    const start = source.indexOf(from), end = source.indexOf(to, start);
    assert.ok(start > 0 && end > start, from); return source.slice(start, end);
  }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chathand-1078-fallback-')));
  for (const name of ['home', 'tmp', 'cache']) fs.mkdirSync(path.join(dir, name));
  const cache = process.env.CHATHAND_TEST_SWIFT_CACHE || path.join(dir, 'cache'); fs.mkdirSync(cache, {recursive: true});
  const env = {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(dir, 'home'), TMPDIR: path.join(dir, 'tmp'), CLANG_MODULE_CACHE_PATH: cache};
  let boundary = fs.readFileSync(path.join(root, 'test-v1/1076-chrome-sheet-attribute-checks.swift'), 'utf8').split('@main struct Checks')[0]
    .replace('/* PRODUCTION_DIAGNOSTIC_TYPES */', method('enum ChromeInstallDetailCode:', '/// Chrome exposes version fields'))
    .replace('/* PRODUCTION_DIAGNOSTIC_READERS */', method('    private func installFailure(', '    private func windowInventory('))
    .replace('/* PRODUCTION_SHEET_ELEMENTS */', method('    private func sheetElements(', '    private func sheets()').replaceAll('ProcessInfo', 'FallbackClock'))
    .replace('/* PRODUCTION_SHEETS */', method('    private func sheets()', '    private func picker()'))
    .replace('/* PRODUCTION_INVENTORY */', method('    private func windowInventory(', '    private func captureTarget('))
    .replace('/* PRODUCTION_VISIBLE */', method('    private func extensionsPageVisible()', '    private func attr('))
    .replace('    func sheetCount()', '    func sheetRefs() throws -> [FixtureAX] { try sheets() }\n    func sheetCount()');
  const observer = source.includes('enum ChromeInstallFallbackCode:') ? 'f.failureDetail?.fallbackCode?.rawValue' : 'nil';
  const checks = fs.readFileSync(path.join(root, 'test-v1/1078-chrome-sheet-fallback-checks.swift'), 'utf8').replace('/* FALLBACK_OBSERVER */', observer);
  const file = path.join(dir, 'Checks.swift'), binary = path.join(dir, 'checks'); fs.writeFileSync(file, boundary + checks);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', '-module-cache-path', cache, file, '-o', binary], {cwd: dir, env, encoding: 'utf8', timeout: 150000});
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(binary, [], {cwd: dir, env, encoding: 'utf8', timeout: 15000});
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /PASS: \d+ unsupported-sheet fallback checks/); console.log(run.stdout.trim());
});

test('1078 typed fallback rejection survives controller and acknowledged native bridge', {skip: process.platform !== 'darwin', timeout: 180000}, () => {
  const main = fs.readFileSync(path.join(root, 'native/main.swift'), 'utf8');
  const from = main.indexOf('            func progress(_ event:String'), deliver = main.indexOf('            func deliver(', from), end = main.indexOf('                // The bridge has already returned started;', deliver);
  assert.ok(from > 0 && deliver > from && end > deliver);
  const support = fs.readFileSync(path.join(root, 'test-v1/1077-chrome-preflight-receipt-checks.swift'), 'utf8').split('@main struct Checks')[0]
    .replace('/* PRODUCTION_PROGRESS */', main.slice(from, deliver))
    .replace('/* PRODUCTION_DELIVER_ERROR */', main.slice(deliver, end) + '\n            }');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chathand-1078-receipt-')));
  for (const name of ['home', 'tmp', 'cache']) fs.mkdirSync(path.join(dir, name));
  const cache = process.env.CHATHAND_TEST_SWIFT_CACHE || path.join(dir, 'cache'); fs.mkdirSync(cache, {recursive: true});
  const env = {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(dir, 'home'), TMPDIR: path.join(dir, 'tmp'), CLANG_MODULE_CACHE_PATH: cache};
  const file = path.join(dir, 'Checks.swift'), binary = path.join(dir, 'checks');
  fs.writeFileSync(file, support + fs.readFileSync(path.join(root, 'test-v1/1078-chrome-fallback-receipt-checks.swift'), 'utf8'));
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-DCHATHAND_INSTALL_PURE_TEST', '-parse-as-library', '-module-cache-path', cache, 'native/LocalText.swift', 'native/ChromeHelperInstall.swift', file, '-o', binary], {cwd: root, env, encoding: 'utf8', timeout: 150000});
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(binary, [dir], {cwd: dir, env, encoding: 'utf8', timeout: 15000});
  assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /PASS: \d+ fallback receipt checks/); console.log(run.stdout.trim());
});
