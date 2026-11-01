@main struct Checks {
    static var checks = 0
    static func expect(_ condition: Bool, _ message: String) { precondition(condition, message); checks += 1 }
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("runtime")
        for name in ChromeInstallSource.files {
            let file = root.appendingPathComponent("browser-extension/" + name)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(("synthetic:" + name).utf8).write(to: file)
        }
        for fallback in ChromeInstallFallbackCode.allCases {
            let detail = ChromeInstallFailureDetail(.sheetsAXError, axError: -25205, fallbackCode: fallback)!
            let adapter = PreflightAdapter(); adapter.wanted = detail; adapter.mainCode = .sheet
            var diagnostics: [[String: Any]] = []
            let installer = ChromeHelperInstaller(runtime: root, expectedFolder: root.appendingPathComponent("helper"), origin: { "http://127.0.0.1:1234" }, api: { _,_,_ in preconditionFailure("rejected fallback must not start a lease") }, adapter: { adapter }, diagnostic: { diagnostics.append($0) })
            var reply: [String: Any] = [:]; installer.start(profileID: "Default") { reply = $0 }
            expect((reply["error"] as? [String: Any])?["code"] as? String == ChromeInstallCode.sheet.rawValue, "coarse stop retained")
            expect(reply["detail_code"] as? String == "SHEETS_AX_ERROR" && reply["ax_error"] as? Int32 == -25205, "original unsupported detail retained")
            expect(reply["fallback_code"] as? String == fallback.rawValue, "controller reply includes typed fallback rejection")
            expect(diagnostics.last?["fallback_code"] as? String == fallback.rawValue, "preflight stopped diagnostic includes same fallback rejection")
            expect(adapter.failureDetail == nil && adapter.closes == 1, "capture before close clears attempt-local state")
            let bridge = Bridge(); bridge.deliver(reply)
            expect(bridge.reports.first?["fallback_code"] as? String == fallback.rawValue, "acknowledged main bridge retains validated third field")
            expect(bridge.reports.first?["ax_error"] as? Int32 == -25205, "no invented secondary AXError")
            bridge.deliver(reply); expect(bridge.reports.count == 1, "duplicate reply cannot overwrite stop")
        }
        let base: [String: Any] = ["detail_code":"SHEETS_AX_ERROR", "ax_error":-25205, "error":["code":ChromeInstallCode.sheet.rawValue]]
        for invalid: Any in ["unknown", "AXDialog/private", NSNumber(value: 1), NSNull(), ["DEADLINE"]] {
            var fields = base; fields["fallback_code"] = invalid
            let decoded = ChromeInstallFailureDetail(metadata: fields)
            expect(decoded?.code == .sheetsAXError && decoded?.axError == -25205 && decoded?.fallbackCode == nil, "invalid optional fallback discarded without hiding primary detail")
            let bridge = Bridge(); bridge.deliver(fields)
            expect(bridge.reports.first?["code"] as? String == ChromeInstallCode.sheet.rawValue && bridge.reports.first?["detail_code"] as? String == "SHEETS_AX_ERROR", "invalid extra never swallows original stopped result")
            expect(bridge.reports.first?["fallback_code"] == nil, "invalid fallback extra omitted")
        }
        for ax in [-25204, -25212, 0] {
            var fields = base; fields["fallback_code"] = "DEADLINE"; fields["ax_error"] = ax
            expect(ChromeInstallFailureDetail(metadata: fields)?.fallbackCode == nil, "third field requires exact unsupported AXError")
        }
        var fields: [String: Any] = ["detail_code":"WINDOW_ID_UNAVAILABLE", "fallback_code":"DEADLINE", "error":["code":ChromeInstallCode.sheet.rawValue]]
        let wrongDetail = Bridge(); wrongDetail.deliver(fields)
        expect(wrongDetail.reports.first?["detail_code"] as? String == "WINDOW_ID_UNAVAILABLE" && wrongDetail.reports.first?["fallback_code"] == nil, "third field requires exact detail code")
        fields = base; fields["fallback_code"] = "DEADLINE"; fields["window_name"] = "private-window"; fields["url"] = "private-url"; fields["value"] = "private-value"
        let safe = Bridge(); safe.deliver(fields)
        let encoded = try JSONSerialization.data(withJSONObject: safe.reports)
        expect(!String(decoding: encoded, as: UTF8.self).contains("private-"), "arbitrary native metadata never merged")
        let later = Bridge(); later.stage = "opening_chrome"; later.deliver(fields)
        expect(later.reports.first?["fallback_code"] == nil, "third field restricted to preparing")
        fields["error"] = ["code":ChromeInstallCode.target.rawValue]
        let wrongMain = Bridge(); wrongMain.deliver(fields)
        expect(wrongMain.reports.first?["fallback_code"] == nil, "third field restricted to original sheet main code")
        expect(ChromeInstallFailureDetail(.sheetsAXError, axError: -25204, fallbackCode: .deadline) == nil, "typed constructor rejects inconsistent fallback tuple")
        let noFallback = ChromeInstallFailureDetail(.sheetsAXError, axError: -25205)!
        expect(noFallback.fallbackCode == nil, "legacy detail needs no optional fallback")
        print("PASS: \(checks) fallback receipt checks; fake adapter and extracted native main only")
    }
}
