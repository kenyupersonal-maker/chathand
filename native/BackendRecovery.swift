import Foundation

// Pure recovery decisions. Never replays tools; only replaces a dead service
// owned by this App. Installer stop/verify/rollback keeps control of its process.
struct BackendRecoveryPolicy {
    private var attempts: [TimeInterval] = []
    private var unattachedAttempts = 0
    var attemptCount: Int { attempts.count }
    mutating func delay(now: TimeInterval) -> TimeInterval? {
        attempts.removeAll { now - $0 > 60 }
        guard attempts.count < 3 else { return nil }
        let delay = [0.5, 1.0, 2.0][attempts.count]
        attempts.append(now); return delay
    }
    // Startup failures can each consume the entire launch deadline. A rolling
    // minute alone would continually expire attempts and permit endless starts.
    mutating func recoveryDelay(now: TimeInterval) -> TimeInterval? {
        guard unattachedAttempts < 3, let next = delay(now: now) else { return nil }
        unattachedAttempts += 1
        return next
    }
    mutating func attached() { unattachedAttempts = 0 }
    static func installerActive(state: [String: Any], pending: [String: Any]?, result: [String: Any]?) -> Bool {
        if (state["lifecycle"] as? [String: Any])?["exit_requested"] as? Bool == true { return true }
        if let pending {
            guard let started = pending["started_at"] as? NSNumber else { return true }
            if let result, let status = result["status"] as? String,
               ["COMMITTED", "ROLLED_BACK", "FAILED", "ROLLBACK_FAILED", "ABORTED"].contains(status),
               let text = result["time"] as? String {
                let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                let date = formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
                if let date, date.timeIntervalSince1970 * 1000 >= started.doubleValue,
                   result["to"] as? String == pending["to"] as? String { return false }
            }
            return true
        }
        // A UI snapshot can say `verifying` while only checking a downloaded
        // package, before any installer exists. Only durable handoff/lifecycle
        // evidence above owns a backend exit; a stale presentation is not a lock.
        return false
    }
}
