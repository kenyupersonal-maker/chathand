import Foundation

final class StoreHarness {
    var authorized = true
    var bodies: [[String: Any]] = []
    var preparations: [([String: Any]) -> Void] = []
    var launches: [ChromeWebStoreLaunchRequest] = []
    var launchReplies: [(Bool) -> Void] = []
    var replies: [[String: Any]] = []
    var apiRoutes: [String] = []
    lazy var chromeWebStoreFlow = ChromeWebStoreFlow(authorized: { [unowned self] in self.authorized }, prepare: { [unowned self] body, reply in
        self.bodies.append(body); self.preparations.append(reply)
    }, launch: { [unowned self] request, reply in self.launches.append(request); self.launchReplies.append(reply) })
    func api(_ route: String, _ body: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        apiRoutes.append(route); completion(["cancelled": true])
    }
    func entry(action: String, data: [String: Any] = [:], done: @escaping ([String: Any]) -> Void) {
        // ACTUAL_STORE_DISPATCH
        done(["unhandled": true])
    }
    func call(_ action: String = "extensionSetup", _ data: [String: Any] = [:]) {
        entry(action: action, data: data) { [unowned self] in self.replies.append($0) }
    }
}

@main struct ChromeStoreChecks {
    static func main() throws {
        var checks = 0
        func check(_ value: @autoclosure () -> Bool, _ label: String) {
            checks += 1
            if !value() { fatalError(label) }
        }
        // Synthetic public ID used only by this fixture; never a deployment identifier.
        let id = String(repeating: "a", count: 32)
        func ready(_ profile: String? = "Default") -> [String: Any] {
            ["distribution": "chrome_web_store", "config_state": "ready", "store_ready": true, "store_published": false,
             "extension_id": id, "store_url": "https://chromewebstore.google.com/detail/" + id,
             "selected_profile": profile as Any? ?? NSNull(), "profiles": [["id": "Default", "name": "Local"], ["id": "Profile 1", "name": "Work"]]]
        }
        for action in ["openChromeStore", "extensionSetup", "extensionRepair", "extensionManual", "revealChromeHelper", "extensionSettings", "reconnectBrowserHelper"] {
            let h = StoreHarness(); h.call(action, ["profile_id": "Profile 1"])
            check(h.bodies.count == 1 && h.bodies[0]["profile_id"] as? String == "Profile 1", action + " uses store preparation")
            h.preparations[0](ready("Profile 1"))
            check(h.launches.count == 1 && h.launches[0].arguments == ["--profile-directory=Profile 1", "https://chromewebstore.google.com/detail/" + id], action + " opens chosen profile only")
            h.launchReplies[0](true)
            check(h.replies.count == 1 && h.replies[0]["opened"] as? Bool == true, action + " reports dispatch")
            check(h.replies[0]["installed"] == nil && h.replies[0]["completed"] == nil && h.replies[0]["profile_verified"] == nil, "opening is not installation or profile verification")
        }
        for url in ["https://example.com/" + id, "https://chromewebstore.google.com/detail/" + String(repeating: "b", count: 32), "https://chromewebstore.google.com/detail/" + id + "?redirect=1", "https://chromewebstore.google.com/detail/" + id + "#x", "https://u:p@chromewebstore.google.com/detail/" + id] {
            let h = StoreHarness(); h.call(); var response = ready(); response["store_url"] = url; h.preparations[0](response)
            check(h.launches.isEmpty && h.replies[0]["error_code"] as? String == "CHROME_STORE_LISTING_INVALID", "reject listing mismatch or injected URL")
        }
        for profile in ["../Default", "Default\n--remote-debugging-port=9222", "Profile 1\n", "Profile 0001", "--user-data-dir=/tmp/x"] {
            let h = StoreHarness(); h.call("extensionSetup", ["profile_id": profile])
            check(h.bodies.isEmpty && h.launches.isEmpty && h.replies[0]["error_code"] as? String == "CHROME_STORE_PROFILE_UNKNOWN", "reject profile argument injection")
        }
        do {
            let h = StoreHarness(); h.call("extensionSetup", ["store_url": "https://example.com"])
            check(h.bodies.isEmpty && h.replies[0]["error_code"] as? String == "ARG_INVALID", "caller cannot provide a listing")
            h.call("extensionSetup", ["profile_id": 3])
            check(h.bodies.isEmpty && h.replies.last?["error_code"] as? String == "ARG_INVALID", "profile type is validated")
        }
        do {
            let h = StoreHarness(); h.call(); h.preparations[0](["distribution": "chrome_web_store", "config_state": "pending", "store_ready": false])
            check(h.launches.isEmpty && h.replies[0]["error_code"] as? String == "CHROME_STORE_CONFIGURATION_PENDING", "pending never opens a fallback")
        }
        do {
            let h = StoreHarness(); h.call(); h.preparations[0](ready(nil))
            check(h.launches.isEmpty && h.replies[0]["choose_profile"] as? Bool == true, "ask for selected profile without inspecting Chrome windows")
        }
        do {
            let h = StoreHarness(); h.call("extensionSetup", ["profile_id": "Profile 1"]); h.preparations[0](ready("Default"))
            check(h.launches.isEmpty && h.replies[0]["error_code"] as? String == "CHROME_STORE_PROFILE_UNKNOWN", "backend cannot silently substitute a profile")
        }
        do {
            let h = StoreHarness(); h.call(); h.call("extensionCancel"); h.preparations[0](ready())
            check(h.launches.isEmpty && h.replies.count == 2 && h.replies[0]["cancelled"] as? Bool == true, "cancel fences delayed preparation")
            check(h.apiRoutes == ["/api/browser/extension/store/cancel"], "cancel never calls legacy installer endpoints")
        }
        do {
            let h = StoreHarness(); h.call(); h.call(); h.preparations[0](ready()); h.preparations[1](ready())
            check(h.launches.count == 1 && h.replies.count == 1, "new attempt replaces old preparation")
            h.call("extensionCancel"); h.launchReplies[0](true)
            check(h.replies.count == 3 && h.replies[1]["cancelled"] as? Bool == true, "late open callback cannot complete cancelled attempt")
        }
        do {
            let h = StoreHarness(); h.call(); h.authorized = false; h.preparations[0](ready())
            check(h.launches.isEmpty && h.replies[0]["error_code"] as? String == "OWNED_WINDOW_REQUIRED", "ownership loss stops dispatch")
        }
        do {
            let h = StoreHarness(); h.call(); h.preparations[0](ready()); h.launchReplies[0](false)
            check(h.replies[0]["opened"] as? Bool == false && h.replies[0]["error_code"] as? String == "CHROME_STORE_OPEN_FAILED", "OS failure is not successful installation")
            h.call("openChromeDataAccessSettings")
            check(h.apiRoutes.isEmpty && h.replies.last?["error_code"] as? String == "CHROME_LOCAL_INSTALL_DISABLED", "old data-access settings flow is disabled")
        }
        print("PASS: \(checks) store native checks; injected API/launch only")
    }
}
