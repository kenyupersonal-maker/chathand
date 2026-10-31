import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

let requests;
export function nativePermissionRequests(){
 if(requests)return requests;
 const main=fs.readFileSync('native/main.swift','utf8');
 const recovery=main.slice(main.indexOf('        case "openChromeDataAccessSettings":'),main.indexOf('        case "extensionCancel":'));
 const manual=main.slice(main.indexOf('        case "extensionManual":'));
 const call=scope=>{
  const match=scope.match(/(?:self\.)?api\("\/api\/browser\/extension\/prepare",[^\n]+?\)\s*\{/);
  assert.ok(match,'actual native prepare call exists');
  return match[0].slice(0,-1)+' { _ in }';
 };
 // Compile and execute the actual Swift call expressions, retaining their
 // literal dictionaries and Foundation JSON serialization. No App is launched.
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'1070-native-retry-')));
 for(const name of ['home','tmp','cache'])fs.mkdirSync(path.join(root,name));
 const source=`import Foundation
 final class Calls {
 var requests:[[String:Any]]=[]
 func api(_ route:String,_ body:[String:Any],completion:([String:Any])->Void){requests.append(["route":route,"body":body]);completion([:])}
 func recovery(){${call(recovery)}}
 func manual(){${call(manual)}}
 }
 let calls=Calls();calls.recovery();calls.manual()
 FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject:calls.requests))
 `;
 const file=path.join(root,'Requests.swift'),binary=path.join(root,'requests');fs.writeFileSync(file,source);
 const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:path.join(root,'home'),TMPDIR:path.join(root,'tmp'),CLANG_MODULE_CACHE_PATH:path.join(root,'cache')};
 const build=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-module-cache-path',path.join(root,'cache'),file,'-o',binary],{env,encoding:'utf8',timeout:120000});
 assert.equal(build.status,0,build.stderr);
 const run=spawnSync(binary,[],{env,encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr);
 requests=JSON.parse(run.stdout);return requests;
}

