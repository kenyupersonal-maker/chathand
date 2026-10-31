import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {FileStore,fail,digest,saveJSON,privateDir,hashConflict} from '../engine/src/core.mjs';
import {captureMetadata,copyMetadata,verifyMetadata} from './file-metadata.mjs';
// Only this invocation's pure preflight can supply this proof. A historical
// prepared receipt or an error after the mutation callback has no such proof.
const preflightRefusals=new WeakMap();
let preflightSequence=0;
export const preflightRefusalCheckpoint=()=>preflightSequence;
export function consumePreflightRefusal(error,store,id,checkpoint){
 const proof=error&&typeof error==='object'?preflightRefusals.get(error):null;
 if(proof?.store!==store||proof.id!==id||proof.sequence<=checkpoint)return false;
 preflightRefusals.delete(error);return true;
}
function within(a,b){return a===b||a.startsWith(b.endsWith(path.sep)?b:b+path.sep);}
// File operations hash bytes without applying the text reader's encoding/size limits.
// Directory hashes include sorted relative names, types, modes, sizes and file hashes.
const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&a.mode===b.mode&&a.nlink===b.nlink;
function ordinary(st){
 if(st.isSymbolicLink()||(st.isFile()&&st.nlink!==1))fail('LINK_BLOCKED','路径操作不处理符号链接或多重硬链接。');
 if(!st.isFile()&&!st.isDirectory())fail('TYPE_BLOCKED','只支持普通文件或文件夹。');
}
function snapshotPath(target,guard=()=>{}){
 const entries=[],accessTimes=[];
 const walk=(p,rel)=>{
  guard(p);const accessTime=String(fs.lstatSync(p,{bigint:true}).atimeNs),before=fs.lstatSync(p);ordinary(before);
  const entry={path:rel,type:before.isDirectory()?'directory':'file',mode:before.mode&0o777};
  if(before.isFile()){
   const fd=fs.openSync(p,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
   try{
    const opened=fs.fstatSync(fd);ordinary(opened);if(!sameFile(before,opened))fail('FILE_CHANGED','文件在读取时变化。');
    const hash=crypto.createHash('sha256'),buf=Buffer.alloc(1024*1024);let bytes=0,n;
    while((n=fs.readSync(fd,buf,0,buf.length,null))>0){hash.update(buf.subarray(0,n));bytes+=n;}
    if(!sameFile(opened,fs.fstatSync(fd))||bytes!==opened.size)fail('FILE_CHANGED','文件在读取时变化。');
    entry.bytes=bytes;entry.sha256=hash.digest('hex');
   }finally{fs.closeSync(fd);}
  }
  accessTimes.push(accessTime);entries.push({...entry,identity:{dev:before.dev,ino:before.ino,size:before.size,mtimeMs:before.mtimeMs,ctimeMs:before.ctimeMs,mode:before.mode,nlink:before.nlink}});
  if(before.isDirectory())for(const name of fs.readdirSync(p).sort())walk(path.join(p,name),rel?rel+'/'+name:name);
  guard(p);if(!sameFile(before,fs.lstatSync(p)))fail('FILE_CHANGED','路径在检查时变化。');
 };
 walk(target,'');const content=entries.map(({identity,...e})=>e),first=entries[0];
 return {type:first.type,sha256:first.type==='file'?first.sha256:digest(JSON.stringify(['chathand-directory-v1',content])),entries,accessTimes};
}
const sameSnapshot=(a,b)=>JSON.stringify(a.entries)===JSON.stringify(b.entries);
function verifySnapshot(target,expected,guard){const current=snapshotPath(target,guard);if(!sameSnapshot(current,expected))fail('FILE_CHANGED','源路径在操作期间变化，未完成移动。');if(expected.metadata)expected.entries.forEach((e,i)=>verifyMetadata(path.join(target,e.path),expected.metadata[i],undefined,e.identity));return current;}
function verifyCopy(target,expected,{restoreAccess=false}={}){const current=snapshotPath(target);if(current.sha256!==expected.sha256||JSON.stringify(current.entries.map(({identity,...e})=>e))!==JSON.stringify(expected.entries.map(({identity,...e})=>e)))fail('COPY_VERIFY_FAILED','复制结果不完整，源路径保留。');if(expected.metadata)expected.entries.forEach((e,i)=>verifyMetadata(path.join(target,e.path),expected.metadata[i],restoreAccess?expected.accessTimes[i]:undefined,current.entries[i].identity));}
function absent(target){try{fs.lstatSync(target);}catch(e){if(e.code==='ENOENT')return;throw e;}fail('EEXIST','目标已存在。');}
function copySnapshot(src,dest,snapshot,{merge=false}={}){
 // Capture before creating any destination; unsupported metadata leaves the source intact.
 if(!snapshot.metadata){snapshot.metadata=snapshot.entries.map(e=>captureMetadata(path.join(src,e.path),e.identity));verifySnapshot(src,snapshot);}
 const destinations=new Map();
 // Exclusive creation keeps concurrent destinations intact. Never follow links.
 for(const entry of snapshot.entries){
  const source=path.join(src,entry.path),target=path.join(dest,entry.path);
  if(merge&&fs.existsSync(target)){const st=fs.lstatSync(target);ordinary(st);if((entry.type==='directory')!==st.isDirectory())fail('COPY_VERIFY_FAILED','恢复路径类型发生变化。');destinations.set(target,{dev:st.dev,ino:st.ino});continue;}
  if(entry.type==='directory'){fs.mkdirSync(target,{mode:0o700});const st=fs.lstatSync(target);destinations.set(target,{dev:st.dev,ino:st.ino});continue;}
  const input=fs.openSync(source,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));let output;
  try{
   const before=fs.fstatSync(input);ordinary(before);if(!before.isFile())fail('TYPE_BLOCKED','复制源不是普通文件。');
   output=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW||0),0o600);
   const created=fs.fstatSync(output);destinations.set(target,{dev:created.dev,ino:created.ino});
   const buf=Buffer.alloc(1024*1024);let n;while((n=fs.readSync(input,buf,0,buf.length,null))>0){let offset=0;while(offset<n){const written=fs.writeSync(output,buf,offset,n-offset);if(!written)fail('COPY_INCOMPLETE','文件写入未完成。');offset+=written;}}
   if(!sameFile(before,fs.fstatSync(input)))fail('FILE_CHANGED','复制时源文件变化。');fs.fchmodSync(output,entry.mode);fs.fsyncSync(output);
  }finally{if(output!==undefined)fs.closeSync(output);fs.closeSync(input);}
 }
 // Directories last: child creation must not change their final timestamps/ACLs.
 for(let i=snapshot.entries.length-1;i>=0;i--){const entry=snapshot.entries[i];if(!merge&&!sameFile(entry.identity,fs.lstatSync(path.join(src,entry.path))))fail('FILE_CHANGED','复制时源路径变化。');copyMetadata(path.join(src,entry.path),path.join(dest,entry.path),snapshot.metadata[i],snapshot.accessTimes[i],merge?undefined:entry.identity,destinations.get(path.join(dest,entry.path)));}
}
function removeCopiedSource(src,dest,snapshot,journal,guard){
 verifySnapshot(src,snapshot,guard);
 const held=path.join(path.dirname(src),'.chathand-move-'+crypto.randomUUID());
 journal({phase:'source_removal_prepared',source_backup:held,destination:dest});
 fs.renameSync(src,held);let removalStarted=false;
 try{
  // Renaming changes ctime; compare copied contents before removing anything.
  verifyCopy(held,snapshot);removalStarted=true;fs.rmSync(held,{recursive:true});
 }catch(error){
  try{
   // A failed recursive removal may have removed only part of a directory.
   // Rebuild missing entries from the verified destination before restoring its name.
   if(removalStarted){copySnapshot(dest,held,snapshot,{merge:true});verifyCopy(held,snapshot,{restoreAccess:true});}
   absent(src);fs.renameSync(held,src);
   journal({phase:'source_restored_after_removal_failure',source_backup:held,destination:dest});
  }catch{journal({phase:'recovery_required',source_backup:held,destination:dest});}
  throw error;
 }
}
function transferPath(src,dest,snapshot,journal,guard){
 absent(dest);verifySnapshot(src,snapshot,guard);
 if(snapshot.type==='file'){
  try{fs.linkSync(src,dest);}catch(e){if(e.code!=='EXDEV')throw e;return copyMove();}
  try{
   const a=fs.lstatSync(src),b=fs.lstatSync(dest),original=snapshot.entries[0].identity;
   if(a.ino!==original.ino||a.dev!==original.dev||a.ino!==b.ino||a.dev!==b.dev||a.nlink!==2||a.size!==original.size||a.mtimeMs!==original.mtimeMs)fail('FILE_CHANGED','移动时源文件变化。');
   fs.unlinkSync(src);
  }catch(e){fs.unlinkSync(dest);throw e;}
 }else{
  // Reserve the final directory exclusively; POSIX rename can replace this empty directory.
  fs.mkdirSync(dest,{mode:0o700});const reserved=fs.lstatSync(dest);
  try{
   verifySnapshot(src,snapshot,guard);const current=fs.lstatSync(dest);
   if(current.ino!==reserved.ino||current.dev!==reserved.dev||!current.isDirectory())fail('FILE_CHANGED','目标路径在移动时变化。');
   fs.renameSync(src,dest);
  }catch(e){
   const current=fs.lstatSync(dest);if(current.ino===reserved.ino&&current.dev===reserved.dev)fs.rmdirSync(dest);
   if(e.code!=='EXDEV')throw e;return copyMove();
  }
 }
 function copyMove(){
  journal({phase:'copy_prepared',destination:dest});
  // Keep a partial destination for inspection on failure; never report success or replay it.
  // Source is untouched until both destination and source snapshots pass verification.
  copySnapshot(src,dest,snapshot);verifyCopy(dest,snapshot,{restoreAccess:true});verifySnapshot(src,snapshot,guard);
  journal({phase:'copy_verified',destination:dest});removeCopiedSource(src,dest,snapshot,journal,guard);
 }
}

