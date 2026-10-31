// 1081（Claude，ChatGPT 复查 10/26）：配置流程里几处「看错了、说早了、跳错了」。
// D01：已经在用 Site 时自己加 OpenAI 通道，向导只认 OpenAI 通道自己连没连上、测没测过；半路关掉，「这次要配的」改回 Site。
// D02：自己配的向导开着时，后台记下的动静不再弹「ChatGPT 正在帮你配」盖在上面。
// 进度页改成自己配：Site 已经交给这台 Mac 了就接着往下，不从建 Site 重来；那一页也按自己配的样子显示，不再套「ChatGPT 正在帮你配」。
// Site 帮我配：在 ChatGPT 里发出去以前，进度页说「先发出去」，不说「ChatGPT 正在帮你配」；「已经填好了」那一条不要了。
// 打不开 ChatGPT 桌面版、退到网页版：进度页自己说「到桌面版里发出去」，不再弹本机服务给 ChatGPT 用的那段话。
// 完成页：主按钮是「打开 ChatGPT」。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {renderH10} from '../ui/h10/views.mjs';
const P=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=f=>fs.readFileSync(path.join(P,f),'utf8');
const app=read('ui/app.js'),wizard=read('ui/wizard.js'),host=read('ui/h10/host.mjs');
const zh=JSON.parse(read('locales/zh.json')),en=JSON.parse(read('locales/en.json'));
const between=(src,a,b)=>{const i=src.indexOf(a),j=src.indexOf(b,i+a.length);assert.ok(i>=0&&j>i,`${a} … ${b}`);return src.slice(i,j);};
const lineOf=(src,a)=>{const i=src.indexOf(a);assert.ok(i>=0,a);assert.equal(src.indexOf(a,i+1),-1,`${a} appears once`);const j=src.indexOf('\n',i);return src.slice(i,j<0?undefined:j);};
const plain=x=>JSON.parse(JSON.stringify(x));
const lit=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const T=k=>k;

// 已经在用 Site（好着、测过），OpenAI 通道还没连上。
const siteInUse=(extra={})=>({site_b:{selected:'site',routes:{site:{configured:true,state:'healthy',health_fresh:true}}},setup_route:'openai',
 connection:{automatic:{phase:'idle'}},relay:{online:false},setup_test:{verified:true,route:'site',site_id:'site_1'},...extra});
function appBits(state){
 const box=vm.createContext({S:state,T});
 vm.runInContext(lineOf(app,'function openaiLive(){')+'\n'+lineOf(app,'function tunnelText(){')+'\nglobalThis.__a={openaiLive,tunnelText};',box);
 return box.__a;
}
function wizardBits(state,{step=1,withApp=true,siteUp=true}={}){
 const box=vm.createContext({S:state,step,T,connected:()=>siteUp,connectionText:()=>'ui.window.connectionText.text'});
 if(withApp)vm.runInContext(lineOf(app,'function openaiLive(){')+'\n'+lineOf(app,'function tunnelText(){'),box);
 vm.runInContext(between(wizard,' function testVerified(){',' function autoAdvance(){')+';globalThis.__w={testVerified,linkedTunnel,tunnelLine,advanceReady};',box);
 return box.__w;
}

