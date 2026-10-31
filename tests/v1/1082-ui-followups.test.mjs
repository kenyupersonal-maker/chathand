// 1082（Claude，1081 本机验收和 Ken 10/28 的意见）：窗口这边的几处跟进。
// 备用那条的「使用」放在卡片右边；Site 的「测试」直接在 ChatGPT 里填好测试话；连接断了那张卡片的说明；
// 自带工作区的名字跟界面语言走；自己放弃的 Site 配对不算出错；应用店装好插件，等「浏览器控制」也显示连上再提示。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const P=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const app=fs.readFileSync(path.join(P,'ui/app.js'),'utf8'),host=fs.readFileSync(path.join(P,'ui/h10/host.mjs'),'utf8'),css=fs.readFileSync(path.join(P,'ui/style.css'),'utf8');
const zh=JSON.parse(fs.readFileSync(path.join(P,'locales/zh.json'),'utf8')),en=JSON.parse(fs.readFileSync(path.join(P,'locales/en.json'),'utf8'));
const between=(src,a,b)=>{const i=src.indexOf(a),j=src.indexOf(b,i);assert.ok(i>=0&&j>i,`${a} … ${b}`);return src.slice(i,j);};
const line=(src,start)=>{const i=src.indexOf(start);assert.ok(i>=0,start);return src.slice(i,src.indexOf('\n',i));};
const T=(k,p)=>p?`${k}${JSON.stringify(p)}`:k;

