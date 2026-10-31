import Foundation

final class PreflightAdapter: ChromeInstallAdapter {
    var needsLaunch = false
    var failureDetail: ChromeInstallFailureDetail?
    var wanted: ChromeInstallFailureDetail?, mainCode: ChromeInstallCode = .sheet
    var closes = 0
    func preflight() throws { failureDetail = nil; failureDetail = wanted; throw mainCode }
    func close() { failureDetail = nil; closes += 1 }
    func bind(_ lease: ChromeInstallLease) throws { preconditionFailure("unexpected bind") }
    func check(_ stage: ChromeInstallStage, input: Bool) throws { preconditionFailure("unexpected check") }
    func perform(_ action: ChromeInstallAction) throws { preconditionFailure("unexpected input") }
    func observe(_ stage: ChromeInstallStage) throws -> ChromeInstallObservation? { preconditionFailure("unexpected observe") }
    func finalEvidence() throws -> String { preconditionFailure("unexpected final evidence") }
}
final class Bridge {
    var attemptAccepted = true, stoppedReported = false, bridgeAcknowledged = true
    var stage = "preparing", stageStartedAt = ProcessInfo.processInfo.systemUptime
    let defaultTarget: Any = NSNull(), preparation = UUID()
    var reports: [[String: Any]] = [], replies: [[String: Any]] = []
    func reportProgress(_ metadata: [String: Any], completion: (([String: Any]) -> Void)? = nil) { reports.append(metadata); completion?(["recorded":true]) }
    func done(_ result: [String: Any]) { replies.append(result) }
/* PRODUCTION_PROGRESS */
/* PRODUCTION_DELIVER_ERROR */
}
@main struct Checks {
    static var count = 0
    static func expect(_ value: Bool, _ message: String) { precondition(value, message); count += 1 }
    static func validAX(_ code: ChromeInstallDetailCode) -> Int32? {
        switch code {
        case .windowsAXError, .windowRoleAXError, .sheetsTimeoutAXError, .sheetsAXError: return -25204
        case .sheetsNoValueWithValue: return -25212
        case .windowIDDuplicate, .windowIDReaderMissing, .windowIDUnavailable, .sheetsDeadline: return nil
        default: return 0
        }
    }
    static func fields(_ detail: ChromeInstallFailureDetail) -> [String: Any] {
        var result: [String: Any] = ["detail_code": detail.code.rawValue]
        if let axError = detail.axError { result["ax_error"] = axError }
        return result
    }
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("runtime")
        for name in ChromeInstallSource.files {
            let file = root.appendingPathComponent("browser-extension/" + name)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(("synthetic:" + name).utf8).write(to: file)
        }
        for code in ChromeInstallDetailCode.allCases {
            let detail = ChromeInstallFailureDetail(code, axError: validAX(code))!
            expect(ChromeInstallFailureDetail(metadata: fields(detail))?.code == code, "all finite details decode")
            let adapter = PreflightAdapter(); adapter.wanted = detail; adapter.mainCode = code.mainCode
            var diagnostics: [[String: Any]] = []
            let installer = ChromeHelperInstaller(runtime: root, expectedFolder: root.appendingPathComponent("helper"), origin: { "http://127.0.0.1:1234" }, api: { _,_,_ in preconditionFailure("preflight stop must not open a lease") }, adapter: { adapter }, diagnostic: { diagnostics.append($0) })
            var reply: [String: Any] = [:]; installer.start(profileID: "Default") { reply = $0 }
            expect((reply["error"] as? [String: Any])?["code"] as? String == code.mainCode.rawValue, "original thrown code preserved")
            expect(reply["detail_code"] as? String == code.rawValue, "controller reply carries finite detail")
            expect(diagnostics.last?["detail_code"] as? String == code.rawValue, "preflight stopped metadata carries detail")
            expect(adapter.closes == 1 && adapter.failureDetail == nil, "controller captured detail before close clears it")
            expect(!installer.active, "failure remains stopped")
            let bridge = Bridge(); bridge.deliver(reply)
            expect(bridge.reports.count == 1, "already acknowledged bridge records one stop")
            expect(bridge.reports[0]["detail_code"] as? String == code.rawValue, "main deliver and progress retain validated detail")
            expect((bridge.reports[0]["ax_error"] as? Int32) == detail.axError, "main retains exact optional AXError")
            bridge.deliver(reply); expect(bridge.reports.count == 1, "duplicate completion cannot replace stop")
        }
        for invalid: [String: Any] in [
            ["detail_code":"foreign", "ax_error":0],
            ["detail_code":"SHEETS_AX_ERROR", "ax_error":0],
            ["detail_code":"SHEETS_AX_ERROR", "ax_error":-25212],
            ["detail_code":"SHEETS_AX_ERROR", "ax_error":true],
            ["detail_code":"SHEETS_AX_ERROR", "ax_error":"-25204"],
            ["detail_code":"SHEETS_AX_ERROR", "ax_error":-2.5],
            ["detail_code":"SHEETS_AX_ERROR", "ax_error":NSNull()],
            ["detail_code":"SHEETS_AX_ERROR", "ax_error":Int64(Int32.max)+1],
            ["detail_code":"SHEETS_AX_ERROR", "ax_error":Int64(Int32.min)-1],
            ["detail_code":"SHEETS_AX_ERROR"],
            ["detail_code":"WINDOW_ID_UNAVAILABLE", "ax_error":0],
            ["detail_code":"SHEETS_NOVALUE_WITH_VALUE", "ax_error":-25204]
        ] {
            expect(ChromeInstallFailureDetail(metadata: invalid) == nil, "invalid detail combinations rejected")
            var reply = invalid; reply["error"] = ["code":ChromeInstallCode.sheet.rawValue]
            let bridge = Bridge(); bridge.deliver(reply)
            expect(bridge.reports.first?["code"] as? String == ChromeInstallCode.sheet.rawValue, "bad diagnostics never hide main stop")
            expect(bridge.reports.first?["detail_code"] == nil && bridge.reports.first?["ax_error"] == nil, "bad optional fields dropped")
        }
        for ax in [Int32.min, Int32.max] {
            expect(ChromeInstallFailureDetail(metadata: ["detail_code":"SHEETS_AX_ERROR", "ax_error":ax])?.axError == ax, "full Int32 range preserved")
        }
        let safe = ChromeInstallFailureDetail(.sheetsAXError, axError: -25204)!
        var untrusted = fields(safe); untrusted["error"] = ["code":ChromeInstallCode.sheet.rawValue]
        untrusted["window_name"] = "private-window"; untrusted["url"] = "private-url"; untrusted["raw_value"] = "private-value"
        let bridge = Bridge(); bridge.deliver(untrusted)
        let bytes = try JSONSerialization.data(withJSONObject: bridge.reports)
        let text = String(decoding: bytes, as: UTF8.self)
        expect(!text.contains("private-"), "only the two typed fields are copied, never arbitrary result metadata")
        let later = Bridge(); later.stage = "opening_chrome"; later.deliver(untrusted)
        expect(later.reports.first?["detail_code"] == nil, "other stages cannot carry preflight details")
        let wrong = Bridge(); untrusted["error"] = ["code":ChromeInstallCode.target.rawValue]; wrong.deliver(untrusted)
        expect(wrong.reports.first?["detail_code"] == nil, "detail cannot contradict main error code")
        print("PASS: \(count) production preflight receipt checks; fake adapter and extracted main only")
    }
}
