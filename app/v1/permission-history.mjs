import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {normalizeConversation} from '../links.mjs';

const owners=new WeakMap();
export const bindPermissionHistory=(state,history)=>owners.set(state,history);
export const permissionHistoryFor=state=>owners.get(state);
const text=(v,n=160)=>typeof v==='string'?v.slice(0,n):null;
function clean(value){
 if(!value||!['grant','revoke','tier','restore'].includes(value.action)||!['chat','window','notification','home','tier'].includes(value.via)||!Number.isSafeInteger(value.at)||value.at<=0)return null;
 const row={event_id:text(value.event_id,36)||crypto.randomUUID(),at:value.at,action:value.action,via:value.via};
 if(value.action==='tier'){if(!['full','light'].includes(value.tier))return null;row.tier=value.tier;}
 else if(value.action!=='restore'){if(!['scope','capability','common','high_risk'].includes(value.gate)||!/^[a-z_]{1,40}$/.test(value.id||'')||!text(value.name))return null;Object.assign(row,{gate:value.gate,id:value.id,name:text(value.name),scope:value.scope==='once'?'once':'always',origin_since:Number.isFinite(value.origin_since)?value.origin_since:null});}
 if(value.conversation?.url&&value.conversation?.title)try{row.conversation={url:normalizeConversation(value.conversation.url).url,title:text(value.conversation.title,150)};}catch{}
 return row;
}
/** Successful permission commits only. Append events; compact retention to 200.
 * Snapshot reads use this memory, never re-read the log or change authority. */
export class PermissionHistory{
 constructor(stateDir){this.file=path.join(stateDir,'permission-history.jsonl');this.rows=[];this.writable=true;this.errorCode=null;try{const st=fs.lstatSync(this.file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>1048576){this.writable=false;this.errorCode='PERMISSION_HISTORY_UNAVAILABLE';return;}this.rows=fs.readFileSync(this.file,'utf8').split('\n').filter(Boolean).map(line=>clean(JSON.parse(line))).filter(Boolean).slice(-200);}catch(e){if(e.code!=='ENOENT'){this.writable=false;this.errorCode='PERMISSION_HISTORY_UNAVAILABLE';}}}
 append(event){const row=clean({...event,event_id:crypto.randomUUID(),at:Date.now()});if(!row||!this.writable)return false;let fd,tmp;try{fd=fs.openSync(this.file,fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK,0o600);const st=fs.fstatSync(fd);if(!st.isFile()||st.nlink!==1)throw Error('HISTORY_TYPE');fs.writeFileSync(fd,JSON.stringify(row)+'\n');fs.closeSync(fd);fd=undefined;const rows=[...this.rows,row];if(rows.length>200){tmp=this.file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,rows.slice(-200).map(x=>JSON.stringify(x)).join('\n')+'\n',{mode:0o600,flag:'wx'});fs.renameSync(tmp,this.file);tmp=null;}this.rows=rows.slice(-200);return true;}catch{this.errorCode='PERMISSION_HISTORY_SAVE_FAILED';return false;}finally{if(fd!==undefined)fs.closeSync(fd);if(tmp)try{fs.unlinkSync(tmp);}catch{}}}
 status(){return {available:this.errorCode===null,persisted:this.errorCode===null,error_code:this.errorCode};}
 view({allowed=[],origins={},tier}={}){const keys=new Set(allowed.map(x=>x.gate+':'+x.id)),latestTier=this.rows.findLast(x=>x.action==='tier')?.event_id;return this.rows.toReversed().map(row=>({...structuredClone(row),active:row.action==='tier'?row.event_id===latestTier&&row.tier===tier:row.action==='grant'&&row.scope==='always'&&keys.has(row.gate+':'+row.id)&&origins[row.gate+':'+row.id]?.since===row.origin_since}));}
}
