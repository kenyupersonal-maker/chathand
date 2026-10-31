import Cocoa
import ApplicationServices
import Darwin

// Target-only OCU 0.3.6 click adaptation. Copyright (c) 2026 Leo, MIT.
// See licenses/OCU-v0.3.6-LICENSE.txt. No helper, activation, global HID,
// foreground defocus/restore, keyboard transport, or permission request.
enum B2TargetClick {
    struct ProcessStart: Equatable {
        let seconds: UInt64
        let microseconds: UInt64
    }
    struct Identity: Equatable {
        let pid: pid_t
        let start: ProcessStart
        let bundle: String
        let windowID: CGWindowID
        let frame: CGRect
    }
    struct Eligibility {
        let hidden: Bool
        let windowCount: Int
        let minimized: Bool?
        let onscreen: Bool?
        let layer: Int?
        let focusedWindowID: CGWindowID?
        let responderWindowID: CGWindowID?
        let responderRoleKnown: Bool
        func allows(_ id: CGWindowID) -> Bool {
            !hidden && windowCount == 1 && minimized == false && onscreen == true && layer == 0 &&
            focusedWindowID == id && responderWindowID == id && responderRoleKnown
        }
    }
    struct FrontGuard: Equatable {
        let pid: pid_t
        let start: ProcessStart
        let windowToken: UInt64
        let pointer: CGPoint
        @MainActor static func read() -> FrontGuard? {
            guard let app = NSWorkspace.shared.frontmostApplication,
                  let start = processStart(app.processIdentifier),
                  let window = ComputerControl.focusedWindow(app),
                  let pointer = CGEvent(source: nil)?.location else { return nil }
            return FrontGuard(pid: app.processIdentifier, start: start,
                              windowToken: ComputerControl.axIdentity(window), pointer: pointer)
        }
    }
    struct Receipt {
        var focusRecords = 0
        var targetChannels = 0
        var attempted: Bool { focusRecords > 0 || targetChannels > 0 }
    }
    struct Failure: Error {
        let cause: Error
        let receipt: Receipt
    }
    static func controlFailure(_ receipt: Receipt, cause: ComputerControl.ControlFailure? = nil) -> ComputerControl.ControlFailure {
        let fallback = cause ?? ComputerControl.ControlFailure("COMPUTER_ACTION_UNCONFIRMED", LocalText.text("native.backgroundClick.unknown"))
        return ComputerControl.ControlFailure(fallback.code,
            receipt.attempted ? LocalText.text("native.backgroundClick.postedUnknown") : fallback.message,
            uncertain: receipt.attempted || fallback.uncertain,
            details: ["method": "background_target_click", "background": true,
                      "attempted_target_channels": receipt.targetChannels, "target_focus_records": receipt.focusRecords])
    }
    static func controlFailure(_ failure: Failure) -> ComputerControl.ControlFailure {
        controlFailure(failure.receipt, cause: failure.cause as? ComputerControl.ControlFailure)
    }

