import fs from 'node:fs';
import path from 'node:path';
import {HIGH_RISK_IDS} from './high-risk.mjs';
const unsupported=()=>{throw Object.assign(new Error('DATA_FORMAT_UNSUPPORTED'),{code:'DATA_FORMAT_UNSUPPORTED'});};
const missing=e=>e?.code==='ENOENT';
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
// Only ChatHand's own marker declares an incompatible layout. Historical
// version/schema fields and other products' format values are ordinary data.
export const DESKTOP_DATA_FORMAT='chathand-desktop-v1';
export function assertDesktopDataFormat(value){
 if(!value||typeof value!=='object'||Array.isArray(value))unsupported();
 const match=Object.hasOwn(value,'format')&&typeof value.format==='string'&&/^chathand-desktop-v([1-9][0-9]*)$/.exec(value.format);
 if(match&&match[1]!=='1'){
  const minimum=typeof value.min_app_version==='string'&&/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.min_app_version)&&value.min_app_version.length<=80?value.min_app_version:null;
  return {compatible:true,kind:'newer',format:match[0],format_version:match[1],min_app_version:minimum};
 }
 return {compatible:true,kind:match?'version_1':'legacy'};
}
function hasDesktopShape(value){
 const executionBooleans=['access_enabled','terminal_enabled','browser_enabled','desktop_enabled','auto_approve_tasks','full_access_confirmed','admin_requested','browser_control_opt_in','auto_connect','auto_update'];
 if(executionBooleans.some(key=>Object.hasOwn(value,key)&&typeof value[key]!=='boolean'))return false;
 if(Object.hasOwn(value,'high_risk')){
  if(!value.high_risk||typeof value.high_risk!=='object'||Array.isArray(value.high_risk))return false;
  if(HIGH_RISK_IDS.some(key=>Object.hasOwn(value.high_risk,key)&&typeof value.high_risk[key]!=='boolean'))return false;
 }
 return Array.isArray(value.projects)&&value.projects.length>0&&value.projects.every(p=>p&&typeof p==='object'&&!Array.isArray(p)&&typeof p.id==='string'&&p.id.length>0)&&value.projects.some(p=>p.id===value.active)&&Array.isArray(value.conversations)&&value.conversations.every(c=>c&&typeof c==='object'&&!Array.isArray(c));
}
// Read-only startup preflight. Never mkdir/chmod, repair, migrate, or save here.
// Unknown additive fields remain untouched; only declared format is interpreted.
export function readDesktopDataSnapshot(stateDir,{allowCorrupt=false,requireShape=false}={}){
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
   bytes=fs.readFileSync(fd);if(bytes.length!==opened.size||!same(opened,fs.fstatSync(fd))||!same(opened,fs.lstatSync(file)))unsupported();
  }finally{fs.closeSync(fd);}
  let value;
  try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch{if(allowCorrupt)return {compatible:true,kind:'corrupt',stat:before};unsupported();}
  if(!value||typeof value!=='object'||Array.isArray(value)){
   if(allowCorrupt)return {compatible:true,kind:'corrupt',stat:before};unsupported();
  }
  const format=assertDesktopDataFormat(value);
  // A future envelope is deliberately not interpreted by this reader.
  if(format.kind!=='newer'&&requireShape&&!hasDesktopShape(value)){
   if(allowCorrupt)return {compatible:true,kind:'corrupt',stat:before};unsupported();
  }
  return {...format,value};
 }catch(e){if(['DATA_FORMAT_UNSUPPORTED','EACCES','EPERM'].includes(e?.code))throw e;unsupported();}
}
export function assertDesktopDataCompatibility(dir,options={}){
 const {value,stat,...status}=readDesktopDataSnapshot(dir,options);return status;
}
