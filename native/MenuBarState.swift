import Foundation

/// A presentation of observed local state. Conversation names require an explicit binding.
struct MenuBarState {
    enum Indicator { case idle, running, connecting, error, offline }
    struct TaskRow { let title: String; let detail: String }
    let connectionTitle: String
    let workspaceTitle: String
    let tasks: [TaskRow]
    let indicator: Indicator
    let shortStatus: String
    let accessEnabled: Bool
    let isConnected: Bool
    let updateStatus: String?
    let updateVersion: String?
    let updateInstallState: String?
    var updateMenuTitle: String? {
        guard updateStatus == "available", let version = updateVersion,
              updateInstallState == nil || ["idle", "failed"].contains(updateInstallState!) else { return nil }
        return LocalText.text("native.menu.update", ["version": version])
    }

    init(snapshot: [String: Any], serviceAvailable: Bool = true, now: Date = Date()) {
        let connection = snapshot["connection"] as? [String: Any] ?? [:]
        let automatic = connection["automatic"] as? [String: Any] ?? [:]
        let relay = snapshot["relay"] as? [String: Any] ?? [:]
        let settings = snapshot["settings"] as? [String: Any] ?? [:]
        let project = snapshot["project"] as? [String: Any] ?? [:]
        let update = serviceAvailable ? snapshot["update"] as? [String: Any] ?? [:] : [:]
        updateStatus = Self.text(update["status"])
        updateVersion = Self.text(update["version"])
        updateInstallState = Self.text((update["install"] as? [String: Any])?["state"])
        let phase = automatic["phase"] as? String ?? ""
        // The local transport can be fine while the cloud cannot be reached (proxy off, network changed): that is not connected.
        let siteSelected = (snapshot["site_b"] as? [String: Any])?["selected"] as? String == "site"
        let display = siteSelected || relay["online"] as? Bool == true ? nil : connection["display"] as? [String: Any]
        let cloudDown = (connection["control_plane"] as? [String: Any])?["state"] as? String == "down"
        let connected = serviceAvailable && ((display != nil ? display?["connected"] as? Bool == true : connection["ready"] as? Bool == true && connection["healthy"] as? Bool == true && !cloudDown) || relay["online"] as? Bool == true)
        isConnected = connected
        accessEnabled = serviceAvailable && snapshot["enabled"] as? Bool == true
        let connecting = serviceAvailable && ["starting", "connecting", "reconnecting", "restoring"].contains(phase)
        let displayTitle = serviceAvailable ? Self.text(display?["title"]).map(Self.localizedDisplayTitle) : nil
        connectionTitle = displayTitle != nil ? (connected && !accessEnabled ? LocalText.text("native.connection.displayPaused", ["title": displayTitle!]) : displayTitle!) : (connected ? (accessEnabled ? LocalText.text("native.connection.ready") : LocalText.text("native.connection.paused")) : connecting ? LocalText.text("native.connection.connecting") : cloudDown ? LocalText.text("native.connection.cloudDown") : LocalText.text("native.connection.offline"))
        let name = Self.text(project["name"]) ?? Self.text(project["path"]).map { URL(fileURLWithPath: $0).lastPathComponent } ?? LocalText.text("native.workspace.unselected")
        let wholeComputer = project["scope"] as? String == "computer" || (snapshot["mode"] as? String ?? settings["mode"] as? String) == "full"
        workspaceTitle = wholeComputer ? LocalText.text("native.workspace.computer") : LocalText.text("native.workspace.folder", ["name": name])
        let observedTasks = serviceAvailable ? (snapshot["tasks"] as? [[String: Any]] ?? []) : []
        let active = observedTasks.filter { ["active", "pending_approval"].contains($0["status"] as? String ?? "") }
            .sorted { ($0["created_at"] as? Double ?? 0) < ($1["created_at"] as? Double ?? 0) }
        let jobs = snapshot["jobs"] as? [[String: Any]] ?? []
        let conversations = settings["conversations"] as? [[String: Any]] ?? []
        let approvals = snapshot["approvals"] as? [[String: Any]] ?? []
        let inputs = snapshot["inputs"] as? [[String: Any]] ?? []
        func awaitsApproval(_ task: [String: Any]) -> Bool {
            if task["status"] as? String == "pending_approval" { return true }
            let ids = Set(task["jobs"] as? [String] ?? [])
            if let id = task["task_id"] as? String, approvals.contains(where: { $0["task_id"] as? String == id && $0["status"] as? String == "pending_approval" }) { return true }
            return (jobs + inputs).contains { item in
                guard let id = item["job_id"] as? String, ids.contains(id) else { return false }
                return item["status"] as? String == "pending_approval"
            }
        }
        let needsAttention = active.contains(where: awaitsApproval)
        tasks = active.map { task in
            let ids = Set(task["jobs"] as? [String] ?? [])
            let runningCommand = jobs.contains { job in
                guard let id = job["job_id"] as? String, ids.contains(id) else { return false }
                return job["status"] as? String == "running" || job["process_alive"] as? Bool == true
            }
            // No tool payload or invented per-task progress is used for the fallback.
            let step = awaitsApproval(task) ? LocalText.text("native.task.waiting") : runningCommand ? LocalText.text("native.task.command") : LocalText.text("native.task.active")
            var parts = [step]
            if let milliseconds = task["created_at"] as? Double, milliseconds > 0 {
                let seconds = max(0, Int(now.timeIntervalSince1970 - milliseconds / 1000))
                parts.append(seconds >= 3600 ? String(format: "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60) : String(format: "%d:%02d", seconds / 60, seconds % 60))
            }
            if let id = task["conversation_id"] as? String,
               let bound = conversations.first(where: { $0["id"] as? String == id && $0["project_id"] as? String == task["project_id"] as? String }),
               let title = Self.text(bound["title"]) { parts.append(LocalText.text("native.task.fromConversation", ["title": title])) }
            return TaskRow(title: Self.text(task["title"]) ?? LocalText.text("native.task.unnamed"), detail: parts.joined(separator: " · "))
        }
        let error = connection["error"] as? [String: Any] ?? [:]
        let hasConnectionError = Self.text(error["code"]) != nil || Self.text(error["message"]) != nil || Self.text(connection["error"]) != nil
        // An empty initial snapshot is expected before the first successful poll; only a
        // populated snapshot becoming unavailable indicates a backend failure.
        let hasError = (!serviceAvailable && !snapshot.isEmpty) || (!connected && (cloudDown || hasConnectionError || ["failed", "error"].contains(phase)))
        indicator = hasError ? .error : connecting ? .connecting : !connected || !accessEnabled ? .offline : active.contains { $0["status"] as? String == "active" } ? .running : .idle
        shortStatus = needsAttention ? LocalText.text("native.status.attention") : hasError ? LocalText.text("native.status.error") : connecting ? LocalText.text("native.status.connecting") : ""
    }

    private static func localizedDisplayTitle(_ title: String) -> String {
        // connection-display currently emits these fixed Chinese status titles.
        // Re-render known statuses locally while retaining unrecognized server text.
        // The daemon continues running in its startup language until its next start.
        guard LocalText.systemLocale == "en" else { return title }
        let keys = [
            "已连接": "native.connection.ready",
            "正在连接 ChatGPT": "native.connection.connecting",
            "尚未连接 ChatGPT": "native.connection.offline",
            "无法连接": "native.connection.cloudDown",
            "连接信息保存失败": "connection.saveFailed",
            "连接信息未通过验证": "connection.authFailed",
            "暂时无法连接": "connection.retryBlocked",
            "网络连接不可用": "ui.window.connectionText.offline.text"
        ]
        return keys[title].map { LocalText.text($0) } ?? title
    }

    private static func text(_ value: Any?) -> String? {
        guard let text = value as? String else { return nil }
        let clean = text.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        return clean.isEmpty ? nil : clean
    }
}
