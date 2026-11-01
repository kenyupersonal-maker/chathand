import Foundation
import Darwin

// Read-only scope validation. This fixture never acquires a lifecycle lease,
// enumerates or signals processes, launches an App, or opens a state file.
@main struct UpgradeLaunchScopeFixture {
    static func main() {
        guard CommandLine.arguments.count == 3 else { exit(2) }
        let state = URL(fileURLWithPath: CommandLine.arguments[1])
        let app = URL(fileURLWithPath: CommandLine.arguments[2])
        do {
            let scope = try InstanceLifecycle.Scope.validated(
                environment: ProcessInfo.processInfo.environment,
                state: state, app: app, beforeMigration: true)
            print(scope.root == nil ? "production" : "rehearsal")
        } catch {
            print((error as? InstanceLifecycle.Failure)?.code ?? "SCOPE_CHECK_FAILED")
            exit(1)
        }
    }
}
