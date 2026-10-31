// 1027：用户在对话里同意更新以后，ChatGPT 在同一轮里装完、等 ChatHand 重启回来、看工具清单刷新了没有（Ken 10/7 定）。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {Updater} from '../../app/v1/update.mjs';import {createDesktop,needsInterface} from '../../app/server.mjs';import {TOOLS} from '../../app/tools.mjs';import {CONNECTOR_API} from '../../app/product.mjs';
import {clientSettings,clientNeedsInterface,updateWorkPending} from '../../app/v1/client-features.mjs';import {armUpgradeGuard} from '../../app/v08/upgrade-guard.mjs';import {installationTask} from '../../app/v1/update-install-task.mjs';

const CURRENT=JSON.parse(fs.readFileSync(new URL('../../package.json',import.meta.url))).version;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),oldSha='a'.repeat(64),newSha='b'.repeat(64);
const read=rel=>fs.readFileSync(new URL("../../"+rel,import.meta.url),'utf8');
const until=async(fn,ms=3000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return true;await new Promise(r=>setTimeout(r,10));}return false;};

// 和 update.test.mjs 一样的假环境：不联网、不跑真的 codesign，装的时候只记下要启动的升级进程。
function updaterFixture(t,{settings={}}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1027-')),stateDir=path.join(dir,'state'),home=path.join(dir,'upgrades'),downloadsDir=path.join(dir,'Downloads'),latestFile=path.join(dir,'latest.json'),installs=[],bytes=Buffer.from('1027 fixture dmg');for(const p of [stateDir,downloadsDir])fs.mkdirSync(p,{recursive:true});
 const latest={format:'chathand-latest-v1',version:'9.0.0',build:9999,published_at:'2026-10-07T00:00:00Z',notes:'一键在对话里更新\n第二行',min_macos:'14.0',tool_schema_sha256:newSha,dmg:{name:'ChatHand-9.0.0.dmg',url:'https://example.invalid/ChatHand-9.0.0.dmg',sha256:hash(bytes),size:bytes.length},release_page:'https://example.invalid/releases/v9.0.0'};fs.writeFileSync(latestFile,JSON.stringify(latest));
 const f={dir,stateDir,home,downloadsDir,latest,installs,busy:false,busyArgs:[],updated:[],data:{...settings}};
 const exec=async(program,args)=>{
  if(program==='/usr/bin/sw_vers')return {stdout:'15.7.5\n'};
  if(program.endsWith('/gh'))throw Object.assign(Error('FAKE_GH_UNAVAILABLE'),{code:'ENOENT'});
  if(program==='/usr/bin/hdiutil'){if(args[0]==='info')return {stdout:'<plist><dict/></plist>'};if(args[0]==='detach')return {stdout:''};const at=args.indexOf('-mountrandom'),volume=path.join(args[at+1],'mounted'),app=path.join(volume,'ChatHand.app'),runtime=path.join(app,'Contents/Resources/runtime');fs.mkdirSync(path.join(runtime,'bin'),{recursive:true});fs.mkdirSync(path.join(runtime,'scripts'));fs.writeFileSync(path.join(runtime,'package.json'),JSON.stringify({version:latest.version,kenBridge:{build_number:latest.build}}));fs.writeFileSync(path.join(runtime,'bin/node'),'fake-node');fs.writeFileSync(path.join(runtime,'scripts/upgrade.mjs'),'fake-upgrader');fs.writeFileSync(path.join(app,'Contents/Info.plist'),'fake-plist');return {stdout:`<plist><dict><key>mount-point</key><string>${volume}</string></dict></plist>`};}
  if(program==='/usr/bin/ditto'){fs.cpSync(args[0],args[1],{recursive:true});return {stdout:''};}
  if(program==='/usr/bin/codesign')return args[0]==='-d'?{stdout:'',stderr:'designated => identifier "com.kenyu.chathand" and certificate leaf = H"fixture"\n'}:{stdout:''};
  if(program==='/usr/libexec/PlistBuddy')return {stdout:args[1].includes('Identifier')?'com.kenyu.chathand':latest.version};
  if(program==='/usr/bin/xattr')return {stdout:''};throw Error('UNEXPECTED_FAKE_COMMAND '+program);
 };
 const spawn=(program,args)=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.unref=()=>{};child.kill=()=>{queueMicrotask(()=>child.emit('close',null));return true;};
  queueMicrotask(()=>{child.emit('spawn');if(program.endsWith('/bin/node')){installs.push({program,args});return;}if(program==='/usr/bin/curl'){fs.writeFileSync(args[args.indexOf('--output')+1],bytes);child.stdout.end('200');child.stderr.end();child.emit('close',0);return;}child.emit('error',Error('UNEXPECTED_FAKE_SPAWN'));});return child;};
 f.make=(extra={})=>new Updater({stateDir,upgradeHome:home,currentAppPath:path.join(dir,'Current.app'),schemaSha:oldSha,version:CURRENT,busy:(...a)=>{f.busyArgs.push(a);return f.busy;},exec,spawn,openURL:async()=>{},state:{data:f.data,save(){}},env:{CHATHAND_UPDATE_URL:pathToFileURL(latestFile).href},currentSystemProxy:()=>null,downloadsDir,aiDelayMs:5,onUpdated:(ju,ai)=>f.updated.push({ju,ai}),...extra});
 f.updater=f.make();
 t.after(()=>{f.updater.close();f.next?.close();fs.rmSync(dir,{recursive:true,force:true});});return f;
}

