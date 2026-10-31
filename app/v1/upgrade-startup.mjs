import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {saveJSON} from '../../engine/src/core.mjs';

const error=code=>Object.assign(Error('请将新版本重新拖入「应用程序」并打开。'),{code});
function ordinary(file,dir=false){const s=fs.lstatSync(file);if(s.isSymbolicLink()||!(dir?s.isDirectory():s.isFile()&&s.nlink===1)||!dir&&s.size>256*1024)throw error('UPGRADE_METADATA_INVALID');return s;}
function read(file,optional=false){try{ordinary(file);return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(optional&&e.code==='ENOENT')return null;throw error('UPGRADE_METADATA_INVALID');}}
const within=(root,file)=>typeof file==='string'&&path.isAbsolute(file)&&path.resolve(file).startsWith(path.resolve(root)+path.sep);
function bounded(root,file){if(!within(root,file)||!within(fs.realpathSync(root),fs.realpathSync(file)))throw error('UPGRADE_METADATA_INVALID');return file;}
export function processAlive(pid){if(!Number.isSafeInteger(pid)||pid<2)throw error('UPGRADE_METADATA_INVALID');try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;return true;}}

/** Lock matches the installer. Dead journals remain history, never a forever gate. */
export async function reconcileStartupUpgrade({guard,stateDir,home,app,version,build,verifyCurrent,finish,installerActive=async()=>false,alive=processAlive}) {
 const marker=guard.inspect(),already=marker.phase==='committed'&&marker.outcome==='superseded'&&marker.superseded_by?.version===version&&marker.superseded_by?.build===build;
 if(!marker.active&&!already)return {reconciled:false,reason:'none'};
 if((marker.phase!=='verifying'&&!already)||!Number.isSafeInteger(build)||build<1||!app)throw error('UPGRADE_METADATA_INVALID');
 fs.mkdirSync(home,{recursive:true,mode:0o700});ordinary(home,true);
 const lock=path.join(home,'install.lock');
 if(fs.existsSync(lock)){ordinary(lock,true);const owner=read(path.join(lock,'owner.json'));if(alive(owner.pid))throw error('UPGRADE_STILL_RUNNING');fs.unlinkSync(path.join(lock,'owner.json'));fs.rmdirSync(lock);}
 const token=crypto.randomUUID();try{fs.mkdirSync(lock,{mode:0o700});}catch{throw error('UPGRADE_STILL_RUNNING');}
 saveJSON(path.join(lock,'owner.json'),{pid:process.pid,token});
 try{
  if(await installerActive())throw error('UPGRADE_STILL_RUNNING');
  const journalFile=path.join(home,'current.json'),journal=read(journalFile,true);
  let original=null,oldBuild=Number.isSafeInteger(marker.build)?marker.build:null;
  if(journal){
   if(journal.format!==1||journal.stateDir!==stateDir||journal.destination!==app||typeof journal.id!=='string'||!/^\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9]{8}$/.test(journal.id)||marker.transaction_id&&marker.transaction_id!==journal.id)throw error('UPGRADE_METADATA_INVALID');
   const transaction=path.join(home,journal.id);ordinary(transaction,true);
   if(journal.appBackup!==path.join(transaction,'previous.app')||journal.stateBackup!==path.join(transaction,'state-backup'))throw error('UPGRADE_METADATA_INVALID');
   if(journal.phase==='superseded'&&already&&journal.superseded_guard===marker.id&&journal.superseded_by?.build===build)return {reconciled:false,reason:'already_superseded'};
   const copy=read(bounded(home,path.join(transaction,'journal.json')));
   if(JSON.stringify(copy)!==JSON.stringify(journal))throw error('UPGRADE_METADATA_INVALID');
   // An installer holds install.lock for the entire transaction. Once its owner
   // is dead and this lock is held, even verifying/rollback_failed is interrupted.
   if(!['preparing','staged','stop_attempted','old_stopped','state_backed_up','migration_attempted','migrated','old_app_move_attempted','old_moved','new_installed','verifying','rollback_failed','committed','rolled_back','aborted'].includes(journal.phase))throw error('UPGRADE_METADATA_INVALID');
   original=JSON.stringify(journal);
   const candidate=journal.candidate;
   if(!within(path.join(home,'staging'),candidate))throw error('UPGRADE_METADATA_INVALID');
   let pkg=null;try{pkg=read(bounded(home,path.join(candidate,'Contents/Resources/runtime/package.json')));}catch(e){if(fs.existsSync(candidate))throw e;}
   const ai=read(path.join(stateDir,'update-ai.json'),true),pending=read(path.join(stateDir,'update-pending.json'),true);
   const sources=[];
   if(oldBuild!==null)sources.push(oldBuild);
   if(pkg){if(pkg.version!==marker.version||pkg.kenBridge?.bundle_id!=='com.kenyu.chathand')throw error('UPGRADE_METADATA_INVALID');sources.push(pkg.kenBridge?.build_number);}
   if(ai?.to?.version===marker.version&&Number.isSafeInteger(ai.to.build)&&(!marker.created_at||Number.isFinite(ai.at)&&ai.at<=marker.created_at))sources.push(ai.to.build);
   if((pending?.to===marker.version||pending?.to===marker.version.split('-')[0])&&Number.isSafeInteger(pending.build_to))sources.push(pending.build_to);
   if(!sources.length||sources.some(n=>!Number.isSafeInteger(n)||n<1||n!==sources[0]))throw error('UPGRADE_BUILD_UNKNOWN');
   oldBuild=sources[0];
   if(!pkg&&!(ai?.to?.version===marker.version&&(pending?.to===marker.version||pending?.to===marker.version.split('-')[0])))throw error('UPGRADE_BUILD_UNKNOWN');
  }else if(!marker.transaction_id||oldBuild===null)throw error('UPGRADE_BUILD_UNKNOWN');
  if(!(build>oldBuild))throw error('UPGRADE_NOT_SUPERSEDED');
  const current=await verifyCurrent();
  if(current?.version!==version||current?.build!==build||current?.verified!==true)throw error('UPGRADE_CURRENT_INVALID');
  if(await installerActive()||original!==null&&JSON.stringify(read(journalFile))!==original)throw error('UPGRADE_STILL_RUNNING');
  const result=already?{committed:true,superseded:true,version,build}:await finish({expected:marker,oldBuild,current,transactionId:journal?.id});
  if(journal)saveJSON(journalFile,{...journal,phase:'superseded',superseded_phase:journal.phase,superseded_guard:marker.id,superseded_by:current,superseded_at:Date.now()});
  return {...result,reconciled:true,old_build:oldBuild,current};
 }finally{try{const owner=read(path.join(lock,'owner.json'));if(owner.token===token){fs.unlinkSync(path.join(lock,'owner.json'));fs.rmdirSync(lock);}}catch{}}
}
