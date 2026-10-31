/** Durable terminal task results, never live grants. Local state only. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {privateDir, saveJSON, fail} from '../engine/src/core.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const REVOCATIONS=new Set(['cancelled','rejected','expired','superseded','revoked','paused','permission_changed','workspace_changed','connection_lost']);
export class TaskReceipts {
  constructor(stateDir) {
    this.dir=path.join(stateDir,'task-receipts'); privateDir(this.dir);this.cache=new Map();this.directorySnapshot=null;
  }
  owner(caller) { return crypto.createHash('sha256').update('ken-task-owner-v1\0'+caller).digest('hex'); }
  read(id,caller) {
    if(typeof id!=='string'||!UUID.test(id)) return null;
    const file=path.join(this.dir,id+'.json');
    let st;try{st=fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
    if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>256*1024)fail('TASK_RECEIPT_UNSAFE','完成回执不是受支持的普通文件。');
    const signature=`${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`,cached=this.cache.get(id);
    let r;if(cached?.signature===signature)r=cached.value;else{try{r=JSON.parse(fs.readFileSync(file,'utf8'));}catch{this.cache.delete(id);fail('TASK_RECEIPT_INVALID','完成回执无法解析；保留文件，不重跑任务。');}}
    if(!r||typeof r!=='object'||Array.isArray(r))fail('TASK_RECEIPT_INVALID','任务回执格式不正确；保留文件，不重跑任务。');
    const result=r.result;
    const completion=r.format===1&&typeof r.success==='boolean'&&result?.status===(r.success?'completed':'failed')&&result.execution_complete===true;
    const revocation=r.format===2&&r.success===null&&REVOCATIONS.has(result?.status)&&result.execution_complete===false&&result.terminal===true;
    if(r.task_id!==id||typeof r.owner_hash!=='string'||result?.task_id!==id||!Array.isArray(result.jobs)||!Number.isSafeInteger(result.finished_at)||(!completion&&!revocation)||Object.hasOwn(r,'connection_principal')&&r.connection_principal!==null&&!(typeof r.connection_principal==='string'&&/^cp:[a-f0-9]{48}$/.test(r.connection_principal)))fail('TASK_RECEIPT_INVALID','任务回执格式不正确；保留文件，不重跑任务。');
    this.cache.set(id,{signature,value:structuredClone(r)});
    return structuredClone(r);
  }
  remember(id,value){const st=fs.lstatSync(path.join(this.dir,id+'.json'));this.cache.set(id,{signature:`${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`,value:structuredClone(value)});}
  invalidateDirectory(){this.directorySnapshot=null;}
  entries(){
    const st=fs.statSync(this.dir),signature=`${st.dev}:${st.ino}:${st.mtimeMs}:${st.ctimeMs}`;
    if(this.directorySnapshot?.signature===signature)return this.directorySnapshot.entries;
    const entries=fs.readdirSync(this.dir).filter(f=>/^[a-f0-9-]{36}\.json$/i.test(f)).map(file=>{let mtime=-Infinity;try{mtime=fs.lstatSync(path.join(this.dir,file)).mtimeMs;}catch{}return {file,mtime};}).sort((a,b)=>b.mtime-a.mtime||a.file.localeCompare(b.file));
    const ids=new Set(entries.map(v=>v.file.slice(0,-5)));for(const id of this.cache.keys())if(!ids.has(id))this.cache.delete(id);
    this.directorySnapshot={signature,count:entries.length,entries};return entries;
  }
  cachedStatus(id){return this.cache.get(id)?.value.result.status??null;}
  save(id,caller,success,result,connection_principal=null) {
    const old=this.read(id,caller);if(old){if(old.format!==1||old.success!==success)fail('TASK_FINISH_CONFLICT','完成参数与已保存结果不同；不得改写历史结果。');return old;}
    if(!UUID.test(id))fail('TASK_RECEIPT_INVALID','无效任务编号。');
    const receipt={format:1,task_id:id,owner_hash:this.owner(caller),success,result:structuredClone(result),...(connection_principal?{connection_principal}:{})};
    try{saveJSON(path.join(this.dir,id+'.json'),receipt);}catch{fail('TASK_RECEIPT_WRITE_FAILED','任务操作已结束，但保存回执失败。只重试 finish_task，不重跑命令。');}
    this.invalidateDirectory();this.remember(id,receipt);return receipt;
  }
  saveRevocation(id,caller,result,connection_principal=null) {
    const old=this.read(id,caller);
    if(old){if(old.format!==2||old.result.status!==result.status)fail('TASK_FINISH_CONFLICT','已有不同的任务终态回执；不得改写历史结果。');return old;}
    if(!UUID.test(id)||!REVOCATIONS.has(result?.status)||result?.task_id!==id||result?.terminal!==true||result?.execution_complete!==false||!Number.isSafeInteger(result?.finished_at)||!Array.isArray(result?.jobs))fail('TASK_RECEIPT_INVALID','撤销任务回执无效。');
    const receipt={format:2,task_id:id,owner_hash:this.owner(caller),success:null,result:structuredClone(result),...(connection_principal?{connection_principal}:{})};
    try{saveJSON(path.join(this.dir,id+'.json'),receipt);}catch{fail('TASK_RECEIPT_WRITE_FAILED','任务已停止，但保存历史失败；可重试停止，不要重跑命令。');}
    this.invalidateDirectory();this.remember(id,receipt);return receipt;
  }
}
