import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fail} from '../engine/src/core.mjs';

export const REVISION_FILE='credential-revision.json';
export const revisionValid=value=>value?.schema===1&&['committed','writing'].includes(value.phase)&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.generation||'');
export const UNCACHEABLE_FILE='credential-uncacheable';
export function credentialCacheDisabled(dir){try{fs.lstatSync(path.join(dir,UNCACHEABLE_FILE));return true;}catch(e){return e.code!=='ENOENT';}}
export function readCredentialRevision(dir){
 const file=path.join(dir,REVISION_FILE);
 try{
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{const st=fs.fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.uid!==process.getuid?.()||st.size>4096)return null;const value=JSON.parse(fs.readFileSync(fd,'utf8'));return revisionValid(value)?value:null;}finally{fs.closeSync(fd);}
 }catch{return null;}
}
export function writeCredentialRevision(dir,value){
 const file=path.join(dir,REVISION_FILE),temp=path.join(dir,`.credential-revision-${crypto.randomUUID()}`);
 if(fs.existsSync(file)){const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)fail('CREDENTIAL_STORE_UNSAFE','本地连接文件状态异常。');}
 let fd;
 try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);const d=fs.openSync(dir,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
 finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch{}}
}
export function disableCredentialCache(dir){
 const file=path.join(dir,UNCACHEABLE_FILE);let fd;
 try{fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.writeFileSync(fd,'{"schema":1,"cache_mode":"legacy_uncacheable"}');fs.fsyncSync(fd);}
 catch(e){
  if(e.code!=='EEXIST')throw e;
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  const st=fs.fstatSync(fd);let value;try{value=JSON.parse(fs.readFileSync(fd,'utf8'));}catch{}
  if(!st.isFile()||st.nlink!==1||st.uid!==process.getuid?.()||(st.mode&0o777)!==0o600||value?.schema!==1||value?.cache_mode!=='legacy_uncacheable')fail('CREDENTIAL_STORE_UNSAFE','本地连接文件状态异常。');
 }finally{if(fd!==undefined)fs.closeSync(fd);}
 const directory=fs.openSync(dir,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
}

// File-backend writers use a separate lock from the retired Keychain helper.
// Publish a complete, nonempty owner directory atomically. A live owner is
// never displaced by age. Removing only a dead owner's unique token is safe
// even if another process acquires the now-empty directory before rmdir.
export const FILE_WRITE_LOCK='credential-file-write.lock';
const sleep=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
export function withCredentialFileLock(dir,fn,{timeoutMs=1500}={}){
 const lock=path.join(dir,FILE_WRITE_LOCK),token=crypto.randomUUID(),name=`${process.pid}-${token}`;
 const prepared=path.join(dir,`.credential-file-owner-${name}`),owner={pid:process.pid,token};
 fs.mkdirSync(prepared,{mode:0o700});
 const marker=path.join(prepared,name);let fd;
 try{fd=fs.openSync(marker,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(owner));fs.fsyncSync(fd);}
 finally{if(fd!==undefined)fs.closeSync(fd);}
 const deadline=Date.now()+Math.max(0,Math.min(5000,timeoutMs));let held=false;
 const removeOwn=base=>{try{fs.unlinkSync(path.join(base,name));}catch(e){if(e.code!=='ENOENT')throw e;}try{fs.rmdirSync(base);}catch(e){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(e.code))throw e;}};
 try{
  for(;;){
   try{fs.renameSync(prepared,lock);held=true;break;}
   catch(e){if(!['EEXIST','ENOTEMPTY','ENOENT'].includes(e.code))throw e;}
   try{
    const st=fs.lstatSync(lock);
    if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid?.())fail('CREDENTIAL_STORE_UNSAFE','本地连接锁状态异常。');
    const entries=fs.readdirSync(lock);
    if(entries.length===1&&/^\d+-[a-f0-9-]{36}$/.test(entries[0])){
     const file=path.join(lock,entries[0]);let f;
     try{
      f=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
      const s=fs.fstatSync(f);
      if(s.isFile()&&s.nlink===1&&s.uid===process.getuid?.()&&s.size<=256){
       const value=JSON.parse(fs.readFileSync(f,'utf8'));
       if(Number.isSafeInteger(value.pid)&&value.pid>1&&`${value.pid}-${value.token}`===entries[0]){
        let dead=false;try{process.kill(value.pid,0);}catch(error){dead=error.code==='ESRCH';}
        if(dead){
         // Never remove another owner's token, even across a release/acquire race.
         try{fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}
         try{fs.rmdirSync(lock);}catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code))throw error;}
        }
       }
      }
     }catch(error){if(error.code==='CREDENTIAL_STORE_UNSAFE')throw error;}
     finally{if(f!==undefined)fs.closeSync(f);}
    }
   }catch(e){if(e.code!=='ENOENT')throw e;}
   if(Date.now()>=deadline)fail('CREDENTIAL_BUSY','连接信息正在保存，请稍后重试。');
   sleep(Math.min(10,Math.max(1,deadline-Date.now())));
  }
  return fn();
 }finally{if(held)removeOwn(lock);else removeOwn(prepared);}
}
