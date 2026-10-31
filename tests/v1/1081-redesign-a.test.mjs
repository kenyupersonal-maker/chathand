// 1081（Claude，Ken 10/27「能自己判断的就别让人点」+ ChatGPT 复查 D01–D09）：OpenAI 通道向导、建 Site 那页、试用的话。
// - ChatGPT 经 OpenAI 通道来拿过工具清单（setup.openai_seen_at），「添加到 ChatGPT」那一页自己往下走；Site 来的、本机自己调的不算。
// - 试一句那一页：只一行状态（等你发 / 连到了 / 要点允许 / 连好了）；测试码过期自己换；发出去 60 秒还没动静才给帮助。
// - 配好过再来加 OpenAI 通道：测过以后回到「ChatGPT 连接」，不进完成页。
// - 建 Site 那页：后台在等配对代码时不让人点「下一步」，收到了就在这页显示，配好了自己去下一页；帮我配时不停在「在 ChatGPT 里连上」。
// - 测试那句话跟帮我配、设置助手是同一句，末尾让 ChatGPT 只回「连好了，回到 ChatHand 就行」；试用的话 @ 的是这台 Mac 的插件名。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {renderH10} from '../../ui/h10/views.mjs';
import {desktop} from './1052-a-fixture.mjs';
import {SetupTest} from '../../app/v1/setup-test.mjs';
const P=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const read=f=>fs.readFileSync(path.join(P,f),'utf8');
const app=read('ui/app.js'),wizard=read('ui/wizard.js'),host=read('ui/h10/host.mjs');
const zh=JSON.parse(read('locales/zh.json')),en=JSON.parse(read('locales/en.json'));
const between=(src,a,b)=>{const i=src.indexOf(a),j=src.indexOf(b,i+a.length);assert.ok(i>=0&&j>i,`${a} … ${b}`);return src.slice(i,j);};
const lineOf=(src,a)=>{const i=src.indexOf(a);assert.ok(i>=0,a);assert.equal(src.indexOf(a,i+1),-1,`${a} appears once`);const j=src.indexOf('\n',i);return src.slice(i,j<0?undefined:j);};
const plain=x=>JSON.parse(JSON.stringify(x));
const lit=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const fill=(s,v={})=>s.replace(/\{(\w+)\}/g,(m,k)=>Object.hasOwn(v,k)?String(v[k]):m);

test('tools/list over the OpenAI Tunnel marks setup.openai_seen_at; the Site and the local MCP caller do not',async t=>{
 const f=await desktop(t),a=f.app,list=id=>({jsonrpc:'2.0',id,method:'tools/list',params:{}});
 assert.equal((await a.snapshot()).setup.openai_seen_at,null);
 const reached=async(caller,context)=>{const n=a.tools.toolsListSeen?.length||0;try{await a.tools.rpc(list(caller),caller,context);}catch{}assert.ok((a.tools.toolsListSeen?.length||0)>n,`${caller} reached tools/list`);};
 await reached('chatgpt',{transport:'site_b',setupPrincipal:'site-b:authenticated:synthetic-owner:b1:1'});
 assert.equal((await a.snapshot()).setup.openai_seen_at,null,'the Site fetching tools is not the tunnel being added');
 await reached('local-mcp',{transport:'local_http'});
 assert.equal((await a.snapshot()).setup.openai_seen_at,null,'the local MCP token is not ChatGPT');
 await reached('chatgpt',{});
 assert.equal((await a.snapshot()).setup.openai_seen_at,null,'an in-process call has no transport');
 const before=Date.now();
 await reached('chatgpt',{transport:'local_http',setupPrincipal:'tunnel:chatgpt'});
 const seen=(await a.snapshot()).setup.openai_seen_at;
 assert.ok(Number.isSafeInteger(seen)&&seen>=before,'ChatGPT over the tunnel');
 a.tools.openaiToolsListAt=null;
 await reached('chatgpt',{transport:'relay',setupPrincipal:'relay:synthetic'});
 assert.ok((await a.snapshot()).setup.openai_seen_at>=before,'ChatGPT over the relay');
});

function advance(state,{step=2,addPageAt=0}={}){
 const box=vm.createContext({S:state,step,T:k=>k});
 vm.runInContext(lineOf(app,'function openaiLive(){')+'\n'+lineOf(app,'function tunnelText(){'),box);
 vm.runInContext(between(wizard,' function testVerified(){',' function autoAdvance(){')+';globalThis.__a=advanceReady;',box);
 vm.runInContext(`addPageAt=${addPageAt};`,box);
 return box.__a();
}

