import Cocoa
import ApplicationServices

// Only production pure readback rules. No AX, desktop, input or permission calls.
@main struct SecureInputReadbackChecks {
    static var checks = 0
    static func expect(_ value: Bool, _ name: String) {
        checks += 1
        if !value { fputs("FAIL: \(name)\n", stderr); exit(1) }
    }
    static func readback(sensitive: Bool, value: String?, reads: inout Int) -> ComputerControl.ControlFailure? {
        do {
            try ComputerControl.verifyTextReadback(sensitive: sensitive, read: { reads += 1; return value }, expected: "fixture text 😄")
            return nil
        } catch let error as ComputerControl.ControlFailure { return error }
        catch { fputs("FAIL: unexpected error\n", stderr); exit(1) }
    }
    static func expectUnconfirmed(_ error: ComputerControl.ControlFailure?) {
        expect(error?.code == "COMPUTER_ACTION_UNCONFIRMED", "existing unconfirmed code")
        expect(error?.uncertain == true, "attempt remains uncertain")
        let details = error?.payload["details"] as? [String: Any]
        expect(details?["do_not_replay"] as? Bool == true, "attempt cannot replay")
        expect(details?["delivery_unconfirmed"] as? Bool == true, "unconfirmed delivery detail")
        expect(error?.payload["verified"] == nil, "never claims verified")
    }
    @MainActor static func main() {
        var writes = 0, reads = 0
        let unavailable = ComputerControl.axTextResult(settable: false, sensitive: true,
            set: { writes += 1; return .success }, read: { reads += 1; return "fixture text 😄" }, expected: "fixture text 😄")
        expect(unavailable == .unavailable, "unavailable AX setter selects fallback")
        expect(writes == 0 && reads == 0, "unavailable setter neither writes nor reads")
        // Execute the same verifier used after production Unicode dispatch;
        // dispatch itself is intentionally never invoked by this fixture.
        expectUnconfirmed(readback(sensitive: true, value: "fixture text 😄", reads: &reads))
        expect(reads == 0, "sensitive fallback never invokes read closure")
        expectUnconfirmed(readback(sensitive: true, value: nil, reads: &reads))
        expect(reads == 0, "unreadable sensitive fallback also never reads")

        for (value, matches) in [("fixture text 😄", true), ("different", false), (nil, false)] as [(String?, Bool)] {
            reads = 0
            let result = readback(sensitive: false, value: value, reads: &reads)
            expect(reads == 1, "ordinary fallback reads exactly once")
            expect((result == nil) == matches, "ordinary fallback comparison preserved")
            if !matches { expectUnconfirmed(result) }
        }
        writes = 0; reads = 0
        expect(ComputerControl.axTextResult(settable: true, sensitive: true,
            set: { writes += 1; return .success }, read: { reads += 1; return "fixture text 😄" }, expected: "fixture text 😄") == .unconfirmed,
            "settable secure AX input remains unconfirmed")
        expect(writes == 1 && reads == 0, "secure AX input writes once without readback")
        for (status, value, wanted, expectedReads) in [
            (AXError.success, "fixture text 😄", ComputerControl.AXTextResult.verified, 1),
            (AXError.success, "different", ComputerControl.AXTextResult.unconfirmed, 1),
            (AXError.cannotComplete, "fixture text 😄", ComputerControl.AXTextResult.unconfirmed, 0)
        ] {
            writes = 0; reads = 0
            expect(ComputerControl.axTextResult(settable: true,
                set: { writes += 1; return status }, read: { reads += 1; return value }, expected: "fixture text 😄") == wanted,
                "ordinary AX setting result preserved")
            expect(writes == 1 && reads == expectedReads, "ordinary AX read/write counts preserved")
        }
        print("PASS \(checks) isolated secure readback checks; zero AX or input events")
    }
}
