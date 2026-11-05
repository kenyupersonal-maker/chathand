import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {workspaceFixture} from '../support/workspace-recovery-fixture.mjs';
import {findChrome} from '../support/real-chrome.mjs';
import {TOOLS} from '../../app/tools.mjs';

const require=createRequire(import.meta.url);
let chromium=null;try{({chromium}=require('playwright-core'));}catch{}
function client(app,{session='workspace-choice',principal='fixture-principal',transport='local_http',locale='zh'}={}){
 let id=0;
 return async(name,args={})=>(await app.tools.rpc({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args,_meta:{'openai/session':session,'openai/locale':locale}}},'chatgpt',{setupPrincipal:principal,transport})).result;
}
const writeArgs=(task_id,name)=>({task_id,path:name,content:'TEST',expected_sha256:'MISSING',operation_id:randomUUID()});
async function missing(t,{locale='zh'}={}){
 const f=await workspaceFixture(t,{missing:false}),app=f.app;await f.post('/api/workspace/check');
 const rpc=client(app,{locale}),started=await rpc('begin_task',{request_id:randomUUID(),title:'测试工作文件夹',new_task:true});
 assert.equal(started.isError,false,JSON.stringify(started.structuredContent));const id=started.structuredContent.task_id;
 assert.equal((await rpc('write_text',writeArgs(id,'before.txt'))).isError,false);
 fs.renameSync(f.work,f.preserved);
 const blocked=await rpc('write_text',writeArgs(id,'blocked.txt'));
 assert.equal(blocked.isError,true);assert.equal(blocked.structuredContent.code,'WORKSPACE_UNAVAILABLE');
 assert.equal(blocked.structuredContent.details.blocked.where.link,'chathand://settings/scope');
 if(locale==='zh'){assert.match(blocked.structuredContent.details.blocked.say_to_user.join(' '),/卡片中选择/);assert.doesNotMatch(blocked.structuredContent.details.blocked.options[0].description,/前往文件范围/);}
 else assert.match(blocked.structuredContent.details.blocked.say_to_user.join(' '),/Choose “Recreate” or “Not now”/);
 const recipe=blocked.structuredContent.details.blocked.choice_card;assert.equal(recipe?.tool,'task_checkpoint',JSON.stringify(blocked.structuredContent));
 const card=await rpc(recipe.tool,recipe.arguments);assert.equal(card.isError,false,JSON.stringify(card.structuredContent));
 const options=card.structuredContent.checkpoint.blocked.options;assert.deepEqual(options.map(x=>x.label),locale==='zh'?['重新建','先不建']:['Recreate','Not now']);
 const nonce=card._meta?.['chathand/card_nonce'];assert.match(nonce,/^[a-f0-9]{64}$/);
 assert.equal(JSON.stringify(card.structuredContent).includes(nonce),false);assert.equal(JSON.stringify(card.content).includes(nonce),false);
 return {f,app,rpc,id,recipe,card,nonce};
}

test('the workspace card recreates the missing folder without reviving the old task',async t=>{
 const {f,app,rpc,id,nonce}=await missing(t);
 const answer=await rpc('card_answer',{nonce,choice:'1'});assert.equal(answer.isError,false,JSON.stringify(answer.structuredContent));
 assert.equal(answer.structuredContent.state,'allowed');assert.match(answer.structuredContent.result_line,/重新建立空文件夹/);
 assert.equal([...app.policy.tasks.values()].filter(x=>x.recovery_control&&x.status==='active').length,0);
 assert.equal(fs.existsSync(f.work),true);assert.deepEqual(fs.readdirSync(f.work),[]);assert.equal(app.policy.get(id).status,'workspace_changed');
 assert.equal((await rpc('card_answer',{nonce,choice:'1'})).isError,true);
 const next=await rpc('begin_task',{request_id:randomUUID(),title:'恢复后继续',new_task:true});assert.equal((await rpc('write_text',writeArgs(next.structuredContent.task_id,'new.txt'))).isError,false);
 assert.equal(fs.readFileSync(path.join(f.preserved,'original.txt'),'utf8'),'ORIGINAL_PROJECT');
});

