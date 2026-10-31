import Foundation
import Darwin

// Native-only test boundary. No page observer, permissions or formal HOME lookup.
enum RehearsalBackendPaths {
 struct Invalid: Error { let code = "REHEARSAL_BACKEND_PATH_INVALID" }
 private static func physical(_ raw: String) -> String? {
  guard let p=realpath(raw,nil) else{return nil};defer{free(p)};return String(cString:p)
 }
 private static func directory(_ raw: String, privateMode: Bool) throws -> String {
  guard raw.hasPrefix("/"),!raw.contains("\0"),!raw.contains("\n"),!raw.contains("\r"),!raw.contains("//"),!URL(fileURLWithPath:raw).pathComponents.contains("Applications"),physical(raw)==raw else{throw Invalid()}
  let a=try FileManager.default.attributesOfItem(atPath:raw)
  guard a[.type] as? FileAttributeType == .typeDirectory,(a[.ownerAccountID] as? NSNumber)?.uint32Value==getuid(),!privateMode || ((a[.posixPermissions] as? NSNumber)?.intValue ?? 0)&0o077==0 else{throw Invalid()}
  return raw
 }
 static func environment(source: [String:String], statePath: String, appPath: String) throws -> [String:String] {
  guard source["CHATHAND_REHEARSAL_ROOT"] != nil || source["CHATHAND_REHEARSAL_HOME"] != nil else{return [:]}
  guard let rawRoot=source["CHATHAND_REHEARSAL_ROOT"],let rawHome=source["CHATHAND_REHEARSAL_HOME"] else{throw Invalid()}
  guard let temporary=physical("/tmp"),rawRoot.hasPrefix(temporary+"/"),URL(fileURLWithPath:rawRoot).lastPathComponent.range(of:"^chathand-1060-rehearsal-[A-Za-z0-9_-]+$",options:.regularExpression) != nil,[rawHome,statePath,appPath].allSatisfy({$0.hasPrefix(rawRoot+"/")}) else{throw Invalid()}
  let root=try directory(rawRoot,privateMode:true),home=try directory(rawHome,privateMode:true)
  let state=try directory(statePath,privateMode:true),app=try directory(appPath,privateMode:false)
  guard source["CHATHAND_STATE_DIR"]==state,[home,state,app].allSatisfy({$0.hasPrefix(root+"/")}) else{throw Invalid()}
  let paths=[home,state,app]
  for i in 0..<paths.count {for j in (i+1)..<paths.count {guard paths[i] != paths[j],!paths[i].hasPrefix(paths[j]+"/"),!paths[j].hasPrefix(paths[i]+"/") else{throw Invalid()}}}
  let marker=root+"/.rehearsal-root.json",a=try FileManager.default.attributesOfItem(atPath:marker)
  guard physical(marker)==marker,a[.type] as? FileAttributeType == .typeRegular,(a[.referenceCount] as? NSNumber)?.intValue==1,(a[.ownerAccountID] as? NSNumber)?.uint32Value==getuid(),((a[.posixPermissions] as? NSNumber)?.intValue ?? 0)&0o077==0,(a[.size] as? NSNumber)?.intValue ?? 99999 <= 4096 else{throw Invalid()}
  let data=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:marker))) as? [String:Any]
  guard data?["format"] as? Int==1,data?["purpose"] as? String=="1060 isolated rehearsal" else{throw Invalid()}
  // Foundation's user-home API can still be formal in an isolated GUI process.
  // Override only after the native root/home/state/App binding is verified.
  return ["HOME":home,"CFFIXED_USER_HOME":home,"TMPDIR":home,"CHATHAND_REHEARSAL_ROOT":root,"CHATHAND_REHEARSAL_HOME":home]
 }
}
