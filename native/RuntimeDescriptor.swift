import Foundation

// Runtime compatibility is an API contract, independent of the release version.
enum RuntimeDescriptor {
    static func accepts(_ r: [String: Any], supportedAPI: Int = BuildVersion.runtimeAPI) -> Bool {
        guard let api = r["runtime_api"] as? Int, api == supportedAPI,
              r["product"] as? String == "ken-bridge",
              let version = r["version"] as? String, !version.isEmpty,
              let pid = r["pid"] as? Int, pid > 1,
              let text = r["ui_origin"] as? String, let u = URL(string: text),
              u.scheme == "http", u.host == "127.0.0.1", let port = u.port,
              port > 0, port <= 65535, u.user == nil, u.password == nil,
              u.query == nil, u.fragment == nil, u.path.isEmpty || u.path == "/",
              let token = r["admin_token"] as? String,
              token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { return false }
        return true
    }
}