test('install_update sits before request_update, and upgrade_status can wait',()=>{
 const tool=TOOLS.find(x=>x.name==='install_update');assert.ok(tool);const installIndex=TOOLS.findIndex(x=>x.name==='install_update'),requestIndex=TOOLS.findIndex(x=>x.name==='request_update');assert.ok(installIndex>=0);assert.equal(requestIndex,installIndex+1);assert.equal(TOOLS.at(-1).name,'run_capability');
 assert.deepEqual(tool.inputSchema.required,[]);assert.equal(tool.inputSchema.properties.build.type,'integer');assert.equal(tool.inputSchema.additionalProperties,false);
 assert.ok(tool.description.includes('upgrade_status')&&tool.description.includes('wait_s'));assert.ok(tool.description.includes('只在用户在对话里明确说要更新以后调'));
 const status=TOOLS.find(x=>x.name==='upgrade_status');assert.deepEqual(status.inputSchema.properties.wait_s,{type:'integer',minimum:0,maximum:25});assert.equal(status.annotations.readOnlyHint,true);
 const frozen=JSON.parse(read(`contracts/tools-v${CONNECTOR_API}.json`));assert.deepEqual(frozen,TOOLS);assert.ok(CONNECTOR_API>=15);
 assert.ok(TOOLS.find(x=>x.name==='request_update').description.includes('install_update'));
});

test('updates need no extra switch; the requesting task never holds the install back',()=>{
 assert.equal('ai_install_local' in clientSettings({}),false);assert.equal(clientNeedsInterface('/api/settings',{auto_update:true}),true);
 assert.equal(updateWorkPending({tasks:[{task_id:'a',status:'active'},{task_id:'b',status:'active'}],exceptTask:['a','b']}),false);assert.equal(updateWorkPending({tasks:[{task_id:'a',status:'active'},{task_id:'b',status:'active'}],exceptTask:['a']}),true);
 assert.equal(needsInterface('/api/update/install',{version:'local:1'}),true,'the window keeps its own Install button');
});

