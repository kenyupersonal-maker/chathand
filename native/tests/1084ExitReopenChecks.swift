import AppKit
import Foundation
import Darwin

// Fixture-only host for the 1084 exit/reopen rehearsal. The Node test builds
// this into a private app bundle and supplies its exact private app path.
private func emit(_ file: URL, _ event: String, _ extra: [String: Any] = [:]) {
    var row = extra; row["event"] = event; row["pid"] = Int(getpid())
    row["uptime"] = ProcessInfo.processInfo.systemUptime
    row["time"] = Date().timeIntervalSince1970
    guard var data = try? JSONSerialization.data(withJSONObject: row) else { return }
    data.append(10)
    let fd = Darwin.open(file.path, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
    guard fd >= 0 else { return }; defer { Darwin.close(fd) }
    _ = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!, $0.count) }
}
private struct CancelBoolStub { func cancel() -> Bool { false } }
private struct CancelStub { func cancel() {} }
private struct CloseStub { func close() {} }
private struct UnregisterStub { func unregister() {} }
private struct UpdateStub { func update(_ value: Bool) {} }
private struct MigrationStub { func cancel() -> Bool { false } }
private enum ComputerControl { static var stopped = false }

private final class ExitReopenFixture: NSObject, NSApplicationDelegate {
    let appURL: URL
    let stateURL: URL
    let records: URL
    var startupLease: InstanceLifecycle.Lease?
    var instanceLease: InstanceLifecycle.Lease?
    var backend: Process?
    var ownerPipeWriter: FileHandle?
    var relaunchProcess: Process?
    var relaunchPipe: FileHandle?
    var reopenHelperPreparing = false
    var reopenHelperReady = false
    var reopenHelperDeadline: TimeInterval = 0
    var reopenReadyReader: FileHandle?
    var reopenReadyBytes = Data()
    var quitCompletionScheduled = false
    var migrationQuitPending = false
    var shuttingDown = false
    var ownsService = true
    let uninstallInProgress = false
    var instanceScope: InstanceLifecycle.Scope?
    var termination = NativeTerminationCoordinator()
    let probeWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 240, height: 120), styleMask: [.titled], backing: .buffered, defer: true)
    private var chromeWebStoreFlow = CancelBoolStub()
    private var chromeProfileDiscovery = CancelStub()
    private var chromeDataAccessResume = CancelStub()
    private var chromeInstallPreparation: Any?
    private var chromeHelperInstaller = CancelStub()
    private var clientFeatures = CloseStub()
    private var emergencyStopHotKey = UnregisterStub()
    private var keepAwake = UpdateStub()
    private var startupMigration = MigrationStub()
    var timer: Timer?
    var computerTimer: Timer?
    var process: Process? { backend }
    var packageURL: URL { appURL.appendingPathComponent("Contents/Resources/runtime") }

    init(app: URL) {
        appURL = app
        let root = app.deletingLastPathComponent()
        stateURL = root.appendingPathComponent("state", isDirectory: true)
        records = root.appendingPathComponent("events.jsonl")
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        guard let source = Bundle.main.bundleURL as URL? else { exit(2) }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let (gate, scope) = try InstanceLifecycle.startupCoordination(state: self.stateURL, source: source, environment: ProcessInfo.processInfo.environment)
                let quitDeadline = ProcessInfo.processInfo.systemUptime + 15
                let diagnostic: InstanceLifecycle.Diagnostic = { _, code, pid in emit(self.records, code, ["owner_pid": Int(pid)]) }
                let waitedStartup = try InstanceLifecycle.waitForRecordedQuittingOwner(state: gate, timeout: 15, diagnostic: diagnostic)
                let waitedData = try InstanceLifecycle.waitForRecordedQuittingOwner(state: self.stateURL, timeout: max(0, quitDeadline - ProcessInfo.processInfo.systemUptime), diagnostic: diagnostic)
                _ = try InstanceLifecycle.captureBackend(state: self.stateURL, source: source, scope: scope, exitingOwnerObserved: waitedStartup || waitedData)
                guard let startup = try InstanceLifecycle.claim(state: gate, source: source, build: 1084, scope: scope, activateExisting: false, diagnostic: diagnostic) else { exit(3) }
                guard let data = try InstanceLifecycle.claim(state: self.stateURL, source: source, build: 1084, scope: scope, activateExisting: false, diagnostic: diagnostic) else { exit(4) }
                DispatchQueue.main.async {
                    self.startupLease = startup; self.instanceLease = data; self.instanceScope = scope
                    emit(self.records, "OWNER_READY")
                    self.startBackend()
                }
            } catch { emit(self.records, "OWNER_START_FAILED", ["error": String(describing: error)]); exit(5) }
        }
    }

    private func startBackend() {
        let child = Process(); child.executableURL = appURL.appendingPathComponent("Contents/Resources/runtime/bin/ExitReopenBackend")
        child.arguments = ["--exit-reopen-backend"]
        let pipe = Pipe(); child.standardInput = pipe.fileHandleForReading; child.standardOutput = FileHandle.nullDevice; child.standardError = FileHandle.nullDevice
        do { try child.run(); try? pipe.fileHandleForReading.close(); backend = child; ownerPipeWriter = pipe.fileHandleForWriting; emit(records, "BACKEND_STARTED", ["backend_pid": Int(child.processIdentifier)]) }
        catch { emit(records, "BACKEND_START_FAILED", ["error": String(describing: error)]) }
    }

    private func show() { guard !shuttingDown else { return }; showProbe() }
    private func showAutomatically() { guard !shuttingDown else { return }; showProbe() }
    private func showProbe() {
        probeWindow.orderFront(nil)
        emit(records, "WINDOW_REQUESTIBLE", ["visible": probeWindow.isVisible, "miniaturized": probeWindow.isMiniaturized, "app_active": NSApp.isActive])
        DispatchQueue.main.async { self.probeWindow.orderOut(nil) }
    }
    __PRODUCTION_QUIT_BLOCK__
    __PRODUCTION_RELAUNCH_METHOD__
    __PRODUCTION_APPLICATION_SHOULD_TERMINATE__
    __PRODUCTION_APPLICATION_SHOULD_HANDLE_REOPEN__

    private func nativeRecord(_ phase: String, _ code: String) {
        var fields: [String: Any] = [:]
        if let process = relaunchProcess { fields["helper_pid"] = Int(process.processIdentifier) }
        if let backend { fields["backend_pid"] = Int(backend.processIdentifier) }
        emit(records, code, fields)
    }
    private func instanceRecord(_ phase: String, _ code: String, _ pid: Int32) {
        InstanceLifecycle.record(state: stateURL, phase: phase, code: code, build: 1084, pid: pid)
        nativeRecord(phase, code)
    }
    private func api(_ route: String, _ body: [String: Any], _ completion: @escaping ([String: Any]) -> Void) { completion([:]) }
    private func cancelChromePreparation() {}
    func applicationWillTerminate(_ note: Notification) {
        emit(records, "APP_WILL_TERMINATE")
        startupLease = nil; instanceLease = nil
    }
}

