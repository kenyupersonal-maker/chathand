/** Local numeric workload estimates. Contents and conversation IDs never enter the saved file. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const BASE_SYSTEM_TOKENS = 8_000; // Estimated Work system instructions and user request; tool tokens are added once at startup.
export const REASON = 400; // Estimated reasoning tokens per tool step.
export const COMPACT_TRIGGER = 258_000; // Approximate context size that triggers Work-style compaction.
export const COMPACT_SUMMARY = 25_000; // Approximate retained summary after compaction.
export const CACHE_WEIGHT = 0.25; // Re-read old context counts as a conservative cached fraction.
export const PRICE = Object.freeze({model:'GPT-6.1 Sol',input_per_m:2,cached_per_m:0.10,output_per_m:10,as_of:'2026 年 10 月',source:'OpenAI API 定价页，标准价、短上下文'});
export const WEEK_TOKENS = Object.freeze({plus:120_000_000,pro_5x:600_000_000,pro_20x:2_400_000_000});
export const PLAN_NAMES = Object.freeze({plus:'Plus',pro_5x:'Pro 5x',pro_20x:'Pro 20x'});
export const VALUE_SETTINGS = Object.freeze(['show_value','value_plan']);
export function initializeValueSettings(state){let changed=false;if(typeof state.data.show_value!=='boolean'){state.data.show_value=true;changed=true;}if(!['auto',...Object.keys(WEEK_TOKENS)].includes(state.data.value_plan)){state.data.value_plan='auto';changed=true;}if(changed)state.save();}
export function validateValueSettings(settings){const result={};const invalid=()=>{const error=Error('工作量显示或订阅选项错误。');error.code='ARG_INVALID';throw error;};if(settings?.show_value!==undefined){if(typeof settings.show_value!=='boolean')invalid();result.show_value=settings.show_value;}if(settings?.value_plan!==undefined){if(!['auto',...Object.keys(WEEK_TOKENS)].includes(settings.value_plan))invalid();result.value_plan=settings.value_plan;}return result;}
const groups = {
 read:['chathand_guide','read_file','get_file_info','start_search','search_results','list_directory','read_text','search_text'],
 write:['edit_file','write_text','restore_file','create_directory','move_path','trash_path','restore_trash','image_batch_start','image_batch_save','save_files','expect_download'],
 command:['propose_command','command_input'],
 browser:['browser_status','browser_open','browser_tabs','browser_snapshot','browser_action','browser_screenshot','browser_upload','browser_download','browser_close','browser_batch','browser_read','browser_find','browser_wait_for'],
 desktop:['desktop_action','computer_status','computer_observe','computer_screenshot','computer_action','computer_batch','computer_applications','computer_focus'],
 other:['chathand_host_flow_commit','records_export','matter_write','matter_query','artifact_status','tools_refresh_click','run_capability','card_answer','install_update','request_update','stop_search','system_inspect','git_inspect','task_history','task_changes','show_task','automation_stop','upgrade_status','connection_check','bridge_info','begin_task','task_status','finish_task','list_conversations','command_result','list_commands','input_status','cancel_command','setup_write_probe','operation_status','image_batch_claim','image_batch_control','image_batch_status','task_checkpoint','task_resume_claim','task_stop','relay_card_control','log_note','setup_status','setup_claim','setup_done'],
};
export const TOOL_CATEGORIES = Object.freeze(Object.fromEntries(Object.entries(groups).flatMap(([category,names])=>names.map(name=>[name,category]))));
// Classify a successfully executed extra capability by its actual operation.
// Discovery and unknown extensions stay other; no name-prefix guessing.
export function toolCategory(name,args={},result={}) {
 if(name!=='run_capability')return TOOL_CATEGORIES[name]||'other';
 const returned=result.structuredContent;
 if(returned?.discovery===true||returned?.executed===false)return 'other';
 if(args.capability==='contract_status')return 'read';
 if(args.capability==='execute_task_step')return TOOL_CATEGORIES[args.parameters?.tool]||'other';
 return 'other';
}
const CATEGORIES = ['all','read','write','command','browser','desktop','other'];
const SAMPLE_BYTES = 256 * 1024, DAY = 86_400_000, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const empty = () => ({io_in:0,io_out:0,work_in:0,work_out:0,tasks:0,calls:Object.fromEntries(CATEGORIES.map(k=>[k,0]))});
const number = value => Number.isFinite(value)&&value>=0?value:0;
const cleanTotals = value => Object.fromEntries(['io_in','io_out','work_in','work_out','tasks'].map(k=>[k,number(value?.[k])]).concat([['calls',Object.fromEntries(CATEGORIES.map(k=>[k,number(value?.calls?.[k])]))]]));
export const localDate = time => {const d=new Date(time);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
function dayOffset(time,offset){const d=new Date(time);d.setDate(d.getDate()+offset);return localDate(d);}

// 文字折 token（估算）。对照 o200k_base 校准：Claude 2026-10-03，1,339 段（中英文档、代码、JSON、命令输出，
// 以及 ChatHand 实际发出的紧凑 JSON 外壳）。做法：先照 o200k 的预分词规则切块，再按块的种类计价。不加依赖。
const SPLIT = /(?:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/giu;
const LETTER = /\p{L}/u, ASCII_LETTER = /[A-Za-z]/, NUMBER = /^\p{N}+$/u, SPACE = /^\s+$/, NEWLINE = /[\r\n]/, CONTRACTION = /^'(?:s|t|re|ve|m|ll|d)$/i;
export const TOKEN_WEIGHTS = Object.freeze({
  proseWord: 0.99,   // 前面带空格的英文词，如 " the"
  otherWord: 1.39,   // 其它英文字母块（标识符、行首词、跟在标点后的词）
  proseExtra: 0.09,  // 上面两种词超过 6 个字母的部分，每个字母
  otherExtra: 0.25,
  number: 0.88,      // 每块 1～3 位数字
  newline: 0.83,     // 含换行的空白块
  spaces: 1.37,      // 只有空格/制表符的空白块
  punct: 0.86,       // 标点符号块
  symbol: 0.33,      // 标点块里的非 ASCII 符号（全角标点、emoji 等），每个
  cjkPiece: 1.34,    // 含汉字/假名的块
  cjkChar: 0.67,     // 每个汉字/假名
  hangul: 0.65,      // 韩文：第 1 个音节之后，每个音节
  otherChar: 0.25,   // 其它文字（俄文、希腊文、带重音的拉丁字母）：前 3 个字母之后，每个字母
});
const K = TOKEN_WEIGHTS;
const isCjk = c => (c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3040 && c <= 0x30ff);
const isHangul = c => c >= 0xac00 && c <= 0xd7af;
export function estimateTextTokens(text) {
  if (typeof text !== 'string' || !text) return 0;
  let sum = 0;
  for (const [piece] of text.matchAll(SPLIT)) {
    if (piece.length <= 3 && CONTRACTION.test(piece)) { sum += 1; continue; }
    if (LETTER.test(piece)) {
      let han = 0, hangul = 0, ascii = 0, other = 0;
      for (const ch of piece) {
        const c = ch.codePointAt(0);
        if (isCjk(c)) han++; else if (isHangul(c)) hangul++; else if (ASCII_LETTER.test(ch)) ascii++; else if (LETTER.test(ch)) other++;
      }
      const lead = piece.charCodeAt(0) === 32;
      if (han) sum += K.cjkPiece + K.cjkChar * han + K.otherChar * other;
      else if (hangul) sum += (lead ? K.proseWord : K.otherWord) + K.hangul * Math.max(0, hangul - 1) + K.otherChar * other;
      else if (other) sum += (lead ? K.proseWord : K.otherWord) + K.otherChar * Math.max(0, ascii + other - 3);
      else sum += lead && ASCII_LETTER.test(piece[1])
        ? K.proseWord + K.proseExtra * Math.max(0, ascii - 6)
        : K.otherWord + K.otherExtra * Math.max(0, ascii - 6);
      continue;
    }
    if (NUMBER.test(piece)) { sum += K.number; continue; }
    if (SPACE.test(piece)) { sum += NEWLINE.test(piece) ? K.newline : K.spaces; continue; }
    let symbols = 0;
    for (const ch of piece) if (ch.codePointAt(0) >= 128) symbols++;
    sum += K.punct + K.symbol * symbols;
  }
  return Math.round(sum);
}

export function sampledTextTokens(text) {
 if(typeof text!=='string')return 0;
 const bytes=Buffer.byteLength(text);
 if(bytes<=SAMPLE_BYTES)return estimateTextTokens(text);
 const prefix=Buffer.from(text.slice(0,SAMPLE_BYTES)).subarray(0,SAMPLE_BYTES).toString('utf8');
 return Math.round(estimateTextTokens(prefix)*bytes/Buffer.byteLength(prefix));
}
export function imageSize(data) {
 try {
  if(typeof data!=='string')return null;
  // Dimensions precede image pixels. Bound decoding even for multi-megabyte screenshots.
  const bytes=Buffer.from(data.slice(0,96*1024),'base64');
  if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR')return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
  if(bytes[0]!==255||bytes[1]!==216)return null;
  for(let offset=2;offset+3<bytes.length;){
   if(bytes[offset++]!==255)continue;
   while(bytes[offset]===255)offset++;
   const marker=bytes[offset++];if(marker===217||marker===218)break;if(marker===216||marker===1||marker>=208&&marker<=215)continue;
   const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length)break;
   if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&length>=7)return {width:bytes.readUInt16BE(offset+5),height:bytes.readUInt16BE(offset+3)};
   offset+=length;
  }
 }catch{ /* Unknown image formats use the documented fallback. */ }
 return null;
}
export function imageTokens(image) {
 let {width,height}=imageSize(image?.data)||{width:1280,height:800};
 if(!width||!height||width>1_000_000||height>1_000_000){width=1280;height=800;}
 let scale=Math.min(1,2048/Math.max(width,height));width*=scale;height*=scale;
 scale=Math.min(1,768/Math.min(width,height));width*=scale;height*=scale;
 // Estimate using the published GPT-4o high-detail 85 + 170-per-512px-tile algorithm.
 return 85+170*Math.ceil(width/512)*Math.ceil(height/512);
}
export function countIO(args,result) {
 let out=sampledTextTokens(JSON.stringify(args??{})),input=0,hasText=false;
 for(const part of result?.content||[]){if(part?.type==='text'&&typeof part.text==='string'&&part.text.length){hasText=true;input+=sampledTextTokens(part.text);}else if(part?.type==='image')input+=imageTokens(part);}
 if(!hasText&&result?.structuredContent!==undefined)input+=sampledTextTokens(JSON.stringify(result.structuredContent));
 return {io_in:Math.min(100_000,input),io_out:Math.min(20_000,out)};
}
export function workInputTokens(base,oldContext,freshInput){return Math.max(0,Math.round(number(freshInput)+(number(base)+number(oldContext))*CACHE_WEIGHT));}
export function nextContextTokens(oldContext,added){const next=number(oldContext)+number(added);return next>COMPACT_TRIGGER?COMPACT_SUMMARY:next;}
export const apiUSDExact = totals => (number(totals?.io_in)*PRICE.input_per_m+Math.max(0,number(totals?.work_in)-number(totals?.io_in))*PRICE.cached_per_m+number(totals?.work_out)*PRICE.output_per_m)/1e6;
export const apiUSD = totals => Number(apiUSDExact(totals).toFixed(2));
export const stepApiUSD = (base,oldContext,io) => (number(io?.io_in)*PRICE.input_per_m+(number(base)+number(oldContext))*PRICE.cached_per_m+(number(io?.io_out)+REASON)*PRICE.output_per_m)/1e6;
export const VALUE_ESTIMATORS = Object.freeze({main:'work-v4',legacy_work:'work-v4',main_usd:'api-v4',legacy_usd:'api-v4'});
export const ioUSDExact = totals => (number(totals?.io_in)*PRICE.input_per_m+number(totals?.io_out)*PRICE.output_per_m)/1e6;
export const ioUSD = totals => Number(ioUSDExact(totals).toFixed(2));
function atomicWrite(file,data){const temporary=file+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';try{fs.writeFileSync(temporary,JSON.stringify(data),{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);}finally{try{fs.unlinkSync(temporary);}catch{}}}
function cleanProbe(value){return {plan:Object.hasOwn(WEEK_TOKENS,value?.plan)?value.plan:null,calibrated_at:number(value?.calibrated_at)||null};}
function cleanApi(value,fallback){const daily={};for(const [date,cost] of Object.entries(value?.daily||{}))if(/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Number(cost))&&Number(cost)>=0)daily[date]=Number(cost);return {lifetime:Number.isFinite(Number(value?.lifetime))&&Number(value.lifetime)>=0?Number(value.lifetime):fallback.lifetime,daily:Object.keys(daily).length?daily:{...fallback.daily}};}