test('D01: with a Site in use, the add-OpenAI wizard only counts the OpenAI Tunnel itself as connected or tested',()=>{
 const idle=appBits(siteInUse());
 assert.equal(idle.openaiLive(),false);
 assert.equal(idle.tunnelText(),'ui.window.connectionText.idle.text','the tunnel’s own state, not the Site’s 已连接');
 const live=appBits(siteInUse({connection:{ready:true,healthy:true,automatic:{}}}));
 assert.equal(live.openaiLive(),true);assert.equal(live.tunnelText(),'ui.window.connectionText.text4');
 assert.equal(appBits(siteInUse({connection:{display:{connected:false,title:'通道没连上'},automatic:{}}})).tunnelText(),'通道没连上','the server’s own title for the tunnel wins');
 assert.equal(appBits(siteInUse({connection:{automatic:{}}})).tunnelText(),'ui.window.connectionText.text6');

 const w=wizardBits(siteInUse());
 assert.equal(w.linkedTunnel(),false,'the healthy Site does not make the new tunnel “connected”');
 assert.equal(w.advanceReady(),false,'step 1 does not skip ahead on the Site');
 assert.equal(w.tunnelLine(),'ui.window.connectionText.idle.text');
 assert.equal(w.testVerified(),false,'a passed Site test is not a passed tunnel test');
 assert.equal(wizardBits(siteInUse({setup_test:{verified:true}}),{step:3}).advanceReady(),true,'a tunnel test (no route field) still counts');
 assert.equal(wizardBits(siteInUse({connection:{ready:true,healthy:true,automatic:{}}})).advanceReady(),true);
 // 单独跑 wizard.js（没有 app.js 的 openaiLive/tunnelText）时退回原来的 connected/connectionText。
 const bare=wizardBits(siteInUse(),{withApp:false});
 assert.equal(bare.linkedTunnel(),true);assert.equal(bare.tunnelLine(),'ui.window.connectionText.text');

 assert.match(wizard,/if\(conn\)\{const ok=linkedTunnel\(\);conn\.dataset\.state=ok\?'ok':'wait';conn\.textContent=ok\?tx\("ui\.wizard\.tunnelConnected"\):tunnelLine\(\)\|\|tx\("ui\.wizard\.awaitTunnel"\);\}/);
 assert.match(wizard,/step===1\|\|step===2\?!linkedTunnel\(\):step===3\?!testVerified\(\):false\);/);
 assert.match(wizard,/function keyHTML\(\)\{const w=watchState\(\),linked=linkedTunnel\(\),/);
 assert.match(wizard,/const test=box\.querySelector\('#wizardTest'\);if\(test\)\{const t=S\.setup_test\?\.route==='site'\?\{\}:S\.setup_test\|\|\{\};/);
});

async function closeWith(state,step,{fail=false}={}){
 const calls=[];
 const box=vm.createContext({S:state,step,opened:true,box:{hidden:false},stopAdvance:()=>{},document:{querySelector:()=>({inert:true})},
  window:{ChatHandKeyWatch:{cancel:async()=>{calls.push('cancel');}}},
  api:async(p,b)=>{calls.push([p,b]);if(fail)throw Object.assign(Error('X'),{code:'X'});return {};}});
 vm.runInContext(lineOf(wizard,' async function closeWizard(){')+'\nglobalThis.__c=closeWizard;',box);
 await box.__c();
 assert.equal(box.opened,false);assert.equal(box.box.hidden,true);
 return plain(calls);
}

test('D01: closing the add-OpenAI wizard halfway puts “what we are setting up” back to the Site in use',async()=>{
 const back=[['/api/setup/route',{route:'site'}]];
 assert.deepEqual(await closeWith(siteInUse(),2),back);
 assert.deepEqual(await closeWith(siteInUse(),1),['cancel',...back],'the key watch is still cancelled first');
 assert.deepEqual(await closeWith(siteInUse(),2,{fail:true}),back,'a failed call does not throw');
 assert.deepEqual(await closeWith(siteInUse(),6),[],'finished: leave it');
 assert.deepEqual(await closeWith(siteInUse({setup_route:'site'}),2),[]);
 assert.deepEqual(await closeWith(siteInUse({site_b:{selected:'openai',routes:{site:{configured:true}}}}),2),[],'the tunnel is the one in use');
 assert.deepEqual(await closeWith({setup_route:'openai',site_b:{selected:'openai',routes:{}}},2),[],'no Site at all');
});

test('D01: a half-done tunnel wizard does not reopen by itself once a Site is set up',()=>{
 const resumeOf=new Function('state',between(wizard,'const settings=state.settings||{},unfinished=',';\n')+';return resume;');
 assert.equal(resumeOf({settings:{setup_complete:false,setup_step:2}}),true);
 assert.equal(resumeOf({settings:{setup_complete:false,setup_step:2},site_b:{routes:{site:{configured:true}}}}),false);
 assert.equal(resumeOf({settings:{setup_complete:false,setup_step:6}}),false);
 assert.equal(resumeOf({settings:{setup_complete:true,setup_step:2}}),false);
});

async function addSelf(r,{fail=false,setupStep=0}={}){
 const calls=[];
 const box=vm.createContext({S:{settings:{setup_step:setupStep}},closeDrawer:()=>calls.push('close'),
  api:async(p,b)=>{calls.push([p,b]);if(fail)throw Object.assign(Error('X'),{code:'X'});return {};},
  refresh:async()=>{calls.push('refresh');},
  window:{startH10:o=>calls.push(['h10',o]),startWizard:async o=>{calls.push(['wizard',o]);}}});
 vm.runInContext(between(app,'async function connAddSelf(','async function action(')+'\nglobalThis.__f=connAddSelf;',box);
 await box.__f(r);
 return plain(calls);
}

test('D01: “Add It Myself” for the OpenAI Tunnel first records that the tunnel is what we are setting up',async()=>{
 const rec=['/api/setup/route',{route:'openai'}];
 assert.deepEqual(await addSelf('openai'),['close',rec,'refresh',['wizard',{}]]);
 assert.deepEqual(await addSelf('openai',{setupStep:3}),['close',rec,'refresh',['wizard',{initialStep:0}]],'started before: from the top');
 assert.deepEqual(await addSelf('openai',{fail:true}),['close',rec,['wizard',{}]],'the wizard still opens if recording fails');
 assert.deepEqual(await addSelf('site'),['close',['h10',{route:'site',screen:'f10'}]],'the Site path is unchanged');
});

function autoOpen(state,wizardEl){
 const started=[];
 const box=vm.createContext({document:wizardEl===undefined?{}:{getElementById:id=>id==='setupWizard'?wizardEl:null},
  seenFinishedAt:0,activityOpened:false,opened:false,screen:'',busy:false,routeDialog:{open:false},setupMode:'manual',actor:'user',noticeText:'',
  current:()=>box.state,finishedAt:s=>s?.setup_activity?.finished_at||0,finishedRecently:()=>true,
  aiBusy:s=>s?.setup_activity?.active===true,assistedRoute:()=>null,rawVerified:()=>false,start:o=>started.push(o),state});
 vm.runInContext(between(host,'function maybeAutoOpen(){','// 1069 第 2 条')+'\nglobalThis.__m=maybeAutoOpen;',box);
 return {box,started,run:()=>box.__m()};
}

test('D02: while the manual wizard is open, setup activity does not pop up “ChatGPT is setting things up”',()=>{
 const busy={setup_activity:{active:true,last_at:10,route:'openai'}};
 const wiz={hidden:false};
 const m=autoOpen(busy,wiz);
 assert.equal(m.run(),false);assert.deepEqual(m.started,[]);
 wiz.hidden=true;
 assert.equal(m.run(),false,'the same burst stays quiet after the wizard closes');assert.deepEqual(m.started,[]);
 const done=autoOpen({setup_activity:{active:false,finished_at:20}},{hidden:false});
 assert.equal(done.run(),false);assert.deepEqual(done.started,[]);assert.equal(done.box.seenFinishedAt,20,'the finish is marked as seen');
 const plainBusy=autoOpen(busy,null);
 assert.equal(plainBusy.run(),true,'no wizard: opens the progress page as before');assert.deepEqual(plain(plainBusy.started),[{screen:'f7',assisted:true}]);
 assert.equal(autoOpen(busy,{hidden:true}).run(),true,'a closed wizard does not block it');
 assert.equal(autoOpen(busy).run(),true,'a document without getElementById does not throw');
});

async function chooseManual({screen='f7',route='site',b={},creatable=true,replaced=false}={}){
 const calls=[];
 const box=vm.createContext({screen,route,setupMode:'assisted',actor:'ai',manualPicked:false,siteCreatable:()=>creatable,bState:()=>b,bindingReplaced:()=>replaced,
  close:()=>calls.push('close'),window:{startWizard:async()=>{calls.push('wizard');}},setScreen:(v,p)=>calls.push(p===undefined?[v]:[v,p])});
 const head="case'choose-manual':";
 vm.runInContext('globalThis.__x=async()=>{'+between(host,head,'// 1069 A4/A5').slice(head.length)+'};',box);
 await box.__x();
 assert.equal(box.setupMode,'manual');assert.equal(box.actor,'user');assert.equal(box.manualPicked,true,'remembers that the user chose it');
 return plain(calls);
}
function topOf(o){
 const box=vm.createContext({screen:'f12',setupMode:'manual',manualPicked:false,aiConfiguring:()=>true,s:{},...o});
 return vm.runInContext('({'+lineOf(host,'  assistedTop:').trim()+'})',box).assistedTop;
}

test('switching the progress page to manual continues where the Site is, instead of building a new one',async()=>{
 const site=(state,extra={})=>({routes:{site:{configured:true,state}},...extra});
 assert.deepEqual(await chooseManual({b:site('healthy')}),[['f12']],'already handed to this Mac: connect it in ChatGPT');
 assert.deepEqual(await chooseManual({b:site('auth_required')}),[['f11','renew']],'needs re-authorizing first');
 assert.deepEqual(await chooseManual({b:site('auth_required'),replaced:true}),[['f12']],'taken over by another Mac: not a renew');
 assert.deepEqual(await chooseManual({b:{routes:{},pairing:{phase:'awaiting_pairing'}}}),[['f11','pair']]);
 assert.deepEqual(await chooseManual({b:{routes:{},pairing:{phase:'pairing'}}}),[['f11','pair']]);
 assert.deepEqual(await chooseManual({b:{routes:{}}}),[['f10']],'nothing yet: build the Site');
 assert.deepEqual(await chooseManual({screen:'f6',b:site('healthy')}),[['f10']],'only from the progress page');
 assert.deepEqual(await chooseManual({route:'openai',b:site('healthy')}),['close','wizard']);
 assert.deepEqual(await chooseManual({creatable:false}),['close','wizard']);
});

test('after “Set Up Myself”, the connect page is the manual one, even while ChatGPT is still recorded as setting up',()=>{
 assert.equal(topOf({manualPicked:true}),false,'chosen by the user: no “ChatGPT is setting it up” heading');
 assert.equal(topOf({}),true,'opened while ChatGPT is setting up, nothing chosen: as before');
 assert.equal(topOf({setupMode:'assisted',manualPicked:true}),true,'picked “Set Up for Me” again');
 assert.equal(topOf({aiConfiguring:()=>false}),false);
 assert.equal(topOf({screen:'f7',setupMode:'assisted'}),false,'only the connect page');
 assert.match(host,/let opened=false,dispose=null,screen='f6',setupMode='manual',actor='user',manualPicked=false;/);
 assert.match(host,/ setupMode='manual';actor='user';manualPicked=false;guideStep=1;/,'cleared each time the window opens');
 const f12={provenance:'host',screen:'f12',connectionRoute:'site',setupMode:'manual',steps:[{state:'done'},{state:'done'},{state:'done'},{state:'done'},{state:'attention'}]};
 const mine=renderH10({...f12,assistedTop:false});
 assert.match(mine,new RegExp(`<h1>${lit(zh['ui.h10.views.connectionTitle'])}</h1>`),'the manual connect page');
 assert.doesNotMatch(mine,new RegExp(lit(zh['ui.h10.views.assistedProgressTitle'])));
 assert.match(renderH10({...f12,assistedTop:true}),new RegExp(`<h1>${lit(zh['ui.h10.views.assistedProgressTitle'])}</h1>`),'the assisted one is still there for “Set Up for Me”');
});

const STEPS=()=>[{state:'done'},{state:'done'},{state:'pending'},{state:'pending'},{state:'pending'}];
function waiting({s={},steps=STEPS(),...over}={}){
 const box=vm.createContext({s,screen:'f7',route:'site',setupMode:'assisted',launched:true,freshFrom:1000,assistedWeb:false,assistHandoff:null,steps,finishedAt:x=>x?.setup_activity?.finished_at||0,...over});
 vm.runInContext(between(host,' const setupAct=',` if(screen==='f7'){`)+'\nglobalThis.__w={waitingStart,webOnly,handoffFailed};',box);
 return box.__w;
}
function waitFields(o){
 const ctx={uiText:T,screen:'f7',route:'site',launched:true,prefill:'unconfirmed',assistedCopied:false,waitingStart:true,webOnly:false,handoffFailed:false,assistHandoff:null,...o};
 ctx.waitTracked??=ctx.route==='site'; // 1083：通道这条路要后台给了 seen_at 才分「等待开始／已经开始」，没给时跟原来一样
 const box=vm.createContext(ctx);
 return plain(vm.runInContext('({'+between(host,'  assistedWaiting:waitingStart,','  assistedSentenceCopied:')+'})',box));
}

test('Site with “Set Up for Me”: until it is sent in ChatGPT, the progress page says to send it first',()=>{
 assert.equal(waiting().waitingStart,true,'no activity yet');
 assert.equal(waiting({s:{setup_activity:{last_at:500}}}).waitingStart,true,'activity from before this click does not count');
 assert.equal(waiting({s:{setup_activity:{last_at:1000}}}).waitingStart,false,'ChatGPT has started');
 assert.equal(waiting({s:{setup_activity:{finished_at:2000}}}).waitingStart,false);
 for(const over of [{route:'openai'},{launched:false},{freshFrom:0},{setupMode:'manual'},{screen:'f15'}])assert.equal(waiting(over).waitingStart,false,JSON.stringify(over));
 const built=STEPS();built[2]={state:'done'};assert.equal(waiting({steps:built}).waitingStart,false,'the Site is already built');
 const stuck=STEPS();stuck[3]={state:'attention'};assert.equal(waiting({steps:stuck}).waitingStart,false,'something needs attention');

 assert.deepEqual(waitFields({prefill:'confirmed',assistedCopied:true}),{assistedWaiting:true,assistedOpenFailed:false,assistedWeb:false,assistedWebAlt:null,assistedWaitingIntro:'ui.h10.views.assistedWaitingPrefilled',assistedStarted:false});
 assert.equal(waitFields({assistedCopied:true}).assistedWaitingIntro,null,'copied but not filled in: the copied line says it');
 assert.equal(waitFields({}).assistedWaitingIntro,'ui.h10.views.assistedWaitingCopyFirst');
 assert.deepEqual(waitFields({waitingStart:false,prefill:'confirmed',assistedCopied:true}),{assistedWaiting:false,assistedOpenFailed:false,assistedWeb:false,assistedWebAlt:null,assistedWaitingIntro:null,assistedStarted:true});
 assert.equal(waitFields({waitingStart:false,route:'openai'}).assistedStarted,false);

 assert.match(host,/waitingStart\?uiText\("ui\.h10\.views\.assistedWaitingStep"\):steps\[i\]\.detail\|\|activeStepCopy\(i\)\};/);
 assert.match(host,/const statusLabel=statusTone==='active'\?\(waitingStart\?uiText\("ui\.h10\.views\.assistedWaitingStatus"\):uiText\("ui\.h10\.views\.active"\)\):/);
 assert.match(between(host,'async function startAssisted(','function startOpenAIAssisted('),/openFailed:res\?\.opened!==true/,'copying alone does not count as opening ChatGPT');
});

