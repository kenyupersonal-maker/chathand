import Foundation
import Darwin

@main struct UninstallStagesChecks {
    static let fm=FileManager.default
    static func check(_ value:@autoclosure ()->Bool,_ label:String) { if !value() { fatalError(label) } }
    static func main() throws {
        let root=ProcessInfo.processInfo.environment["CHATHAND_UNINSTALL_FIXTURE_ROOT"].map {URL(fileURLWithPath:$0)} ?? fm.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("chathand-uninstall-stages-"+UUID().uuidString)
        try fm.createDirectory(at:root,withIntermediateDirectories:true)
        defer { try? fm.removeItem(at:root) }
        var receipts:[[String:Any]]=[]
        for mode in ["keep","delete","legacy_keep","legacy_delete","blocked","foreign","foreign_body","skill_symlink","backend","login","changed","busy","audit","pref_sync","symlink"] {
            let home=root.appendingPathComponent(mode),app=home.appendingPathComponent("Applications/ChatHand.app"),support=home.appendingPathComponent("Library/Application Support/ChatHand"),state=support.appendingPathComponent("data"),hosts=home.appendingPathComponent("Library/Application Support/Google/Chrome/NativeMessagingHosts"),skill=home.appendingPathComponent(".codex/skills/chathand-setup")
            for url in [app.appendingPathComponent("Contents"),state,hosts,skill] { try fm.createDirectory(at:url,withIntermediateDirectories:true) }
            if let source=ProcessInfo.processInfo.environment["CHATHAND_UNINSTALL_FIXTURE_APP"], ["keep","delete"].contains(mode) {
                try fm.removeItem(at:app);try fm.copyItem(at:URL(fileURLWithPath:source),to:app)
            } else {
                try PropertyListSerialization.data(fromPropertyList:["CFBundleIdentifier":"com.kenyu.chathand","CFBundleExecutable":"ChatHand"],format:.xml,options:0).write(to:app.appendingPathComponent("Contents/Info.plist"))
            }
            try Data("synthetic settings".utf8).write(to:state.appendingPathComponent("settings.json"))
            let installedSkill=["keep","delete"].contains(mode) && ProcessInfo.processInfo.environment["CHATHAND_UNINSTALL_FIXTURE_ROOT"] != nil
            if ["legacy_keep","legacy_delete"].contains(mode) {
                try Data("---\nname: chathand-setup\n---\nlegacy fixture\n".utf8).write(to:skill.appendingPathComponent("SKILL.md"))
            } else if mode == "foreign_body" {
                try Data("Synthetic other-product skill.\nname: chathand-setup\n".utf8).write(to:skill.appendingPathComponent("SKILL.md"))
            } else if !installedSkill {try Data("synthetic own skill".utf8).write(to:skill.appendingPathComponent("SKILL.md"))}
            if !["foreign","foreign_body","skill_symlink"].contains(mode) && !installedSkill && !["legacy_keep","legacy_delete"].contains(mode) {try Data("{\"format\":1,\"owner\":\"com.kenyu.chathand\",\"kind\":\"setup-skill\"}".utf8).write(to:skill.appendingPathComponent(".chathand-owned.json"))}
            let foreign=home.appendingPathComponent("personal.txt");try Data("unrelated".utf8).write(to:foreign)
            if mode == "skill_symlink" {try fm.removeItem(at:skill);try fm.createSymbolicLink(at:skill,withDestinationURL:foreign)}
            let foreignBackup=hosts.appendingPathComponent("org.kenbridge.browser.json.backup-"+UUID().uuidString)
            try Data("{\"name\":\"org.kenbridge.browser\",\"type\":\"stdio\",\"path\":\"/foreign/product\"}".utf8).write(to:foreignBackup)
            for name in ["com.kenyu.chathand.browser","org.kenbridge.browser"] {
                let object:[String:Any] = ["name":name,"type":"stdio","path":app.appendingPathComponent("Contents/Resources/runtime/bin/ChatHandBrowserHost").path]
                let bytes=try JSONSerialization.data(withJSONObject:object)
                try bytes.write(to:hosts.appendingPathComponent(name+".json"))
                try bytes.write(to:hosts.appendingPathComponent(name+".json.backup-"+UUID().uuidString))
            }
            let caches=["Library/Caches/com.kenyu.chathand","Library/HTTPStorages/com.kenyu.chathand","Library/WebKit/com.kenyu.chathand","Library/Saved Application State/com.kenyu.chathand.savedState"]
            for name in caches {let url=home.appendingPathComponent(name);try fm.createDirectory(at:url,withIntermediateDirectories:true);try Data("synthetic".utf8).write(to:url.appendingPathComponent("fixture"))}
            let prefs=home.appendingPathComponent("Library/Preferences/com.kenyu.chathand.plist");try fm.createDirectory(at:prefs.deletingLastPathComponent(),withIntermediateDirectories:true);try Data("synthetic prefs".utf8).write(to:prefs)
            if mode == "symlink" {
                let target=home.appendingPathComponent(caches[0]);try fm.removeItem(at:target);try fm.createSymbolicLink(at:target,withDestinationURL:home.appendingPathComponent("personal.txt"))
            }
            let plan=try ChatHandUninstallPlan(app:app,home:home,state:state,deleteData:!["keep","legacy_keep"].contains(mode),incremental:true)
            let logs=home.appendingPathComponent("Library/Logs")
            if mode == "audit" { try fm.createDirectory(at:logs,withIntermediateDirectories:true);check(chmod(logs.path,0) == 0,"deny own audit directory") }
            var auditError:String?
            do {try plan.prepareAudit()}catch {auditError=ChatHandUninstallPlan.reason(error)}
            if mode == "audit" {check(auditError == "ACCESS_DENIED","real audit directory denial classified")}
            else {check(auditError == nil,"audit writable")}

            if mode == "busy" {
                let existing=try plan.excludeUpgrade()
                do {_ = try plan.excludeUpgrade();fatalError("busy must refuse") }catch{}
                existing.release();check(fm.fileExists(atPath:app.path),"busy App unchanged");continue
            }
            let lease=try plan.excludeUpgrade()
            if mode == "blocked" {check(chmod(hosts.path,0) == 0,"deny own Chrome directory")}
            if mode == "foreign" {try Data("foreign registration".utf8).write(to:hosts.appendingPathComponent("org.kenbridge.browser.json"))}
            if mode == "changed" {try Data("changed Info".utf8).write(to:hosts.appendingPathComponent("org.kenbridge.browser.json"))}
            var events:[[String:String]]=[]
            let report=plan.executeStages(backendStopped:mode != "backend",loginRemoved:mode != "login",exclusion:lease,auditFailure:auditError,preferencesCleared:mode != "pref_sync",event:{stage,code in
                events.append(["stage":stage,"code":code])
                if auditError == nil {NativeDiagnostics.record(in:plan.auditState,phase:"uninstall_"+stage,code:code,backendPID:nil,generation:"00000000-0000-0000-0000-000000000000")}
            })
            if mode == "blocked" {check(chmod(hosts.path,0o700) == 0,"restore own directory")}
            if mode == "audit" {check(chmod(logs.path,0o700) == 0,"restore own audit directory")}
            if auditError == nil {
                let lines=try String(contentsOf:plan.auditState.appendingPathComponent("diagnostics/native-events.jsonl"),encoding:.utf8).split(separator:"\n")
                let rows=try lines.map {try JSONSerialization.jsonObject(with:Data($0.utf8)) as! [String:Any]}
                check(rows.count == events.count,"each stage event physically persisted")
                check(rows.allSatisfy {Set($0.keys).isSubset(of:Set(["at","phase","code","build","native_pid","generation"]))},"metadata-only diagnostic fields")
                check(rows.last?["code"] as? String == (report.complete ? "COMPLETED" : "PARTIAL"),"terminal log reason")
            }
            let appPresent=fm.fileExists(atPath:app.path),dataPresent=fm.fileExists(atPath:state.path)
            if mode == "backend" || mode == "login" {check(appPresent && !report.complete,"App prerequisites remain hard")}
            else {check(!appPresent,"App removed despite unrelated failure")}
            if ["keep","legacy_keep"].contains(mode) {check(dataPresent && fm.fileExists(atPath:prefs.path),"keep settings/history/preferences");check(report.complete,"keep complete")}
            else if mode != "backend" {check(!dataPresent && !fm.fileExists(atPath:prefs.path),"delete actual data/prefs");for name in caches where !(mode == "symlink" && name == caches[0]) {check(!fm.fileExists(atPath:home.appendingPathComponent(name).path),"delete own cache")}}
            if mode == "audit" {check(!report.complete && report.items.contains {$0.stage == "audit" && $0.code == "ACCESS_DENIED"},"audit failure does not block deletion")}
            if mode == "pref_sync" {check(!report.complete && report.items.contains {$0.code == "PREFERENCES_SYNC_FAILED"},"preferences failure does not block other deletion")}
            if mode == "symlink" {check(!report.complete && report.items.contains {$0.code == "UNSAFE_PATH"},"unsafe path retained without touching foreign target")}
            if mode == "blocked" {check(!report.complete && report.items.contains {$0.code == "ACCESS_DENIED"},"real permission denied classified; other cleanup continued")}
            if ["foreign","foreign_body"].contains(mode) {check(fm.fileExists(atPath:skill.path),"foreign skill retained");check(report.items.contains {$0.stage == "skill" && $0.code == "FOREIGN_RETAINED"},"foreign receipt")}
            else if mode == "skill_symlink" {check(fm.fileExists(atPath:skill.path) && (try? fm.destinationOfSymbolicLink(atPath:skill.path)) == foreign.path,"unsafe skill symlink retained");check(report.items.contains {$0.stage == "skill" && $0.code == "UNSAFE_PATH"},"unsafe skill receipt")}
            else if mode != "backend" {check(!fm.fileExists(atPath:skill.path),"marked skill removed in either mode")}
            if ["legacy_keep","legacy_delete"].contains(mode) {check(!fm.fileExists(atPath:skill.path),"unmarked legacy setup skill removed in either mode");check(report.items.contains {$0.stage == "skill" && $0.code == "REMOVED"},"legacy setup skill receipt")}
            check(fm.fileExists(atPath:foreign.path) && fm.fileExists(atPath:foreignBackup.path),"foreign personal and backup retained")
            let removals=events.filter {$0["code"] == "REMOVED"}
            if !appPresent {check(removals.last?["stage"] == "app","App final destructive product target")}
            check(!fm.fileExists(atPath:support.appendingPathComponent("upgrades/install.lock").path),"own lock released")
            receipts.append(["mode":mode,"complete":report.complete,"app_present":appPresent,"data_present":dataPresent,"events":events,"only_disposable_home":true,"physical_stage_log_verified":auditError == nil,"real_installer_skill":installedSkill,"real_app_copy":["keep","delete"].contains(mode) && ProcessInfo.processInfo.environment["CHATHAND_UNINSTALL_FIXTURE_APP"] != nil])
        }
        let domain="invalid.chathand.uninstall."+UUID().uuidString
        let defaults=UserDefaults(suiteName:domain)!
        defaults.setPersistentDomain(["fixture":"synthetic"],forName:domain);_ = defaults.synchronize()
        check(ChatHandUninstallPlan.clearPreferences(defaults,domain:domain),"isolated domain synchronize")
        check(defaults.persistentDomain(forName:domain)?.isEmpty != false,"only random fixture domain removed")
        let bytes=try JSONSerialization.data(withJSONObject:receipts,options:[.prettyPrinted,.sortedKeys]);FileHandle.standardOutput.write(bytes);print("\nPASS: actual staged filesystem removals, blocked Chrome continuation, prerequisites and foreign ownership")
    }
}
