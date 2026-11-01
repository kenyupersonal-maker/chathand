import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('1079 complete version window plus another empty AXWindow retains explicit UNKNOWN inventory evidence', {skip: process.platform !== 'darwin', timeout: 180000}, () => {
  const source = fs.readFileSync(path.join(root, 'native/ChromeHelperInstall.swift'), 'utf8');
  function method(from, to) {
    const start = source.indexOf(from), end = source.indexOf(to, start);
    assert.ok(start > 0 && end > start, from); return source.slice(start, end);
  }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chathand-1079-window-evidence-')));
  for (const name of ['home', 'tmp', 'cache']) fs.mkdirSync(path.join(dir, name));
  const cache = process.env.CHATHAND_TEST_SWIFT_CACHE || path.join(dir, 'cache'); fs.mkdirSync(cache, {recursive: true});
  const env = {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(dir, 'home'), TMPDIR: path.join(dir, 'tmp'), CLANG_MODULE_CACHE_PATH: cache};
  let boundary = fs.readFileSync(path.join(root, 'tests/v1/1076-chrome-sheet-attribute-checks.swift'), 'utf8').split('@main struct Checks')[0]
    .replace('/* PRODUCTION_DIAGNOSTIC_TYPES */', method('enum ChromeInstallDetailCode:', '/// Chrome exposes version fields'))
    .replace('/* PRODUCTION_DIAGNOSTIC_READERS */', method('    private func installFailure(', '    private func windowInventory('))
    .replace('/* PRODUCTION_SHEET_ELEMENTS */', method('    private func sheetElements(', '    private func sheets()').replaceAll('ProcessInfo', 'FallbackClock'))
    .replace('/* PRODUCTION_SHEETS */', method('    private func sheets()', '    private func picker()'))
    .replace('/* PRODUCTION_INVENTORY */', method('    private func windowInventory(', '    private func captureTarget('))
    .replace('/* PRODUCTION_VISIBLE */', method('    private func extensionsPageVisible()', '    private func attr('))
    .replace('    var number:', '    var value: String?\n    var number:')
    .replace('case sheet = "CHROME_INSTALL_SHEET_UNKNOWN"', 'case controls = "CHROME_INSTALL_CONTROLS_UNKNOWN", profile = "CHROME_INSTALL_PROFILE_UNKNOWN", otherProfile = "CHROME_INSTALL_OTHER_PROFILE", sheet = "CHROME_INSTALL_SHEET_UNKNOWN"')
    .replace('    func sheetCount()', '    func sheetRefs() throws -> [FixtureAX] { try sheets() }\n    func sheetCount()');
  const version = fs.readFileSync(path.join(root, 'tests/v1/chrome-version-page-checks.swift'), 'utf8');
  const from = version.indexOf('struct FixtureHome'), to = version.indexOf('final class PreparationSchedule');
  assert.ok(from > 0 && to > from);
  const decoder = version.slice(from, to)
    .replace('/* PRODUCTION_NODES */', method('    private func nodes(', '    private func unique('))
    .replace('/* PRODUCTION_ADDRESS */', method('    private func isAddress(', '    private func address()'))
    .replace('/* PRODUCTION_VERSION */', method('    private func versionEvidence(', '    func observe('));
  const types = method('enum ChromeVersionPageEvidence {', '/// A blocked/queued AX reader') + '\nenum ChromeInstallObservation { case version(profile: String, major: Int) }\n';
  const checks = fs.readFileSync(path.join(root, 'tests/v1/1079-chrome-window-evidence-checks.swift'), 'utf8');
  const file = path.join(dir, 'Checks.swift'), binary = path.join(dir, 'checks'); fs.writeFileSync(file, boundary + types + decoder + checks);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', '-module-cache-path', cache, file, '-o', binary], {cwd: dir, env, encoding: 'utf8', timeout: 150000});
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(binary, [], {cwd: dir, env, encoding: 'utf8', timeout: 15000});
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /PASS: \d+ multi-window evidence checks/); console.log(run.stdout.trim());
});
