import Foundation
import Darwin
@main struct MigrationFixture {
 static func main() {
  let a=CommandLine.arguments,runner=StartupMigration(),root=URL(fileURLWithPath:a[1])
  if a[2]=="message" {print(StartupMigration.messageKey(code:a[3]));return}
  if a[2]=="identity" {
   let value=(try? InstanceLifecycle.identity(Int32(a[3])!)) ?? nil
   let row:[String:Any]
   if let i=value {row=["present":true,"identity":["pid":Int(i.pid),"path":i.path,"seconds":i.seconds,"micros":i.micros]]} else {row=["present":false]}
   print(String(data:try! JSONSerialization.data(withJSONObject:row,options:[.sortedKeys]),encoding:.utf8)!);return
  }
  if a[2]=="scope" {
   let state=root.appendingPathComponent("data"),source=root.appendingPathComponent("Fixture.app")
   let environment=["CHATHAND_REHEARSAL_ROOT":root.path,"CHATHAND_REHEARSAL_HOME":root.appendingPathComponent("home").path,"CHATHAND_STATE_DIR":state.path]
   do {
    if a[3]=="strict" {_=try InstanceLifecycle.Scope.validated(environment:environment,state:state,app:source)}
    else {_=try InstanceLifecycle.startupCoordination(state:state,source:source,environment:environment)}
    print("ok")
   } catch {print((error as? InstanceLifecycle.Failure)?.code ?? "FAILED")};return
  }
  let cancellation=Double(a[5])!
  if cancellation==0 {runner.cancel()}
  else if cancellation>0 {DispatchQueue.global().asyncAfter(deadline:.now()+cancellation){runner.cancel()}}
  let started=ProcessInfo.processInfo.systemUptime,lock=NSLock();var output:[String:Any]?
  DispatchQueue.global().async {
   var codes:[String]=[];var handlerReady=false
   let result=runner.run(executable:URL(fileURLWithPath:a[3]),script:URL(fileURLWithPath:a[4]),directory:root){code,pid in
    codes.append(code)
    if code=="MIGRATION_CHILD_STARTED",let i=try? InstanceLifecycle.identity(pid) {
     let value:[String:Any]=["pid":Int(i.pid),"path":i.path,"seconds":i.seconds,"micros":i.micros]
     try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]).write(to:root.appendingPathComponent("child-identity.json"))
     if URL(fileURLWithPath:a[3]).lastPathComponent=="hang" {
      // C writes this only after signal(SIGTERM,SIG_IGN). A launched PID alone
      // does not prove it has left dyld and installed the fault handler.
      let until=ProcessInfo.processInfo.systemUptime+2
      repeat {
       if (try? String(contentsOfFile:a[4],encoding:.utf8))==String(pid) {handlerReady=true;break}
       Thread.sleep(forTimeInterval:0.01)
      } while ProcessInfo.processInfo.systemUptime<until
      guard handlerReady else{fputs("HANG_FIXTURE_NOT_READY\n",stderr);exit(7)}
     }
    }
   }
   lock.lock();output=["code":result.code,"pid":Int(result.pid),"succeeded":result.succeeded,"codes":codes,"handler_ready":handlerReady,"elapsed":ProcessInfo.processInfo.systemUptime-started];lock.unlock()
  }
  while true {
   lock.lock();let result=output;lock.unlock()
   if let result {print(String(data:try! JSONSerialization.data(withJSONObject:result,options:[.sortedKeys]),encoding:.utf8)!);return}
   RunLoop.current.run(until:Date().addingTimeInterval(0.02))
  }
 }
}
