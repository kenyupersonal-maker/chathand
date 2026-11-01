import {storeTestDistribution} from '../support/chrome-store-fixture.mjs';
import {legacyChromeDistribution} from '../../app/v1/chrome-distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {memoryActivity} from '../../app/v1/events.mjs';
import {TaskPolicy} from '../../app/policy.mjs';
import {AutoTaskExecution} from '../../app/v1/auto-task-execution.mjs';
import {ExtensionBrowser} from '../../app/v09/extension-browser.mjs';
import {connectionDisplay} from '../../app/v1/connection-display.mjs';
import {ToolListProof} from '../../app/v1/tool-list-proof.mjs';
import {Repair} from '../../app/v1/repair.mjs';
import {Updater} from '../../app/v1/update.mjs';
import {messageMetadata} from '../../app/v1/message-metadata.mjs';
import {refreshFixture} from '../support/1063-refresh-fixture.mjs';
const contract=JSON.parse(fs.readFileSync(new URL('../support/1063-message-contract.json',import.meta.url)));
const temporary=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1063-message-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const makePolicy=dir=>{const p=new TaskPolicy({data:{active:'fixture-project',mode:'auto',conversations:[]},save(){}},{root:dir,stateDir:dir,paused:false,accessMode:'auto'},{jobs:new Map(),inputs:new Map()});p.enabled=true;return p;};
function helper(state,extras={}){
 const b=Object.create(ExtensionBrowser.prototype);b.distribution=legacyChromeDistribution();b.helper={version:'1',build:1000,features:[],session:'old',...extras.helper};b.expected={version:'2',build:1063,folder:'/tmp/fixture-helper'};b.reloadAsked=new Map();
 if(state==='outdated')b.helper.version=null;
 if(['wrong_folder','reloading','reload_failed'].includes(state))b.reloadAsked.set('1>2',{at:Date.now()-(state==='reload_failed'?130000:0),session:state==='wrong_folder'?'another':'old'});
 return b.helperStatus();
}
function updater(t){const dir=temporary(t);return new Updater({stateDir:dir,upgradeHome:path.join(dir,'upgrade'),downloadsDir:path.join(dir,'downloads'),currentAppPath:null,version:'1.0.0',build:1063,env:{},exec:async()=>{throw Error('NO_EXTERNAL_COMMANDS');}});}
async function repairState(s,extra={},body={login_item_requires_approval:true}){
 let now=0;const r=new Repair({distribution:storeTestDistribution(),snapshot:()=>s,now:()=>now,sleep:async ms=>{now+=ms;},systemProxy:()=>null,probePort:async()=>false,restoreTunnel:()=>false,openChromeInBackground:()=>{},cleanupUpgrade:()=>({cleaned:0}),...extra});
 const value=r.start(body);for(let i=0;i<300&&value.status!=='done';i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(value.status,'done');return value;
}
function english(key,params={},depth=0){assert.ok(Object.hasOwn(contract,key),'known key '+key);assert.ok(depth<=2);return contract[key].replace(/\{([A-Za-z]+)\}/g,(_,name)=>{assert.ok(Object.hasOwn(params,name),'param '+key+'.'+name);const v=params[name];return typeof v==='object'?english(v.key,v.params,depth+1):String(v);});}
function field(o,name){assert.doesNotMatch(JSON.stringify(o[name+'_params']),/\p{Script=Han}/u);return english(o[name+'_key'],o[name+'_params']);}

test('connection metadata covers failure/retry/up/down/pending and preserves localText fallback',()=>{
 const cases=[['CREDENTIAL_SAVE_FAILED',null,'saveFailed'],[null,'needs_login','authFailed'],[null,'needs_retry','retry'],[null,'offline','offline'],[null,'starting','connecting'],[null,null,'notConnected']];
 for(const [error_code,phase,key] of cases){const r=connectionDisplay({automatic:{error_code,phase}});assert.equal(r.title_key,'connection.'+key+'.title');if(r.detail_key)field(r,'detail');field(r,'title');}
 const raw=connectionDisplay({automatic:{phase:'needs_retry',message:'原连接消息'}});assert.equal(raw.detail,'原连接消息');assert.equal(raw.detail_key,null);assert.deepEqual(raw.detail_params,{});
 for(const [cp,probe,key] of [[{state:'up'},null,null],[{state:'down'},null,'connection.downNoReply.detail'],[{state:'down',down_since:1},null,'connection.downStill.detail'],[{state:'down'},{reachable:false,via_system_proxy:true},'connection.downProxyNode.detail']]){
  const r=connectionDisplay({process_running:true,healthy:true,ready:true,control_plane:cp},{proxyProbe:probe});assert.equal(r.detail_key,key);field(r,'title');if(key)field(r,'detail');
 }
 const r=connectionDisplay({process_running:true,healthy:true,ready:true,control_plane:{state:'checking',down_since:1}},{now:20000});assert.equal(r.settings_warning.title_key,'connection.cloudPending.title');field(r.settings_warning,'detail');
});
test('helper branches carry safe params and retain original fallback text',()=>{
 for(const state of ['outdated','wrong_folder','reloading','reload_failed','stale']){const r=helper(state);assert.equal(r.state,state);assert.ok(r.message);assert.doesNotMatch(field(r,'message'),/\p{Script=Han}/u);}
 assert.equal(helper('stale',{helper:{features:['self_reload']}}).message_key,'helper.staleAuto.message');
 const b=Object.create(ExtensionBrowser.prototype);b.distribution=legacyChromeDistribution();b.helper={version:'1',build:1000,features:[],session:'new'};b.expected={version:'2',build:1063,folder:'/tmp/中文路径'};b.reloadAsked=new Map([['1>2',{at:1,session:'old'}]]);const r=b.helperStatus();assert.match(r.message,/中文路径/);assert.deepEqual(r.message_params.folder,{key:'helper.folderFallback.text'});field(r,'message');
});
test('tool proof distinguishes saved/current/unknown/site/stale and propagates note',t=>{
 const proof=new ToolListProof(temporary(t)),id='a'.repeat(24),schema='b'.repeat(64),args={identity:id,currentSchema:schema};
 assert.equal(proof.status(args).message_key,'toolsList.unknown.message');assert.equal(proof.status({...args,site:true}).message_key,'toolsList.unknownSite.message');
 proof.record({identity:id,at:1,schema_sha256:schema,build:1063});assert.equal(proof.status(args).message_key,'toolsList.current.message');proof.persisted.clear();assert.equal(proof.status(args).message_key,'toolsList.currentUnsaved.message');
 const stale=proof.status({...args,currentSchema:'c'.repeat(64)});assert.equal(stale.message_key,'toolsList.stale.message');assert.equal(stale.new_conversation_note_key,'toolsList.newConversation.note');field(stale,'message');field(stale,'new_conversation_note');
});
test('repair titles/actions/sentence params/summary and copied tool-list metadata',async()=>{
 const r=await repairState({enabled:false,settings:{access_enabled:false,desktop_enabled:true,browser_enabled:false},tools_list_status:{state:'stale',message:'旧工具原句',message_key:'toolsList.stale.message',message_params:{}},automation:{computer:{permissions:{}}}});
 for(const item of r.items){field(item,'title');if(item.message_key)field(item,'message');if(item.action)field(item.action,'label');}
 assert.equal(r.items.find(x=>x.id==='desktop_permissions').message,'缺少辅助功能和屏幕录制授权');assert.equal(r.items.find(x=>x.id==='desktop_permissions').message_key,'repair.desktop_permissions.missingBoth.message');
 const tools=r.items.find(x=>x.id==='chatgpt_tools');assert.equal(tools.message,'旧工具原句');assert.equal(tools.message_key,'toolsList.stale.message');field(r.summary,'text');
 for(const [permissions,key] of [[{accessibility:true},'missingScreenRecording'],[{screen_recording:true},'missingAccessibility']]){const v=await repairState({settings:{connection_preference:'relay',browser_enabled:false},relay:{online:true},automation:{computer:{permissions}}});assert.equal(v.items.find(x=>x.id==='desktop_permissions').message_key,'repair.desktop_permissions.'+key+'.message');}
});
test('policy title and summary persist through finish/replay/reopened receipt with internal glue',t=>{
 const dir=temporary(t),p=makePolicy(dir),out=p.begin({request_id:'fixture-begin-1063',title:'刷新 ChatGPT 里的 ChatHand 工具'},'chatgpt'),task=p.get(out.task_id);
 Object.assign(task,{title_key:'refresh.task.title',title_params:{},summary_key:'refresh.summary.failed',summary_params:{}});
 assert.equal(p.view(task).title_key,'refresh.task.title');const finished=p.finish(task.id,'chatgpt',false,'没刷新成');assert.equal(finished.summary_key,'refresh.summary.failed');assert.equal(finished.title_key,'refresh.task.title');
 const activity=memoryActivity([finished],{conversations:[]});assert.equal(activity.items[0].tasks[0].title_key,'refresh.task.title');assert.equal(activity.items[0].tasks[0].summary_key,'refresh.summary.failed');
 const reopened=makePolicy(dir).view(makePolicy(dir).get(task.id,'chatgpt'));assert.equal(reopened.summary_key,'refresh.summary.failed');assert.equal(p.finish(task.id,'chatgpt',false,'unused').summary_key,'refresh.summary.failed');
});
test('automatic task title metadata is stored in ledger and policy without public metadata args',async t=>{
 const dir=temporary(t),policy=makePolicy(dir),auto=new AutoTaskExecution({stateDir:dir,policy,capabilities:()=>({})});
 const r=await auto.execute('write_text',{task_id:'00000000-0000-4000-8000-000000000001',operation_id:'fixture-write-1063',path:'mock.txt',content:'mock'},'chatgpt',{},async args=>({operation_id:args.operation_id}));
 const task=policy.get(r.task_id);assert.equal(task.title,'write_text 自动任务');assert.equal(policy.view(task).title_key,'autoTask.task.title');assert.deepEqual(task.title_params,{name:'write_text'});
 const record=fs.readdirSync(auto.dir).find(x=>x.endsWith('.json'));assert.equal(JSON.parse(fs.readFileSync(path.join(auto.dir,record))).title_key,'autoTask.task.title');assert.equal(policy.finish(task.id,'chatgpt',true,'done').title_key,'autoTask.task.title');
});
test('updater metadata covers dev, listed async failures, raw unlisted timer errors and startup results',async t=>{
 const u=updater(t);u.value.status='available';u.latest={version:'2.0.0',build:1064};assert.equal(u.install('2.0.0').install.message_key,'update.devEnvironment.message');
 u.app=path.join(u.stateDir,'Mock.app');u._createInstallMarker=()=>({install_task:{view:{}},marker:{from:{},to:{}}});u._finishInstallTask=()=>{};
 for(const [key,message] of [['update.downloadTimeout.message','还没等到安装包，可以再试一次'],['update.hashMismatch.message','安装包校验不对，没有安装'],['update.checkFailed.message','安装包检查没通过，没有安装']]){
  u.latest={source:'local',build:1064,version:'2.0.0'};u._install=async()=>{throw Object.assign(Error('fixture'),{updateMessageKey:key,updateMessage:message});};u.install('local:1064');await u.run.promise;assert.equal(u.value.install.message,message);assert.equal(u.value.install.message_key,key);
 }
 for(const [code,key] of [['UPDATE_VERSION_MISMATCH',null],['UPDATE_HASH_MISMATCH','update.hashMismatch.message']]){
  u.aiDelayMs=1;u.install=()=>{throw Object.assign(Error('原始未列举消息'),{code});};u.value.install.message_key='update.dragAgain.message';u.aiInstall({build:1064},{source_task_ids:[]});await new Promise(r=>setTimeout(r,10));assert.equal(u.value.install.message,'原始未列举消息');assert.equal(u.value.install.message_key,key);assert.deepEqual(u.value.install.message_params,{});
 }
 for(const [status,key] of [['ROLLBACK_FAILED','update.rollbackFailed.message'],['ROLLED_BACK','update.rolledBack.message'],['FAILED','update.failedNotInstalled.message']]){fs.writeFileSync(u.resultFile,JSON.stringify({status}));u._readResult();assert.equal(u.value.install.message_key,key);field(u.value.install,'message');}u.close();
});
test('six emitted categories render using supplied English contract; writes isolated UI handoff fixture only when requested',async t=>{
 const repair=await repairState({settings:{browser_enabled:false,desktop_enabled:false,connection_preference:'relay'},relay:{online:false}}),p=refreshFixture({confirm:true});const refresh=await p.refresher.run(),u=updater(t);u.value.status='available';u.latest={version:'2.0.0'};const update=u.install('2.0.0').install;
 const fixture={connection:{display:connectionDisplay({automatic:{error_code:'CREDENTIAL_SAVE_FAILED'}})},repair,tools_list_status:new ToolListProof(temporary(t)).status({identity:'a'.repeat(24),currentSchema:'b'.repeat(64)}),tools_refresh:refresh,update:{install:update},automation:{browser:{extension:{helper:helper('outdated')}}},tasks:[{title:'刷新 ChatGPT 里的 ChatHand 工具',title_key:'refresh.task.title',title_params:{},...p.finished[0]}],automatic_task:{message:refresh.message,message_key:refresh.message_key,message_params:refresh.message_params,steps:refresh.steps.map(s=>({...s,title:s.step,title_key:'refresh.step.'+s.step+'.title',title_params:{}}))}};
 for(const [o,f] of [[fixture.connection.display,'title'],[fixture.connection.display,'detail'],[repair.summary,'text'],[fixture.tools_list_status,'message'],[refresh,'message'],[update,'message'],[fixture.automation.browser.extension.helper,'message'],[fixture.tasks[0],'title'],[fixture.tasks[0],'summary']])assert.doesNotMatch(field(o,f),/\p{Script=Han}/u);
 if(process.env.CHATHAND_1063_FIXTURE_OUT)fs.writeFileSync(process.env.CHATHAND_1063_FIXTURE_OUT,JSON.stringify(fixture,null,2)+'\n');u.close();
});
test('metadata clears stale fields, validates keys, permits only safe params and two nested sentence levels',()=>{
 const original={message_key:'repair.common.off.message',message_params:{old:1}};Object.assign(original,messageMetadata('message'));assert.equal(original.message_key,null);assert.deepEqual(original.message_params,{});
 assert.equal(messageMetadata('message','invalid').message_key,null);const result=messageMetadata('message','refresh.message.failed.stepError',{reason:{key:'refresh.reason.unknown',params:{first:{key:'refresh.reason.unknown',params:{second:{key:'refresh.reason.unknown'}}}}},bad:'中文','中文字段':1,array:[]});assert.equal(result.message_params.bad,undefined);assert.doesNotMatch(JSON.stringify(result.message_params),/\p{Script=Han}/u);assert.deepEqual(result.message_params.reason.params.first.params,{});
});

test('repair emits all eight summary combinations with numeric params',async()=>{
 const observed=[];
 for(const fixed of [0,1])for(const action of [0,1])for(const failed of [0,1]){
  const r=await repairState({enabled:!action,settings:{access_enabled:true,browser_enabled:false,desktop_enabled:false,connection_preference:'relay'},relay:{online:!failed}},{cleanupUpgrade:()=>({cleaned:fixed})},{});
  assert.deepEqual(r.summary.text_params,{fixed,actionNeeded:action,failed});observed.push(r.summary.text_key);assert.doesNotMatch(field(r.summary,'text'),/\p{Script=Han}/u);
 }
 assert.equal(new Set(observed).size,8);
});
