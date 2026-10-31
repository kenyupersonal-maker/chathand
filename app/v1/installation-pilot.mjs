/** 1049: private, install-bound pilot identity. Not part of exported/settings/migrated user state. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const fail=code=>{throw Object.assign(Error(code),{code});};
const hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
function privateFile(file){
 const st=fs.lstatSync(file);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>4096||(st.mode&0o077)!==0)fail('PILOT_IDENTITY_UNSAFE');
 return st;
}
function scopeFor(dir){
 const rp=fs.realpathSync(dir),st=fs.statSync(rp);
 if(!st.isDirectory())fail('PILOT_IDENTITY_UNSAFE');
 // An installation copied to another state folder (even on the same Mac) is a new scope.
 // Directory inode/device persist through ordinary in-place application upgrades.
 return hash(JSON.stringify([rp,st.dev,st.ino,process.platform,os.hostname()]));
}
function flushDirectory(dir){
 try{const fd=fs.openSync(dir,fs.constants.O_RDONLY);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}catch{}
}
function atomic(file,value){
 const dir=path.dirname(file),tmp=file+'.'+crypto.randomUUID()+'.tmp';
 let fd;
 try{
  fd=fs.openSync(tmp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW||0),0o600);
  fs.writeFileSync(fd,JSON.stringify(value)+'\n','utf8');fs.fsyncSync(fd);fs.closeSync(fd);fd=null;
  if(fs.existsSync(file))privateFile(file);
  fs.renameSync(tmp,file);flushDirectory(dir);
 }finally{if(fd!==undefined&&fd!==null)try{fs.closeSync(fd);}catch{}try{fs.unlinkSync(tmp);}catch{}}
}
export class InstallationPilot {
 constructor(stateDir){
  if(typeof stateDir!=='string'||!path.isAbsolute(stateDir))fail('PILOT_IDENTITY_INVALID');
  this.dir=fs.realpathSync(stateDir);
  this.file=path.join(this.dir,'installation-1049.json');
  this.scope=scopeFor(this.dir);
  if(!fs.existsSync(this.file)){
   const fresh={format:1,installation_uuid:crypto.randomUUID(),installation_scope:this.scope,pilot_installation_uuid:null};
   // Exclusive create: competing starts cannot overwrite or choose each other's UUID.
   try{const fd=fs.openSync(this.file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW||0),0o600);
    try{fs.writeFileSync(fd,JSON.stringify(fresh)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    flushDirectory(this.dir);
   }catch(e){if(e.code!=='EEXIST')throw e;}
  }
  this.data=this.read();
 }
 read(){
  privateFile(this.file);
  let d;try{d=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{fail('PILOT_IDENTITY_CORRUPT');}
  if(d?.format!==1||!UUID.test(d.installation_uuid)||typeof d.installation_scope!=='string'||
   (d.pilot_installation_uuid!==null&&d.pilot_installation_uuid!==undefined&&!UUID.test(d.pilot_installation_uuid)))fail('PILOT_IDENTITY_CORRUPT');
  // Copies of the private identity file are readable but NEVER pilot-eligible.
  return d;
 }
 eligible(){
  return this.defaultApplyFailed!==true&&this.data.installation_scope===this.scope &&
   this.data.pilot_installation_uuid===this.data.installation_uuid;
 }
 applyDefaultOnce(){
  this.data=this.read();
  if(this.data.installation_scope!==this.scope||this.data.pilot_default_applied===true)return this.status();
  const updated={...this.data,pilot_installation_uuid:this.data.installation_uuid,pilot_default_applied:true};
  atomic(this.file,updated);this.data=updated;return this.status();
 }
 setPilotEnabled(enabled){
  if(typeof enabled!=='boolean')fail('PILOT_SETTING_INVALID');
  this.data=this.read();
  if(this.data.installation_scope!==this.scope)fail('PILOT_INSTALLATION_MISMATCH');
  const updated={...this.data,pilot_default_applied:true,pilot_installation_uuid:enabled?this.data.installation_uuid:null};
  atomic(this.file,updated);this.data=updated;this.defaultApplyFailed=false;
  return {pilot_enabled:this.eligible()};
 }
 status(){return {pilot_enabled:this.eligible()};}
}
