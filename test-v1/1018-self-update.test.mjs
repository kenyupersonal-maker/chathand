// 1018 request_update: ChatGPT may ask for a new ChatHand; only the user's click in ChatHand's own window installs it.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {createDesktop,needsInterface} from '../app/server.mjs';
import {TOOLS} from '../app/tools.mjs';import {CONNECTOR_API,manifest} from '../app/product.mjs';
import {classifyCommand,neverError} from '../app/v1/high-risk.mjs';import {updateWorkPending} from '../app/v1/client-features.mjs';import {TOOL_CATEGORIES} from '../app/v1/value-stats.mjs';

const HOME='/Users/fixture',CWD='/Users/fixture/Work/proj',SELF={selfPids:[4242],selfPaths:['/Applications/ChatHand.app','/Users/fixture/Library/Application Support/ChatHand'],selfCmdlines:['/Applications/ChatHand.app/Contents/Resources/runtime/bin/node /Applications/ChatHand.app/Contents/Resources/runtime/app/server.mjs']};
const run=(program,args=[])=>classifyCommand({program,args,cwd:CWD,home:HOME,...SELF}),viaShell=script=>run('/bin/zsh',['-lc',script]);
const never=r=>r.never?.id??null;
const read=rel=>fs.readFileSync(new URL('../'+rel,import.meta.url),'utf8');

test('request_update precedes the generic capability wrapper, needs a task and a path, is categorised',()=>{
 const tool=TOOLS.find(t=>t.name==='request_update');assert.ok(tool);assert.equal(TOOLS.at(-2).name,'request_update');assert.equal(TOOLS.at(-1).name,'run_capability');assert.equal(TOOLS.filter(t=>t.name==='request_update').length,1);
 assert.deepEqual([...tool.inputSchema.required].sort(),['app_path','task_id']);assert.equal(tool.inputSchema.properties.app_path.type,'string');assert.equal(tool.inputSchema.properties.note.type,'string');assert.equal(tool.inputSchema.properties.note.maxLength,300);assert.equal(tool.inputSchema.additionalProperties,false);
 assert.equal(tool.annotations.readOnlyHint,false);assert.equal(tool.annotations.destructiveHint,false);assert.ok(tool.description.includes('ChatHand'));
 assert.equal(TOOL_CATEGORIES.request_update,'other');
 const frozen=JSON.parse(read(`contracts/tools-v${CONNECTOR_API}.json`));assert.equal(frozen.at(-2).name,'request_update');assert.equal(frozen.at(-1).name,'run_capability');assert.deepEqual(frozen,TOOLS);assert.equal(manifest(TOOLS).tool_count,frozen.length);assert.ok(CONNECTOR_API>=7);
});
test('swapping ChatHand is the window\'s decision: /api/update/install needs the window credential, the AI-facing request routes do not exist',()=>{
 assert.equal(needsInterface('/api/update/install',{version:'local:1'}),true);assert.equal(needsInterface('/api/update/install',{}),true);
 // Nothing for ChatGPT to call over the local API either: the only way in is the request_update tool.
 assert.equal(/requestLocal|request_update|\/api\/update\/request/.test(read('app/server.mjs')),false);
});
test('classifyCommand: running the upgrade transaction, the local install script or the upgrade helper is never allowed (never:self)',()=>{
 const refused=[
  ['node','scripts/upgrade.mjs --install /x'],['/usr/local/bin/node','./scripts/upgrade.mjs --install /tmp/stage --destination /Applications/ChatHand.app'],['node','/Users/fixture/Work/proj/scripts/upgrade.mjs'],
  ['bash','scripts/install-local-build.sh'],['sh','scripts/install-local-build.sh --yes'],['zsh','-f /x/scripts/install-local-build.sh'],['./scripts/install-local-build.sh',''],['/Users/fixture/Work/proj/scripts/install-local-build.sh',''],
  ['/x/ken-upgrade-control','stop-exact 111 222'],['ken-upgrade-control','stop-exact 1'],['./ken-upgrade-control','status'],
 ];
 for(const [program,args] of refused){const r=run(program,args?args.split(' '):[]);assert.equal(never(r),'self',program+' '+args);}
 for(const script of ["bash -c 'node scripts/upgrade.mjs --install /p'","node scripts/upgrade.mjs --install /p","cd /tmp && node ./scripts/upgrade.mjs --install /p","echo ok && bash scripts/install-local-build.sh","/x/ken-upgrade-control stop-exact 1 2","sh -c './scripts/install-local-build.sh'"])assert.equal(never(viaShell(script)),'self',script);
 assert.equal(never(run('bash',['-c',"node scripts/upgrade.mjs --install /p"])),'self');
 const err=neverError('self','node scripts/upgrade.mjs');assert.equal(err.code,'NEVER_ALLOWED');assert.equal(err.details.never_id,'self');assert.ok(err.details.instructions_for_ai.some(s=>s.includes('request_update')));assert.ok(err.details.instructions_for_ai.length>=3);
 assert.equal(neverError('switch_user').details.instructions_for_ai.some(s=>s.includes('request_update')),false);
});
test('classifyCommand: reading, testing, building or committing those files is ordinary work, not never:self',()=>{
 const fine=[
  ['node','--test test-v1/update.test.mjs'],['node','scripts/check-contract.mjs'],['node','scripts/generate-version.mjs'],['node','scripts/build-v09.mjs --output /tmp/out/ChatHand.app'],
  ['git','add scripts/upgrade.mjs'],['git','diff -- scripts/upgrade.mjs'],['cat','scripts/install-local-build.sh'],['grep','-n install scripts/install-local-build.sh'],['cat','scripts/upgrade.mjs'],['bash','scripts/build.sh'],['sed','-n 1,20p scripts/upgrade.mjs'],
 ];
 for(const [program,args] of fine){const r=run(program,args?args.split(' '):[]);assert.equal(never(r),null,program+' '+args);}
 for(const script of ['node --test test-v1/update.test.mjs','git add scripts/upgrade.mjs && git commit -m "x"','cat scripts/install-local-build.sh | head -20','node scripts/generate-version.mjs'])assert.equal(never(viaShell(script)),null,script);
});
test('updateWorkPending: the task that asked for the update does not hold it back; other tasks and live jobs still do',()=>{
 const tasks=[{task_id:'task_1',status:'active'},{task_id:'task_2',status:'finished'}];
 assert.equal(updateWorkPending({tasks}),true);assert.equal(updateWorkPending({tasks,exceptTask:null}),true);assert.equal(updateWorkPending({tasks,exceptTask:'task_1'}),false);assert.equal(updateWorkPending({tasks,exceptTask:'task_other'}),true);
 assert.equal(updateWorkPending({tasks:[{task_id:'task_1',status:'pending_approval'}],exceptTask:'task_1'}),false);
 assert.equal(updateWorkPending({tasks:[...tasks,{task_id:'task_3',status:'active'}],exceptTask:'task_1'}),true);assert.equal(updateWorkPending({tasks:[...tasks,{task_id:'task_3',status:'pending_approval'}],exceptTask:'task_1'}),true);
 // Running or half-cleaned jobs always count, even when they belong to the requesting task.
 assert.equal(updateWorkPending({tasks,jobs:[{process_alive:true}],exceptTask:'task_1'}),true);assert.equal(updateWorkPending({tasks,jobs:[{cleanup_pending:true}],exceptTask:'task_1'}),true);assert.equal(updateWorkPending({tasks,jobs:[{process_alive:false,cleanup_pending:false}],exceptTask:'task_1'}),false);
 assert.equal(updateWorkPending({}),false);assert.equal(updateWorkPending({tasks:[],jobs:[]}),false);
});

