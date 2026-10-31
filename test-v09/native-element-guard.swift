import Cocoa
import ApplicationServices

// Native decision tests only. Does not request OS permission or generate input.
@main struct NativeElementGuardTests {
    static func main() {
        var checks = 0
        func expect(_ condition: @autoclosure () -> Bool, _ name: String) {
            precondition(condition(), name)
            checks += 1
            print("PASS \(name)")
        }
        expect(!ComputerControl.inputAllowedForBundle("com.apple.notificationcenterui", selfBundleID: nil), "notification center cannot receive AI input")
        expect(!ComputerControl.inputAllowedForBundle("com.kenyu.chathand", selfBundleID: nil), "ChatHand cannot receive AI input")
        expect(!ComputerControl.inputAllowedForBundle("com.example.Self", selfBundleID: "com.example.Self"), "custom self bundle cannot receive AI input")
        expect(ComputerControl.inputAllowedForBundle("com.example.Editor", selfBundleID: "com.kenyu.chathand"), "other applications keep their existing input route")
        let moved = CGRect(x: 500, y: 300, width: 120, height: 40)
        func problem(role: String? = "AXButton", name: String = "下载",
                     enabled: Bool? = true, frame: CGRect? = moved) -> String? {
            ComputerControl.elementProblem(expectedRole: "AXButton", expectedName: "下载",
                                           liveRole: role, liveName: name, enabled: enabled, frame: frame)
        }
        expect(problem() == nil, "same control with current geometry is valid")
        expect(problem(role: nil) == "COMPUTER_ELEMENT_STALE", "removed control rejected")
        expect(problem(role: "AXTextField") == "COMPUTER_ELEMENT_STALE", "reused role rejected")
        expect(problem(name: "删除") == "COMPUTER_ELEMENT_STALE", "changed action label rejected")
        expect(problem(enabled: false) == "COMPUTER_ELEMENT_DISABLED", "newly disabled control rejected")
        expect(problem(frame: nil) == "COMPUTER_ELEMENT_STALE", "missing geometry rejected")
        expect(problem(frame: CGRect(x: 0, y: 0, width: Double.infinity, height: 4)) != nil, "infinite geometry rejected")
        expect(problem(frame: CGRect(x: 700, y: 420, width: 120, height: 40)) == nil,
               "same-window control movement revalidates current geometry")
        let context = ComputerControl.windowContextProblem(expectedBundle: "com.example.Editor",
                                                            expectedPID: 101,
                                                            expectedWindowToken: 11,
                                                            actualBundle: "com.example.Editor",
                                                            actualPID: 101,
                                                            actualWindowToken: 11)
        expect(context == nil, "same process and window remain valid")
        expect(ComputerControl.windowContextProblem(expectedBundle: "com.example.Editor", expectedPID: 101,
                                                    expectedWindowToken: nil, actualBundle: "com.example.Editor",
                                                    actualPID: 101, actualWindowToken: nil) == nil,
               "windowless desktop context remains bound to process")
        expect(ComputerControl.windowContextProblem(expectedBundle: "com.example.Editor", expectedPID: 101,
                                                    expectedWindowToken: nil, actualBundle: "com.example.Editor",
                                                    actualPID: 101, actualWindowToken: 12) == "COMPUTER_WINDOW_STALE",
               "new window invalidates windowless context")
        expect(ComputerControl.windowContextProblem(expectedBundle: "com.example.Editor",
                                                    expectedPID: 101,
                                                    expectedWindowToken: 11,
                                                    actualBundle: "com.example.Editor",
                                                    actualPID: 101,
                                                    actualWindowToken: 12) == "COMPUTER_WINDOW_STALE",
               "same app window switch is rejected")
        expect(ComputerControl.windowContextProblem(expectedBundle: "com.example.Editor",
                                                    expectedPID: 101,
                                                    expectedWindowToken: 11,
                                                    actualBundle: "com.example.Editor",
                                                    actualPID: 202,
                                                    actualWindowToken: 11) == "COMPUTER_WINDOW_STALE",
               "process identity change is rejected")
        var attempts = 0
        let unavailable = ComputerControl.semanticPress(supported: false) { attempts += 1; return .success }
        expect(unavailable == .unavailable && attempts == 0, "unsupported semantic press emits no action")
        let passed = ComputerControl.semanticPress(supported: true) { attempts += 1; return .success }
        expect(passed == .performed && attempts == 1, "supported press executes once")
        let uncertain = ComputerControl.semanticPress(supported: true) { attempts += 1; return .cannotComplete }
        expect(uncertain == .unconfirmed && attempts == 2, "uncertain press does not retry")
        typealias Page = ComputerControl.SettingsNodeFacts
        let settings = "com.apple.systempreferences"
        let secure = Page(role: "AXTextField", subrole: "AXSecureTextField")
        let touch = Page(role: "AXRow", selected: true, children: [Page(role: "AXStaticText", name: "Touch ID 与密码")])
        let unselectedTouch = Page(role: "AXRow", children: [Page(role: "AXStaticText", name: "Touch ID 与密码")])
        let ordinary = Page(role: "AXRow", name: "外观", selected: true)
        let selectedPage = Page(role: "AXWindow", children: [Page(role: "AXOutline", children: [touch])])
        let ordinaryPage = Page(role: "AXWindow", children: [Page(role: "AXOutline", children: [unselectedTouch, ordinary]), Page(role: "AXHeading", name: "外观")])
        for bundle in ["com.apple.SecurityAgent", "com.apple.loginwindow", "com.apple.LocalAuthentication.UIAgent"] {
            expect(ComputerControl.securityProblem(bundle: bundle, title: ""), "explicit system computer-password identity")
        }
        expect(!ComputerControl.securityProblem(bundle: "com.apple.CoreServicesUIAgent", title: "Security", targetSecure: true), "downloaded-App confirmation is not a computer-password blanket block")
        for bundle in ["com.google.Chrome", "org.example.Editor"] {
            expect(!ComputerControl.securityProblem(bundle: bundle, title: "Password OTP", settings: selectedPage,
                targetSecure: true, focusedSecure: true, currentSheetSecure: true), "ordinary App secure input allowed")
        }
        expect(ComputerControl.securityProblem(bundle: settings, title: "系统设置", settings: selectedPage), "generic Settings title with selected Touch ID blocks")
        expect(!ComputerControl.securityProblem(bundle: settings, title: "系统设置", settings: ordinaryPage), "unselected sidebar Touch ID does not block ordinary page")
        expect(!ComputerControl.securityProblem(bundle: settings, title: "Privacy & Security", settings: ordinaryPage), "ordinary privacy security page allowed")
        expect(ComputerControl.securityProblem(bundle: settings, title: "System Settings", settings: Page(role: "AXHeading", name: "Passwords")), "actual content password heading blocks")
        expect(ComputerControl.securityProblem(bundle: settings, title: "System Settings", settings: Page(role: "AXOutline", children: [Page(role: "AXRow", identifier: "TouchID", selected: true)])), "selected navigation identifier blocks")
        expect(!ComputerControl.securityProblem(bundle: settings, title: "System Settings", settings: Page(role: "AXOutline", children: [Page(role: "AXHeading", name: "Passwords")])), "unselected sidebar heading is not content")
        expect(ComputerControl.securityProblem(bundle: settings, title: "Touch ID"), "explicit password window title blocks")
        expect(ComputerControl.securityProblem(bundle: settings, title: "系统设置", targetSecure: true), "system target secure field backstop")
        expect(ComputerControl.securityProblem(bundle: settings, title: "系统设置", focusedSecure: true), "system focused secure field backstop")
        expect(ComputerControl.securityProblem(bundle: settings, title: "系统设置", currentSheetSecure: ComputerControl.hasSecureField(Page(role: "AXSheet", children: [secure]))), "system current secure sheet without heading blocks")
        expect(!ComputerControl.securityProblem(bundle: settings, title: "系统设置", settings: Page(role: "AXTextField", name: "搜索密码")), "unselected search label is not password page")
        expect(!ComputerControl.securityProblem(bundle: settings, title: "System Settings", settings: Page(role: "AXOutline", selected: true, children: [unselectedTouch])), "selected sidebar container does not select every item")
        var writes = 0, reads = 0
        let secureWrite = ComputerControl.axTextResult(settable: true, sensitive: true, set: { writes += 1; return .success },
            read: { reads += 1; return "fixture-secret-1060" }, expected: "fixture-secret-1060")
        expect(secureWrite == .unconfirmed && writes == 1 && reads == 0, "secure AX write is attempted once without reading or replaying its value")
        expect(ComputerControl.foregroundSurfaceProblem(targetPID: 101, frontPID: 202, surfaceCurrent: true, focusMatches: true) == "front_app_changed", "switch to an authentication process cannot inherit foreground delivery")
        print("\(checks)/\(checks) native decision tests passed; real desktop acceptance remains separate")
    }
}
