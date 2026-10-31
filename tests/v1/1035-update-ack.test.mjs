import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Updater} from '../../app/v1/update.mjs';
import {Tools} from '../../app/tools.mjs';

const schema='a'.repeat(64),other='b'.repeat(64);
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1035-update-'));
 const stateDir=path.join(root,'state');fs.mkdirSync(stateDir);
 const deps={stateDir,upgradeHome:path.join(root,'upgrades'),downloadsDir:path.join(root,'Downloads'),currentAppPath:null,
  version:'1.0.0-beta.4',build:1035,schemaSha:schema,exec:async()=>{throw Error('No external commands allowed');}};
 const make=extra=>new Updater({...deps,...extra});
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const commit=old=>{
  fs.writeFileSync(path.join(stateDir,'update-pending.json'),JSON.stringify({from:'1.0.0-beta.4',to:deps.version,build_from:1034,build_to:1035,schema_from:old}));
  fs.writeFileSync(path.join(stateDir,'update-result.json'),JSON.stringify({status:'COMMITTED',from:'1.0.0-beta.4',to:deps.version,schema_from:old}));
 };
 const view=u=>Tools.prototype.upgradeView.call({updater:u,toolsRefresh:{snapshot:()=>({state:'idle'})},upgradePending:false});
 return {stateDir,make,commit,view};
}
test('1035 acknowledgement removes bubble but retains verified unchanged tools across restart',t=>{
 const f=fixture(t);f.commit(schema);const u=f.make();
 assert.equal(u.aiStatus().tools_changed,false);assert.equal(f.view(u).tools_refresh.state,'not_needed');
 u.ack();assert.equal(u.snapshot().just_updated,null);
 assert.equal(fs.existsSync(u.pendingFile)||fs.existsSync(u.resultFile),false);
 assert.equal(f.view(u).tools_refresh.state,'not_needed');
 const restarted=f.make();const v=f.view(restarted);
 assert.equal(restarted.snapshot().just_updated,null);assert.equal(v.phase,'updated');
 assert.equal(v.tools_changed,false);assert.equal(v.tools_refresh.state,'not_needed');
});
test('1035 changed schema remains changed after acknowledgement and cannot skip refresh',t=>{
 const f=fixture(t);f.commit(other);const u=f.make();assert.equal(u.aiStatus().tools_changed,true);u.ack();
 const v=f.view(f.make());assert.equal(v.tools_changed,true);assert.equal(v.tools_refresh.state,'pending');
});
test('1035 completed history is bound to exact build and schema, and cannot mask a new pending update',t=>{
 const f=fixture(t);f.commit(schema);const u=f.make();u.aiStatus();u.ack();
 for(const extra of [{build:1036},{schemaSha:other}]){
  const v=f.view(f.make(extra));assert.equal(v.tools_changed,null);assert.equal(v.tools_refresh.state,'unknown');
 }
 fs.writeFileSync(path.join(f.stateDir,'update-pending.json'),JSON.stringify({from:'1.0.0-beta.4',to:'1.0.0-beta.4',build_to:1036}));
 const v=f.view(f.make());assert.equal(v.phase,'verifying');assert.equal(v.tools_changed,null);
});
test('1035 no successful commit never invents not_needed from the AI install plan',t=>{
 const f=fixture(t);
 fs.writeFileSync(path.join(f.stateDir,'update-ai.json'),JSON.stringify({at:Date.now(),from:{build:1034},to:{build:1035},tool_schema_changed:false}));
 const v=f.view(f.make());assert.equal(v.phase,'updated');assert.equal(v.tools_changed,null);assert.equal(v.tools_refresh.state,'unknown');
 assert.equal(fs.existsSync(path.join(f.stateDir,'update-completed.json')),false);
});
