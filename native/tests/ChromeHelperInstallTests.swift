import Foundation

// Compile with -DCHATHAND_INSTALL_PURE_TEST. Only temporary files and fake
// adapters/API callbacks are used; the live Cocoa/AX adapter is excluded.
private final class FakeChrome: ChromeInstallAdapter {
    var needsLaunch = false
    var inputReady = true
    var actions: [ChromeInstallAction] = []
    var checks: [(ChromeInstallStage, Bool)] = []
    var delays: [ChromeInstallStage: Int] = [:]
    var preflightFailure: ChromeInstallCode?
    var failure: ChromeInstallCode?
    var actionFailure: ChromeInstallAction?
    var developer = false
    var profile = "/fixture/Chrome/Default"
    var finalProfile: String?
    var major = 128
    var fingerprint = ""
    var finalFingerprint: String?
    var closed = 0
    var probeCreated = false
    var existingHelper = false
    var loadSucceeds = true
    var helperEnabled = true
    var helperSourceFailure = false
    var policyFailure: ChromeInstallCode?
    var holdEvidence = false
    var evidenceCallback: (() -> Void)?
    var inputGuards = 0
    func preflight() throws { if let preflightFailure { throw preflightFailure } }
    func bind(_ lease: ChromeInstallLease) throws { fingerprint = lease.fingerprint }
    func check(_ stage: ChromeInstallStage, input: Bool) throws {
        checks.append((stage, input)); if input { inputGuards += 1 }
        if let failure { throw failure }
    }
    func perform(_ action: ChromeInstallAction) throws {
        precondition(inputGuards == actions.count + 1, "each input has its own post-status local guard")
        actions.append(action)
        if action == actionFailure { throw ChromeInstallCode.unconfirmed }
        if action == .developerMode { developer = true }
        if action == .probeURL { probeCreated = true }
        if action == .enableHelper { helperEnabled = true }
        if action == .openFolder && loadSucceeds { existingHelper = true }
    }
    func observe(_ stage: ChromeInstallStage) throws -> ChromeInstallObservation? {
        if let remaining = delays[stage], remaining > 0 { delays[stage] = remaining - 1; return nil }
        switch stage {
        case .runningChrome: needsLaunch = false; return .runningChrome
        case .normal, .chooserClosing: return .chooserDismissed
        case .newTab: return .newTab
        case .version: return .version(profile: profile, major: major)
        case .policies: if let policyFailure { throw policyFailure }; return .policiesClear
        case .finalVersion: return .version(profile: finalProfile ?? profile, major: major)
        case .extensions: return .extensions(developerMode: developer)
        case .helperList: return existingHelper ? .helperFound : .missingHelper
        case .helperDetails:
            if helperSourceFailure { throw ChromeInstallCode.source }
            return .helperDetails(enabled:helperEnabled,current:true)
        case .helperReady: return .helperReady
        case .chooser: return .chooser
        case .goFolder: return .pathEntry
        case .selectedFolder: return .selectedFolder
        case .probe: return probeCreated ? .probe : nil
        }
    }
    func finalEvidence() throws -> String { if let failure { throw failure }; return finalFingerprint ?? fingerprint }
    func failureEvidence(code: String, stage: String, current: @escaping () -> Bool, completion: @escaping ([String: Any]) -> Void) {
        let respond = { if current() { completion(["code":code,"stage":stage,"evidence_code":"CHROME_INSTALL_EVIDENCE_UNAVAILABLE"]) } }
        if holdEvidence { evidenceCallback = respond } else { respond() }
    }
    func close() { closed += 1 }
}
private final class Harness {
    let root: URL
    let runtime: URL
    let helper: URL
    let chrome = FakeChrome()
    let leaseID = String(repeating: "a", count: 32)
    let origin = "http://127.0.0.1:31415"
    var requests: [(String, [String: Any])] = []
    var scheduled: [() -> Void] = []
    var clock: TimeInterval = 100
    var holdStart = false, holdStatus = false, holdFinish = false
    var startCallback: (([String: Any]) -> Void)?
    var statusCallback: (([String: Any]) -> Void)?
    var finishCallback: (([String: Any]) -> Void)?
    var onStatus: (() -> Void)?
    var active = true
    var verifyCalls = 0
    var holdHandshake = false
    var helperSeen = true
    var diagnostics: [[String: Any]] = []
    var response: [String: Any]
    lazy var installer = ChromeHelperInstaller(runtime: runtime, expectedFolder: helper, origin: { [weak self] in self?.origin ?? "" }, api: { [weak self] path, body, done in self?.request(path, body, done) }, adapter: { [weak self] in self?.chrome ?? FakeChrome() }, diagnostic: { [weak self] in self?.diagnostics.append($0) }, now: { [weak self] in self?.clock ?? 0 }, schedule: { [weak self] _, work in self?.scheduled.append(work) })
    init() throws {
        let temporaryRoot = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("chathand-1042-pure-" + UUID().uuidString, isDirectory: true)
        root = temporaryRoot
        let package = temporaryRoot.appendingPathComponent("runtime", isDirectory: true)
        runtime = package
        let copy = temporaryRoot.appendingPathComponent("chrome-helper", isDirectory: true)
        helper = copy
        let folder = package.appendingPathComponent("browser-extension", isDirectory: true)
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("vendor"), withIntermediateDirectories: true)
        for name in ChromeInstallSource.files {
            let file = folder.appendingPathComponent(name)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(("fixture:" + name).utf8).write(to: file)
        }
        try FileManager.default.copyItem(at: folder, to: copy)
        response = ["lease_id": String(repeating: "a", count: 32), "profile_id":"Default", "probe_url": "http://127.0.0.1:31415/api/browser/extension/install/probe/" + String(repeating: "b", count: 64), "extension_folder": copy.path, "source_fingerprint": try ChromeInstallSource.fingerprint(runtime: package)]
    }
    deinit { try? FileManager.default.removeItem(at: root) }
    var liveStatus: [String: Any] { ["phase": "waiting_helper", "active": active, "code": NSNull()] }
    var doneStatus: [String: Any] { ["phase": "installed_verified", "active": false, "code": NSNull()] }
    func request(_ path: String, _ body: [String: Any], _ done: @escaping ([String: Any]) -> Void) {
        requests.append((path, body))
        switch path.split(separator: "/").last! {
        case "start": if holdStart { startCallback = done } else { done(response) }
        case "status": onStatus?(); if holdStatus { statusCallback = done } else { done(liveStatus) }
        case "progress": done(liveStatus)
        case "evidence": done(["ok":true])
        case "verify":
            precondition(chrome.probeCreated, "extension cannot query before native creates the fixed test tab")
            verifyCalls += 1
            done(["phase": (holdHandshake || verifyCalls == 1) ? "waiting_helper" : "probe_verified", "active": active, "code": NSNull(), "helper_seen": helperSeen])
        case "finish": if holdFinish { finishCallback = done } else { done(doneStatus) }
        case "cancel": done(["phase": "stopped", "active": false, "code": body["code"] ?? ChromeInstallCode.cancelled.rawValue])
        default: preconditionFailure("unexpected fake API route")
        }
    }
    func pump() {
        var rounds = 0
        while !scheduled.isEmpty { rounds += 1; precondition(rounds < 2000, "bounded fake scheduler"); scheduled.removeFirst()() }
    }
    func count(_ suffix: String) -> Int { requests.filter { $0.0.hasSuffix("/" + suffix) }.count }
    func start(profileID: String = "Default") -> [String: Any] { var result: [String: Any] = [:]; installer.start(profileID:profileID) { result = $0 }; return result }
}

