import AppKit
import Foundation
import Darwin

private enum ButtonLocalText {
    static func text(_ key: String) -> String { key }
}
private enum ButtonLifecycle {
    typealias Lease=InstanceLifecycle.Lease
    typealias Scope=InstanceLifecycle.Scope
    typealias Failure=InstanceLifecycle.Failure
    typealias Backend=InstanceLifecycle.Backend
    struct Running { let identity: InstanceLifecycle.Identity }
    static var existing: Running?
    static var woken: Int32?
    static func startupCoordination(state: URL, source: URL, environment: [String:String]) throws -> (URL,Scope) {
        try InstanceLifecycle.startupCoordination(state:state,source:source,environment:[:])
    }
    static func existingForClearRetry(state: URL, coordination: URL, source: URL, scope: Scope) throws -> Running? { existing }
    static func wake(_ running: Running, scope: Scope) { woken=running.identity.pid }
    static func record(state: URL, phase: String, code: String, build: Int, pid: Int32) {}
    static func acquire(state: URL) throws -> Lease? { try InstanceLifecycle.acquire(state:state) }
    static func physical(_ path: String) -> String? { InstanceLifecycle.physical(path) }
    static func clearStaleBackendRecords(state: URL, prior: Backend?) throws -> Bool {
        try InstanceLifecycle.clearStaleBackendRecords(state:state,prior:prior)
    }
}
private final class ButtonApp {
    let stateURL: URL
    var process: Process?,startupLease: ButtonLifecycle.Lease?,instanceLease: ButtonLifecycle.Lease?,priorBackend: ButtonLifecycle.Backend?
    var shuttingDown=false,migrationQuitPending=false,backendRecovery=BackendRecoveryPolicy()
    var finished=false,retries=0,diagnostics=[String]()

    init(state: URL) { stateURL=state }
    func finishQuit() { finished=true }
    func beginStartup() { retries += 1 }
    func startService() throws { retries += 1 }
    func nativeRecord(_ phase: String, _ code: String) { diagnostics.append(code) }
    func clickClearRetry(_ alert: NSAlert, actions: [StartupFailureAction]) -> NSApplication.ModalResponse {
        let index=actions.firstIndex(of:.clearRetry)!
        precondition(alert.buttons[index].title=="native.startupFailure.action.clearRetry")
        return NSApplication.ModalResponse(rawValue:NSApplication.ModalResponse.alertFirstButtonReturn.rawValue+index)
    }
    // ACTUAL_CLEAR_RETRY_CALLBACKS
}

