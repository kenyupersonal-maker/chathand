import AppKit
import Foundation

private func check(_ value: Bool, _ label: String) {
    if !value { fputs("FAIL: \(label)\n", stderr); exit(1) }
}

private func pureChecks() {
    var system = NativeTerminationCoordinator()
    check(system.requestSystemTermination(uninstalling:false) == .later, "system waits for cleanup")
    check(system.beginCleanup(), "cleanup starts once")
    check(system.requestSystemTermination(uninstalling:false) == .later, "repeated system request stays pending")
    check(!system.beginCleanup(), "repeated request does not restart cleanup")
    check(system.finishCleanup() == .reply, "system request receives reply")
    check(system.finishCleanup() == .none, "completion cannot reply twice")
    check(system.requestSystemTermination(uninstalling:false) == .now, "finished cleanup can exit")

    var menu = NativeTerminationCoordinator()
    check(menu.beginCleanup(), "menu starts cleanup")
    check(menu.finishCleanup() == .terminate, "menu completes through terminate")
    check(menu.requestSystemTermination(uninstalling:false) == .now, "menu termination is not deferred again")

    var migration = NativeTerminationCoordinator()
    check(migration.beginCleanup(), "migration quit starts cleanup")
    check(migration.requestSystemTermination(uninstalling:false) == .later, "system joins migration cleanup")
    check(migration.systemReplyPending && !migration.cleanupReady, "migration retains pending request until child completes")
    check(migration.finishCleanup() == .reply, "migration completion replies instead of terminating twice")

    var uninstall = NativeTerminationCoordinator()
    check(uninstall.requestSystemTermination(uninstalling:true) == .cancel, "uninstall retains its own lifetime")
    check(!uninstall.systemReplyPending, "cancelled uninstall request creates no pending reply")
    check(uninstall.finishCleanup() == .terminate, "completed uninstall can terminate")
    check(uninstall.requestSystemTermination(uninstalling:false) == .now, "completed uninstall exits immediately")
    print("PASS: termination coordinator system/menu/migration/uninstall")
}

private final class FixtureDelegate: NSObject, NSApplicationDelegate {
    let state: URL
    let delayed: Bool
    let receipt: URL
    var coordinator = NativeTerminationCoordinator()
    var lease: InstanceLifecycle.Lease?
    var cleanupCount = 0
    var replyCount = 0
    var terminateCount = 0
    init(state: URL, delayed: Bool, receipt: URL) { self.state=state;self.delayed=delayed;self.receipt=receipt }
    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            lease = try InstanceLifecycle.acquire(state:state)
            check(lease != nil, "fixture acquires instance lease")
            check(try InstanceLifecycle.acquire(state:state) == nil, "lease excludes a simultaneous restart")
        } catch { fputs("FAIL: fixture lease \(error)\n",stderr);exit(2) }
        try? JSONSerialization.data(withJSONObject:["pid":getpid()]).write(to:receipt.appendingPathExtension("ready"))
        DispatchQueue.main.asyncAfter(deadline:.now()+4) { fputs("FAIL: AppKit quit did not complete\n",stderr);exit(4) }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        switch coordinator.requestSystemTermination(uninstalling:false) {
        case .cancel: return .terminateCancel
        case .now: return .terminateNow
        case .later:
            if coordinator.beginCleanup() {
                cleanupCount += 1
                DispatchQueue.main.asyncAfter(deadline:.now()+(delayed ? 0.4:0.01)) {
                    switch self.coordinator.finishCleanup() {
                    case .reply:
                        self.replyCount += 1
                        sender.reply(toApplicationShouldTerminate:true)
                    case .terminate:
                        self.terminateCount += 1
                        sender.terminate(nil)
                    case .none:break
                    }
                }
            }
            return .terminateLater
        }
    }
    func applicationWillTerminate(_ notification: Notification) {
        lease = nil
        do {
            let restarted = try InstanceLifecycle.acquire(state:state)
            check(restarted != nil, "willTerminate releases the old instance lease")
        } catch { fputs("FAIL: restart lease \(error)\n",stderr);exit(3) }
        check(cleanupCount == 1 && replyCount == 1 && terminateCount == 0, "one cleanup replies once without a second terminate")
        try? JSONSerialization.data(withJSONObject:["completed":true,"cleanup_count":cleanupCount,"reply_count":replyCount,"terminate_count":terminateCount,"lease_released":true]).write(to:receipt)
        print("PASS: isolated AppKit normal termination and instance lease release")
        fflush(stdout)
    }
}

@main struct TerminationChecks {
    static func main() {
        let args=CommandLine.arguments
        if args.count == 4 && args[1] == "request" {
            guard let pid=Int32(args[2]),let app=NSRunningApplication(processIdentifier:pid),
                  app.bundleURL?.path == args[3],app.bundleIdentifier == "test.chathand.termination1070" else { exit(5) }
            check(app.terminate(), "normal termination request is accepted")
            print("REQUESTED")
            return
        }
        guard args.count == 4 else { pureChecks();return }
        let application = NSApplication.shared
        application.setActivationPolicy(.prohibited)
        let delegate = FixtureDelegate(state:URL(fileURLWithPath:args[2]), delayed:args[1] == "migration", receipt:URL(fileURLWithPath:args[3]))
        application.delegate = delegate
        application.run()
        withExtendedLifetime(delegate) {}
    }
}
