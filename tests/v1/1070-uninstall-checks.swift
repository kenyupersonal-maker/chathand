import Foundation
import Darwin

// Disposable filesystem + stdin owner adapter. No AppKit, real HOME lookup,
// keychain, login item, system preferences, process stop or network access.
@main struct UninstallRevokeChecks {
    @MainActor static var reply: (([String: Any]) -> Void)?
    @MainActor static var stopped: CheckedContinuation<Void, Never>?
    @MainActor static var backendStopped = false
    @MainActor static var callbacks = 0
    static func emit(_ row: [String: Any]) {
        let bytes = try! JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
        FileHandle.standardOutput.write(bytes + Data([10]))
    }
    @MainActor static func main() async throws {
        let fm = FileManager.default
        let root = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
        let mode = CommandLine.arguments[2]
        guard root.lastPathComponent.hasPrefix("1070-uninstall-"),
              try String(contentsOf: root.appendingPathComponent(".fixture"), encoding: .utf8) == "disposable-1070" else { exit(64) }
        let home = root.appendingPathComponent("home"), app = home.appendingPathComponent("Applications/ChatHand.app")
        let state = home.appendingPathComponent("Library/Application Support/ChatHand/data")
        let plan = try ChatHandUninstallPlan(app: app, home: home, state: state, deleteData: mode != "keep", incremental: true)
        try plan.prepareAudit()
        let lease = try plan.excludeUpgrade()
        defer { lease.release() }
        var events: [[String: String]] = []
        func record(_ stage: String, _ code: String) {
            events.append(["phase": "uninstall_" + stage, "code": code])
            NativeDiagnostics.record(in: plan.auditState, phase: "uninstall_" + stage, code: code,
                                     backendPID: nil, generation: "00000000-0000-0000-0000-000000000000")
        }
        DispatchQueue.global().async {
            while let line = readLine(), let bytes = line.data(using: .utf8),
                  let message = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] {
                DispatchQueue.main.async {
                    if message["kind"] as? String == "owner_response", let body = message["body"] as? [String: Any] {
                        callbacks += 1; reply?(body)
                        if mode == "duplicate" { callbacks += 1; reply?(body) }
                    } else if message["kind"] as? String == "backend_stopped" {
                        backendStopped = true; stopped?.resume(); stopped = nil
                    }
                }
            }
        }
        let start = ProcessInfo.processInfo.systemUptime
        let result = await ChatHandUninstallRevoke.run(deleteData: plan.deleteData, ownerAvailable: mode != "owner_missing", request: { endpoint, body, done in
            reply = done
            emit(["kind": "request", "endpoint": endpoint, "empty_body": body.isEmpty])
        }, event: record)
        let elapsed = Int((ProcessInfo.processInfo.systemUptime - start) * 1000)
        emit(["kind": "revoke_done", "code": result.code.rawValue, "reason": result.reason.rawValue, "elapsed_ms": elapsed])
        await withCheckedContinuation { continuation in
            if backendStopped { continuation.resume() } else { stopped = continuation }
        }
        record("backend", "STOPPED")
        // Login removal is a test seam, not a real system operation.
        let report = plan.executeStages(backendStopped: backendStopped, loginRemoved: true, exclusion: lease, event: record)
        let lines = try String(contentsOf: plan.auditState.appendingPathComponent("diagnostics/native-events.jsonl"), encoding: .utf8).split(separator: "\n")
        let audit = try lines.map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
        let revoke = audit.filter { $0["phase"] as? String == "uninstall_revoke" }
        let removals = events.filter { $0["code"] == "REMOVED" }
        emit(["kind": "finished", "complete": report.complete, "app_present": fm.fileExists(atPath: app.path),
              "callback_count": callbacks, "total_ms": Int((ProcessInfo.processInfo.systemUptime - start) * 1000),
              "data_present": fm.fileExists(atPath: state.path), "app_last": removals.last?["phase"] == "uninstall_app",
              "revoke_events": revoke.count, "revoke_code": revoke.first?["code"] as? String ?? "MISSING",
              "revoke_before_stop": events.first?["phase"] == "uninstall_revoke",
              "audit_fields": Array(Set(audit.flatMap { $0.keys })).sorted()])
    }
}