async function exerciseWidget(t,{locale='zh',theme='light',choice=1}={}){
 if(!chromium||!findChrome()){t.skip('playwright-core or Chrome unavailable');return;}
 const {f,rpc,card}=await missing(t,{locale});
 const browser=await chromium.launch({executablePath:findChrome(),headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:720,height:700},colorScheme:theme});
 await page.exposeFunction('__workspaceRpc',(name,args)=>rpc(name,args));
 await page.setContent(fs.readFileSync(new URL('../../ui/task-widget.html',import.meta.url),'utf8'));
 await page.evaluate(({output,metadata,locale,theme})=>{
  window.__followUp=false;window.openai={theme,locale,toolOutput:output,toolResponseMetadata:metadata,widgetState:{},
   callTool:(name,args)=>window.__workspaceRpc(name,args),setWidgetState(){},notifyIntrinsicHeight(){},sendFollowUpMessage:async()=>{window.__followUp=true;}};
  window.dispatchEvent(new Event('openai:set_globals'));
 },{output:card.structuredContent,metadata:card._meta,locale,theme});
 const choices=page.locator('#blockerOptions button');await choices.first().waitFor({state:'visible'});
 assert.deepEqual(await choices.allTextContents(),locale==='zh'?['重新建','先不建']:['Recreate','Not now']);
 await page.waitForFunction(()=>!document.querySelector('#blockerOptions button')?.disabled);
 const visible=await page.locator('.card').innerText();assert.doesNotMatch(visible,/已完成 1 块|1 block\(s\) done|等外部条件|已明确停在/);
 if(locale==='en')assert.doesNotMatch(visible,/[一-龥]/);
 if(process.env.CHATHAND_SHOT_DIR){fs.mkdirSync(process.env.CHATHAND_SHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.CHATHAND_SHOT_DIR,'workspace-choice-'+locale+'-'+theme+'.png')});}
 await choices.first().focus();if(choice===2)await page.keyboard.press('Tab');
 assert.equal(await choices.nth(choice-1).evaluate(element=>element===document.activeElement),true);
 await page.keyboard.press('Enter');
 await page.waitForFunction(()=>window.__followUp===true);
 if(choice===1){assert.equal(fs.existsSync(f.work),true);assert.deepEqual(fs.readdirSync(f.work),[]);assert.match(await page.locator('#compactText').innerText(),/重新建立空文件夹/);}
 else{assert.equal(fs.existsSync(f.work),false);assert.match(await page.locator('#compactText').innerText(),locale==='en'?/No folder was created/:/未建立文件夹/);}
}

test('the Chinese light task widget recreates the folder',async t=>exerciseWidget(t,{locale:'zh',theme:'light',choice:1}));
test('the Chinese dark task widget keeps the folder paused',async t=>exerciseWidget(t,{locale:'zh',theme:'dark',choice:2}));
test('the English task widget keeps the folder paused',async t=>exerciseWidget(t,{locale:'en',theme:'light',choice:2}));

test('the English recovery card presents and records the not-now choice in English',async t=>{
 const {f,rpc,card,nonce}=await missing(t,{locale:'en'});
 assert.equal(card.structuredContent.checkpoint.blocked.error,'The selected work folder is missing. Files and commands are paused.');
 const answer=await rpc('card_answer',{nonce,choice:'2'});assert.equal(answer.structuredContent.state,'denied');
 assert.equal(answer.structuredContent.result_line,'No folder was created. Files and commands remain paused.');assert.equal(fs.existsSync(f.work),false);
});

test('not now leaves the folder missing and restoring the original is accepted on next use',async t=>{
 const {f,app,rpc,id,nonce,recipe}=await missing(t),answer=await rpc('card_answer',{nonce,choice:'2'});
 assert.equal(answer.isError,false);assert.equal(answer.structuredContent.state,'denied');assert.equal(fs.existsSync(f.work),false);assert.equal(app.store.workspaceStatus().available,false);
 const receipt=await rpc('task_status',{task_id:recipe.arguments.task_id});assert.equal(receipt.isError,false,JSON.stringify(receipt.structuredContent));assert.equal(receipt.structuredContent.status,'completed');
 const other=client(app,{session:'other-session'});assert.equal((await other('task_status',{task_id:recipe.arguments.task_id})).isError,true);
 assert.equal((await rpc('task_checkpoint',recipe.arguments)).isError,true);
 fs.renameSync(f.preserved,f.work);const read=await rpc('read_file',{path:'original.txt'});assert.equal(read.isError,false,JSON.stringify(read.structuredContent));
 assert.equal(app.store.workspaceStatus().available,true);assert.equal(app.policy.get(id).status,'workspace_changed');
});

test('a failed recreate keeps the folder paused and leaves a readable failure receipt',async t=>{
 const {f,rpc,nonce,recipe}=await missing(t),mkdir=fs.mkdirSync;
 t.mock.method(fs,'mkdirSync',(p,...rest)=>{if(p===f.work)throw Object.assign(Error('synthetic denied'),{code:'EACCES'});return mkdir(p,...rest);});
 const answer=await rpc('card_answer',{nonce,choice:'1'});
 assert.equal(answer.structuredContent.state,'failed');assert.equal(fs.existsSync(f.work),false);
 const receipt=await rpc('task_status',{task_id:recipe.arguments.task_id});assert.equal(receipt.isError,false);assert.equal(receipt.structuredContent.status,'failed');
 assert.equal(fs.readFileSync(path.join(f.preserved,'original.txt'),'utf8'),'ORIGINAL_PROJECT');
});

