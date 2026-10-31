import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fail,privateDir,saveJSON} from '../../engine/src/core.mjs';
import {safeArtifactPath,safeArtifactName} from './artifact-zip.mjs';

// API30 freezes this offline shell protocol. Breaking shell changes require a
// new contract/URI; ordinary result data and local extensions do not change it.
export const widgetURI=(name,_file)=>`ui://chathand/${name}.html`;
export const IMAGE_BATCH_URI=widgetURI('image-batch','../../ui/image-batch-widget.html');
export const LEGACY_IMAGE_BATCH_URI='ui://chathand/image-batch-v1.html';
const MAX_ITEMS=40,MAX_PROMPT=6000,MAX_IMAGE_BYTES=30*1024*1024,DOWNLOAD_TIMEOUT_MS=30000,MIN_SEND_GAP_MS=3000;
const s=(extra={})=>({type:'string',...extra}),b={type:'boolean'},i=(min,max)=>({type:'integer',minimum:min,maximum:max});
const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const tool=(name,description,inputSchema,annotations={})=>({name,description,inputSchema,annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false,idempotentHint:false,...annotations}});
const itemSchema=schema({name:s({maxLength:80}),prompt:s({maxLength:MAX_PROMPT})},['name','prompt']);
const imageSchema=schema({
 download_url:s({maxLength:8192}),
 file_id:s({maxLength:512}),
 mime_type:s({maxLength:200}),
 file_name:s({maxLength:512}),
},['download_url','file_id']);
const cardMeta={ui:{resourceUri:IMAGE_BATCH_URI},'openai/outputTemplate':IMAGE_BATCH_URI};
const widgetMeta={'openai/visibility':'private','openai/widgetAccessible':true};

export const IMAGE_BATCH_TOOLS=[
 {...tool('image_batch_start','批量出图：先建批次。把 1–40 张图的名字和完整描述交给 ChatHand（或给一个只放 .txt 描述的文件夹），ChatHand 记清单、显示进度卡片、帮你把图存到本机；它不替用户发消息。建好后照 bridge_info 里「批量出图」的做法一张一张出：出完先看一眼对不对得上这一张的描述，对得上就 image_batch_save，对不上就不存、照实说；每张出完，回复最后单独一行加粗写「发『继续』，出第 k+1/N 张：名字」，用户发「继续」再出下一张；串页一次就停；超过 6 张，出完 6 张建议开新对话。',schema({title:s({maxLength:120}),items:{type:'array',minItems:1,maxItems:MAX_ITEMS,items:itemSchema},source_dir:s({maxLength:4096}),save_dir:s({maxLength:4096}),auto:b},['title'])),_meta:cardMeta},
 {...tool('image_batch_claim','已停用（10/6 起卡片不再替用户发消息）。不要调用。 Deprecated: the card no longer sends messages; do not call.',schema({batch_id:s()},['batch_id'])),_meta:widgetMeta},
 {...tool('image_batch_save','批量出图时，把刚出的这一张交回 ChatHand 存到本机；先看过、对得上这一张的描述再存。不给 index 就算下一张没出的。image 是 ChatGPT 文件参数；宿主不给文件参数时传 no_file:true，这一张记为「已出，未交回」。',schema({image:imageSchema,batch_id:s(),index:i(1,MAX_ITEMS),no_file:b}),{openWorldHint:true}),_meta:{...cardMeta,'openai/fileParams':['image']}},
 {...tool('image_batch_control','已停用（10/6 起卡片不再替用户发消息）。不要调用。 Deprecated: the card no longer sends messages; do not call.',schema({batch_id:s(),action:{type:'string',enum:['start','pause','stop','release','set_auto']},auto:b},['batch_id','action'])),_meta:widgetMeta},
 {...tool('image_batch_status','读取一个连续出图批次的当前状态并显示卡片。',schema({batch_id:s(),from_card:b},['batch_id']),{readOnlyHint:true,idempotentHint:true}),_meta:{...cardMeta,'openai/widgetAccessible':true}},
];