async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1018-')),key='e'.repeat(64),f={requests:[],emitted:[],deps:null,build:1018,forAI:{status:'available',request:{status:'waiting_user'}}};
 f.app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:path.join(root,'work'),uiKey:key,adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{computerName:()=> 'Isolated Mac',tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),
  updaterFactory:deps=>{f.deps=deps;return {currentBuild:f.build,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>f.forAI,start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0}),async requestLocal(input){f.requests.push(input);return {status:'waiting_user',version:'9.9.9',build:f.build+1};}};}}});
 let rpcId=0;f.call=async(name,args={},session='self-update-test-session')=>{const response=await f.app.tools.rpc({jsonrpc:'2.0',id:++rpcId,method:'tools/call',params:{name,arguments:args,_meta:{'openai/session':session,'io.modelcontextprotocol/protocolVersion':'2026-07-28'}}},'chatgpt',{transport:'local_http',setupPrincipal:'tunnel:chatgpt'});const envelope=response.result,result=envelope?.result??envelope;if(result?.isError){const detail=result.structuredContent||{};throw Object.assign(Error(detail.message||detail.code||'tool call failed'),detail);}return result?.structuredContent;};f.begin=async(extra={})=>{const {session,...args}=extra;return f.call('begin_task',{request_id:crypto.randomUUID(),title:'Self update',...args},session||'self-update-test-session');};
 t.after(async()=>{await f.app.close();fs.rmSync(root,{recursive:true,force:true});});return f;
}
test('request_update needs an active task, is refused while that task has a live command, and otherwise hands the request to the updater',async t=>{
 const f=await fixture(t);
 await assert.rejects(()=>f.call('request_update',{app_path:'/tmp/x/ChatHand.app'}),e=>e.code!=null);
 const deferred=await f.call('request_update',{task_id:'task_does_not_exist',app_path:'/tmp/x/ChatHand.app'});assert.equal(deferred.execution_state,'not_started');assert.equal(deferred.task_created,false);assert.equal(deferred.next_action,'call_run_capability');assert.equal(deferred.parameters.tool,'request_update');assert.equal(f.requests.length,0,'the proposed run_capability step has not been accepted or executed');
 await assert.rejects(()=>f.call('request_update',{task_id:'task_does_not_exist'}),e=>e.code==='ARG_INVALID');
 assert.equal(f.requests.length,0,'the updater is never reached without a real active task');
 const task=await f.begin();assert.ok(task.task_id);
 await assert.rejects(()=>f.call('request_update',{task_id:task.task_id}),e=>e.code!=null);assert.equal(f.requests.length,0);
 const ok=await f.call('request_update',{task_id:task.task_id,app_path:'/tmp/built/ChatHand.app',note:'改按钮'});assert.equal(ok.status,'waiting_user');assert.equal(f.requests.length,1);
 assert.equal(f.requests[0].app_path,'/tmp/built/ChatHand.app');assert.equal(f.requests[0].note,'改按钮');assert.equal(f.requests[0].task_id,task.task_id);assert.ok(f.requests[0].conversation_title===null||typeof f.requests[0].conversation_title==='string');
 const bare=await f.call('request_update',{task_id:task.task_id,app_path:'/tmp/built/ChatHand.app'});assert.equal(bare.status,'waiting_user');assert.equal(f.requests[1].note,'');
 // A command still running in the task blocks the request (the install would kill it).
 const live=f.app.tools.queue.list;f.app.tools.queue.list=()=>[{job_id:'job_live',process_alive:true}];f.app.tools.policy.tasks.get(task.task_id).jobs.push('job_live');
 await assert.rejects(()=>f.call('request_update',{task_id:task.task_id,app_path:'/tmp/built/ChatHand.app'}),{code:'UPDATE_TASK_BUSY'});assert.equal(f.requests.length,2);
 f.app.tools.queue.list=()=>[{job_id:'job_live',process_alive:false}];assert.equal((await f.call('request_update',{task_id:task.task_id,app_path:'/tmp/built/ChatHand.app'})).status,'waiting_user');f.app.tools.queue.list=live;
});
test('bridge_info tells the AI the running build and the update state; the server wires the updater to events and to the requesting-task-aware busy check',async t=>{
 const f=await fixture(t),info=await f.call('bridge_info');assert.equal(info.client_build,1018);assert.deepEqual(info.update,f.forAI);assert.equal(info.manifest.tool_count,TOOLS.length);assert.equal(info.manifest.tool_names,undefined);assert.ok(info.tool_access.actions.includes('request_update'));assert.equal(info.manifest.schema_sha256,manifest(TOOLS).schema_sha256);
 f.build=1019;f.app.tools.updater.currentBuild=1019;f.forAI={status:'unknown',request:null,just_updated:{from:'1.0.0',to:'1.0.0',build_from:1018,build_to:1019}};const after=await f.call('bridge_info');assert.equal(after.client_build,1019);assert.deepEqual(after.update.just_updated,{from:'1.0.0',to:'1.0.0',build_from:1018,build_to:1019});
 // Events from the updater reach the window's event stream.
 const seen=[],policy=f.app.tools.policy,emit=policy.emit;policy.emit=(kind,data)=>{seen.push([kind,data]);return emit.call(policy,kind,data);};f.deps.emit('update_requested',{version:'9.9.9',build:1019});policy.emit=emit;assert.deepEqual(seen,[['update_requested',{version:'9.9.9',build:1019}]]);
 // busy(): without an exception any active task blocks; the requesting task alone does not; a live command always does.
 assert.equal(f.deps.busy(),false);const task=await f.begin();assert.equal(f.deps.busy(),true);assert.equal(f.deps.busy(null),true);assert.equal(f.deps.busy(task.task_id),false);assert.equal(f.deps.busy('task_other'),true);
 const other=await f.begin({title:'Another',session:'self-update-second-session'});assert.equal(f.deps.busy(task.task_id),true);
 const live=f.app.tools.queue.list;f.app.tools.queue.list=()=>[{job_id:'job_live',process_alive:true}];assert.equal(f.deps.busy(task.task_id),true);f.app.tools.queue.list=live;
 assert.ok(other.task_id);
});