test('a recovery choice does not add a separate task to the app or its history',async t=>{
 const {f,app,rpc,nonce,recipe}=await missing(t),id=recipe.arguments.task_id;
 let snapshot=await app.snapshot();assert.equal(snapshot.tasks.some(x=>x.task_id===id),false);assert.equal(snapshot.history.some(x=>x.task_id===id),false);
 await rpc('card_answer',{nonce,choice:'2'});snapshot=await app.snapshot();
 assert.equal(snapshot.tasks.some(x=>x.task_id===id),false);assert.equal(snapshot.history.some(x=>x.task_id===id),false);
 await f.close();await f.boot();snapshot=await f.app.snapshot();
 assert.equal(snapshot.history.some(x=>x.task_id===id),false);
});

test('control tasks cannot execute work and card capabilities stay bound to the original session and route',async t=>{
 const {f,app,rpc,recipe,nonce}=await missing(t),control=recipe.arguments.task_id;
 const misuse=await rpc('write_text',writeArgs(control,'not-allowed.txt'));assert.equal(misuse.isError,true);assert.equal(fs.existsSync(path.join(f.work,'not-allowed.txt')),false);
 const other=client(app,{session:'other-session'}),otherCard=await other('task_checkpoint',recipe.arguments);assert.equal(otherCard.isError,true);
 assert.equal((await other('card_answer',{nonce,choice:'1'})).isError,true);
 const differentRoute=client(app,{transport:'relay'});assert.equal((await differentRoute('card_answer',{nonce,choice:'1'})).isError,true);
 assert.equal(fs.existsSync(f.work),false);const answer=await rpc('card_answer',{nonce,choice:'2'});assert.equal(answer.structuredContent.state,'denied');
 const schema=TOOLS.find(x=>x.name==='task_checkpoint').inputSchema.properties.blocked.properties.options.items.properties.action.enum;
 assert.ok(!schema.includes('workspace_recreate'));assert.ok(!schema.includes('workspace_later'));
});

test('a different folder or symlink appearing before the answer is never replaced',async t=>{
 const {f,rpc,nonce}=await missing(t);fs.mkdirSync(f.work);fs.writeFileSync(path.join(f.work,'keep.txt'),'KEEP');
 const answer=await rpc('card_answer',{nonce,choice:'1'});assert.notEqual(answer.structuredContent?.state,'allowed');assert.equal(fs.readFileSync(path.join(f.work,'keep.txt'),'utf8'),'KEEP');
});

test('a symlink appearing before the answer is not followed or overwritten',async t=>{
 const {f,rpc,nonce}=await missing(t);fs.symlinkSync(f.other,f.work);
 const answer=await rpc('card_answer',{nonce,choice:'1'});assert.notEqual(answer.structuredContent?.state,'allowed');assert.equal(fs.lstatSync(f.work).isSymbolicLink(),true);assert.equal(fs.readFileSync(path.join(f.other,'other.txt'),'utf8'),'OTHER_PROJECT');
});

test('a recovery lock cannot be released by a competing project change',async t=>{
 const {f,app,rpc,nonce}=await missing(t),recovery=app.tools.workspaceChoices.recovery,original=recovery.resetAuthority.bind(recovery);
 let release,entered;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve);
 t.mock.method(recovery,'resetAuthority',async options=>{await original(options);entered();await gate;});
 const answer=rpc('card_answer',{nonce,choice:'1'});await ready;assert.equal(app.store.workspaceTransitioning,true);
 const competing=await f.post('/api/projects/select',{id:f.secondId});assert.notEqual(competing.status,200);assert.equal(app.store.workspaceTransitioning,true);assert.equal(fs.existsSync(f.work),false);
 release();const finished=await answer;assert.equal(finished.structuredContent.state,'allowed');assert.equal(app.store.workspaceTransitioning,false);assert.equal(fs.existsSync(f.work),true);
});

test('an expired recovery choice cannot recreate a folder',async t=>{
 const {f,app,rpc,nonce}=await missing(t);app.tools.workspaceChoices.now=()=>Date.now()+2*60*60*1000;
 const answer=await rpc('card_answer',{nonce,choice:'1'});assert.equal(answer.isError,true);assert.equal(fs.existsSync(f.work),false);
});
