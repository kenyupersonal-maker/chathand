import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {MatterStore} from '../../app/v1/matters.mjs';
import {createDesktop} from '../../app/server.mjs';

const RAW='只供临时测试的永久删除原文';
let sequence=0;
const op=()=>`r10-guard-${++sequence}`;
const write=(store,entry)=>store.write({request_id:op(),entries:[entry]}).then(x=>x.items[0]);
async function deleted(store){
 const made=await write(store,{operation_id:op(),action:'create',title:'待删除事项',raw:{speaker:'Ken',text:RAW},create_anyway:true});
 assert.equal(made.saved,true);
 const gone=await write(store,{operation_id:op(),action:'delete',id:made.id,base_revision:made.revision});
 assert.equal(gone.saved,true);return made.id;
}
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'1052-r10-guard-'))),stateDir=path.join(root,'state');
 fs.mkdirSync(stateDir,{mode:0o700});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,stateDir,store:new MatterStore({stateDir})};
}
const ledger=stateDir=>path.join(stateDir,'matters/purge-ledger.json');

test('array-shaped corrupt ledger with a crash-left body fails closed instead of resurrecting it',async t=>{
 const f=fixture(t),id=await deleted(f.store);
 f.store.removeBodies=()=>{throw Error('synthetic interruption after ledger commit');};
 await assert.rejects(f.store.purge({confirmed:true}));
 assert.equal(fs.existsSync(f.store.file(id)),true);
 fs.writeFileSync(ledger(f.stateDir),'{"format":1,"purged":[],"consumed":[]}\n');
 assert.throws(()=>new MatterStore({stateDir:f.stateDir}),{code:'MATTER_LEDGER_CORRUPT'});
 assert.equal(fs.existsSync(f.store.file(id)),true,'no file is deleted to hide the corrupt-ledger condition');
});

test('an unparseable finish intent blocks purge before ledger commit and preserves every user file',async t=>{
 const f=fixture(t),id=await deleted(f.store),name=crypto.randomUUID()+'.json';
 const file=path.join(f.store.pendingDir,name);fs.writeFileSync(file,'{"raw":"'+RAW+'",');
 await assert.rejects(f.store.purge({confirmed:true}),{code:'MATTER_PENDING_UNPROVEN'});
 assert.equal(fs.existsSync(ledger(f.stateDir)),false);
 assert.equal(fs.existsSync(f.store.file(id)),true);
 assert.ok(fs.readFileSync(file,'utf8').includes(RAW));
});

test('an interrupted intent temp is scrubbed only after its exact target is proven',async t=>{
 const f=fixture(t),id=await deleted(f.store),task=crypto.randomUUID();
 const file=path.join(f.store.pendingDir,task+'.json.'+crypto.randomUUID()+'.tmp');
 fs.writeFileSync(file,JSON.stringify({task_id:task,entries:[{entry:{operation_id:op(),action:'append',id,raw:{text:RAW}},reservedId:null}]}));
 assert.deepEqual(await f.store.purge({confirmed:true}),{purged:1});
 assert.equal(fs.readFileSync(file,'utf8').includes(RAW),false);
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).entries[0].entry.purged,true);
});

test('corrupt intent temp is preserved and blocks purge before ledger commit',async t=>{
 const f=fixture(t),id=await deleted(f.store),task=crypto.randomUUID();
 const file=path.join(f.store.pendingDir,task+'.json.'+crypto.randomUUID()+'.tmp');
 fs.writeFileSync(file,RAW);
 await assert.rejects(f.store.purge({confirmed:true}),{code:'MATTER_PENDING_UNPROVEN'});
 assert.equal(fs.existsSync(ledger(f.stateDir)),false);
 assert.equal(fs.existsSync(f.store.file(id)),true);
 assert.equal(fs.readFileSync(file,'utf8'),RAW);
});

test('a corrupt ledger leaves the App up but all matter APIs and writes fail closed',async t=>{
 const f=fixture(t),work=path.join(f.root,'work');fs.mkdirSync(work);
 fs.writeFileSync(ledger(f.stateDir),'{"format":1,"purged":[],"consumed":[]}\n');
 const app=await createDesktop({stateDir:f.stateDir,defaultRoot:work,uiKey:'af'.repeat(32),clientDeps:{
  currentAppPath:path.join(f.root,'ChatHand.app'),computerName:()=> 'Synthetic matter degradation',
  tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),
  updaterFactory:()=>({currentBuild:1052,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request:null,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})
 }});
 t.after(async()=>app.close());
 const state=await app.snapshot();
 assert.equal(state.matters.available,false);assert.equal(state.matters.error_code,'MATTER_LEDGER_CORRUPT');
 assert.equal(state.matters.total,null);assert.ok(state.site_b,'non-matter App snapshot remains available');
 await assert.rejects(app.handle('/api/matters/query',{}),{code:'MATTER_LEDGER_CORRUPT'});
 await assert.rejects(app.handle('/api/matters/purge',{confirmed:true}),{code:'MATTER_LEDGER_CORRUPT'});
 app.tools.policy.enabled=true;app.store.paused=false;
 await assert.rejects(app.tools.invoke('matter_query',{},'chatgpt',{}),{code:'MATTER_LEDGER_CORRUPT'});
 await assert.rejects(app.tools.invoke('begin_task',{request_id:'matter-denied-001',title:'不能认领',matter_ids:['CH-1']},'chatgpt',{}),{code:'MATTER_LEDGER_CORRUPT'});
 assert.equal(app.tools.policy.tasks.size,0,'failed matter claim must not open a task');
 assert.equal(fs.readFileSync(ledger(f.stateDir),'utf8'),'{"format":1,"purged":[],"consumed":[]}\n');
});