test('a failed desktop handoff stays recoverable until setup starts on the same route',()=>{
 for(const route of ['site','openai']){
  const assistHandoff={route,openFailed:true,openWarning:'opening failed'};
  assert.equal(waiting({route,assistHandoff}).handoffFailed,true);
  const needsRepair=STEPS();needsRepair[3]={state:'attention',detail:'existing connection problem'};
  assert.equal(waiting({route,assistHandoff,steps:needsRepair}).handoffFailed,true,'an existing connection error must not hide the failed launch or retry');
  assert.equal(waiting({route,assistHandoff,s:{setup_activity:{seen_at:1000}}}).handoffFailed,false);
  assert.equal(waiting({route,assistHandoff:{...assistHandoff,route:route==='site'?'openai':'site'}}).handoffFailed,false);
  assert.equal(waitFields({route,handoffFailed:true,assistHandoff}).assistedWaitingIntro,'opening failed');
  assert.equal(waitFields({route,handoffFailed:true,assistHandoff,waitingStart:false}).assistedStarted,false);
 }
 const steps=STEPS(),box=vm.createContext({steps,screen:'f7',handoffFailed:true,waitingStart:true,uiText:T,status:'',activeStepCopy:()=>{throw Error('must not claim setup is running');}});
 vm.runInContext(between(host," if(screen==='f7'){\n  const i=steps.findIndex",' const installedScope=')+'\nglobalThis.result={steps,statusTone};',box);
 assert.equal(box.result.steps[2].state,'attention');assert.equal(box.result.statusTone,'attention');
});

