import AppKit
import Foundation

/// Opens a prefilled Codex conversation in the installed ChatGPT desktop app.
/// URL dispatch is not evidence that a message was sent or setup completed.
enum SetupConversation {
    static func promptURL(_ prompt: String) -> URL? {
        guard !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              prompt.utf8.count <= 16_384 else { return nil }
        var components = URLComponents()
        components.scheme = "codex"
        components.host = "new"
        components.path = ""
        components.queryItems = [URLQueryItem(name: "prompt", value: prompt),
                                 URLQueryItem(name: "mode", value: "codex")]
        // URLSearchParams treats bare '+' as a space; preserve literal prompt text.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.url
    }

    private static func installedApp() -> URL? {
        [URL(fileURLWithPath: "/Applications/ChatGPT.app"),
         FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/ChatGPT.app")]
            .first { Bundle(url: $0)?.executableURL.map { FileManager.default.isExecutableFile(atPath: $0.path) } == true }
    }
    static func status() -> [String: Any] {
        guard let url = installedApp(), let bundle = Bundle(url: url) else {
            return ["available": false, "can_open": false, "reason": "not_installed", "auto_sent": false]
        }
        let types = bundle.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]] ?? []
        let supported = types.contains { ($0["CFBundleURLSchemes"] as? [String] ?? []).contains("codex") }
        return ["available": true, "can_open": supported, "reason": supported ? "ready" : "scheme_unavailable",
                "app": "ChatGPT", "version": bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "", "auto_sent": false]
    }
    /// Open the desktop app without dispatching a URL or creating a conversation.
    static func showDesktop(installed: () -> URL? = { installedApp() },
                            open: (URL, @escaping (Bool) -> Void) -> Void = { url, finish in
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        configuration.createsNewApplicationInstance = false
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
            DispatchQueue.main.async { finish(error == nil && app != nil) }
        }
    }, completion: @escaping ([String: Any]) -> Void) {
        guard let app = installed() else {
            completion(["opened": false, "error_code": "CHATGPT_DESKTOP_UNAVAILABLE"])
            return
        }
        open(app) { success in
            completion(success ? ["opened": true] : ["opened": false, "error_code": "CHATGPT_OPEN_FAILED"])
        }
    }
    static func open(prompt: String, completion: @escaping ([String: Any]) -> Void) {
        guard let url = promptURL(prompt) else {
            completion(["opened": false, "auto_sent": false, "error_code": "SETUP_PROMPT_INVALID"])
            return
        }
        guard status()["can_open"] as? Bool == true, let app = installedApp() else {
            var result = status();result["opened"] = false;result["error_code"] = "CHATGPT_DESKTOP_UNAVAILABLE"
            completion(result)
            return
        }
        // Target the known ChatGPT bundle rather than the system's default scheme handler.
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.open([url], withApplicationAt: app, configuration: configuration) { application, error in
            DispatchQueue.main.async {
                if error == nil && application != nil { completion(["opened": true, "dispatched": true, "auto_sent": false]) }
                else {
                    var result: [String: Any] = ["opened": false, "dispatched": false, "auto_sent": false, "error_code": "CHATGPT_OPEN_FAILED"]
                    if let error = error as NSError? {
                        result["native_error_domain"] = error.domain
                        result["native_error_code"] = error.code
                    }
                    completion(result)
                }
            }
        }
    }
}