test('the standby route has a small “Use” button on the right of its card, read out with the full name',()=>{
 const box=vm.createContext({S:{},flash:'',connBusy:'',T,TH:T,E:x=>String(x??''),icon:x=>`<i ${x}>`,btn:(l,a,id,cls)=>`<button ${a} ${cls}>${l}</button>`,
  routeStatus:()=>({st:'online'}),selectedConnection:()=>'openai',routeAdded:()=>true,nbName:x=>x,connRouteName:r=>r==='site'?'ChatGPT Site':'OpenAI',
  connBroken:()=>'<broken>',sentenceJoin:(...a)=>a.filter(Boolean).join(' ')});
 vm.runInContext(between(app,'function connRes(','// 好着的那条下面一句')+between(app,'function connStandby(','// 没加：空状态'),box);
 for(const st of ['online','connecting','idle']){
  box.routeStatus=()=>({st});
  const html=box.connStandby('site');
  assert.match(html,/^<div class="dp-res conn-res[^"]* side[ "]/,`${st}: the card is laid out with the button on the side`);
  assert.doesNotMatch(html,/ stack[ "]/,`${st}: the button does not drop below the text`);
  assert.match(html,/<button class="btn sm primary" type="button" data-action="connUse" data-id="site" aria-label="ui\.window\.conn\.use\{&quot;name&quot;:&quot;ChatGPT Site&quot;\}|<button class="btn sm primary" type="button" data-action="connUse" data-id="site" aria-label="ui\.window\.conn\.use\{"name":"ChatGPT Site"\}">ui\.window\.conn\.useShort<\/button><\/div>/,`${st}: the button sits inside the card and says only “Use”`);
  assert.doesNotMatch(html,/dp-acts/,`${st}: no separate full-width button row under the card`);
 }
 box.connBusy='site';box.routeStatus=()=>({st:'online'});
 assert.match(box.connStandby('site'),/<button class="btn sm primary" type="button" disabled>ui\.window\.conn\.switching<\/button><\/div>/,'while switching the same spot shows the disabled “Switching…”');
 assert.match(css,/\.conn-res\.side>\.btn\{flex:none;align-self:center;margin:0 0 0 6px\}/);
 assert.equal(zh['ui.window.conn.useShort'],'使用');assert.equal(en['ui.window.conn.useShort'],'Use');
});

test('Site “Test” fills in a test message in ChatGPT instead of opening the setup guide',()=>{
 assert.match(line(app,"case'testConnection':"),/^case'testConnection':\{if\(selectedConnection\(\)==='site'\)\{await openChatGPT\(siteTestPrompt\(\)\);return;\}/);
 assert.doesNotMatch(line(app,"case'testConnection':"),/startH10/);
 const run=(S,openai=false)=>{const box=vm.createContext({S,T,crypto:globalThis.crypto,routeAdded:r=>r==='openai'&&openai});vm.runInContext(line(app,'function siteTestPrompt(')+'\n'+between(app,' const nonce=Array.from','const shownAppName'),box);return box.siteTestPrompt();};
 const named=run({chatgpt_apps:{site:{name:' ChatHand · 笔记本\u0007 '},openai:{name:'ChatHand · 笔记本 OpenAI 通道'}}},true);
 const m=named.match(/^ui\.setup\.connectionTestPromptNamed\{"app":"ChatHand · 笔记本","nonce":"([0-9a-f]{24})"\}$/);
 assert.ok(m,'names this Site’s own plugin, without control characters, with a fresh 24-hex test code: '+named);
 assert.notEqual(run({chatgpt_apps:{site:{name:'A'}}}),run({chatgpt_apps:{site:{name:'A'}}}),'each click gets a new code');
 assert.match(run({chatgpt_apps:{openai:{name:'Other'}}},true),/^ui\.setup\.connectionTestPrompt\{"nonce":"[0-9a-f]{24}"\}$/,'no Site plugin known: do not name the other route’s plugin');
 assert.match(run({settings:{chatgpt_app_name:'Only Site'}},false),/^ui\.setup\.connectionTestPromptNamed\{"app":"Only Site"/,'older backend, only Site added: the one registered plugin is the Site’s');
 assert.match(run({settings:{chatgpt_app_name:'Maybe OpenAI'}},true),/^ui\.setup\.connectionTestPrompt\{"nonce"/,'older backend, both routes added: the registered plugin may be the other one, so do not name it');
});

test('the disconnected card says what to do; while reconnecting it only says the connection dropped',()=>{
 assert.equal(zh['ui.window.connModel.held.sub'],'与 ChatGPT 的连接已中断，请点击下方按钮重新连接。');
 assert.equal(zh['ui.window.connModel.held.connectingSub'],'与 ChatGPT 的连接已中断。');
 assert.equal(en['ui.window.connModel.held.connectingSub'],'Disconnected from ChatGPT.');
 const held=line(app,' if(linkHeld())return ');
 assert.match(held,/\{st:'connecting',dot:'spin',label:T\("ui\.window\.connModel\.held\.connecting"\),sub:T\("ui\.window\.connModel\.held\.connectingSub"\)/,'no button while connecting, so no “click below”');
 assert.match(held,/\{st:'paused',dot:'cloud-down',label:T\("ui\.window\.connModel\.held\.label"\),sub:T\("ui\.window\.connModel\.held\.sub"\),left:called,right:btn\(/);
});

test('the built-in workspace shows one name in the interface language, in the scope menu and in the folder note',()=>{
 const box=vm.createContext({S:{project:{name:'默认工作区',path:'/Users/x/ChatHand-Workspace'}},T});
 vm.runInContext(line(app,'function workspaceName('),box);
 assert.equal(box.workspaceName(),'ui.window.workspaceName.default');
 box.S={project:{name:'客户资料',path:'/Users/x/客户资料'}};assert.equal(box.workspaceName(),'客户资料','a name the user gave stays');
 box.S={project:{path:'/Users/x/Projects/site'}};assert.equal(box.workspaceName(),'site','no name: the folder name');
 assert.match(line(app,'function folderScopeNote('),/TH\("ui\.window\.folderScopeNote\.text",\{"value":E\(workspaceName\(\)\)\}\)/,'the folder note uses the same name, not the folder on disk');
 assert.equal(zh['ui.window.workspaceName.default'],'默认工作区');assert.equal(en['ui.window.workspaceName.default'],'Default Workspace');
});

test('a Site pairing the user gave up, cancelled or removed is not shown as an error or as “Site created”',()=>{
 const box=vm.createContext({screen:'f11',receiveEnteredAt:100,receiveLocal:null,watch:{state:'waiting'},uiText:(k,p)=>T(k,p),safeOrigin:o=>o||'',sitePairingErrorCopy:c=>'error:'+c,freshFrom:100});
 vm.runInContext(line(host,'const userStoppedPairing=')+'\n'+line(host,'const pairingStopped=')+'\n'+between(host,'function receiveView(','function safeOrigin(')+'\nglobalThis.pairingStopped=pairingStopped;',box);
 for(const code of ['B_PAIRING_ABANDONED','B_PAIRING_CANCELLED','B_CONNECTION_REMOVED']){
  const p={phase:'failed',error_code:code,updated_at:200};
  assert.deepEqual({...box.receiveView({site_b:{pairing:p}})},{receiveStatus:'waiting',receiveStatusCopy:null},code+': still waiting, not orange');
  assert.equal(box.pairingStopped(p),false,code+': not a stopped pairing');
 }
 const real={phase:'failed',error_code:'B_BINDING_CONFLICT',updated_at:200};
 assert.equal(box.receiveView({site_b:{pairing:real}}).receiveStatus,'error','a real failure is still shown');
 assert.equal(box.pairingStopped(real),true);
});

test('after a Chrome Web Store install, the success notice waits until Browser Use also shows connected',()=>{
 assert.match(app,/async function browserShownConnected\(limit=6000\)\{const until=Date\.now\(\)\+limit;for\(;;\)\{await refresh\(\)\.catch\(\(\)=>\{\}\);if\(browserState\(\)==='connected'\|\|Date\.now\(\)>=until\)return;await new Promise\(r=>setTimeout\(r,500\)\);\}\}/);
 assert.match(line(app,'async function extensionSuccessToast('),/^async function extensionSuccessToast\(message,kind\)\{if\(kind==='chrome-store'\)await browserShownConnected\(\);/,'only the store flow waits; the local install guide is unchanged');
});

// Ken 10/28 12:42、12:43：装插件要么装好了、要么没装好，不说「没能确认装没装好」；「连接断开太久，停下了」「很久没动静」换成标准说法。
// 任务结束的原因，ChatGPT 里的任务卡、窗口、待办里写的那句，三处说法一样。
test('an automatic install that did not finish says so, and points at the manual steps',()=>{
 for(const k of ['ui.window.showChromeInstall.text4','ui.window.showChromeInstall.repairUnconfirmed','ui.chrome.profile.unknown']){
  assert.doesNotMatch(zh[k],/确认|可能|不确定|装好/,k);assert.doesNotMatch(en[k],/confirm|may |not sure|unclear/i,k);
  assert.match(zh[k],/未完成|未安装/,k);assert.match(zh[k],/手动步骤/,k);
 }
 assert.equal(zh['ui.window.showChromeInstall.text4'],'自动安装未完成，请改用手动步骤安装。');
});

test('a task that ended for a reason reads the same on the ChatGPT task card, in the window and in the to-do list',()=>{
 const src=fs.readFileSync(path.join(P,'app/v1/matters.mjs'),'utf8'),m=src.match(/const TASK_END_WORDS=Object\.freeze\((\{[^}]*\})\);/);
 assert.ok(m,'TASK_END_WORDS');const server=vm.runInNewContext('('+m[1]+')');
 const same=[['connection_lost','ui.taskWidget.connectionLost','ui.window.statusWords.stop.text6'],['permission_changed','ui.taskWidget.permissionChanged','ui.window.statusWords.stop.text7'],
  ['paused',null,'ui.window.statusWords.stop.text5'],['workspace_changed',null,'ui.window.statusWords.stop.text8'],['idle',null,'ui.window.statusWords.stop.text2']];
 for(const [reason,card,window] of same){
  assert.equal(server[reason],zh[window],reason+': to-do list = window');
  if(card){assert.equal(zh[card],zh[window],reason+': task card = window');assert.equal(en[card],en[window],reason+': English too');}
 }
 assert.equal(zh['ui.taskWidget.connectionLost'],'因连接中断已停止');
 for(const v of [...Object.values(server),zh['ui.taskWidget.connectionLost'],zh['ui.taskWidget.permissionChanged'],...Object.keys(zh).filter(k=>k.startsWith('ui.window.statusWords.stop.')).map(k=>zh[k])])
  assert.doesNotMatch(v,/停下了|收起了|很久没动静|太久/,v);
});

// Ken 10/28 13:00：说明只给一个动作，不让人自己分辨两种情况；回复中断、等你回复各有自己的说明。
test('a task with no activity for a while is labelled “长时间无活动”, and the note under it says what to do',()=>{
 assert.equal(zh['ui.window.taskState.label.text5'],'长时间无活动');assert.equal(en['ui.window.taskState.label.text5'],'Inactive');
 assert.equal(zh['ui.window.taskNote.text13'],'ChatGPT 已有一段时间无活动');
 assert.equal(zh['ui.window.taskNote.text14'],'请回到 ChatGPT 对话查看进度。');
 assert.doesNotMatch(zh['ui.window.taskNote.text13']+zh['ui.window.taskNote.text14'],/很久|没动|看一眼|半路|即可/);
 assert.match(line(app,"if((!st||!st.running)&&!jobRunning(t)&&Date.now()-lastActiveAt(t)>QUIET_MS)"),/label:T\("ui\.window\.taskState\.label\.text5"\)/);
});

test('a stopped reply gets the same instruction in the window and in the Mac notification',()=>{
 const say=zh['ui.window.taskNote.text12'];
 assert.equal(say,'请回到 ChatGPT 对话发送「继续」，不要点击「重试」。如果无法发送，请先刷新页面。');
 assert.equal(zh['native.notification.stalled.body'],say);assert.ok(zh['native.notification.stalled.namedBody'].endsWith(say));
 assert.equal(en['native.notification.stalled.body'],en['ui.window.taskNote.text12']);
 for(const v of [say,zh['native.notification.stalled.namedBody']])assert.doesNotMatch(v,/（|；|请勿|若/,v);
});
