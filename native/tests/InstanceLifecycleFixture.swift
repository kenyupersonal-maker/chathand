// Compiled and ad-hoc signed only inside the disposable native test root.
import Foundation
import Darwin
@main struct InstanceFixture {
 static func main() throws {
  let args=CommandLine.arguments,root=args[2],state=URL(fileURLWithPath:root+"/state"),app=InstanceLifecycle.appPath(in:InstanceLifecycle.physical(args[0])!,marker:"MacOS/") ?? InstanceLifecycle.appPath(in:InstanceLifecycle.physical(args[0])!,marker:"Resources/runtime/bin/")!
  let scope=try InstanceLifecycle.Scope.validated(environment:["CHATHAND_REHEARSAL_ROOT":root,"CHATHAND_REHEARSAL_HOME":root+"/home","CHATHAND_STATE_DIR":state.path],state:state,app:app)
  if args[1]=="residual" {
   signal(SIGTERM,SIG_IGN)
   let runtime:[String:Any]=["pid":Int(getpid()),"ui_origin":"http://127.0.0.1:"+args[3],"admin_token":String(repeating:"a",count:64)]
   try JSONSerialization.data(withJSONObject:runtime).write(to:state.appendingPathComponent("runtime.json"));chmod(state.appendingPathComponent("runtime.json").path,0o600)
   let until=Date().addingTimeInterval(50);while Date()<until{RunLoop.current.run(until:Date().addingTimeInterval(0.05))};return
  }
  if args[1]=="reclaim" {
   let frozen=try InstanceLifecycle.captureBackend(state:state,source:app,scope:scope)
   try FileManager.default.removeItem(at:state.appendingPathComponent("runtime.json"))
   try InstanceLifecycle.shutdownOrphan(state:state,source:app,scope:scope,prior:frozen){_,code,pid in InstanceLifecycle.record(state:state,phase:"instance",code:code,build:1064,pid:pid)}
   print("reclaimed");return
  }
  if args[1]=="target" {
   do{let u=try InstanceLifecycle.relaunchTarget(environment:["CHATHAND_REHEARSAL_RELAUNCH_TARGET":args[3]],scope:scope);print(u.path)}catch{print((error as? InstanceLifecycle.Failure)?.code ?? "FAILED")};return
  }
  let build=Int(Bundle.main.object(forInfoDictionaryKey:"CFBundleVersion") as! String)!
  if args[1]=="build" {let r=try InstanceLifecycle.signatureRequirement(app);print(InstanceLifecycle.liveBuild(pid:Int32(args[3])!,app:app,requirement:r) ?? -1);return}
  var lease:InstanceLifecycle.Lease?
  if args[1]=="claim" {
   lease=try InstanceLifecycle.claim(state:state,source:app,build:build,scope:scope){_,code,pid in InstanceLifecycle.record(state:state,phase:"instance",code:code,build:build,pid:pid)}
   guard lease != nil else{exit(20)}
  }
  let row:[String:Any]=["pid":Int(getpid()),"build":build,"claimed":lease != nil]
  try JSONSerialization.data(withJSONObject:row).write(to:URL(fileURLWithPath:root+"/"+String(getpid())+".json"))
  let end=Date().addingTimeInterval(12)
  while Date()<end {RunLoop.current.run(until:Date().addingTimeInterval(0.05))}
  withExtendedLifetime(lease){}
 }
}
