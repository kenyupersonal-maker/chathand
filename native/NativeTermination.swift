import Foundation

/// One cleanup may serve either the App menu or a system Quit & Reopen request.
/// A pending system request must receive its reply, never a second terminate call.
struct NativeTerminationCoordinator {
    enum Decision { case cancel, later, now }
    enum Completion { case reply, terminate, none }
    private(set) var cleanupStarted = false
    private(set) var cleanupReady = false
    private(set) var systemReplyPending = false
    private var completionDelivered = false

    mutating func requestSystemTermination(uninstalling: Bool) -> Decision {
        guard !uninstalling else { return .cancel }
        guard !cleanupReady else { return .now }
        systemReplyPending = true
        return .later
    }

    mutating func beginCleanup() -> Bool {
        guard !cleanupStarted else { return false }
        cleanupStarted = true
        return true
    }

    mutating func finishCleanup() -> Completion {
        guard !completionDelivered else { return .none }
        cleanupStarted = true
        cleanupReady = true
        completionDelivered = true
        if systemReplyPending {
            systemReplyPending = false
            return .reply
        }
        return .terminate
    }
}
