import Foundation
#if !CHATHAND_INSTALL_PURE_TEST
import ApplicationServices
#endif

/// Keeps only the caller's original click intent. This grants no installer lease,
/// performs no input, and never requests Screen Recording. Call on the main queue.
final class ChromeAccessibilityWait {
    typealias Schedule = (TimeInterval, @escaping () -> Void) -> Void
    private let now: () -> TimeInterval
    private let schedule: Schedule
    private let trusted: () -> Bool
    private var generation: UUID?
    private var deadline: TimeInterval = 0
    private var granted: (() -> Void)?
    private var completion: ((Result<Void, ChromeInstallCode>) -> Void)?
    var active: Bool { generation != nil }

    init(now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         schedule: @escaping Schedule = { delay, work in DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work) },
         trusted: @escaping () -> Bool = { ChromeAccessibilityWait.processTrusted() }) {
        self.now = now; self.schedule = schedule; self.trusted = trusted
    }
    static func processTrusted() -> Bool {
        #if CHATHAND_INSTALL_PURE_TEST
        return false
        #else
        return AXIsProcessTrusted()
        #endif
    }
    func start(onWaiting: @escaping () -> Void, onGranted: @escaping () -> Void,
               completion: @escaping (Result<Void, ChromeInstallCode>) -> Void) {
        // A second click must not replace the first caller's authority/callback.
        guard !active else { completion(.failure(.busy)); return }
        let run = UUID()
        generation = run; deadline = now() + 180
        granted = onGranted; self.completion = completion
        if trusted() { finish(.success(()), run: run); return }
        onWaiting()
        guard generation == run else { return } // guidance may cancel synchronously
        scheduleNext(run)
    }
    private func scheduleNext(_ run: UUID) {
        let remaining = deadline - now()
        guard remaining > 0 else { finish(.failure(.accessibilityTimeout), run: run); return }
        schedule(min(1, remaining)) { [weak self] in self?.poll(run) }
    }
    private func poll(_ run: UUID) {
        guard generation == run else { return }
        // Delayed timers cannot grant authority after the original 180 seconds.
        guard now() < deadline else { finish(.failure(.accessibilityTimeout), run: run); return }
        if trusted() { finish(.success(()), run: run) }
        else { scheduleNext(run) }
    }
    private func finish(_ result: Result<Void, ChromeInstallCode>, run: UUID) {
        guard generation == run else { return }
        let done = completion, onGranted = granted
        generation = nil; completion = nil; granted = nil
        if case .success = result { onGranted?() }
        done?(result)
    }
    func cancel() {
        if let run = generation { finish(.failure(.cancelled), run: run) }
    }
}
