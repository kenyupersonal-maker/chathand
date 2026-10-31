import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SetupActivity} from '../app/v1/setup-activity.mjs';
import {DesktopState} from '../app/state.mjs';

function fixture(data={}){
 let now=1000,saves=0;
 const state={data,save(){saves++;}};
 const activity=new SetupActivity({state,now:()=>now});
 return {state,activity,clock:value=>{now=value;},saves:()=>saves};
}

test('1070 reads, handoffs and route switches never create or renew activity',()=>{
 const f=fixture();
 assert.deepEqual(f.activity.snapshot(),{active:false,last_at:null,last_command:null,route:null});
 const reads=['doctor','status','test-status','switch','skill','repair','add','state-poll','/api/setup/skill','/api/setup/switch'];
 for(const command of reads)assert.equal(f.activity.touch(command,'site'),false);
 assert.equal(f.saves(),0);
 f.activity.touch('site-start','site');
 const saved=structuredClone(f.state.data);
 f.clock(1000+900000);
 for(const command of reads)assert.equal(f.activity.touch(command,'openai'),false);
 assert.equal(f.activity.snapshot().active,false);
 assert.deepEqual(f.state.data,saved);
 assert.equal(f.saves(),1);
});

test('1070 accepted setup steps persist explicit command and target route, including standby',()=>{
 const f=fixture({selected_route:'openai'});
 for(const [command,route]of [
  ['site-start','site'],['site','site'],['site-pair','site'],['site-replace','site'],
  ['connect','openai'],['bind-app','site'],['bind-app','openai'],
  ['prepare-browser','site'],['prepare-browser','openai'],['test-start','site'],['test-start','openai']
 ]){
  assert.equal(f.activity.touch(command,route),true);
  const reopened=new SetupActivity({state:{data:structuredClone(f.state.data),save(){assert.fail('snapshot must not write');}},now:()=>1000});
  assert.deepEqual(reopened.snapshot(),{active:true,last_at:1000,last_command:command,route});
 }
 assert.equal(f.state.data.selected_route,'openai');
});

test('1070 attribution and completion survive reopening the real desktop state file',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'1070-activity-state-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const open=()=>new DesktopState(path.join(root,'state'),{defaultRoot:path.join(root,'workspace')});
 const activity=new SetupActivity({state:open(),now:()=>1000});
 activity.touch('site-replace','site');
 const reopened=new SetupActivity({state:open(),now:()=>1001});
 assert.deepEqual(reopened.snapshot(),{active:true,last_at:1000,last_command:'site-replace',route:'site'});
 reopened.finish();
 assert.deepEqual(new SetupActivity({state:open(),now:()=>1002}).snapshot(),{
  active:false,last_at:1000,last_command:'site-replace',route:'site',finished_at:1001
 });
});

test('1070 unknown commands, missing routes and mismatched route attribution are no-ops',()=>{
 const f=fixture();
 for(const args of [['connect'],['site-start'],['test-start'],['connect','site'],['site','openai'],
  ['site-pair','openai'],['site-replace','openai'],['test-start','none'],['site-start','https://invalid.example'],
  ['unknown','site'],[{},'site'],['connect',{}],['doctor','openai']]){
  assert.equal(f.activity.touch(...args),false);
 }
 assert.deepEqual(f.state.data,{});
 assert.equal(f.saves(),0);
});

test('1070 actual progress extends the 15 minute window; reads and expiry do not write',()=>{
 const f=fixture();f.activity.touch('site-start','site');
 f.clock(900999);assert.equal(f.activity.snapshot().active,true);
 f.activity.touch('site','site');
 f.clock(1800998);assert.equal(f.activity.snapshot().active,true);
 f.clock(1800999);assert.equal(f.activity.snapshot().active,false);
 assert.equal(f.activity.finish(),false);
 assert.equal(f.saves(),2);
 assert.deepEqual(f.activity.snapshot(),{active:false,last_at:900999,last_command:'site',route:'site'});
});

test('1070 completion keeps attribution, can restart and publishes monotonic completion receipts',()=>{
 const f=fixture({setup_complete:true});
 assert.equal(f.activity.finish(),false);
 f.activity.touch('connect','openai');assert.equal(f.activity.finish(),true);
 assert.deepEqual(f.activity.snapshot(),{active:false,last_at:1000,last_command:'connect',route:'openai',finished_at:1000});
 assert.equal(f.activity.finish(),false);
 f.activity.touch('test-start','site');assert.equal(f.activity.snapshot().active,true);
 assert.equal(f.activity.finish(),true);assert.equal(f.activity.snapshot().finished_at,1001);
 assert.equal(f.saves(),4);
});

test('1070 failed touch restores every field exactly, including absent and present-undefined properties',()=>{
 for(const data of [{},{setup_activity_in_progress:undefined},{
  setup_activity_last_at:20,setup_activity_in_progress:false,setup_activity_last_command:'connect',
  setup_activity_route:'openai',setup_activity_finished_at:30,unrelated:true
 }]){
  const f=fixture(data),before=structuredClone(f.state.data),failure=Error('synthetic save failure');
  f.state.save=()=>{throw failure;};
  assert.throws(()=>f.activity.touch('site-replace','site'),error=>error===failure);
  assert.deepEqual(f.state.data,before);
 }
});

test('1070 failed finish restores pending state and completion receipt without losing attribution',()=>{
 for(const finished of [undefined,500]){
  const f=fixture(finished===undefined?{}:{setup_activity_finished_at:finished});
  f.activity.touch('site-pair','site');
  const before=structuredClone(f.state.data),failure=Error('synthetic save failure');
  f.state.save=()=>{throw failure;};
  assert.throws(()=>f.activity.finish(),error=>error===failure);
  assert.deepEqual(f.state.data,before);
  assert.equal(f.activity.snapshot().active,true);
 }
});

test('1070 legacy or malformed persisted attribution cannot activate setup or expose arbitrary values',()=>{
 for(const data of [
  {setup_activity_last_at:1000,setup_activity_in_progress:true},
  {setup_activity_last_at:1000,setup_activity_last_command:'doctor',setup_activity_route:'site'},
  {setup_activity_last_at:1000,setup_activity_last_command:'site',setup_activity_route:'openai'},
  {setup_activity_last_at:1000,setup_activity_last_command:{unexpected:true},setup_activity_route:'site'}
 ]){
  const f=fixture(data);assert.deepEqual(f.activity.snapshot(),{active:false,last_at:1000,last_command:null,route:null});
  assert.equal(f.activity.finish(),false);assert.equal(f.saves(),0);
 }
 const f=fixture();
 for(const now of [-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1]){
  f.clock(now);assert.equal(f.activity.touch('site-start','site'),false);
 }
 assert.equal(f.saves(),0);
 f.clock(1000);f.activity.touch('site-start','site');
 f.clock(999);assert.equal(f.activity.snapshot().active,false);
 f.state.data.setup_activity_finished_at=Number.MAX_SAFE_INTEGER;
 f.clock(1000);assert.equal(f.activity.finish(),false);
 assert.equal(f.saves(),1);
});
