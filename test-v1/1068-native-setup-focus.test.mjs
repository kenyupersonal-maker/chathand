import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('native setup presentation preserves background launches and activates only an existing ChatGPT',{skip:process.platform!=='darwin',timeout:120000},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1068-focus-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'main.swift'),binary=path.join(root,'focus-check');
 fs.writeFileSync(source,`import AppKit
import Foundation
@main struct Checks {
 static func main() {
  let now=2_000_000.0
  let live:[String:Any]=["active":true,"last_at":now-1_000]
  let idle:[String:Any]=["active":false,"last_at":now-1_000]
  func check(_ value:Bool,_ label:String) {if !value {fputs("FAIL: \\(label)\\n",stderr);exit(1)}}
  check(!ClientFeatures.shouldActivateWindow(userRequested:false,appIsActive:false,setupActivity:nil,nowMS:now),"unknown startup stays background")
  check(!ClientFeatures.shouldActivateWindow(userRequested:false,appIsActive:true,setupActivity:live,nowMS:now),"setup never asks to activate")
  check(!ClientFeatures.shouldActivateWindow(userRequested:false,appIsActive:false,setupActivity:idle,nowMS:now),"idle auto-open does not switch apps")
  check(ClientFeatures.shouldActivateWindow(userRequested:true,appIsActive:false,setupActivity:live,nowMS:now),"explicit menu/Dock request wins")
  check(ClientFeatures.shouldActivateWindow(userRequested:false,appIsActive:true,setupActivity:idle,nowMS:now),"already-active normal window can become key")
  check(ClientFeatures.shouldActivateWindow(userRequested:false,appIsActive:true,setupActivity:["active":true,"last_at":now-900_000],nowMS:now),"stale setup does not suppress an already-active app")
  var calls=0
  check(ClientFeatures.activateChatGPT(find:{nil})["activated"] as? Bool == false,"not running means no launch")
  check(ClientFeatures.activateChatGPT(find:{{calls+=1;return true}})["activated"] as? Bool == true,"activate existing instance")
  check(calls==1,"one existing activation only")
  check(ClientFeatures.activateChatGPT(find:{{calls+=1;return false}})["activated"] as? Bool == false,"activation failure is explicit")
  check(calls==2,"failed activation not retried or relaunched")
  print("PASS: background setup and existing ChatGPT activation")
 }
}
`);
 const compile=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','-module-cache-path',path.join(root,'cache'),'-framework','Cocoa','-framework','WebKit','native/ClientFeatures.swift','native/WindowChrome.swift',source,'-o',binary],{encoding:'utf8',timeout:90000});
 assert.equal(compile.status,0,compile.stderr);
 const run=spawnSync(binary,[],{encoding:'utf8',timeout:5000});
 assert.equal(run.status,0,run.stderr);
 assert.match(run.stdout,/PASS: background setup and existing ChatGPT activation/);
});

test('the native shell carries background intent through startup, reopen and instance wake without launching a new ChatGPT',()=>{
 const main=fs.readFileSync(new URL('../native/main.swift',import.meta.url),'utf8');
 const features=fs.readFileSync(new URL('../native/ClientFeatures.swift',import.meta.url),'utf8');
 const instance=fs.readFileSync(new URL('../native/InstanceLifecycle.swift',import.meta.url),'utf8');
 const automatic=main.slice(main.indexOf('func showAutomatically()'),main.indexOf('func windowShouldClose'));
 assert.match(automatic,/ClientFeatures\.shouldActivateWindow/);
 assert.match(automatic,/state\["setup_activity"\]/);
 assert.doesNotMatch(automatic,/NSApp\.activate/);
 assert.match(main,/showAutomatically\(\)\s+nativeRecord\("startup", "WINDOW_SHOWN"\)/);
 assert.match(main,/if sender\.isActive \{show\(\)\} else \{showAutomatically\(\)\}/);
 assert.equal((main.match(/activateExisting:activateExisting/g)||[]).length,2);
 assert.match(instance,/userInfo:\["activate":activate\]/);
 assert.match(instance,/config\.activates=activate/);
 const bridge=main.slice(main.indexOf('case "activateChatGPT":'),main.indexOf('case "openChatGPT":'));
 assert.match(bridge,/guard data\.isEmpty/);
 assert.match(bridge,/ClientFeatures\.activateChatGPT\(\)/);
 const activate=features.slice(features.indexOf('static func activateChatGPT('),features.indexOf('static let uiZoomKey'));
 assert.match(activate,/runningApplications/);
 assert.match(activate,/bundleIdentifier == "com\.openai\.chat"/);
 assert.doesNotMatch(activate,/openURL|openApplication|promptURL|\.launch\(/);
});
