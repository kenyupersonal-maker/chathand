import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
test('native extension details uses app-owned ID and rejects all caller data',{skip:process.platform!=='darwin',timeout:150000},t=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-details-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const source=path.join(dir,'Checks.swift'),bin=path.join(dir,'checks');
 fs.writeFileSync(source,`import Foundation
 @main struct Checks {static func main() throws {let id=String(repeating:"a",count:32);let config:[String:Any]=["distribution":"chrome_web_store","extension_id":id];assert(try ChromeExtensionDetailsPolicy.target(data:[:],configuration:config).absoluteString == "chrome://extensions/?id="+id)
 for bad:[String:Any] in [["id":id],["url":"https://example.com"],["unused":false]] {do {_=try ChromeExtensionDetailsPolicy.target(data:bad,configuration:config);fatalError("accepted caller data")}catch{assert((error as NSError).userInfo["error_code"] as? String == "ARG_INVALID")}}
 for bad in ["",id+"/",String(repeating:"z",count:32)] {do {_=try ChromeExtensionDetailsPolicy.target(data:[:],configuration:["distribution":"chrome_web_store","extension_id":bad]);fatalError("accepted invalid id")}catch{}}
 print("PASS native details checks")}}
 `.replace('assert(try ChromeExtensionDetailsPolicy.target(data:[:],configuration:config).absoluteString == "chrome://extensions/?id="+id)','let target=try ChromeExtensionDetailsPolicy.target(data:[:],configuration:config);assert(target.absoluteString == "chrome://extensions/?id="+id)'));
 const build=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-DCHATHAND_INSTALL_PURE_TEST','-parse-as-library','native/LocalText.swift','native/ChromeHelperInstall.swift',source,'-o',bin],{encoding:'utf8',timeout:120000});assert.equal(build.status,0,build.stderr);const run=spawnSync(bin,[],{encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS/);
});
