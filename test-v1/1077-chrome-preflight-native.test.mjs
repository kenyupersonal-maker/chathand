import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'native/ChromeHelperInstall.swift'), 'utf8');
function method(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start > 0 && end > start, from); return source.slice(start, end);
}
function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chathand-1077-preflight-')));
  for (const name of ['home', 'tmp', 'cache']) fs.mkdirSync(path.join(dir, name));
  const cache = process.env.CHATHAND_TEST_SWIFT_CACHE || path.join(dir, 'cache');
  fs.mkdirSync(cache, {recursive: true});
  return {dir, cache, env: {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(dir, 'home'), TMPDIR: path.join(dir, 'tmp'), CLANG_MODULE_CACHE_PATH: cache}};
}
function compileRun(f, content, extra = []) {
  const file = path.join(f.dir, 'Checks.swift'), binary = path.join(f.dir, 'checks'); fs.writeFileSync(file, content);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-DCHATHAND_INSTALL_PURE_TEST', '-parse-as-library', '-module-cache-path', f.cache, ...extra, file, '-o', binary], {cwd: root, env: f.env, encoding: 'utf8', timeout: 150000});
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(binary, [f.dir], {cwd: f.dir, env: f.env, encoding: 'utf8', timeout: 15000});
  assert.equal(run.status, 0, run.stderr); console.log(run.stdout.trim()); return run.stdout;
}
test('1077 actual inventory and sheet reader emit finite same-read failure details', {skip: process.platform !== 'darwin', timeout: 180000}, () => {
  const f = fixture();
  const boundary = fs.readFileSync(path.join(root, 'test-v1/1076-chrome-sheet-attribute-checks.swift'), 'utf8').split('@main struct Checks')[0]
    .replace('/* PRODUCTION_DIAGNOSTIC_TYPES */', method('enum ChromeInstallDetailCode:', '/// Chrome exposes version fields'))
    .replace('/* PRODUCTION_DIAGNOSTIC_READERS */', method('    private func installFailure(', '    private func windowInventory('))
    .replace('/* PRODUCTION_SHEET_ELEMENTS */', method('    private func sheetElements(', '    private func sheets()'))
    .replace('/* PRODUCTION_SHEETS */', method('    private func sheets()', '    private func picker()'))
    .replace('/* PRODUCTION_INVENTORY */', method('    private func windowInventory(', '    private func captureTarget('))
    .replace('/* PRODUCTION_VISIBLE */', method('    private func extensionsPageVisible()', '    private func attr('));
  assert.match(compileRun(f, boundary + fs.readFileSync(path.join(root, 'test-v1/1077-chrome-preflight-native-checks.swift'), 'utf8')), /PASS: \d+ production preflight diagnostic branch checks/);
});
test('1077 actual controller and acknowledged main bridge retain only validated stop details', {skip: process.platform !== 'darwin', timeout: 180000}, () => {
  const f = fixture(), main = fs.readFileSync(path.join(root, 'native/main.swift'), 'utf8');
  const start = main.indexOf('            func progress(_ event:String'), deliver = main.indexOf('            func deliver(', start), end = main.indexOf('                // The bridge has already returned started;', deliver);
  assert.ok(start > 0 && deliver > start && end > deliver);
  const content = fs.readFileSync(path.join(root, 'test-v1/1077-chrome-preflight-receipt-checks.swift'), 'utf8')
    .replace('/* PRODUCTION_PROGRESS */', main.slice(start, deliver))
    .replace('/* PRODUCTION_DELIVER_ERROR */', main.slice(deliver, end) + '\n            }');
  assert.match(source, /func preflight\(\) throws \{\s*failureDetail = nil/);
  assert.match(source, /func close\(\) \{\s*failureDetail = nil/);
  assert.match(compileRun(f, content, ['native/LocalText.swift', 'native/ChromeHelperInstall.swift']), /PASS: \d+ production preflight receipt checks/);
});