test('1083: OpenAI Tunnel with “Set Up for Me”: once the service reports when ChatGPT last ran a setup command, the page waits for it like the Site does',()=>{
 const seen=at=>({setup_activity:{active:false,last_at:null,seen_at:at}});
 assert.equal(waiting({route:'openai',s:seen(null)}).waitingStart,true,'nothing has run since this click');
 assert.equal(waiting({route:'openai',s:seen(500)}).waitingStart,true,'a run from before this click does not count');
 assert.equal(waiting({route:'openai',s:seen(1000)}).waitingStart,false,'ChatGPT ran its first setup command');
 assert.equal(waiting({route:'openai',s:{setup_activity:{active:false,last_at:null}}}).waitingStart,false,'no seen_at field: as before, never stuck waiting');
 assert.equal(waiting({s:seen(1000)}).waitingStart,false,'the Site counts it too');
 const built=STEPS();built[2]={state:'done'};assert.equal(waiting({route:'openai',s:seen(null),steps:built}).waitingStart,false,'the tunnel is already recorded');
 assert.equal(waiting({route:'openai',assistedWeb:true,s:seen(1000)}).webOnly,false,'web version: ChatGPT has started all the same');
 assert.deepEqual(waitFields({route:'openai',waitTracked:true,prefill:'confirmed',assistedCopied:true}),{assistedWaiting:true,assistedOpenFailed:false,assistedWeb:false,assistedWebAlt:null,assistedWaitingIntro:'ui.h10.views.assistedWaitingPrefilled',assistedStarted:false});
 assert.equal(waitFields({route:'openai',waitTracked:true,waitingStart:false}).assistedStarted,true,'started: no more “paste it and send”');
 assert.match(host,/ const waitTracked=route==='site'\|\|'seen_at' in setupAct;/);
});

