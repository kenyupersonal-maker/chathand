import Cocoa
import Foundation

@main struct Native1063Checks {
 static func check(_ ok: Bool, _ label: String) { if !ok { fatalError(label) } }
 static func main() throws {
  var at = Date(timeIntervalSince1970: 100), count = 0, text = "", imports = 0, clears = 0
  var rows: [[String]] = [], done: (([String: Any]) -> Void)?
  let line: (String) -> String = { host in "{\"format\":\"chathand-site-v2\",\"site_origin\":\"https://\(host)\",\"site_id\":\"sandboxSite\",\"service_credential\":\"" + String(repeating:"x",count:48) + "\"}" }
  let watcher = ClipboardSiteWatcher(changeCount:{ count }, read:{ text }, clear:{ clears += 1 }, submit:{ _,_,callback in imports += 1; done = callback }, now:{ at }, diagnostic:{ rows.append([$0,$1,$2 ?? ""]) })
  check(watcher.start(id:"intent",expiresAt:at.addingTimeInterval(3600),schedule:false),"pending starts without a window")
  at = at.addingTimeInterval(150); text = line("isolated.chatgpt.site"); count += 1; watcher.tick()
  check(imports == 1,"copy after two and a half minutes submits")
  done?(["error":["code":"B_PAIRING_INTENT_MISMATCH"]]); check(watcher.active && clears == 0,"failed pair retains watch")
  check(rows.last?[1] == "PAIR_FAILED", "pair failure diagnostic")
  text = "bad"; count += 1; watcher.tick(); check(rows.last?[1] == "INVALID_FORMAT", "invalid format diagnostic")
  text = line("invalid.example"); count += 1; watcher.tick(); check(rows.last?[1] == "INVALID_ORIGIN", "invalid origin diagnostic")
  at = at.addingTimeInterval(601); text = line("isolated.chatgpt.site"); count += 1; watcher.tick(); check(imports == 2,"watch survives beyond ten minutes")
  done?(["accepted":true,"phase":"pairing"]); check(watcher.active && clears == 1 && rows.last?[1] == "CODE_ACCEPTED", "accepted code keeps pairing watch alive")
  watcher.synchronize(["watching":false,"stopped_id":"intent","stopped_reason":"paired"])
  check(!watcher.active && rows.last?[1] == "WATCH_PAIRED", "only authoritative pairing success stops watch")
  check(!watcher.start(id:"expired",expiresAt:at.addingTimeInterval(-1),schedule:false),"expired rejected")
  check(rows.last?[1] == "WATCH_EXPIRED","expired diagnostic")
  check(watcher.start(id:"next",expiresAt:at.addingTimeInterval(30),schedule:false),"new intent")
  watcher.synchronize(["watching":false,"stopped_id":"next","stopped_reason":"no_pending"])
  check(!watcher.active && rows.last?[1] == "NO_PENDING","no pending diagnostic")
  let fm = FileManager.default, root = fm.temporaryDirectory.appendingPathComponent("native1063-" + UUID().uuidString), downloads = root.appendingPathComponent("Downloads")
  try fm.createDirectory(at: root,withIntermediateDirectories:true); defer { try? fm.removeItem(at:root) }
  let icon = URL(fileURLWithPath:CommandLine.arguments[1]); check(try PluginIconExport.bytes(icon).count <= 10240,"exact PNG source validates")
  let first = try PluginIconExport.copy(source:icon,downloads:downloads), again = try PluginIconExport.copy(source:icon,downloads:downloads)
  check(first == again && first.lastPathComponent == "ChatHand-icon.png","identical icon reused")
  try Data("user file".utf8).write(to:first)
  let second = try PluginIconExport.copy(source:icon,downloads:downloads); check(second.lastPathComponent == "ChatHand-icon-2.png","different file preserved")
  check(try Data(contentsOf:first) == Data("user file".utf8),"collision never overwritten")
  NativeDiagnostics.record(in:root,phase:"startup",code:"SERVICE_START",backendPID:nil,generation:"isolated",attempt:1)
  let diagnostic = try String(contentsOf:root.appendingPathComponent("diagnostics/native-events.jsonl"),encoding:.utf8)
  check(diagnostic.contains("SERVICE_START") && !diagnostic.contains("service_credential"),"categorical receipt")
  print("PASS: 1063 pending clipboard, long lifecycle, rejections, icon collision and categorical diagnostics")
 }
}
