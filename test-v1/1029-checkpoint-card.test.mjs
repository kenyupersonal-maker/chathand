import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {ResumeKeeper} from '../app/v1/resume.mjs';
import {TOOLS} from '../app/tools.mjs';
import {TASK_URI} from '../app/v06/features.mjs';
import {findChrome} from '../test-support/real-chrome.mjs';
import {t as translate} from '../app/i18n.mjs';
const T=(key,params={})=>translate(key,params,'zh');

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const widget=fs.readFileSync(path.join(root,'ui/task-widget.html'),'utf8');
const require=createRequire(import.meta.url);
let chromium=null;try{({chromium}=require('playwright-core'));}catch{}

test('checkpoint 有稳定递增 seq、卡片字段，25 次后仍只保留最近 20 条',()=>{
 let now=1000;const r=new ResumeKeeper({now:()=>++now});let last;
 for(let i=1;i<=25;i++)last=r.checkpoint('task-a',{done:'第 '+i+' 块',next:'下一块',block:i,total:25});
 assert.equal(last.task_id,'task-a');assert.equal(last.card,'checkpoint');assert.equal(last.checkpoint_seq,25);
 assert.equal(last.checkpoint.block,25);assert.equal(last.checkpoint.done,'第 25 块');
 assert.equal(last.checkpoints,20);
 const v=r.view({task_id:'task-a',status:'active'});assert.equal(v.checkpoint_seq,25);assert.equal(v.checkpoints,20);
});

test('task_checkpoint 合同指向任务卡，说明写明进度卡',()=>{
 const cp=TOOLS.find(x=>x.name==='task_checkpoint');
 assert.equal(cp._meta.ui.resourceUri,TASK_URI);assert.equal(cp._meta['openai/outputTemplate'],TASK_URI);
 assert.match(cp.description,/进度卡/);
});

async function launch(t){
 if(!chromium||!findChrome()){t.skip('没有 playwright-core 或 Chrome');return null;}
 const browser=await chromium.launch({executablePath:findChrome(),headless:true});t.after(()=>browser.close());
 return browser;
}
const blocker={step:'下载发布包',error:'HTTP 403: Release asset access denied',why:'当前账号没有这个发布包的下载权限。',options:[{label:'改用已下载的包',cost:'需要确认本机已有包是同一版本。'},{label:'先停在这里',cost:'等拿到下载权限后再继续。'}]};
const cp=(seq,theme='light',blocked=null)=>({recorded:true,task_id:'task-cards',card:'checkpoint',checkpoint_seq:seq,checkpoint:{at:Date.now(),block:seq,total:3,done:'第 '+seq+' 块完成：写好测试和界面',next:'下一块',waiting_user:!!blocked,...(blocked?{blocked}:{})},checkpoints:seq,waiting_user:!!blocked,next_action:blocked?'end_turn_and_wait_for_user':'continue_without_stopping',theme});
const status=(blocked=null)=>({task_id:'task-cards',title:'1029 进度卡测试',status:'active',checkpoint_seq:3,last_checkpoint:{at:Date.now(),block:3,total:3,done:'第 3 块完成：写好测试和界面',next:'继续',waiting_user:!!blocked,...(blocked?{blocked}:{})},blocker:blocked,checkpoints:3,recent_steps:[{tool:'write_text',target:'ui/task-widget.html',at:Date.now()-1000,ok:true}],forecast:'none',stall:{stalled:false,waiting_user:!!blocked,quiet_ms:0,threshold_ms:600000,basis:'provisional',last_at:Date.now(),last_tool:'task_checkpoint',running:false}});

