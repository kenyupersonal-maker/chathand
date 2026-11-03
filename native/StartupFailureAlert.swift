import AppKit

enum StartupFailureAction: String { case retry, download, dataFolder, log, quit }

/// The failure surface needs neither the local service nor the web interface.
/// It displays only fixed reason codes, never arbitrary logs or exception text.
enum StartupFailureAlert {
    static func errorCode(_ error: Error) -> String {
        let value=error as NSError
        if value.domain == NSPOSIXErrorDomain {
            if [Int(EACCES),Int(EPERM)].contains(value.code) { return "STARTUP_ACCESS_DENIED" }
            if value.code == Int(ENOSPC) { return "STARTUP_STORAGE_FULL" }
        }
        if value.domain == NSCocoaErrorDomain && [NSFileReadNoPermissionError,NSFileWriteNoPermissionError].contains(value.code) { return "STARTUP_ACCESS_DENIED" }
        return "SERVICE_LAUNCH_FAILED"
    }
    static func reason(_ code: String) -> String {
        switch code {
        case "SERVICE_NODE_MISSING": return "nodeMissing"
        case "STARTUP_NODE_VERSION": return "nodeVersion"
        case "STARTUP_STORAGE_FULL": return "storage"
        case "STARTUP_ACCESS_DENIED": return "access"
        case "STARTUP_ALREADY_RUNNING", "INSTANCE_LOCK_BUSY", "INSTANCE_QUITTING_TIMEOUT": return "running"
        case "INITIAL_START_TIMEOUT", "MIGRATION_TIMEOUT": return "timeout"
        case "STARTUP_PORT_IN_USE": return "port"
        case "STARTUP_OWNER_EXITED": return "owner"
        case "DATA_FORMAT_UNSUPPORTED", "STARTUP_DATA_UNSUPPORTED", "STATE_UNSAFE", "B_STORE_CONFIG", "B_STORE_UNSAFE", "RELAY_STATE_VERSION", "MATTER_UNSAFE_PATH", "MATTER_UNSAFE_FILE", "MATTER_SEQUENCE", "MATTER_ID", "MATTER_JOURNAL_CONFLICT": return "data"
        default: return "service"
        }
    }
    static func make(code: String, canRetry: Bool, text: (String)->String) -> (NSAlert,[StartupFailureAction]) {
        let category=reason(code),alert=NSAlert()
        alert.alertStyle = .warning
        alert.messageText=text("native.start.failed")
        alert.informativeText=text("native.startupFailure."+category)+"\n("+code+")"
        let first: StartupFailureAction = ["nodeMissing","nodeVersion"].contains(category) ? .download : ["data","storage","access","running"].contains(category) || !canRetry ? .dataFolder : .retry
        let actions=[first,StartupFailureAction.log,.quit]
        for action in actions { alert.addButton(withTitle:text("native.startupFailure.action."+action.rawValue)) }
        return (alert,actions)
    }
}
