import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {fail,digest,saveJSON,hashConflict} from '../../engine/src/core.mjs';
export function writeLarge(store,rel,content,expected,id){
  store.checkActive(true);
  if(typeof content!=='string'||Buffer.byteLength(content)>8*1024*1024||content.includes('\0'))fail('CONTENT_INVALID','文本写入上限为 8 MiB。');
  if(expected!=='MISSING'&&!/^[a-f0-9]{64}$/.test(expected||''))fail('HASH_REQUIRED','提供当前文件 SHA-256。');
  const record=store.operationFile(id),fingerprint=digest(JSON.stringify([store.root,rel,content,expected]));
  if(fs.existsSync(record)){const old=JSON.parse(fs.readFileSync(record));if(old.fingerprint!==fingerprint)fail('OP_CONFLICT','操作编号冲突。');if(old.status!=='applied')fail('OP_INCOMPLETE','前次操作尚未核实。');return {...old.result,replayed:true};}
  const target=store.writable(rel,true);let before=null;
  try{before=store.bytes(rel);}catch(e){if(e.code!=='ENOENT')throw e;}
  if((before?.sha256||'MISSING')!==expected)hashConflict(store,rel,before?.sha256||'MISSING',expected);
  const receipt={version:1,id,root:store.root,path:rel,fingerprint,status:'prepared',created_at:new Date().toISOString(),before:before?{content:before.content,sha256:before.sha256,mode:before.mode}:null,after_sha256:digest(content)};
  saveJSON(record,receipt);const temp=path.join(path.dirname(target),'.ken-write-'+crypto.randomUUID());
  try{
    const fd=fs.openSync(temp,'wx',before?.mode||0o600);try{fs.writeFileSync(fd,content);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    if(store.writable(rel,true)!==target)fail('PATH_CHANGED','目标位置发生变化。');
    let latest='MISSING';try{latest=store.bytes(rel).sha256;}catch(e){if(e.code!=='ENOENT')throw e;}
    if(latest!==expected)hashConflict(store,rel,latest,expected);
    if(expected==='MISSING'){fs.linkSync(temp,target);fs.unlinkSync(temp);}else fs.renameSync(temp,target);
    receipt.status='applied';receipt.result={path:rel,sha256:receipt.after_sha256,receipt_id:id,created:before===null};saveJSON(record,receipt);
    store.audit({event:'write_text',path:rel,operation_id:id});return receipt.result;
  }finally{try{fs.unlinkSync(temp);}catch{}}
}
