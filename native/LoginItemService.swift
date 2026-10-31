import Foundation
import ServiceManagement

@MainActor
enum LoginItemService {
    static func removeForUninstall() async throws {
        guard Bundle.main.bundleIdentifier == BuildVersion.bundleID,
              Bundle.main.bundleURL.pathExtension == "app" else {
            throw NSError(domain: "ChatHandUninstall", code: 1)
        }
        let service = SMAppService.mainApp
        if service.status != .notRegistered && service.status != .notFound { try await service.unregister() }
        guard service.status == .notRegistered || service.status == .notFound else {
            throw NSError(domain: "ChatHandUninstall", code: 2)
        }
    }
    static func uninstallReason(_ error:Error) -> String {
        let value=error as NSError
        if value.domain == "ChatHandUninstall" { return value.code == 1 ? "LOGIN_ITEM_IDENTITY" : "LOGIN_ITEM_REMAINS" }
        if value.domain == NSCocoaErrorDomain && [NSFileReadNoPermissionError,NSFileWriteNoPermissionError].contains(value.code) { return "ACCESS_DENIED" }
        return "LOGIN_ITEM_REMOVE_FAILED"
    }
    static func openSettings() -> [String: Any] {
        SMAppService.openSystemSettingsLoginItems()
        return ["opened": true]
    }
    static func status() -> [String: Any] {
        let service = SMAppService.mainApp
        let value: String
        switch service.status {
        case .notRegistered: value = "not_registered"
        case .enabled: value = "enabled"
        case .requiresApproval: value = "requires_approval"
        case .notFound: value = "not_found"
        @unknown default: value = "unknown"
        }
        return ["supported": true, "enabled": service.status == .enabled, "status": value,
                "requires_approval": service.status == .requiresApproval,
                "can_change": Bundle.main.bundleURL.pathExtension == "app" && Bundle.main.bundleIdentifier == BuildVersion.bundleID]
    }
    static func setEnabled(_ enabled: Bool) async -> [String: Any] {
        guard status()["can_change"] as? Bool == true else {
            return ["supported": true, "error_code": "LOGIN_ITEM_APP_REQUIRED", "message": LocalText.text("native.login.appRequired")]
        }
        do {
            let service = SMAppService.mainApp
            if enabled {
                if service.status != .enabled && service.status != .requiresApproval { try service.register() }
            } else if service.status != .notRegistered { try await service.unregister() }
            return status()
        } catch {
            var result = status()
            result["error_code"] = "LOGIN_ITEM_CHANGE_FAILED"
            result["message"] = LocalText.text("native.login.failed")
            return result
        }
    }
}