export function validateImageBatchToolArgs(tool,args){
 if(!args||typeof args!=='object'||Array.isArray(args))fail('ARG_INVALID','参数必须是对象。');
 const root=tool.inputSchema;
 const check=(spec,value,label)=>{
  if(spec.type==='string'){
   if(typeof value!=='string')fail('ARG_INVALID',`参数 ${label} 类型不正确。`);
   if(spec.maxLength!==undefined&&[...value].length>spec.maxLength)fail('ARG_INVALID',`参数 ${label} 过长。`);
  }else if(spec.type==='integer'){
   if(!Number.isInteger(value))fail('ARG_INVALID',`参数 ${label} 类型不正确。`);
   if(spec.minimum!==undefined&&value<spec.minimum||spec.maximum!==undefined&&value>spec.maximum)fail('ARG_INVALID',`参数 ${label} 超出范围。`);
  }else if(spec.type==='boolean'){
   if(typeof value!=='boolean')fail('ARG_INVALID',`参数 ${label} 类型不正确。`);
  }else if(spec.type==='array'){
   if(!Array.isArray(value))fail('ARG_INVALID',`参数 ${label} 类型不正确。`);
   if(spec.minItems!==undefined&&value.length<spec.minItems||spec.maxItems!==undefined&&value.length>spec.maxItems)fail('ARG_INVALID',`参数 ${label} 数量超出范围。`);
   value.forEach((entry,n)=>check(spec.items,entry,`${label}[${n}]`));
  }else if(spec.type==='object'){
   if(!value||typeof value!=='object'||Array.isArray(value))fail('ARG_INVALID',`参数 ${label} 类型不正确。`);
   for(const key of spec.required||[])if(!(key in value))fail('ARG_INVALID',`缺少参数 ${label}.${key}。`);
   for(const [key,entry] of Object.entries(value)){const child=spec.properties?.[key];if(!child&&spec.additionalProperties===false)fail('ARG_INVALID','文件参数包含未知字段。');if(child)check(child,entry,`${label}.${key}`);}
  }
  if(spec.enum&&!spec.enum.includes(value))fail('ARG_INVALID',`参数 ${label} 超出可选值。`);
 };
 for(const key of root.required||[])if(!(key in args))fail('ARG_INVALID',`缺少参数 ${key}。`);
 for(const [key,value] of Object.entries(args)){const spec=root.properties[key];if(!spec)fail('ARG_INVALID','工具参数包含未知字段。');check(spec,value,key);}
}

const safeName=name=>{
 if(typeof name!=='string'||!name||[...name].length>80||/[<>:"/\\|?*\u0000-\u001f]/u.test(name)||name==='.'||name==='..'||/[ .]$/u.test(name))fail('IMAGE_BATCH_NAME_INVALID','图片名称只能使用普通文件名字符，不能含路径、控制字符或系统保留字符，且不超过 80 字。');
 return name;
};
const safeTitleSegment=title=>{
 const cleaned=String(title).normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]+/gu,'-').replace(/\s+/gu,' ').trim().replace(/[ .]+$/u,'').slice(0,80);
 return cleaned||'连续出图';
};
const localDate=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const clone=value=>structuredClone(value);

