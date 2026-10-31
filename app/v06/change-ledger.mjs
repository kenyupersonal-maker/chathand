import fs from 'node:fs';
import path from 'node:path';
import {digest,fail,privateDir,saveJSON} from '../../engine/src/core.mjs';
import {localText} from '../i18n.mjs';

const MAX_BYTES=2*1024*1024,hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const invalid=()=>fail('CHANGE_LOG_INVALID',localText('ui.server.undo.invalidLedger'));
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
const entry=x=>plain(x)&&typeof x.tool==='string'&&typeof x.status==='string';
function readJSON(file){
 const st=fs.lstatSync(file);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>MAX_BYTES)invalid();
 try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{invalid();}
}
// Each immutable block is bounded independently. The head never grows with
// completed history. Missing/reordered blocks cannot become a partial undo plan.
export class ChangeLedger {
 constructor(dir){this.dir=dir;}
 file(id){return path.join(this.dir,id+'.json');}
 blocks(id){return path.join(this.dir,id+'.blocks');}
 state(id){
  const file=this.file(id);
  if(!fs.existsSync(file)){
   // A lost head must not make an existing chain look like a no-change task.
   try{fs.lstatSync(file);invalid();}catch(e){if(e.code!=='ENOENT')throw e;}
   if(fs.existsSync(this.blocks(id)))invalid();
   return {head:{version:2,task_id:id,count:0,tail:null,complete:true,pending:[]},changes:[]};
  }
  const head=readJSON(file);
  if(Array.isArray(head)){
   if(!head.every(entry))invalid();
   // Under the two legacy writers, slice() leaves 300 entries forever. Byte
   // eviction leaves its newest save_files until a later 300-entry slice.
   return {legacy:true,head:{version:2,task_id:id,count:0,tail:null,complete:head.length<300&&!head.some(c=>c.tool==='save_files'),pending:[]},changes:head};
  }
  if(!plain(head)||head.version!==2||head.task_id!==id||!Number.isSafeInteger(head.count)||head.count<0||typeof head.complete!=='boolean'||!Array.isArray(head.pending)||head.pending.some(x=>typeof x!=='string')||new Set(head.pending).size!==head.pending.length||(head.count===0?head.tail!==null:!hash(head.tail)))invalid();
  const changes=[];let tail=head.tail;
  if(head.count){const st=fs.lstatSync(this.blocks(id));if(!st.isDirectory()||st.isSymbolicLink())invalid();}
  for(let index=head.count;index>0;index--){
   if(!hash(tail))invalid();
   let block;try{block=readJSON(path.join(this.blocks(id),tail+'.json'));}catch{invalid();}
   if(!plain(block)||block.version!==1||block.index!==index||digest(JSON.stringify(block))!==tail||!entry(block.change))invalid();
   changes.push(block.change);tail=block.previous;
  }
  if(tail!==null)invalid();
  return {head,changes:changes.reverse()};
 }
 check(change){
  if(!entry(change))invalid();
  if(Buffer.byteLength(JSON.stringify({version:1,index:Number.MAX_SAFE_INTEGER,previous:'f'.repeat(64),change},null,2))>MAX_BYTES)
   fail('CHANGE_LOG_LIMIT',localText('ui.server.undo.ledgerLimit'));
 }
 saveHead(id,head){
  if(Buffer.byteLength(JSON.stringify(head,null,2))>MAX_BYTES)fail('CHANGE_LOG_LIMIT',localText('ui.server.undo.ledgerLimit'));
  saveJSON(this.file(id),head);
 }
 block(id,head,change){
  this.check(change);privateDir(this.blocks(id));
  const block={version:1,index:head.count+1,previous:head.tail,change},tail=digest(JSON.stringify(block));
  saveJSON(path.join(this.blocks(id),tail+'.json'),block);
  return {...head,count:block.index,tail};
 }
 writable(id){
  const state=this.state(id);
  if(state.legacy){for(const change of state.changes)state.head=this.block(id,state.head,change);this.saveHead(id,state.head);}
  return state;
 }
 prepare(id,operationId,change){
  this.check(change);const state=this.writable(id);
  if(operationId&&state.changes.some(c=>c.operation_id===operationId))return false;
  const key=operationId||change.tool;
  if(state.head.pending.includes(key))return false;
  this.saveHead(id,{...state.head,pending:[...state.head.pending,key]});return true;
 }
 cancel(id,operationId){
  const {head}=this.writable(id);
  if(head.pending.includes(operationId))this.saveHead(id,{...head,pending:head.pending.filter(x=>x!==operationId)});
 }
 append(id,change){
  const state=this.writable(id),key=change.operation_id||change.tool;
  const existing=change.operation_id&&state.changes.some(c=>c.operation_id===change.operation_id);
  // Also protect reconciliation/legacy callers which only register an already
  // applied result. Production mutation paths prepare before their side effect.
  if(!existing&&!state.head.pending.includes(key)){
   state.head={...state.head,pending:[...state.head.pending,key]};this.saveHead(id,state.head);
  }
  const head=existing?state.head:this.block(id,state.head,change);
  // The pending intent stays durable until this final head commit succeeds.
  this.saveHead(id,{...head,pending:head.pending.filter(x=>x!==key)});
 }
 read(id,{undo=false}={}){
  const {head,changes}=this.state(id);
  if(undo&&(!head.complete||head.pending.length))fail('CHANGE_LOG_INCOMPLETE',localText('ui.server.undo.incompleteLedger'));
  return changes;
 }
}