@main struct ChromeHelperInstallTests {
    static func main() throws {
        if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--fingerprint" {
            print(try ChromeInstallSource.fingerprint(runtime: URL(fileURLWithPath: CommandLine.arguments[2])))
            return
        }
        var checks = 0
        func expect(_ condition: @autoclosure () -> Bool, _ message: String) { precondition(condition(), message); checks += 1 }
        func scenario(_ body: (Harness) throws -> Void) throws { let h = try Harness(); try body(h); h.installer.cancel(); h.chrome.close(); h.scheduled.removeAll() }
        let numeric = "1.0.0.1042", named = "1.0.0-beta.4 (1042)"
        expect(ChromeInstallSource.displayVersion(["version":numeric,"version_name":named],numericVersion:numeric) == named,"Chrome named display version is used for AX, not its internal numeric version")
        expect(ChromeInstallSource.displayVersion(["version":numeric],numericVersion:numeric) == numeric,"unnamed manifest displays numeric version")
        let invalidNames: [Any] = ["", "   ", "release\n1042", String(repeating:"x",count:161), 1042]
        for invalid in invalidNames {
            expect(ChromeInstallSource.displayVersion(["version":numeric,"version_name":invalid],numericVersion:numeric) == numeric,"invalid or empty display version falls back to numeric version")
        }
        expect(ChromeInstallSource.displayVersion(["version_name":" 1.0 beta "],numericVersion:numeric) == " 1.0 beta ","valid display text is preserved exactly rather than rewritten")
        expect(ChromeInstallSource.openedPathMatches("/fixture/file",expected:"/fixture/file"),"exact descriptor path")
        expect(ChromeInstallSource.openedPathMatches("/private/var/folders/fixture/file",expected:"/var/folders/fixture/file"),"macOS Foundation /var alias and F_GETPATH physical path")
        expect(ChromeInstallSource.openedPathMatches("/private/tmp/fixture/file",expected:"/tmp/fixture/file"),"macOS /tmp physical counterpart")
        expect(!ChromeInstallSource.openedPathMatches("/private/var/folders/other/file",expected:"/var/folders/fixture/file"),"different physical source is rejected")
        expect(!ChromeInstallSource.openedPathMatches("/private/various/file",expected:"/various/file"),"alias comparison requires exact directory boundary")
        expect(!ChromeInstallSource.openedPathMatches("/outside/file",expected:"/fixture/file"),"arbitrary linked parent is not an accepted alias")
        try scenario { h in
            let path = h.runtime.path
            let logical = path.hasPrefix("/private/var/") ? String(path.dropFirst("/private".count)) : path
            if logical.hasPrefix("/var/") {
                let alias = URL(fileURLWithPath:logical,isDirectory:true), physical = URL(fileURLWithPath:"/private"+logical,isDirectory:true)
                let aliasHash = try ChromeInstallSource.fingerprint(runtime:alias)
                let physicalHash = try ChromeInstallSource.fingerprint(runtime:physical)
                expect(aliasHash == physicalHash && aliasHash == h.response["source_fingerprint"] as? String,"real /var and /private/var fixture reads have the same source digest")
            }
            let linked = h.root.appendingPathComponent("arbitrary-runtime-link",isDirectory:true)
            try FileManager.default.createSymbolicLink(at:linked,withDestinationURL:h.runtime)
            do { _ = try ChromeInstallSource.fingerprint(runtime:linked); expect(false,"arbitrary parent source link must fail") }
            catch { expect(error as? ChromeInstallCode == .source,"arbitrary parent link remains rejected") }
        }
        func policy(_ values: [String: String], expected: ChromeInstallCode? = nil) {
            do { try ChromeInstallPolicies.check(values, helperID: "fdkpegpobipiidkdcjldomfbkemjdpfd"); expect(expected == nil, "policy permits only unambiguous cases") }
            catch { expect(error as? ChromeInstallCode == expected, "policy blocker/unknown contract") }
        }
        policy([:]); policy(["DeveloperToolsAvailability":"2"], expected:.managed)
        policy(["DeveloperToolsAvailability":"2","ExtensionDeveloperModeSettings":"0"])
        policy(["ExtensionDeveloperModeSettings":"1"], expected:.managed)
        policy(["ExtensionDeveloperModeSettings":"99"], expected:.controls)
        policy(["ExtensionInstallBlocklist":"[\"*\"]"], expected:.managed)
        policy(["ExtensionInstallBlocklist":"[\"*\"]","ExtensionInstallAllowlist":"[\"fdkpegpobipiidkdcjldomfbkemjdpfd\"]"], expected:.controls)
        policy(["ExtensionSettings":"{\"*\":{\"installation_mode\":\"blocked\"},\"fdkpegpobipiidkdcjldomfbkemjdpfd\":{\"installation_mode\":\"allowed\"}}"])
        policy(["ExtensionSettings":"{\"fdkpegpobipiidkdcjldomfbkemjdpfd\":{\"installation_mode\":\"removed\"}}"], expected:.managed)
        expect(!ChromeInstallLease.validProfile("Profile 1234567"), "profile ID is limited to six digits")
        try scenario { h in
            h.chrome.policyFailure = .managed; _ = h.start(); h.pump()
            expect(h.installer.lastCode == .managed && !h.chrome.actions.contains(.developerMode) && !h.chrome.actions.contains(.loadUnpacked), "managed policy blocks before install controls")
            let evidence = h.requests.filter { $0.0.hasSuffix("/evidence") }.first?.1
            expect(evidence?["lease_id"] as? String == h.leaseID && evidence?["code"] as? String == ChromeInstallCode.managed.rawValue, "failure evidence is private and bound to the failed lease")
            expect(evidence?["evidence_code"] as? String == "CHROME_INSTALL_EVIDENCE_UNAVAILABLE", "pure fixture never captures real windows")
            let cancelled = h.requests.firstIndex { $0.0.hasSuffix("/cancel") } ?? Int.max
            let archived = h.requests.firstIndex { $0.0.hasSuffix("/evidence") } ?? -1
            expect(cancelled < archived, "failure archive waits for confirmed stopped lease")
        }
        try scenario { h in
            h.chrome.inputReady = false; _ = h.start()
            expect(h.chrome.actions.isEmpty && !h.scheduled.isEmpty, "locked/sleeping session waits without input")
            h.chrome.inputReady = true; h.pump()
            expect(h.count("finish") == 1, "wake revalidates and proceeds once")
        }
        try scenario { h in
            h.chrome.inputReady = false; _ = h.start(); h.clock += 91; h.pump()
            expect(h.chrome.actions.isEmpty && h.installer.lastCode == .timeout, "locked wait cannot extend lease or send input at expiry")
        }
        try scenario { h in
            h.chrome.policyFailure = .managed; h.chrome.holdEvidence = true; _ = h.start(); h.pump()
            expect(h.count("cancel") == 1 && h.count("evidence") == 0 && !h.installer.active, "asynchronous evidence cannot delay stop")
            h.chrome.policyFailure = nil; h.chrome.holdEvidence = false; _ = h.start(); h.pump()
            h.chrome.evidenceCallback?()
            expect(h.count("evidence") == 0 && h.count("finish") == 1, "new start invalidates late evidence from old target")
        }
        try scenario { h in
            let response = h.start(); expect(response["started"] as? Bool == true, "immediate started reply")
            expect(Set(response.keys) == ["started"], "no private lease/URL/folder/title in renderer reply")
            h.pump(); expect(!h.installer.active, "successful chain settles")
            expect(h.count("finish") == 1 && h.count("cancel") == 0, "dual proof finishes once")
            expect(h.verifyCalls == 2, "verify polls waiting-helper once without repeating input")
            for action in [ChromeInstallAction.developerMode, .loadUnpacked, .goToFolder, .folderPath, .submitFolder, .openFolder, .probeURL] {
                expect(h.chrome.actions.filter { $0 == action }.count == 1, "one attempt for " + action.rawValue)
            }
            expect(h.chrome.actions.filter { $0 == .newTab }.count == 3, "owned setup tab, installed-profile check and independent final profile tab")
            expect(h.chrome.checks.filter { $0.1 }.count == h.chrome.actions.count, "status/local validation before every input")
            let finish = h.requests.first { $0.0.hasSuffix("/finish") }!.1
            expect(finish["native_verified"] as? Bool == true, "native finish evidence")
        }
        try scenario { h in
            h.chrome.developer = true
            h.chrome.delays = [.newTab: 2, .chooser: 3, .goFolder: 2, .selectedFolder: 3, .chooserClosing: 4]
            _ = h.start(); h.pump()
            expect(h.count("finish") == 1, "known delayed modal appear/dismiss can be observed")
            expect(!h.chrome.actions.contains(.developerMode), "already enabled developer mode skipped")
            for action in [ChromeInstallAction.loadUnpacked, .goToFolder, .submitFolder, .openFolder] {
                expect(h.chrome.actions.filter { $0 == action }.count == 1, "animation does not replay " + action.rawValue)
            }
        }
        try scenario { h in
            h.chrome.needsLaunch = true; h.chrome.delays[.runningChrome] = 3
            _ = h.start(); h.pump()
            expect(h.count("finish") == 1, "installed stopped Chrome can launch and settle through the same chain")
            expect(h.chrome.actions.first == .launchChrome && h.chrome.actions.filter { $0 == .launchChrome }.count == 1, "background launch is lease-guarded and never replayed")
            expect(h.chrome.checks.first?.1 == true, "launch has status plus local input guard")
        }
        for enabled in [true,false] {
            try scenario { h in
                h.chrome.existingHelper = true; h.chrome.helperEnabled = enabled
                _ = h.start(); h.pump()
                expect(h.count("finish") == 1, "existing helper can verify through a fresh reload")
                expect(h.chrome.actions.filter{$0 == .reloadHelper}.count == 1, "existing helper reload attempted once")
                expect(h.chrome.actions.filter{$0 == .enableHelper}.count == (enabled ? 0 : 1), "disabled correct helper enabled once")
                expect(!h.chrome.actions.contains(.loadUnpacked) && !h.chrome.actions.contains(.openFolder), "existing helper does not duplicate-load or remove")
            }
        }
        try scenario { h in
            h.chrome.existingHelper = true; h.chrome.helperEnabled = false; h.chrome.helperSourceFailure = true
            _ = h.start(); h.pump(); expect(!h.chrome.actions.contains(.enableHelper) && !h.chrome.actions.contains(.reloadHelper) && h.count("finish") == 0, "unproven existing source cannot enable/reload/claim installed")
        }
        try scenario { h in
            h.response["profile_id"] = "Profile 3"; h.chrome.profile = "/fixture/Chrome/Profile 3"
            _ = h.start(profileID:"Profile 3"); h.pump()
            expect(h.count("finish") == 1 && h.requests.first?.1["profile_id"] as? String == "Profile 3", "validated chosen profile bound to lease and both profile checks")
        }
        try scenario { h in
            _ = h.start(profileID:"../Default"); expect(h.requests.isEmpty && h.chrome.actions.isEmpty, "unregistered profile syntax rejected before API/input")
        }
        try scenario { h in
            h.chrome.profile = "/fixture/Chrome/Profile 2"; _ = h.start(); h.pump()
            expect(h.installer.lastCode == .profile && !h.chrome.actions.contains(.loadUnpacked), "wrong selected profile stops before install")
        }
        for code in [ChromeInstallCode.accessibility, .chromeMissing, .target, .sheet] {
            try scenario { h in h.chrome.preflightFailure = code; let r = h.start(); expect((r["error"] as? [String: Any])?["code"] as? String == code.rawValue, "preflight fixed failure"); expect(h.requests.isEmpty && h.chrome.actions.isEmpty, "invalid local evidence rejects before network/input") }
        }
        try scenario { h in
            h.holdStart = true; _ = h.start(); let second = h.start()
            expect((second["error"] as? [String: Any])?["code"] as? String == ChromeInstallCode.busy.rawValue, "duplicate start refused")
            expect(h.count("start") == 1, "no duplicate server start")
            h.installer.cancel(); h.startCallback?(h.response); h.pump()
            expect(h.count("cancel") == 1 && h.chrome.actions.isEmpty, "late start lease cancelled without input")
        }
        try scenario { h in
            h.holdStatus = true; _ = h.start(); h.installer.cancel(); h.statusCallback?(h.liveStatus); h.pump()
            expect(h.chrome.actions.isEmpty && h.count("finish") == 0, "cancelled status callback cannot post input")
        }
        for code in [ChromeInstallCode.interrupted, .target, .focus, .sheet, .source] {
            try scenario { h in h.onStatus = { h.chrome.failure = code }; _ = h.start(); h.pump(); expect(h.chrome.actions.isEmpty && h.installer.lastCode == code, "post-await local " + code.rawValue + " prevents input") }
        }
        try scenario { h in h.active = false; _ = h.start(); h.pump(); expect(h.chrome.actions.isEmpty && h.installer.lastCode == .permission, "revoked permission prevents input") }
        try scenario { h in
            h.chrome.actionFailure = .loadUnpacked; _ = h.start(); h.pump()
            expect(h.chrome.actions.filter { $0 == .loadUnpacked }.count == 1, "unknown load attempted once")
            expect(!h.chrome.actions.contains(.goToFolder) && h.count("finish") == 0 && h.installer.lastCode == .unconfirmed, "unknown load never continues or claims rollback/success")
        }
        try scenario { h in h.chrome.major = 127; _ = h.start(); h.pump(); expect(!h.chrome.actions.contains(.loadUnpacked) && h.installer.lastCode == .oldChrome, "old Chrome stops before install") }
        try scenario { h in h.chrome.finalProfile = "/fixture/Chrome/Profile 1"; _ = h.start(); h.pump(); expect(h.count("finish") == 0 && h.installer.lastCode == .otherProfile, "positive helper evidence plus other actual profile cannot claim target success") }
        try scenario { h in h.chrome.finalFingerprint = String(repeating: "c", count: 64); _ = h.start(); h.pump(); expect(h.count("finish") == 0 && h.installer.lastCode == .source, "final source mismatch cannot claim success") }
        try scenario { h in _ = h.start(); h.clock += 91; h.pump(); expect(h.installer.lastCode == .timeout && h.count("finish") == 0, "deadline stops all scheduled input") }
        try scenario { h in
            h.holdFinish = true; _ = h.start(); h.pump(); expect(h.count("finish") == 1, "finish pending")
            let actions = h.chrome.actions.count; h.installer.cancel(); h.finishCallback?(h.doneStatus); h.pump()
            expect(h.installer.lastCode == .cancelled && h.chrome.actions.count == actions, "late finish cannot resume cancelled chain")
        }
        for invalid in ["https://example.test/probe", "http://127.0.0.1:31416/api/browser/extension/install/probe/" + String(repeating: "b", count: 64), "http://127.0.0.1:31415/api/browser/extension/install/probe/" + String(repeating: "b", count: 64) + "?key=fixture"] {
            try scenario { h in h.response["probe_url"] = invalid; _ = h.start(); h.pump(); expect(h.chrome.actions.isEmpty && h.installer.lastCode == .invalidLease, "foreign/malformed probe rejected") }
        }
        try scenario { h in
            let file = h.runtime.appendingPathComponent("browser-extension/background.js")
            try FileManager.default.removeItem(at: file)
            try FileManager.default.createSymbolicLink(at: file, withDestinationURL: h.runtime.appendingPathComponent("browser-extension/driver.js"))
            _ = h.start(); expect(h.requests.isEmpty && h.chrome.actions.isEmpty, "symlink source rejected before network")
        }
        try scenario { h in
            try Data("wrong copy".utf8).write(to: h.helper.appendingPathComponent("background.js"))
            _ = h.start(); h.pump(); expect(h.chrome.actions.isEmpty && h.installer.lastCode == .source, "fixed copy must match bundled source before input")
        }
        try scenario { h in
            h.chrome.loadSucceeds = false; _ = h.start(); h.pump()
            expect(h.installer.lastCode == .notInstalled && h.verifyCalls == 0, "positive helper absence after picker closure is not installed, not a handshake timeout")
        }
        for seen in [false, true] {
            try scenario { h in
                h.holdHandshake = true; h.helperSeen = seen; _ = h.start(); h.pump()
                expect(h.installer.lastCode == (seen ? .handshakeTimeout : .nativeHost), "installed target distinguishes missing NativeHost from pending target challenge")
                expect(h.count("finish") == 0 && h.verifyCalls == 120, "global connected or helper presence never substitutes for the target probe")
                expect(h.requests.last(where:{$0.0.hasSuffix("/cancel")})?.1["code"] as? String == h.installer.lastCode?.rawValue, "four-way code reaches server diagnostic cancellation")
            }
        }
        try scenario { h in
            h.chrome.preflightFailure = .accessibility; _ = h.start(profileID:"Profile 4")
            expect(h.diagnostics.count == 2, "preflight failure has attempt start and terminal diagnostic")
            expect(h.diagnostics.last?["code"] as? String == ChromeInstallCode.accessibility.rawValue && h.diagnostics.last?["target_is_default"] as? Bool == false, "preflight diagnostic has code and default boolean only")
            let allowed = Set(["native_event","stage","elapsed_ms","target_is_default","code"])
            expect(h.diagnostics.allSatisfy { Set($0.keys).isSubset(of:allowed) }, "native diagnostics never forward profile ID, username, path, lease or helper content")
        }
        print("PASS: \(checks) isolated Chrome installer checks; fake adapter only, zero GUI/AX/events/OS permission/production state")
    }
}
