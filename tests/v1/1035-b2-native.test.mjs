import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
test('1035 fixed transport, identity and zero-event rejection rules run offline', {skip: process.platform !== 'darwin', timeout: 120000}, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chathand-1035-b2-'));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  const cache = process.env.CHATHAND_TEST_SWIFT_CACHE || path.join(temp, 'module-cache');
  fs.mkdirSync(cache, {recursive: true});
  const binary = path.join(temp, 'b2-pure-checks');
  const env = {...process.env, CHATHAND_STATE_DIR: path.join(temp, 'state'), CLANG_MODULE_CACHE_PATH: cache};
  const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', '-module-cache-path', cache,
    '-framework', 'Cocoa', '-framework', 'ApplicationServices', '-framework', 'ScreenCaptureKit', '-framework', 'Vision',
    'native/LocalText.swift','native/ComputerControl.swift', 'native/B2TargetClick.swift', 'tests/v1/1035-b2-native.swift', '-o', binary],
    {cwd: root, env, encoding: 'utf8', timeout: 90000});
  assert.equal(build.status, 0, (build.error?.code || '') + ' ' + build.stderr);
  fs.cpSync(path.join(root,'locales'),path.join(temp,'locales'),{recursive:true});
  const run = spawnSync(binary, [], {cwd: root, env, encoding: 'utf8', timeout: 5000});
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /PASS \d+ isolated B2 click checks; zero real events/);
  console.log(run.stdout.trim());
});

test('1035 production background dispatch is bound to snapshot and preserves original gates', () => {
  const native = read('native/ComputerControl.swift'), b2 = read('native/B2TargetClick.swift');
  const perform = native.slice(native.indexOf('@MainActor static func perform('), native.indexOf('@MainActor static func runBatch('));
  const ax = perform.indexOf('AXUIElementPerformAction(element, kAXPressAction');
  const background = perform.indexOf('B2TargetClick.attempt('), foreground = perform.indexOf('session.foreground(');
  assert.ok(ax >= 0 && background > ax && foreground > background);
  for (const gate of ['try await session.authorize()', 'try revalidate(args)', 'guard inputAllowedForBundle', 'try checkSystemPassword(target, element: entry?.element)']) {
    assert.ok(perform.indexOf(gate) >= 0 && perform.indexOf(gate) < background, gate);
  }
  assert.match(perform, /if operation == "click" \{[\s\S]*B2TargetClick\.attempt/);
  assert.match(perform, /catch let failure as B2TargetClick\.Failure\s*\{\s*throw B2TargetClick\.controlFailure\(failure\)/);
  assert.match(perform, /if let receipt \{\s*return try B2TargetClick\.postedReceipt\(receipt\)/);
  assert.match(native, /capturedIdentity: identity, capturingScreenshot: true/);
  assert.match(native, /window\.windowID != identity\.windowID/);
  assert.match(native, /matchingCaptureWindows\(content\.windows, target: target, identity: identity\)/);
  assert.match(native, /if let identity, B2TargetClick\.snapshotIdentity\(target\) != identity/);
  assert.match(b2, /try await check\(\)[\s\S]*snapshotIdentity\(target\) == expected/);
  assert.match(b2, /FrontGuard\.read\(\) == front/);
  assert.match(b2, /CGPreflightPostEventAccess\(\)/);
  assert.doesNotMatch(b2, /CGRequest|AXIsProcessTrustedWithOptions|\.activate\(|kAXRaiseAction|\.post\(tap:|NSPasteboard|Process\(\)|SetFrontProcess|AXUIElementSetAttributeValue/);
  assert.match(read('native/Package.swift'), /"B2TargetClick.swift"/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /OCU[\s\S]*Copyright \(c\) 2026 Leo/);
  assert.match(read('licenses/OCU-v0.3.6-LICENSE.txt'), /Copyright \(c\) 2026 Leo[\s\S]*THE SOFTWARE IS PROVIDED "AS IS"/);
});
