import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mac = process.platform === 'darwin';
function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chathand-1070-native-')));
  for (const name of ['home', 'tmp', 'cache']) fs.mkdirSync(path.join(dir, name));
  const cache = process.env.CHATHAND_TEST_SWIFT_CACHE || path.join(dir, 'cache');
  fs.mkdirSync(cache, {recursive: true});
  // No inherited account/config environment and no real home in child processes.
  const env = {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(dir, 'home'),
    TMPDIR: path.join(dir, 'tmp'), CLANG_MODULE_CACHE_PATH: cache};
  return {dir, cache, env}; // Keep self-created evidence; never clean user-owned files.
}
function swift(f, args) {
  const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-swift-version', '5',
    '-module-cache-path', f.cache, ...args], {cwd: root, env: f.env, encoding: 'utf8', timeout: 120000});
  assert.equal(result.status, 0, (result.error?.code ?? '') + result.stderr);
}
function run(f, binary, args = []) {
  const result = spawnSync(binary, args, {cwd: f.dir, env: f.env, encoding: 'utf8', timeout: 15000});
  assert.equal(result.status, 0, (result.error?.code ?? '') + result.stderr);
  return result.stdout;
}

test('1070 wait, verified page open and repair execute only injected clocks/AX/browser/API and synthetic files', {skip: !mac, timeout: 150000}, () => {
  const f = fixture(), binary = path.join(f.dir, 'checks');
  swift(f, ['-DCHATHAND_INSTALL_PURE_TEST', '-parse-as-library', 'native/LocalText.swift',
    'native/ChromeHelperInstall.swift', 'native/ChromeAccessibilityWait.swift',
    'test-v1/1070-chrome-native-checks.swift', '-o', binary]);
  const output = run(f, binary, [f.dir]);
  assert.match(output, /PASS: \d+ 1070 Chrome native checks/);
  console.log(output.trim());
});

test('1070 live Chrome adapter and wait typecheck without running any desktop or permission APIs', {skip: !mac, timeout: 150000}, () => {
  const f = fixture(), stubs = path.join(f.dir, 'CompileOnly.swift');
  fs.writeFileSync(stubs, `import Cocoa
import ApplicationServices
enum ComputerControl {
  static func elementFrame(_ element: AXUIElement) -> CGRect? { nil }
}
enum B2TargetClick {
  final class WindowReader {
    static let shared: WindowReader? = nil
    func id(_ element: AXUIElement) -> CGWindowID? { nil }
  }
  static func windowInfo(pid: pid_t, id: CGWindowID) -> [String: Any]? { nil }
}
`);
  swift(f, ['-typecheck', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`,
    stubs, 'native/LocalText.swift', 'native/ChromeHelperInstall.swift', 'native/ChromeAccessibilityWait.swift']);
});

test('1070 actual accessibility-only PermissionAssistant methods never advance to another pane', {skip: !mac, timeout: 150000}, () => {
  const source = fs.readFileSync(path.join(root, 'native/PermissionAssistant.swift'), 'utf8');
  const from = source.indexOf('    func requestAccessibilityOnly('), to = source.indexOf('    func reopenGuidance(', from);
  assert.ok(from > 0 && to > from);
  const methods = source.slice(from, to);
  assert.doesNotMatch(methods, /CGRequest|screenRecording|requestPermissions|runTCCReset|scheduledTimer/);
  const f = fixture(), file = path.join(f.dir, 'PermissionFixture.swift'), binary = path.join(f.dir, 'permission-checks');
  fs.writeFileSync(file, `import Foundation
var fakeTrust = false
func AXIsProcessTrusted() -> Bool { fakeTrust }
enum FakePane { case accessibility }
final class FakeController {
  var panes: [FakePane] = []; var closed = 0
  func authorize(pane: FakePane, suggestedAppURLs: [URL]) { panes.append(pane) }
  func closePanel() { closed += 1 }
}
@MainActor final class PermissionFixture {
  let controller = FakeController()
  var genericGeneration: UUID?
  var timer: Timer?, update: (([String: Any]) -> Void)?
  var onboardingBegin: ((String) -> ((String, String) -> Void))?
  var onboardingEnd: ((String, String) -> Void)?
  var step: PermissionFlowStep = .idle
  var accessibilityOnly = false
${methods}
}
@main struct Checks {
  @MainActor static func main() {
    let f = PermissionFixture(); var events: [String] = []
    f.onboardingBegin = { step in events.append(step); return { outcome, code in events.append(outcome + ":" + code) } }
    f.timer = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { _ in fatalError("old timer ran") }
    let timer = f.timer; f.update = { _ in fatalError("old full-permission callback ran") }
    let waiting = f.requestAccessibilityOnly()
    precondition(waiting["accessibility"] as? Bool == false && f.controller.panes.count == 1)
    precondition(timer?.isValid == false && f.timer == nil && f.update == nil && f.step == .accessibility)
    f.finishAccessibilityOnly(granted: true)
    precondition(f.step == .complete && f.controller.closed == 1 && events == ["permission_accessibility", "ok:NONE"])
    f.finishAccessibilityOnly(granted: false); precondition(f.controller.closed == 1)
    _ = f.requestAccessibilityOnly(); f.finishAccessibilityOnly(granted: false)
    precondition(f.step == .idle && events.last == "cancelled:CANCELLED")
    fakeTrust = true
    let granted = f.requestAccessibilityOnly()
    precondition(granted["accessibility"] as? Bool == true && f.controller.panes.count == 2)
    f.finishAccessibilityOnly(granted: true)
    print("PASS: actual accessibility-only methods with fake trust/controller; no system UI")
  }
}
`);
  swift(f, ['-parse-as-library', 'native/PermissionFlowState.swift', file, '-o', binary]);
  assert.match(run(f, binary), /PASS: actual accessibility-only methods/);
});
