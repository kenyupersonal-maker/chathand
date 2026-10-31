import Foundation

/// Menu-only preflight. The existing owner API owns authentication and signed
/// remote acknowledgement verification; no Site origin or credential enters here.
@MainActor enum ChatHandUninstallRevoke {
    static let timeoutSeconds: TimeInterval = 10
    typealias Request = (String, [String: Any], @escaping ([String: Any]) -> Void) -> Void

    enum Code: String { case confirmed = "CONFIRMED", unconfirmed = "UNCONFIRMED", skipped = "SKIPPED" }
    enum Reason: String {
        case keepData = "KEEP_DATA", ownerUnavailable = "OWNER_UNAVAILABLE", notConfigured = "NOT_CONFIGURED"
        case remoteConfirmed = "REMOTE_CONFIRMED", remoteUnconfirmed = "REMOTE_UNCONFIRMED"
        case ownerAPIError = "OWNER_API_ERROR", invalidResponse = "INVALID_RESPONSE", timeout = "TIMEOUT"
    }
    struct Result {
        let code: Code
        let reason: Reason
    }

    /// Call after the uninstall identity/update guards and before stopping the
    /// backend. A missing/late callback never holds up the remaining uninstall.
    /// `event` is the menu's existing recorder, which prefixes `uninstall_`.
    static func run(deleteData: Bool, ownerAvailable: Bool, request: Request,
                    event: @escaping (String, String) -> Void = { _, _ in }) async -> Result {
        func immediate(_ code: Code, _ reason: Reason) -> Result {
            event("revoke", code.rawValue)
            return Result(code: code, reason: reason)
        }
        guard deleteData else { return immediate(.skipped, .keepData) }
        guard ownerAvailable else { return immediate(.unconfirmed, .ownerUnavailable) }
        return await withCheckedContinuation { continuation in
            let pending = Pending(continuation: continuation, event: event)
            // Schedule before issuing the request: the whole owner round trip,
            // including lost/generation-fenced callbacks, shares this deadline.
            let deadline = DispatchSource.makeTimerSource(flags: .strict, queue: .main)
            deadline.setEventHandler { pending.finish(Result(code: .unconfirmed, reason: .timeout)) }
            pending.deadline = deadline
            deadline.schedule(deadline: .now() + timeoutSeconds, leeway: .nanoseconds(0))
            deadline.resume()
            request("/api/site-b/revoke", [:]) { response in
                // The owner API currently replies on main; this also makes test
                // transports and future callers safe when they reply elsewhere.
                DispatchQueue.main.async { pending.receive(response) }
            }
        }
    }

    private static func classify(_ response: [String: Any]) -> Result {
        if let error = response["error"] {
            let code = (error as? [String: Any])?["code"] as? String
            return code == "B_DEVICE_UNCONFIGURED"
                ? Result(code: .skipped, reason: .notConfigured)
                : Result(code: .unconfirmed, reason: .ownerAPIError)
        }
        guard response["local_revoked"] as? Bool == true else {
            return Result(code: .unconfirmed, reason: .invalidResponse)
        }
        switch response["remote_revocation"] as? String {
        case "confirmed": return Result(code: .confirmed, reason: .remoteConfirmed)
        case "unconfirmed": return Result(code: .unconfirmed, reason: .remoteUnconfirmed)
        default: return Result(code: .unconfirmed, reason: .invalidResponse)
        }
    }

    @MainActor private final class Pending {
        var deadline: DispatchSourceTimer?
        private let expiresAt = ProcessInfo.processInfo.systemUptime + timeoutSeconds
        private var continuation: CheckedContinuation<Result, Never>?
        private let event: (String, String) -> Void
        init(continuation: CheckedContinuation<Result, Never>, event: @escaping (String, String) -> Void) {
            self.continuation = continuation; self.event = event
        }
        func receive(_ response: [String: Any]) {
            // Check the monotonic cutoff as well as the timer: a busy main queue
            // must not turn a response received after ten seconds into success.
            finish(ProcessInfo.processInfo.systemUptime >= expiresAt
                   ? Result(code: .unconfirmed, reason: .timeout) : classify(response))
        }
        func finish(_ result: Result) {
            guard let continuation else { return }
            self.continuation = nil
            deadline?.cancel(); deadline = nil
            event("revoke", result.code.rawValue)
            continuation.resume(returning: result)
        }
    }
}
