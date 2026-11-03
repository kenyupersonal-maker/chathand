import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DesktopState} from '../../app/state.mjs';
import {readDesktopDataSnapshot} from '../../app/v1/data-compatibility.mjs';
import {HIGH_RISK_IDS} from '../../app/v1/high-risk.mjs';
import {startupFixture} from '../support/startup-five-fixture.mjs';

const fingerprint=file=>{const stat=fs.statSync(file);return {bytes:fs.readFileSync(file),mode:stat.mode,ino:stat.ino,mtime:stat.mtimeMs};};
const permissions={access_enabled:true,terminal_enabled:true,browser_enabled:true,desktop_enabled:true,auto_approve_tasks:true,full_access_confirmed:true,admin_requested:false,browser_control_opt_in:true,auto_connect:false,auto_update:false};

test('present execution/permission booleans and known high-risk switches reject damaged types without changing the inspected file',t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-settings-types-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'state'),seed=new DesktopState(dir,{defaultRoot:path.join(root,'work')}),file=path.join(dir,'desktop.json');
 const base={...seed.data,...permissions};
 for(const [key,bad]of [['access_enabled','false'],['terminal_enabled','false'],['browser_enabled',null],['desktop_enabled',1],['auto_approve_tasks',{}],['full_access_confirmed',[]],['admin_requested','false'],['browser_control_opt_in',0],['auto_connect','false'],['auto_update',null]]){
  fs.writeFileSync(file,JSON.stringify({...base,[key]:bad}));const before=fingerprint(file);
  assert.equal(readDesktopDataSnapshot(dir,{allowCorrupt:true,requireShape:true}).kind,'corrupt',key);assert.deepEqual(fingerprint(file),before);
 }
 for(const high_risk of [...HIGH_RISK_IDS.map(id=>({[id]:'false'})),null,[],true]){
  fs.writeFileSync(file,JSON.stringify({...base,high_risk}));const before=fingerprint(file);
  assert.equal(readDesktopDataSnapshot(dir,{allowCorrupt:true,requireShape:true}).kind,'corrupt',JSON.stringify(high_risk));assert.deepEqual(fingerprint(file),before);
 }
});

test('actual CLI keeps absent legacy switches, ordinary version/schema and unknown extra fields compatible',async t=>{
 const f=await startupFixture(t,{prepare:f=>{
  const file=path.join(f.stateDir,'desktop.json'),value=JSON.parse(fs.readFileSync(file));for(const key of Object.keys(permissions))delete value[key];
  Object.assign(value,{version:999,schema:'business-schema',unknown_switch:'false',high_risk:{future_switch:'not-a-known-boolean'}});fs.writeFileSync(file,JSON.stringify(value));
 }});
 const state=(await f.request('/api/state')).body;assert.equal(state.settings.settings_recovery_notice,undefined);assert.deepEqual(state.startup_notices,[]);
 const saved=JSON.parse(fs.readFileSync(path.join(f.stateDir,'desktop.json')));assert.equal(saved.version,999);assert.equal(saved.schema,'business-schema');assert.equal(saved.unknown_switch,'false');assert.equal(saved.high_risk.future_switch,'not-a-known-boolean');
 assert.equal(fs.readdirSync(f.stateDir).filter(name=>name.startsWith('desktop.unreadable-')).length,0);
});

for(const kind of ['terminal','high-risk'])test('actual CLI preserves damaged permission bytes and remains closed after restart: '+kind,async t=>{
 let original;
 const first=await startupFixture(t,{prepare:f=>{
  const file=path.join(f.stateDir,'desktop.json'),value=JSON.parse(fs.readFileSync(file));Object.assign(value,permissions,{mode:'full',high_risk:{admin:false,autostart:true}});
  if(kind==='terminal')value.terminal_enabled='false';else value.high_risk.admin='false';
  fs.writeFileSync(file,JSON.stringify(value)+'\n');original=fingerprint(file);fs.writeFileSync(path.join(f.work,'project.txt'),'UNCHANGED_PROJECT');
 }});
 async function assertClosed(f){
  const state=(await f.request('/api/state')).body;assert.equal(state.enabled,false);assert.equal(state.settings.settings_recovery_notice,true);assert.equal(state.mode,'auto');
  for(const key of ['access_enabled','terminal_enabled','browser_enabled','desktop_enabled','auto_connect','auto_update'])assert.equal(state.settings[key],false,key);
  for(const capability of Object.values(state.permissions.capabilities))assert.equal(capability.enabled,false);
  for(const risk of state.permissions.high_risk){assert.equal(risk.enabled,false);assert.equal(risk.usable_now,false);}
  const runtime=JSON.parse(fs.readFileSync(path.join(f.stateDir,'runtime.json')));
  const response=await fetch(runtime.mcp_url,{method:'POST',headers:{'Content-Type':'application/json','X-Ken-Bridge-Token':runtime.mcp_token,Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'begin_task',arguments:{request_id:'settings-recovery-'+kind,title:'Synthetic denied task'},_meta:{'openai/session':'settings-recovery-'+kind}}})});
  const result=(await response.json()).result;assert.equal(result.isError,true);assert.equal(result.structuredContent.code,'LOCAL_DISABLED');assert.deepEqual((await f.request('/api/state')).body.jobs,[]);
  const preserved=fs.readdirSync(f.stateDir).filter(name=>name.startsWith('desktop.unreadable-'));assert.equal(preserved.length,1);assert.deepEqual(fingerprint(path.join(f.stateDir,preserved[0])),original);
  assert.equal(fs.readFileSync(path.join(f.work,'project.txt'),'utf8'),'UNCHANGED_PROJECT');
 }
 await assertClosed(first);await first.close();
 const restarted=await startupFixture(t,{existingRoot:first.root});await assertClosed(restarted);
});