export class ProjectStore extends FileStore {
 setRoot(root){const real=fs.realpathSync(root);if(!fs.statSync(real).isDirectory())fail('ROOT_INVALID','请选择文件夹。');
  if(within(real,this.stateDir))fail('ROOT_STATE_OVERLAP','不能将程序状态目录设为项目。');
  this.root=real;this.writesEnabled=false;this.allowSensitive=false;}
 resolve(rel,{missing=false,directory=false}={}){
  if(typeof rel!=='string'||!rel||rel.length>4096||rel.includes('\0')||rel.includes('\\')||path.isAbsolute(rel))fail('PATH_INVALID','使用当前工作区内的相对路径。');
  if(directory&&rel==='.')return this.root;
  const parts=rel.split('/');if(parts.some(x=>!x||x==='.'||x==='..'))fail('PATH_INVALID','路径不能包含空段或上级目录。');
  let target=path.join(this.root,...parts),current=this.root;
  for(let i=0;i<parts.length;i++){
   current=path.join(current,parts[i]);let st;try{st=fs.lstatSync(current);}catch(e){if(e.code==='ENOENT'&&missing&&i===parts.length-1)break;throw e;}
   if(st.isSymbolicLink())fail('LINK_BLOCKED','直接文件工具不跟随符号链接。');
   if(st.isFile()&&st.nlink>1)fail('LINK_BLOCKED','直接文件工具不处理多重硬链接。');
   if(!st.isFile()&&!st.isDirectory())fail('TYPE_BLOCKED','只支持普通文件或文件夹。');
   const real=fs.realpathSync(current);if(within(real,this.stateDir))fail('PATH_BLOCKED','客户端状态目录始终不可通过远程文件工具访问。');
  }
  if(!within(target,this.root))fail('PATH_INVALID','路径超出选定范围。');
  return target;
 }

