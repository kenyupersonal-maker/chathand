import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {installSkill} from '../app/v09/local-setup.mjs';

test('staged uninstall really removes disposable files in both modes and continues past denied Chrome access',{skip:process.platform!=='darwin',timeout:150000},t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-uninstall-stage-'));const fixtures=path.join(dir,'homes');
 t.after(()=>{for(const relative of ['blocked/Library/Application Support/Google/Chrome/NativeMessagingHosts','audit/Library/Logs']){const target=path.join(fixtures,relative);try{if(fs.lstatSync(target).isDirectory())fs.chmodSync(target,0o700);}catch{}}fs.rmSync(dir,{recursive:true,force:true});});
 for(const mode of ['keep','delete']){const home=path.join(fixtures,mode);installSkill({home,codexHome:path.join(home,'.codex')});}
 const binary=path.join(dir,'checks');
 const build=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-module-cache-path',path.join(dir,'cache'),'-parse-as-library','native/ChatHandUninstall.swift','native/NativeDiagnostics.swift','native/BuildVersion.swift','native/tests/UninstallStagesChecks.swift','-o',binary],{encoding:'utf8',timeout:120000});
 assert.equal(build.status,0,build.stderr);
 const result=spawnSync(binary,[],{encoding:'utf8',timeout:20000,env:{...process.env,CHATHAND_UNINSTALL_FIXTURE_ROOT:fixtures}});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PASS: actual staged/);console.log(result.stdout.trim());
});
test('installed setup skill receives a private ownership marker in the atomic staging transaction',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-skill-owned-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const codexHome=path.join(home,'.codex');const installed=installSkill({home,codexHome});
 const marker=path.join(installed.path,'.chathand-owned.json');assert.deepEqual(JSON.parse(fs.readFileSync(marker,'utf8')),{format:1,owner:'com.kenyu.chathand',kind:'setup-skill'});assert.equal(fs.statSync(marker).mode&0o777,0o600);assert.ok(fs.existsSync(path.join(installed.path,'SKILL.md')));
 const original=fs.readFileSync(marker);const second=installSkill({home,codexHome});assert.deepEqual(fs.readFileSync(path.join(second.backup_path,'.chathand-owned.json')),original);assert.deepEqual(fs.readFileSync(marker),original);
});
test('uninstall stays native-menu-only and uses staged results instead of the fail-fast filesystem API',()=>{
 const main=fs.readFileSync('native/main.swift','utf8');const menu=main.slice(main.indexOf('@objc private func uninstallChatHand'),main.indexOf('@MainActor private func stopForUninstall'));
 assert.ok(menu.includes('incremental: true'));assert.ok(menu.includes('plan.executeStages('));assert.ok(menu.includes('LoginItemService.uninstallReason'));assert.ok(menu.includes('native.uninstall.remainingTitle'));assert.ok(menu.includes('native.uninstall.auditTitle'));
 assert.ok(!main.slice(main.indexOf('switch action')).includes('case "uninstallChatHand"'));
});
