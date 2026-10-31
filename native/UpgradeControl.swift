import Cocoa
import Darwin
import CryptoKit

// This branch is opt-in and only accepts a fresh, private, canonical temporary
// rehearsal tree. The unchanged 1059 updater invokes this candidate helper for
// BOTH replacement and rollback. Ordinary NSWorkspace launches stay unchanged.
struct RehearsalIsolation {
 static let protocolVersion = 1
 static let fileManager = FileManager.default
 static let services = ["com.apple.cfprefsd.agent", "com.apple.cfprefsd.daemon", "com.apple.securityd", "com.apple.usernotifications.usernotificationservice", "com.apple.usernotifications.remotenotificationservice"]
 struct Invalid: Error { let code: String }
 static func reject(_ code: String) throws { throw Invalid(code: code) }
 static func physical(_ raw:String)->String? {
  guard let pointer=realpath(raw,nil) else{return nil};defer{free(pointer)};return String(cString:pointer)
 }
 static func canonical(_ raw: String) throws -> URL {
  guard raw.hasPrefix("/"), !raw.contains("\0"), !raw.contains("\n"), !raw.contains("\r") else { throw Invalid(code: "REHEARSAL_PATH_INVALID") }
  let value=URL(fileURLWithPath:raw)
  // Foundation normalizes /private/tmp back to /tmp on this macOS. POSIX
  // realpath is the same physical spelling used by the updater/Node guards.
  guard physical(raw) == raw, !raw.contains("//"), !value.pathComponents.contains("Applications") else { throw Invalid(code: "REHEARSAL_PATH_ALIAS") }
  return value
 }
 static func root(_ raw: String) throws -> URL {
  let value=try canonical(raw)
  let parents=["/private/tmp", NSTemporaryDirectory()].compactMap{physical($0)}
  guard parents.contains(where:{value.path.hasPrefix($0+"/")}), value.lastPathComponent.range(of:"^chathand-1060-rehearsal-[A-Za-z0-9_-]+$",options:.regularExpression) != nil else { throw Invalid(code:"REHEARSAL_ROOT_REQUIRED") }
  let a=try fileManager.attributesOfItem(atPath:value.path)
  guard a[.type] as? FileAttributeType == .typeDirectory, (a[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(), ((a[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o077 == 0 else { throw Invalid(code:"REHEARSAL_ROOT_NOT_PRIVATE") }
  let marker=try inside(value, value.appendingPathComponent(".rehearsal-root.json").path)
  guard let data=try JSONSerialization.jsonObject(with:Data(contentsOf:marker)) as? [String:Any], data["format"] as? Int == 1, data["purpose"] as? String == "1060 isolated rehearsal" else { throw Invalid(code:"REHEARSAL_ROOT_MARKER") }
  return value
 }
 static func inside(_ root: URL,_ raw: String) throws -> URL {
  let value=try canonical(raw)
  guard value.path.hasPrefix(root.path+"/") else { throw Invalid(code:"REHEARSAL_PATH_OUTSIDE_ROOT") }
  var cursor=root
  for part in value.path.dropFirst(root.path.count+1).split(separator:"/") {
   cursor.appendPathComponent(String(part))
   let a=try fileManager.attributesOfItem(atPath:cursor.path)
   let type=a[.type] as? FileAttributeType
   guard type == .typeDirectory || (type == .typeRegular && (a[.referenceCount] as? NSNumber)?.intValue == 1) else { throw Invalid(code:"REHEARSAL_PATH_ALIAS") }
   guard (a[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else { throw Invalid(code:"REHEARSAL_PATH_OWNER") }
  }
  return value
 }
 static func quote(_ value:String)->String { return "\""+value.replacingOccurrences(of:"\\",with:"\\\\").replacingOccurrences(of:"\"",with:"\\\"")+"\"" }
 static func profile(_ root: URL) throws -> String {
  guard let pwd=getpwuid(getuid()), let pointer=pwd.pointee.pw_dir else { throw Invalid(code:"REHEARSAL_USER_HOME_UNKNOWN") }
  let formalHome=String(cString:pointer)
  guard formalHome.hasPrefix("/"),formalHome != "/" else { throw Invalid(code:"REHEARSAL_USER_HOME_UNKNOWN") }
  return """
  (version 1)
  (allow default)
  (deny mach-lookup \(services.map{"(global-name \(quote($0)))"}.joined(separator:" ")) (global-name-regex #"^com\\.apple\\.usernoted\\.") (global-name-regex #"^com\\.apple\\.usernotifications\\."))
  (deny file-read* (subpath \(quote(formalHome))) (subpath "/Library/Keychains") (subpath "/System/Library/Keychains"))
  (allow file-read* (subpath \(quote(root.path))))
  (deny file-write*)
  (allow file-write* (subpath \(quote(root.path))))
  (deny network*)
  (allow network-bind (local ip "localhost:*"))
  (allow network-inbound (local ip "localhost:*"))
  (allow network-outbound (remote ip "localhost:*"))
  """+"\n"
 }
 static func environment(_ root: URL) throws -> [String:String] {
  let source=ProcessInfo.processInfo.environment
  guard let homeRaw=source["CHATHAND_REHEARSAL_HOME"], let stateRaw=source["CHATHAND_STATE_DIR"] else { throw Invalid(code:"REHEARSAL_ENV_REQUIRED") }
  let logRaw=source["CHATHAND_REHEARSAL_LOG_DIR"] ?? root.path+"/logs"
  let home=try inside(root,homeRaw),state=try inside(root,stateRaw),log=try inside(root,logRaw)
  for url in [home,state,log] {
   let attributes=try fileManager.attributesOfItem(atPath:url.path)
   guard attributes[.type] as? FileAttributeType == .typeDirectory,((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0)&0o077==0 else { throw Invalid(code:"REHEARSAL_DIRECTORY_REQUIRED") }
  }
  guard state != home, !state.path.hasPrefix(home.path+"/"), !home.path.hasPrefix(state.path+"/") else { throw Invalid(code:"REHEARSAL_STATE_HOME_OVERLAP") }
  if let legacy=source["KEN_BRIDGE_STATE_DIR"],legacy != stateRaw { throw Invalid(code:"REHEARSAL_STATE_MISMATCH") }
  var result=["HOME":home.path,"CFFIXED_USER_HOME":home.path,"PATH":"/usr/bin:/bin:/usr/sbin:/sbin","LANG":"en_US.UTF-8","TMPDIR":home.path,"CHATHAND_STATE_DIR":state.path,"KEN_BRIDGE_STATE_DIR":state.path,"CHATHAND_REHEARSAL_ROOT":root.path,"CHATHAND_REHEARSAL_HOME":home.path,"CHATHAND_REHEARSAL_LOG_DIR":log.path]
  // Only the native page observer's confined directory is an additional input.
  if let raw=source["CHATHAND_REHEARSAL_PAGE_DIR"] { result["CHATHAND_REHEARSAL_PAGE_DIR"]=try inside(root,raw).path }
  if let raw=source["CHATHAND_REHEARSAL_RELAUNCH_TARGET"] { result["CHATHAND_REHEARSAL_RELAUNCH_TARGET"]=try inside(root,raw).path }
  return result
 }
 static func executablePath(_ pid:pid_t)->String? {
  var buffer=[CChar](repeating:0,count:4*Int(MAXPATHLEN))
  let count=proc_pidpath(pid,&buffer,UInt32(buffer.count));return count>0 ? String(cString:buffer) : nil
 }
 static func launchServices(_ root:URL,_ app:URL,_ binary:URL,_ arguments:[String],_ env:[String:String],_ policy:URL,_ dir:URL) throws -> [String:Any]? {
  let option=root.appendingPathComponent(".rehearsal-launch-services.json")
  guard fileManager.fileExists(atPath:option.path) else{return nil}
  _=try inside(root,option.path)
  let attributes=try fileManager.attributesOfItem(atPath:option.path)
  guard (attributes[.size] as? NSNumber)?.intValue ?? 99999 < 4096,((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0)&0o077==0,
   let config=try JSONSerialization.jsonObject(with:Data(contentsOf:option)) as? [String:Any],Set(config.keys)==Set(["format","gateway_binary","sha256"]),config["format"] as? Int==1,
   let raw=config["gateway_binary"] as? String,let expected=config["sha256"] as? String else{throw Invalid(code:"REHEARSAL_GATEWAY_CONFIG_INVALID")}
  let source=try inside(root,raw),data=try Data(contentsOf:source)
  guard data.count<=4*1024*1024,SHA256.hash(data:data).map({String(format:"%02x",$0)}).joined()==expected else{throw Invalid(code:"REHEARSAL_GATEWAY_HASH_MISMATCH")}
  let gateway=dir.appendingPathComponent("Gateway-"+UUID().uuidString+".app"),contents=gateway.appendingPathComponent("Contents"),macos=contents.appendingPathComponent("MacOS"),resources=contents.appendingPathComponent("Resources")
  try fileManager.createDirectory(at:macos,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700]);try fileManager.createDirectory(at:resources,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
  let executable=macos.appendingPathComponent("LaunchGateway");try data.write(to:executable,options:.withoutOverwriting);try fileManager.setAttributes([.posixPermissions:0o700],ofItemAtPath:executable.path)
  let plist:[String:Any]=["CFBundleExecutable":"LaunchGateway","CFBundleIdentifier":"invalid.chathand.launchgateway."+UUID().uuidString.lowercased(),"CFBundleName":"Isolated Launch Gateway","CFBundlePackageType":"APPL","LSUIElement":true]
  try PropertyListSerialization.data(fromPropertyList:plist,format:.xml,options:0).write(to:contents.appendingPathComponent("Info.plist"),options:.withoutOverwriting)
  let body:[String:Any]=["root":root.path,"binary":binary.path,"profile":policy.path,"environment":env,"arguments":arguments]
  try JSONSerialization.data(withJSONObject:body).write(to:resources.appendingPathComponent("launch.json"),options:.withoutOverwriting)
  let launch=NSWorkspace.OpenConfiguration();launch.createsNewApplicationInstance=true
  var completion=false,failed=false,pid:pid_t=0
  NSWorkspace.shared.openApplication(at:gateway,configuration:launch){app,error in completion=true;failed=error != nil;pid=app?.processIdentifier ?? 0}
  let until=Date().addingTimeInterval(15)
  while Date()<until {
   if completion && failed{throw Invalid(code:"REHEARSAL_LS_LAUNCH_FAILED")}
   if completion,pid>1,executablePath(pid)==binary.path,let registered=NSWorkspace.shared.runningApplications.first(where:{$0.processIdentifier==pid}),physical(registered.bundleURL?.path ?? "")==app.path {
    return ["started":true,"pid":Int(pid),"executable":binary.path,"bundle":app.path,"registered_bundle":registered.bundleURL?.path ?? "","launchservices_gateway":gateway.path,"isolation_protocol":protocolVersion,"profile":policy.path,"derived_log_dir":ProcessInfo.processInfo.environment["CHATHAND_REHEARSAL_LOG_DIR"]==nil]
   }
   RunLoop.main.run(until:Date().addingTimeInterval(0.05))
  }
  // Never kill an unverified process on a registration/identity failure.
  throw Invalid(code:"REHEARSAL_LS_IDENTITY_TIMEOUT")
 }
 static func launch(_ app:URL,_ arguments:[String]) throws -> [String:Any] {
  let source=ProcessInfo.processInfo.environment
  let rootURL=try root(source["CHATHAND_REHEARSAL_ROOT"] ?? "")
  _=try inside(rootURL,app.path)
  guard app.pathExtension == "app", app.lastPathComponent != "ChatHand.app", let bundle=Bundle(url:app),let executable=bundle.executableURL else { throw Invalid(code:"REHEARSAL_BUNDLE_INVALID") }
  let binary=try inside(rootURL,app.appendingPathComponent("Contents/MacOS/"+executable.lastPathComponent).path)
  guard fileManager.isExecutableFile(atPath:binary.path),arguments.allSatisfy({["--upgrade-verification"].contains($0)}) else { throw Invalid(code:"REHEARSAL_ARGUMENTS_INVALID") }
  let env=try environment(rootURL),dir=URL(fileURLWithPath:env["CHATHAND_REHEARSAL_LOG_DIR"]!)
  // Each isolated start may follow a state restore which excludes launcher.log.
  // Provision that exact runtime file without changing old App/updater bytes.
  do {
   let serviceLog=URL(fileURLWithPath:env["CHATHAND_STATE_DIR"]!).appendingPathComponent("launcher.log")
   var logDescriptor=Darwin.open(serviceLog.path,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,mode_t(0o600))
   if logDescriptor < 0 {
    let savedErrno=errno
    guard savedErrno==EEXIST else { throw Invalid(code:"REHEARSAL_SERVICE_LOG_CREATE_ERRNO_\(savedErrno)") }
    logDescriptor=Darwin.open(serviceLog.path,O_WRONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK)
    guard logDescriptor >= 0 else { throw Invalid(code:"REHEARSAL_SERVICE_LOG_OPEN_ERRNO_\(errno)") }
   }
   defer { Darwin.close(logDescriptor) }
   var logStat=stat()
   guard fstat(logDescriptor,&logStat)==0,
    logStat.st_mode & mode_t(S_IFMT)==mode_t(S_IFREG),logStat.st_uid==getuid(),logStat.st_nlink==1,
    logStat.st_mode & 0o777==0o600 else { throw Invalid(code:"REHEARSAL_SERVICE_LOG_UNSAFE") }
  }
  let id=UUID().uuidString,policy=dir.appendingPathComponent("launch-"+id+".sb"),log=dir.appendingPathComponent("launch-"+id+".log")
  try profile(rootURL).write(to:policy,atomically:false,encoding:.utf8)
  try fileManager.setAttributes([.posixPermissions:0o600],ofItemAtPath:policy.path)
  let descriptor=Darwin.open(log.path,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,mode_t(0o600))
  guard descriptor >= 0 else { throw Invalid(code:"REHEARSAL_LOG_CREATE_ERRNO_\(errno)") }
  let output=FileHandle(fileDescriptor:descriptor,closeOnDealloc:true)
  defer { try? output.close() }
  let child=Process();
  if let receipt=try launchServices(rootURL,app,binary,arguments,env,policy,dir){return receipt}
  child.executableURL=URL(fileURLWithPath:"/usr/bin/sandbox-exec")

  child.arguments=["-f",policy.path,binary.path]+arguments+["-ChatHandUIZoom","1.25"]
  let input=Pipe();try input.fileHandleForWriting.close()
  child.environment=env;child.currentDirectoryURL=rootURL;child.standardInput=input;child.standardOutput=output;child.standardError=output
  do { try child.run() } catch {
   let savedErrno=errno,detail=error as NSError
   let domain=detail.domain==NSPOSIXErrorDomain ? "POSIX" : detail.domain==NSCocoaErrorDomain ? "COCOA" : "OTHER"
   let underlying=detail.userInfo[NSUnderlyingErrorKey] as? NSError
   let posix=detail.domain==NSPOSIXErrorDomain ? detail.code : underlying?.domain==NSPOSIXErrorDomain ? underlying!.code : 0
   throw Invalid(code:"REHEARSAL_LAUNCH_FAILED_\(domain)_\(detail.code)_POSIX_\(posix)_ERRNO_\(savedErrno)")
  }
  let pid=child.processIdentifier,until=Date().addingTimeInterval(12)
  while Date()<until && child.isRunning {
   if let running=NSWorkspace.shared.runningApplications.first(where:{$0.processIdentifier==pid && physical($0.bundleURL?.path ?? "")==app.path}), !running.isTerminated, physical(executablePath(pid) ?? "")==binary.path {
    // Process does not terminate children on deinit. stdout/stderr are regular
    // files; the app has no dependence on a pipe owned by this short-lived helper.
    return ["started":true,"pid":Int(pid),"executable":binary.path,"bundle":app.path,"isolation_protocol":protocolVersion,"log":log.path,"profile":policy.path]
   }
   RunLoop.main.run(until:Date().addingTimeInterval(0.05))
  }
  if child.isRunning { child.terminate() }
  throw Invalid(code:child.isRunning ? "REHEARSAL_APP_REGISTRATION_TIMEOUT" : "REHEARSAL_APP_EXITED")
 }
}

enum ExactAppProcess {
 struct Invalid: Error { let code: String }
 struct Start: Equatable { let seconds: UInt64; let microseconds: UInt64 }
 // Injectable system reads keep exit/reuse races deterministic in native tests.
 // The shipped CLI always uses system operations; there is no runtime override.
 struct Operations {
  var alive: (pid_t) throws -> Bool
  var zombie: (pid_t) -> Bool
  var path: (pid_t) -> String?
  var start: (pid_t) -> Start?
  var terminate: (pid_t) throws -> Void
  var now: () -> Date
  var pause: () -> Void
  static var system: Operations {
   Operations(alive: ExactAppProcess.alive, zombie: { pid in
    var info = proc_bsdinfo()
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 1, &info, Int32(MemoryLayout.size(ofValue: info))) == MemoryLayout.size(ofValue: info) else { return false }
    return info.pbi_status == UInt32(SZOMB)
   }, path: RehearsalIsolation.executablePath, start: { pid in
    var info = proc_bsdinfo()
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout.size(ofValue: info))) == MemoryLayout.size(ofValue: info) else { return nil }
    return Start(seconds: info.pbi_start_tvsec, microseconds: info.pbi_start_tvusec)
   }, terminate: { pid in
    guard kill(pid, SIGTERM) == 0 || errno == ESRCH else { throw Invalid(code: "EXACT_STOP_DENIED") }
   }, now: Date.init, pause: { RunLoop.main.run(until: Date().addingTimeInterval(0.1)) })
  }
 }
 static func executable(_ app: URL) throws -> String {
  guard let bundle = Bundle(url: app), let binary = bundle.executableURL,
        let physical = RehearsalIsolation.physical(binary.path), physical.hasPrefix(app.path + "/Contents/MacOS/") else { throw Invalid(code: "APP_EXECUTABLE_UNKNOWN") }
  return physical
 }
 static func alive(_ pid: pid_t) throws -> Bool {
  if kill(pid, 0) == 0 { return true }; if errno == ESRCH { return false }
  throw Invalid(code: "PID_STATUS_UNKNOWN")
 }
 static func identity(_ pid: pid_t, operations: Operations = .system) throws -> [String: Any]? {
  guard try operations.alive(pid) else { return nil }
  // A process can exit between kill(0), proc_pidinfo and proc_pidpath. Missing
  // identity is success only after the same PID is confirmed absent (ESRCH)
  // or the kernel confirms it has exited and is awaiting collection (SZOMB).
  guard let before = operations.start(pid), let executable = operations.path(pid), let after = operations.start(pid) else {
   guard try operations.alive(pid) else { return nil }
   if operations.zombie(pid) { return nil }
   throw Invalid(code: "PID_INSPECTION_UNAVAILABLE")
  }
  // Do not combine the path of one process with a reused PID's start time.
  guard before == after else { throw Invalid(code: "PID_IDENTITY_CHANGED") }
  return ["pid":Int(pid), "executable":executable, "started_seconds":after.seconds, "started_microseconds":after.microseconds]
 }
 static func scan(_ app: URL) throws -> [[String: Any]] {
  let expected = try executable(app), count = proc_listallpids(nil, 0)
  guard count > 0 else { throw Invalid(code:"PID_ENUMERATION_FAILED") }
  var pids = [Int32](repeating:0,count:Int(count)+1024)
  let actual = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<Int32>.size))
  guard actual >= 0, actual < pids.count else { throw Invalid(code:"PID_ENUMERATION_FAILED") }
  return try pids.prefix(Int(actual)).filter { $0 > 1 && RehearsalIsolation.executablePath($0) == expected }.compactMap { try identity($0) }
 }
 static func stop(_ app: URL, _ pid: pid_t, operations: Operations = .system) throws -> [String: Any] {
  guard let before = try identity(pid, operations: operations) else { return ["stopped":true,"already_gone":true,"pid_absent":true] }
  guard before["executable"] as? String == (try executable(app)) else { throw Invalid(code:"PID_IDENTITY_CHANGED") }
  try operations.terminate(pid)
  let until=operations.now().addingTimeInterval(8)
  while operations.now()<until {
   guard let current = try identity(pid, operations: operations) else { return ["stopped":true,"pid_absent":true] }
   guard current["started_seconds"] as? UInt64 == before["started_seconds"] as? UInt64,
         current["started_microseconds"] as? UInt64 == before["started_microseconds"] as? UInt64,
         current["executable"] as? String == before["executable"] as? String else { throw Invalid(code:"PID_IDENTITY_CHANGED") }
   operations.pause()
  }
  throw Invalid(code:"EXACT_STOP_TIMEOUT")
 }
}

#if !EXACT_APP_PROCESS_TESTS
@main struct UpgradeControl {
 static func output(_ value:[String:Any],_ code:Int32=0){let d=try! JSONSerialization.data(withJSONObject:value);print(String(data:d,encoding:.utf8)!);exit(code)}
 static func main(){
  let args=CommandLine.arguments;guard args.count>=3 else{output(["error":"ARGUMENTS_REQUIRED"],2);return}
  let action=args[1];var url=URL(fileURLWithPath:RehearsalIsolation.physical(args[2]) ?? args[2])
  let rehearsal=ProcessInfo.processInfo.environment["CHATHAND_REHEARSAL_ROOT"]
  if action=="trash" {
   guard !ProcessInfo.processInfo.environment.keys.contains(where:{$0.hasPrefix("CHATHAND_REHEARSAL_")}) else{output(["error":"REHEARSAL_TRASH_NOT_ALLOWED"],2);return}
   let root=FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/ChatHand/upgrades",isDirectory:true).standardizedFileURL.resolvingSymlinksInPath()
   guard args.count==3,args[2].hasPrefix("/"),url.path.hasPrefix(root.path+"/") else{output(["error":"TRASH_PATH_NOT_ALLOWED"],2);return}
   do {try FileManager.default.trashItem(at:url,resultingItemURL:nil);output(["trashed":true])}catch{output(["error":"TRASH_FAILED"],3)}
   return
  }
  if action=="rehearsal-profile" {
   do {let root=try RehearsalIsolation.root(args[2]);output(["isolation_protocol":RehearsalIsolation.protocolVersion,"profile":try RehearsalIsolation.profile(root),"blocked_services":RehearsalIsolation.services])}
   catch {output(["error":(error as? RehearsalIsolation.Invalid)?.code ?? "REHEARSAL_PATH_INVALID"],2)}
   return
  }
  if let raw=rehearsal {
   do {url=try RehearsalIsolation.inside(RehearsalIsolation.root(raw),args[2])}
   catch {output(["error":(error as? RehearsalIsolation.Invalid)?.code ?? "REHEARSAL_PATH_INVALID"],2)}
  } else if ProcessInfo.processInfo.environment.keys.contains(where:{$0.hasPrefix("CHATHAND_REHEARSAL_")}) {
   output(["error":"REHEARSAL_ROOT_REQUIRED"],2);return
  }
  if action=="install-stop" {
   guard args.count==3 else{output(["error":"ARG_INVALID"],2);return}
   do {
    guard let source=InstanceLifecycle.appPath(in:InstanceLifecycle.physical(args[0]) ?? args[0],marker:"Resources/runtime/bin/") else{throw InstanceLifecycle.Failure(code:"RELAUNCH_SOURCE_UNKNOWN")}
    let base=FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/ChatHand")
    let states:[URL]
    if let state=ProcessInfo.processInfo.environment["CHATHAND_STATE_DIR"] {states=[URL(fileURLWithPath:state)]}
    else {states=[base.appendingPathComponent("data")]}
    let scope=try InstanceLifecycle.Scope.validated(environment:ProcessInfo.processInfo.environment,state:states[0],app:source,beforeMigration:true)
    // Freeze the backends before normal quit removes runtime.json. Reuse the
    // same signature/PID/start-time checks as the existing relaunch path.
    let backends=try states.map{try InstanceLifecycle.captureBackend(state:$0,source:source,scope:scope)}
    let initial=try InstanceLifecycle.instances(source:source,scope:scope)
    for app in initial {try InstanceLifecycle.stop(app)}
    guard try InstanceLifecycle.instances(source:source,scope:scope).isEmpty else{throw InstanceLifecycle.Failure(code:"RELAUNCH_INSTANCES_REMAIN")}
    let build=Int(Bundle(url:source)?.object(forInfoDictionaryKey:"CFBundleVersion") as? String ?? "0") ?? 0
    for (state,backend) in zip(states,backends) {
     try InstanceLifecycle.shutdownOrphan(state:state,source:source,scope:scope,prior:backend,diagnostic:{_,code,pid in InstanceLifecycle.record(state:state,phase:"install",code:code,build:build,pid:pid)})
    }
    output(["stopped":true,"pids":initial.map{Int($0.identity.pid)}])
   }catch{output(["error":(error as? InstanceLifecycle.Failure)?.code ?? "INSTALL_QUIT_FAILED"],6)}
   return
  }
  if action=="backend-info" || action=="stop-backend-exact" {
   guard args.count==4 else{output(["error":"ARG_INVALID"],2);return}
   let state=URL(fileURLWithPath:args[3])
   do {
    guard let source=InstanceLifecycle.appPath(in:InstanceLifecycle.physical(args[0]) ?? args[0],marker:"Resources/runtime/bin/") else{throw InstanceLifecycle.Failure(code:"RELAUNCH_SOURCE_UNKNOWN")}
    let sourceRequirement=try InstanceLifecycle.signatureRequirement(source)
    guard InstanceLifecycle.trusted(url,requirement:sourceRequirement) else{throw InstanceLifecycle.Failure(code:"ORPHAN_IDENTITY_UNKNOWN")}
    let scope:InstanceLifecycle.Scope
    if rehearsal != nil {scope=try InstanceLifecycle.Scope.validated(environment:ProcessInfo.processInfo.environment,state:state,app:source)}
    else {
     let base=FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/ChatHand").path
     guard [base+"/data",base+"/v05"].contains(state.path),InstanceLifecycle.physical(state.path)==state.path else{throw InstanceLifecycle.Failure(code:"INSTANCE_ISOLATION_REQUIRED")}
     scope=InstanceLifecycle.Scope(root:nil)
    }
    if action=="backend-info" {
     guard let backend=try InstanceLifecycle.captureBackend(state:state,source:source,scope:scope) else{output(["present":false]);return}
     let i=backend.identity
     output(["present":true,"signature_verified":true,"uid":Int(getuid()),"identity":["pid":Int(i.pid),"path":i.path,"seconds":i.seconds,"micros":i.micros]]);return
    }
    var bytes=Data()
    while let chunk=try FileHandle.standardInput.read(upToCount:4096),!chunk.isEmpty {bytes.append(chunk);if bytes.count>131072{throw InstanceLifecycle.Failure(code:"ORPHAN_IDENTITY_UNKNOWN")}}
    guard bytes.count<=131072,let input=(try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any],Set(input.keys)==Set(["runtime","receipt"]),let runtime=input["runtime"] as? [String:Any],let receipt=input["receipt"] as? [String:Any],receipt["signature_verified"] as? Bool==true,receipt["uid"] as? Int==Int(getuid()),let item=receipt["identity"] as? [String:Any],let pid=item["pid"] as? Int32,let path=item["path"] as? String,let seconds=item["seconds"] as? UInt64,let micros=item["micros"] as? UInt64,runtime["pid"] as? Int==Int(pid) else{throw InstanceLifecycle.Failure(code:"ORPHAN_IDENTITY_UNKNOWN")}
    let expected=InstanceLifecycle.Identity(pid:pid,path:path,seconds:seconds,micros:micros)
    guard let current=try InstanceLifecycle.identity(pid) else{output(["stopped":true,"pid_absent":true,"pid":Int(pid)]);return}
    guard current==expected,let backend=try InstanceLifecycle.captureBackend(state:state,source:source,scope:scope,record:runtime),backend.identity==expected else{throw InstanceLifecycle.Failure(code:"INSTANCE_IDENTITY_CHANGED")}
    let build=Int(Bundle(url:source)?.object(forInfoDictionaryKey:"CFBundleVersion") as? String ?? "0") ?? 0
    try InstanceLifecycle.shutdownOrphan(state:state,source:source,scope:scope,prior:backend,diagnostic:{phase,code,pid in InstanceLifecycle.record(state:state,phase:phase,code:code,build:build,pid:pid)})
    guard !(try InstanceLifecycle.alive(pid)) else{throw InstanceLifecycle.Failure(code:"ORPHAN_STOP_TIMEOUT")}
    output(["stopped":true,"pid_absent":true,"pid":Int(pid)])
   }catch{output(["error":(error as? InstanceLifecycle.Failure)?.code ?? "ORPHAN_IDENTITY_UNKNOWN"],6)}
   return
  }
  if action=="reopen-after-exit" {
   guard args.count==6,["0","1"].contains(args[5]),let sourcePID=Int32(args[3]),sourcePID>1 else{output(["error":"ARG_INVALID"],2);return}
   let state=URL(fileURLWithPath:args[4]),activate=args[5]=="1";var build=0,recordState=state
   func record(_ code:String,_ pid:Int32){InstanceLifecycle.record(state:recordState,phase:"relaunch",code:code,build:build,pid:pid)}
   do {
    guard let source=InstanceLifecycle.appPath(in:InstanceLifecycle.physical(args[0]) ?? args[0],marker:"Resources/runtime/bin/"),let text=Bundle(url:source)?.object(forInfoDictionaryKey:"CFBundleVersion") as? String,let sourceBuild=Int(text) else{throw InstanceLifecycle.Failure(code:"RELAUNCH_SOURCE_UNKNOWN")}
    build=sourceBuild
    let scope=try InstanceLifecycle.Scope.validated(environment:ProcessInfo.processInfo.environment,state:state,app:source,beforeMigration:true)
    if !FileManager.default.fileExists(atPath:state.path) {recordState=try InstanceLifecycle.startupCoordination(state:state,source:source,environment:ProcessInfo.processInfo.environment).0}
    let requirement=try InstanceLifecycle.signatureRequirement(source)
    let target=try InstanceLifecycle.relaunchTarget(environment:ProcessInfo.processInfo.environment,scope:scope)
    guard InstanceLifecycle.physical(target.path)==InstanceLifecycle.physical(url.path),InstanceLifecycle.trusted(target,requirement:requirement),
          let old=try InstanceLifecycle.identity(sourcePID),InstanceLifecycle.appPath(in:old.path,marker:"MacOS/")==source,InstanceLifecycle.trustedPID(sourcePID,requirement:requirement) else{throw InstanceLifecycle.Failure(code:"RELAUNCH_SOURCE_UNKNOWN")}
    // The native keeps its lifetime until this exact identity is captured.
    try FileHandle.standardOutput.write(contentsOf:Data("ready\n".utf8))
    guard readLine()=="go" else{throw InstanceLifecycle.Failure(code:"RELAUNCH_CANCELLED")}
    record("REOPEN_WAIT_OLD",sourcePID)
    guard try InstanceLifecycle.waitGone(old,timeout:15) else{throw InstanceLifecycle.Failure(code:"INSTANCE_QUITTING_TIMEOUT")}
    record("REOPEN_OLD_GONE",sourcePID)
    let deadline=ProcessInfo.processInfo.systemUptime+15
    while true {
     let running=try InstanceLifecycle.instances(source:source,scope:scope)
     let recordOwner=InstanceLifecycle.readOwner(state:state)
     if let owner=recordOwner,!owner.quitting,let current=running.first(where:{$0.identity.pid==owner.pid && $0.identity.seconds==owner.seconds && $0.identity.micros==owner.micros && $0.build>=build}) {
      InstanceLifecycle.wake(current,scope:scope,activate:activate);record("REOPEN_USE_NEW_OWNER",current.identity.pid);exit(0)
     }
     if running.isEmpty {break}
     // A newly launched contender owns its startup/migration work. Never stop
     // it or mistake it for the old owner that the user asked to reopen.
     guard ProcessInfo.processInfo.systemUptime<deadline else{throw InstanceLifecycle.Failure(code:"RELAUNCH_START_TIMEOUT")}
     RunLoop.current.run(until:Date().addingTimeInterval(0.025))
    }
    if scope.root != nil {let result=try RehearsalIsolation.launch(target,[]);record("REOPEN_STARTED",Int32(result["pid"] as? Int ?? 0));exit(0)}
    let configuration=NSWorkspace.OpenConfiguration();configuration.createsNewApplicationInstance=true
    configuration.allowsRunningApplicationSubstitution=false;configuration.promptsUserIfNeeded=false
    configuration.activates=activate;configuration.addsToRecentItems=false
    var launched:Int32?,finished=false
    NSWorkspace.shared.openApplication(at:target,configuration:configuration){app,error in launched=app?.processIdentifier;finished=true}
    let until=ProcessInfo.processInfo.systemUptime+15
    while !finished && ProcessInfo.processInfo.systemUptime<until {RunLoop.main.run(until:Date().addingTimeInterval(0.025))}
    guard let pid=launched else{throw InstanceLifecycle.Failure(code:"RELAUNCH_START_FAILED")}
    record("REOPEN_STARTED",pid);exit(0)
   }catch{record((error as? InstanceLifecycle.Failure)?.code ?? "REOPEN_HELPER_FAILED",sourcePID);exit(6)}
  }
  if action=="relaunch" {
   guard args.count==5,let sourcePID=Int32(args[3]),sourcePID>1 else{output(["error":"ARG_INVALID"],2);return}
   let state=URL(fileURLWithPath:args[4])
   var build=0
   func record(_ code:String,_ pid:Int32){InstanceLifecycle.record(state:state,phase:"relaunch",code:code,build:build,pid:pid)}
   do {
    guard let source=InstanceLifecycle.appPath(in:InstanceLifecycle.physical(args[0]) ?? args[0],marker:"Resources/runtime/bin/"),let text=Bundle(url:source)?.object(forInfoDictionaryKey:"CFBundleVersion") as? String,let sourceBuild=Int(text) else{throw InstanceLifecycle.Failure(code:"RELAUNCH_SOURCE_UNKNOWN")}
    build=sourceBuild
    let scope=try InstanceLifecycle.Scope.validated(environment:ProcessInfo.processInfo.environment,state:state,app:source)
    let target=try InstanceLifecycle.relaunchTarget(environment:ProcessInfo.processInfo.environment,scope:scope)
    guard InstanceLifecycle.physical(target.path)==InstanceLifecycle.physical(url.path),InstanceLifecycle.trusted(target,requirement:try InstanceLifecycle.signatureRequirement(source)) else{throw InstanceLifecycle.Failure(code:"RELAUNCH_TARGET_INVALID")}
    let priorBackend=try InstanceLifecycle.captureBackend(state:state,source:source,scope:scope)
    let initial=try InstanceLifecycle.instances(source:source,scope:scope)
    guard initial.contains(where:{$0.identity.pid==sourcePID && $0.app.path==source.path}) else{throw InstanceLifecycle.Failure(code:"RELAUNCH_SOURCE_UNKNOWN")}
    guard readLine()=="go" else{throw InstanceLifecycle.Failure(code:"RELAUNCH_CANCELLED")}
    record("RELAUNCH_BEGIN",sourcePID)
    for app in initial.sorted(by:{$0.identity.pid != sourcePID && $1.identity.pid==sourcePID}) {try InstanceLifecycle.stop(app);record("RELAUNCH_PID_GONE",app.identity.pid)}
    guard try InstanceLifecycle.instances(source:source,scope:scope).isEmpty else{throw InstanceLifecycle.Failure(code:"RELAUNCH_INSTANCES_REMAIN")}
    try InstanceLifecycle.shutdownOrphan(state:state,source:source,scope:scope,prior:priorBackend,diagnostic:{_,code,pid in record(code,pid)})
    if scope.root != nil {let result=try RehearsalIsolation.launch(target,[]);record("RELAUNCH_STARTED",Int32(result["pid"] as? Int ?? 0));output(result);return}
    let configuration=NSWorkspace.OpenConfiguration();configuration.createsNewApplicationInstance=true
    var result:[String:Any]?
    NSWorkspace.shared.openApplication(at:target,configuration:configuration){app,error in
     if let app{record("RELAUNCH_STARTED",app.processIdentifier);result=["relaunching":true,"pid":Int(app.processIdentifier)]}
     else{record("RELAUNCH_START_FAILED",sourcePID);result=["error":"RELAUNCH_START_FAILED"]}
    }
    let until=Date().addingTimeInterval(15);while result==nil && Date()<until{RunLoop.main.run(until:Date().addingTimeInterval(0.05))}
    guard let result else{throw InstanceLifecycle.Failure(code:"RELAUNCH_START_TIMEOUT")};output(result,result["error"]==nil ? 0:6)
   }catch{let code=(error as? InstanceLifecycle.Failure)?.code ?? (error as? RehearsalIsolation.Invalid)?.code ?? "RELAUNCH_FAILED";record(code,sourcePID);output(["error":code],6)}
   return
  }
  let apps=NSWorkspace.shared.runningApplications.filter{RehearsalIsolation.physical($0.bundleURL?.path ?? "")==url.path}
  if action=="pid-info",rehearsal != nil {
   guard args.count==4,let pid=Int32(args[3]),pid>1,let executable=RehearsalIsolation.executablePath(pid),let physical=RehearsalIsolation.physical(executable),physical.hasPrefix(url.path+"/Contents/") else{output(["error":"REHEARSAL_PID_OUTSIDE_BUNDLE"],3);return}
   output(["pid":Int(pid),"executable":physical,"bundle":url.path]);return
  }
  if action=="info" {
   do {
    let identities=try ExactAppProcess.scan(url),pids=identities.compactMap{$0["pid"] as? Int}
    // NSWorkspace registration and kernel executable ownership must agree.
    guard apps.allSatisfy({pids.contains(Int($0.processIdentifier))}) else { throw ExactAppProcess.Invalid(code:"APP_PID_IDENTITY_UNKNOWN") }
    var value:[String:Any] = ["running":!pids.isEmpty,"pids":pids,"identities":identities,"executable_paths":identities.compactMap{$0["executable"] as? String},"kernel_scan":true]
    if rehearsal != nil {value["isolation_protocol"]=RehearsalIsolation.protocolVersion}
    output(value)
   } catch {output(["error":(error as? ExactAppProcess.Invalid)?.code ?? "PID_INSPECTION_UNAVAILABLE"],3)}
   return
  }
  if action=="stop-exact" {
   guard args.count==4,let pid=Int32(args[3]),pid>1 else{output(["error":"INVALID_PID"],2);return}
   do {output(try ExactAppProcess.stop(url,pid))}
   catch {output(["error":(error as? ExactAppProcess.Invalid)?.code ?? "PID_INSPECTION_UNAVAILABLE"],5)}
   return
  }
  if action=="stop" {
   guard apps.count<=1 else{output(["error":"MULTIPLE_TARGET_INSTANCES"],3);return}
   for app in apps {if !app.terminate(){output(["error":"APP_DECLINED_QUIT"],4);return}}
   let until=Date().addingTimeInterval(15)
   while Date()<until && apps.contains(where:{!$0.isTerminated}){RunLoop.main.run(until:Date().addingTimeInterval(0.1))}
   guard !apps.contains(where:{!$0.isTerminated}) else{output(["error":"APP_STOP_TIMEOUT"],5);return}
   output(["stopped":true]);return
  }
  if action=="rehearsal-start-ls" {
   guard let raw=rehearsal,args.count==4 else{output(["error":"REHEARSAL_ROOT_REQUIRED"],2);return}
   do {
    let root=try RehearsalIsolation.root(raw),gateway=try RehearsalIsolation.inside(root,args[3])
    guard gateway.pathExtension=="app",gateway != url, let bundle=Bundle(url:gateway), bundle.bundleIdentifier?.hasPrefix("invalid.chathand.launchgateway.")==true else{throw RehearsalIsolation.Invalid(code:"REHEARSAL_GATEWAY_INVALID")}
    let expected=try ExactAppProcess.executable(url),config=NSWorkspace.OpenConfiguration();config.createsNewApplicationInstance=true
    var completion=false,failed=false,pid:pid_t=0
    NSWorkspace.shared.openApplication(at:gateway,configuration:config){app,error in completion=true;failed=error != nil;pid=app?.processIdentifier ?? 0}
    let until=Date().addingTimeInterval(15)
    while Date()<until {
     if completion && failed{throw RehearsalIsolation.Invalid(code:"REHEARSAL_LS_LAUNCH_FAILED")}
     if completion,pid>1,RehearsalIsolation.executablePath(pid)==expected {
      let registered=NSWorkspace.shared.runningApplications.first{$0.processIdentifier==pid}
      output(["started":true,"pid":Int(pid),"executable":expected,"bundle":url.path,"registered_bundle":registered?.bundleURL?.path ?? "","launchservices_gateway":gateway.path,"isolation_protocol":RehearsalIsolation.protocolVersion]);return
     }
     RunLoop.main.run(until:Date().addingTimeInterval(0.05))
    }
    throw RehearsalIsolation.Invalid(code:"REHEARSAL_LS_IDENTITY_TIMEOUT")
   }catch{output(["error":(error as? RehearsalIsolation.Invalid)?.code ?? "REHEARSAL_LS_LAUNCH_FAILED"],6)}
   return
  }
  if action=="start" || action=="install-start" {
   if rehearsal != nil {
    guard apps.isEmpty else{output(["error":"REHEARSAL_TARGET_ALREADY_RUNNING"],3);return}
    do {output(try RehearsalIsolation.launch(url,Array(args.dropFirst(3))))}
    catch {output(["error":(error as? RehearsalIsolation.Invalid)?.code ?? "REHEARSAL_LAUNCH_FAILED"],6)}
    return
   }
   let config=NSWorkspace.OpenConfiguration();config.createsNewApplicationInstance=true
   if action=="install-start" {config.allowsRunningApplicationSubstitution=false;config.activates=false;config.promptsUserIfNeeded=false}
   // Explicitly carry the existing isolated-state override through LaunchServices.
   // Ordinary launches have no override and keep the user's normal state path.
   if let state=ProcessInfo.processInfo.environment["CHATHAND_STATE_DIR"] ?? ProcessInfo.processInfo.environment["KEN_BRIDGE_STATE_DIR"] {
    guard state.hasPrefix("/"), !state.contains("\0") else{output(["error":"INVALID_STATE_OVERRIDE"],2);return}
    config.environment=["CHATHAND_STATE_DIR":state,"KEN_BRIDGE_STATE_DIR":state]
   }
   config.arguments=Array(args.dropFirst(3));var result:[String:Any]?;var failed=false
   NSWorkspace.shared.openApplication(at:url,configuration:config){app,error in
    if let app=app {result=["started":true,"pid":Int(app.processIdentifier)]}else{failed=true;result=["error":"APP_LAUNCH_FAILED"]}
   }
   let until=Date().addingTimeInterval(15)
   while result==nil && Date()<until{RunLoop.main.run(until:Date().addingTimeInterval(0.1))}
   output(result ?? ["error":"APP_LAUNCH_TIMEOUT"],result==nil || failed ? 6:0);return
  }
  output(["error":"ACTION_UNKNOWN"],2)
 }
}
#endif