async function prepareOuter(page,{uiMessageOk=false}={}){
 await page.setContent('<!doctype html><html><body style="margin:0;background:#eee"><div id="cards" style="display:grid;gap:8px"></div></body></html>');
 await page.evaluate(ok=>{window.__uiMessageOk=ok;window.__uiMessages=[];window.addEventListener('message',e=>{const m=e.data;if(!m||m.jsonrpc!=='2.0'||!m.id)return;if(m.method==='ui/initialize')e.source.postMessage({jsonrpc:'2.0',id:m.id,result:{hostContext:{theme:'light'}}},'*');if(m.method==='ui/message'){window.__uiMessages.push(m.params);e.source.postMessage(window.__uiMessageOk?{jsonrpc:'2.0',id:m.id,result:{ok:true}}:{jsonrpc:'2.0',id:m.id,error:{message:'blocked'}},'*');}});},uiMessageOk);
}
async function addFrame(page,output,theme='light',late=false){
 const handle=await page.evaluateHandle(html=>{const f=document.createElement('iframe');f.style.cssText='border:0;width:720px;height:260px;background:transparent';document.querySelector('#cards').append(f);f.srcdoc=html;return f;},widget);
 const el=handle.asElement();const frame=await el.contentFrame();await frame.waitForLoadState('domcontentloaded');
 await frame.evaluate(({output,theme,late})=>{window.openai={theme,callTool:async(name)=>name==='task_status'?window.__status:{},widgetState:{},setWidgetState(){},notifyIntrinsicHeight(){}};window.__status=null;if(!late){window.openai.toolOutput=output;}},{output,theme,late});
 await frame.evaluate(s=>{window.__status=s;window.dispatchEvent(new Event('openai:set_globals'));},status(output?.checkpoint?.blocked||null));
 return {el,frame};
}
async function cardScenario(t,theme){
 const browser=await launch(t);if(!browser)return;
 const context=await browser.newContext({viewport:{width:820,height:900},colorScheme:theme});const page=await context.newPage();await prepareOuter(page);
 const cards=[];for(let i=1;i<=3;i++)cards.push(await addFrame(page,cp(i),theme));
 await page.waitForTimeout(1800);
 const heights=[];const texts=[];
 for(const c of cards){heights.push(await c.frame.locator('.card').evaluate(e=>e.getBoundingClientRect().height));texts.push(await c.frame.locator('.card').innerText());}
 assert.ok(heights[0]<50&&heights[1]<50,JSON.stringify(heights));assert.ok(heights[2]>100,JSON.stringify(heights));
 assert.match(texts[0],/第 1\/3 块/);assert.match(texts[1],/第 2\/3 块/);assert.match(texts[2],/1029 进度卡测试/);
 const dir=process.env.CHATHAND_SHOT_DIR;if(dir){fs.mkdirSync(dir,{recursive:true});await page.screenshot({path:path.join(dir,'D-cards-'+theme+'.png'),fullPage:true});}
 await context.close();
}

test('三张 checkpoint 卡只有最新一张展开，旧两张收成一行；可出浅色截图',async t=>cardScenario(t,'light'));
test('三张 checkpoint 卡暗色也只留最新一张展开',async t=>cardScenario(t,'dark'));

test('1049 老 8 秒消息回退和并行发送器已关闭',()=>{
 assert.doesNotMatch(widget,/function autoSend\(/);
 assert.doesNotMatch(widget,/function post\(/);
 assert.doesNotMatch(widget,/send\('ui\/message'/);
 assert.doesNotMatch(widget,/task_resume_claim/);
 assert.match(widget,/relay_card_control/);
 assert.match(widget,/sendFollowUpMessage/);
});

test('toolOutput 晚到 openai:set_globals 后仍会渲染任务名',async t=>{
 const browser=await launch(t);if(!browser)return;const page=await browser.newPage({viewport:{width:820,height:500}});await prepareOuter(page);
 const c=await addFrame(page,null,'light',true);await page.waitForTimeout(300);
 const late={task_id:'late-task',title:'晚到的任务数据',status:'active',checkpoint_seq:0,last_checkpoint:null,checkpoints:0,recent_steps:[],forecast:'none',stall:{stalled:false}};
 await c.frame.evaluate(x=>{window.openai.toolOutput=x;window.dispatchEvent(new Event('openai:set_globals'));},late);await page.waitForTimeout(100);
 assert.equal(await c.frame.locator('#title').innerText(),'晚到的任务数据');
});


async function blockerScenario(t,theme){
 const browser=await launch(t);if(!browser)return;const context=await browser.newContext({viewport:{width:820,height:620},colorScheme:theme});const page=await context.newPage();await prepareOuter(page);
 const c=await addFrame(page,cp(3,theme,blocker),theme);await page.waitForTimeout(600);
 const text=await c.frame.locator('.card').innerText();for(const want of ['受阻步骤：下载发布包','错误信息：HTTP 403: Release asset access denied','改用已下载的包','需要确认本机已有包是同一版本。','先停在这里'])assert.match(text,new RegExp(want));
 assert.equal(await c.frame.locator('#blockerOptions button').count(),0);assert.match(await c.frame.locator('#blockerReply').innerText(),/输入框回复/);
 const dir=process.env.CHATHAND_SHOT_DIR;if(dir){fs.mkdirSync(dir,{recursive:true});await page.screenshot({path:path.join(dir,'N-blocker-'+theme+'.png'),fullPage:true});}
 await context.close();
}
test('blocked 进度卡显示卡点、原话、选项和代价（浅色）',async t=>blockerScenario(t,'light'));
test('blocked 进度卡深色显示一致',async t=>blockerScenario(t,'dark'));

test('窗口时间线会记录用户选择，窗口任务面板只读显示 blocker',()=>{
 const ui=fs.readFileSync(path.join(root,'ui/app.js'),'utf8'),server=fs.readFileSync(path.join(root,'app/server.mjs'),'utf8');
 assert.ok(ui.includes('T("ui.window.stepsOf.title.text3",{"choice":t.last_checkpoint.choice})'));assert.equal(T('ui.window.stepsOf.title.text3',{choice:'继续执行'}),'已选择：继续执行');assert.ok(ui.includes('function taskBlocker(b,taskId,checkpointSeq)'));assert.ok(ui.includes('taskBlocker(t.blocker,t.task_id,t.checkpoint_seq)'));
 assert.ok(server.includes('tools.resume.view(t)')||server.includes('tools.resume.view(v)'));
});
