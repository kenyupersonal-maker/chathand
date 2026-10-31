// Optional observations of the ACTUAL native page, never a replacement host or
// credential injector. Has no effect unless the confined rehearsal helper supplies
// a validated temporary directory. No Accessibility or screen capture permission.
import Cocoa
import WebKit
import Darwin

final class RehearsalPageObserver {
 private weak var web:WKWebView?
 private weak var window:NSWindow?
 private let directory:URL
 private let showWindow:()->Void
 private let servicePID:()->Int?
 private let ownerKeyReady:()->Bool
 private let started=ProcessInfo.processInfo.systemUptime
 private var timer:Timer?
 private var sampleInFlight=false
 private var commandID=""
 private var sequence=0
 private var snapshotSequence=0
 private var lastSnapshot=0.0
 private static func physical(_ path:String)->String? {guard let p=realpath(path,nil) else{return nil};defer{free(p)};return String(cString:p)}
 private static func safeDirectory()->URL? {
  let e=ProcessInfo.processInfo.environment
  guard let root=e["CHATHAND_REHEARSAL_ROOT"],let dir=e["CHATHAND_REHEARSAL_PAGE_DIR"],physical(root)==root,physical(dir)==dir,
   root.hasPrefix("/private/tmp/chathand-1060-rehearsal-") || root.hasPrefix((physical(NSTemporaryDirectory()) ?? "__none__")+"/chathand-1060-rehearsal-"),dir.hasPrefix(root+"/") else{return nil}
  for path in [root,dir] {
   guard let a=try? FileManager.default.attributesOfItem(atPath:path),a[.type] as? FileAttributeType == .typeDirectory,
    (a[.ownerAccountID] as? NSNumber)?.uint32Value==getuid(),((a[.posixPermissions] as? NSNumber)?.intValue ?? 0)&0o077==0 else{return nil}
  }
  let marker=URL(fileURLWithPath:root).appendingPathComponent(".rehearsal-root.json")
  guard physical(marker.path)==marker.path,let data=try? Data(contentsOf:marker),let value=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],value["format"] as? Int==1,value["purpose"] as? String=="1060 isolated rehearsal" else{return nil}
  return URL(fileURLWithPath:dir)
 }
 static func attach(web:WKWebView,window:NSWindow,showWindow:@escaping()->Void,servicePID:@escaping()->Int?,ownerKeyReady:@escaping()->Bool = {false})->RehearsalPageObserver? {
  guard let directory=safeDirectory(),!web.configuration.websiteDataStore.isPersistent else{return nil}
  return RehearsalPageObserver(web:web,window:window,directory:directory,showWindow:showWindow,servicePID:servicePID,ownerKeyReady:ownerKeyReady)
 }
 private init(web:WKWebView,window:NSWindow,directory:URL,showWindow:@escaping()->Void,servicePID:@escaping()->Int?,ownerKeyReady:@escaping()->Bool) {
  self.web=web;self.window=window;self.directory=directory;self.showWindow=showWindow;self.servicePID=servicePID;self.ownerKeyReady=ownerKeyReady
  append(["kind":"observer_ready","pid":Int(getpid()),"bundle":Bundle.main.bundleURL.path,"nonpersistent":true,"auth_injected_by_observer":false])
  timer=Timer.scheduledTimer(withTimeInterval:0.5,repeats:true){[weak self]_ in self?.sample()}
 }
 deinit {timer?.invalidate()}
 private func append(_ value:[String:Any]) {
  var row=value;row["monotonic_ms"]=Int((ProcessInfo.processInfo.systemUptime-started)*1000)
  guard var data=try? JSONSerialization.data(withJSONObject:row,options:[.sortedKeys]) else{return};data.append(10)
  let file=directory.appendingPathComponent("page-observations.jsonl")
  let fd=open(file.path,O_WRONLY|O_CREAT|O_APPEND|O_NOFOLLOW,0o600);guard fd>=0 else{return};defer{close(fd)}
  var st=stat();guard fstat(fd,&st)==0,st.st_nlink==1,st.st_uid==getuid() else{return}
  data.withUnsafeBytes{p in if let address=p.baseAddress{_ = write(fd,address,data.count)}}
 }
 private func sample() {
  processCommand()
  guard !sampleInFlight,let web else{return};sampleInFlight=true;sequence+=1
  let sampleID=sequence
  // Read-only evaluation: never set window.webkit, auth, clocks or app state.
  let script="""
  (()=>({ready:document.readyState,origin:location.origin,path:location.pathname,time_origin:performance.timeOrigin,performance_ms:performance.now(),visibility:document.visibilityState,native_bridge:typeof window.webkit?.messageHandlers?.native?.postMessage==='function',native_auth:typeof window.ChatHandAuth?.fetch==='function',stream_status:window.ChatHandStream?.status?.()||null,render_count:window.__renderStats?.renders||0,state_build:typeof S==='object'&&S?S.about?.build:null,state_version:typeof S==='object'&&S?S.version:null,state_instance:typeof S==='object'&&S?S.instance_id:null,main_text:(document.getElementById('main')?.innerText||'').slice(0,2000),header_text:(document.getElementById('valueHeader')?.innerText||'').slice(0,300),site_notice:(document.getElementById('siteNotice')?.innerText||'').slice(0,300)}))()
  """
  web.evaluateJavaScript(script){[weak self] value,error in
   guard let self else{return};self.sampleInFlight=false
   var row:[String:Any]=["kind":"page_sample","sequence":sampleID,"window_visible":self.window?.isVisible ?? false,"backend_pid":self.servicePID() ?? 0,"owner_key_shared":self.ownerKeyReady()]
   if let result=value as? [String:Any]{row["page"]=result}else{row["error"]="JAVASCRIPT_OBSERVATION_FAILED"}
   self.append(row)
  }
  let now=ProcessInfo.processInfo.systemUptime
  if now-lastSnapshot>=5 {lastSnapshot=now;snapshot()}
 }
 private func snapshot() {
  guard let web else{return};snapshotSequence+=1;let id=snapshotSequence
  web.takeSnapshot(with:nil){[weak self] image,error in
   guard let self,let tiff=image?.tiffRepresentation,let bitmap=NSBitmapImageRep(data:tiff),let data=bitmap.representation(using:.png,properties:[:]) else{self?.append(["kind":"snapshot_failed","sequence":id]);return}
   let file=self.directory.appendingPathComponent(String(format:"page-%04d.png",id))
   let fd=open(file.path,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0o600);guard fd>=0 else{return};defer{close(fd)}
   data.withUnsafeBytes{p in if let address=p.baseAddress{_ = write(fd,address,data.count)}}
   self.append(["kind":"snapshot","sequence":id,"file":file.lastPathComponent])
  }
 }
 private func processCommand() {
  let file=directory.appendingPathComponent("page-command.json")
  guard Self.physical(file.path)==file.path,let a=try? FileManager.default.attributesOfItem(atPath:file.path),a[.type] as? FileAttributeType == .typeRegular,(a[.referenceCount] as? NSNumber)?.intValue==1,(a[.size] as? NSNumber)?.intValue ?? 99999<4096,
   let data=try? Data(contentsOf:file),let value=(try? JSONSerialization.jsonObject(with:data)) as? [String:String],Set(value.keys)==Set(["id","action"]),let id=value["id"],UUID(uuidString:id) != nil,id != commandID,let action=value["action"],["hide","show","snapshot","probe-key","relaunch"].contains(action) else{return}
  commandID=id
  if action=="hide" {window?.performClose(nil)}
  if action=="show" {showWindow()}
  if action=="snapshot" {snapshot()}
  if action=="relaunch" {
   web?.callAsyncJavaScript("return await native('relaunchChatHand');",arguments:[:],in:nil,in:.page) {[weak self] outcome in
    guard let self else{return};let result=(try? outcome.get()) as? [String:Any] ?? [:]
    self.append(["kind":"relaunch_reply","id":id,"relaunching":result["relaunching"] as? Bool ?? false,"code":result["error"] as? String ?? "NONE"])
   }
  }
  if action=="probe-key" {
   web?.callAsyncJavaScript("try{const r=await window.ChatHandAuth.fetch('/api/native/state');const j=await r.json();return {authorized:r.ok,status:r.status,code:j.error?.code||'NONE'};}catch{return {authorized:false,status:0,code:'LOCAL_NETWORK'};}",arguments:[:],in:nil,in:.page) {[weak self] outcome in
    guard let self else{return};let result=(try? outcome.get()) as? [String:Any] ?? [:]
    self.append(["kind":"key_probe","id":id,"authorized":result["authorized"] as? Bool ?? false,"status":result["status"] as? Int ?? 0,"code":result["code"] as? String ?? "PROBE_FAILED","owner_key_shared":self.ownerKeyReady()])
   }
  }
  append(["kind":"page_command","id":id,"action":action,"window_visible":window?.isVisible ?? false])
 }
}