@main struct ExitReopenChecks {
    private static func controller(_ args: [String]) {
        guard args.count >= 2 else { exit(20) }
        let action = args[0], appURL = URL(fileURLWithPath: args[1])
        if action == "snapshot" {
            do {
                let running = try InstanceLifecycle.instances(source: appURL, scope: InstanceLifecycle.Scope(root: nil), excluding: getpid())
                let pids = running.map { Int($0.identity.pid) }
                let encoded = try JSONSerialization.data(withJSONObject: pids)
                print("{\"action\":\"snapshot\",\"pids\":\(String(data: encoded, encoding: .utf8)!)}")
                exit(0)
            } catch { fputs("fixture snapshot failed: \(error)\n", stderr); exit(24) }
        }
        if action == "quit", args.count == 3, let pid = Int32(args[2]),
           let running = NSRunningApplication(processIdentifier: pid), running.bundleIdentifier == "test.chathand.exitreopen1084",
           running.bundleURL?.standardizedFileURL == appURL.standardizedFileURL {
            guard running.terminate() else { exit(23) }
            print("{\"pid\":\(pid),\"action\":\"quit\"}")
            exit(0)
        }
        let config = NSWorkspace.OpenConfiguration()
        config.promptsUserIfNeeded = false; config.activates = false; config.addsToRecentItems = false
        config.allowsRunningApplicationSubstitution = false
        config.createsNewApplicationInstance = action == "launch"
        guard action == "launch" || action == "open" || action == "probe" else { exit(21) }
        var finished = false; var ok = false; var pid = 0
        NSWorkspace.shared.openApplication(at: appURL, configuration: config) { opened, error in
            pid = Int(opened?.processIdentifier ?? 0); ok = opened != nil && error == nil; finished = true
        }
        let until = Date().addingTimeInterval(8)
        while !finished && Date() < until { RunLoop.current.run(until: Date().addingTimeInterval(0.025)) }
        guard finished && ok else { exit(22) }
        print("{\"pid\":\(pid),\"action\":\"\(action)\"}")
        exit(0)
    }
    static func main() {
        if CommandLine.arguments.contains("--exit-reopen-backend") {
            _ = FileHandle.standardInput.readDataToEndOfFile()
            Thread.sleep(forTimeInterval: 2.5)
            return
        }
        if CommandLine.arguments.count > 1 && CommandLine.arguments[1] == "controller" { controller(Array(CommandLine.arguments.dropFirst(2))) }
        let app = NSApplication.shared; app.setActivationPolicy(.regular)
        let delegate = ExitReopenFixture(app: Bundle.main.bundleURL); app.delegate = delegate
        app.run(); withExtendedLifetime(delegate) {}
    }
}
