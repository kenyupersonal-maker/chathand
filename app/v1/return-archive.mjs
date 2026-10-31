/**
 * 1049: shrink *visible textual fields* in oversized tool returns.
 * Control refs, card metadata and permissions are never moved to an archive.
 * This runs AFTER the private card envelope is split and BEFORE toolResult
 * constructs its content + structuredContent pair.
 */
import {PACING} from './pacing.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const RETURN_LIMIT_CHARS=PACING.return_limit_chars;
// Preserve the existing eager text-compaction trigger; the visible ceiling is 12k.
const COMPACT_START_CHARS=RETURN_LIMIT_CHARS/3;
const FOLDER='ChatHand-工具返回.noindex';
const MAX_FILE_BYTES=32*1024*1024;
const FIELD_START=320,FIELD_END=80;
const CONTROL=/^(?:ref|refs|.*_ref|nonce|.*_nonce|.*_id|id|.*_ids|permission|permissions|grant|grants|approval|receipt|receipts|blocked|recovery|details|error|code|status|scope|next_action|retry|next_cursor|oldest_cursor|cursor|next_offset|fingerprint|sha256|.*_sha256|resultType|confirmations|chathand_note|chathand_forecast|options|rules|buttons)$/i;
const UNSAFE_KEY=/(?:nonce|witness|host.?cap|(?:card|permit|report|interruption).*token|^_meta$|^_card_meta$|widget.{0,15}meta|(?:image|screenshot|thumbnail|video|audio).*base64|data_base64|^image$|^images$)/i;
const SECRET_KEY=/(?:password|api.?key|access.?token|refresh.?token|secret|authorization|credential|private.?key)/i;
const TOKEN_TEXT=/\bsk-[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~+/-]{16,}|(?:password|api[_-]?key|secret|access[_-]?token)\s*[=:]\s*\S+/i;
const looksBase64=value=>{if(value.length<1100)return false;const s=value.replace(/\s/g,'');return s.length>=1100&&/^[A-Za-z0-9+/]+={0,2}$/.test(s)&&new Set(s.slice(0,1024)).size>=35;};
function mustSkip(value,depth=0){
 if(depth>16)return true; // Unknown nested type: do not risk a partial archive.
 if(typeof value==='string')return TOKEN_TEXT.test(value)||looksBase64(value);
 if(!value||typeof value!=='object')return false;
 if(Array.isArray(value))return value.some(v=>mustSkip(v,depth+1));
 if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))return true;
 for(const [key,v] of Object.entries(value)){
  if(UNSAFE_KEY.test(key)||SECRET_KEY.test(key)||key==='mimeType'&&typeof v==='string'&&v.startsWith('image/'))return true;
  if(mustSkip(v,depth+1))return true;
 }
 return false;
}
function excerpt(value){return value.slice(0,FIELD_START)+'\n…（完整文字已保存在本机，可分段读取）…\n'+value.slice(-FIELD_END);}
function previewTree(value,fields,key='',location='',depth=0){
 if(depth>15||CONTROL.test(key))return value;
 if(typeof value==='string'){
  if(value.length<=650||CONTROL.test(key))return value;
  const field=location||key||'text';
  fields.push({field,text:value});
  return excerpt(value);
 }
 if(Array.isArray(value))return value.map((item,i)=>previewTree(item,fields,key,location+'['+i+']',depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,previewTree(v,fields,k,location?location+'.'+k:k,depth+1)]));
 return value;
}
function safelyWrite(store,fullText,ext){
 // Output archiving must not grant write access when the session is read-only.
 store.checkActive(true);
 const dir=store.writable(FOLDER,true);
 if(path.resolve(dir)!==path.resolve(store.root,FOLDER))throw new Error('tool output path left workspace');
 try{fs.mkdirSync(dir,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
 const st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink())throw new Error('tool output directory unsafe');
 const file=store.writable(path.join(FOLDER,Date.now()+'-'+crypto.randomUUID()+ext),true);
 if(path.dirname(file)!==dir)throw new Error('tool output path changed');
 const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW||0),0o600);
 try{fs.writeFileSync(fd,fullText,'utf8');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 return file;
}
// Find only display arrays/text, never control/authority subtrees.
function candidates(value,arrays,texts,key='',location='$',parent=null,parentKey=null){
 if(CONTROL.test(key))return;
 if(Array.isArray(value)){if(value.length)arrays.push({value,path:location,size:JSON.stringify(value).length});for(let i=0;i<value.length;i++)candidates(value[i],arrays,texts,key,location+'['+i+']',value,i);}
 else if(typeof value==='string'&&value.length>0&&parent)texts.push({parent,key:parentKey,value,path:location});
 else if(value&&typeof value==='object')for(const [k,v] of Object.entries(value))candidates(v,arrays,texts,k,location+'.'+k,value,k);
}
export function compactToolReturn(result,{store,tool,args={}}={}){
 if(!store||!result||typeof result!=='object'||Array.isArray(result)||args.full===true)return result;
 if(tool==='read_file'&&typeof args.path==='string'&&args.path.includes(FOLDER+'/')&&args.max_bytes<=3000)return result;
 let original;try{original=JSON.stringify(result);}catch{return result;}
 if(original.length<=COMPACT_START_CHARS||mustSkip(result))return result;
 const fields=[],projected=previewTree(result,fields),omitted_items={};
 if(tool==='command_result'&&Array.isArray(result.output_events)){projected.output_events=result.output_events.map(e=>({...e}));}
 const budget=RETURN_LIMIT_CHARS-1800;
 let text=JSON.stringify(projected);
 while(text.length>budget){
  const arrays=[],texts=[];candidates(projected,arrays,texts);
  arrays.sort((a,b)=>b.size-a.size);
  if(arrays.length){const a=arrays[0],old=a.value.length;let lo=0,hi=old-1;const saved=a.value.slice();
   while(lo<hi){const n=Math.ceil((lo+hi)/2);a.value.splice(0,a.value.length,...saved.slice(0,n));if(JSON.stringify(projected).length<=budget)lo=n;else hi=n-1;}
   a.value.splice(0,a.value.length,...saved.slice(0,lo));
   if(tool==='command_result'&&a.path==='$.output_events'&&saved[lo]&&Number.isInteger(saved[lo].cursor)){
    if(lo===0&&typeof saved[0].text==='string'){
     const event={...saved[0],text:'',truncated:true,output_partial:true};a.value.push(event);projected.truncated=true;projected.next_cursor=saved[0].cursor+1;
     let start=0,end=saved[0].text.length;while(start<end){const n=Math.ceil((start+end)/2);event.text=saved[0].text.slice(0,n);if(JSON.stringify(projected).length<=budget)start=n;else end=n-1;}
     if(start>0&&saved[0].text.charCodeAt(start-1)>=0xd800&&saved[0].text.charCodeAt(start-1)<=0xdbff)start--;event.text=saved[0].text.slice(0,start);lo=1;
    }else projected.next_cursor=saved[lo].cursor;
   }
   omitted_items[a.path]=(omitted_items[a.path]||0)+old-lo;
  }else{const t=texts.sort((a,b)=>b.value.length-a.value.length)[0];if(!t)break;t.parent[t.key]=t.value.length>80?t.value.slice(0,80):'';}
  const next=JSON.stringify(projected);if(next.length===text.length)break;text=next;
 }
 if(!fields.length&&!Object.keys(omitted_items).length&&text.length===original.length)return result;
 // Retain the entire structured result when items were omitted; the old simple
 // text archive stays directly segment-readable for a single large text field.
 const simple=fields.length===1&&!Object.keys(omitted_items).length;
 const fullText=simple?fields[0].text:original;
 let file=null;if(Buffer.byteLength(fullText,'utf8')<=MAX_FILE_BYTES)try{file=safelyWrite(store,fullText,simple?'.txt':'.json');}catch{}
 const pagination=Object.fromEntries(['next_offset','next_cursor','cursor','offset','limit'].filter(k=>projected[k]!==undefined).map(k=>[k,projected[k]]));
 const summary={compacted:true,saved:!!file,tool,original_chars:original.length,original_bytes:Buffer.byteLength(original,'utf8'),omitted_items,...(file?{file_path:file,read_segments:{tool:'read_file',format:'text',max_bytes:3000,start_offset:0}}:{pagination}),note:file?'本机文件保留完整内容，按read_segments分段读取；控制字段以本次响应为准。':Object.keys(pagination).length?'本次省略部分未保存；按原工具分页参数继续读取。':'这部分没给出，缩小范围再查一次。'};
 return {...projected,output_summary:summary};
}