test('an official release: plan, start after a short delay, report starting → restarting; the new process reports updated and fires onUpdated once',async t=>{
 const f=updaterFixture(t);assert.throws(()=>f.updater.aiPlan(),{code:'UPDATE_NONE'});
 assert.equal((await f.updater.check()).status,'available');
 const ai=f.updater.forAI();assert.deepEqual(ai.installable,{version:'9.0.0',build:9999,source:'release',notes:'一键在对话里更新\n第二行',how:'install_update_after_user_agrees'});
 assert.throws(()=>f.updater.aiPlan({build:1}),{code:'UPDATE_VERSION_MISMATCH'});
 const plan=f.updater.aiPlan({build:9999});assert.equal(plan.local,false);assert.equal(plan.value,'9.0.0');assert.equal(plan.tool_schema_changed,true);
 f.busy=true;assert.throws(()=>f.updater.aiInstall(plan,{session_hash:'h'.repeat(64)}),{code:'UPDATE_TASK_BUSY'});f.busy=false;
 const r=f.updater.aiInstall(plan,{session_hash:'h'.repeat(64)});assert.equal(r.status,'restarting_soon');assert.equal(r.to.build,9999);assert.ok(r.next_steps.some(s=>s.includes('upgrade_status')));assert.ok(r.message_for_user.includes('ChatHand 会重启'));
 assert.equal(f.updater.aiStatus().phase,'starting');assert.throws(()=>f.updater.aiPlan(),{code:'UPDATE_IN_PROGRESS'});
 const marker=JSON.parse(fs.readFileSync(path.join(f.stateDir,'update-ai.json'),'utf8'));assert.equal(marker.session_hash,'h'.repeat(64));assert.equal(marker.to.build,9999);assert.equal(marker.local,false);
 assert.ok(await until(()=>f.installs.length===1),'the upgrade process is started');assert.equal(f.updater.aiStatus().phase,'restarting');
 // 重启后的新版：同一个状态目录，版本和构建号都是新的；升级事务写下 COMMITTED。
 f.next=f.make({version:'9.0.0',build:9999,schemaSha:newSha});assert.equal(f.next.aiStatus().phase,'verifying','the new process is verifying until the transaction writes its result');
 fs.writeFileSync(path.join(f.stateDir,'update-result.json'),JSON.stringify({status:'COMMITTED',from:CURRENT,to:'9.0.0',schema_from:oldSha,schema_to:newSha,time:new Date().toISOString()}));
 assert.equal(f.next.aiStatus().phase,'updated','reads the committed result right away');f.next.start();
 const st=f.next.aiStatus();assert.equal(st.current.build,9999);assert.equal(st.tools_changed,true);assert.equal(f.updated.length,1);assert.equal(f.updated[0].ai.to.build,9999);assert.equal(f.updated[0].ju.tool_schema_changed,true);
 f.next._readResult();assert.equal(f.updated.length,1,'onUpdated fires once');
 f.next.ack();assert.equal(f.next.aiStatus().phase,'updated','a recent AI install still reads as updated after the bubble is closed');
});

test('a build ChatGPT made here: request_update says to install it in the same turn, and install_update takes it',async t=>{
 const f=updaterFixture(t),appPath=path.join(f.dir,'built','ChatHand.app'),runtime=path.join(appPath,'Contents/Resources/runtime');
 fs.mkdirSync(runtime,{recursive:true});fs.writeFileSync(path.join(runtime,'package.json'),JSON.stringify({version:CURRENT,kenBridge:{build_number:999999,bundle_id:'com.kenyu.chathand'}}));fs.writeFileSync(path.join(appPath,'Contents/Info.plist'),'fake');
 f.updater.exec=async(program,args)=>program==='/usr/libexec/PlistBuddy'?{stdout:args[1].includes('Identifier')?'com.kenyu.chathand':CURRENT.split('-')[0]}:program==='/usr/bin/codesign'?(args[0]==='-d'?{stdout:'',stderr:'designated => identifier "com.kenyu.chathand"\n'}:{stdout:''}):{stdout:''};
 const r=await f.updater.requestLocal({app_path:appPath,note:'对话里一键更新',task_id:'task_req'});assert.equal(r.install_how,'install_update_after_user_agrees');assert.ok(r.next_steps[0].includes('install_update'));assert.ok(r.message_for_user.includes('我接着装'));
 assert.equal(f.updater.forAI().installable.how,'install_update_after_user_agrees');assert.equal(f.updater.forAI().installable.source,'local_build');
 const plan=f.updater.aiPlan({build:999999});assert.equal(plan.local,true);assert.equal(plan.value,'local:999999');assert.equal(plan.request_task,'task_req');
 f.updater.aiInstall(plan);assert.deepEqual(f.busyArgs.at(-1),[['task_req']],'the requesting task does not hold the install back');
});

