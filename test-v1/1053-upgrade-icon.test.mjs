import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createUpgradeRunner} from '../scripts/upgrade.mjs';
import {upgradeTransaction} from '../app/v07/upgrade-transaction.mjs';

const touch='/usr/bin/touch';
const register='/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
function fixture(t,{name='ChatHand.app',failure=null}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-icon-refresh-'));
 t.after(()=>fs.renameSync(root,root+'_待清理.noindex'));
 const packageRoot=path.join(root,'package'),candidate=path.join(packageRoot,'ChatHand.app'),destination=path.join(root,'installed',name),stateDir=path.join(root,'state'),backupRoot=path.join(root,'backups');
 for(const p of [candidate,destination,stateDir])fs.mkdirSync(p,{recursive:true});
 fs.writeFileSync(path.join(candidate,'version'),'new');fs.writeFileSync(path.join(destination,'version'),'old');
 const calls=[],warnings=[];
 const runner=createUpgradeRunner({packageRoot,destination,stateDir,backupRoot,isolatedLaunch:true,
  executeCommand(program,args,options){
   calls.push({program,args,options,version:fs.readFileSync(path.join(destination,'version'),'utf8')});
   if(program===touch||program===register){
    assert.equal(JSON.parse(fs.readFileSync(path.join(backupRoot,'current.json'))).phase,'new_installed');
    assert.equal(options.timeout,3000);assert.equal(options.maxBuffer,4096);assert.equal(options.stdio,'ignore');
    if(failure?.program===program){if(failure.throws)throw Object.assign(Error('private path and output must not leak'),{code:'ETIMEDOUT'});return {status:1,stderr:'private diagnostic'};}
   }
   return {status:0,stdout:''};
  },iconWarning:code=>warnings.push(code)});
 const hooks={validate:async()=>{},stop:async()=>{},migrate:async()=>{},start:runner.hooks.start,verify:async()=>({healthy:true})};
 return {root,candidate,destination,stateDir,backupRoot,calls,warnings,runner,hooks};
}
test('replacement precedes bounded touch, registration and exact helper start',async t=>{
 const f=fixture(t),result=await upgradeTransaction(f);
 assert.equal(result.status,'COMMITTED');assert.deepEqual(f.calls.map(c=>c.program),[touch,register,path.join(path.dirname(f.candidate),'ChatHand.app/Contents/Resources/runtime/bin/ken-upgrade-control')]);
 assert.deepEqual(f.calls.map(c=>c.args),[[f.destination],['-f',f.destination],['start',f.destination,'--upgrade-verification']]);
 assert.ok(f.calls.every(c=>c.version==='new'));assert.deepEqual(f.warnings,[]);
});
for(const failure of [{program:touch,throws:true},{program:register,throws:false}])test('metadata failure still starts and commits: '+path.basename(failure.program),async t=>{
 const f=fixture(t,{failure}),result=await upgradeTransaction(f);
 assert.equal(result.status,'COMMITTED');assert.equal(f.calls.length,3);assert.equal(f.calls[2].args[0],'start');
 assert.deepEqual(f.warnings,[failure.program===touch?'UPGRADE_ICON_TOUCH_FAILED':'UPGRADE_ICON_REGISTER_FAILED']);
 assert.equal(fs.readFileSync(path.join(f.destination,'version'),'utf8'),'new');
});
test('alternate path, recovery start and non-ChatHand basename never refresh metadata',async t=>{
 const f=fixture(t);await f.runner.hooks.start(path.join(f.root,'Other.app'),true);await f.runner.hooks.start(f.destination,false);
 assert.ok(f.calls.every(c=>c.program!==touch&&c.program!==register));
 const other=fixture(t,{name:'Other.app'});assert.equal((await upgradeTransaction(other)).status,'COMMITTED');assert.equal(other.calls.length,1);
});
test('symlink destination never refreshes metadata',async t=>{
 const f=fixture(t);fs.renameSync(f.destination,f.destination+'.actual');fs.symlinkSync(f.destination+'.actual',f.destination);
 await f.runner.hooks.start(f.destination,true);assert.equal(f.calls.length,1);assert.equal(f.calls[0].args[0],'start');
});