export class ValueStats {
 constructor({stateDir=null,tools=[],now=Date.now,schedule=setImmediate,cancelScheduled=clearImmediate,setTimer=setTimeout,clearTimer=clearTimeout,writeFile=atomicWrite,onChange=()=>{},getTask=null}={}){
  Object.assign(this,{now,schedule,cancelScheduled,setTimer,clearTimer,writeFile,onChange,getTask});
  this.file=stateDir?path.join(stateDir,'value-stats.json'):null;this.base=estimateTextTokens(JSON.stringify(tools))+BASE_SYSTEM_TOKENS;
  this.data={format:4,since:now(),lifetime:empty(),daily:{},api:{lifetime:0,daily:{}},probe:cleanProbe(null),estimators:VALUE_ESTIMATORS};
  this.queue=[];this.contexts=new Map();this.taskContexts=new Map();this.recent=new Map();this.active=new Map();this.closedTasks=new Set();this.metaKeys=new Set();this.headerNames=new Set();this.serial=0;this.deferred=null;this.saveTimer=null;this.lastSaved=now();this.dirty=false;this.closed=false;let legacyQuotaProbe=false;
  try{if(this.file){const st=fs.lstatSync(this.file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>1024*1024)throw Error();const raw=JSON.parse(fs.readFileSync(this.file,'utf8'));if(![4,5].includes(raw.format)||!Number.isFinite(raw.since))throw Error();if(raw.format===5&&!(raw.estimators?.legacy_work==='work-v4'&&raw.estimators?.legacy_usd==='api-v4'&&['tool-io-v1','work-v4'].includes(raw.estimators?.main)&&['tool-io-price-v1','api-v4'].includes(raw.estimators?.main_usd)))throw Error();this.data={format:4,since:number(raw.since),lifetime:cleanTotals(raw.lifetime),daily:{},api:{lifetime:0,daily:{}},probe:cleanProbe(raw.probe),estimators:VALUE_ESTIMATORS};for(const [date,totals] of Object.entries(raw.daily||{}))if(/^\d{4}-\d{2}-\d{2}$/.test(date))this.data.daily[date]=cleanTotals(totals);const fallback={lifetime:apiUSDExact(this.data.lifetime),daily:Object.fromEntries(Object.entries(this.data.daily).map(([date,totals])=>[date,apiUSDExact(totals)]))};this.data.api=cleanApi(raw.api,fallback);this.pruneDays();legacyQuotaProbe=Object.hasOwn(raw.probe||{},'week_tokens');if(raw.format!==4||Object.entries(VALUE_ESTIMATORS).some(([key,value])=>raw.estimators?.[key]!==value))this.data.needsMigration=true;}}
  catch{legacyQuotaProbe=false; /* A bad/unavailable statistics file starts from zero. */ }
  if(legacyQuotaProbe||this.data.needsMigration){delete this.data.needsMigration;this.changed();}
 }
 enqueue(call){if(this.closed)return;this.queue.push({...call,time:this.now()});if(this.deferred===null)this.deferred=this.schedule(()=>{this.deferred=null;this.drain();});}
 drain(){if(this.deferred!==null){this.cancelScheduled(this.deferred);this.deferred=null;}const calls=this.queue;this.queue=[];for(const call of calls)try{this.record(call);}catch{/* Estimates must never change a tool response. */}}
 conversation(session,caller,time){
  for(const [key,value] of this.contexts)if(time-value.time>=DAY)this.contexts.delete(key);
  let key=typeof session==='string'&&session.trim()&&session.length<=4096?`${caller}\0${session}`:null;
  const previous=this.recent.get(caller);if(!key&&previous&&time-previous.time<=30*60_000&&this.contexts.has(previous.key))key=previous.key;
  key||=`anonymous:${++this.serial}`;
  const context=this.contexts.get(key)||{io:0,time,task:null};context.time=time;this.contexts.delete(key);this.contexts.set(key,context);this.recent.set(caller,{key,time});
  while(this.contexts.size>200)this.contexts.delete(this.contexts.keys().next().value);
  return context;
 }
 record({name,args={},result={},session,caller='chatgpt',metaKeys=[],headerNames=[],time}){
  for(const key of metaKeys)if(typeof key==='string'&&key.length<=128&&this.metaKeys.size<50)this.metaKeys.add(key);
  for(const key of headerNames)if(typeof key==='string'&&/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(key)&&this.headerNames.size<50)this.headerNames.add(key.toLowerCase());
  const io=countIO(args,result),context=this.conversation(session,caller,time),success=result.isError!==true,returned=result.structuredContent;
  const startsTask=success&&name==='begin_task'&&returned?.replayed!==true&&UUID.test(returned?.task_id);if(startsTask)context.task=returned.task_id;
  const explicit=typeof args.task_id==='string'&&UUID.test(args.task_id)?args.task_id:null,id=explicit||(startsTask?returned.task_id:context.task),oldContext=id?(this.taskContexts.get(id)||0):context.io;
  const work_in=workInputTokens(this.base,oldContext,io.io_in),work_out=io.io_out+REASON,nextContext=nextContextTokens(oldContext,io.io_in+io.io_out),api_cost=stepApiUSD(this.base,oldContext,io);if(id)this.taskContexts.set(id,nextContext);else context.io=nextContext;
  const values={...io,work_in,work_out};const date=localDate(time),day=this.data.daily[date]||=empty();this.data.api.lifetime+=api_cost;this.data.api.daily[date]=(this.data.api.daily[date]||0)+api_cost;
  for(const totals of [day,this.data.lifetime]){for(const key of Object.keys(values))totals[key]+=values[key];if(success){totals.calls.all++;totals.calls[toolCategory(name,args,result)]++;}if(success&&name==='finish_task'&&returned?.success===true&&returned.replayed!==true)totals.tasks++;}
  const task=this.getTask?.(id),ongoing=!this.getTask||task&&['active','pending_approval'].includes(task.status);
  if(id&&!this.closedTasks.has(id)&&ongoing){const totals=this.active.get(id)||{io_in:0,io_out:0,work_in:0,work_out:0,calls:0};for(const key of Object.keys(values))totals[key]+=values[key];if(success)totals.calls++;this.active.set(id,totals);}
  this.pruneDays();this.changed();
 }
 receiptValue(id){this.drain();const total=this.active.get(id);return total?{work:total.work_in+total.work_out,legacy_work:total.work_in+total.work_out,estimators:VALUE_ESTIMATORS,io_in:total.io_in,io_out:total.io_out,calls:total.calls}:null;}
 endTask(id){this.closedTasks.add(id);this.active.delete(id);for(const context of this.contexts.values())if(context.task===id)context.task=null;}
 pruneDays(){const first=dayOffset(this.now(),-399),today=localDate(this.now());for(const date of Object.keys(this.data.daily))if(date<first||date>today){delete this.data.daily[date];delete this.data.api.daily[date];}}
 changed(){this.dirty=true;if(this.file&&this.saveTimer===null&&!this.closed)this.saveTimer=this.setTimer(()=>{this.saveTimer=null;this.flush();},Math.max(0,5000-(this.now()-this.lastSaved)));this.saveTimer?.unref?.();try{this.onChange();}catch{}}
 flush(){if(!this.dirty||!this.file)return false;this.lastSaved=this.now();try{this.writeFile(this.file,this.data);this.dirty=false;return true;}catch{return false;}}
 setProbe(value){const next=cleanProbe(value);if(Object.keys(next).every(key=>next[key]===this.data.probe[key]))return;this.data.probe=next;this.changed();}
 snapshot(settings={}){
  const now=this.now(),last7=empty();let api7=0;for(let offset=-6;offset<=0;offset++){const date=dayOffset(now,offset),day=this.data.daily[date];api7+=number(this.data.api.daily[date]);if(day){for(const key of ['io_in','io_out','work_in','work_out','tasks'])last7[key]+=day[key];for(const key of CATEGORIES)last7.calls[key]+=day.calls[key];}}
  const setting=settings.value_plan,probe=this.data.probe,manual=Object.hasOwn(WEEK_TOKENS,setting),id=manual?setting:probe.plan||'plus',source=manual?'setting':probe.plan?'auto':'default',week=WEEK_TOKENS[id];
  const summary=(total,legacyUsd)=>({work:total.work_in+total.work_out,legacy_work:total.work_in+total.work_out,io:{in:total.io_in,out:total.io_out},usd:Number(number(legacyUsd).toFixed(2)),legacy_usd:Number(number(legacyUsd).toFixed(2)),tasks:total.tasks});
  return {show:settings.show_value!==false,since:this.data.since,estimators:VALUE_ESTIMATORS,plan:{id,name:PLAN_NAMES[id],source},quota:{week_tokens:week,source:'table',week_tokens_by_plan:{...WEEK_TOKENS}},price:{...PRICE},last7:{...summary(last7,api7),share:(last7.work_in+last7.work_out)/week*100,calls:{...last7.calls}},lifetime:summary(this.data.lifetime,this.data.api.lifetime),daily:Array.from({length:182},(_,i)=>{const date=dayOffset(now,i-181),total=this.data.daily[date];return {date,work:total?total.work_in+total.work_out:0,legacy_work:total?total.work_in+total.work_out:0};}),active:Object.fromEntries([...this.active].map(([id,total])=>[id,{work:total.work_in+total.work_out,legacy_work:total.work_in+total.work_out,calls:total.calls}])),probe:{meta_keys:[...this.metaKeys],header_names:[...this.headerNames]}};
 }
 reset(){this.drain();const next={format:4,since:this.now(),lifetime:empty(),daily:{},api:{lifetime:0,daily:{}},probe:this.data.probe,estimators:VALUE_ESTIMATORS};if(this.file)try{this.writeFile(this.file,next);}catch{const error=Error('清零失败，请稍后重试。');error.code='VALUE_RESET_FAILED';throw error;}this.data=next;this.active.clear();this.taskContexts.clear();for(const context of this.contexts.values())context.io=0;this.dirty=false;this.lastSaved=this.now();if(this.saveTimer!==null)this.clearTimer(this.saveTimer);this.saveTimer=null;try{this.onChange();}catch{}return {ok:true,since:this.data.since};}
 close(){if(this.closed)return;this.drain();this.closed=true;if(this.saveTimer!==null)this.clearTimer(this.saveTimer);this.saveTimer=null;this.flush();}
}