function fakeUpdater(f){
 return deps=>{f.deps=deps;return {currentBuild:1026,snapshot:()=>({status:'available',install:{state:'idle'}}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0}),
  forAI:()=>f.forAI,aiPlan:args=>{f.plans.push(args);if(f.planError)throw f.planError;return {value:'local:1027',local:true,build:1027,version:'1.0.0',note:'x',request_task:f.requestTask||null,tool_schema_changed:true};},
  aiInstall:(plan,opts)=>{const task=installationTask({build:plan.build,caller:opts.caller,sourceTask:opts.sourceTask,session_hash:opts.session_hash});f.installs.push({plan,opts,installation_task:task.view,tasks:f.app.tools.policy.summary().tasks.map(t=>[t.task_id,t.status])});return {status:'restarting_soon',to:{build:plan.build},installation_task:task.view};},
  aiStatus:()=>f.status};};
}
async function desktop(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1027-desk-')),f={root,plans:[],installs:[],forAI:{status:'available',request:{status:'waiting_user'},installable:{build:1027,how:'install_update_after_user_agrees'}},status:{phase:'idle',current:{version:'1.0.0',build:1026},target:null,install_state:'idle',just_updated:null,tools_changed:null,request:null}};
 f.app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:path.join(root,'work'),uiKey:'f'.repeat(64),adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{computerName:()=> 'Isolated Mac',tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),updaterFactory:fakeUpdater(f),toolsRefreshFactory:()=>({snapshot:()=>f.refresh||{state:'idle'},run:async()=>{throw Error("UNEXPECTED_TOOLS_REFRESH_RUN");},clickByNumber:async()=>{throw Error("UNEXPECTED_TOOLS_REFRESH_CLICK");}})}});
 f.app.tools.policy.enabled=true;f.app.store.paused=false;f.app.store.writesEnabled=true;
 let id=0;f.rpc=async(name,args={},session='conv-update')=>(await f.app.tools.rpc({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args,_meta:{'openai/session':session}}},'chatgpt',{setupPrincipal:'acct-1'})).result;
 t.after(async()=>{await f.app.close();fs.rmSync(root,{recursive:true,force:true});});return f;
}

test('install_update preserves the caller\'s task, creates a bound installation task, and refuses while its command runs',async t=>{
 const f=await desktop(t),call=(n,a)=>f.app.tools.invoke(n,a,'chatgpt');
 const started=await f.rpc('begin_task',{request_id:'upd_1027_a',title:'1027 收尾'});assert.equal(started.isError,false);const task=started.structuredContent;
 const live=f.app.tools.queue.list;f.app.tools.queue.list=()=>[{job_id:'job_live',process_alive:true}];f.app.tools.policy.tasks.get(task.task_id).jobs.push('job_live');
 await assert.rejects(()=>call('install_update',{task_id:task.task_id}),{code:'UPDATE_TASK_BUSY'});assert.equal(f.installs.length,0);
 f.app.tools.queue.list=live;f.app.tools.policy.tasks.get(task.task_id).jobs.pop();
 const r=await f.rpc('install_update',{task_id:task.task_id,build:1027});assert.equal(r.isError,false,JSON.stringify(r.structuredContent));assert.equal(r.structuredContent.status,'restarting_soon');
 assert.deepEqual(f.plans.at(-1),{build:1027});assert.equal(f.installs.length,1);assert.match(f.installs[0].opts.session_hash,/^[a-f0-9]{64}$/);
 assert.deepEqual(f.installs[0].tasks.find(x=>x[0]===task.task_id),[task.task_id,'active'],'the caller task is not falsely completed by starting installation');
 const installed=r.structuredContent.installation_task;assert.notEqual(installed.task_id,task.task_id);assert.equal(installed.status,'installing');assert.equal(installed.source_kind,'install_update');assert.equal(installed.source,'chathand_auto');assert.equal(installed.project_id,task.project_id);assert.equal(installed.root,task.root);assert.equal(installed.session_hash,f.installs[0].opts.session_hash);assert.match(installed.request_id,/^install_/);
 f.planError=Object.assign(Error('现在没有可以装的新版'),{code:'UPDATE_NONE'});const refused=await f.rpc('install_update',{});assert.equal(refused.isError,true);assert.equal(refused.structuredContent.code,'UPDATE_NONE');
});

