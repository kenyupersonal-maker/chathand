import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'appearance-pure-'));
for(const name of ['home','tmp','cache'])fs.mkdirSync(path.join(dir,name));
function compileRun(files,extra=''){
 const env={...process.env,HOME:path.join(dir,'home'),TMPDIR:path.join(dir,'tmp')+'/',CLANG_MODULE_CACHE_PATH:path.join(dir,'cache'),SWIFT_MODULECACHE_PATH:path.join(dir,'cache')};
 if(extra){fs.writeFileSync(path.join(dir,'probe.swift'),extra);files=[...files,path.join(dir,'probe.swift')];}
 const build=spawnSync('swiftc',[...files,'-module-cache-path',path.join(dir,'cache'),'-o',path.join(dir,'checks')],{cwd:root,env,encoding:'utf8'});
 assert.equal(build.status,0,build.stdout+build.stderr);
 const result=spawnSync(path.join(dir,'checks'),[],{cwd:dir,env,encoding:'utf8'});assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;
}
test('complete native production class serializes physical writes and fences logical intent',()=>{
 assert.match(compileRun(['native/ClientFeatures.swift','test-v1/appearance-transaction-native.swift']),/checks 51: PASS/);
});
test('actual main API expiration is opt-in and releases appearance flight only on real completion',()=>{
 const main=read('native/main.swift'),start=main.indexOf('    func api(_ endpoint:'),end=main.indexOf('    private var setupCompletionFocus',start);
 assert.ok(start>=0&&end>start);const api=main.slice(start,end);
 for(const assignment of ['let nextGeneration = UUID(); backendGeneration = nextGeneration','let generation = UUID(); backendGeneration = generation'])assert.ok(main.includes('invalidateClientAppearance()\n        '+assignment));
 const hookStart=main.indexOf('}, appearanceAPI:')+18,hookEnd=main.indexOf('}, applyAppearance:',hookStart);
 assert.ok(hookStart>=18&&hookEnd>hookStart);const hook=main.slice(hookStart,hookEnd+1).trim();
 const shim=read('test-v1/appearance-transaction-native.swift').split('final class AppearanceFixture')[0].replace('var changeCount:Int {0}', 'static var countReads=0;var changeCount:Int {Self.countReads += 1;return 0}');
 const lazyStart=main.indexOf('    private var clientFeaturesInitialized'),lazyEnd=main.indexOf('    @available(macOS 14.0, *) lazy var permissionAssistant',lazyStart);
 assert.ok(lazyStart>=0&&lazyEnd>lazyStart);const lazy=main.slice(lazyStart,lazyEnd);
 const bridgeStart=main.indexOf('        case "setAppearance":'),bridgeEnd=main.indexOf('        case "windowChrome":',bridgeStart);
 assert.ok(bridgeStart>=0&&bridgeEnd>bridgeStart);const bridge=main.slice(bridgeStart,bridgeEnd);
 const probe=shim+`
import WebKit
// All network and dispatch boundaries shadow Foundation; nothing can send a request.
final class URLSession {
 static let shared=URLSession()
 var replies:[(Data?,URLResponse?,Error?)->Void]=[]
 final class Task {func resume(){}}
 func dataTask(with request:URLRequest,completionHandler:@escaping(Data?,URLResponse?,Error?)->Void)->Task {replies.append(completionHandler);return Task()}
 func reply(_ index:Int){replies[index](try! JSONSerialization.data(withJSONObject:["ok":true]),nil,nil)}
}
enum DispatchQueue {static let main=Queue();struct Queue{func async(execute:()->Void){execute()}}}
enum LocalText {static func text(_ key:String)->String {key}}
enum PageBackgroundSync {static func synchronize(window:NSWindow?,web:WKWebView?){fatalError("real UI forbidden")}}
final class Client {
 var origin="http://127.0.0.1:1234",token="fixture-token",interfaceKey="fixture-key",interfaceKeyShared=false,backendGeneration=0
 var window:NSWindow?=nil,web:WKWebView?=nil
 func refreshZoomMenu(){fatalError("UI forbidden")}
 ${lazy}
 func invalidateForTest(){invalidateClientAppearance()}
 func appearanceBridge(_ data:[String:Any],done:@escaping([String:Any])->Void){switch "setAppearance" {${bridge} default:fatalError("unexpected action")}}
 ${api}
 func appearanceHook()->ClientFeatureCoordinator.API {return ${hook}}
}
@main struct MainChecks {static func main(){
 let cold=Client();precondition(NSPasteboard.countReads==0);cold.invalidateForTest();precondition(NSPasteboard.countReads==0)
 var bridgeCodes:[String]=[]
 for invalid in [true,Double.nan,"bad"] as [Any] {cold.appearanceBridge(["mode":"dark","expires_at":invalid]){bridgeCodes.append($0["error_code"] as? String ?? "unexpected")}}
 precondition(bridgeCodes==["ARG_INVALID","ARG_INVALID","ARG_INVALID"] && NSPasteboard.countReads==0)
 cold.appearanceBridge(["mode":"dark","expires_at":0]){bridgeCodes.append($0["error_code"] as? String ?? "unexpected")}
 precondition(bridgeCodes.last=="NATIVE_TIMEOUT" && URLSession.shared.replies.isEmpty)
 _=cold.clientFeatures;precondition(NSPasteboard.countReads==1);cold.invalidateForTest();precondition(NSPasteboard.countReads==1)
 let client=Client();var ordinary=0,expired=0,done=0
 client.api("/fixture"){_ in ordinary += 1};client.backendGeneration += 1
 precondition(expired==0 && ordinary==0);URLSession.shared.reply(0);precondition(ordinary==0)
 client.api("/fixture",onExpired:{expired += 1}){_ in done += 1};client.backendGeneration += 1
 precondition(expired==0);URLSession.shared.reply(1);precondition(expired==1 && done==0)
 client.api("/fixture",onExpired:{expired += 1}){_ in done += 1};URLSession.shared.reply(2);precondition(expired==1 && done==1)
 var modes:[String]=[],results:[[String:Any]]=[]
 let coordinator=ClientFeatureCoordinator(api:{_,_,_ in fatalError("non appearance")},appearanceAPI:client.appearanceHook(),watcher:ClipboardKeyWatcher(changeCount:{0},read:{fatalError("read")},clear:{fatalError("clear")},submit:{_,_,_ in fatalError("credential")}),applyAppearance:{modes.append($0)})
 coordinator.setAppearance(mode:"dark"){results.append($0)};coordinator.invalidateAppearance();client.backendGeneration += 1
 coordinator.setAppearance(mode:"light"){results.append($0)};precondition(URLSession.shared.replies.count==4)
 URLSession.shared.reply(3);precondition(modes.isEmpty && URLSession.shared.replies.count==5)
 URLSession.shared.reply(4);precondition(modes==["light"] && results.count==2 && results[0]["cancelled"] as? Bool==true)
 coordinator.close();print("main opt-in/default + native roundtrip: PASS")
}}
`;
 assert.match(compileRun(['native/ClientFeatures.swift'],probe),/roundtrip: PASS/);
});
