import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import vm from 'node:vm';
import {chromium} from 'playwright-core';import {findChrome} from '../test-support/real-chrome.mjs';
const widget=fs.readFileSync(new URL('../ui/task-widget.html',import.meta.url),'utf8');
const nonce='a'.repeat(64);
test('window fallback displays an uncertain commit honestly and does not rearm it',async()=>{const ui=fs.readFileSync(new URL('../ui/app.js',import.meta.url),'utf8'),body=ui.slice(ui.indexOf("case'confirmAnswer':"),ui.indexOf("case'revokeAlwaysAllowed':"));let feedback='',armed=0,refreshed=0;const ctx={IN_APP:true,id:'confirm',el:{dataset:{scope:'always'}},S:{confirmations:[{id:'confirm',item:{name:'test'}}]},confirmReady:new Set(['confirm']),confirmArmed:new Set(['confirm']),confirmErrors:new Map(),scheduleRender(){},native:async()=>({ok:false,state:'unknown',do_not_replay:true,result_line:'unconfirmed'}),setConfirmFeedback:(id,text)=>feedback=text,refresh:async()=>refreshed++,armConfirmation:()=>armed++};await vm.runInNewContext('(async()=>{switch("confirmAnswer"){'+body+'}})()',ctx);assert.equal(feedback,'unconfirmed');assert.equal(armed,0);assert.equal(refreshed,1);assert.equal(ctx.confirmReady.size,0);});
const permission=()=>({card:'permission',task_id:'isolated-task',confirm_id:'cf_0123456789abcdef',item:{id:'browser',name:'浏览器控制'},effect:{can_do:'看网页和点按钮',risk:'页面会进入对话'},cause:'读取一个本地测试页',scopes:['always'],chat_ok:true,expires_at:Date.now()+120000,conversation_title:'隔离验收'});
async function harness(t,{transport='openai',theme='light',unknown=false}={}){
 const browser=await chromium.launch({executablePath:findChrome(),headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:740,height:580},colorScheme:theme});
 await page.setContent('<iframe style="border:0;width:700px;height:540px"></iframe>');
 await page.evaluate(({widget,nonce,transport,unknown,theme,output})=>{
  window.__calls=[];window.__messages=[];window.addEventListener('message',e=>{const m=e.data;if(!m?.id)return;let result;if(m.method==='ui/initialize')result={hostContext:{theme}};else if(m.method==='tools/call'){window.__calls.push(m.params);result={structuredContent:{ok:!unknown,state:unknown?'unknown':'allowed',result_line:unknown?'结果尚未确认':'已允许',ai_waiting:true}};}else return;e.source.postMessage({jsonrpc:'2.0',id:m.id,result},'*');});
  const frame=document.querySelector('iframe');frame.srcdoc=widget;frame.onload=()=>{const w=frame.contentWindow;if(transport==='openai'){w.openai={theme,toolOutput:output,toolResponseMetadata:{'chathand/card_nonce':nonce},callTool:async(name,args)=>{window.__calls.push({name,arguments:args});return {structuredContent:{ok:!unknown,state:unknown?'unknown':'allowed',result_line:unknown?'结果尚未确认':'已允许',ai_waiting:true}};},setWidgetState:x=>window.__messages.push(x)};w.dispatchEvent(new Event('openai:set_globals'));}else{w.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:output,_meta:{'chathand/card_nonce':nonce}}},'*');}};
 },{widget,nonce,transport,unknown,theme,output:permission()});
 const frame=page.frames().find(f=>f.parentFrame());await frame.locator('#permissionButtons button').first().waitFor();return {page,frame};
}
for(const transport of ['openai','mcp'])test('permission card consumes its closure capability exactly once through '+transport,async t=>{
 const {page,frame}=await harness(t,{transport,theme:transport==='mcp'?'dark':'light'});assert.equal(await frame.locator('#permissionButtons button').count(),2);
 assert.equal(await frame.locator('#permissionButtons button').first().innerText(),'允许');assert.equal((await frame.locator('body').innerHTML()).includes(nonce),false);
 const shot=process.env.CHATHAND_SHOT_DIR;if(shot){fs.mkdirSync(shot,{recursive:true});await page.screenshot({path:path.join(shot,'1041-permission-'+transport+'.png')});}
 await frame.locator('#permissionButtons button').first().click();await frame.waitForFunction(()=>document.querySelector('#permissionResult').textContent==='已允许');
 await frame.evaluate(()=>answerCard('always'));const calls=await page.evaluate(()=>window.__calls);assert.equal(calls.length,1);assert.equal(calls[0].name,'card_answer');assert.deepEqual(calls[0].arguments,{nonce,choice:'always'});assert.equal(await frame.locator('#permissionButtons button:enabled').count(),0);
});
test('uncertain card result cannot regain a button when host delivers the same old metadata',async t=>{
 const {frame,page}=await harness(t,{unknown:true});await frame.locator('#permissionButtons button').first().click();await frame.waitForFunction(()=>document.querySelector('#state').textContent==='结果待确认');
 await frame.evaluate(()=>window.dispatchEvent(new Event('openai:set_globals')));await frame.evaluate(()=>answerCard('deny'));assert.equal((await page.evaluate(()=>window.__calls)).length,1);assert.equal(await frame.locator('#permissionButtons button:enabled').count(),0);
});
