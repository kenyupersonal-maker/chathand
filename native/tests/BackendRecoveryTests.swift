import Foundation

@main struct BackendRecoveryTests {
    static func main() {
        var policy = BackendRecoveryPolicy()
        precondition(policy.delay(now: 1) == 0.5)
        precondition(policy.delay(now: 2) == 1)
        precondition(policy.delay(now: 3) == 2)
        precondition(policy.delay(now: 4) == nil)
        precondition(policy.delay(now: 62) == 2)
        let pending: [String: Any] = ["started_at": 1000, "to": "1.0.0-beta.10"]
        let active: [String: Any] = ["update": ["install": ["state": "verifying"]]]
        precondition(BackendRecoveryPolicy.installerActive(state: [:], pending: pending, result: nil))
        precondition(BackendRecoveryPolicy.installerActive(state: [:], pending: pending, result: ["status": "COMMITTED", "to": "old", "time": "2026-10-18T00:00:00.000Z"]))
        precondition(BackendRecoveryPolicy.installerActive(state: [:], pending: pending, result: ["status": "FAILED", "to": "1.0.0-beta.10", "time": "1970-01-01T00:00:00.000Z"]))
        for status in ["COMMITTED", "ROLLED_BACK", "FAILED", "ROLLBACK_FAILED"] {
            precondition(!BackendRecoveryPolicy.installerActive(state: active, pending: pending, result: ["status": status, "to": "1.0.0-beta.10", "time": "2026-10-18T00:00:00.000Z"]))
        }
        precondition(BackendRecoveryPolicy.installerActive(state: ["lifecycle": ["exit_requested": true]], pending: nil, result: nil))
        precondition(!BackendRecoveryPolicy.installerActive(state: active, pending: nil, result: nil))
        for presentation in ["installing", "restarting", "verifying"] {
            precondition(!BackendRecoveryPolicy.installerActive(state: ["update": ["install": ["state": presentation]]], pending: nil, result: nil))
        }
        precondition(!BackendRecoveryPolicy.installerActive(state: [:], pending: nil, result: nil))
        print("BackendRecoveryTests PASS")
    }
}