test('legacy web guidance stays readable; new local setup failures stay on the progress page',async()=>{
 assert.equal(waiting({assistedWeb:true}).webOnly,true,'the web version opened and nothing has started');
 assert.equal(waiting({assistedWeb:true,route:'openai'}).webOnly,true,'the OpenAI Tunnel too');
 assert.equal(waiting().webOnly,false,'the desktop app opened');
 assert.equal(waiting({assistedWeb:true,s:{setup_activity:{last_at:1000}}}).webOnly,false,'sent from the desktop app: ChatGPT has started');
 assert.equal(waiting({assistedWeb:true,s:{setup_activity:{finished_at:2000}}}).webOnly,false);
 for(const over of [{launched:false},{freshFrom:0},{setupMode:'manual'},{screen:'f15'}])assert.equal(waiting({assistedWeb:true,...over}).webOnly,false,JSON.stringify(over));
 const stuck=STEPS();stuck[3]={state:'attention'};assert.equal(waiting({assistedWeb:true,steps:stuck}).webOnly,false,'something needs attention');

 assert.deepEqual(waitFields({webOnly:true,assistedCopied:true}),{assistedWaiting:true,assistedOpenFailed:false,assistedWeb:true,assistedWebAlt:'ui.h10.views.assistedWebNoApp',assistedWaitingIntro:'ui.h10.views.assistedWebIntro',assistedStarted:false},'say it first; no desktop app is its own line');
 assert.deepEqual(waitFields({webOnly:true,waitingStart:false,route:'openai',assistedCopied:true}),{assistedWaiting:false,assistedOpenFailed:false,assistedWeb:true,assistedWebAlt:'ui.h10.views.assistedWebNoApp',assistedWaitingIntro:'ui.h10.views.assistedWebIntro',assistedStarted:false});

 const start=between(host,'async function startAssisted(','function startOpenAIAssisted(');
 assert.ok(start.includes("openLocalSetupHandoff?.(assistHandoff,{quiet:true})"),'the progress page says it: no pop-up');
 assert.ok(start.includes("assistedWeb=res?.opened==='web';"));
 assert.match(start,/openWarning:res\?\.warning/,'show the actual desktop failure guidance');
 assert.match(host,/templateFileMode=false,assistedCopied=false,assistedWeb=false;/);
 assert.match(host,/templateFileMode=false;assistedCopied=false;assistedWeb=false;assistHandoff=null;/,'reset each time the window opens');

 // app.js：quiet 是进度页自己说了（Ken 10/27 10:18），桌面版、网页版那句都不弹；不传跟原来一样（1053 管着）。
 const fn=app.slice(app.indexOf('async function openLocalSetupHandoff('),app.indexOf('async function openChatGPT('));
 const handoff={prompt:'P',web_warning:'W'};
 const run=async(opened,options)=>{const calls=[],box=vm.createContext({window:{},T,encodeURIComponent,api:async()=>handoff,copyText:async t=>calls.push(['copy',t]),
  native:async(name,args)=>{calls.push([name,args]);return name==='openSetupConversation'?{opened}:{ok:true};},toast:t=>calls.push(['toast',t])});
  vm.runInContext(fn+'\nwindow.openLocalSetupHandoff=openLocalSetupHandoff;',box);const r=await box.window.openLocalSetupHandoff(handoff,options);return {r:plain(r),calls:plain(calls)};};
 const quiet=await run(false,{quiet:true});
 assert.equal(quiet.r.opened,false);assert.equal(quiet.r.copied,true);assert.equal(quiet.r.warning,'ui.window.openLocalSetupHandoff.failedCopied');
 assert.equal(quiet.calls.some(x=>x[0]==='toast'&&x[1]==='W'),false);
 assert.deepEqual(quiet.calls.map(x=>x[0]),['copy','openSetupConversation']);
 const loud=await run(false);assert.deepEqual(loud.calls.at(-1),['toast','ui.window.openLocalSetupHandoff.failedCopied'],'without the option: one short line of its own, not the text written for ChatGPT (Ken 10/28)');
 const desk=await run(true,{quiet:true});assert.equal(desk.r.prefill_requested,true);assert.equal(desk.calls.some(x=>x[0]==='toast'),false,'the desktop app opened: the page says it, no pop-up');
 const deskLoud=await run(true);assert.deepEqual(deskLoud.calls.at(-1),['toast','ui.window.openLocalSetupHandoff.text2'],'without the option: as before');
});

