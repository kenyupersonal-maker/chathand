import {readChromeDistribution,requireLegacyInstaller} from './chrome-distribution.mjs';
import {localText} from '../i18n.mjs';
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {fail} from '../../engine/src/core.mjs';
import {installSource,helperFingerprint,INSTALL_SOURCE_FILES} from './chrome-install-probe.mjs';
export const helperFolder=home=>path.join(home,'Library/Application Support/ChatHand/chrome-helper');
function directories(dir){
 let cursor=path.parse(dir).root;for(const part of dir.slice(cursor.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,part);if(!fs.existsSync(cursor))fs.mkdirSync(cursor,{mode:0o700});const stat=fs.lstatSync(cursor);if(!stat.isDirectory()||stat.isSymbolicLink())fail('INSTALL_SOURCE_CHANGED',localText('chrome.sourceDirectoryInvalid'));}
}
/** Publish only pinned helper files to its own fixed directory; keep the prior copy recoverable. */
export function publishHelper({root,home,guard=()=>{},distribution=readChromeDistribution(root)}){
 requireLegacyInstaller(distribution);guard();const source=installSource(root),target=helperFolder(home),parent=path.dirname(target);directories(parent);guard();
 if(fs.existsSync(target)){
  if(fs.lstatSync(target).isSymbolicLink()||!fs.lstatSync(target).isDirectory())fail('INSTALL_SOURCE_CHANGED',localText('chrome.sourceDirectoryUnknown'));
  const previousFingerprint=helperFingerprint(target,{olderThanBuild:source.build}); // Older signed helper layouts remain replaceable; current layouts require every resource.
  const original=JSON.parse(fs.readFileSync(path.join(source.folder,'manifest.json'))),previous=JSON.parse(fs.readFileSync(path.join(target,'manifest.json')));
  if(typeof original.key!=='string'||original.key!==previous.key||previous.manifest_version!==3)fail('INSTALL_SOURCE_CHANGED',localText('chrome.sourceIdentityChanged'));
  if(previousFingerprint===source.fingerprint){guard();return {folder:target,fingerprint:source.fingerprint,changed:false,backup:null};}
 }
 const stage=fs.mkdtempSync(path.join(parent,'.chrome-helper-staging-'));let backup=null,published=false;
 try{
  for(const name of [...INSTALL_SOURCE_FILES,'vendor/LICENSE.playwright','vendor/README.md','RELEASE_REVIEW.md']){
   guard();const file=path.join(source.folder,name),stat=fs.lstatSync(file);
   if(stat.isSymbolicLink()||!stat.isFile()||stat.size>16*1024*1024||fs.realpathSync(file)!==file)fail('INSTALL_SOURCE_CHANGED',localText('chrome.sourceFileChanged'));
   const destination=path.join(stage,name);fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});fs.copyFileSync(file,destination,fs.constants.COPYFILE_EXCL);fs.chmodSync(destination,0o600);
  }
  if(helperFingerprint(stage)!==source.fingerprint||installSource(root).fingerprint!==source.fingerprint)fail('INSTALL_SOURCE_CHANGED',localText('chrome.sourceCopyChanged'));guard();
  if(fs.existsSync(target)){backup=path.join(parent,'_chrome-helper-待清理-'+crypto.randomUUID()+'.noindex');fs.renameSync(target,backup);}
  try{guard();fs.renameSync(stage,target);published=true;}catch(e){if(backup&&!fs.existsSync(target))fs.renameSync(backup,target);throw e;}
  guard();if(helperFingerprint(target)!==source.fingerprint)fail('INSTALL_SOURCE_CHANGED',localText('chrome.sourceVerifyFailed'));
  return {folder:target,fingerprint:source.fingerprint,changed:true,backup};
 }finally{if(!published&&fs.existsSync(stage))fs.rmSync(stage,{recursive:true,force:true});}
}
