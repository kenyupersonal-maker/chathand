import Cocoa
import Foundation
import Security
import Darwin

@_silgen_name("csops") private func instance_csops(_ pid: Int32, _ operation: UInt32, _ address: UnsafeMutableRawPointer?, _ size: Int) -> Int32

/// Product-instance authority is a stable signature plus exact kernel identity.
/// Scope is per-user in production and confined to one verified private test root.
enum InstanceLifecycle {
    struct Failure: Error { let code: String }
    struct Identity: Equatable { let pid: Int32; let path: String; let seconds: UInt64; let micros: UInt64 }
    struct Running { let identity: Identity; let app: URL; let build: Int }
    struct Scope {
        let root: String?
        func permits(_ path: String) -> Bool { root.map { path.hasPrefix($0 + "/") } ?? true }
        static func validated(environment e: [String:String], state: URL, app: URL, beforeMigration: Bool = false) throws -> Scope {
            let flagged=e.keys.contains{$0.hasPrefix("CHATHAND_REHEARSAL_")}
            guard flagged else {
                guard e["CHATHAND_STATE_DIR"] == nil && e["KEN_BRIDGE_STATE_DIR"] == nil else { throw Failure(code:"INSTANCE_ISOLATION_REQUIRED") }
                return Scope(root:nil)
            }
            guard let root=e["CHATHAND_REHEARSAL_ROOT"],physical(root)==root,
                  root.hasPrefix("/private/tmp/chathand-1060-rehearsal-"),let home=e["CHATHAND_REHEARSAL_HOME"],
                  [state.path,app.path,home].allSatisfy({$0.hasPrefix(root+"/") && (physical($0)==$0 || beforeMigration && $0==state.path && missingPhysicalPath($0))}),
                  e["CHATHAND_STATE_DIR"]==state.path else{throw Failure(code:"INSTANCE_ISOLATION_REQUIRED")}
            for path in [root,home,state.path] {
                if beforeMigration && path==state.path && missingPhysicalPath(path) { continue }
                var st=stat();guard lstat(path,&st)==0,st.st_mode & mode_t(S_IFMT)==mode_t(S_IFDIR),st.st_uid==getuid(),st.st_mode & 0o077==0 else{throw Failure(code:"INSTANCE_ISOLATION_REQUIRED")}
            }
            let marker=root+"/.rehearsal-root.json";var st=stat()
            guard lstat(marker,&st)==0,st.st_mode & mode_t(S_IFMT)==mode_t(S_IFREG),st.st_uid==getuid(),st.st_nlink==1,st.st_mode & 0o077==0,st.st_size<=4096,
                  let data=try? Data(contentsOf:URL(fileURLWithPath:marker)),let value=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],value["format"] as? Int==1,value["purpose"] as? String=="1060 isolated rehearsal" else{throw Failure(code:"INSTANCE_ISOLATION_REQUIRED")}
            return Scope(root:root)
        }
    }
    private final class WeakLease { weak var value: Lease?; init(_ value: Lease) { self.value=value } }
    private static let leaseRegistryLock=NSLock()
    private static var heldLeases=[WeakLease]()
    private static var processIsQuitting=false
    final class Lease {
        let descriptor: Int32
        fileprivate var owner: Identity?
        fileprivate var ownerQuitting=false
        init(_ descriptor: Int32) {
            self.descriptor=descriptor
            InstanceLifecycle.leaseRegistryLock.lock();defer{InstanceLifecycle.leaseRegistryLock.unlock()}
            InstanceLifecycle.heldLeases.removeAll{$0.value==nil}
            InstanceLifecycle.heldLeases.append(WeakLease(self))
        }
        deinit { _=flock(descriptor,LOCK_UN);Darwin.close(descriptor) }
    }
    struct OwnerRecord { let pid:Int32;let seconds:UInt64;let micros:UInt64;let quitting:Bool }
    /// Preserve the legacy identity fields. Only the holder writes its locked fd.
    private static func writeOwner(_ lease:Lease,_ own:Identity,quitting:Bool) throws {
        var value:[String:Any]=["pid":Int(own.pid),"seconds":own.seconds,"micros":own.micros]
        if quitting {value["quitting"]=true}
        let bytes=try JSONSerialization.data(withJSONObject:value)
        guard ftruncate(lease.descriptor,0)==0,lseek(lease.descriptor,0,SEEK_SET)>=0 else{throw Failure(code:"INSTANCE_LOCK_UNSAFE")}
        let written=bytes.withUnsafeBytes{Darwin.write(lease.descriptor,$0.baseAddress!,$0.count)}
        guard written==bytes.count else{throw Failure(code:"INSTANCE_LOCK_UNSAFE")}
        lease.owner=own;lease.ownerQuitting=quitting
    }
    private static func recordOwner(_ lease:Lease,_ own:Identity) throws {
        leaseRegistryLock.lock();defer{leaseRegistryLock.unlock()}
        try writeOwner(lease,own,quitting:processIsQuitting)
    }
    /// Includes startup leases held on the worker before the main-queue handoff.
    @discardableResult static func markOwnedLeasesQuitting() throws -> Int {
        leaseRegistryLock.lock();defer{leaseRegistryLock.unlock()}
        processIsQuitting=true
        var marked=0,failure:Error?
        for entry in heldLeases {if let lease=entry.value,let own=lease.owner,!lease.ownerQuitting {
            do {try writeOwner(lease,own,quitting:true);marked += 1}catch{failure=error}
        }}
        if let failure {throw failure}
        return marked
    }
    static func readOwner(state:URL) -> OwnerRecord? {
        let fd=Darwin.open(state.appendingPathComponent("native-instance.lock").path,O_RDONLY|O_NOFOLLOW|O_CLOEXEC)
        guard fd>=0 else{return nil};defer{Darwin.close(fd)}
        var st=stat();guard fstat(fd,&st)==0,st.st_mode & mode_t(S_IFMT)==mode_t(S_IFREG),st.st_uid==getuid(),st.st_nlink==1,st.st_mode & 0o077==0,st.st_size>0,st.st_size<1024 else{return nil}
        var bytes=[UInt8](repeating:0,count:1024);let count=Darwin.read(fd,&bytes,bytes.count)
        guard count==Int(st.st_size),let object=(try? JSONSerialization.jsonObject(with:Data(bytes.prefix(count)))) as? [String:Any] else{return nil}
        func integer(_ key:String)->UInt64? {
            guard let number=object[key] as? NSNumber,CFGetTypeID(number) != CFBooleanGetTypeID() else{return nil}
            let text=number.stringValue;guard !text.isEmpty,text.allSatisfy({$0>="0" && $0<="9"}) else{return nil};return UInt64(text)
        }
        guard let pid=integer("pid"),pid>1,pid<=UInt64(Int32.max),let seconds=integer("seconds"),let micros=integer("micros"),micros<1_000_000 else{return nil}
        let flag=object["quitting"] as? NSNumber
        return OwnerRecord(pid:Int32(pid),seconds:seconds,micros:micros,quitting:flag.map{CFGetTypeID($0)==CFBooleanGetTypeID() && $0.boolValue} ?? false)
    }
    /// A zombie may have no executable path while its kernel identity is alive.
    /// Wait for ESRCH; an unavailable path never grants another owner authority.
    static func waitForQuittingOwner(_ owner:OwnerRecord,timeout:TimeInterval) throws -> Bool {
        let deadline=ProcessInfo.processInfo.systemUptime+timeout
        repeat {
            guard try alive(owner.pid) else{return true}
            var info=proc_bsdinfo()
            guard proc_pidinfo(owner.pid,PROC_PIDTBSDINFO,1,&info,Int32(MemoryLayout.size(ofValue:info)))==MemoryLayout.size(ofValue:info) else {
                if !(try alive(owner.pid)){return true};throw Failure(code:"INSTANCE_PID_UNKNOWN")
            }
            guard info.pbi_uid==getuid(),info.pbi_start_tvsec==owner.seconds,info.pbi_start_tvusec==owner.micros else{throw Failure(code:"INSTANCE_IDENTITY_CHANGED")}
            RunLoop.current.run(until:Date().addingTimeInterval(0.025))
        } while ProcessInfo.processInfo.systemUptime<deadline
        return !(try alive(owner.pid))
    }
    /// Startup must not freeze a dying backend before reaching claim's wait.
    /// A free stale lock record is recoverable; a live unknown holder is not.
    @discardableResult static func waitForRecordedQuittingOwner(state:URL,timeout:TimeInterval,diagnostic:Diagnostic) throws -> Bool {
        guard let owner=readOwner(state:state),owner.quitting else{return false}
        let fd=Darwin.open(state.appendingPathComponent("native-instance.lock").path,O_RDWR|O_NOFOLLOW|O_CLOEXEC)
        guard fd>=0 else{throw Failure(code:"INSTANCE_LOCK_UNSAFE")};defer{Darwin.close(fd)}
        var st=stat();guard fstat(fd,&st)==0,st.st_mode & mode_t(S_IFMT)==mode_t(S_IFREG),st.st_uid==getuid(),st.st_nlink==1,st.st_mode & 0o077==0 else{throw Failure(code:"INSTANCE_LOCK_UNSAFE")}
        let free=flock(fd,LOCK_EX|LOCK_NB)==0
        if free {_=flock(fd,LOCK_UN)}else if errno != EWOULDBLOCK {throw Failure(code:"INSTANCE_LOCK_UNSAFE")}
        diagnostic("instance","INSTANCE_WAIT_QUITTING",owner.pid)
        do {guard try waitForQuittingOwner(owner,timeout:timeout) else{throw Failure(code:"INSTANCE_QUITTING_TIMEOUT")}}
        catch let error as Failure where error.code=="INSTANCE_IDENTITY_CHANGED" && free {diagnostic("instance","INSTANCE_STALE_QUIT_RECORD",owner.pid);return false}
        diagnostic("instance","INSTANCE_QUITTING_GONE",owner.pid);return true
    }
    static func physical(_ raw: String) -> String? { guard let p=realpath(raw,nil) else{return nil};defer{free(p)};return String(cString:p) }
    /// Validate a not-yet-created migration destination without creating it or
    /// accepting a dangling symlink. Existing-path validation stays unchanged.
    private static func missingPhysicalPath(_ raw: String) -> Bool {
        guard URL(fileURLWithPath:raw).standardizedFileURL.path==raw else{return false}
        var cursor=raw,st=stat()
        while lstat(cursor,&st) != 0 {
            guard errno==ENOENT else{return false}
            let parent=URL(fileURLWithPath:cursor).deletingLastPathComponent().path
            guard parent != cursor else{return false};cursor=parent
        }
        return cursor != raw && physical(cursor)==cursor && st.st_mode & mode_t(S_IFMT)==mode_t(S_IFDIR)
    }
    /// The first-start lease must not create data/: migration uses its absence
    /// to decide whether legacy data must be copied and atomically installed.
    static func startupCoordination(state: URL, source: URL, environment: [String:String]) throws -> (URL, Scope) {
        let scope=try Scope.validated(environment:environment,state:state,app:source,beforeMigration:true)
        guard physical(state.path)==state.path || missingPhysicalPath(state.path) else{throw Failure(code:"INSTANCE_LOCK_UNSAFE")}
        let parent=state.deletingLastPathComponent()
        try FileManager.default.createDirectory(at:parent,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        var st=stat()
        guard physical(parent.path)==parent.path,lstat(parent.path,&st)==0,st.st_uid==getuid(),st.st_mode & mode_t(S_IFMT)==mode_t(S_IFDIR),st.st_mode & 0o077==0 else{throw Failure(code:"INSTANCE_LOCK_UNSAFE")}
        let coordination=parent.appendingPathComponent(".native-startup",isDirectory:true)
        if lstat(coordination.path,&st)==0 {
            guard physical(coordination.path)==coordination.path,st.st_uid==getuid(),st.st_mode & mode_t(S_IFMT)==mode_t(S_IFDIR),st.st_mode & 0o077==0 else{throw Failure(code:"INSTANCE_LOCK_UNSAFE")}
        } else {
            guard errno==ENOENT else{throw Failure(code:"INSTANCE_LOCK_UNSAFE")}
            do {try FileManager.default.createDirectory(at:coordination,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])} catch let error as NSError {
                // Another first launch may have just created the same gate.
                guard error.domain==NSCocoaErrorDomain && error.code==NSFileWriteFileExistsError || error.domain==NSPOSIXErrorDomain && error.code==Int(EEXIST) else{throw error}
            }
        }
        guard physical(coordination.path)==coordination.path,lstat(coordination.path,&st)==0,st.st_uid==getuid(),st.st_mode & mode_t(S_IFMT)==mode_t(S_IFDIR),st.st_mode & 0o077==0 else{throw Failure(code:"INSTANCE_LOCK_UNSAFE")}
        return (coordination,scope)
    }
    static func alive(_ pid: Int32) throws -> Bool {if kill(pid,0)==0{return true};if errno==ESRCH{return false};throw Failure(code:"INSTANCE_PID_UNKNOWN")}
    static func identity(_ pid: Int32) throws -> Identity? {
        guard try alive(pid) else{return nil}
        var path=[CChar](repeating:0,count:4*Int(MAXPATHLEN)),info=proc_bsdinfo()
        guard proc_pidpath(pid,&path,UInt32(path.count))>0,proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,Int32(MemoryLayout.size(ofValue:info)))==MemoryLayout.size(ofValue:info),info.pbi_uid==getuid() else{throw Failure(code:"INSTANCE_PID_UNKNOWN")}
        return Identity(pid:pid,path:String(cString:path),seconds:info.pbi_start_tvsec,micros:info.pbi_start_tvusec)
    }
    static func signatureRequirement(_ app: URL) throws -> SecRequirement {
        var code:SecStaticCode?,requirement:SecRequirement?
        guard SecStaticCodeCreateWithPath(app as CFURL,[],&code)==errSecSuccess,let code,
              SecStaticCodeCheckValidity(code,SecCSFlags(rawValue:kSecCSStrictValidate),nil)==errSecSuccess,
              SecCodeCopyDesignatedRequirement(code,[],&requirement)==errSecSuccess,let requirement else{throw Failure(code:"INSTANCE_SIGNATURE_UNKNOWN")}
        return requirement
    }
    static func trusted(_ app: URL, requirement: SecRequirement) -> Bool {
        guard Bundle(url:app)?.bundleIdentifier=="com.kenyu.chathand" else{return false}
        var code:SecStaticCode?
        return SecStaticCodeCreateWithPath(app as CFURL,[],&code)==errSecSuccess && code.map{SecStaticCodeCheckValidity($0,SecCSFlags(rawValue:kSecCSStrictValidate),requirement)==errSecSuccess}==true
    }
    static func trustedPID(_ pid: Int32, requirement: SecRequirement) -> Bool {
        var guest: SecCode?
        return SecCodeCopyGuestWithAttributes(nil,[kSecGuestAttributePid:pid] as CFDictionary,[],&guest)==errSecSuccess && guest.map{SecCodeCheckValidity($0,[],requirement)==errSecSuccess}==true
    }
    /// Only the live image's hash can bind an on-disk build number to this PID.
    static func liveBuild(pid: Int32, app: URL, requirement: SecRequirement) -> Int? {
        var guest: SecCode?, disk: SecStaticCode?, diskInfo: CFDictionary?
        var liveHash=[UInt8](repeating:0,count:20)
        guard SecCodeCopyGuestWithAttributes(nil,[kSecGuestAttributePid:pid] as CFDictionary,[],&guest)==errSecSuccess,let guest,
              SecCodeCheckValidity(guest,[],requirement)==errSecSuccess,
              SecStaticCodeCreateWithPath(app as CFURL,[],&disk)==errSecSuccess,let disk,
              instance_csops(pid,5,&liveHash,liveHash.count)==0,
              SecCodeCopySigningInformation(disk,SecCSFlags(rawValue:kSecCSSigningInformation),&diskInfo)==errSecSuccess,
              let b=(diskInfo as? [String:Any])?[kSecCodeInfoUnique as String] as? Data,Data(liveHash)==b,
              let text=Bundle(url:app)?.object(forInfoDictionaryKey:"CFBundleVersion") as? String else{return nil}
        return Int(text)
    }
    static func appPath(in executable: String, marker: String) -> URL? {
        guard let range=executable.range(of:".app/Contents/"+marker) else{return nil}
        return URL(fileURLWithPath:String(executable[..<range.lowerBound])+".app")
    }
    static func instances(source: URL, scope: Scope, excluding: Int32 = getpid()) throws -> [Running] {
        let requirement=try signatureRequirement(source),count=proc_listallpids(nil,0)
        guard count>0 else{throw Failure(code:"INSTANCE_ENUMERATION_FAILED")}
        var pids=[Int32](repeating:0,count:Int(count)+1024);let actual=proc_listallpids(&pids,Int32(pids.count*MemoryLayout<Int32>.size))
        guard actual>=0,actual<pids.count else{throw Failure(code:"INSTANCE_ENUMERATION_FAILED")}
        var results:[Running]=[],cache:[String:Bool]=[:]
        for pid in pids.prefix(Int(actual)) where pid>1 && pid != excluding {
            var path=[CChar](repeating:0,count:4*Int(MAXPATHLEN));guard proc_pidpath(pid,&path,UInt32(path.count))>0 else{continue}
            let text=String(cString:path);guard scope.permits(text),let app=appPath(in:text,marker:"MacOS/") else{continue}
            let valid=cache[app.path] ?? trusted(app,requirement:requirement);cache[app.path]=valid;guard valid else{continue}
            guard let observed=try identity(pid) else{continue}
            guard trustedPID(pid,requirement:requirement) else{throw Failure(code:"INSTANCE_SIGNATURE_UNKNOWN")}
            let build=liveBuild(pid:pid,app:app,requirement:requirement) ?? -1
            results.append(Running(identity:observed,app:app,build:build))
        }
        return results
    }
    static func acquire(state: URL) throws -> Lease? {
        let fm=FileManager.default;try fm.createDirectory(at:state,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let file=state.appendingPathComponent("native-instance.lock"),fd=Darwin.open(file.path,O_RDWR|O_CREAT|O_NOFOLLOW|O_CLOEXEC,mode_t(0o600));guard fd>=0 else{throw Failure(code:"INSTANCE_LOCK_UNSAFE")}
        var st=stat();guard fstat(fd,&st)==0,st.st_mode & mode_t(S_IFMT)==mode_t(S_IFREG),st.st_uid==getuid(),st.st_nlink==1,st.st_mode & 0o077==0 else{Darwin.close(fd);throw Failure(code:"INSTANCE_LOCK_UNSAFE")}
        if flock(fd,LOCK_EX|LOCK_NB)==0{return Lease(fd)}
        let saved=errno;Darwin.close(fd);if saved==EWOULDBLOCK{return nil};throw Failure(code:"INSTANCE_LOCK_UNSAFE")
    }
    static func waitGone(_ observed: Identity, timeout: TimeInterval) throws -> Bool {
        let until=Date().addingTimeInterval(timeout)
        while Date()<until {
            do {
                guard let current=try identity(observed.pid) else{return true}
                guard current==observed else{throw Failure(code:"INSTANCE_IDENTITY_CHANGED")}
            } catch let failure as Failure where failure.code=="INSTANCE_PID_UNKNOWN" {
                // Exiting/zombie processes can lose proc_pidpath before kill(0)
                // reaches ESRCH. Keep waiting; unavailable never means gone.
                if !(try alive(observed.pid)){return true}
            }
            RunLoop.current.run(until:Date().addingTimeInterval(0.05))
        }
        return !(try alive(observed.pid))
    }
    static func stop(_ running: Running) throws {
        guard try identity(running.identity.pid)==running.identity else{throw Failure(code:"INSTANCE_IDENTITY_CHANGED")}
        DistributedNotificationCenter.default().postNotificationName(Notification.Name("com.kenyu.chathand.quit."+String(running.identity.pid)),object:nil,userInfo:nil,deliverImmediately:true)
        let terminate = { _=NSRunningApplication(processIdentifier:running.identity.pid)?.terminate() }
        if Thread.isMainThread { terminate() } else { DispatchQueue.main.sync(execute:terminate) }
        if try waitGone(running.identity,timeout:4){return}
        guard try identity(running.identity.pid)==running.identity else{throw Failure(code:"INSTANCE_IDENTITY_CHANGED")}
        guard kill(running.identity.pid,SIGTERM)==0||errno==ESRCH else{throw Failure(code:"INSTANCE_STOP_DENIED")}
        guard try waitGone(running.identity,timeout:8) else{throw Failure(code:"INSTANCE_STOP_TIMEOUT")}
    }
    static func wake(_ running: Running, scope: Scope, activate: Bool = true) {
        if !Thread.isMainThread {DispatchQueue.main.async{wake(running,scope:scope,activate:activate)};return}
        DistributedNotificationCenter.default().postNotificationName(Notification.Name("com.kenyu.chathand.show."+String(running.identity.pid)),object:nil,userInfo:["activate":activate],deliverImmediately:true)
        if activate {_=NSRunningApplication(processIdentifier:running.identity.pid)?.activate(options:[.activateAllWindows])}
        guard scope.root == nil else{return} // Never let a rehearsal wake launch outside its sandbox gateway.
        let config=NSWorkspace.OpenConfiguration();config.createsNewApplicationInstance=false;config.activates=activate;config.promptsUserIfNeeded=false
        NSWorkspace.shared.openApplication(at:running.app,configuration:config){_,_ in}
    }
    typealias Diagnostic=(String,String,Int32)->Void
    /// The lease is held for the whole native lifetime, serializing simultaneous starts.
    static func claim(state: URL, source: URL, build: Int, scope: Scope, activateExisting: Bool = true, diagnostic: Diagnostic) throws -> Lease? {
        var lease:Lease?
        let until=Date().addingTimeInterval(3)
        let quittingDeadline=ProcessInfo.processInfo.systemUptime+15
        while true {
            // Owning the flock distinguishes a stale record from a live owner.
            // Still wait for a matching old PID after willTerminate releases it.
            lease=try acquire(state:state)
            if let owner=readOwner(state:state),owner.quitting,owner.pid != getpid() {
                diagnostic("instance","INSTANCE_WAIT_QUITTING",owner.pid)
                do {
                    guard try waitForQuittingOwner(owner,timeout:max(0,quittingDeadline-ProcessInfo.processInfo.systemUptime)) else{throw Failure(code:"INSTANCE_QUITTING_TIMEOUT")}
                    diagnostic("instance","INSTANCE_QUITTING_GONE",owner.pid)
                } catch let error as Failure where error.code=="INSTANCE_IDENTITY_CHANGED" && lease != nil {
                    diagnostic("instance","INSTANCE_STALE_QUIT_RECORD",owner.pid)
                }
            }
            if lease != nil {break}
            if readOwner(state:state)?.quitting==true {continue}
            let running=try instances(source:source,scope:scope)
            if let record=readOwner(state:state),
               let owner=running.first(where:{$0.identity.pid==record.pid && $0.identity.seconds==record.seconds && $0.identity.micros==record.micros}) {
                // A quit can start between the first read and enumeration.
                if record.quitting {continue}
                if owner.build>=build {diagnostic("instance","INSTANCE_WAKE_EXISTING",owner.identity.pid);wake(owner,scope:scope,activate:activateExisting);return nil}
                diagnostic("instance",owner.build<0 ? "INSTANCE_RUNNING_BUILD_UNKNOWN":"INSTANCE_STOP_OLDER",owner.identity.pid)
                try stop(owner);diagnostic("instance","INSTANCE_OLD_GONE",owner.identity.pid)
            }
            if Date()>=until{throw Failure(code:"INSTANCE_LOCK_BUSY")}
            RunLoop.current.run(until:Date().addingTimeInterval(0.05))
        }
        guard let lease,let own=try identity(getpid()) else{throw Failure(code:"INSTANCE_LOCK_UNSAFE")}
        try recordOwner(lease,own)
        let running=try instances(source:source,scope:scope)
        for old in running {
            // Same-image contenders cannot own this lease and will wake us and exit.
            if old.build==build && old.build>=1064{continue}
            if old.build>=build {diagnostic("instance","INSTANCE_WAKE_EXISTING",old.identity.pid);wake(old,scope:scope,activate:activateExisting);return nil}
            diagnostic("instance",old.build<0 ? "INSTANCE_RUNNING_BUILD_UNKNOWN":"INSTANCE_STOP_OLDER",old.identity.pid)
            try stop(old);diagnostic("instance","INSTANCE_OLD_GONE",old.identity.pid)
        }
        diagnostic("instance","INSTANCE_CLAIMED",getpid());return lease
    }

    static func runtime(state: URL) -> [String:Any]? {
        let file=state.appendingPathComponent("runtime.json");var st=stat()
        guard lstat(file.path,&st)==0,st.st_mode & mode_t(S_IFMT)==mode_t(S_IFREG),st.st_uid==getuid(),st.st_nlink==1,st.st_mode & 0o077==0,st.st_size<=65536,let data=try? Data(contentsOf:file) else{return nil}
        return (try? JSONSerialization.jsonObject(with:data)) as? [String:Any]
    }
    struct Backend {
        let identity:Identity;let app:URL;let origin:String;let token:String;let requirement:SecRequirement
    }
    /// Freeze a validated PID before an older owner's shutdown can remove runtime.json.
    static func captureBackend(state: URL, source: URL, scope: Scope, record: [String:Any]? = nil, exitingOwnerObserved:Bool = false) throws -> Backend? {
        guard let runtime=record ?? runtime(state:state) else{return nil}
        guard let pid=runtime["pid"] as? Int,pid>1,pid<=Int(Int32.max) else{throw Failure(code:"ORPHAN_IDENTITY_UNKNOWN")}
        let observed:Identity
        let deadline=ProcessInfo.processInfo.systemUptime+(exitingOwnerObserved ? 3:0)
        while true {
            do {guard let current=try identity(Int32(pid)) else{return nil};observed=current;break}
            catch let error as Failure where error.code=="INSTANCE_PID_UNKNOWN" && exitingOwnerObserved && ProcessInfo.processInfo.systemUptime<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.025))}
        }
        let requirement=try signatureRequirement(source)
        guard scope.permits(observed.path),let app=appPath(in:observed.path,marker:"Resources/runtime/bin/"),trusted(app,requirement:requirement),["ChatHandNode","node"].contains(URL(fileURLWithPath:observed.path).lastPathComponent),
              let origin=runtime["ui_origin"] as? String,let u=URLComponents(string:origin),u.scheme=="http",u.host=="127.0.0.1",u.port != nil,u.user==nil,u.password==nil,u.path.isEmpty,u.query==nil,u.fragment==nil,
              let token=runtime["admin_token"] as? String,token.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil else{throw Failure(code:"ORPHAN_IDENTITY_UNKNOWN")}
        let backendRequirement=try signatureRequirement(URL(fileURLWithPath:observed.path))
        guard trustedPID(observed.pid,requirement:backendRequirement) else{throw Failure(code:"ORPHAN_IDENTITY_UNKNOWN")}
        return Backend(identity:observed,app:app,origin:origin,token:token,requirement:backendRequirement)
    }
    static func shutdownOrphan(state: URL, source: URL, scope: Scope, prior: Backend? = nil, diagnostic: Diagnostic) throws {
        guard let backend=try prior ?? captureBackend(state:state,source:source,scope:scope) else{return}
        let observed=backend.identity,app=backend.app,origin=backend.origin,token=backend.token
        guard let current=try identity(observed.pid) else{return}
        let requirement=try signatureRequirement(source)
        guard current==observed,scope.permits(observed.path),trusted(app,requirement:requirement),trustedPID(observed.pid,requirement:backend.requirement) else{throw Failure(code:"ORPHAN_IDENTITY_UNKNOWN")}
        // A current owner's native process must never be displaced as an orphan.
        let waitForContenders=Date().addingTimeInterval(2)
        var others=try instances(source:source,scope:scope)
        while !others.isEmpty && Date()<waitForContenders {
            RunLoop.current.run(until:Date().addingTimeInterval(0.05))
            others=try instances(source:source,scope:scope)
        }
        guard others.isEmpty else{throw Failure(code:"ORPHAN_OWNER_STILL_RUNNING")}
        diagnostic("instance","ORPHAN_SHUTDOWN",observed.pid)
        var missing=stat()
        let closedAfterOwner=prior != nil && lstat(state.appendingPathComponent("runtime.json").path,&missing) != 0 && errno==ENOENT && closedListener(origin)
        if closedAfterOwner{diagnostic("instance","ORPHAN_ALREADY_CLOSED",observed.pid)}
        var shutdownAcknowledged=false
        let semaphore=DispatchSemaphore(value:0);var request=URLRequest(url:URL(string:origin+"/api/shutdown")!);request.httpMethod="POST";request.httpBody=Data("{}".utf8);request.setValue("Bearer "+token,forHTTPHeaderField:"Authorization");request.setValue("application/json",forHTTPHeaderField:"Content-Type");request.timeoutInterval=4
        URLSession.shared.dataTask(with:request){_,response,error in shutdownAcknowledged=error==nil && (response as? HTTPURLResponse)?.statusCode==200;semaphore.signal()}.resume();_=semaphore.wait(timeout:.now()+5)
        if !(try waitGone(observed,timeout:8)) {
            diagnostic("instance","ORPHAN_GRACEFUL_TIMEOUT",observed.pid)
            diagnostic("instance","ORPHAN_TERM_FALLBACK",observed.pid)
            guard try identity(observed.pid)==observed else{throw Failure(code:"INSTANCE_IDENTITY_CHANGED")}
            guard kill(observed.pid,SIGTERM)==0||errno==ESRCH else{throw Failure(code:"ORPHAN_STOP_DENIED")}
            if !(try waitGone(observed,timeout:8)) {
                diagnostic("instance","ORPHAN_TERM_TIMEOUT",observed.pid)
                var st=stat()
                // Only an acknowledged, closed legacy service may leave a residual PID.
                guard shutdownAcknowledged || closedAfterOwner,lstat(state.appendingPathComponent("runtime.json").path,&st) != 0,errno==ENOENT,
                      try identity(observed.pid)==observed,try instances(source:source,scope:scope).isEmpty,
                      trusted(app,requirement:requirement),trustedPID(observed.pid,requirement:backend.requirement),
                      closedListener(origin) else{throw Failure(code:"ORPHAN_STOP_TIMEOUT")}
                diagnostic("instance","ORPHAN_FORCE_KILL",observed.pid)
                guard kill(observed.pid,SIGKILL)==0||errno==ESRCH else{throw Failure(code:"ORPHAN_STOP_DENIED")}
                guard try waitGone(observed,timeout:8) else{throw Failure(code:"ORPHAN_STOP_TIMEOUT")}
            }
        }
        diagnostic("instance","ORPHAN_GONE",observed.pid)
    }
    private static func closedListener(_ origin: String) -> Bool {
        let done=DispatchSemaphore(value:0);var closed=false
        var request=URLRequest(url:URL(string:origin+"/api/state")!);request.timeoutInterval=1
        URLSession.shared.dataTask(with:request){_,response,error in
            let code=(error as NSError?)?.code
            closed=response==nil && code==NSURLErrorCannotConnectToHost
            done.signal()
        }.resume()
        _=done.wait(timeout:.now()+2);return closed
    }
    static func relaunchTarget(environment: [String:String], scope: Scope) throws -> URL {
        let path:String
        if let root=scope.root {
            guard let raw=environment["CHATHAND_REHEARSAL_RELAUNCH_TARGET"],raw.hasPrefix(root+"/"),physical(raw)==raw else{throw Failure(code:"RELAUNCH_TARGET_INVALID")};path=raw
        } else {guard environment["CHATHAND_REHEARSAL_RELAUNCH_TARGET"]==nil else{throw Failure(code:"RELAUNCH_TARGET_INVALID")};path="/Applications/ChatHand.app"}
        let url=URL(fileURLWithPath:path);guard Bundle(url:url)?.bundleIdentifier=="com.kenyu.chathand" else{throw Failure(code:"RELAUNCH_TARGET_MISSING")};return url
    }
    static func record(state: URL, phase: String, code: String, build: Int, pid: Int32) {
        guard ["instance","relaunch","migration"].contains(phase),code.range(of:"^[A-Z][A-Z0-9_]{0,63}$",options:.regularExpression) != nil else{return}
        let dir=state.appendingPathComponent("diagnostics");do{try FileManager.default.createDirectory(at:dir,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])}catch{return}
        var st=stat();guard lstat(dir.path,&st)==0,st.st_mode & mode_t(S_IFMT)==mode_t(S_IFDIR),st.st_uid==getuid(),st.st_mode & 0o077==0 else{return}
        let fd=Darwin.open(dir.appendingPathComponent("native-events.jsonl").path,O_WRONLY|O_CREAT|O_APPEND|O_NOFOLLOW|O_CLOEXEC,mode_t(0o600));guard fd>=0 else{return};defer{Darwin.close(fd)}
        guard fstat(fd,&st)==0,st.st_mode & mode_t(S_IFMT)==mode_t(S_IFREG),st.st_uid==getuid(),st.st_nlink==1,st.st_mode & 0o077==0 else{return}
        guard var bytes=try? JSONSerialization.data(withJSONObject:["at":ISO8601DateFormatter().string(from:Date()),"phase":phase,"code":code,"build":build,"pid":Int(pid)]) else{return};bytes.append(10);bytes.withUnsafeBytes{if let p=$0.baseAddress{_=Darwin.write(fd,p,$0.count)}}
    }
}
