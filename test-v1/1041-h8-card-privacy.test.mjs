import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDesktop} from '../app/server.mjs';
import {TOOLS} from '../app/tools.mjs';
import {toolResult} from '../app/v06/features.mjs';
import {highRiskError} from '../app/v1/high-risk.mjs';
import {commandHash} from '../app/v1/confirmations.mjs';
let seq=0;
test('permission capability is private in both protocols, including incoming observers and rejection paths',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1041-privacy-')),work=path.join(dir,'work');fs.mkdirSync(work);const app=await createDesktop({stateDir:path.join(dir,'state'),defaultRoot:work,uiKey:'bc'.repeat(32),adminAccess:{supported:()=>false,ready:()=>false}});t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});await app.handle('/api/access',{enabled:true});await app.handle('/api/mode',{mode:'full',confirm:true});
 const seen=[],capture=(object,method)=>{const original=object[method];object[method]=function(...args){seen.push(JSON.stringify(args));return original.apply(this,args);};};
 for(const method of ['receiveRPC','handled'])capture(app.tools.trace,method);capture(app.tools.valueStats,'enqueue');for(const method of ['before','after'])capture(app.tools.resume,method);capture(app.store,'audit');
 // Isolated migration fixture: an already-issued pre-1060 permission card.
 app.tools.confirmations.offerSettingsCards=true;
 for(const modern of [false,true]){
  const session='privacy-'+modern,rpc=async(name,args={})=>(await app.tools.rpc({jsonrpc:'2.0',id:++seq,method:'tools/call',params:{name,arguments:args,_meta:{'openai/session':session,...(modern?{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}:{})}}},'privacy-caller',{setupPrincipal:'privacy-fixture'})).result;
  const begin=await rpc('begin_task',{request_id:'privacy-task-'+(++seq),title:'privacy',new_task:true}),task=app.policy.get(begin.structuredContent.task_id),blocked=highRiskError('gatekeeper').details.blocked,c=app.tools.confirmations.create({task_id:task.id,session_hash:task.session_hash,blocked,hash:commandHash({program:'fixture',args:[],cwd:work})});
  assert.equal((await rpc('request_permission',{task_id:task.id,confirm_id:c.id})).structuredContent.code,'TOOL_UNKNOWN');
  const card=toolResult(app.tools.h8Cards.permission(task.id,c.id,'privacy-caller',task.session_hash,modern?'2026-07-28':'legacy')),nonce=card._meta['chathand/card_nonce'];assert.match(nonce,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(card).split(nonce).length-1,1);assert.equal(JSON.stringify(card.content).includes(nonce),false);assert.equal(JSON.stringify(card.structuredContent).includes(nonce),false);assert.equal(seen.join('\n').includes(nonce),false);
  const guessed=await rpc('card_answer',{nonce:'0'.repeat(64),choice:'always'});assert.equal(guessed.isError,true);assert.equal(app.tools.confirmations.get(c.id).state,'waiting');
  const injected=await rpc('card_answer',{nonce,choice:'always',[nonce]:nonce});assert.equal(injected.isError,true);assert.equal(JSON.stringify(injected).includes(nonce),false);assert.equal(seen.join('\n').includes(nonce),false);
  const answer=await rpc('card_answer',{nonce,choice:'deny'});assert.equal(answer.isError,false);assert.equal(answer.structuredContent.state,'denied');assert.equal(JSON.stringify(answer).includes(nonce),false);assert.equal(seen.join('\n').includes(nonce),false);assert.equal((await rpc('card_answer',{nonce,choice:'deny'})).isError,true);
 }
 const tools=TOOLS.filter(x=>['request_permission','card_answer'].includes(x.name));assert.equal(tools.length,1);assert.equal(tools.find(x=>x.name==='card_answer')._meta['openai/visibility'],'private');assert.equal(tools.find(x=>x.name==='card_answer')._meta['openai/widgetAccessible'],true);assert.equal(TOOLS.some(x=>['card_probe','card_probe_report'].includes(x.name)),false);
});
