import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generate,extensionManifestVersion} from '../scripts/generate-version.mjs';

test('App release generation preserves the independently published store package version and public key',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-store-version-'));
 const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
 pkg.version='9.0.0-beta.9';pkg.kenBridge.build_number=70000;
 const manifest={...JSON.parse(fs.readFileSync('browser-extension/manifest.json','utf8')),version:'3.2.1',version_name:'Store release'};
 for(const [rel,value]of Object.entries({'package.json':pkg,'browser-extension/manifest.json':manifest,'connectors/browser-extension.json':{distribution:'chrome_web_store'},'plugins/chathand/.codex-plugin/plugin.json':{version:'1.0.0'}})){
  const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
 }
 generate(root);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'browser-extension/manifest.json'),'utf8')),manifest);
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'plugins/chathand/.codex-plugin/plugin.json'),'utf8')).version,pkg.version);
 assert.match(fs.readFileSync(path.join(root,'native/BuildVersion.swift'),'utf8'),/buildNumber = 70000/);
 assert.doesNotThrow(()=>generate(root,true));
});

test('missing store configuration never silently enables App-coupled legacy version generation',()=>{
 const pkg={version:'9.0.0',kenBridge:{build_number:9999}},manifest={version:'1.0.0.1080',version_name:'Original store build'};
 for(const config of [null,{}, {distribution:'chrome_web_store'}])assert.deepEqual(extensionManifestVersion(pkg,manifest,config),manifest);
 assert.deepEqual(extensionManifestVersion(pkg,manifest,{distribution:'legacy_unpacked'}),{version:'9.0.0.9999',version_name:'9.0.0 (9999)'});
});

test('store version validation rejects malformed or missing versions without inventing an App-derived replacement',()=>{
 for(const version of [undefined,'','1.2.3\n','01.2','1.2.3.4.5','65536.1','0.0.0','1.beta'])assert.throws(()=>extensionManifestVersion({},{version},{distribution:'chrome_web_store'}),/STORE_EXTENSION_VERSION_REQUIRED/);
});
