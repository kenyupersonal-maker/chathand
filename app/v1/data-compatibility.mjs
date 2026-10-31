import fs from 'node:fs';
import path from 'node:path';
const unsupported=()=>{throw Object.assign(new Error('DATA_FORMAT_UNSUPPORTED'),{code:'DATA_FORMAT_UNSUPPORTED'});};
const newer=()=>{throw Object.assign(new Error('DATA_FORMAT_NEWER'),{code:'DATA_FORMAT_NEWER'});};
const missing=e=>e?.code==='ENOENT';
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
// Read-only startup preflight. Never mkdir/chmod, repair, migrate, or save here.
// Unknown additive fields remain untouched; only declared format is interpreted.
export function assertDesktopDataCompatibility(stateDir){
 if(typeof stateDir!=='string'||!path.isAbsolute(stateDir))unsupported();
 let cursor=path.parse(stateDir).root;
 try{
  for(const part of path.resolve(stateDir).slice(cursor.length).split(path.sep).filter(Boolean)){
   cursor=path.join(cursor,part);let st;
   try{st=fs.lstatSync(cursor);}catch(e){if(missing(e))return {compatible:true,kind:'absent'};throw e;}
   if(st.isSymbolicLink()){
    // The sole fixed macOS system alias; no user-controlled link is followed.
    if(cursor!=='/var'||!['private/var','/private/var'].includes(fs.readlinkSync(cursor)))unsupported();
   }else if(!st.isDirectory())unsupported();
  }
  const file=path.join(stateDir,'desktop.json');let before;
  try{before=fs.lstatSync(file);}catch(e){if(missing(e))return {compatible:true,kind:'absent'};throw e;}
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)unsupported();
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);let bytes;
  try{
   const opened=fs.fstatSync(fd);if(!opened.isFile()||!same(before,opened))unsupported();
   bytes=fs.readFileSync(fd);if(bytes.length!==opened.size||!same(opened,fs.fstatSync(fd)))unsupported();
  }finally{fs.closeSync(fd);}
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!value||typeof value!=='object'||Array.isArray(value))unsupported();
  for(const key of ['schema','version'])if(Object.hasOwn(value,key)){
   const number=value[key];if(!Number.isSafeInteger(number)||number<1)unsupported();if(number>1)newer();
  }
  return {compatible:true,kind:Object.hasOwn(value,'schema')||Object.hasOwn(value,'version')?'version_1':'legacy'};
 }catch(e){if(e?.code==='DATA_FORMAT_NEWER'||e?.code==='DATA_FORMAT_UNSUPPORTED')throw e;unsupported();}
}
