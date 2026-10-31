import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {privateDir,fail} from '../engine/src/core.mjs';
import {readCredentialRevision,writeCredentialRevision,withCredentialFileLock} from './credential-revision.mjs';

const AAD=Buffer.from('ken-bridge-local-credentials-v1');
const KEY_BYTES=32,IV_BYTES=12;
const unsafeNames=new Set(['__proto__','prototype','constructor']);
function sectionName(name){if(typeof name!=='string'||!/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(name)||unsafeNames.has(name))fail('ARG_INVALID','连接类型错误。');}
function jsonValue(value,seen=new Set()){
 if(value===null||typeof value==='string'||typeof value==='boolean')return;
 if(typeof value==='number'&&Number.isFinite(value))return;
 if(!value||typeof value!=='object'||seen.has(value)||!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('ARG_INVALID','连接信息格式错误。');
 seen.add(value);for(const key of Object.keys(value)){if(unsafeNames.has(key))fail('ARG_INVALID','连接信息字段错误。');jsonValue(value[key],seen);}seen.delete(value);
}
function sections(value){if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('ARG_INVALID','连接信息格式错误。');for(const key of Object.keys(value))sectionName(key);jsonValue(value);}
function syncDir(dir){const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function exists(file){try{fs.lstatSync(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
function openPrivate(file,{size,max=4*1024*1024,repair=false}={}){
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const st=fs.fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.uid!==process.getuid?.()||st.size>max||size!==undefined&&st.size!==size)fail('CREDENTIAL_STORE_UNSAFE','本地连接文件状态异常。');if((st.mode&0o777)!==0o600){if(!repair)fail('CREDENTIAL_STORE_UNSAFE','本地连接文件权限异常。');fs.fchmodSync(fd,0o600);}return fd;}catch(e){fs.closeSync(fd);throw e;}
}
function identity(file,{size,max}={}){
 try{const fd=openPrivate(file,{size,max});try{const s=fs.fstatSync(fd,{bigint:true});return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;}finally{fs.closeSync(fd);}}
 catch(e){if(e.code==='ENOENT')return 'missing';return null;}
}

/** Every installation uses the same local AES-256-GCM file backend. */
export class CredentialStore {
 constructor(dir,options={}){
  if(options.adapter!==undefined&&options.adapter!==null)fail('CREDENTIAL_BACKEND_UNSUPPORTED','连接信息只使用本地加密文件。');
  privateDir(dir);this.dir=fs.realpathSync(dir);this.file=path.join(this.dir,'credentials.json');this.keyFile=path.join(this.dir,'credentials.key');
  this.cache=null;this.observed=null;this.bases=new WeakMap();this.lockOptions={timeoutMs:options.lockTimeoutMs??1500};
 }
 key({create=false,exclusive=false}={}){
  if(exclusive&&exists(this.keyFile))fail('CREDENTIAL_STORE_EXISTS','本地连接文件已经存在，没有覆盖。');
  if(!exists(this.keyFile)){
   if(!create)fail('CREDENTIAL_STORE_CORRUPT','本地连接信息无法解密，请重新连接一次。');
   const temp=path.join(this.dir,`.credentials-key-${crypto.randomUUID()}.tmp`);let fd;
   try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,crypto.randomBytes(KEY_BYTES));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;try{fs.linkSync(temp,this.keyFile);}catch(e){if(e.code==='EEXIST')fail('CREDENTIAL_STORE_EXISTS','本地连接文件已经存在，没有覆盖。');throw e;}syncDir(this.dir);}
   finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);syncDir(this.dir);}catch(e){if(e.code!=='ENOENT')throw e;}}
  }
  const fd=openPrivate(this.keyFile,{size:KEY_BYTES,repair:true});try{return fs.readFileSync(fd);}finally{fs.closeSync(fd);}
 }
 readEncrypted(){
  if(!exists(this.file))return {};
  if(!exists(this.keyFile))fail('CREDENTIAL_STORE_CORRUPT','本地连接信息无法解密，请重新连接一次。');
  let box;const fd=openPrivate(this.file,{repair:true});
  try{box=JSON.parse(fs.readFileSync(fd,'utf8'));}catch{fail('CREDENTIAL_STORE_CORRUPT','本地连接信息无法读取，请重新连接一次。');}finally{fs.closeSync(fd);}
  if(box?.schema!==1||box?.algorithm!=='aes-256-gcm')fail('CREDENTIAL_STORE_VERSION','本地连接信息格式不支持，请重新连接一次。');
  try{const iv=Buffer.from(box.iv,'base64'),tag=Buffer.from(box.tag,'base64'),ciphertext=Buffer.from(box.ciphertext,'base64');if(iv.length!==IV_BYTES||tag.length!==16||!ciphertext.length)throw Error('shape');const decipher=crypto.createDecipheriv('aes-256-gcm',this.key(),iv);decipher.setAAD(AAD);decipher.setAuthTag(tag);const value=JSON.parse(Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8'));sections(value);return value;}
  catch(e){if(e?.code&&String(e.code).startsWith('CREDENTIAL_'))throw e;fail('CREDENTIAL_STORE_CORRUPT','本地连接信息无法解密，请重新连接一次。');}
 }
 invalidate(){this.cache=null;this.observed=null;}
 revision(){const file=identity(this.file),key=identity(this.keyFile,{size:KEY_BYTES}),marker=readCredentialRevision(this.dir);if(!file||!key||!marker||marker.phase!=='committed')return null;return `file:${file}|key:${key}|generation:${marker.generation}`;}
 writeRevision(){return this.revision();}
 observe(value,revision){this.observed={revision,value:structuredClone(value)};if(revision&&this.revision()===revision)this.cache={revision,value:structuredClone(value)};}
 _copy(value,revision){const copy=structuredClone(value);this.bases.set(copy,{revision,snapshot:structuredClone(value),scopes:new Map()});return copy;}
 _underLock(fn){return withCredentialFileLock(this.dir,fn,this.lockOptions);}
 _loaded(){
  // Under the writer lock, authenticate actual bytes before repairing a stamp.
  // A corrupt file never becomes an empty store or gains a successful cache.
  const value=this.readEncrypted();let revision=this.revision();
  if(!revision){writeCredentialRevision(this.dir,{schema:1,phase:'committed',generation:crypto.randomUUID()});revision=this.revision();}
  if(!revision)fail('CREDENTIAL_STORE_UNSAFE','本地连接信息状态异常。');return {value,revision};
 }
 readAll(){
  try{for(let n=0;n<3;n++){
   const before=this.revision();
   if(before&&this.cache?.revision===before){const value=structuredClone(this.cache.value);if(this.revision()===before)return this._copy(value,before);}
   if(!before){this.invalidate();return this._underLock(()=>{const {value,revision}=this._loaded();this.observe(value,revision);return this._copy(value,revision);});}
   const value=this.readEncrypted();if(this.revision()!==before)continue;this.observe(value,before);return this._copy(value,before);
  }fail('CREDENTIAL_CHANGED','连接信息正在变化，请稍后重试。');}catch(e){this.invalidate();throw e;}
 }
 _commit(value,{exclusive=false}={}){
  if(exclusive&&(exists(this.file)||exists(this.keyFile)))fail('CREDENTIAL_STORE_EXISTS','本地连接文件已经存在，没有覆盖。');
  const generation=crypto.randomUUID();writeCredentialRevision(this.dir,{schema:1,phase:'writing',generation});
  const key=this.key({create:true,exclusive}),iv=crypto.randomBytes(IV_BYTES),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(AAD);const ciphertext=Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value))),cipher.final()]);
  const box={schema:1,algorithm:'aes-256-gcm',iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64'),updated_at:new Date().toISOString()};
  const temp=path.join(this.dir,`.credentials-${crypto.randomUUID()}.tmp`);let fd;
  try{
   fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(box));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
   if(exclusive){try{fs.linkSync(temp,this.file);}catch(e){if(e.code==='EEXIST')fail('CREDENTIAL_STORE_EXISTS','本地连接文件已经存在，没有覆盖。');throw e;}} // Atomic no-replace publication.
   else{if(exists(this.file)){const check=openPrivate(this.file);fs.closeSync(check);}fs.renameSync(temp,this.file);}
   syncDir(this.dir);
  }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);syncDir(this.dir);}catch(e){if(e.code!=='ENOENT')throw e;}}
  const verified=this.readEncrypted();if(!isDeepStrictEqual(verified,value))fail('CREDENTIAL_WRITE_VERIFY_FAILED','本地连接信息写入校验未通过。');
  writeCredentialRevision(this.dir,{schema:1,phase:'committed',generation});const revision=this.revision();if(!revision)fail('CREDENTIAL_WRITE_VERIFY_FAILED','本地连接信息写入校验未通过。');this.observe(verified,revision);
 }
 writeAll(data,{exclusive=false}={}){
  sections(data);const base=this.bases.get(data);this.invalidate();return this._underLock(()=>{
   if(exclusive&&(exists(this.file)||exists(this.keyFile)))fail('CREDENTIAL_STORE_EXISTS','本地连接文件已经存在，没有覆盖。');
   if(!exclusive){const loaded=this._loaded();if(base?.revision&&loaded.revision!==base.revision)fail('CREDENTIAL_CONFLICT','连接信息已变化，请重新核对。');}
   this._commit(structuredClone(data),{exclusive});return {saved:true};
  });
 }
 get(section){sectionName(section);const all=this.readAll(),value=all[section]??null;if(value&&typeof value==='object')this.bases.set(value,this.bases.get(all));return value;}
 revisionOf(value){return value&&typeof value==='object'?this.bases.get(value)?.revision||null:null;}
 isCurrent(value){const revision=this.revisionOf(value);return revision?this.revision()===revision:undefined;}
 // Authority consumers may fence a fixed set of sections without treating an
 // unrelated token refresh as revocation. Whole-store CAS still uses revision.
 isCurrentScope(value,sections){
  if(!Array.isArray(sections)||!sections.length)fail('ARG_INVALID','连接类型错误。');
  for(const section of sections)sectionName(section);
  const base=value&&typeof value==='object'?this.bases.get(value):null;
  if(!base?.revision)return undefined;
  const revision=this.revision(),scope=JSON.stringify([...new Set(sections)].sort());
  if(!revision)return false;
  if(revision===base.revision||base.scopes.get(scope)===revision)return true;
  try{
   const current=this.readAll(),observed=this.revisionOf(current);
   if(!observed||this.revision()!==observed)return false;
   if(!sections.every(section=>isDeepStrictEqual(base.snapshot[section],current[section])))return false;
   base.scopes.set(scope,observed);return true;
  }catch{return false;}
 }
 set(section,value){sectionName(section);jsonValue(value);const base=value&&typeof value==='object'?this.bases.get(value):null;this.invalidate();return this._underLock(()=>{const loaded=this._loaded();if(base?.revision&&base.revision!==loaded.revision)fail('CREDENTIAL_CONFLICT','连接信息已变化，请重新核对。');if(Object.hasOwn(loaded.value,section)&&isDeepStrictEqual(loaded.value[section],value)){this.observe(loaded.value,loaded.revision);return {saved:true};}loaded.value[section]=structuredClone(value);this._commit(loaded.value);return {saved:true};});}
 remove(section){sectionName(section);this.invalidate();return this._underLock(()=>{const loaded=this._loaded();if(!Object.hasOwn(loaded.value,section))return {removed:false};delete loaded.value[section];this._commit(loaded.value);return {removed:true};});}
 peek(section){sectionName(section);const revision=this.revision();return revision&&this.observed?.revision===revision?structuredClone(this.observed.value[section]??null):null;}
 status(){const revision=this.revision(),verified=!!revision&&this.observed?.revision===revision,data=verified?this.observed.value:{};return {format:'local-encrypted-json',healthy:verified,verified,observation:verified?'current_revision':'unverified',tunnel:!!data.tunnel,relay:!!data.relay,site_b:!!data.site_b,site_b_machine:!!data.site_b_machine};}
}
