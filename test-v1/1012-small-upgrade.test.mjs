import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {archiveUpgradeBackups,createUpgradeRunner,retainedUpgradeSetting} from '../scripts/upgrade.mjs';
import {assertTemporaryUpdatePaths} from '../app/v1/client-features.mjs';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1012-backups-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const backups=path.join(root,'upgrades');fs.mkdirSync(backups);return {root,backups,destination:path.join(root,'ChatHand.app'),stateDir:path.join(root,'state')};}
function transaction(f,index,patch={}){const created=`2026-10-0${index}T00:00:00.000Z`,id=created.replace(/[:.]/g,'-')+'-abcd000'+index,dir=path.join(f.backups,id);fs.mkdirSync(dir);fs.mkdirSync(path.join(dir,'previous.app'));fs.mkdirSync(path.join(dir,'state-backup'));fs.writeFileSync(path.join(dir,'previous.app','original'),'unchanged');fs.writeFileSync(path.join(dir,'journal.json'),JSON.stringify({format:1,id,phase:'committed',destination:f.destination,stateDir:f.stateDir,appBackup:path.join(dir,'previous.app'),stateBackup:path.join(dir,'state-backup'),hadApp:true,created,...patch}));return dir;}
test('upgrade verification accepts new defaults and retains explicit old preferences',()=>{
 for(const [before,after,field,expected] of [[{},{appearance:'system'},'appearance',true],[{},{auto_update:true},'auto_update',true],[{},{appearance:'invalid'},'appearance',false],[{},{},'auto_update',false],[{appearance:'dark'},{appearance:'light'},'appearance',false],[{auto_update:false},{auto_update:true},'auto_update',false],[{auto_update:false},{auto_update:false},'auto_update',true],[{projects:[1]},{projects:[2]},'projects',false]])assert.equal(retainedUpgradeSetting(before,after,field),expected);
});
test('self-check success archives only older own backups and retains the newest; no deletion',t=>{
 const f=fixture(t),old=transaction(f,1),newest=transaction(f,2),foreign=transaction(f,3,{destination:path.join(f.root,'VoicePointer.app')});
 assert.deepEqual(archiveUpgradeBackups({backupRoot:f.backups,currentTransaction:newest}),{moved:[],retained:null});assert.equal(fs.existsSync(old),true);
 const result=archiveUpgradeBackups({backupRoot:f.backups,currentTransaction:newest,verified:true,now:new Date('2026-10-02')});assert.equal(result.retained,newest);assert.equal(result.moved.length,1);assert.match(result.moved[0],/_待清理-2026-10-02\.noindex/);assert.equal(fs.readFileSync(path.join(result.moved[0],'previous.app','original'),'utf8'),'unchanged');assert.equal(fs.existsSync(foreign),true);assert.equal(fs.existsSync(newest),true);assert.equal(archiveUpgradeBackups({backupRoot:f.backups,currentTransaction:newest,verified:true}).moved.length,0);
});
test('unfinished, wrong format, foreign state, forged paths and symlink backups stay untouched',t=>{
 const f=fixture(t),newest=transaction(f,7);
 const patches=[{phase:'verifying'},{format:2},{stateDir:path.join(f.root,'foreign')},{appBackup:path.join(f.root,'foreign.app')},{hadApp:false}];
 const untouched=patches.map((patch,i)=>transaction(f,i+1,patch));const linked=transaction(f,6);fs.rmSync(path.join(linked,'previous.app'),{recursive:true});fs.symlinkSync(f.root,path.join(linked,'previous.app'));
 assert.equal(archiveUpgradeBackups({backupRoot:f.backups,currentTransaction:newest,verified:true}).moved.length,0);for(const dir of [...untouched,linked])assert.equal(fs.existsSync(dir),true);
 const file=path.join(newest,'journal.json'),j=JSON.parse(fs.readFileSync(file));j.created='invalid';fs.writeFileSync(file,JSON.stringify(j));assert.deepEqual(archiveUpgradeBackups({backupRoot:f.backups,currentTransaction:newest,verified:true}),{moved:[],retained:null});
});
test('temporary path guard rejects daily destinations and symlinks; imported runner cannot run by default',async t=>{
 const f=fixture(t);assertTemporaryUpdatePaths(f.root,path.join(f.root,'uncreated'));for(const file of ['/Applications/ChatHand.app',path.join(os.homedir(),'Downloads','ChatHand.dmg')])assert.throws(()=>assertTemporaryUpdatePaths(file),/ISOLATED_UPDATE_PATH_REQUIRED/);
 fs.symlinkSync(os.homedir(),path.join(f.root,'escape'));assert.throws(()=>assertTemporaryUpdatePaths(path.join(f.root,'escape','uncreated.app')),/ISOLATED_UPDATE_PATH_REQUIRED/);
 const runner=createUpgradeRunner({packageRoot:f.root,destination:f.destination,stateDir:f.stateDir,backupRoot:f.backups});await assert.rejects(runner.run('--install'),/UPGRADE_LIFECYCLE_NOT_AUTHORIZED/);assert.equal(fs.existsSync(f.stateDir),false);
 const unsafe=createUpgradeRunner({packageRoot:f.root,destination:'/Applications/ChatHand.app',stateDir:f.stateDir,backupRoot:f.backups,isolatedLaunch:true,allowLifecycle:true});await assert.rejects(unsafe.run('--install'),/ISOLATED_UPDATE_PATH_REQUIRED/);assert.equal(fs.existsSync(f.stateDir),false);
});
