import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
function method(source, marker) {
  const start = source.indexOf(marker), open = source.indexOf('{', start);
  assert.ok(start >= 0 && open > start, marker);
  let depth = 1, end = open + 1;
  while (depth && end < source.length) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  }
  assert.equal(depth, 0);
  return source.slice(start, end);
}

test('1075 actual permission controller, display entries and language bridge use the effective App language', {skip: process.platform !== 'darwin', timeout: 120000}, t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chathand-1075-permission-locale-')));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  for (const part of ['home', 'tmp', 'cache']) fs.mkdirSync(path.join(dir, part));
  const cache = process.env.CHATHAND_TEST_SWIFT_CACHE || path.join(dir, 'cache');
  fs.mkdirSync(cache, {recursive: true});
  const source = fs.readFileSync(path.join(root, 'native/PermissionAssistant.swift'), 'utf8');
  const declarations = source.slice(source.indexOf('    private let '), source.indexOf('    var onboardingBegin:'));
  const accessibility = source.slice(source.indexOf('    func requestAccessibilityOnly('), source.indexOf('    func reopenGuidance('));
  const ordinary = method(source, '    private func openCurrentPane(');
  const main = fs.readFileSync(path.join(root, 'native/main.swift'), 'utf8');
  const refresh = method(main, '    func refreshNativeLanguage(');
  const bridge = refresh.split('\n').filter(line => line.includes('permissionAssistant.refreshLanguage()')).join('\n');
  const file = path.join(dir, 'GuidanceLocaleChecks.swift'), binary = path.join(dir, 'guidance-checks');
  // Only Foundation and pure fake vendor/trust transports. The actual production
  // declarations and methods below never reach AppKit, AX, TCC or user defaults.
  fs.writeFileSync(file, `import Foundation
enum LocalText { static var systemLocale = "en" }
enum PermissionFlowPane { case accessibility, screenRecording }
struct PermissionFlowConfiguration {
  let requiredAppURLs: [URL]
  let promptForAccessibilityTrust: Bool
  let localeIdentifier: String?
}
final class PermissionFlowController {
  static var latest: PermissionFlowController?
  var localeIdentifier: String?, panelLocale: String?
  var shown: [String?] = []
  var panelOpen = false
  init(_ configuration: PermissionFlowConfiguration) { localeIdentifier = configuration.localeIdentifier; Self.latest = self }
  func setLocaleIdentifier(_ locale: String?) { localeIdentifier = locale; if panelOpen { panelLocale = locale } }
  func authorize(pane: PermissionFlowPane, suggestedAppURLs: [URL]) { panelOpen = true; panelLocale = localeIdentifier; shown.append(localeIdentifier) }
  func closePanel() { panelOpen = false }
}
enum PermissionFlow {
  static func makeController(configuration: PermissionFlowConfiguration) -> PermissionFlowController { PermissionFlowController(configuration) }
}
struct FakePrompt { func takeUnretainedValue() -> String { "prompt" } }
let kAXTrustedCheckOptionPrompt = FakePrompt()
func AXIsProcessTrusted() -> Bool { false }
func AXIsProcessTrustedWithOptions(_ options: CFDictionary) -> Bool { false }
func CGRequestScreenCaptureAccess() -> Bool { false }
@MainActor final class PermissionFixture {
${declarations}
  var timer: Timer?, update: (([String: Any]) -> Void)?
  var onboardingBegin: ((String) -> ((String, String) -> Void))?
  var onboardingEnd: ((String, String) -> Void)?
  var step: PermissionFlowStep = .idle
  var accessibilityOnly = false
${accessibility}
${ordinary}
  func show(_ pane: PermissionFlowStep) { step = pane; openCurrentPane() }
}
@MainActor final class BridgeFixture {
  let permissionAssistant: PermissionFixture
  init(_ assistant: PermissionFixture) { permissionAssistant = assistant }
  func refreshNativeLanguage() {
${bridge}
  }
}
@main struct Checks {
  @MainActor static func main() {
    var checks = 0
    func expect(_ value: Bool, _ message: String) { checks += 1; if !value { fputs("FAIL: \\(message)\\n", stderr); exit(1) } }
    let assistant = PermissionFixture(), controller = PermissionFlowController.latest!
    expect(controller.localeIdentifier == "en", "English App initializes English guidance")
    _ = assistant.requestAccessibilityOnly()
    expect(controller.shown == ["en"], "Chrome AX-only shows English")
    LocalText.systemLocale = "zh"
    _ = assistant.requestAccessibilityOnly()
    expect(controller.shown.last! == "zh-Hans", "next AX-only display refreshes changed language")
    LocalText.systemLocale = "en"
    assistant.show(.accessibility)
    expect(controller.shown.last! == "en", "ordinary accessibility display refreshes English")
    LocalText.systemLocale = "zh"
    assistant.show(.screenRecording)
    expect(controller.shown.last! == "zh-Hans", "ordinary recording display refreshes Chinese")
    let bridge = BridgeFixture(assistant), before = controller.shown.count, step = assistant.step
    LocalText.systemLocale = "en"; bridge.refreshNativeLanguage()
    expect(controller.panelOpen && controller.panelLocale == "en", "open panel receives App language bridge update")
    expect(controller.shown.count == before && assistant.step == step, "language refresh neither authorizes again nor changes permission step")
    LocalText.systemLocale = "zh"; bridge.refreshNativeLanguage()
    expect(controller.panelLocale == "zh-Hans", "open panel can switch back to Chinese")
    expect(controller.shown.count == before, "repeated language update stays side-effect-free")
    print("PASS: \\(checks) actual permission locale checks; fake vendor/trust only, zero OS APIs")
  }
}
`);
  const env = {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(dir, 'home'), TMPDIR: path.join(dir, 'tmp'), CLANG_MODULE_CACHE_PATH: cache};
  const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', '-module-cache-path', cache,
    'native/PermissionFlowState.swift', file, '-o', binary], {cwd: root, env, encoding: 'utf8', timeout: 90000});
  assert.equal(build.status, 0, (build.error?.code || '') + build.stderr);
  const run = spawnSync(binary, [], {cwd: dir, env, encoding: 'utf8', timeout: 5000});
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /PASS: 9 actual permission locale checks; fake vendor\/trust only, zero OS APIs/);
  console.log(run.stdout.trim());
});
