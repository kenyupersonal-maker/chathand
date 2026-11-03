/** 1049: private, install-bound pilot identity. Not part of exported/settings/migrated user state. */
// 1095 (Claude, Ken 11/3): this identity never stops ChatHand from opening.
// "Same Mac" is decided only by the Mac's hardware UUID (kept as a salted
// digest). Host name and folder inode change in ordinary use (new Wi-Fi, a
// renamed Mac, a rebuilt or restored data folder), so they no longer decide
// anything. Outcomes:
//  - same Mac, or cannot tell: keep this identity and fill in what is missing;
//  - certainly another Mac (data copied over): start a new identity, so the
//    copied Site pairing is simply not used here and the user pairs again;
//  - the file is unreadable or damaged: keep it aside untouched, start fresh.
// Writes that fail keep the identity in memory for this run.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const FILE='installation-1049.json';
const fail=code=>{throw Object.assign(Error(code),{code});};
const hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
/** The Mac's hardware UUID, or null when it cannot be read (or not on macOS). */
export function readThisMac(){
 if(process.platform!=='darwin')return null;
 try{
  const out=execFileSync('/usr/sbin/ioreg',['-rd1','-c','IOPlatformExpertDevice'],{encoding:'utf8',timeout:1500,maxBuffer:65536,stdio:['ignore','pipe','ignore']});
  const value=/"IOPlatformUUID"\s*=\s*"([A-Fa-f0-9-]{36})"/.exec(out)?.[1]?.toLowerCase();
  return UUID.test(value||'')?value:null;
 }catch{return null;}
}
const deviceDigest=raw=>typeof raw==='string'&&UUID.test(raw.toLowerCase())?hash(JSON.stringify(['chathand-device-v1',raw.toLowerCase()])):null;
function scopeFor(dir){
 // Kept only so older ChatHand versions can still read this file after a downgrade.
 const rp=fs.realpathSync(dir),st=fs.statSync(rp);
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
  fs.renameSync(tmp,file);flushDirectory(dir);
 }finally{if(fd!==undefined&&fd!==null)try{fs.closeSync(fd);}catch{}try{fs.unlinkSync(tmp);}catch{}}
}
function valid(d){
 return d?.format===1&&UUID.test(d.installation_uuid)&&
  (d.installation_scope===undefined||typeof d.installation_scope==='string')&&
  (d.device===undefined||d.device===null||HASH.test(d.device))&&
  (d.pilot_installation_uuid===null||d.pilot_installation_uuid===undefined||UUID.test(d.pilot_installation_uuid));
}
const stamp=()=>new Date().toISOString().replace(/[-:]/g,'').replace(/\..*$/,'');
export class InstallationPilot {
 constructor(stateDir,{readDevice=readThisMac}={}){
  if(typeof stateDir!=='string'||!path.isAbsolute(stateDir))fail('PILOT_IDENTITY_INVALID');
  this.dir=fs.realpathSync(stateDir);
  this.file=path.join(this.dir,FILE);
  this.scope=scopeFor(this.dir);
  let raw=null;try{raw=readDevice();}catch{}
  this.device=deviceDigest(raw);
  /** null, or why this run uses a new identity: 'damaged' | 'other_mac'. */
  this.change=null;this.setAside=null;this.saveFailed=false;
  const saved=this.load();
  if(!saved)this.data=this.fresh();
  else if(saved.device&&this.device&&saved.device!==this.device){
   this.change='other_mac';
   this.data=this.save({...this.blank(),previous_installation_uuid:saved.installation_uuid});
  }else{
   const next={...saved,installation_scope:this.scope,device:this.device||saved.device||null};
   this.data=next.installation_scope===saved.installation_scope&&next.device===(saved.device??null)?saved:this.save(next);
  }
 }
 blank(){return {format:1,installation_uuid:crypto.randomUUID(),installation_scope:this.scope,device:this.device,pilot_installation_uuid:null};}
 /** Reads the saved identity. Anything unusable is moved aside untouched and null is returned. */
 load(){
  let st;try{st=fs.lstatSync(this.file);}catch(e){if(e.code==='ENOENT')return null;this.change='damaged';return null;}
  let d=null;
  if(st.isFile()&&st.size<=4096){try{d=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{d=null;}}
  if(!valid(d)){this.moveAside();return null;}
  if((st.mode&0o077)!==0)try{fs.chmodSync(this.file,0o600);}catch{}
  return d;
 }
 moveAside(){
  this.change='damaged';
  const target=path.join(this.dir,`installation-1049.unreadable-${stamp()}-${crypto.randomUUID().slice(0,8)}.json`);
  try{fs.renameSync(this.file,target);this.setAside=path.basename(target);}catch{}
 }
 fresh(){
  const value=this.blank();
  if(fs.existsSync(this.file)){this.saveFailed=true;return value;}
  // Exclusive create: competing starts cannot overwrite or choose each other's UUID.
  try{
   const fd=fs.openSync(this.file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW||0),0o600);
   try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   flushDirectory(this.dir);return value;
  }catch(e){
   if(e.code==='EEXIST'){const other=this.load();if(other)return other;}
   this.saveFailed=true;return value;
  }
 }
 save(value){try{atomic(this.file,value);}catch{this.saveFailed=true;}return value;}
 read(){return this.data;}
 eligible(){
  return this.defaultApplyFailed!==true&&this.data.pilot_installation_uuid===this.data.installation_uuid;
 }
 applyDefaultOnce(){
  if(this.data.pilot_default_applied===true)return this.status();
  const updated={...this.data,pilot_installation_uuid:this.data.installation_uuid,pilot_default_applied:true};
  atomic(this.file,updated);this.data=updated;return this.status();
 }
 setPilotEnabled(enabled){
  if(typeof enabled!=='boolean')fail('PILOT_SETTING_INVALID');
  const updated={...this.data,pilot_default_applied:true,pilot_installation_uuid:enabled?this.data.installation_uuid:null};
  atomic(this.file,updated);this.data=updated;this.defaultApplyFailed=false;
  return {pilot_enabled:this.eligible()};
 }
 status(){return {pilot_enabled:this.eligible()};}
}