@main struct StaleBackendRecordChecks {
    static func require(_ condition: Bool, _ message: String) {
        precondition(condition,message)
    }
    static func expect(_ code: String, _ run: () throws -> Void) throws {
        do { try run() }
        catch let failure as InstanceLifecycle.Failure {
            require(failure.code==code,"expected \(code), received \(failure.code)")
            return
        }
        preconditionFailure("expected \(code)")
    }
    static func write(_ record: [String:Any], to file: URL, date: Date? = nil) throws {
        let bytes=try JSONSerialization.data(withJSONObject:record,options:.sortedKeys)
        require(FileManager.default.createFile(atPath:file.path,contents:bytes,attributes:[.posixPermissions:0o600]),"fixture write")
        if let date { try FileManager.default.setAttributes([.modificationDate:date],ofItemAtPath:file.path) }
    }
    static func files(_ state: URL) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath:state.path).sorted()
    }
    static func checkClearRetryButton(_ root: URL, unrelatedPID: Int32) throws {
        _=NSApplication.shared
        let state=root.appendingPathComponent("button-state")
        try FileManager.default.createDirectory(at:state,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
        let runtime=state.appendingPathComponent("runtime.json"),lock=state.appendingPathComponent("app.lock")
        try write(["pid":Int(unrelatedPID)],to:runtime)
        try write(["pid":Int(unrelatedPID)],to:lock)
        let runtimeBytes=try Data(contentsOf:runtime),lockBytes=try Data(contentsOf:lock)
        ButtonLifecycle.existing=ButtonLifecycle.Running(identity:try InstanceLifecycle.identity(getpid())!)
        let existing=ButtonApp(state:state)
        existing.showStartupFailure("STARTUP_ALREADY_RUNNING")
        require(ButtonLifecycle.woken==getpid() && existing.finished && existing.retries==0,"the button wakes a confirmed owner and exits")
        require(try Data(contentsOf:runtime)==runtimeBytes && Data(contentsOf:lock)==lockBytes,"waking the owner leaves both records unchanged")
        require(try files(state)==["app.lock","runtime.json"],"waking the owner performs no archival")

        ButtonLifecycle.existing=nil
        let retry=ButtonApp(state:state)
        retry.showStartupFailure("ORPHAN_IDENTITY_UNKNOWN")
        require(retry.retries==1 && !retry.finished && retry.diagnostics==["STALE_RUNTIME_RECORD"],"the button archives and invokes startup once")
        let archive=try files(state).filter { $0.contains(".stale-") }
        require(archive.count==2 && archive[0].hasPrefix("app.lock.stale-") && archive[1].hasPrefix("runtime.json.stale-"),"both records archived")
        require(try Data(contentsOf:state.appendingPathComponent(archive[0]))==lockBytes &&
                Data(contentsOf:state.appendingPathComponent(archive[1]))==runtimeBytes,"the button preserves the original file contents")
        print("PASS: clear retry button callbacks preserve an existing owner's files or archive before invoking startup")
    }
    static func main() throws {
        let state=URL(fileURLWithPath:CommandLine.arguments[1]),scope=InstanceLifecycle.Scope(root:nil)
        let runtime=state.appendingPathComponent("runtime.json"),lock=state.appendingPathComponent("app.lock")
        let livePID=getpid(),absentPID=Int32.max
        let start=try InstanceLifecycle.processStart(livePID)!
        let boot=try InstanceLifecycle.bootTime()
        require(boot.seconds<=Int64(start.seconds),"startup follows boot")
        require(try InstanceLifecycle.processStart(absentPID)==nil,"absent PID is proven")
        let beforeBoot=Date(timeIntervalSince1970:Double(boot.seconds)-5)
        let live:[String:Any]=["pid":Int(livePID),"start_seconds":start.seconds,"start_microseconds":start.microseconds]
        var reused=live
        reused["start_microseconds"]=(start.microseconds+1)%1_000_000
        require(InstanceLifecycle.runtimeMatchesChild(live,pid:livePID,start:start),"the actual child start matches")
        require(!InstanceLifecycle.runtimeMatchesChild(reused,pid:livePID,start:start),"PID alone cannot match the child")
        require(!InstanceLifecycle.runtimeMatchesChild(["pid":Int(livePID)],pid:livePID,start:start),"a legacy record cannot match the newly started child")
        func capture() throws -> InstanceLifecycle.Backend? {
            try InstanceLifecycle.captureBackend(state:state,source:state,scope:scope)
        }

        try write(["pid":Int(absentPID)],to:runtime)
        require(try capture()==nil,"an absent PID is stale")
        try write(["pid":Int(absentPID),"start_seconds":"broken"],to:runtime)
        require(try capture()==nil,"an absent PID proves staleness independently of malformed timestamp fields")
        try write(reused,to:runtime)
        require(try capture()==nil,"a microsecond mismatch is stale")
        try write(["pid":Int(livePID)],to:runtime,date:beforeBoot)
        require(try capture()==nil,"a legacy record from before boot is stale")
        try write(live,to:runtime,date:beforeBoot)
        require(try capture()==nil,"a newer-format record from before boot is stale")
        try write(live,to:runtime)
        try expect("INSTANCE_SIGNATURE_UNKNOWN") { _=try capture() }
        try write(["pid":Int(livePID)],to:runtime)
        try expect("INSTANCE_SIGNATURE_UNKNOWN") { _=try capture() }
        try write(["pid":Int(livePID),"start_seconds":start.seconds],to:runtime,date:beforeBoot)
        require(try capture()==nil,"a preboot record is stale even with malformed timestamp fields")
        try write(["pid":Int(livePID),"start_seconds":start.seconds],to:runtime)
        try expect("ORPHAN_IDENTITY_UNKNOWN") { _=try capture() }
        print("PASS: native capture requires kernel evidence before treating a record as stale")

        try write(reused,to:runtime)
        try write(live,to:lock,date:beforeBoot)
        try expect("STARTUP_ALREADY_RUNNING") { _=try InstanceLifecycle.clearStaleBackendRecords(state:state,prior:nil) }
        require(try files(state)==["app.lock","runtime.json"],"live lock preserves both files")
        try write(["pid":Int(livePID),"start_seconds":"broken"],to:lock)
        try expect("ORPHAN_IDENTITY_UNKNOWN") { _=try InstanceLifecycle.clearStaleBackendRecords(state:state,prior:nil) }
        require(try files(state)==["app.lock","runtime.json"],"unknown identity preserves both files")
        try write(["pid":Int(absentPID)],to:lock)
        let runtimeBytes=try Data(contentsOf:runtime),lockBytes=try Data(contentsOf:lock)
        var st=stat()
        require(lstat(runtime.path,&st)==0,"read stale runtime metadata")
        let device=UInt64(bitPattern:Int64(st.st_dev)),inode=st.st_ino
        let mtime=Int64(st.st_mtimespec.tv_sec)*1_000_000_000+Int64(st.st_mtimespec.tv_nsec)
        require(try InstanceLifecycle.clearStaleBackendRecords(state:state,prior:nil),"old records were archived")
        let backups=try files(state)
        require(backups.count==2 && backups[0].hasPrefix("app.lock.stale-") &&
                backups[1]=="runtime.json.stale-\(device)-\(inode)-\(mtime)","both records have deterministic archive names")
        require(try Data(contentsOf:state.appendingPathComponent(backups[0]))==lockBytes,"lock kept byte-for-byte")
        require(try Data(contentsOf:state.appendingPathComponent(backups[1]))==runtimeBytes,"runtime kept byte-for-byte")
        try write(live,to:runtime)
        require(try !InstanceLifecycle.archiveRecord(state:state,name:"runtime.json",device:device,inode:inode,mtimeNS:mtime),"a delayed contender cannot archive a new runtime")
        require(try Data(contentsOf:runtime) != runtimeBytes,"new runtime stays in place")

        let sleeper=Process()
        sleeper.executableURL=URL(fileURLWithPath:"/bin/sleep")
        sleeper.arguments=["30"]
        try sleeper.run()
        defer { if sleeper.isRunning { sleeper.terminate() };sleeper.waitUntilExit() }
        let sleepStart=try InstanceLifecycle.processStart(sleeper.processIdentifier)!
        try write(["pid":Int(sleeper.processIdentifier)],to:runtime)
        try write(["pid":Int(sleeper.processIdentifier)],to:lock)
        try expect("INSTANCE_SIGNATURE_UNKNOWN") { _=try capture() }
        require(try InstanceLifecycle.clearStaleBackendRecords(state:state,prior:nil),"manual clear can archive legacy records of a known unrelated executable")
        require(sleeper.isRunning,"manual clear leaves the unrelated process running")
        let sleepNow=try InstanceLifecycle.processStart(sleeper.processIdentifier)
        require(sleepNow?.seconds==sleepStart.seconds && sleepNow?.microseconds==sleepStart.microseconds,"unrelated process identity is unchanged")
        print("PASS: clear preserves live and unknown records and archives only proven stale records")
        try checkClearRetryButton(state,unrelatedPID:sleeper.processIdentifier)
        require(sleeper.isRunning,"the full button path also leaves the unrelated process running")
    }
}
