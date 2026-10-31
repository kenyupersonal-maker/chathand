import Foundation

@main struct MenuBarStateChecks {
    static func main() {
        let now=Date(timeIntervalSince1970:200)
        let base:[String:Any]=["enabled":true,"mode":"auto","connection":["ready":true,"healthy":true],"project":["id":"p","name":"研究","path":"/tmp/research"],"settings":["conversations":[["id":"chat","project_id":"p","title":"已绑定对话"]]]]
        let idle=MenuBarState(snapshot:base,now:now)
        precondition(idle.indicator == .idle && idle.tasks.isEmpty && idle.shortStatus.isEmpty)
        precondition(idle.workspaceTitle == "文件范围：研究")
        var running=base
        running["tasks"]=[["task_id":"t","project_id":"p","title":"真实任务","status":"active","created_at":100_000.0,"jobs":["j"],"conversation_id":"chat"]]
        running["jobs"]=[["job_id":"j","status":"running","process_alive":true]]
        let active=MenuBarState(snapshot:running,now:now)
        precondition(active.indicator == .running && active.tasks.count == 1)
        precondition(active.tasks[0].detail == "正在运行命令 · 1:40 · 来自「已绑定对话」")
        var unbound=running;unbound["settings"]=["conversations":[]]
        precondition(!MenuBarState(snapshot:unbound,now:now).tasks[0].detail.contains("来自"))
        var otherProject=running;otherProject["settings"]=["conversations":[["id":"chat","project_id":"other","title":"不能混入"]]]
        precondition(!MenuBarState(snapshot:otherProject,now:now).tasks[0].detail.contains("不能混入"))
        var noJob=running;noJob["jobs"]=[["job_id":"unrelated","status":"running"]]
        precondition(MenuBarState(snapshot:noJob,now:now).tasks[0].detail.hasPrefix("任务进行中"))
        var finished=running;finished["tasks"]=[["status":"completed","title":"不能作为运行中显示"]]
        precondition(MenuBarState(snapshot:finished).tasks.isEmpty)
        var pending=base;pending["tasks"]=[["task_id":"t","status":"pending_approval","title":"待确认"]]
        precondition(MenuBarState(snapshot:pending).shortStatus == "待处理")
        let unavailable=MenuBarState(snapshot:running,serviceAvailable:false)
        precondition(unavailable.indicator == .error && unavailable.tasks.isEmpty && !unavailable.accessEnabled)
        var full=base;full["mode"]="full"
        precondition(MenuBarState(snapshot:full).workspaceTitle.hasSuffix("整台电脑"))
        var computer=base;computer["project"]=["name":"整台电脑","scope":"computer"]
        precondition(MenuBarState(snapshot:computer).workspaceTitle.hasSuffix("整台电脑"))
        var relay=base;relay["connection"]=[:];relay["relay"]=["online":true]
        precondition(MenuBarState(snapshot:relay).isConnected)
        var paused=base;paused["enabled"]=false
        precondition(MenuBarState(snapshot:paused).connectionTitle == "ChatGPT 已连接 · AI 已暂停")
        var commandApproval=running;commandApproval["jobs"]=[["job_id":"j","status":"pending_approval"]]
        precondition(MenuBarState(snapshot:commandApproval).shortStatus == "待处理")
        precondition(MenuBarState(snapshot:commandApproval).tasks[0].detail.hasPrefix("等待确认"))
        var offline=base;offline["connection"]=["ready":false,"healthy":false,"error":NSNull(),"automatic":["phase":"idle"]];offline["settings"]=["connection_preference":"none"]
        precondition(MenuBarState(snapshot:offline).indicator == .offline && MenuBarState(snapshot:offline).shortStatus.isEmpty)
        precondition(MenuBarState(snapshot:[:],serviceAvailable:false).indicator == .offline)
        var pausedOffline=base;pausedOffline["enabled"]=false
        precondition(MenuBarState(snapshot:pausedOffline).indicator == .offline)
        for phase in ["starting","connecting","reconnecting","restoring"] {
            var connecting=offline;connecting["connection"]=["automatic":["phase":phase]]
            precondition(MenuBarState(snapshot:connecting).indicator == .connecting)
        }
        var failed=offline;failed["connection"]=["automatic":["phase":"connecting"],"error":["code":"CONNECTION_FAILED"]]
        precondition(MenuBarState(snapshot:failed).indicator == .error && MenuBarState(snapshot:failed).shortStatus == "出错")
        var cloudDown=base;cloudDown["connection"]=["ready":false,"healthy":false,"control_plane":["state":"down"],"automatic":["phase":"connecting"]]
        precondition(MenuBarState(snapshot:cloudDown).indicator == .error)
        var healthyRelay=relay;healthyRelay["connection"]=["control_plane":["state":"down"],"error":["code":"OLD_TUNNEL_ERROR"]]
        precondition(MenuBarState(snapshot:healthyRelay).indicator == .idle)
        var update=base;update["update"]=["status":"available","version":"1.0.0-beta.3"]
        precondition(MenuBarState(snapshot:update).updateMenuTitle == "更新到 1.0.0-beta.3…")
        for state in ["idle","failed","downloading"] {
            update["update"]=["status":"available","version":"1.0.0-beta.3","install":["state":state]]
            precondition((MenuBarState(snapshot:update).updateMenuTitle != nil) == (state != "downloading"))
        }
        print("PASS: five menu bar states, command and conversation details, approval, stale service, scope, relay, pause, update menu availability")
    }
}
