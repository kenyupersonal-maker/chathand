import {PACING} from '../v1/pacing.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {setImmediate as tick} from 'node:timers/promises';
import {fail,digest} from '../../engine/src/core.mjs';
const glob=s=>new RegExp('^'+s.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.')+'$','i');
export class SearchManager {
  constructor(store,policy){this.store=store;this.policy=policy;this.jobs=new Map();}
  start(o,caller,session_hash){
    this.store.checkActive();if(typeof session_hash!=='string'||!/^[a-f0-9]{64}$/.test(session_hash))fail('SEARCH_SESSION_REQUIRED','没有可信的当前连接会话，不能启动搜索。');
    if(!o.query||o.query.length>256)fail('QUERY_INVALID','请输入 1–256 字符的搜索内容。');
    const type=o.type||'content';if(!['content','files'].includes(type))fail('SEARCH_TYPE_INVALID','选择 files 或 content。');
    for(const [id,j] of this.jobs)if(j.status!=='running'&&Date.now()-j.finished_at>300000)this.jobs.delete(id);
    const running=[...this.jobs.values()].filter(j=>j.status==='running');if(running.length>=3){const e=Object.assign(Error('已经有 3 个搜索在跑。用 search_results（wait_ms）等其中一个跑完，或者 stop_search 停掉不要的，再开新的。这是暂时的，不要因为它结束任务。'),{code:'SEARCH_LIMIT',running:running.map(j=>({search_id:j.id,run_ms:Math.max(0,Date.now()-j.created_at)})),retry_after_ms:PACING.wait.poll_ms});throw e;}
    while(this.jobs.size>=40){const oldest=[...this.jobs.values()].filter(j=>j.status!=='running').sort((a,b)=>(a.finished_at||0)-(b.finished_at||0))[0];if(!oldest)break;this.jobs.delete(oldest.id);}
    const base=this.store.resolve(o.path||'.',{directory:true});
    const j={id:crypto.randomUUID(),caller,session_hash,project_id:this.policy.state.data.active,root:this.store.root,epoch:this.policy.epoch,permissionRevision:this.policy.permissionRevision||0,status:'running',results:[],visited:0,skipped:0,bytes:0,incomplete:false,reasons:[],created_at:Date.now(),streams:new Set(),base,options:o,type};
    this.jobs.set(j.id,j);void this.walk(j).catch(e=>{j.status='failed';j.error=e.code||'SEARCH_FAILED';}).finally(()=>{j.finished_at=Date.now();if(j.status==='running')j.status='completed';for(const s of j.streams)s.destroy();});
    return this.view(j,0,0);
  }
  valid(j){return j.status==='running'&&j.epoch===this.policy.epoch&&j.permissionRevision===(this.policy.permissionRevision||0)&&j.root===this.store.root&&!this.store.paused;}
  incomplete(j,reason){j.incomplete=true;if(!j.reasons.includes(reason))j.reasons.push(reason);}
  async walk(j){
    const {options:o}=j;const needle=o.case_sensitive?o.query:o.query.toLocaleLowerCase();const filter=o.file_pattern?glob(o.file_pattern):null;const nameMatch=j.type==='files'?glob(o.query.includes('*')||o.query.includes('?')?o.query:'*'+o.query+'*'):null;
    const pending=[{file:j.base,depth:0}],seen=new Set();const max=o.max_results??500;
    while(pending.length&&this.valid(j)){
      if(Date.now()-j.created_at>30000){this.incomplete(j,'TIME_BUDGET');break;}
      if(j.visited>=50000){this.incomplete(j,'FILE_COUNT_LIMIT');break;}
      const {file,depth}=pending.pop();let real;
      try{real=this.store.resolve(file,{directory:true});}catch{j.skipped++;continue;}
      if(seen.has(real))continue;seen.add(real);
      let dir;try{dir=await fs.promises.opendir(real);}catch{j.skipped++;continue;}
      if(!this.valid(j)){await dir.close();return;}
      for await(const entry of dir){
        if(!this.valid(j))break;
        if(j.results.length>=max){this.incomplete(j,'RESULT_LIMIT');return;}
        if(j.visited>=50000||j.bytes>=256*1024*1024||Date.now()-j.created_at>30000){this.incomplete(j,'SCAN_BUDGET');return;}
        if(!o.include_hidden&&entry.name.startsWith('.'))continue;
        if(['node_modules','.git','.Trash'].includes(entry.name))continue;
        j.visited++;const p=path.join(real,entry.name);let safe;
        try{safe=this.store.resolve(p);}catch{j.skipped++;continue;}
        if(entry.isDirectory()){if(depth<30)pending.push({file:safe,depth:depth+1});else this.incomplete(j,'DEPTH_LIMIT');}
        if(j.type==='files'&&nameMatch.test(entry.name))j.results.push({path:safe,type:entry.isDirectory()?'directory':'file'});
        if(j.type==='content'&&entry.isFile()&&(!filter||filter.test(entry.name))){
          await this.scanFile(j,safe,needle,max);
          if(!this.valid(j))return;
        }
        if(j.visited%100===0){
          await tick();
          if(!this.valid(j))return;
        }
      }
    }
  }
  async scanFile(j,p,needle,max){
    let opened;try{opened=this.store.openRead(p);}catch{j.skipped++;return;}
    const stream=fs.createReadStream(p,{fd:opened.fd,autoClose:true,highWaterMark:65536});j.streams.add(stream);
    let pending='',line=0,bytes=0,tooLong=false;const decoder=new StringDecoder('utf8');
    const accept=text=>{
      pending+=text;let at;
      while((at=pending.indexOf('\n'))!==-1){const value=pending.slice(0,at);pending=pending.slice(at+1);line++;
        if(!tooLong&&(j.options.case_sensitive?value:value.toLocaleLowerCase()).includes(needle)&&j.results.length<max)j.results.push({path:p,line,text:value.slice(0,1000)});
        tooLong=false;
      }
      if(pending.length>65536){pending='';tooLong=true;this.incomplete(j,'LONG_LINE_SKIPPED');}
    };
    try{
      for await(const chunk of stream){
        if(!this.valid(j)||j.results.length>=max)break;
        bytes+=chunk.length;j.bytes+=chunk.length;
        if(chunk.includes(0)){j.skipped++;break;}
        accept(decoder.write(chunk));
        if(bytes>=64*1024*1024||j.bytes>=256*1024*1024||Date.now()-j.created_at>30000){this.incomplete(j,'CONTENT_SCAN_LIMIT');break;}
        await tick();
        if(!this.valid(j))break;
      }
      if(this.valid(j)&&!stream.destroyed&&pending)accept(decoder.end()+'\n');
      else if(this.valid(j)&&pending&&!tooLong&&bytes===opened.stat.size)accept(decoder.end()+'\n');
    }catch(e){if(this.valid(j))j.skipped++;}
    finally{stream.destroy();j.streams.delete(stream);}
  }
  get(id,caller,session_hash){const j=this.jobs.get(id);if(!j)fail('SEARCH_MISSING','搜索已过期或不存在。');
    if(typeof session_hash!=='string'||!/^[a-f0-9]{64}$/.test(session_hash)||j.caller!==caller||j.session_hash!==session_hash||j.project_id!==this.policy.state.data.active)
      fail('SEARCH_OWNER','搜索不属于当前连接、会话和工作区。');
    if(j.epoch!==this.policy.epoch||j.permissionRevision!==(this.policy.permissionRevision||0)||j.root!==this.store.root){j.results=[];fail('SEARCH_REVOKED','权限或工作区已改变，请重新搜索。');}return j;}
  view(j,offset=0,limit=50,cursor=null){
    if(j.epoch!==this.policy.epoch||j.permissionRevision!==(this.policy.permissionRevision||0)||j.root!==this.store.root){j.results=[];fail('SEARCH_REVOKED','搜索范围的授权已变化，旧结果不能继续读取。');}
    if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<0||limit>100)fail('ARG_INVALID','搜索分页范围无效。');
    const stable=j.status==='completed',snapshot=stable?digest(JSON.stringify([j.id,j.epoch,j.results])):null;
    if(cursor!==null){const match=typeof cursor==='string'&&/^v1:(\d+):([a-f0-9]{64})$/.exec(cursor);
      if(!stable||!match||Number(match[1])!==offset||match[2]!==snapshot)fail('SEARCH_CHANGED','搜索结果尚未稳定或游标已失效，请重新从第一页读取。');
    }else if(offset>0&&!stable)fail('SEARCH_UNSTABLE','搜索仍在进行中，完成后再翻页，避免重复或漏行。');
    const items=j.results.slice(offset,offset+limit),next_offset=stable&&offset+items.length<j.results.length?offset+items.length:null;
    const complete=stable&&!j.incomplete&&j.skipped===0;
    return {search_id:j.id,status:j.status,visited:j.visited,skipped:j.skipped,bytes_scanned:j.bytes,
      total_results:j.results.length,total:complete?j.results.length:null,at_least:j.results.length,total_exact:complete,
      results:items,offset,limit,next_offset,next_cursor:next_offset===null?null:'v1:'+next_offset+':'+snapshot,
      stable,waiting:j.status==='running',truncated:next_offset!==null||!complete,incomplete:j.incomplete||!stable||j.skipped>0,
      reasons:j.reasons,error:j.error||null};
  }
  results(id,caller,session_hash,offset=0,limit=50,cursor=null,wait_ms=0){
    if(!Number.isInteger(wait_ms)||wait_ms<0||wait_ms>PACING.wait.poll_ms)fail('ARG_INVALID','wait_ms 只能是 0–'+PACING.wait.poll_ms+'。');
    const j=this.get(id,caller,session_hash);if(!wait_ms||j.status!=='running')return this.view(j,offset,limit,cursor);
    return (async()=>{const end=Date.now()+wait_ms;while(this.get(id,caller,session_hash).status==='running'&&Date.now()<end)await new Promise(r=>setTimeout(r,Math.min(25,end-Date.now())));return this.view(this.get(id,caller,session_hash),offset,limit,cursor);})();
  }
  stop(id,caller,session_hash){const j=this.get(id,caller,session_hash);if(j.status==='running'){j.status='cancelled';j.finished_at=Date.now();for(const s of j.streams)s.destroy();}return this.view(j,0,0);}
  cancelAll(){for(const j of this.jobs.values()){if(j.status==='running')j.status='cancelled';j.results=[];j.finished_at=Date.now();for(const s of j.streams)s.destroy();}}
}
