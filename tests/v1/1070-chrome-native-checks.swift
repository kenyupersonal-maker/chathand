import Foundation

private var checks = 0
private func expect(_ condition: Bool, _ label: String) {
    precondition(condition, label); checks += 1
}
private final class Clock {
    var time: TimeInterval = 0
    var jobs: [(TimeInterval, () -> Void)] = []
    func schedule(_ delay: TimeInterval, _ work: @escaping () -> Void) { jobs.append((time + delay, work)) }
    func advance(_ target: TimeInterval) {
        var ticks = 0
        while let next = jobs.enumerated().filter({ $0.element.0 <= target }).min(by: { $0.element.0 < $1.element.0 }) {
            ticks += 1; precondition(ticks < 4000, "finite test scheduler")
            let job = jobs.remove(at: next.offset); time = job.0; job.1()
        }
        time = target
    }
}
private final class RepairChrome: ChromeInstallAdapter {
    var needsLaunch = false
    var exists = true, sourceMatches = false, current = true, enabled = true
    var actions: [ChromeInstallAction] = [], repairs: [ChromeInstallRepairAction] = []
    var checksBeforeInput = 0, inputs = 0, closed = 0
    var dialogVisible = false, removed = false, neverDisappears = false, unexpectedDialog = false
    var inputFailure: ChromeInstallCode?, policyFailure: ChromeInstallCode?
    var failRemove = false, holdHandshake = false
    var fingerprint = ""
    func preflight() throws {}
    func bind(_ lease: ChromeInstallLease) throws { fingerprint = lease.fingerprint }
    func check(_ stage: ChromeInstallStage, input: Bool) throws {
        if input { if let inputFailure { throw inputFailure }; checksBeforeInput += 1 }
    }
    func guardedInput() { inputs += 1; expect(checksBeforeInput == inputs, "every repair/install input has a fresh status and local guard") }
    func perform(_ action: ChromeInstallAction) throws {
        guardedInput(); actions.append(action)
        if action == .openFolder { exists = true; current = true; sourceMatches = true; enabled = true }
        if action == .enableHelper { enabled = true }
    }
    func observe(_ stage: ChromeInstallStage) throws -> ChromeInstallObservation? {
        switch stage {
        case .normal, .chooserClosing: return .chooserDismissed
        case .runningChrome: return .runningChrome
        case .newTab: return .newTab
        case .version, .finalVersion: return .version(profile: "/fixture/Chrome/Default", major: 130)
        case .policies: if let policyFailure { throw policyFailure }; return .policiesClear
        case .extensions: return .extensions(developerMode: true)
        case .helperList: return exists ? .helperFound : .missingHelper
        case .helperDetails: return .helperDetails(enabled: enabled, current: current)
        case .helperReady: return .helperReady
        case .chooser: return .chooser
        case .goFolder: return .pathEntry
        case .selectedFolder: return .selectedFolder
        case .probe: return .probe
        }
    }
    func checkRepair(_ stage: ChromeInstallRepairStage, input: Bool) throws {
        if unexpectedDialog && stage == .confirmation { throw ChromeInstallCode.sheet }
        if input { if let inputFailure { throw inputFailure }; checksBeforeInput += 1 }
    }
    func observeRepair(_ stage: ChromeInstallRepairStage) throws -> ChromeInstallRepairObservation? {
        switch stage {
        case .details: return .details(enabled: enabled, current: current, sourceMatches: sourceMatches)
        case .removable: return .removable
        case .confirmation: return dialogVisible ? .confirmation : nil
        case .removed: return removed && !neverDisappears ? .removed : nil
        }
    }
    func performRepair(_ action: ChromeInstallRepairAction) throws {
        guardedInput(); repairs.append(action)
        switch action {
        case .remove:
            if failRemove { throw ChromeInstallCode.unconfirmed }
            dialogVisible = true
        case .confirm: dialogVisible = false; removed = true; exists = false
        }
    }
    func finalEvidence() throws -> String { fingerprint }
    func close() { closed += 1 }
}
private final class RepairFixture {
    let clock = Clock(), chrome = RepairChrome(), runtime: URL, folder: URL
    var finished = false, cancelCode: String?, stages: [String] = []
    var permission = true
    lazy var installer = ChromeHelperInstaller(runtime: runtime, expectedFolder: folder, origin: { "http://127.0.0.1:31415" },
        api: { [unowned self] path, body, reply in self.api(path, body, reply) }, adapter: { [unowned self] in self.chrome },
        now: { [unowned self] in self.clock.time }, schedule: { [unowned self] delay, work in self.clock.schedule(delay, work) })
    init(_ parent: URL) throws {
        let root = parent.appendingPathComponent(UUID().uuidString)
        runtime = root.appendingPathComponent("runtime"); folder = root.appendingPathComponent("helper")
        for file in ChromeInstallSource.files {
            let destination = runtime.appendingPathComponent("browser-extension/" + file)
            try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(("synthetic source " + file).utf8).write(to: destination)
        }
        try FileManager.default.copyItem(at: runtime.appendingPathComponent("browser-extension"), to: folder)
    }
    func api(_ path: String, _ body: [String: Any], _ reply: ([String: Any]) -> Void) {
        switch path.split(separator: "/").last! {
        case "start": reply(["lease_id": String(repeating: "a", count: 32), "profile_id": "Default",
                             "probe_url": "http://127.0.0.1:31415/api/browser/extension/install/probe/" + String(repeating: "b", count: 64),
                             "extension_folder": folder.path, "source_fingerprint": try! ChromeInstallSource.fingerprint(runtime: runtime)])
        case "progress": stages.append(body["stage"] as! String); reply(["active": permission])
        case "status": reply(["active": permission])
        case "verify": reply(["active": true, "phase": chrome.holdHandshake ? "waiting_helper" : "probe_verified", "helper_seen": true])
        case "finish": finished = true; reply(["active": false, "phase": "installed_verified"])
        case "cancel": cancelCode = body["code"] as? String; reply(["phase": "stopped", "active": false])
        case "evidence": reply(["ok": true])
        default: fatalError("unexpected route")
        }
    }
    func start(_ repair: Bool = true) {
        installer.start(profileID: "Default", repair: repair) {
            let code = ($0["error"] as? [String: Any])?["code"] as? String ?? "NONE"
            expect($0["started"] as? Bool == true, "private installer starts: " + code)
        }
    }
    func finish() { clock.advance(100) }
}

