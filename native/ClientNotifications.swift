import Foundation

/// Notification payloads contain routing metadata only, never page/input content.
enum ClientNotifications {
    static let confirmCategory = "chathand.confirm"
    static let confirmDenyCategory = "chathand.confirm.deny"
    static let allowAlwaysAction = "allow_always"
    static let allowOnceAction = "allow_once"
    static let denyAction = "deny"

    /// 深链来自网页或对话，不是允许操作的证据；返回值只能用于页面跳转。
    static func route(for url: URL) -> [String: String]? {
        guard url.scheme?.lowercased() == "chathand", url.user == nil, url.password == nil,
              url.port == nil, url.query == nil, url.fragment == nil, let host = url.host?.lowercased() else { return nil }
        // URL.path 会去掉末尾斜杠；保留原始路径，空编号和多余斜杠不能变成有效路由。
        guard let rawPath = URLComponents(url:url, resolvingAgainstBaseURL:false)?.percentEncodedPath else { return nil }
        let parts = rawPath.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.first == "", parts.count >= 2 else { return nil }
        let segments = parts.dropFirst().map(String.init)
        let validID: (String) -> Bool = { value in
            !value.isEmpty && value.count <= 128 && value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
        }
        switch host {
        case "setup":
            guard segments == ["openai"] else { return nil }
            return ["page":"setup", "section":"openai"]
        case "settings":
            guard (1...2).contains(segments.count),
                  ["commands", "browser", "desktop", "scope", "connection"].contains(segments[0]) else { return nil }
            var result = ["page":"settings", "section":segments[0]]
            if segments.count == 2 { guard validID(segments[1]) else { return nil }; result["item"] = segments[1] }
            return result
        case "confirm":
            guard segments.count == 1, validID(segments[0]) else { return nil }
            return ["page":"home", "confirm_id":segments[0]]
        case "task":
            guard segments.count == 1, validID(segments[0]) else { return nil }
            return ["page":"tasks", "task_id":segments[0]]
        default:
            return nil
        }
    }

    static func networkChallengeTarget(kind: String?) -> [String: String]? {
        guard kind == "network_challenge", let url=URL(string:"chathand://setup/openai") else { return nil }
        return route(for:url)
    }
    static var browserConnectionLostTitle: String { LocalText.text("native.notification.browserLost.title") }
    static var browserConnectionLostBody: String { LocalText.text("native.notification.browserLost.body") }
    static func confirmationTitle(item: [String: Any]?) -> String {
        guard let item, let id = item["id"] as? String, let name = item["name"] as? String else {
            return LocalText.text("native.notification.capability.title")
        }
        let keys = ["permissions.risk.\(id).name", "permissions.capability.\(id).name"] + (id == "full" ? ["permissions.scope.name"] : [])
        let key = keys.first { LocalText.catalog.chinese[$0] == name || LocalText.catalog.english[$0] == name }
        let localizedName = key.map { LocalText.text($0) } ?? name
        return LocalText.text("notification.confirmation.request", ["name": localizedName])
    }
    /// An existing daemon may still format text in its startup language. Re-render
    /// known notification templates locally, while leaving user content literal.
    static func continuationBody(_ event: [String: Any]) -> String {
        guard let body = event["body"] as? String else { return LocalText.text("native.notification.taskReminder.body") }
        let parameters = ["title": event["title"] as? String ?? LocalText.text("notification.task.default")]
        for key in ["notification.task.blockLimit", "notification.task.autoContinue", "notification.task.manualContinue"] {
            if ["zh", "en"].contains(where: { LocalText.catalog.text(key, parameters, locale: $0) == body }) {
                return LocalText.text(key, parameters)
            }
        }
        return body
    }
    static func browserRepairTarget(kind: String?) -> [String: String]? {
        guard kind == "browser_connection_lost" else { return nil }
        return ["page":"settings", "section":"browser", "reason":"connection_lost"]
    }
    static func browserRepairScript(kind: String?) -> String? {
        guard let target = browserRepairTarget(kind:kind),
              let bytes = try? JSONSerialization.data(withJSONObject:target),
              let payload = String(data:bytes,encoding:.utf8) else { return nil }
        return "(()=>{const target=\(payload);window.showPage && window.showPage(target.page,target.section);window.dispatchEvent(new CustomEvent('browserRepairRequested',{detail:target}));})()"
    }
}

/// Network notices retry delivery failures, and retry acknowledgement separately
/// once macOS has accepted the notification. No other notification kind uses this gate.
struct NetworkChallengeNotificationGate {
    enum Action { case none, deliver, acknowledge }
    private(set) var delivered: [String]
    private var inFlight = Set<String>()
    private var retryAfter: [String: Double] = [:]
    init(delivered: [String] = []) { self.delivered = Array(delivered.suffix(256)) }
    mutating func next(key: String, nowMS: Double) -> Action {
        guard !inFlight.contains(key), nowMS >= (retryAfter[key] ?? 0) else { return .none }
        if delivered.contains(key) { retryAfter[key] = nowMS + 30_000; return .acknowledge }
        inFlight.insert(key)
        return .deliver
    }
    mutating func completed(key: String, succeeded: Bool, nowMS: Double) {
        inFlight.remove(key)
        retryAfter[key] = nowMS + 30_000
        if succeeded && !delivered.contains(key) { delivered.append(key); delivered = Array(delivered.suffix(256)) }
    }
}