test('finish card: while an update request waits, "you do" says ChatGPT will install it',async t=>{
 const f=await desktop(t),call=(n,a)=>f.app.tools.invoke(n,a,'chatgpt');
 const task=await call('begin_task',{request_id:'upd_1027_card1',title:'打包'});const r=await call('finish_task',{task_id:task.task_id,summary:'打好了'});assert.equal(r.user_action,'无需操作，ChatGPT 将继续安装新版并告知结果。');
});

test('upgrade_status answers even while ChatHand is paused or verifying an upgrade, waits for a change, and words the next step',async t=>{
 const f=await desktop(t);
 await assert.rejects(()=>f.app.tools.invoke('upgrade_status',{wait_s:30},'chatgpt'),{code:'ARG_INVALID'});
 f.app.tools.policy.enabled=false;let v=(await f.rpc('upgrade_status',{})).structuredContent;assert.equal(v.phase,'idle');assert.ok(v.message.includes('没有在装'));
 assert.equal((await f.rpc('begin_task',{request_id:'upd_1027_paused',title:'x'})).isError,true,'other tools stay blocked while paused');f.app.tools.policy.enabled=true;
 armUpgradeGuard(path.join(f.root,'state'),'1.0.0','guard-1027');v=(await f.rpc('upgrade_status',{})).structuredContent;assert.equal(v.phase,'verifying');assert.equal((await f.rpc('begin_task',{request_id:'upd_1027_verify',title:'x'})).structuredContent.code,'UPGRADE_VERIFYING');
 fs.rmSync(path.join(f.root,'state','upgrade-guard.json'));
 f.status={...f.status,phase:'installing',install_state:'verifying'};setTimeout(()=>{f.status={...f.status,phase:'restarting',install_state:'restarting'};},150);
 const t0=Date.now();v=(await f.rpc('upgrade_status',{wait_s:5})).structuredContent;assert.equal(v.phase,'restarting');assert.ok(Date.now()-t0<4000);assert.ok(v.message.includes('调用会失败'));
 f.status={...f.status,phase:'updated',current:{version:'1.0.0',build:1027},tools_changed:true,just_updated:{tool_schema_changed:true}};f.refresh={state:'running'};let attested=false;setTimeout(()=>{attested=true;f.refresh={state:'refreshed',target_attested:true,message:'目标 ChatGPT 页面已返回绑定的新工具清单'};},150);
 v=(await f.rpc('upgrade_status',{wait_s:5})).structuredContent;assert.equal(v.phase,'updated');assert.equal(v.tools_refresh.state,'refreshed');assert.equal(attested,true,'wait_s waits for the target attestation');assert.equal(v.tools_refresh.target_attested,true);assert.ok(v.message.includes('已装好构建 1027')&&v.message.includes('目标页面已核验绑定的新工具清单')&&v.message.includes('不能据此证明某个旧对话已更新'));
 f.refresh={state:'not_found',message:'设置页里找不到'};v=(await f.rpc('upgrade_status',{})).structuredContent;assert.ok(v.message.includes('拉到最下面点「刷新工具」'));
 f.status={...f.status,tools_changed:false,just_updated:{tool_schema_changed:false}};v=(await f.rpc('upgrade_status',{})).structuredContent;assert.equal(v.tools_refresh.state,'not_needed');assert.ok(v.message.includes('工具没变'));
 f.status={...f.status,phase:'failed',install_message:'没更新成功，已经换回原来的版本'};v=(await f.rpc('upgrade_status',{})).structuredContent;assert.ok(v.message.includes('没装上'));
});

test('ChatHand notes every time ChatGPT fetches the tool list',async t=>{
 const f=await desktop(t),before=(f.app.tools.toolsListSeen||[]).length;
 const r=await f.app.tools.rpc({jsonrpc:'2.0',id:1,method:'tools/list'},'chatgpt',{});assert.equal(r.result.tools.length,TOOLS.length);
 assert.equal(f.app.tools.toolsListSeen.length,before+1);assert.ok(Date.now()-f.app.tools.toolsListSeen.at(-1)<5000);
 const snap=await f.app.snapshot();assert.ok(Array.isArray(snap.tools_list_seen));assert.ok(snap.tools_refresh);
});