function imageType(buf){
 if(buf.length>=8&&buf.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))return {ext:'png',mime:'image/png'};
 if(buf.length>=3&&buf[0]===0xff&&buf[1]===0xd8&&buf[2]===0xff)return {ext:'jpg',mime:'image/jpeg'};
 if(buf.length>=12&&buf.toString('ascii',0,4)==='RIFF'&&buf.toString('ascii',8,12)==='WEBP')return {ext:'webp',mime:'image/webp'};
 return null;
}
function atomicJSON(file,value){
 const dir=path.dirname(file),tmp=path.join(dir,`.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
 if(fs.existsSync(file)){const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink>1)fail('IMAGE_BATCH_STATE_INVALID','批次状态文件不是普通文件，已停止写入。');}
 fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
 try{fs.renameSync(tmp,file);}finally{try{fs.unlinkSync(tmp);}catch{}}
}
function publicItem(item){return {index:item.index,name:item.name,status:item.status,...(item.file?{file:item.file}:{}),...(item.error?{error:item.error}:{})};}

export class ImageBatchManager{
 constructor(store,policy,{fetchImpl=globalThis.fetch,now=Date.now,sleepImpl=sleep}={}){
  this.store=store;this.policy=policy;this.fetchImpl=fetchImpl;this.now=now;this.sleep=sleepImpl;this.batches=new Map();this.locks=new Map();this.saving=new Set();
  this.registryDir=path.join(store.stateDir,'image-batches');privateDir(this.registryDir);this.loadRegistry();
 }
 has(name){return IMAGE_BATCH_TOOLS.some(t=>t.name===name);}
 async invoke(name,args,caller,context={}){
  switch(name){
   case'image_batch_start':return this.start(args,caller,context);
   case'image_batch_claim':return this.claim(args.batch_id,caller);
   case'image_batch_save':return this.save(args,caller,context);
   case'image_batch_control':return this.control(args,caller);
   case'image_batch_status':return this.view(this.get(args.batch_id,caller));
   default:fail('TOOL_UNKNOWN','连续出图工具不存在。');
  }
 }
 loadRegistry(){
  let files=[];try{files=fs.readdirSync(this.registryDir).filter(f=>/^[a-f0-9-]{36}\.json$/i.test(f)).slice(-300);}catch{return;}
  for(const file of files)try{
   const data=JSON.parse(fs.readFileSync(path.join(this.registryDir,file),'utf8'));
   if(data?.version===1&&data.batch_id===file.slice(0,-5)&&Array.isArray(data.items)&&typeof data.save_dir==='string')this.batches.set(data.batch_id,data);
  }catch{}
 }
 registryFile(id){return path.join(this.registryDir,id+'.json');}
 async locked(id,fn){
  const prev=this.locks.get(id)||Promise.resolve();let release;const next=new Promise(r=>{release=r;}),current=prev.then(()=>next);this.locks.set(id,current);
  await prev;try{return await fn();}finally{release();if(this.locks.get(id)===current)this.locks.delete(id);}
 }
 normalizePath(input){
  if(input==='~'||input.startsWith('~/'))input=path.join(os.homedir(),input.slice(2));
  return path.isAbsolute(input)?path.normalize(input):path.resolve(this.store.root,input);
 }
 ensureDirectory(input){
  const target=this.normalizePath(input);
  const make=p=>{
   if(fs.existsSync(p)){const real=this.store.resolve(p,{directory:true});this.store.checkProtected?.(real,{write:true});return real;}
   const parent=path.dirname(p);if(parent===p)fail('PATH_INVALID','保存目录无效。');
   const realParent=make(parent),candidate=path.join(realParent,path.basename(p));this.store.checkProtected?.(candidate,{write:true});
   try{fs.mkdirSync(candidate,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
   return this.store.resolve(candidate,{directory:true});
  };
  return make(target);
 }
 chooseSaveDir(title,saveDir){
  if(saveDir)return this.ensureDirectory(saveDir);
  const parent=this.ensureDirectory(path.join(this.store.root,'连续出图')),stem=safeTitleSegment(title)+'-'+localDate();
  let candidate=path.join(parent,stem),n=2;while(fs.existsSync(candidate))candidate=path.join(parent,`${stem}-${n++}`);
  return this.ensureDirectory(candidate);
 }
 validateItems(items){
  if(!Array.isArray(items)||items.length<1||items.length>MAX_ITEMS)fail('IMAGE_BATCH_ITEMS_INVALID','连续出图一次需要 1–40 张。');
  return items.map((item,n)=>{
   if(!item||typeof item!=='object'||Array.isArray(item))fail('IMAGE_BATCH_ITEMS_INVALID','每一张都需要 name 和 prompt。');
   const name=safeName(item.name),prompt=typeof item.prompt==='string'?item.prompt:'';
   if(!prompt||[...prompt].length>MAX_PROMPT)fail('IMAGE_BATCH_PROMPT_INVALID','每张 prompt 需要 1–6000 字。');
   return {index:n+1,name,prompt,status:'pending'};
  });
 }
 itemsFromDirectory(sourceDir){
  const dir=this.store.resolve(sourceDir,{directory:true}),names=fs.readdirSync(dir).filter(n=>n.toLowerCase().endsWith('.txt')).sort((a,b)=>a.localeCompare(b,'zh-Hans-CN',{numeric:true}));
  if(names.length<1||names.length>MAX_ITEMS)fail('IMAGE_BATCH_SOURCE_INVALID','描述文件夹里需要 1–40 个 .txt 文件。');
  return this.validateItems(names.map(name=>({name,prompt:this.store.bytes(path.join(dir,name)).content})));
 }
 start(args,caller,context={}){
  const binding=this.artifacts?this.taskBinding(caller,context.session_hash):null;
  const hasItems=args.items!==undefined,hasSource=args.source_dir!==undefined;if(hasItems===hasSource)fail('IMAGE_BATCH_INPUT_INVALID','items 和 source_dir 必须二选一。');
  if(typeof args.title!=='string'||!args.title.trim()||[...args.title].length>120)fail('IMAGE_BATCH_TITLE_INVALID','批次标题需要 1–120 字。');
  const items=hasItems?this.validateItems(args.items):this.itemsFromDirectory(args.source_dir);
  const saveDir=binding?(args.save_dir?this.normalizePath(args.save_dir):path.join(binding.root,'成果',safeArtifactName(this.policy.get(binding.task_id).title)+'-'+binding.task_id.slice(0,8))):this.chooseSaveDir(args.title,args.save_dir);
  if(binding){const rel=path.relative(binding.root,saveDir);safeArtifactPath(rel);if(path.isAbsolute(rel)||rel==='..'||rel.startsWith('..'+path.sep))fail('SCOPE_REQUIRED','图片成果只接收进当前工作区。');this.store.checkProtected?.(saveDir,{write:true});}
  const stateFile=path.join(saveDir,'_batch.json');if(fs.existsSync(stateFile))fail('IMAGE_BATCH_SAVE_DIR_BUSY','保存目录里已经有 _batch.json，请换一个目录，避免覆盖已有批次。');
  const batch={version:1,...(binding?{binding}:{}),batch_id:crypto.randomUUID(),title:args.title.trim(),created_at:new Date(this.now()).toISOString(),save_dir:saveDir,source_dir:args.source_dir||null,auto:args.auto!==false,running:true,paused:false,stopped:false,last_sent_at:null,in_flight:null,items,timeline:[{time:this.now(),event:'created',caller}]};
  this.batches.set(batch.batch_id,batch);this.persist(batch);this.policy.emit?.('image_batch_created',{batch_id:batch.batch_id,total:items.length});
  return this.view(batch);
 }
 get(id){
  if(typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id))fail('IMAGE_BATCH_MISSING','连续出图批次编号无效。');
  const batch=this.batches.get(id);if(!batch)fail('IMAGE_BATCH_MISSING','找不到这个连续出图批次。');return batch;
 }
 persist(batch){
  saveJSON(this.registryFile(batch.batch_id),batch);if(!this.artifacts&&!batch.binding)atomicJSON(path.join(batch.save_dir,'_batch.json'),batch); // Bound batches use one private authoritative registry, never a mutable workspace sidecar.
 }
 view(batch){
  const items=batch.items.map(publicItem),saved=items.filter(x=>x.status==='saved').length,terminal=items.every(x=>x.status==='saved'||x.status==='failed');
  const done=terminal&&!batch.in_flight;
  const next=items.find(x=>x.status==='pending');
  const lastFailed=[...items].reverse().find(x=>x.status==='failed'&&x.error);
  return {batch_id:batch.batch_id,title:batch.title,total:items.length,saved,running:!!batch.running&&!batch.paused&&!batch.stopped&&!done,stopped:!!batch.stopped,done,auto:batch.auto!==false,next_index:next?.index??null,in_flight:batch.in_flight?clone(batch.in_flight):null,items,save_dir:batch.save_dir,...(lastFailed?{last_error:{index:lastFailed.index,name:lastFailed.name,message:lastFailed.error}}:{})};
 }
 async claim(id,caller){
  for(;;){
   const wait=await this.locked(id,async()=>{
    const batch=this.get(id),view=this.view(batch);
    if(batch.stopped)return {result:{ok:false,reason:'stopped',view},wait:0};
    if(this.view(batch).done)return {result:{ok:false,reason:'done',view:this.view(batch)},wait:0};
    if(batch.paused)return {result:{ok:false,reason:'paused',view},wait:0};
    if(!batch.running)return {result:{ok:false,reason:'not_running',view},wait:0};
    if(batch.in_flight)return {result:{ok:false,reason:'already_sent',view},wait:0};
    const elapsed=batch.last_sent_at==null?MIN_SEND_GAP_MS:this.now()-batch.last_sent_at;
    if(elapsed<MIN_SEND_GAP_MS)return {result:null,wait:MIN_SEND_GAP_MS-elapsed};
    const item=batch.items.find(x=>x.status==='pending');if(!item)return {result:{ok:false,reason:'done',view:this.view(batch)},wait:0};
    const sentAt=new Date(this.now()).toISOString();item.status='sent';delete item.error;batch.in_flight={index:item.index,name:item.name,sent_at:sentAt};batch.last_sent_at=this.now();batch.timeline.push({time:this.now(),event:'sent',index:item.index,name:item.name,caller});this.persist(batch);this.policy.emit?.('image_batch_sent',{batch_id:id,index:item.index,name:item.name});
    return {result:{ok:true,index:item.index,name:item.name,message_text:`第 ${item.index}/${batch.items.length} 张（ChatHand 连续出图）：出一张图，画面如下：\n\n${item.prompt}`,view:this.view(batch)},wait:0};
   });
   if(wait.result)return wait.result;await this.sleep(Math.max(1,wait.wait));
  }
 }
 async control(args,caller){
  return this.locked(args.batch_id,async()=>{
   const batch=this.get(args.batch_id),action=args.action;
   if(action==='start'){
    if(!batch.stopped&&!this.view(batch).done){batch.running=true;batch.paused=false;batch.timeline.push({time:this.now(),event:'started',caller});}
   }else if(action==='pause'){
    if(!batch.stopped&&!this.view(batch).done){batch.running=false;batch.paused=true;batch.timeline.push({time:this.now(),event:'paused',caller});}
   }else if(action==='stop'){
    batch.running=false;batch.paused=false;batch.stopped=true;batch.timeline.push({time:this.now(),event:'stopped',caller});
   }else if(action==='release'){
    if(batch.in_flight){const item=batch.items.find(x=>x.index===batch.in_flight.index);if(item?.status==='sent')item.status='pending';batch.timeline.push({time:this.now(),event:'released',index:batch.in_flight.index,name:batch.in_flight.name,caller});batch.in_flight=null;}
   }else if(action==='set_auto'){
    if(typeof args.auto!=='boolean')fail('IMAGE_BATCH_AUTO_INVALID','set_auto 需要 auto 布尔值。');batch.auto=args.auto;batch.timeline.push({time:this.now(),event:'auto_changed',auto:args.auto,caller});
   }
   this.persist(batch);this.policy.emit?.('image_batch_control',{batch_id:batch.batch_id,action});return this.view(batch);
  });
 }
 resolveSaveTarget(args){
  let batch;if(args.batch_id)batch=this.get(args.batch_id);else{
   const candidates=[...this.batches.values()].filter(x=>!x.stopped&&(x.in_flight&&x.items.some(i=>i.index===x.in_flight.index&&i.status==='sent')||x.items.some(i=>i.status==='pending')));
   if(candidates.length!==1)fail('IMAGE_BATCH_AMBIGUOUS','请提供 batch_id；当前无法唯一确定正在出的批次。');batch=candidates[0];
  }
  /* 10/6 起不经卡片领取：没有在出的一张时，就把要存的这张（给了 index 用它，没给就是下一张没出的）记成在出，再走原来的核对。 */
  if(!batch.in_flight&&!batch.stopped){const want=args.index??batch.items.find(x=>x.status==='pending')?.index,item=batch.items.find(x=>x.index===want);if(item&&item.status==='pending'){item.status='sent';batch.in_flight={index:item.index,name:item.name,sent_at:new Date(this.now()).toISOString()};batch.last_sent_at=this.now();batch.timeline.push({time:this.now(),event:'sent',index:item.index,name:item.name,caller:'chatgpt'});this.persist(batch);}}
  const index=args.index??batch.in_flight?.index;if(!index)fail('IMAGE_BATCH_NO_IN_FLIGHT','这个批次没有还没出的图了。');
  if(!batch.in_flight||batch.in_flight.index!==index)fail('IMAGE_BATCH_INDEX_MISMATCH','只能交回当前正在出的这一张，避免把图片存错位置。');
  const item=batch.items.find(x=>x.index===index);if(!item||item.status!=='sent')fail('IMAGE_BATCH_INDEX_MISMATCH','这一张当前不是待交回状态。');
  return {batch,item};
 }
 async download(image){
  if(!image||typeof image!=='object'||typeof image.download_url!=='string'||typeof image.file_id!=='string')fail('IMAGE_BATCH_FILE_REQUIRED','没有收到 ChatGPT 的图片文件参数。');
  let url;try{url=new URL(image.download_url);}catch{fail('IMAGE_BATCH_URL_INVALID','图片下载地址无效。');}
  if(url.protocol!=='https:')fail('IMAGE_BATCH_URL_INVALID','只允许从 HTTPS 地址接收图片。');
  const signal=AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);let response;
  try{response=await this.fetchImpl(url,{signal,redirect:'follow'});}catch(e){const err=Error(e?.name==='TimeoutError'?'下载图片超过 30 秒。':'下载图片失败。');err.code='IMAGE_BATCH_DOWNLOAD_FAILED';throw err;}
  if(!response?.ok){const err=Error(`下载图片失败：HTTP ${response?.status??'unknown'}。`);err.code='IMAGE_BATCH_DOWNLOAD_FAILED';throw err;}
  if(response.url&&new URL(response.url).protocol!=='https:'){const err=Error('图片下载发生了非 HTTPS 跳转。');err.code='IMAGE_BATCH_DOWNLOAD_FAILED';throw err;}
  const declared=Number(response.headers?.get?.('content-length')||0);if(declared>MAX_IMAGE_BYTES){const err=Error('图片超过 30 MB。');err.code='IMAGE_BATCH_DOWNLOAD_FAILED';throw err;}
  const reader=response.body?.getReader?.();if(!reader){const err=Error('图片下载响应不可读取。');err.code='IMAGE_BATCH_DOWNLOAD_FAILED';throw err;}
  const chunks=[];let total=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;const chunk=Buffer.from(value);total+=chunk.length;if(total>MAX_IMAGE_BYTES){await reader.cancel().catch(()=>{});const err=Error('图片超过 30 MB。');err.code='IMAGE_BATCH_DOWNLOAD_FAILED';throw err;}chunks.push(chunk);}}finally{try{reader.releaseLock();}catch{}}
  const buf=Buffer.concat(chunks,total),type=imageType(buf);if(!type){const err=Error('收到的文件不是 PNG、JPG 或 WebP 图片。');err.code='IMAGE_BATCH_DOWNLOAD_FAILED';throw err;}return {buf,...type};
 }
 writeImage(batch,item,download){
  const prefix=/^\d{1,3}[_-]/.test(item.name)?item.name:String(item.index).padStart(2,'0')+'_'+item.name;let n=1,target;
  for(;;){const suffix=n===1?'':`-${n}`;target=path.join(batch.save_dir,prefix+suffix+'.'+download.ext);this.store.checkProtected?.(target,{write:true});try{const fd=fs.openSync(target,'wx',0o600);try{fs.writeFileSync(fd,download.buf);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}break;}catch(e){if(e.code==='EEXIST'){n++;continue;}throw e;}}
  return target;
 }
 async finalizeFailure(batchId,index,message,caller){
  return this.locked(batchId,async()=>{const batch=this.get(batchId),item=batch.items.find(x=>x.index===index);if(item?.status==='sent'){item.status='failed';item.error=String(message).slice(0,600);batch.in_flight=null;if(batch.items.every(x=>x.status==='saved'||x.status==='failed'))batch.running=false;batch.timeline.push({time:this.now(),event:'failed',index,name:item.name,error:item.error,caller});this.persist(batch);this.policy.emit?.('image_batch_failed',{batch_id:batchId,index,name:item.name});}return this.view(batch);});
 }
 taskBinding(caller,sessionHash){
  if(!sessionHash)fail('IMAGE_BATCH_TASK_AMBIGUOUS','出图接收需要明确的任务。');
  const candidates=[...this.policy.tasks.values()].filter(t=>t.caller===caller&&t.session_hash===sessionHash&&t.status==='active');
  if(candidates.length!==1)fail('IMAGE_BATCH_TASK_AMBIGUOUS','先在当前对话开始或接续一个明确的任务。');
  return this.artifacts.binding(candidates[0].id,caller,sessionHash);
 }
 bindForSave(batch,args,caller,sessionHash){
  if(batch.binding){this.artifacts.guard(batch.binding);return batch.binding;}
  // Old-format batches have no original session proof. An explicit batch is
  // continued by the currently authorized task; history is never reassigned.
  if(!args.batch_id)fail('IMAGE_BATCH_TASK_AMBIGUOUS','旧批次接续需要明确的批次编号。');
  const binding=this.taskBinding(caller,sessionHash),dir=this.store.resolve(batch.save_dir,{directory:true});this.store.checkProtected(dir);
  if(dir!==binding.root&&!dir.startsWith(binding.root+path.sep))fail('SCOPE_REQUIRED','旧批次不在当前工作区。');
  batch.binding=binding;batch.save_dir=path.join(binding.root,'成果',safeArtifactName(this.policy.get(binding.task_id).title)+'-'+binding.task_id.slice(0,8));batch.timeline.push({time:this.now(),event:'continued_by_task',task_id:binding.task_id,caller});return binding;
 }
 async saveArtifact(args,caller,{session_hash}={}){
  // Resolve and bind under the same lock; no network runs until ownership is
  // established. The shared receiver rechecks on every asynchronous boundary.
  const batchId=args.batch_id||[...this.batches.values()].filter(x=>x.binding?.caller===caller&&x.binding?.session_hash===session_hash&&!x.stopped&&(x.in_flight||x.items.some(i=>i.status==='pending'))).map(x=>x.batch_id).filter((_,__,all)=>all.length===1)[0];
  if(!batchId)fail('IMAGE_BATCH_AMBIGUOUS','请提供 batch_id；无法唯一确定当前对话的批次。');
  const target=await this.locked(batchId,()=>{const b=this.get(batchId);this.bindForSave(b,{...args,batch_id:args.batch_id},caller,session_hash);const selected=this.resolveSaveTarget({...args,batch_id:batchId});const key=batchId+':'+selected.item.index;if(this.saving.has(key))fail('IMAGE_BATCH_SAVE_IN_PROGRESS','这一张正在保存，不要重复交回。');this.saving.add(key);this.persist(b);return {...selected,key};});
  const {batch,item,key}=target;
  try{
   if(args.no_file===true){if(args.image)fail('IMAGE_BATCH_FILE_CONFLICT','no_file:true 时不要同时传 image。');return await this.finalizeFailure(batchId,item.index,'已出，未交回：宿主没有提供图片文件参数。',caller);}
   if(!args.image)fail('IMAGE_BATCH_FILE_REQUIRED','没有收到图片文件参数；宿主不给文件参数时传 no_file:true。');
   if(typeof args.image.download_url!=='string'||typeof args.image.file_id!=='string')fail('IMAGE_BATCH_FILE_REQUIRED','没有收到完整图片文件参数。');
   const request_id='image-'+batchId+'-'+item.index,prefix=/^\d{1,3}[_-]/.test(item.name)?item.name:String(item.index).padStart(2,'0')+'_'+item.name,extension=({ 'image/jpeg':'jpg','image/webp':'webp','image/png':'png'})[args.image.mime_type]||(/\.(png|jpe?g|webp)$/i.exec(args.image.file_name||'')?.[1]||'png');
   const inputs=[{...args.image,file_name:prefix+'.'+extension}],fingerprint=crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
   const intent=this.artifacts.newIntent({task_id:batch.binding.task_id,request_id,extract_zip:false,destination_prefix:safeArtifactPath(path.relative(batch.binding.root,batch.save_dir).split(path.sep).join('/'))},caller,session_hash,fingerprint);
   const result=intent.replayed?this.artifacts.view(intent.record):await this.artifacts.receive(intent.record,inputs,{requireImage:true});
   this.artifacts.guard(batch.binding);
   if(result.status!=='applied'){if(result.status==='unconfirmed'){return {...this.view(batch),receipt:result,next_action:'artifact_status',do_not_replay:true};}return await this.finalizeFailure(batchId,item.index,result.code==='ARTIFACT_IMAGE_INVALID'?'收到的文件不是可解码的 PNG、JPG 或 WebP 图片。':result.code==='ARTIFACT_URL_INVALID'?'只允许从 HTTPS 地址接收图片。':'图片接收没有完成（'+(result.code||'ARTIFACT_FAILED')+'）。',caller);}
   return this.locked(batchId,()=>{this.artifacts.guard(batch.binding);const live=this.get(batchId),current=live.items.find(x=>x.index===item.index);if(!live.in_flight||live.in_flight.index!==item.index||current?.status!=='sent')fail('IMAGE_BATCH_INDEX_MISMATCH','批次状态已经变化；成果回执保留，不重复保存。');const file=result.files[0];current.status='saved';current.file=path.join(batch.binding.root,file.path);current.mime_type=file.image?.mime_type||'image/png';delete current.error;live.in_flight=null;if(live.items.every(x=>x.status==='saved'||x.status==='failed'))live.running=false;live.timeline.push({time:this.now(),event:'saved',index:current.index,name:current.name,file:current.file,caller});this.persist(live);return this.view(live);});
  }finally{this.saving.delete(key);}
 }
 async save(args,caller,context={}){
  if(this.artifacts)return this.saveArtifact(args,caller,context);
  const {batch,item}=this.resolveSaveTarget(args),key=batch.batch_id+':'+item.index;if(this.saving.has(key))fail('IMAGE_BATCH_SAVE_IN_PROGRESS','这一张正在保存，不要重复交回。');this.saving.add(key);
  try{
   if(args.no_file===true){
    if(args.image)fail('IMAGE_BATCH_FILE_CONFLICT','no_file:true 时不要同时传 image。');
    return await this.finalizeFailure(batch.batch_id,item.index,'已出，未交回：宿主没有提供图片文件参数。',caller);
   }
   if(args.no_file!==undefined&&args.no_file!==false)fail('IMAGE_BATCH_FILE_REQUIRED','no_file 必须是布尔值。');
   if(!args.image)fail('IMAGE_BATCH_FILE_REQUIRED','没有收到图片文件参数；如果宿主确实不给文件参数，请明确传 no_file:true。');
   let download;try{download=await this.download(args.image);}catch(e){return await this.finalizeFailure(batch.batch_id,item.index,e.message||'图片下载失败。',caller);}
   return await this.locked(batch.batch_id,async()=>{
    const live=this.get(batch.batch_id),current=live.items.find(x=>x.index===item.index);
    if(!live.in_flight||live.in_flight.index!==item.index||current?.status!=='sent')fail('IMAGE_BATCH_INDEX_MISMATCH','图片下载完成时批次状态已经变化，没有写入，避免存错图片。');
    const file=this.writeImage(live,current,download);current.status='saved';current.file=file;current.mime_type=download.mime;delete current.error;live.in_flight=null;if(live.items.every(x=>x.status==='saved'||x.status==='failed'))live.running=false;live.timeline.push({time:this.now(),event:'saved',index:current.index,name:current.name,file,caller});this.persist(live);this.policy.emit?.('image_batch_saved',{batch_id:live.batch_id,index:current.index,name:current.name,file});return this.view(live);
   });
  }finally{this.saving.delete(key);}
 }
}
