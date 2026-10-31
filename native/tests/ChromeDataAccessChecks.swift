import Foundation
import Darwin

@main struct ChromeDataAccessChecks {
 static func check(_ value:@autoclosure ()->Bool,_ label:String){if !value(){fatalError(label)}}
 static func main()throws{
  var time:TimeInterval=0,scheduled:[()->Void]=[],tries=0,replies:[[String:Any]]=[],pending:(([String:Any])->Void)?
  let recovery=ChromeDataAccessResume(now:{time},schedule:{_,work in scheduled.append(work)})
  recovery.start(retry:{done in tries+=1;pending=done},completion:{replies.append($0)})
  check(tries==0,"no background permission polling")
  recovery.returnedToApp();recovery.returnedToApp();check(tries==1,"one in-flight attempt per return")
  pending?(["error":["code":"CHROME_DATA_ACCESS_DENIED"]]);check(recovery.active && replies.isEmpty,"denial stays waiting")
  recovery.returnedToApp();check(tries==2,"next actual return retries")
  pending?(["started":true]);check(!recovery.active && replies.count==1,"permitted resumes once")
  scheduled[0]();check(replies.count==1,"old deadline cannot change completed result")
  recovery.start(retry:{done in pending=done},completion:{replies.append($0)})
  recovery.returnedToApp();let late=pending;recovery.cancel();late?(["started":true]);check(replies.count==2 && !recovery.active,"cancel rejects late result")
  recovery.start(retry:{_ in tries+=1},completion:{replies.append($0)});time=121;recovery.returnedToApp()
  check(!recovery.active && (replies.last?["error"] as? [String:String])?["code"] == "CHROME_DATA_ACCESS_TIMEOUT","finite expiry before retry")
  scheduled.last?();check(replies.count==3,"deadline completion once")

  var queued:[()->Void]=[],deliveries:[()->Void]=[],deadlines:[()->Void]=[],observations:[ChromeProfileDiscovery.Value]=[]
  let discovery=ChromeProfileDiscovery(execute:{queued.append($0)},deliver:{deliveries.append($0)},schedule:{_,work in deadlines.append(work)})
  discovery.start(timeout:0.05,read:{.success(["Default"])},completion:{observations.append($0)})
  check(queued.count==1 && observations.isEmpty,"AX reader never runs on calling main path")
  deadlines[0]();check(observations.count==1,"main deadline fires while worker remains hung or queued")
  if case .failure(let code)=observations[0]{check(code == .timeout,"known deadline has explicit timeout code")}else{fatalError("deadline must fail")}
  queued[0]();deliveries[0]();check(observations.count==1,"late AX result discarded")
  discovery.start(timeout:0.05,read:{.success(["Profile 2"])},completion:{observations.append($0)})
  discovery.cancel();queued[1]();deliveries[1]();check(observations.count==2,"cancel invalidates future queued authority")
  discovery.start(timeout:0.05,read:{.success(["Default"])},completion:{observations.append($0)})
  deadlines.last?();check(observations.count==3,"each new queued request owns its deadline")
  queued[2]();deliveries[2]();check(observations.count==3,"later queue unblock never starts install")

  let fm=FileManager.default,root=fm.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("chathand-chrome-access-"+UUID().uuidString)
  defer{try? fm.removeItem(at:root)}
  for mode in ["keep","delete"]{
   let home=root.appendingPathComponent(mode),app=home.appendingPathComponent("Applications/ChatHand.app"),support=home.appendingPathComponent("Library/Application Support/ChatHand"),state=support.appendingPathComponent("data"),hosts=home.appendingPathComponent("Library/Application Support/Google/Chrome/NativeMessagingHosts"),cache=home.appendingPathComponent("Library/Caches/com.kenyu.chathand")
   for dir in [app.appendingPathComponent("Contents"),state,hosts,cache]{try fm.createDirectory(at:dir,withIntermediateDirectories:true)}
   try PropertyListSerialization.data(fromPropertyList:["CFBundleIdentifier":"com.kenyu.chathand","CFBundleExecutable":"ChatHand"],format:.xml,options:0).write(to:app.appendingPathComponent("Contents/Info.plist"))
   try Data("synthetic".utf8).write(to:state.appendingPathComponent("fixture"))
   let plan=try ChatHandUninstallPlan(app:app,home:home,state:state,deleteData:mode=="delete",incremental:true),lease=try plan.excludeUpgrade()
   check(chmod(hosts.path,0)==0,"deny disposable Chrome folder")
   var access:[[String:Any]]=[],events:[[String:String]]=[]
   let result=plan.executeStages(backendStopped:true,loginRemoved:true,exclusion:lease,event:{events.append(["stage":$0,"code":$1])},dataAccess:{access.append($0)})
   check(chmod(hosts.path,0o700)==0,"restore only owned folder")
   check(!result.complete && result.items.contains{$0.code=="ACCESS_DENIED"},"legacy result retains specific remaining items")
   check(!access.isEmpty && events.contains{$0["code"]=="CHROME_DATA_ACCESS_DENIED"},"special classification emitted")
   check(access.allSatisfy{$0["pid"] as? Int == Int(getpid()) && $0["accessor_role"] as? String == "native" && $0["os_attribution"] as? String == "unknown"},"actual accessor metadata, no guessed TCC responsibility")
   check(!fm.fileExists(atPath:app.path) && !fm.fileExists(atPath:cache.path),"other possible steps continue; App last")
   check(fm.fileExists(atPath:state.path) == (mode=="keep"),"mode semantics preserved")
   let text=String(data:try JSONSerialization.data(withJSONObject:access),encoding:.utf8)!
   check(!text.contains(root.path) && !text.contains("fixture"),"no paths or file contents in metadata")
  }
  print("PASS: bounded recovery, cancellation, queued AX deadlines, and two real disposable Chrome denials continue uninstall")
 }
}
