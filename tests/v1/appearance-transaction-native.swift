import AppKit
import Foundation
// Own module shadows the imported pasteboard type, including the Site watcher
// constructor's changeCount call. No real clipboard or UI may be reached.
final class NSPasteboard {
 enum Kind {case string}
 static let general=NSPasteboard()
 var changeCount:Int {0}
 func string(forType:Kind)->String? {fatalError("clipboard value read forbidden")}
 func clearContents(){fatalError("clipboard clear forbidden")}
 func setString(_ value:String,forType:Kind)->Bool {fatalError("clipboard write forbidden")}
}
enum WindowChrome {static func place(_ window:NSWindow){fatalError("window operation forbidden")}}
final class AppearanceFixture {
 var date = Date(timeIntervalSince1970: 100)
 var calls: [(String, ([String:Any]) -> Void)] = []
 var modes: [String] = [], replies: [[String:Any]] = []
 lazy var coordinator = ClientFeatureCoordinator(api: { _,_,_ in fatalError("non-appearance API forbidden") }, appearanceAPI: { [unowned self] route,body,reply in
  precondition(route == "/api/settings" && body.count == 1)
  self.calls.append((body["appearance"] as! String, reply))
 }, appearanceNow: { [unowned self] in self.date }, watcher: ClipboardKeyWatcher(changeCount:{0},read:{fatalError("read forbidden")},clear:{fatalError("clear forbidden")},submit:{_,_,_ in fatalError("credential request forbidden")}), applyAppearance:{[unowned self] in self.modes.append($0)})
 func select(_ mode: String, expiresAt: Date? = nil) { coordinator.setAppearance(mode:mode,expiresAt:expiresAt){[unowned self] in self.replies.append($0)} }
 func state(_ mode: String) { coordinator.synchronize(state:["settings":["appearance":mode]]) }
 deinit { coordinator.close() }
}
@main struct AppearanceChecks {
 static func main() {
  var checks=0
  func check(_ value: @autoclosure () -> Bool, _ label: String) { checks += 1; if !value() {fatalError("FAIL: " + label)} }
  for oldFailed in [false,true] {
   let f=AppearanceFixture();f.select("dark");f.select("light")
   check(f.calls.map{$0.0} == ["dark"],"only one physical write before completion")
   check(f.replies.count==1 && f.replies[0]["superseded"] as? Bool == true,"older logical intent superseded")
   f.calls[0].1(oldFailed ? ["error_code":"LOCAL_NETWORK"] : ["ok":true])
   check(f.calls.map{$0.0} == ["dark","light"],"latest write waits real completion")
   check(f.modes.isEmpty,"superseded success/failure cannot apply")
   f.calls[1].1(["ok":true]);check(f.modes==["light"],"latest appearance applied")
   check(f.replies.count==2 && f.replies[1]["mode"] as? String == "light","latest completion")
   f.calls[0].1(["ok":true]);check(f.modes==["light"] && f.replies.count==2,"duplicate old callback ignored")
  }
  do {
   let f=AppearanceFixture();f.select("dark");f.select("light");f.select("system")
   check(f.replies.count==2 && f.replies.allSatisfy{$0["superseded"] as? Bool == true},"queued intent coalesces")
   f.calls[0].1(["ok":true]);check(f.calls.map{$0.0} == ["dark","system"],"never issue superseded queued write")
   f.calls[1].1(["ok":true]);check(f.modes==["system"],"coalesced latest success")
  }
  for oldReply in [["ok":true],["error_code":"LOCAL_NETWORK"],["cancelled":true,"delivery_unconfirmed":true]] as [[String:Any]] {
   let f=AppearanceFixture();f.select("dark");f.coordinator.serviceUnavailable()
   check(f.replies.count==1 && f.replies[0]["cancelled"] as? Bool == true,"service loss cancels logical intent immediately")
   f.state("light");check(f.modes==["light"],"recovered state applies")
   f.select("system");check(f.calls.count==1,"new service waits existing physical flight")
   f.calls[0].1(oldReply);check(f.modes==["light"] && f.calls.count==2,"old response releases barrier without apply")
   f.calls[1].1(["ok":true]);check(f.modes==["light","system"],"new service selection recovers normally")
  }
  do {
   let f=AppearanceFixture();f.state("system");f.select("dark");f.state("light")
   check(f.modes==["system"],"ordinary snapshot cannot override pending selection")
   f.calls[0].1(["ok":true]);check(f.modes==["system","dark"],"ordinary snapshot does not cancel intent")
  }
  do {
   let f=AppearanceFixture();f.select("dark");f.date=f.date.addingTimeInterval(1);f.select("light")
   f.date=f.date.addingTimeInterval(30);f.state("system")
   check(f.modes==["system"] && f.calls.count==1,"expired intent permits state sync, retains physical barrier")
   f.calls[0].1(["ok":true]);check(f.calls.count==1 && f.modes==["system"],"expired queued intent never sent")
   check(f.replies.last?["error_code"] as? String == "NATIVE_TIMEOUT","expired queued intent reports failure")
  }
  do {
   let f=AppearanceFixture();f.select("dark");f.date=f.date.addingTimeInterval(31)
   check(f.calls.count==1 && f.replies.isEmpty,"clock alone never fakes network completion")
   f.calls[0].1(["ok":true]);check(f.modes.isEmpty,"expired flight cannot apply")
   check(f.replies[0]["error_code"] as? String == "NATIVE_TIMEOUT" && f.replies[0]["delivery_unconfirmed"] as? Bool == true,"expired flight retains delivery uncertainty")
   f.select("light");f.calls[1].1(["ok":true]);check(f.modes==["light"],"normal recovery after timeout")
  }
  do {
   let f=AppearanceFixture();f.select("dark",expiresAt:f.date)
   check(f.calls.isEmpty && f.replies[0]["error_code"] as? String == "NATIVE_TIMEOUT","already expired never starts")
   f.select("light",expiresAt:f.date.addingTimeInterval(90));f.date=f.date.addingTimeInterval(31);f.calls[0].1(["ok":true])
   check(f.modes.isEmpty,"caller cannot extend existing 30 second policy")
  }
  for mode in ["light","dark","system"] {
   let f=AppearanceFixture();f.select(mode);f.calls[0].1(["ok":true]);check(f.modes==[mode] && f.replies[0]["mode"] as? String==mode,"normal mode succeeds")
  }
  do {
   let f=AppearanceFixture();f.select("dark");f.calls[0].1(["error_code":"LOCAL_NETWORK"])
   check(f.modes.isEmpty && f.replies[0]["error_code"] as? String=="LOCAL_NETWORK","latest failure does not apply or rollback persist")
   check(f.calls.count==1,"no retry or compensating write")
   f.select("light");f.calls[1].1(["ok":true]);check(f.modes==["light"],"normal selection after failure")
  }
  do {
   let f=AppearanceFixture();f.select("dark");f.select("light");f.coordinator.close();f.calls[0].1(["ok":true]);f.select("system")
   check(f.calls.count==1 && f.modes.isEmpty,"close never starts queued or new writes")
   check(f.replies.last?["error_code"] as? String=="ARG_INVALID","closed coordinator rejects selection")
  }
  print("appearance transaction checks \(checks): PASS; complete production class; fake API/pasteboard/window only")
 }
}