test('“Add to ChatGPT” moves on by itself once ChatGPT fetched the tools over the tunnel after the page opened',()=>{
 const live={connection:{ready:true,healthy:true,automatic:{}},relay:{online:false}};
 assert.equal(advance({...live,setup:{openai_seen_at:2000}},{addPageAt:1000}),true);
 assert.equal(advance({...live,setup:{openai_seen_at:900}},{addPageAt:1000}),false,'a fetch from before this page does not count');
 assert.equal(advance({...live,setup:{openai_seen_at:null}},{addPageAt:1000}),false);
 assert.equal(advance({...live,setup:{}},{addPageAt:1000}),false);
 assert.equal(advance({connection:{automatic:{}},relay:{online:false},setup:{openai_seen_at:2000}},{addPageAt:1000}),false,'the tunnel itself has to be up');
 assert.match(wizard,/function enterStep\(\)\{if\(step===2\)addPageAt=Date\.now\(\);/);
 // 以前加过、ChatGPT 这次没来拿：每张底下都有「已经加好了？直接去试一句」。试一句那一页：「还没加？回到添加到 ChatGPT」。
 assert.match(wizard,/data-wizard="alreadyAdded">\$\{E\(tx\("ui\.wizard\.alreadyAdded"\)\)\}<\/button><\/p>`;\}/);
 assert.match(wizard,/case'alreadyAdded':stopAdvance\(\);await move\(3\);break;/);
 assert.match(wizard,/case'backToAdd':stopAdvance\(\);await move\(2\);break;/);
 // 自己会往下走的三段，最后一张不放「继续」；试一句那一段不放「上一步」。
 assert.match(wizard,/const autoStep=last&&step>=1&&step<=3,showNext=!autoStep\|\|holdAdvance&&advanceReady\(\);/);
 assert.match(wizard,/const back=step===3\?'':step>0\|\|page>0\?button\(tx\("ui\.wizard\.previous"\),'back'\):'';/);
 assert.doesNotMatch(wizard,/'retest'|ui\.wizard\.retest|ui\.wizard\.connectionAdded/,'no “Test Again” or “I added it” buttons');
});

function testPage(setup_test,{now=1_000_000,sentAgo=null,renewed=false,readAgo=null,triedAgo=null,opened=true}={}){
 const el={innerHTML:''},timers=[],calls=[];
 const box=vm.createContext({S:{setup_test},box:{querySelector:q=>q==='#wizardTest'?el:null},opened,step:3,
  tx:(k,v)=>v?`${k}${JSON.stringify(v)}`:k,E:x=>String(x),tutorialApp:()=>'ChatHand MacMini',
  api:async(p,b)=>{calls.push([p,b]);return {nonce:'fresh',read:false,write:false,verified:false};},draw:()=>calls.push('draw'),updateStatus:()=>calls.push('update'),
  setTimeout:(fn,ms)=>{timers.push(ms);},
  testSentAt:sentAgo==null?0:now-sentAgo,testRenewed:renewed,renewingTest:false,renewTriedAt:triedAgo==null?0:now-triedAgo,readSeenAt:readAgo==null?0:now-readAgo});
 vm.runInContext('globalThis.__t=function(Date){'+between(wizard,"  const test=box.querySelector('#wizardTest');if(test){","\n  if(step===6){")+'}',box);
 box.__t({now:()=>now});
 const state=/data-state="([a-z]+)"/.exec(el.innerHTML)?.[1],line=/<p class="wiz-conn"[^>]*>([^<]*)<\/p>/.exec(el.innerHTML)?.[1];
 return {html:el.innerHTML,state,line,help:(el.innerHTML.match(/<li>/g)||[]).length,timers,calls,box};
}

test('the test page shows one status line and works out what to say by itself',async()=>{
 let v=testPage({nonce:'n1',read:false,write:false,verified:false});
 assert.equal(v.line,'ui.wizard.test.waiting');assert.equal(v.state,'wait');assert.equal(v.help,0);
 assert.equal((v.html.match(/<p /g)||[]).length,1,'one line');

 v=testPage({nonce:'n1',read:true,write:false});
 assert.equal(v.line,'ui.wizard.test.reached');assert.equal(v.state,'wait');
 assert.deepEqual(plain(v.timers),[15500],'looks again after 15 seconds');assert.equal(v.box.readSeenAt,1_000_000);
 v=testPage({nonce:'n1',read:true,write:false},{readAgo:14000});
 assert.equal(v.line,'ui.wizard.test.reached');assert.deepEqual(plain(v.timers),[],'the 15-second check is set once');
 v=testPage({nonce:'n1',read:true,write:false},{readAgo:15000});
 assert.equal(v.line,'ui.wizard.test.needAllow','reached this Mac but no change after 15 seconds: tell them to click Allow');assert.equal(v.state,'attention');
 assert.equal(v.help,2,'this time / every time: one line each (Ken 10/27 10:18)');assert.match(v.html,/<li>ui\.wizard\.test\.allowOnce<\/li><li>ui\.wizard\.test\.allowAlways<\/li>/);
 v=testPage({nonce:'n1',read:true,write:true,verified:false},{readAgo:20000});
 assert.equal(v.line,'ui.wizard.test.reached','both calls in, being confirmed');assert.equal(v.box.readSeenAt,0);

 v=testPage({nonce:'n1',read:true,write:true,verified:true});
 assert.equal(v.line,'ui.wizard.test.passed');assert.equal(v.state,'ok');
 v=testPage({nonce:'n1',read:true,write:true,verified:true,route:'site'});
 assert.equal(v.line,'ui.wizard.test.waiting','a passed Site test is not this tunnel’s');

 // 发出去 60 秒，ChatGPT 还没连到这台 Mac：给三条帮助，带这台的插件名。没发过、或者已经连到了，不给。
 v=testPage({nonce:'n1'},{sentAgo:60000});
 assert.equal(v.help,3);assert.match(v.html,/<ul class="wiz-test-help"><li>ui\.wizard\.test\.help1\{"app":"ChatHand MacMini"\}<\/li>/);
 assert.equal(testPage({nonce:'n1'},{sentAgo:59000}).help,0);
 assert.equal(testPage({nonce:'n1'}).help,0);
 assert.equal(testPage({nonce:'n1',read:true},{sentAgo:90000}).help,0);

 // 测试码过期：自己换一个，不让人点「重新测试」。发过旧的那句才说「已经换成新的」。
 v=testPage({nonce:'old',expired:true},{sentAgo:30000});
 assert.equal(v.line,'ui.wizard.test.renewed');assert.equal(v.state,'attention');
 assert.deepEqual(plain(v.calls),[['/api/setup/test/start',{}]]);assert.equal(v.box.testSentAt,0);assert.equal(v.box.renewingTest,true);
 await new Promise(r=>setImmediate(r));
 assert.equal(v.box.S.setup_test.nonce,'fresh');assert.deepEqual(plain(v.calls).slice(1),['draw'],'redrawn with the new sentence');assert.equal(v.box.renewingTest,false);
 v=testPage({nonce:'old',status:'expired'});
 assert.equal(v.line,'ui.wizard.test.waiting','never sent: swap quietly');assert.deepEqual(plain(v.calls),[['/api/setup/test/start',{}]]);
 assert.deepEqual(plain(testPage({nonce:'old',expired:true},{triedAgo:5000}).calls),[],'not again within 10 seconds');
 assert.equal(testPage({nonce:'old',expired:true,verified:true}).calls.length,0,'already passed: nothing to renew');
 assert.equal(testPage({nonce:'n2'},{renewed:true}).line,'ui.wizard.test.renewed','still says it until they send the new one');
 assert.equal(testPage({nonce:'n2',read:true},{renewed:true}).line,'ui.wizard.test.reached');

 // 点「去 ChatGPT 发这句话」或「复制这句话」才开始数 60 秒。
 assert.match(wizard,/case'copyTest':testSentAt=Date\.now\(\);testRenewed=false;setTimeout\(\(\)=>\{if\(opened\)updateStatus\(\);\},60500\);await window\.openChatGPT\?\.\(prompt\(\)\);break;/);
 assert.match(wizard,/case'copyTestText':testSentAt=Date\.now\(\);testRenewed=false;setTimeout\(\(\)=>\{if\(opened\)updateStatus\(\);\},60500\);await copy\(prompt\(\)\);break;/);
});

function mover({adding,step=3,next=6}){
 const calls=[];
 const box=vm.createContext({S:{settings:{setup_step:step},setup_test:{verified:true}},step,sub:0,holdAdvance:true,adding,tunnel:'tunnel_synthetic01',selectedTier:'full',
  testSentAt:5,testRenewed:true,readSeenAt:5,box:{querySelector:()=>null},
  window:{ChatHandKeyWatch:{cancel:async()=>calls.push('cancel')},openDrawer:p=>calls.push(['drawer',p])},
  stopAdvance:()=>{},tutorialApp:()=>'ChatHand',pageCount:()=>1,shownTier:()=>'full',testVerified:()=>true,
  api:async(p,b)=>{calls.push([p,b]);return {};},draw:()=>calls.push('draw'),enterStep:()=>calls.push('enter'),
  closeWizard:async()=>calls.push('close'),toast:m=>calls.push(['toast',m]),tx:k=>k});
 vm.runInContext(lineOf(wizard,' async function move(next,{toEnd=false}={}){')+'\nglobalThis.__m=move;',box);
 return {box,calls,run:()=>box.__m(next)};
}

test('adding the OpenAI Tunnel after setup: a passed test closes into “ChatGPT Connection” instead of the done page',async()=>{
 const add=mover({adding:true});await add.run();
 assert.deepEqual(plain(add.calls),[['/api/setup/progress',{step:6,tunnel_id:'tunnel_synthetic01',app_name:'ChatHand'}],'close',['drawer','conn'],['toast','ui.wizard.channelAdded']]);
 assert.equal(add.box.S.settings.setup_complete,true,'still recorded as finished');
 const first=mover({adding:false});await first.run();
 assert.deepEqual(plain(first.calls).slice(1),['draw','enter'],'first setup: the done page as before');
 assert.equal(first.box.testSentAt,0);assert.equal(first.box.readSeenAt,0);
 const mid=mover({adding:true,step:2,next:3});await mid.run();
 assert.ok(!plain(mid.calls).some(c=>c==='close'),'only the last step closes');
 assert.match(wizard,/window\.startWizard=async\(\{restart=false,initialStep=null\}=\{\}\)=>\{adding=S\.settings\?\.setup_ever_complete===true\|\|S\.settings\?\.setup_complete===true;/);
 assert.equal(zh['ui.wizard.channelAdded'],'OpenAI 通道已连接并启用');
});

test('the Site page picks up the pairing code by itself while ChatHand is watching, and moves on once paired',()=>{
 const base={provenance:'host',screen:'f10',connectionRoute:'site',setupMode:'manual',connectionActor:'user',guideStep:1,steps:[],templateConfigured:true,sitePromptEnabled:true,workPrompt:'synthetic'};
 const watching=renderH10({...base,siteWatching:true});
 assert.match(watching,new RegExp(`<p class="h10-next" role="status">${lit(zh['ui.h10.views.siteReadyAuto'])}</p>`));
 assert.doesNotMatch(watching,/data-action="to-receive"/,'no “Next” while ChatHand is watching');
 const idle=renderH10({...base,siteWatching:false});
 assert.match(idle,new RegExp(`<button type="button" class="h10-link" data-action="to-receive">${lit(zh['ui.h10.manual.receiveEntry'])}</button></nav>`),'not watching yet: current manual Site offers the receive-code link');assert.equal((idle.match(/data-action="to-receive"/g)||[]).length,1,'one manual receive-code entry while idle');
 const got=renderH10({...base,siteWatching:true,receiveStatus:'received',receiveStatusCopy:'正在配对'});
 assert.match(got,/<div class="h10-next"><p class="h10-receive-state" data-state="received" role="status"><span class="h10-spin" aria-hidden="true"><\/span>正在配对<\/p><\/div>/);
 const bad=renderH10({...base,siteWatching:true,receiveStatus:'error',receiveStatusCopy:'没配成'});
 assert.match(bad,/<div class="h10-next"><p class="h10-receive-state" data-state="error" role="alert">没配成<\/p><\/div>/);
 const file=renderH10({...base,siteWatching:true,templateFileMode:true});
 assert.match(file,new RegExp(lit(zh['ui.h10.views.siteReadyAuto'])),'the template-file page too');
 // F11 照旧用同一行。
 assert.match(renderH10({...base,screen:'f11',receiveMode:'automatic-capable',receiveStatus:'received',receiveStatusCopy:'正在配对'}),/data-state="received"/);
 // host：F10 也看配对进展；配好了 F10/F11 都去「在 ChatGPT 里连上」；帮我配时那一页换成帮我配的进度。
 assert.match(host,/if\(screen!=='f11'&&screen!=='f10'\)return \{receiveStatus:null,receiveStatusCopy:null\};/);
 assert.match(host,/if\(\(screen==='f11'\|\|screen==='f10'\)&&route==='site'&&isHealthy\(b,'site'\)&&routeKey\(s\)!==receiveBaseline\)\{screen='f12';/);
 assert.match(host,/if\(screen==='f12'&&\(setupMode==='assisted'\|\|aiConfiguring\(s\)&&!manualPicked\)\)screen='f7';/);
 assert.match(host,/function setScreen\(value,purpose\)\{if\(value==='f11'\)enterReceive\(purpose\);else if\(value==='f10'\)enterReceive\('pair'\);/);
 assert.match(host,/siteWatching:s\?\.site_b\?\.enrollment_watch\?\.watching===true,appName:appName\(\),/);
});

test('the test sentence is the same everywhere and asks ChatGPT to reply only “Connected. Go back to ChatHand.”',()=>{
 for(const [cat,done] of [[zh,'两次都成功的话，只回我一句：「连好了，回到 ChatHand 就行。」'],[en,'If both work, reply only: “Connected. Go back to ChatHand.”']]){
  for(const k of ['ui.setup.connectionTestPrompt','ui.setup.connectionTestPromptNamed']){
   assert.ok(cat[k].endsWith(done),k);assert.match(cat[k],/\{nonce\}/);
   assert.doesNotMatch(cat[k],/暗号|口令|password/i);
  }
  assert.match(cat['ui.setup.connectionTestPromptNamed'],/@\{app\}/);
 }
 assert.match(wizard,/const prompt=\(\)=>appName\(\)\?window\.ChatHandText\.t\("ui\.setup\.connectionTestPromptNamed", \{app: appName\(\), nonce: S\.setup_test\?\.nonce\|\|''\}\):window\.ChatHandText\.t\("ui\.setup\.connectionTestPrompt", \{nonce: S\.setup_test\?\.nonce\|\|''\}\);/);
 assert.match(host,/uiText\("ui\.setup\.connectionTestPromptNamed",\{app,nonce:t\.nonce\}\):uiText\("ui\.setup\.connectionTestPrompt",\{nonce:t\.nonce\}\)/);
 assert.doesNotMatch(wizard,/"ui\.wizard\.connectionTestPrompt/,'the wizard’s old sentence is not used any more');
});

test('sample prompts @ this Mac’s app name in ChatGPT; the done page says the same name',()=>{
 const run=name=>{const box=vm.createContext({S:{settings:{chatgpt_app_name:name}},T:(k,v)=>fill(zh[k],v)});vm.runInContext(lineOf(app,'function samplePrompts(){')+'\nglobalThis.__p=samplePrompts();',box);return plain(box.__p);};
 assert.deepEqual(run('ChatHand MacMini'),['ui.window.prompts.app1','ui.window.prompts.app2','ui.window.prompts.app3'].map(k=>fill(zh[k],{app:'ChatHand MacMini'})));
 assert.ok(run('ChatHand MacMini')[0].startsWith('@ChatHand MacMini '));
 assert.ok(run(undefined)[0].startsWith('@ChatHand '),'unknown: ChatHand');
 assert.ok(run('  \u0007 ')[0].startsWith('@ChatHand '),'blank after stripping control characters');
 assert.ok(run('A\u0000B')[0].startsWith('@AB '));
 assert.equal(run('x'.repeat(80))[0].split(' ')[0].length,61,'at most 60 characters');
 assert.doesNotMatch(app,/\bPROMPTS\b/);
 assert.match(app,/samplePrompts\(\)\.map\(\(prompt,i\)=>`<button class="prompt-pill"/);
 for(const k of ['ui.window.prompts.app1','ui.window.prompts.app2','ui.window.prompts.app3'])for(const cat of [zh,en])assert.ok(cat[k].startsWith('@{app} '),k);
 for(const cat of [zh,en])for(const k of ['ui.h10.views.completionIntroduction','ui.h10.host.computerSample','ui.h10.host.folderSample'])assert.match(cat[k],/@\{app\}/,k);
 const f15={provenance:'host',screen:'f15',connectionRoute:'site',setupMode:'manual',connectionActor:'user',steps:[],completionView:'current-installation-verified',scope:'folder'};
 const done=renderH10({...f15,appName:'ChatHand MacMini'});
 assert.match(done,new RegExp(lit(fill(zh['ui.h10.views.completionIntroduction'],{app:'ChatHand MacMini'}))));
 assert.match(renderH10(f15),new RegExp(lit(fill(zh['ui.h10.views.completionIntroduction'],{app:'ChatHand'}))));
});

test('ChatGPT is told what to do when the test code is old or belongs to another Mac',()=>{
 let now=1000;const s=new SetupTest({now:()=>now,deviceName:()=>'MacMini'});const {nonce}=s.start();
 const err=f=>{try{f();}catch(e){return {code:e.code,message:e.message};}assert.fail('expected an error');};
 const other=err(()=>s.record('read','not-this-one','session','principal'));
 assert.equal(other.code,'SETUP_TEST_OTHER_DEVICE');assert.equal(other.message,'这里是「MacMini」上的 ChatHand，这个测试码不是它发的。账号里有好几个 ChatHand 的话，换另一个再试。');
 now+=10*60*1000;
 const old=err(()=>s.record('read',nonce,'session','principal'));
 assert.equal(old.code,'SETUP_TEST_EXPIRED');assert.equal(old.message,'这个测试码过期了。回到 ChatHand，用那里新的那句再发一次。');
 const {nonce:second}=s.start();now+=11*60*1000;s.start();
 assert.equal(err(()=>s.record('read',second,'session','principal')).code,'SETUP_TEST_EXPIRED','an earlier code from this Mac');
 assert.doesNotMatch(read('app/v1/setup-test.mjs'),/暗号|测试口令/);
});

// 1081（Claude，Ken 10/27 10:03、10:07、10:18）：两种情况不并成一句；正在自己做的时候不写「会自己好」；要人修的时候不写「正在重连」。
test('Ken 10/27: one case per line, no “it fixes itself”, and the task strip says what is wrong when the connection in use needs fixing',()=>{
 const stripSrc=lineOf(app,'function stripBroken(){');
 const strip=(sel,r,on=false)=>{const box=vm.createContext({connected:()=>on,selectedConnection:()=>sel,routeStatus:()=>r});vm.runInContext(stripSrc+';globalThis.__s=stripBroken;',box);return box.__s();};
 assert.equal(strip('site',{st:'broken',why:'W'}),'W','the Site sign-in expired: say so');
 assert.equal(strip('openai',{st:'broken',why:'K'}),'K','the key stopped working: say so');
 for(const r of [{st:'connecting'},{st:'idle'}])assert.equal(strip('site',r),'',`${r.st}: keep “reconnecting”`);
 assert.equal(strip('site',{st:'broken',why:'W'},true),'','connected: nothing');
 const banner=lineOf(app,' const banner=upgrading()?');
 assert.ok(banner.includes("stripBroken()?E(fullStop(stripBroken()))+' '+tbtn(T(\"ui.window.taskParts.openConn\"),'drawer','conn'):TH(\"ui.window.taskParts.text5\")"),'the button opens ChatGPT Connection');
 assert.ok(lineOf(app," if(upgrading())return {st:'connecting',dot:'spin',").includes("sub:''"),'installing a new version: one line');
 assert.doesNotMatch(between(app,'function connectionPage(){','const m=connModel()'),/<p>/,'the installing page has no second line');
 assert.ok(lineOf(app,'const held=st===').includes("offline:siteRs?.st==='broken'?siteRs.why:T(\"ui.window.connectionPage.offline.text3\")"),'the Site page says what is wrong when ChatHand knows');
 for(const L of [zh,en]){
  assert.ok(L['ui.window.connectionPage.offline.text3'].includes(L===zh?`「${zh['ui.window.connModel.right.text']}」`:`“${en['ui.window.connModel.right.text']}”`),'names the button below it');
  const [a,b]=L['ui.h10.host.siteUpdateCopied'].split('\n');assert.ok(a&&b,'two cases, two lines');
  assert.equal(typeof L['ui.window.taskParts.openConn'],'string');
 }
 for(const k of ['ui.window.action.testConnection.text3','ui.window.offlineReason.text3','ui.window.keyLost.body','ui.wizard.tutorial.test.lead','ui.wizard.test.needAllow','ui.h10.views.assistedWebIntro'])
  assert.doesNotMatch(zh[k],/会自己|自动重连|多半|可能是|不受影响|；/,k);
 assert.doesNotMatch(en['ui.window.action.testConnection.text3'],/automatically|may be/i);
});