@main struct Chrome1070Checks {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1]).resolvingSymlinksInPath()
        // C1 uses no AX/system UI. Every poll and timestamp is fake.
        do {
            let clock = Clock(); var reads = 0, trace: [String] = [], replies = 0
            let wait = ChromeAccessibilityWait(now: { clock.time }, schedule: clock.schedule, trusted: { reads += 1; return clock.time >= 3 })
            wait.start(onWaiting: { trace.append("waiting") }, onGranted: { trace.append("granted") }) { result in
                if case .success = result { trace.append("success") }; replies += 1
            }
            clock.advance(2.9); expect(wait.active && reads == 3, "poll once per second before grant")
            clock.advance(3); expect(!wait.active && trace == ["waiting", "granted", "success"], "automatically continues once after grant")
            clock.advance(500); expect(replies == 1 && reads == 4, "no late completion or further AX reads")
        }
        do {
            let clock = Clock(); var trusted = false, reply: ChromeInstallCode?, grants = 0, busy: ChromeInstallCode?
            let wait = ChromeAccessibilityWait(now: { clock.time }, schedule: clock.schedule, trusted: { trusted })
            wait.start(onWaiting: {}, onGranted: { grants += 1 }) { if case .failure(let code) = $0 { reply = code } }
            wait.start(onWaiting: { fatalError("duplicate guidance") }, onGranted: { fatalError("duplicate grant") }) { if case .failure(let code) = $0 { busy = code } }
            expect(busy == .busy && wait.active, "duplicate start preserves original intent")
            clock.advance(179); trusted = true; clock.advance(180)
            expect(reply == .accessibilityTimeout && grants == 0 && !wait.active, "180-second deadline cannot grant expired authority")
        }
        do {
            let clock = Clock(); var replies: [ChromeInstallCode] = [], grants = 0, trusted = false
            let wait = ChromeAccessibilityWait(now: { clock.time }, schedule: clock.schedule, trusted: { trusted })
            wait.start(onWaiting: {}, onGranted: { grants += 1 }) { if case .failure(let code) = $0 { replies.append(code) } }
            wait.cancel(); trusted = true
            wait.start(onWaiting: { fatalError("already trusted must not open UI") }, onGranted: { grants += 1 }) { _ in }
            clock.advance(200)
            expect(replies == [.cancelled] && grants == 1, "cancelled timers cannot affect a new attempt")
            trusted = false
            wait.start(onWaiting: { wait.cancel() }, onGranted: { fatalError("cancelled guidance") }) { if case .failure(let code) = $0 { replies.append(code) } }
            expect(replies == [.cancelled, .cancelled] && clock.jobs.isEmpty, "cancel during guidance never schedules work")
        }
        // C2 only responds opened after an independent, bounded page observation.
        do {
            let clock = Clock(); var observed = false, opens = 0, replies: [[String: Any]] = []
            let opener = ChromeExtensionsPageOpen(requestOpen: { current, done in expect(current(), "open has live intent"); opens += 1; done(.success(())) },
                observe: { _, done in done(.success(observed)) }, now: { clock.time }, schedule: clock.schedule)
            opener.start { replies.append($0) }; clock.advance(1)
            expect(replies.isEmpty, "launch receipt alone cannot report opened")
            observed = true; clock.advance(1.2)
            expect(replies.count == 1 && replies[0]["opened"] as? Bool == true && opens == 1, "new page evidence completes once without relaunch")
            clock.advance(12); expect(replies.count == 1, "success ignores watchdog")
        }
        do {
            let clock = Clock(); var callback: ((Result<Bool, ChromeExtensionsPageCode>) -> Void)?, reply: [String: Any] = [:]
            let opener = ChromeExtensionsPageOpen(requestOpen: { _, done in done(.success(())) }, observe: { _, done in callback = done }, now: { clock.time }, schedule: clock.schedule)
            opener.start { reply = $0 }; clock.advance(10); callback?(.success(true))
            expect(reply["error_code"] as? String == ChromeExtensionsPageCode.unverified.rawValue && reply["opened"] == nil, "hung or late AX cannot falsely confirm a page")
        }
        do {
            let clock = Clock(); var current: (() -> Bool)?, delivered: ((Result<Void, ChromeExtensionsPageCode>) -> Void)?, replies: [[String: Any]] = [], reads = 0
            let opener = ChromeExtensionsPageOpen(requestOpen: { alive, done in current = alive; delivered = done }, observe: { _, _ in reads += 1 }, now: { clock.time }, schedule: clock.schedule)
            opener.start { replies.append($0) }; opener.cancel(); delivered?(.success(())); clock.advance(20)
            expect(current?() == false && reads == 0 && replies.count == 1, "cancel invalidates pending launch and observation")
            expect(replies[0]["error_code"] as? String == ChromeExtensionsPageCode.cancelled.rawValue, "cancel has explicit code")
        }
        for code in [ChromeExtensionsPageCode.accessibility, .unavailable, .failed] {
            var reply: [String: Any] = [:]
            let opener = ChromeExtensionsPageOpen(requestOpen: { _, done in done(.failure(code)) }, observe: { _, _ in fatalError("failed launch must not observe") }, schedule: { _, _ in })
            opener.start { reply = $0 }; expect(reply["error_code"] as? String == code.rawValue, "explicit launch/permission failure")
        }
        expect(ChromeExtensionsPageOpen.isExtensionsPage(address: "chrome://extensions/", documentURL: "chrome://extensions/", title: "扩展程序", developerControl: true), "actual fixed page signature")
        for address in ["https://example.invalid/chrome://extensions", "chrome://extensions/?id=other", "chrome://settings"] {
            expect(!ChromeExtensionsPageOpen.isExtensionsPage(address: address, documentURL: "chrome://extensions/", title: "Extensions", developerControl: true), "lookalike/wrong internal page rejected")
        }
        expect(!ChromeExtensionsPageOpen.isExtensionsPage(address: "chrome://extensions", documentURL: "chrome://extensions/", title: "New Tab", developerControl: true), "typed but not navigated address rejected")
        expect(!ChromeExtensionsPageOpen.isExtensionsPage(address: "chrome://extensions", documentURL: "chrome://extensions/", title: "Extensions", developerControl: false), "missing page control rejected")
        expect(!ChromeExtensionsPageOpen.isExtensionsPage(address: "chrome://extensions", documentURL: "https://example.invalid/", title: "Extensions", developerControl: true), "a typed omnibox URL over lookalike content cannot prove navigation")
        // C3: wrong folder and stale same-folder both remove only via explicit repair.
        for wrongFolder in [true, false] {
            let f = try RepairFixture(root); f.chrome.sourceMatches = !wrongFolder; f.chrome.current = wrongFolder; f.start(); f.finish()
            expect(f.finished && f.installer.lastCode == nil, "repair reaches fresh profile/probe/finish verification")
            expect(f.chrome.repairs.count == 2 && f.chrome.removed, "repair removes and confirms exactly once")
            expect(f.chrome.actions.filter { $0 == .loadUnpacked }.count == 1 && f.chrome.actions.contains(.probeURL), "loads the verified folder and checks fresh probe")
            expect(f.stages.contains("removing_copy"), "repair shares the progress channel")
        }
        do {
            let f = try RepairFixture(root); f.chrome.sourceMatches = true; f.chrome.enabled = false; f.start(); f.finish()
            expect(f.finished && f.chrome.repairs.isEmpty && f.chrome.actions.contains(.enableHelper) && f.chrome.actions.contains(.reloadHelper), "current correct helper is enabled/reloaded without removal")
        }
        do {
            let f = try RepairFixture(root); f.chrome.exists = false; f.start(); f.finish()
            expect(f.finished && f.chrome.repairs.isEmpty && !f.stages.contains("removing_copy"), "absent helper uses normal installation")
        }
        do {
            let f = try RepairFixture(root); f.chrome.sourceMatches = true; f.start(false); f.finish()
            expect(f.finished && f.chrome.repairs.isEmpty, "legacy start never invokes repair adapter methods")
        }
        do {
            let f = try RepairFixture(root); f.chrome.failRemove = true; f.start(); f.finish()
            expect(f.installer.lastCode == .unconfirmed && f.chrome.repairs.count == 1 && !f.finished, "uncertain removal is never retried or continued")
        }
        do {
            let f = try RepairFixture(root); f.chrome.unexpectedDialog = true; f.start(); f.finish()
            expect(f.installer.lastCode == .sheet && f.chrome.repairs.count == 1 && !f.finished, "unrelated confirmation blocks destructive action")
        }
        do {
            let f = try RepairFixture(root); f.chrome.neverDisappears = true; f.start(); f.finish()
            expect(f.installer.lastCode == .timeout && !f.chrome.actions.contains(.loadUnpacked) && !f.finished, "no load before confirmed removal")
        }
        do {
            let f = try RepairFixture(root); f.chrome.policyFailure = .managed; f.start(); f.finish()
            expect(f.installer.lastCode == .managed && f.chrome.repairs.isEmpty, "policy blocks repair before removal")
        }
        do {
            let f = try RepairFixture(root); f.chrome.holdHandshake = true; f.start(); f.finish()
            expect(!f.finished && f.installer.lastCode == .handshakeTimeout, "UI installation is not handshake acceptance")
        }
        do {
            let f = try RepairFixture(root); f.start(); f.installer.cancel(); f.finish()
            expect(f.installer.lastCode == .cancelled && f.chrome.repairs.isEmpty && !f.finished, "cancelled repair has no delayed removal")
        }
        let name = "ChatHand Test Helper"
        let catalogs: [[String: Any]] = [["helperName": ["message": "ChatHand Chrome 插件"]], ["helperName": ["message": "ChatHand Chrome extension"]]]
        expect(try ChromeInstallSource.displayNames("__MSG_helperName__", catalogs: catalogs) == Set(["ChatHand Chrome 插件", "ChatHand Chrome extension"]), "manifest name resolves only fingerprinted locale names")
        expect(try ChromeInstallSource.displayNames(name, catalogs: []) == [name], "literal legacy name remains exact")
        for malformed in ["__MSG_missing__", "__MSG_helperName", "__MSG_../helperName__"] {
            do { _ = try ChromeInstallSource.displayNames(malformed, catalogs: catalogs); fatalError("unknown locale name accepted") }
            catch { expect(error as? ChromeInstallCode == .source, "unknown name cannot authorize a card") }
        }
        let fixedID = String(repeating: "a", count: 32)
        expect(ChromeRepairEvidence.isFixedID("ID: " + fixedID, expected: fixedID), "exact fixed ID recognized")
        for value in [String(repeating: "b", count: 32), fixedID + "a", "other " + fixedID, name] {
            expect(!ChromeRepairEvidence.isFixedID(value, expected: fixedID), "same name or similar ID grants no removal authority")
        }
        expect(ChromeRepairEvidence.removalTitle("Remove “\(name)” ?", helperName: name) == false, "uncertain removal text is not guessed")
        expect(ChromeRepairEvidence.removalTitle("Remove “\(name)”?", helperName: name), "exact fixed helper removal title")
        expect(!ChromeRepairEvidence.removalTitle("Remove “Other Helper”?", helperName: name), "other helper cannot be removed")
        expect(!ChromeRepairEvidence.removalTitle("Remove “\(name)” and all apps?", helperName: name), "name substring never grants removal")
        expect(try ChromeRepairEvidence.sourcePath(["/fixture/copy", "/fixture/copy"]) == "/fixture/copy", "source duplicates normalize without reading a directory")
        for paths in [[], ["/fixture/a", "/fixture/b"], ["/fixture/../other"], ["relative"]] {
            do { _ = try ChromeRepairEvidence.sourcePath(paths); fatalError("ambiguous source accepted") }
            catch { expect(error as? ChromeInstallCode == .source, "unknown source fails closed") }
        }
        print("PASS: \(checks) 1070 Chrome native checks; virtual clock/AX/browser/API and synthetic source only")
    }
}