const f7={provenance:'host',screen:'f7',connectionRoute:'site',setupMode:'assisted',statusTone:'active',
 steps:[{state:'done'},{state:'done'},{state:'active',detail:zh['ui.h10.views.assistedWaitingStep']},{state:'pending'},{state:'pending'}]};

test('the progress page: one heading line about what to do now, no separate “already filled in” bar',()=>{
 const waitingHtml=renderH10({...f7,statusLabel:zh['ui.h10.views.assistedWaitingStatus'],assistedWaiting:true,assistedWaitingIntro:zh['ui.h10.views.assistedWaitingPrefilled'],prefill:'confirmed',assistedSentenceCopied:true});
 assert.match(waitingHtml,new RegExp(`<h1>${lit(zh['ui.h10.views.assistedWaitingTitle'])}</h1><p>${lit(zh['ui.h10.views.assistedWaitingPrefilled'])}</p><div class="h10-assist-action"><button[^>]*data-action="back-to-chatgpt"`));
 assert.match(waitingHtml,new RegExp(`<span class="h10-status" data-tone="active"><i aria-hidden="true"></i>${lit(zh['ui.h10.views.assistedWaitingStatus'])}</span>`));
 assert.match(waitingHtml,new RegExp(`<small>${lit(zh['ui.h10.views.assistedWaitingStep'])}</small>`));
 assert.doesNotMatch(waitingHtml,/h10-prefill|reopen-chatgpt/);
 assert.doesNotMatch(waitingHtml,new RegExp(lit(zh['ui.h10.views.assistedProgressTitle'])));
 const started=renderH10({...f7,assistedStarted:true,assistedSentenceCopied:true,prefill:'confirmed'});
 assert.match(started,new RegExp(`<h1>${lit(zh['ui.h10.views.assistedProgressTitle'])}</h1><p>${lit(zh['ui.h10.views.assistedProgressIntroduction'])}</p>`),'sent: no more “paste and send”');
 assert.doesNotMatch(started,/h10-prefill|reopen-chatgpt/);
 const web=renderH10({...f7,statusLabel:zh['ui.h10.views.assistedWaitingStatus'],assistedWaiting:true,assistedOpenFailed:false,assistedWeb:true,assistedWebAlt:zh['ui.h10.views.assistedWebNoApp'],assistedWaitingIntro:zh['ui.h10.views.assistedWebIntro'],assistedSentenceCopied:true});
 assert.match(web,new RegExp(`<h1>${lit(zh['ui.h10.views.assistedWebTitle'])}</h1><p>${lit(zh['ui.h10.views.assistedWebIntro'])}</p><p class="h10-assist-alt">${lit(zh['ui.h10.views.assistedWebNoApp'])}</p>`),'the web version opened: send it in the desktop app; no desktop app on its own line');
 const webTunnel=renderH10({...f7,connectionRoute:'openai',assistedWeb:true,assistedWaitingIntro:zh['ui.h10.views.assistedWebIntro'],assistedSentenceCopied:true});
 assert.match(webTunnel,new RegExp(`<h1>${lit(zh['ui.h10.views.assistedWebTitle'])}</h1><p>${lit(zh['ui.h10.views.assistedWebIntro'])}</p>`));
 const tunnel=renderH10({...f7,connectionRoute:'openai',assistedSentenceCopied:true});
 assert.match(tunnel,new RegExp(`<h1>${lit(zh['ui.h10.views.assistedProgressTitle'])}</h1><p>${lit(zh['ui.h10.views.assistedCopiedIntroduction'])}</p>`),'the OpenAI Tunnel keeps the copied line');
 for(const k of ['ui.h10.views.prefillConfirmed','ui.h10.host.prefillWarning'])assert.doesNotMatch(waitingHtml+started+tunnel,new RegExp(lit(zh[k])),k);
});

