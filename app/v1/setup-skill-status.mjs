import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const base=()=>process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
export function setupSkillStatus({codexHome=base()}={}){
 const dest=path.join(codexHome,'skills/chathand-setup');
 try{
  const directory=fs.lstatSync(dest);if(!directory.isDirectory()||directory.isSymbolicLink())return {installed:false,managed:false};
  const entry=fs.lstatSync(path.join(dest,'SKILL.md'));if(!entry.isFile()||entry.isSymbolicLink())return {installed:false,managed:false};
  let marker;try{marker=fs.lstatSync(path.join(dest,'.chathand-owned.json'));}catch(error){if(error?.code==='ENOENT')return {installed:false,managed:true};throw error;}
  if(!marker.isFile()||marker.isSymbolicLink()||marker.nlink!==1||marker.size>65536)return {installed:false,managed:true};
  const value=JSON.parse(fs.readFileSync(path.join(dest,'.chathand-owned.json'),'utf8'));
  const keys=value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value).sort():[];
  const installed=keys.length===3&&keys.join(',')==='format,kind,owner'&&typeof value.format==='number'&&Number.isInteger(value.format)&&value.format===1&&value.owner==='com.kenyu.chathand'&&value.kind==='setup-skill';
  return {installed,managed:true};
 }catch{return {installed:false,managed:false};}
}
export function removeSetupSkill({codexHome=base()}={}){
 if(!setupSkillStatus({codexHome}).installed)return {removed:false};
 const backups=path.join(codexHome,'skill-backups');fs.mkdirSync(backups,{recursive:true});
 fs.renameSync(path.join(codexHome,'skills/chathand-setup'),path.join(backups,'chathand-setup-removed-'+crypto.randomUUID()));
 return {removed:true,recoverable:true};
}