 info(){return {...super.info(),version:'0.4.0-preview.1',workspace_path:this.root,scope:'Selected working directory; terminal is not an OS sandbox. Full disk is subject to macOS and account permissions.'};}
 list(rel='.'){
  this.checkActive();const dir=this.resolve(rel,{directory:true});const raw=fs.readdirSync(dir,{withFileTypes:true}),entries=[];
  for(const e of raw){try{this.resolve(rel==='.'?e.name:rel+'/'+e.name);entries.push({name:e.name,type:e.isDirectory()?'directory':'file'});}catch{}}
  return {path:rel,entries:entries.slice(0,300),truncated:entries.length>300};
 }
 operation(kind,id,payload,fn,prepare=()=>undefined){
  const file=this.operationFile(id),fingerprint=digest(JSON.stringify([this.root,kind,payload]));
  if(fs.existsSync(file)){const old=JSON.parse(fs.readFileSync(file));if(old.fingerprint!==fingerprint)fail('OP_CONFLICT','操作编号已经用于其他内容。');if(old.status!=='applied')fail('OP_INCOMPLETE','前次结果不明确，必须先检查记录。');return {...old.result,replayed:true};}
  const record={kind,fingerprint,status:'prepared'};saveJSON(file,record);
  let prepared;
  try{prepared=prepare();}catch(error){
   if(error&&typeof error==='object')preflightRefusals.set(error,{store:this,id,sequence:++preflightSequence});
   throw error;
  }
  const journal=details=>{Object.assign(record,details);saveJSON(file,record);};const result=fn(journal,prepared);saveJSON(file,{...record,status:'applied',result});this.audit({event:kind,operation_id:id});return result;
 }
 mkdir(rel,id){this.checkActive(true);return this.operation('mkdir',id,[rel],(_journal,p)=>{fs.mkdirSync(p,{mode:0o700});return {path:rel,created:true};},()=>{const p=this.resolve(rel,{missing:true});if(fs.existsSync(p))fail('EEXIST','目标已存在。');return p;});}
 // Also invoked for every descendant: moving an ancestor must not move self/data.
 pathForOperation(input,{missing=false,write=false}={}){
  if(typeof input!=='string'||!input)fail('PATH_INVALID','文件路径无效。');
  const expanded=input==='~'||input?.startsWith('~/')?path.join(os.homedir(),input.slice(2)):input;
  const lexical=path.resolve(this.root,expanded),target=this.resolve(input,{missing,directory:input==='.'});
  if(lexical!==target)fail('LINK_BLOCKED','路径操作不跟随符号链接。');
  if(write){
   if(target===this.root||path.dirname(target)===target)fail('ROOT_PROTECTED','不能移动或回收当前范围根目录。');
   this.checkProtected?.(target,{write:true});
   const runtime=this.runtimeRoot||fileURLToPath(new URL('../',import.meta.url));
   for(const base of [this.stateDir,path.resolve(runtime)])if(within(target,base)||within(base,target))fail('PATH_BLOCKED','ChatHand 自身及数据目录不可修改。');
  }
  return target;
 }
 pathSnapshot(input,{write=false}={}){
  const target=this.pathForOperation(input,{write});
  const guard=p=>{const rel=path.isAbsolute(input)?p:path.relative(this.root,p)||'.';if(this.pathForOperation(rel,{write})!==p)fail('FILE_CHANGED','路径在检查时变化。');};
  return {target,guard,snapshot:snapshotPath(target,guard)};
 }
 pathInfo(input){this.checkActive();const {snapshot}=this.pathSnapshot(input);return {path:input,type:snapshot.type,sha256:snapshot.sha256,hash_kind:snapshot.type==='directory'?'chathand-directory-v1':'sha256',entries:snapshot.entries.length};}
 checkedSnapshot(input,expected){
  if(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected))fail('HASH_REQUIRED','expected_sha256 必须是刚读取的文件或目录快照哈希。');
  const result=this.pathSnapshot(input,{write:true});if(result.snapshot.sha256!==expected)hashConflict(this,input,result.snapshot.sha256,expected);return result;
 }
 move(from,to,expected,id){
  this.checkActive(true);return this.operation('move_path',id,[from,to,expected],(journal,{src,dest,snapshot,guard})=>{
   transferPath(src,dest,snapshot,journal,guard);return {from,to,moved:true,sha256:snapshot.sha256,type:snapshot.type};
  },()=>{
   const {target:src,snapshot,guard}=this.checkedSnapshot(from,expected),dest=this.pathForOperation(to,{missing:true,write:true});
   if(within(dest,src)||within(src,dest))fail('PATH_INVALID','源路径与目标路径不能相互包含。');
   absent(dest);return {src,dest,snapshot,guard};
  });
 }
 trash(rel,expected,id){
  this.checkActive(true);return this.operation('trash_path',id,[rel,expected],(journal,{target:src,snapshot,guard})=>{
   const dir=path.join(this.stateDir,'recycle');privateDir(dir);
   const trashId=crypto.randomUUID(),payload=path.join(dir,trashId+'.payload'),receiptFile=path.join(dir,trashId+'.json');
   const receipt={version:2,root:this.root,path:rel,sha256:snapshot.sha256,type:snapshot.type,access_times:snapshot.accessTimes,status:'prepared'};
   saveJSON(receiptFile,receipt);journal({trash_id:trashId});transferPath(src,payload,snapshot,journal,guard);
   saveJSON(receiptFile,{...receipt,status:'recycled'});
   return {path:rel,trash_id:trashId,status:'recycled',sha256:snapshot.sha256,type:snapshot.type,reversible:true,location:'ChatHand 回收区（不是系统废纸篓）'};
  },()=>this.checkedSnapshot(rel,expected));
 }
 restoreTrash(trashId,id){
  this.checkActive(true);if(!/^[a-f0-9-]{36}$/.test(trashId))fail('ARG_INVALID','回收编号错误。');
  const dir=path.join(this.stateDir,'recycle'),receipt=JSON.parse(fs.readFileSync(path.join(dir,trashId+'.json')));
  if(receipt.root!==this.root)fail('ROOT_CHANGED','切换到原工作区后再恢复。');
  if(receipt.version!==2)return this.write(receipt.path,receipt.content,'MISSING',id);
  return this.operation('restore_trash',id,[trashId],(journal,{source,dest,snapshot})=>{
   journal({phase:'restore_copy_prepared',destination:dest,root:this.root,path:receipt.path,after_sha256:receipt.sha256,type:receipt.type});copySnapshot(source,dest,snapshot);verifyCopy(dest,snapshot,{restoreAccess:true});verifySnapshot(source,snapshot);
   return {path:receipt.path,sha256:receipt.sha256,receipt_id:id,trash_id:trashId,type:receipt.type,restored:true};
  },()=>{
   if(receipt.status!=='recycled')fail('OP_INCOMPLETE','回收结果未确认，请先检查记录。');
   const dest=this.pathForOperation(receipt.path,{missing:true,write:true});
   if(fs.existsSync(dest))hashConflict(this,receipt.path,this.pathInfo(receipt.path).sha256,'MISSING');
   const source=path.join(dir,trashId+'.payload'),snapshot=snapshotPath(source);
   if(snapshot.sha256!==receipt.sha256||snapshot.type!==receipt.type)fail('HASH_CONFLICT','回收内容已经变化，未恢复。');
   // Preserve the access times captured before trash preflight read the payload.
   if(Array.isArray(receipt.access_times)&&receipt.access_times.length===snapshot.entries.length&&receipt.access_times.every(t=>typeof t==='string'&&/^-?[0-9]+$/.test(t)))snapshot.accessTimes=receipt.access_times;
   return {source,dest,snapshot};
  });
 }
 search(query,rel='.'){
  this.checkActive();if(typeof query!=='string'||!query||query.length>256)fail('ARG_INVALID','请输入 1–256 字符的搜索文本。');const matches=[];let visited=0,truncated=false,overflow=false;
  const walk=(base,depth)=>{
   if(overflow)return;
   if(depth>8||visited>=1000){truncated=true;return;}
   const listing=this.list(base);if(listing.truncated)truncated=true;
   for(const e of listing.entries){
    if(overflow)return;
    if(visited++>=1000){truncated=true;return;}
    const p=base==='.'?e.name:base+'/'+e.name;
    if(e.type==='directory'){walk(p,depth+1);continue;}
    let content;try{content=this.bytes(p).content;}catch(error){
     // Binary files are excluded; unreadable candidate text leaves the count unknown.
     if(error.code!=='BINARY_BLOCKED')truncated=true;
     continue;
    }
    const lines=content.split('\n');
    for(let i=0;i<lines.length;i++)if(lines[i].includes(query)){
     // Seeing the next match distinguishes exactly 100 from an incomplete prefix.
     if(matches.length===100){truncated=true;overflow=true;return;}
     matches.push({path:p,line:i+1,text:lines[i].slice(0,600)});
    }
   }
  };walk(rel,0);return {matches,visited,truncated};
 }
}
