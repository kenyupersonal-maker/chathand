// Uses only injected AX objects, trust and a virtual monotonic clock.
final class FallbackClock {
    static let processInfo = FallbackClock()
    var systemUptime: TimeInterval = 100
}
@main struct Checks {
    static var checks = 0
    static var covered = Set<String>()
    static func expect(_ condition: Bool, _ message: String) { precondition(condition, message); checks += 1 }
    static func fallbackCode(_ f: Reader) -> String? { /* FALLBACK_OBSERVER */ }
    static func fresh(_ roles: [String] = ["AXGroup"]) -> Reader {
        fixtureTrusted = true; fixtureReadHook = nil; fixtureTimeoutHook = nil; fixtureTypeCheckHook = nil
        FallbackClock.processInfo.systemUptime = 100
        let window = FixtureAX(); window.sheetResult = .attributeUnsupported; window.sheetValue = nil
        window.childrenResult = .success
        window.children = roles.map { role in
            let child = FixtureAX(role); child.parentResult = .success; child.parentValue = window; return child
        }
        fixtureApp.windowsResult = .success; fixtureApp.overrideWindows = false; fixtureApp.children = [window]
        B2TargetClick.WindowReader.shared = B2TargetClick.WindowReader()
        let reader = Reader(); reader.window = window; return reader
    }
    static func reject(_ f: Reader, _ fallback: String) {
        do { _ = try f.sheetRefs(); preconditionFailure("unsafe fallback accepted") }
        catch ChromeInstallCode.sheet { checks += 1 }
        catch { preconditionFailure("coarse error mapping changed") }
        expect(f.failureDetail?.code == .sheetsAXError && f.failureDetail?.axError == -25205, "original unsupported failure remains")
        expect(fallbackCode(f) == fallback, "finite fallback rejection identifies the failed gate")
        covered.insert(fallback)
    }
    static func main() throws {
        // This first positive case also runs against the parent: it must compile,
        // then fail because the parent's actual method stops at unsupported.
        var f = fresh(); let before = reads
        expect(try f.sheetRefs().isEmpty, "unsupported plus two complete reciprocal snapshots proves no direct AXSheet")
        expect(reads == before + 9, "one AXSheets read and exactly two four-read snapshots")
        expect(f.failureDetail == nil, "successful fallback does not manufacture failure or installation success")
        f = fresh(["AXGroup", "AXToolbar", "AXTabGroup", "AXScrollArea", "AXSplitGroup", "AXWebArea", "AXButton"])
        expect(try f.sheetRefs().isEmpty, "all seven explicitly allowed non-sheet structural roles")
        f = fresh(["  AXGroup\n"]); f.window?.kind = " AXWindow\n"
        expect(try f.sheetRefs().isEmpty, "existing role normalization retained")
        f = fresh(["AXSheet"]); let actualSheet = f.window!.children[0]
        expect(try f.sheetRefs().first === actualSheet, "real sheet reference is returned without erasure")
        do { _ = try f.inventory(); preconditionFailure("attached sheet passed preflight") }
        catch ChromeInstallCode.sheet { checks += 1 }
        expect(f.failureDetail?.code == .sheetsPresent, "the existing caller still rejects a real sheet")
        f = fresh(["AXSheet", "AXSheet"])
        expect(try f.sheetRefs().count == 2, "ambiguous real sheets are not collapsed into a chooser")

        f = fresh(); f.window?.sheetValue = NSArray(); let beforeEntry = reads
        reject(f, "ENTRY_VALUE_PRESENT"); expect(reads == beforeEntry + 1, "contradictory unsupported value causes no fallback read")
        f = fresh(); fixtureReadHook = { _, name in if name == "AXSheets" { FallbackClock.processInfo.systemUptime = 103 } }
        // The fallback's own 2s budget starts after the original unsupported read.
        expect(try f.sheetRefs().isEmpty, "fallback owns a fresh bounded budget, not a guessed original read duration")
        f = fresh(); f.observationDeadline = 100.1
        fixtureReadHook = { _, name in if name == "AXRole" { FallbackClock.processInfo.systemUptime = 100.2 } }
        reject(f, "DEADLINE")
        f = fresh(); fixtureReadHook = { _, name in if name == "AXChildren" { FallbackClock.processInfo.systemUptime = 102.01 } }
        reject(f, "DEADLINE")
        f = fresh(); fixtureReadHook = { _, name in if name == "AXRole" { fixtureTrusted = false } }
        reject(f, "PERMISSION_CHANGED")
        f = fresh(); fixtureReadHook = { node, name in if name == "AXSheets" { node.messagingResult = .cannotComplete } }
        reject(f, "TIMEOUT_SETUP_FAILED")
        f = fresh(); f.window?.roleResult = .cannotComplete
        reject(f, "WINDOW_ROLE_READ_FAILED")
        f = fresh(); f.window?.kind = "AXDialog"
        reject(f, "WINDOW_ROLE_INVALID")
        f = fresh(); f.window?.childrenResult = .attributeUnsupported
        reject(f, "CHILDREN_READ_FAILED")
        f = fresh(); f.window?.overrideChildren = true; f.window?.childrenValue = "foreign" as NSString
        reject(f, "CHILDREN_INVALID")
        f = fresh(); f.window?.overrideChildren = true; f.window?.childrenValue = NSArray(object: "foreign")
        reject(f, "CHILDREN_INVALID")
        f = fresh([])
        reject(f, "CHILDREN_EMPTY")
        f = fresh(Array(repeating: "AXGroup", count: 101))
        reject(f, "CHILDREN_LIMIT")
        f = fresh(); f.window?.overrideChildren = true
        f.window?.childrenValue = NSArray(array: (0..<100).map { _ in FixtureAX("AXGroup") as AnyObject } + ["foreign" as NSString])
        var elementTypeChecks = 0, childPropertyReads = 0
        fixtureTypeCheckHook = { value in if value is FixtureAX || value is NSString { elementTypeChecks += 1 } }
        fixtureReadHook = { node, _ in if node !== f.window { childPropertyReads += 1 } }
        reject(f, "CHILDREN_LIMIT")
        expect(elementTypeChecks == 0 && childPropertyReads == 0, "over-limit malformed array is rejected before any element inspection or child read")
        f = fresh(); f.window?.children = [f.window!]
        reject(f, "CHILD_IDENTITY_INVALID")
        f = fresh(); f.window?.children.append(f.window!.children[0])
        reject(f, "CHILD_IDENTITY_INVALID")
        f = fresh(); f.window?.children[0].roleResult = .cannotComplete
        reject(f, "CHILD_ROLE_READ_FAILED")
        f = fresh(); f.window?.children[0].overrideRole = true
        reject(f, "CHILD_ROLE_INVALID")
        f = fresh(["  "])
        reject(f, "CHILD_ROLE_INVALID")
        for role in ["AXDialog", "AXSystemDialog", "AXUnknown", "AXWindow", "AXFutureRole"] {
            f = fresh([role]); reject(f, "CHILD_ROLE_DISALLOWED")
        }
        f = fresh(); f.window?.children[0].parentResult = .cannotComplete
        reject(f, "CHILD_PARENT_READ_FAILED")
        f = fresh(); f.window?.children[0].parentValue = nil
        reject(f, "CHILD_PARENT_INVALID")
        f = fresh(); f.window?.children[0].parentValue = "foreign" as NSString
        reject(f, "CHILD_PARENT_INVALID")
        f = fresh(); f.window?.children[0].parentValue = FixtureAX()
        reject(f, "CHILD_PARENT_INVALID")
        f = fresh(["AXGroup", "AXToolbar"]); var snapshots = 0
        fixtureReadHook = { node, name in if node === f.window && name == "AXChildren" { snapshots += 1; if snapshots == 2 { node.children.reverse() } } }
        reject(f, "SNAPSHOT_CHANGED")
        f = fresh(); snapshots = 0
        fixtureReadHook = { node, name in if node === f.window && name == "AXChildren" { snapshots += 1; if snapshots == 2 { node.children[0].kind = "AXToolbar" } } }
        reject(f, "SNAPSHOT_CHANGED")

        for status in [AXError.cannotComplete, .apiDisabled, .invalidUIElement, .failure, .unknown] {
            f = fresh(); f.window?.sheetResult = status; let initial = reads
            do { _ = try f.sheetRefs(); preconditionFailure("non-unsupported read entered fallback") }
            catch ChromeInstallCode.sheet { checks += 1 }
            expect(reads == initial + 1 && fallbackCode(f) == nil, "other errors do not acquire fallback evidence")
        }
        for (status, value) in [(AXError.success, nil as AnyObject?), (.success, "foreign" as NSString), (.success, NSArray(object: "foreign")), (.noValue, NSArray())] {
            f = fresh(); f.window?.sheetResult = status; f.window?.sheetValue = value; let initial = reads
            do { _ = try f.sheetRefs(); preconditionFailure("malformed original result used otherwise complete fallback proof") }
            catch ChromeInstallCode.sheet { checks += 1 }
            expect(reads == initial + 1 && fallbackCode(f) == nil, "successful malformed and contradictory noValue results never use fallback")
        }
        f = fresh(); f.window?.sheetResult = .success; f.window?.sheetValue = NSArray()
        let supported = reads; expect(try f.sheetRefs().isEmpty, "supported empty array unchanged"); expect(reads == supported + 1, "supported path has no fallback queries")
        f = fresh(); f.window?.sheetResult = .noValue
        let noValue = reads; expect(try f.sheetRefs().isEmpty, "explicit noValue unchanged"); expect(reads == noValue + 1, "noValue path has no fallback queries")
        f = fresh(); var timeoutProof = true, fallbackStarted = false
        fixtureReadHook = { _, name in if name == "AXSheets" { fallbackStarted = true } else { FallbackClock.processInfo.systemUptime += 0.01 } }
        fixtureTimeoutHook = { _, timeout in if fallbackStarted { timeoutProof = timeoutProof && Double(timeout) <= min(0.2, 102 - FallbackClock.processInfo.systemUptime) } }
        expect(try f.sheetRefs().isEmpty && timeoutProof, "every added read's timeout fits both 0.2s and remaining 2s")
        f = fresh(); f.observationDeadline = 100.05; timeoutProof = true; fallbackStarted = false
        fixtureReadHook = { _, name in if name == "AXSheets" { fallbackStarted = true } }
        fixtureTimeoutHook = { _, timeout in if fallbackStarted { timeoutProof = timeoutProof && Double(timeout) <= 100.05 - FallbackClock.processInfo.systemUptime } }
        expect(try f.sheetRefs().isEmpty && timeoutProof, "existing earlier observation deadline bounds all added reads")
        expect(covered.count == 17, "all seventeen fallback rejection categories exercised")
        fixtureReadHook = nil; fixtureTimeoutHook = nil; fixtureTrusted = true
        print("PASS: \(checks) unsupported-sheet fallback checks; synthetic AX/trust/clock only")
    }
}
