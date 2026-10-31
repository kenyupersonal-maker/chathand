// Exact read-only process/window metadata; no UI input or app launch.
import Cocoa
import CoreGraphics
import Darwin
let pid=pid_t(CommandLine.arguments[1])!,root=CommandLine.arguments[2],expected=CommandLine.arguments[3]
func physical(_ raw:String)->String?{guard let p=realpath(raw,nil) else{return nil};defer{free(p)};return String(cString:p)}
func emit(_ row:[String:Any]){print(String(data:try! JSONSerialization.data(withJSONObject:row,options:[.sortedKeys]),encoding:.utf8)!)}
guard root.hasPrefix("/private/tmp/chathand-1060-rehearsal-1064-"),physical(root)==root,physical(expected)==expected,expected.hasPrefix(root+"/"),let marker=try? Data(contentsOf:URL(fileURLWithPath:root+"/.rehearsal-root.json")),let parsed=(try? JSONSerialization.jsonObject(with:marker)) as? [String:Any],parsed["format"] as? Int==1,parsed["purpose"] as? String=="1060 isolated rehearsal" else{emit(["valid":false,"code":"TEMP_ROOT_REQUIRED"]);exit(2)}
var buffer=[CChar](repeating:0,count:4*Int(MAXPATHLEN));guard proc_pidpath(pid,&buffer,UInt32(buffer.count))>0 else{emit(["valid":false,"present":false,"pid":Int(pid)]);exit(0)}
let executable=String(cString:buffer)
guard executable.hasPrefix(expected+"/Contents/MacOS/") else{emit(["valid":false,"code":"PID_PATH_MISMATCH"]);exit(2)}
let app=NSWorkspace.shared.runningApplications.first{$0.processIdentifier==pid}
let windows=(CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []).filter{($0[kCGWindowOwnerPID as String] as? Int)==Int(pid)}.map{w -> [String:Any] in ["id":w[kCGWindowNumber as String] ?? 0,"layer":w[kCGWindowLayer as String] ?? -1,"onscreen":w[kCGWindowIsOnscreen as String] ?? false,"bounds":w[kCGWindowBounds as String] ?? [:]]}
let visible=windows.contains{w in let b=w["bounds"] as? [String:Any] ?? [:];return (w["onscreen"] as? Bool)==true&&(w["layer"] as? Int)==0&&(b["Width"] as? Double ?? 0)>0&&(b["Height"] as? Double ?? 0)>0}
let registered=physical(app?.bundleURL?.path ?? "")==expected
emit(["at":ISO8601DateFormatter().string(from:Date()),"pid":Int(pid),"executable":executable,"registered_bundle":app?.bundleURL?.path ?? "","windows":windows,"valid":registered&&visible,"method":"read_only_CGWindowList_NSWorkspace","input_sent":false])