test('the done page: “Open ChatGPT” is the main button, “Done” next to it',()=>{
 const html=renderH10({provenance:'host',screen:'f15',connectionRoute:'site',scope:'computer',completionView:'current-installation-verified'});
 const foot=html.match(/<footer class="h10-footer">[\s\S]*?<\/footer>/)?.[0];
 assert.equal(foot,`<footer class="h10-footer"><button type="button" class="h10-button h10-button-primary h10-button-l" data-action="open-chatgpt">${zh['ui.h10.views.openChatGPT']}</button><button type="button" class="h10-button h10-button-l" data-action="finish">${zh['ui.h10.views.finish']}</button></footer>`);
 assert.equal((html.match(/h10-button-primary/g)||[]).length,1);
});

test('copy: zh and en together, plain words, the failure line names the button below it',()=>{
 const keys=['ui.h10.views.assistedWaitingTitle','ui.h10.views.assistedWaitingPrefilled','ui.h10.views.assistedWaitingCopyFirst','ui.h10.views.assistedWaitingStep',
  'ui.h10.views.assistedWaitingStatus','ui.h10.views.assistedWebTitle','ui.h10.views.assistedWebIntro','ui.h10.views.assistedWebNoApp','ui.h10.host.assistedHandoffFailed','ui.h10.host.tunnelCreating','ui.h10.views.assistedDuration','ui.h10.views.assistedExplanation',
  'ui.window.pgConn.toolsUnknownSite','ui.h10.host.operationFailed','ui.h10.host.sourceUnavailable'];
 for(const k of keys){
  assert.equal(typeof zh[k],'string',k);assert.equal(typeof en[k],'string',k);
  assert.doesNotMatch(zh[k],/宿主|回执|设备健康|凭据|核验|实例|握手|心跳|路由|配对摘要|这版 ChatHand|这一版 ChatHand|本人|已批准来源|原连接与授权/,k);
  assert.doesNotMatch(en[k],/receipt|credential|host |device health|verif|this build|handshake|heartbeat|approved source/i,k);
 }
 assert.ok(zh['ui.h10.host.assistedHandoffFailed'].includes(`「${zh['ui.h10.views.copyAssistedSentence']}」`));
 assert.ok(en['ui.h10.host.assistedHandoffFailed'].includes(`“${en['ui.h10.views.copyAssistedSentence']}”`));
 assert.ok(zh['ui.h10.views.assistedWebNoApp'].includes(`「${zh['ui.h10.views.chooseManual']}」`),'names the link below it');
 assert.ok(en['ui.h10.views.assistedWebNoApp'].includes(`“${en['ui.h10.views.chooseManual']}”`));
 for(const L of [zh,en])assert.doesNotMatch(L['ui.h10.views.assistedWebIntro'],new RegExp(lit(L['ui.h10.views.chooseManual'])),'the other case is its own line');
 for(const L of [zh,en])assert.match(L['ui.h10.host.operationFailed'],/\{code\}/);
 assert.doesNotMatch(zh['ui.window.pgConn.toolsUnknownSite'],/看不到它取没取过/);
 assert.doesNotMatch(zh['ui.h10.views.assistedDuration'],/一点/,'it uses Codex quota; no “a little”');
});
