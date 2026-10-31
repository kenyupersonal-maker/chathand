import Foundation
import Darwin

@main
struct BrowserHostMain {
    static func main() {
// Chrome invokes this executable with a pinned extension origin. JSON framing is handled by Node.
let executable=URL(fileURLWithPath:CommandLine.arguments[0]).standardizedFileURL.resolvingSymlinksInPath()
let runtime=executable.deletingLastPathComponent().deletingLastPathComponent()
if CommandLine.arguments.contains("--self-check") {print("{\"component\":\"browser-native-host\",\"framing\":\"node-stdio\"}");exit(0)}
guard CommandLine.arguments.count>=2,let data=try? Data(contentsOf:runtime.appendingPathComponent("connectors/browser-extension.json")),let config=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let id=config["extension_id"] as? String,CommandLine.arguments[1]=="chrome-extension://\(id)/" else{exit(2)}
let currentNode=runtime.appendingPathComponent("bin/ChatHandNode").path
let node=FileManager.default.isExecutableFile(atPath:currentNode) ? currentNode : runtime.appendingPathComponent("bin/node").path
let script=runtime.appendingPathComponent("app/v09/extension-host.mjs").path
let strings: [String] = [node,script,CommandLine.arguments[1]]
let values: [UnsafeMutablePointer<CChar>?] = strings.map { value in value.withCString { strdup($0) } }
var args=values+[nil]
// Do not inherit provider secrets from a launching shell; keep only basic native environment.
let home=FileManager.default.homeDirectoryForCurrentUser.path
let systemLocale = LocalText.systemLocale
// Match the desktop's explicit state override for isolated development/acceptance.
// Chrome pages cannot set this environment variable; normal launches use saved state.
let stateOverride=ProcessInfo.processInfo.environment["CHATHAND_STATE_DIR"] ?? ProcessInfo.processInfo.environment["KEN_BRIDGE_STATE_DIR"]
for key in ProcessInfo.processInfo.environment.keys {unsetenv(key)};setenv("HOME",home,1);setenv("PATH","/usr/bin:/bin:/usr/sbin:/sbin",1);setenv("LANG","en_US.UTF-8",1)
setenv("CHATHAND_SYSTEM_LOCALE",systemLocale,1)
if let stateOverride, stateOverride.hasPrefix("/"), !stateOverride.contains("\0") {setenv("CHATHAND_STATE_DIR",stateOverride,1);setenv("KEN_BRIDGE_STATE_DIR",stateOverride,1)}
args.withUnsafeMutableBufferPointer{buffer in _=execv(node,buffer.baseAddress!)}
for p in values{free(p)}
exit(3)

    }
}
