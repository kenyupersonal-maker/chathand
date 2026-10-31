import AppKit
import Foundation

@main struct SetupReturnChecks {
    static func main() {
        func check(_ condition: Bool, _ label: String) {
            if !condition { fputs("FAIL: \(label)\n", stderr); exit(1) }
        }
        var calls = 0
        var result: [String: Any] = [:]
        let app = URL(fileURLWithPath: "/synthetic/ChatGPT.app")
        SetupConversation.showDesktop(installed: { app }, open: { url, finish in
            calls += 1
            check(url == app, "opens the selected desktop app")
            finish(true)
        }, completion: { result = $0 })
        check(calls == 1 && result["opened"] as? Bool == true, "opens once")

        SetupConversation.showDesktop(installed: { nil }, open: { _, _ in calls += 1 }, completion: { result = $0 })
        check(calls == 1 && result["error_code"] as? String == "CHATGPT_DESKTOP_UNAVAILABLE", "missing app")

        SetupConversation.showDesktop(installed: { app }, open: { _, finish in finish(false) }, completion: { result = $0 })
        check(result["opened"] as? Bool == false && result["error_code"] as? String == "CHATGPT_OPEN_FAILED", "open failed")
        print("PASS: desktop return without opening a URL")
    }
}
