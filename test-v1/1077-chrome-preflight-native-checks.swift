// Appended to the existing synthetic AX boundary after injecting production methods.
@main struct Checks {
    static var count = 0
    static var covered = Set<ChromeInstallDetailCode>()
    static func expect(_ value: Bool, _ message: String) { precondition(value, message); count += 1 }
    static func fresh(_ result: AXError = .success, _ value: AnyObject? = NSArray()) -> Reader {
        fixtureApp.windowsResult = .success; fixtureApp.overrideWindows = false; fixtureApp.windowsValue = nil
        B2TargetClick.WindowReader.shared = B2TargetClick.WindowReader()
        let window = FixtureAX(); window.sheetResult = result; window.sheetValue = value
        fixtureApp.children = [window]
        let reader = Reader(); reader.window = window; return reader
    }
    static func failure(_ f: Reader, _ detail: ChromeInstallDetailCode, _ ax: Int32?, sheets: Bool = false) {
        do { _ = try sheets ? f.sheetCount() : f.inventory(); preconditionFailure("accepted rejected fixture") }
        catch let code as ChromeInstallCode { expect(code == detail.mainCode, "original main error code preserved") }
        catch { preconditionFailure("unexpected error mapping") }
        expect(f.failureDetail?.code == detail, "precise finite detail")
        expect(f.failureDetail?.axError == ax, "only original AXError or no AXError")
        covered.insert(detail)
    }
    static func main() throws {
        var f = fresh(); fixtureApp.windowsResult = .noValue
        failure(f, .windowsAXError, -25212)
        f = fresh(); fixtureApp.overrideWindows = true
        failure(f, .windowsValueMissing, 0)
        f = fresh(); fixtureApp.overrideWindows = true; fixtureApp.windowsValue = "foreign" as NSString
        failure(f, .windowsValueInvalid, 0)
        f = fresh(); fixtureApp.children = (0...100).map { _ in FixtureAX() }
        failure(f, .windowsTooMany, 0)
        f = fresh(); fixtureApp.children.append(FixtureAX())
        failure(f, .windowIDDuplicate, nil)
        f = fresh(); f.window?.roleResult = .cannotComplete
        failure(f, .windowRoleAXError, -25204)
        f = fresh(); f.window?.overrideRole = true; f.window?.roleValue = NSNumber(value: 42)
        failure(f, .windowRoleValueInvalid, 0)
        f = fresh(); f.window?.kind = "AXGroup"
        failure(f, .windowRoleMismatch, 0)
        f = fresh(); B2TargetClick.WindowReader.shared = nil
        failure(f, .windowIDReaderMissing, nil)
        f = fresh(); f.window?.number = nil
        failure(f, .windowIDUnavailable, nil)
        f = fresh(); f.observationDeadline = 0
        failure(f, .sheetsDeadline, nil, sheets: true)
        f = fresh(); f.observationDeadline = ProcessInfo.processInfo.systemUptime + 10; f.window?.messagingResult = .cannotComplete
        failure(f, .sheetsTimeoutAXError, -25204, sheets: true)
        f = fresh(.attributeUnsupported, nil)
        failure(f, .sheetsAXError, -25205)
        f = fresh(.noValue, NSArray())
        failure(f, .sheetsNoValueWithValue, -25212)
        f = fresh(.success, nil)
        failure(f, .sheetsValueMissing, 0)
        f = fresh(.success, "foreign" as NSString)
        failure(f, .sheetsValueNotArray, 0)
        f = fresh(.success, FixtureArrayCastFailure())
        failure(f, .sheetsArrayCastFailed, 0)
        f = fresh(.success, NSArray(object: "foreign"))
        failure(f, .sheetsElementInvalid, 0)
        f = fresh(.success, NSArray(object: FixtureAX("AXSheet")))
        failure(f, .sheetsPresent, 0)
        expect(covered == Set(ChromeInstallDetailCode.allCases), "every declared detail covered")
        f = fresh(.noValue, nil); f.window?.kind = "  AXWindow\n"
        let before = reads
        expect(try f.inventory() == 1, "role trimming and explicit noValue still pass")
        expect(reads == before + 3, "exactly one Windows/Role/Sheets read")
        expect(f.failureDetail == nil, "success carries no detail")
        f = fresh(); f.observationDeadline = 0
        let beforeDeadline = reads
        do { _ = try f.inventory(); preconditionFailure("expired inventory accepted") }
        catch ChromeInstallCode.target { count += 1 }
        expect(reads == beforeDeadline, "inventory deadline performs no read")
        for error in [AXError.cannotComplete, .apiDisabled, .failure, .unknown] {
            f = fresh(error, nil); failure(f, .sheetsAXError, error.rawValue)
        }
        print("PASS: \(count) production preflight diagnostic branch checks; synthetic AX only")
    }
}
