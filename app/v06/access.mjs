import fs from 'node:fs';
import {writeLarge} from './large-write.mjs';
import {VERSION} from '../product.mjs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {ProjectStore} from '../store.mjs';
import {TaskPolicy} from '../policy.mjs';
import {fail, digest} from '../../engine/src/core.mjs';
export const APP_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const within=(target,base)=>{return target===base||target.startsWith(base.endsWith(path.sep)?base:base+path.sep);};
const canonical=p=>{try{return fs.realpathSync(p);}catch{return path.resolve(p);}};
function rejectPathLinks(candidate,{missing=false}={}){
 const aliases=process.platform==='darwin'?new Map([['/var','/private/var'],['/tmp','/private/tmp'],['/etc','/private/etc']]):new Map();
 let current=path.parse(candidate).root;const parts=candidate.slice(current.length).split(path.sep).filter(Boolean);
 for(let i=0;i<parts.length;i++){
  current=path.join(current,parts[i]);let st;
  try{st=fs.lstatSync(current);}catch(e){if(e.code==='ENOENT'&&missing&&i===parts.length-1)return;throw e;}
  if(!st.isSymbolicLink())continue;
  if(aliases.get(current)===fs.realpathSync(current))continue;
  let real;try{real=fs.realpathSync(candidate);}catch{try{real=path.join(fs.realpathSync(path.dirname(candidate)),path.basename(candidate));}catch{}}
  const e=Object.assign(new Error('文件工具不跟随符号链接。'+(real?'请直接使用真实路径：'+real:'请先确认该链接的真实路径。')),{code:'LINK_BLOCKED'});if(real)e.details={real_path:real};throw e;
 }
}
export class ScopedStore extends ProjectStore {
  constructor(root,stateDir){super(root,stateDir);this.accessMode='auto';this.runtimeRoot=APP_ROOT;}
  get protectedPaths(){return [...new Set([this.stateDir,...['v05','data','upgrades'].map(n=>canonical(path.join(os.homedir(),'Library/Application Support/ChatHand',n)))])];}
  checkProtected(target,{write=false}={}){
    for(const base of this.protectedPaths){if(within(target,base)||(write&&within(base,target)))fail('BRIDGE_STATE_PROTECTED','客户端连接资料与运行状态由本机应用管理。');}
    if(write&&(within(target,this.runtimeRoot)||within(this.runtimeRoot,target)))fail('RUNTIME_PROTECTED','运行中的程序不可自行改写；请在独立开发副本中修改后安装。');
  }
  resolve(input,{missing=false,directory=false}={}){
    if(typeof input!=='string'||!input||input.length>4096||input.includes('\0'))fail('PATH_INVALID','文件路径无效。');
    if(input==='~'||input.startsWith('~/'))input=path.join(os.homedir(),input.slice(2));
    const candidate=path.resolve(this.root,input);
    this.checkProtected(candidate);
    let real;
    try{real=fs.realpathSync(candidate);}catch(e){
      if(e.code!=='ENOENT'||!missing)throw e;
      real=path.join(fs.realpathSync(path.dirname(candidate)),path.basename(candidate));
    }
    this.checkProtected(real);
    if(this.accessMode!=='full'&&!within(real,this.root))fail('SCOPE_REQUIRED','此路径在工作区外，当前不能访问；文件范围在 ChatHand 窗口里调整。');
    rejectPathLinks(candidate,{missing});
    let st;try{st=fs.lstatSync(real);}catch(e){if(e.code!=='ENOENT'||!missing)throw e;}
    if(st&&!st.isFile()&&!st.isDirectory())fail('TYPE_BLOCKED','仅支持普通文件与文件夹。');
    if(st?.isFile()&&st.nlink>1)fail('LINK_BLOCKED','文件存在多个硬链接，请先复制为普通文件。');
    if(directory&&st&&!st.isDirectory())fail('TYPE_BLOCKED','需要一个文件夹。');
    return real;
  }
  list(input='.',options={}){
    this.checkActive();const dir=this.resolve(input,{directory:true}),entries=[];let restricted=false;
    const limit=options.limit??300,offset=options.offset??0,cursor=options.cursor??null;
    if(!Number.isInteger(limit)||limit<1||limit>300||!Number.isInteger(offset)||offset<0)fail('ARG_INVALID','文件列表分页范围无效。');
    const handle=fs.opendirSync(dir);try{let entry;while((entry=handle.readSync())){
      try{if(entry.isSymbolicLink()){restricted=true;continue;}const p=this.resolve(path.join(dir,entry.name)),st=fs.lstatSync(p);
        if(!st.isFile()&&!st.isDirectory()||st.nlink>1&&st.isFile()){restricted=true;continue;}
        entries.push({name:entry.name,type:st.isDirectory()?'directory':'file',bytes:st.size,symlink:false});
      }catch{restricted=true;}
    }}finally{handle.closeSync();}
    entries.sort((a,b)=>(a.type===b.type?0:a.type==='directory'?-1:1)||a.name.localeCompare(b.name));
    const snapshot=digest(JSON.stringify([this.root,this.accessMode,dir,entries.map(x=>[x.name,x.type,x.bytes])]));
    if(cursor!==null){const match=typeof cursor==='string'&&/^v1:(\d+):([a-f0-9]{64})$/.exec(cursor);if(!match||Number(match[1])!==offset||match[2]!==snapshot)fail('LIST_CHANGED','文件列表已经变化，请从第一页重查。');}
    else if(offset!==0)fail('LIST_CURSOR_REQUIRED','翻页请带上一页的 cursor，避免错页。');
    const page=entries.slice(offset,offset+limit),next_offset=offset+page.length<entries.length?offset+page.length:null;
    return {path:input,entries:page,offset,limit,total:entries.length,scope_visible_only:true,
      next_offset,next_cursor:next_offset===null?null:'v1:'+next_offset+':'+snapshot,
      truncated:next_offset!==null||restricted,incomplete:restricted,hidden_or_skipped:restricted,scope:this.accessMode};
  }
  openRead(input){
    this.checkActive();const p=this.resolve(input);const before=fs.statSync(p);
    if(!before.isFile())fail('TYPE_BLOCKED','需要一个普通文件。');
    const fd=fs.openSync(p,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    try{const st=fs.fstatSync(fd);const again=this.resolve(input);const live=fs.statSync(again);
      if(st.nlink>1||st.ino!==before.ino||st.dev!==before.dev||st.ino!==live.ino||st.dev!==live.dev||again!==p)fail('FILE_CHANGED','文件在打开过程中变化，请重新读取。');
      return {fd,path:p,stat:st};
    }catch(e){fs.closeSync(fd);throw e;}
  }
  bytes(input){
    const {fd,stat}=this.openRead(input);
    try{
      if(stat.size>8*1024*1024)fail('FILE_TOO_LARGE','请使用 read_file 的分段读取，不必扩大权限。');
      const buf=fs.readFileSync(fd);if(buf.length>8*1024*1024)fail('FILE_TOO_LARGE','文件在读取时增长，请分段读取。');
      if(buf.includes(0))fail('BINARY_BLOCKED','请使用 read_file 自动识别文件格式。');
      let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(buf);}catch{fail('ENCODING_BLOCKED','请使用 read_file 并指定实际编码。');}
      return {buf,content,sha256:digest(buf),mode:stat.mode&0o777};
    }finally{fs.closeSync(fd);}
  }
  writable(input,missing=false){const p=this.resolve(input,{missing});this.checkProtected(p,{write:true});return p;}
  write(rel,content,...args){this.writable(rel,true);return typeof content==='string'&&Buffer.byteLength(content)>256*1024?writeLarge(this,rel,content,...args):super.write(rel,content,...args);}
  mkdir(rel,...args){this.writable(rel,true);return super.mkdir(rel,...args);}
  // Applied receipts outlive their source. Recheck today's scope/self boundary
  // through the nearest existing ancestor, without requiring that source back.
  checkReplayPath(input){
    if(typeof input!=='string'||!input||input.length>4096||input.includes('\0'))fail('PATH_INVALID','文件路径无效。');
    const expanded=input==='~'||input.startsWith('~/')?path.join(os.homedir(),input.slice(2)):input;
    const lexical=path.resolve(this.root,expanded);let parent=lexical,real;
    for(;;){try{real=fs.realpathSync(parent);break;}catch(e){if(e.code!=='ENOENT'||path.dirname(parent)===parent)throw e;parent=path.dirname(parent);}}
    const target=path.resolve(real,path.relative(parent,lexical));
    this.checkProtected(lexical,{write:true});this.checkProtected(target,{write:true});
    if(this.accessMode!=='full'&&!within(target,this.root))fail('SCOPE_REQUIRED','此路径在工作区外，当前不能访问；文件范围在 ChatHand 窗口里调整。');
    if(target===this.root||path.dirname(target)===target)fail('ROOT_PROTECTED','不能移动或回收当前范围根目录。');
    if(target!==lexical)fail('LINK_BLOCKED','路径操作不跟随符号链接。');
  }
  operation(kind,id,payload,fn,prepare){
    if(['move_path','trash_path'].includes(kind)&&fs.existsSync(this.operationFile(id)))
      for(const input of kind==='move_path'?payload.slice(0,2):payload.slice(0,1))this.checkReplayPath(input);
    return super.operation(kind,id,payload,fn,prepare);
  }
  info(){return {...super.info(),version:VERSION,scope:(this.accessMode==='full'?'当前账户可访问的文件；客户端连接资料受保护':'这个文件夹；命令受系统沙箱约束'),access_scope:this.accessMode,max_file_bytes:null,max_legacy_edit_bytes:8*1024*1024,streaming_read:true,not_os_sandbox:false};}
}
export class AccessPolicy extends TaskPolicy {
  constructor(state,store,queue){
    super(state,store,queue);this.transitioning=false;
    if(!['auto','full'].includes(state.data.mode))state.data.mode='auto';
    if(state.data.mode==='full'&&state.data.full_access_confirmed!==true)state.data.mode='auto';
    state.data.auto_approve_tasks=true;state.data.permission_model=2;state.save();
    this.fullArmed=state.data.mode==='full';store.accessMode=state.data.mode;
  }
  check(){super.check();if(this.transitioning)fail('PERMISSION_TRANSITION','权限正在切换，旧任务正在停止。');}
  begin(args,caller,context){const result=super.begin(args,caller,context);const t=this.get(result.task_id,caller);if(t.status==='active')t.expires_at=null;return {...this.view(t),...(result.replayed?{replayed:true}:{})};}
  revokeAll(reason='revoked',options={}){this.onRevoke?.(reason);super.revokeAll(reason,options);}
  async setMode(mode,confirm=false,{keepTask=null,validateCommit=null}={}){
    if(!['auto','full'].includes(mode))fail('ARG_INVALID','仅支持「这个文件夹」和「整台电脑」。');
    if(mode==='full'&&!confirm)fail('FULL_CONFIRM_REQUIRED','完全访问要在 ChatHand 窗口里确认，AI 不能代选；读取的文件会进入云端对话。');
    if(this.transitioning)fail('PERMISSION_TRANSITION','权限正在切换。');
    this.transitioning=true;
    try{
      this.revokeAll('permission_changed',{keepTask});
      const until=Date.now()+5000;
      while(this.queue.list().some(j=>j.process_alive||j.cleanup_pending)&&Date.now()<until)await new Promise(r=>setTimeout(r,25));
      if(this.queue.list().some(j=>j.process_alive||j.cleanup_pending))fail('STOP_INCOMPLETE','旧任务尚未停止，权限未变更。');
      if(keepTask&&keepTask.status!=='active')fail('TASK_REVOKED','原任务已停止。');validateCommit?.();
      this.state.data.mode=mode;this.state.data.full_access_confirmed=mode==='full';
      this.state.data.auto_approve_tasks=true;this.store.accessMode=mode;this.fullArmed=mode==='full';this.state.save();if(keepTask){if(keepTask.status!=='active')fail('TASK_REVOKED','原任务已停止。');keepTask.epoch=this.epoch;keepTask.root=this.store.root;}this.emit('permissions_changed');
      return {mode};
    }finally{this.transitioning=false;}
  }
}
