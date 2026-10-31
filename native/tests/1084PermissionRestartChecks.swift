import AppKit
import Foundation

private func check(_ value:Bool,_ label:String) {if !value {fputs("FAIL: \(label)\n",stderr);exit(1)}}
private func record(_ file:URL,_ fields:[String:Any]) {
    var row=fields;row["pid"]=Int(getpid());row["time"]=Date().timeIntervalSince1970
    guard var data=try? JSONSerialization.data(withJSONObject:row) else{return};data.append(10)
    let fd=Darwin.open(file.path,O_WRONLY|O_CREAT|O_APPEND,mode_t(0o600));guard fd>=0 else{return};defer{Darwin.close(fd)}
    _=data.withUnsafeBytes{Darwin.write(fd,$0.baseAddress!,$0.count)}
}
// The frozen baseline keeps its open-before-quit order. Its /usr/bin/open
// boundary is replaced with the equivalent public launch configuration so a
// deliberately failing control never opens Finder error UI on the user's Mac.
private final class QuietBaselineOpen {
    var executableURL:URL?
    var arguments:[String]?
    func run() throws {
        guard executableURL?.path=="/usr/bin/open",arguments==["-n",Bundle.main.bundleURL.path] else{throw NSError(domain:"FixtureBoundary",code:1)}
        let app=Bundle.main.bundleURL,receipt=app.deletingLastPathComponent().appendingPathComponent("events.jsonl")
        let config=NSWorkspace.OpenConfiguration();config.createsNewApplicationInstance=true;config.allowsRunningApplicationSubstitution=false;config.activates=false;config.promptsUserIfNeeded=false;config.addsToRecentItems=false
        NSWorkspace.shared.openApplication(at:app,configuration:config){opened,error in
            record(receipt,["event":"baseline_open_result","new_pid":Int(opened?.processIdentifier ?? -1),"success":opened != nil && error==nil])
        }
    }
}
private final class PermissionStub {var complete=true;func status()->[String:Any]{["complete":complete]}}
private final class PermissionRestartFixture:NSObject,NSApplicationDelegate {
    let permissionAssistant=PermissionStub()
    let root:URL
    var lease:InstanceLifecycle.Lease?
    var fakeResult:[String:Any]?
    var helperCalls=0
    var scenario="patched"
    var receipt:URL{root.appendingPathComponent("events.jsonl")}
    init(root:URL){self.root=root}
    func relaunchChatHand(completion:@escaping([String:Any])->Void) {
        helperCalls += 1
        if let fakeResult {completion(fakeResult);return}
        let helper=Process();helper.executableURL=Bundle.main.executableURL
        helper.arguments=["helper",Bundle.main.bundleURL.path,String(getpid())]
        helper.standardInput=FileHandle.nullDevice;helper.standardOutput=FileHandle.nullDevice;helper.standardError=FileHandle.nullDevice
        do {try helper.run();completion(["relaunching":true])}catch{completion(["error":"RELAUNCH_START_FAILED"])}
    }
    __PATCHED_METHOD__
    __BASELINE_METHOD__
    func runUnitChecks() {
        var responses=[[String:Any]]()
        permissionAssistant.complete=false;fakeResult=["relaunching":true]
        confirmAndRestartAfterPermissions{responses.append($0)}
        check(helperCalls==0 && responses.count==1 && responses[0]["reason"] as? String=="permissions_incomplete","incomplete permissions do not launch a helper")
        permissionAssistant.complete=true;responses=[]
        confirmAndRestartAfterPermissions{responses.append($0)}
        check(helperCalls==1 && responses.count==1 && responses[0]["restart"] as? Bool==true,"helper acceptance preserves restart true exactly once")
        for error in ["RELAUNCH_BUSY","RELAUNCH_SIGNATURE_UNKNOWN","RELAUNCH_HELPER_MISSING"] {
            fakeResult=["error":error];responses=[]
            confirmAndRestartAfterPermissions{responses.append($0)}
            check(responses.count==1 && responses[0]["restart"] as? Bool==false && responses[0]["reason"] as? String=="launch_failed" && responses[0]["error"] as? String==error,"helper failure remains a failed restart with its code")
        }
        fakeResult=[:];responses=[];confirmAndRestartAfterPermissions{responses.append($0)}
        check(responses[0]["error"] as? String=="RELAUNCH_START_FAILED","missing helper acceptance fails closed")
        print("PASS: extracted production permission restart method")
    }
    func applicationDidFinishLaunching(_ n:Notification) {
        do {lease=try InstanceLifecycle.acquire(state:root.appendingPathComponent("state"))}catch{record(receipt,["event":"lease_error"]);exit(2)}
        guard lease != nil else {record(receipt,["event":"contender_forwarded_to_old_owner"]);NSApp.terminate(nil);return}
        let initial=CommandLine.arguments.contains("initial")
        record(receipt,["event":initial ? "initial_owner":"fresh_owner"])
        if initial {
            let config=(try? Data(contentsOf:root.appendingPathComponent("scenario.json"))).flatMap{try? JSONSerialization.jsonObject(with:$0) as? [String:Any]}
            scenario=config?["scenario"] as? String ?? "patched"
            DispatchQueue.main.asyncAfter(deadline:.now()+0.1){
                let done:([String:Any])->Void={record(self.receipt,["event":"restart_response","response":$0])}
                if self.scenario=="baseline"{self.baselineRestartAfterPermissions(completion:done)}else{self.confirmAndRestartAfterPermissions(completion:done)}
            }
        }
        DispatchQueue.main.asyncAfter(deadline:.now()+20){NSApp.terminate(nil)}
    }
    func applicationShouldTerminate(_ sender:NSApplication)->NSApplication.TerminateReply{.terminateNow}
    func applicationWillTerminate(_ n:Notification){lease=nil;record(receipt,["event":"owner_terminated"])}
}
@main struct PermissionRestartChecks {
    static func main() {
        let a=CommandLine.arguments
        if a.count==2 && a[1]=="unit" {PermissionRestartFixture(root:URL(fileURLWithPath:"/unused")).runUnitChecks();return}
        if a.count==4 && a[1]=="helper" {
            let appURL=URL(fileURLWithPath:a[2]),root=appURL.deletingLastPathComponent(),receipt=root.appendingPathComponent("events.jsonl")
            guard let pid=Int32(a[3]),let source=NSRunningApplication(processIdentifier:pid),source.bundleURL==appURL,source.bundleIdentifier=="test.chathand.permissionrestart1084" else{exit(3)}
            record(receipt,["event":"helper_stop_requested","old_pid":Int(pid)])
            guard source.terminate() else{exit(4)}
            let deadline=Date().addingTimeInterval(7)
            while kill(pid,0)==0 && Date()<deadline{RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
            guard kill(pid,0) != 0,errno==ESRCH else{exit(5)}
            do {guard let proof=try InstanceLifecycle.acquire(state:root.appendingPathComponent("state")) else{exit(6)};withExtendedLifetime(proof){record(receipt,["event":"old_pid_gone_lease_available","old_pid":Int(pid)])}}catch{exit(7)}
            let config=NSWorkspace.OpenConfiguration();config.createsNewApplicationInstance=true;config.allowsRunningApplicationSubstitution=false;config.activates=false;config.promptsUserIfNeeded=false;config.addsToRecentItems=false
            var done=false;var success=false
            NSWorkspace.shared.openApplication(at:appURL,configuration:config){app,error in
                record(receipt,["event":"helper_open_result","new_pid":Int(app?.processIdentifier ?? -1),"old_pid":Int(pid),"success":app != nil && error==nil]);success=app != nil && error==nil;done=true
            }
            let until=Date().addingTimeInterval(7);while !done && Date()<until{RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
            exit(done && success ? 0:8)
        }
        if a.count==3 && a[1]=="launch" {
            let appURL=URL(fileURLWithPath:a[2]),config=NSWorkspace.OpenConfiguration()
            config.createsNewApplicationInstance=true;config.allowsRunningApplicationSubstitution=false;config.activates=false;config.promptsUserIfNeeded=false;config.addsToRecentItems=false;config.arguments=["initial"]
            var done=false;var success=false
            NSWorkspace.shared.openApplication(at:appURL,configuration:config){app,error in success=app != nil && error==nil;done=true}
            let until=Date().addingTimeInterval(7);while !done && Date()<until{RunLoop.current.run(until:Date().addingTimeInterval(0.01))};exit(done && success ? 0:9)
        }
        let app=NSApplication.shared;app.setActivationPolicy(.regular)
        let delegate=PermissionRestartFixture(root:Bundle.main.bundleURL.deletingLastPathComponent());app.delegate=delegate;app.run();withExtendedLifetime(delegate){}
    }
}
