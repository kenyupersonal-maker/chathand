import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createDesktop} from '../../app/server.mjs';import {TOOLS} from '../../app/tools.mjs';import {TASK_URI} from '../../app/v06/features.mjs';

async function fixture(t,request=null){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1022-finish-')),work=path.join(root,'work');fs.mkdirSync(work);
 const app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:work,uiKey:'e'.repeat(64),adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{currentAppPath:path.join(root,'ChatHand.app'),computerName:()=> 'Isolated Mac',tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),updaterFactory:()=>({currentBuild:1021,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})}});
 app.tools.policy.enabled=true;app.store.paused=false;app.store.writesEnabled=true;t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});return app;
}
const begin=(app,id)=>app.tools.invoke('begin_task',{request_id:id,title:'Finish card'},'chatgpt');

test('finish_task renders the task card and accepts a short user_action',()=>{
 const d=TOOLS.find(x=>x.name==='finish_task');
 assert.equal(d._meta['openai/outputTemplate'],TASK_URI);assert.equal(d.inputSchema.properties.user_action.maxLength,60);
 assert.ok(d.description.includes('user_action'));
});

test('result and user action come back for the card; ChatHand defaults fill gaps',async t=>{
 const app=await fixture(t);
 const a=await begin(app,'finish_1021_a'),ra=await app.tools.invoke('finish_task',{task_id:a.task_id,success:false,summary:'测试没过',user_action:'把这条转给 Claude。'},'chatgpt');
 assert.equal(ra.summary,'测试没过');assert.equal(ra.user_action,'把这条转给 Claude。');assert.deepEqual(ra.changes,[]);assert.ok(ra.reply_format.zh.includes('不要再写这两行'));
 const again=await app.tools.invoke('finish_task',{task_id:a.task_id,success:false,summary:'别的',user_action:'别的'},'chatgpt');
 assert.equal(again.replayed,true);assert.equal(again.user_action,'把这条转给 Claude。');
 const b=await begin(app,'finish_1021_b'),rb=await app.tools.invoke('finish_task',{task_id:b.task_id,success:true,summary:'做完了'},'chatgpt');
 assert.equal(rb.user_action,'无需操作。');
 const c=await begin(app,'finish_1021_c'),rc=await app.tools.invoke('finish_task',{task_id:c.task_id,success:false},'chatgpt');
 assert.equal(rc.user_action,'');
 const d=await begin(app,'finish_1021_d');await assert.rejects(app.tools.invoke('finish_task',{task_id:d.task_id,user_action:'字'.repeat(61)},'chatgpt'),{code:'ARG_INVALID'});
});

test('a waiting install request makes the user action ChatHand-defined',async t=>{
 const app=await fixture(t,{status:'waiting_user',version:'1.0.0',build:1022,requested_at:Date.now()});
 const a=await begin(app,'finish_1021_install'),r=await app.tools.invoke('finish_task',{task_id:a.task_id,success:true,summary:'已申请更新',user_action:'等一下'},'chatgpt');
 assert.equal(r.user_action,'无需操作，ChatGPT 将继续安装新版并告知结果。'); // 1027 起 ChatGPT 申请完更新就自己装
});

test('task card shows 结果 and 你要做 from the receipt, not from model text',()=>{
 const w=fs.readFileSync(new URL('../../ui/task-widget.html',import.meta.url),'utf8');
 for(const s of ['结果','你要做','user_action','t.summary','[hidden]{display:none!important}'])assert.ok(w.includes(s),s);
 assert.ok(w.includes("input?.task_id?{task:input"));
});