    /// Only the successful return of runRecipe may call this. A dispatch return
    /// proves the fixed recipe ran without throwing, not that the target consumed
    /// a click. Failed/partial recipes still go through controlFailure above.
    static func postedReceipt(_ receipt: Receipt) throws -> [String: Any] {
        guard receipt.focusRecords == 2, receipt.targetChannels == 10 else {
            throw controlFailure(receipt)
        }
        return ["method": "background_target_click",
                "background": true,
                "delivery_status": "posted_unconfirmed",
                "delivery_unconfirmed": true,
                "do_not_replay": true,
                "verified": false,
                "completed": false,
                "automatic_retry": false,
                "attempted_target_channels": receipt.targetChannels,
                "target_focus_records": receipt.focusRecords,
                "next_action": "computer_screenshot",
                "message": LocalText.text("native.backgroundClick.observeBeforeRetry")]
    }
    struct Step {
        let type: CGEventType
        let local: CGPoint
        let click: Int64
        let phase: Int64
        let delay: Double
    }
    static func recipe(local: CGPoint) -> [Step] {
        [Step(type: .mouseMoved, local: local, click: 0, phase: 2, delay: 0.015),
         Step(type: .leftMouseDown, local: CGPoint(x: -1, y: -1), click: 1, phase: 1, delay: 0.001),
         Step(type: .leftMouseUp, local: CGPoint(x: -1, y: -1), click: 1, phase: 2, delay: 0.100),
         Step(type: .leftMouseDown, local: local, click: 1, phase: 3, delay: 0.001),
         Step(type: .leftMouseUp, local: local, click: 1, phase: 3, delay: 0)]
    }
    /// Pure injectable transport state machine. The public channel is part of
    /// the fixed recipe, never a retry/fallback for an unknown private result.
    /// Count BEFORE dispatch, including failed focus records: delivery is then
    /// uncertain and callers must never borrow foreground or replay.
    @MainActor static func runRecipe(local: CGPoint,
                                    check: () async throws -> Void,
                                    focus: (Bool) throws -> Void,
                                    post: (Int, Bool) throws -> Void,
                                    wait: (Double) async -> Void) async throws -> Receipt {
        var receipt = Receipt()
        do {
            try await check()
            receipt.focusRecords += 1
            try focus(true)
            await wait(0.040)
            for (index, step) in recipe(local: local).enumerated() {
                for privateChannel in [true, false] {
                    try await check()
                    receipt.targetChannels += 1
                    try post(index, privateChannel)
                }
                await wait(step.delay)
            }
            await wait(0.100)
            try await check()
            receipt.focusRecords += 1
            try focus(false)
            await wait(0.040)
            try await check()
            return receipt
        } catch {
            // No cleanup posts after a failed guard. Never release/focus a
            // replacement process/window, and never replay a partial pair.
            throw Failure(cause: error, receipt: receipt)
        }
    }
    static func processStart(_ pid: pid_t) -> ProcessStart? {
        guard pid > 0 else { return nil }
        var info = proc_bsdinfo()
        let size = MemoryLayout<proc_bsdinfo>.stride
        let bytes = withUnsafeMutablePointer(to: &info) {
            proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, UnsafeMutableRawPointer($0), Int32(size))
        }
        guard bytes == Int32(size), info.pbi_pid == UInt32(pid),
              info.pbi_uid == geteuid(), info.pbi_start_tvsec > 0,
              info.pbi_start_tvusec < 1_000_000 else { return nil }
        return ProcessStart(seconds: info.pbi_start_tvsec, microseconds: info.pbi_start_tvusec)
    }
    final class WindowReader {
        typealias Read = @convention(c) (UnsafeRawPointer, UnsafeMutablePointer<UInt32>) -> Int32
        let read: Read
        static let shared = WindowReader()
        private init?() {
            guard let handle = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_NOW),
                  let symbol = dlsym(handle, "_AXUIElementGetWindow") else { return nil }
            read = unsafeBitCast(symbol, to: Read.self)
        }
        func id(_ element: AXUIElement) -> CGWindowID? {
            var id: UInt32 = 0
            return read(UnsafeRawPointer(Unmanaged.passUnretained(element).toOpaque()), &id) == 0 && id != 0 ? id : nil
        }
    }
    static func windowInfo(pid: pid_t, id: CGWindowID) -> [String: Any]? {
        guard let list = CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]] else { return nil }
        let exact = list.filter {
            ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id &&
            ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid
        }
        return exact.count == 1 ? exact.first : nil
    }
    static func snapshotIdentity(_ target: ComputerControl.Target) -> Identity? {
        let pid = target.app.processIdentifier
        guard let running = NSRunningApplication(processIdentifier: pid), !running.isTerminated,
              let bundle = running.bundleIdentifier, bundle == target.bundle,
              let start = processStart(pid), let id = WindowReader.shared?.id(target.window),
              let frame = ComputerControl.elementFrame(target.window), frame == target.frame,
              let info = windowInfo(pid: pid, id: id),
              let bounds = info[kCGWindowBounds as String] as? [String: Any],
              let cgFrame = CGRect(dictionaryRepresentation: bounds as CFDictionary), cgFrame == frame else { return nil }
        return Identity(pid: pid, start: start, bundle: bundle, windowID: id, frame: frame)
    }
    /// Missing AX focus proof fails closed. There is deliberately no Electron
    /// singleton exception, even when only one AX/CG window can be observed.
    static func eligible(_ target: ComputerControl.Target, identity: Identity) -> Bool {
        guard !target.app.isTerminated, let reader = WindowReader.shared,
              let info = windowInfo(pid: identity.pid, id: identity.windowID),
              let focusedWindow = ComputerControl.focusedWindow(target.app),
              ComputerControl.sameWindow(target.window, focusedWindow),
              let focused = ComputerControl.elementAttr(AXUIElementCreateApplication(identity.pid), kAXFocusedUIElementAttribute as String),
              let responderWindow = ComputerControl.elementAttr(focused, kAXWindowAttribute as String) else { return false }
        return Eligibility(hidden: target.app.isHidden, windowCount: ComputerControl.windows(target.app).count,
                           minimized: ComputerControl.boolAttr(target.window, kAXMinimizedAttribute as String),
                           onscreen: (info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue,
                           layer: (info[kCGWindowLayer as String] as? NSNumber)?.intValue,
                           focusedWindowID: reader.id(focusedWindow), responderWindowID: reader.id(responderWindow),
                           responderRoleKnown: ComputerControl.stringAttr(focused, kAXRoleAttribute as String) != nil).allows(identity.windowID)
    }
    private final class Transport {
        typealias Post = @convention(c) (pid_t, UnsafeMutableRawPointer?) -> Void
        typealias Integer = @convention(c) (UnsafeMutableRawPointer?, UInt32, Int64) -> Void
        typealias Location = @convention(c) (UnsafeMutableRawPointer?, Double, Double) -> Void
        typealias GetPSN = @convention(c) (pid_t, UnsafeMutableRawPointer?) -> Int32
        typealias PostRecord = @convention(c) (UnsafeRawPointer?, UnsafeRawPointer?) -> Int32
        let privatePost: Post
        let integer: Integer
        let location: Location
        let recordPost: PostRecord
        let identity: Identity
        var psn = [UInt8](repeating: 0, count: 8)
        let events: [CGEvent]
        init?(identity: Identity, local: CGPoint) {
            guard let sky = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW),
                  let services = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_NOW),
                  let p = dlsym(sky, "SLEventPostToPid"), let i = dlsym(sky, "SLEventSetIntegerValueField"),
                  let l = dlsym(sky, "CGEventSetWindowLocation"), let r = dlsym(sky, "SLPSPostEventRecordTo"),
                  let g = dlsym(services, "GetProcessForPID") else { return nil }
            privatePost = unsafeBitCast(p, to: Post.self)
            integer = unsafeBitCast(i, to: Integer.self)
            location = unsafeBitCast(l, to: Location.self)
            recordPost = unsafeBitCast(r, to: PostRecord.self)
            self.identity = identity
            let getPSN = unsafeBitCast(g, to: GetPSN.self)
            var process = [UInt8](repeating: 0, count: 8)
            guard process.withUnsafeMutableBytes({ getPSN(identity.pid, $0.baseAddress) }) == 0 else { return nil }
            psn = process
            let group = Int64(DispatchTime.now().uptimeNanoseconds % 1_000_000_000)
            var created: [CGEvent] = []
            for step in B2TargetClick.recipe(local: local) {
                let screen = step.local.x < 0 ? CGPoint(x: -1, y: -1) :
                    CGPoint(x: identity.frame.minX + step.local.x, y: identity.frame.minY + step.local.y)
                guard let source = CGEventSource(stateID: .hidSystemState),
                      let event = CGEvent(mouseEventSource: source, mouseType: step.type, mouseCursorPosition: screen, mouseButton: .left) else { return nil }
                event.setIntegerValueField(.eventSourceUserData, value: ComputerControl.eventTag)
                event.setIntegerValueField(.eventSourceUnixProcessID, value: Int64(getpid()))
                let ptr = Unmanaged.passUnretained(event).toOpaque(), wid = Int64(identity.windowID)
                let setInteger = unsafeBitCast(i, to: Integer.self), setLocation = unsafeBitCast(l, to: Location.self)
                for (field, value): (UInt32, Int64) in [(0, step.phase), (1, step.click), (3, 0), (7, 3),
                                                       (40, Int64(identity.pid)), (51, wid), (58, group), (91, wid), (92, wid)] {
                    setInteger(ptr, field, value)
                }
                setLocation(ptr, step.local.x, step.local.y)
                created.append(event)
            }
            events = created
        }
        func focus(_ focused: Bool) throws {
            var record = [UInt8](repeating: 0, count: 0xF8)
            record[0x04] = 0xF8; record[0x08] = 0x0D
            for offset in 0..<4 { record[0x3C + offset] = UInt8(truncatingIfNeeded: identity.windowID >> (offset * 8)) }
            record[0x8A] = focused ? 0x01 : 0x02
            let status = psn.withUnsafeBytes { destination in
                record.withUnsafeBytes { recordPost(destination.baseAddress, $0.baseAddress) }
            }
            guard status == 0 else {
                throw ComputerControl.ControlFailure("COMPUTER_ACTION_UNCONFIRMED", LocalText.text("native.backgroundClick.focusUnconfirmed"), uncertain: true)
            }
        }
        func post(_ index: Int, privateChannel: Bool) {
            let event = events[index]
            if privateChannel { privatePost(identity.pid, Unmanaged.passUnretained(event).toOpaque()) }
            else { event.postToPid(identity.pid) }
        }
    }
    /// nil means ZERO events and permits the existing foreground path. Every
    /// failure after attempted dispatch is returned as uncertain, never nil.
    @MainActor static func attempt(_ target: ComputerControl.Target, snapshot: ComputerControl.AXSnapshot,
                                   point: CGPoint, check: () async throws -> Void) async throws -> Receipt? {
        guard let expected = snapshot.clickIdentity else { return nil }
        guard let live = snapshotIdentity(target), live == expected else {
            throw ComputerControl.ControlFailure("TARGET_CHANGED", LocalText.text("native.backgroundClick.targetChanged"))
        }
        guard eligible(target, identity: expected), CGPreflightPostEventAccess(),
              let front = FrontGuard.read() else { return nil }
        let local = CGPoint(x: point.x - expected.frame.minX, y: point.y - expected.frame.minY)
        guard let transport = Transport(identity: expected, local: local) else { return nil }
        return try await runRecipe(local: local, check: {
            try await check()
            guard snapshotIdentity(target) == expected, eligible(target, identity: expected) else {
                throw ComputerControl.ControlFailure("TARGET_CHANGED", LocalText.text("native.backgroundClick.targetUnknown"))
            }
            guard FrontGuard.read() == front else {
                throw ComputerControl.ControlFailure("FOCUS_CHANGED", LocalText.text("native.backgroundClick.frontChanged"))
            }
        }, focus: { try transport.focus($0) }, post: { transport.post($0, privateChannel: $1) }, wait: { await ComputerControl.pause($0) })
    }
}
