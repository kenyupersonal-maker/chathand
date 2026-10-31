import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {saveJSON,privateDir} from '../../engine/src/core.mjs';

const exists=p=>fs.existsSync(p);
const ordinary=(p,optional=false)=>{
  if(!exists(p)&&optional)return;
  if(fs.lstatSync(p).isSymbolicLink()||!fs.statSync(p).isDirectory())throw Error('UNSAFE_UPGRADE_PATH');
};

function copyState(from,to){
  privateDir(to);
  fs.cpSync(from,to,{recursive:true,dereference:false,verbatimSymlinks:true,filter:p=>!['runtime.json','app.lock','launcher.log'].includes(path.relative(from,p))});
}

function moveAside(from,to){
  if(!exists(from))return;
  let target=to,index=0;
  while(exists(target))target=`${to}.${++index}`;
  fs.renameSync(from,target);
  return target;
}

function restoreState(journal,transaction,suffix){
  if(journal.stateBackupComplete){
    ordinary(journal.stateBackup);
    if(!exists(journal.stateDir))throw Error('UPGRADE_STATE_ROOT_MISSING');
    ordinary(journal.stateDir);ordinary(transaction);
    const state=fs.realpathSync(journal.stateDir),backup=fs.realpathSync(journal.stateBackup),owner=fs.realpathSync(transaction);
    const overlaps=(a,b)=>a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep);
    if(state===path.parse(state).root||path.dirname(backup)!==owner||overlaps(state,backup)||overlaps(state,owner))throw Error('UNSAFE_UPGRADE_PATH');
    // Installation authority includes the state directory's inode. Restore its
    // contents in place; never turn the installation into a copied directory.
    let evidence=path.join(transaction,suffix),index=0;
    while(exists(evidence))evidence=path.join(transaction,`${suffix}.${++index}`);
    fs.mkdirSync(evidence,{mode:0o700});
    for(const name of fs.readdirSync(journal.stateDir).sort()){
      fs.renameSync(path.join(journal.stateDir,name),path.join(evidence,name));
    }
    // A move/copy failure leaves the original root, backup and every moved
    // entry available for a later recovery attempt, without claiming resume.
    copyState(journal.stateBackup,journal.stateDir);
  }else if(!journal.hadState&&exists(journal.stateDir)){
    moveAside(journal.stateDir,path.join(transaction,suffix));
  }
}

async function resumeOld(hooks,destination,hadApp){
  if(!hadApp)return;
  if(typeof hooks.resume==='function')await hooks.resume(destination);
  else await hooks.start(destination,false);
}

function lockUpgrade(root){
  const dir=path.join(root,'install.lock');
  try{fs.mkdirSync(dir,{mode:0o700});}
  catch(e){if(e.code==='EEXIST')throw Error('UPGRADE_IN_PROGRESS_OR_INTERRUPTED');throw e;}
  saveJSON(path.join(dir,'owner.json'),{pid:process.pid});
  return ()=>fs.rmSync(dir,{recursive:true,force:true});
}

const recoverableStopPhases=new Set(['stop_attempted','old_stopped','state_backed_up','migration_attempted','migrated','old_app_move_attempted','old_moved','new_installed','verifying']);

/** Rollback covers app + private state, never the user's project folders. Hooks own native lifecycle. */
export async function upgradeTransaction({candidate,destination,stateDir,backupRoot,hooks}){
  ordinary(candidate);
  ordinary(destination,true);
  ordinary(stateDir,true);
  privateDir(backupRoot);
  ordinary(backupRoot);
  const unlock=lockUpgrade(backupRoot);
  try{
    const journalFile=path.join(backupRoot,'current.json');
    if(exists(journalFile)){
      const prior=JSON.parse(fs.readFileSync(journalFile));
      if(!['committed','rolled_back','aborted','superseded'].includes(prior.phase))throw Error('UPGRADE_RECOVERY_REQUIRED');
    }
    const id=new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID().slice(0,8);
    const transaction=path.join(backupRoot,id);
    privateDir(transaction);
    const stage=path.join(path.dirname(destination),'.ken-bridge-upgrade-'+id+'.app');
    const appBackup=path.join(transaction,'previous.app');
    const stateBackup=path.join(transaction,'state-backup');
    const journal={
      format:1,id,phase:'preparing',candidate,destination,stateDir,stage,appBackup,stateBackup,
      hadApp:exists(destination),hadState:exists(stateDir),stateBackupComplete:false,
      stop_attempted:false,old_stopped:false,migration_attempted:false,
      old_app_move_attempted:false,new_app_installed:false,created:new Date().toISOString()
    };
    const record=phase=>{journal.phase=phase;saveJSON(journalFile,journal);saveJSON(path.join(transaction,'journal.json'),journal);};
    let stopped=false;
    try{
      await hooks.validate(candidate);
      fs.cpSync(candidate,stage,{recursive:true,dereference:false,verbatimSymlinks:true});
      await hooks.validate(stage);
      record('staged');

      // Persist this marker before invoking stop. If the process dies or stop
      // throws after a side effect, recovery must not assume the old app ran.
      journal.stop_attempted=true;
      record('stop_attempted');
      await hooks.stop(destination);
      stopped=true;
      journal.old_stopped=true;
      record('old_stopped');

      if(journal.hadState){
        copyState(stateDir,stateBackup);
        journal.stateBackupComplete=true;
      }
      record('state_backed_up');

      journal.migration_attempted=true;
      record('migration_attempted');
      await hooks.migrate?.(stateDir);
      record('migrated');

      if(journal.hadApp){
        journal.old_app_move_attempted=true;
        record('old_app_move_attempted');
        fs.renameSync(destination,appBackup);
      }
      record('old_moved');
      fs.renameSync(stage,destination);
      journal.new_app_installed=true;
      record('new_installed');
      await hooks.start(destination,true);
      record('verifying');
      const verification=await hooks.verify(destination,stateDir);
      await hooks.commit?.(verification);
      record('committed');
      return {status:'COMMITTED',transaction,retained_state:true,backup_available:journal.hadApp};
    }catch(error){
      journal.error_code=error.code||error.message||'UPGRADE_FAILED';
      const oldAppMoved=exists(appBackup);
      const newAppInstalled=journal.new_app_installed||(
        journal.hadApp&&oldAppMoved&&exists(destination)
      )||(
        !journal.hadApp&&journal.phase==='new_installed'&&exists(destination)
      );

      if(!journal.stop_attempted){
        if(exists(stage))fs.rmSync(stage,{recursive:true,force:true});
        record('aborted');
        throw error;
      }

      // No app rename/install has happened. The old path and state remain the
      // source of truth. If stop itself failed, confirm stop once more before
      // restarting; starting immediately could create a duplicate instance.
      if(!oldAppMoved&&!newAppInstalled){
        if(!stopped){
          let recoveryError;
          try{
            await hooks.stop(destination);
            await resumeOld(hooks,destination,journal.hadApp);
          }catch(e){recoveryError=e;}
          if(recoveryError){
            journal.rollback_error=recoveryError.code||recoveryError.message;
            record('rollback_failed');
            throw Object.assign(Error('ROLLBACK_REQUIRES_LOCAL_RECOVERY'),{code:'ROLLBACK_FAILED'});
          }
          if(exists(stage))fs.rmSync(stage,{recursive:true,force:true});
          record('aborted');
          throw error;
        }
        try{
          restoreState(journal,transaction,'failed-state');
          if(exists(stage))fs.rmSync(stage,{recursive:true,force:true});
          await resumeOld(hooks,destination,journal.hadApp);
          record('rolled_back');
          return {status:'ROLLED_BACK',transaction,error_code:journal.error_code,retained_state:true};
        }catch(rollback){
          journal.rollback_error=rollback.code||rollback.message;
          record('rollback_failed');
          throw Object.assign(Error('ROLLBACK_REQUIRES_LOCAL_RECOVERY'),{code:'ROLLBACK_FAILED'});
        }
      }

      try{
        if(exists(destination))await hooks.stop(destination);
        if(exists(destination))moveAside(destination,path.join(transaction,'failed.app'));
        if(exists(appBackup))fs.renameSync(appBackup,destination);
        restoreState(journal,transaction,'failed-state');
        if(exists(stage))fs.rmSync(stage,{recursive:true,force:true});
        await resumeOld(hooks,destination,journal.hadApp);
        record('rolled_back');
        return {status:'ROLLED_BACK',transaction,error_code:journal.error_code,retained_state:true};
      }catch(rollback){
        journal.rollback_error=rollback.code||rollback.message;
        record('rollback_failed');
        throw Object.assign(Error('ROLLBACK_REQUIRES_LOCAL_RECOVERY'),{code:'ROLLBACK_FAILED'});
      }
    }
  }finally{unlock();}
}

export async function recoverUpgrade({backupRoot,hooks}){
  const file=path.join(backupRoot,'current.json');
  if(!exists(file))return {status:'NOTHING_TO_RECOVER'};
  const j=JSON.parse(fs.readFileSync(file));
  if(['committed','rolled_back','aborted','superseded'].includes(j.phase))return {status:'NOTHING_TO_RECOVER'};
  if(typeof j.appBackup!=='string'||typeof j.stateBackup!=='string'||typeof j.destination!=='string'||typeof j.stateDir!=='string'||typeof j.stage!=='string')throw Error('INVALID_RECOVERY_JOURNAL');
  const lock=path.join(backupRoot,'install.lock');
  if(exists(lock)){
    const owner=JSON.parse(fs.readFileSync(path.join(lock,'owner.json')));
    let alive=true;
    try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
    if(alive)throw Error('UPGRADE_STILL_RUNNING');
    fs.rmSync(lock,{recursive:true,force:true});
  }
  const transaction=path.dirname(j.appBackup);
  if(!transaction.startsWith(backupRoot+path.sep)||path.dirname(j.stateBackup)!==transaction)throw Error('INVALID_RECOVERY_JOURNAL');
  const unlock=lockUpgrade(backupRoot);
  try{
    // Journals written by the pre-fix transaction have no marker. Infer the
    // marker from their phase so an interrupted old upgrade remains recoverable.
    const stopAttempted=j.stop_attempted===true||recoverableStopPhases.has(j.phase);
    if(!stopAttempted){
      if(exists(j.stage))fs.rmSync(j.stage,{recursive:true,force:true});
      j.phase='aborted';
      saveJSON(file,j);
      return {status:'ABORTED_AFTER_INTERRUPTION'};
    }

    // Confirm the old/new process is stopped before moving either app or state.
    // Before the swap destination still points at the old app, so no app or
    // state replacement occurs until this call succeeds.
    await hooks.stop(j.destination);
    const appBackupExists=exists(j.appBackup);
    if(appBackupExists){
      if(exists(j.destination))moveAside(j.destination,path.join(transaction,'interrupted.app'));
      fs.renameSync(j.appBackup,j.destination);
    }else if((j.new_app_installed||j.phase==='old_moved'||j.phase==='new_installed'||j.phase==='verifying')&&exists(j.destination)&&!j.hadApp){
      moveAside(j.destination,path.join(transaction,'interrupted.app'));
    }
    restoreState(j,transaction,'interrupted-state');
    if(exists(j.stage))fs.rmSync(j.stage,{recursive:true,force:true});
    await resumeOld(hooks,j.destination,j.hadApp);
    j.stop_attempted=true;
    j.phase='rolled_back';
    saveJSON(file,j);
    return {status:'ROLLED_BACK_AFTER_INTERRUPTION'};
  }catch(error){
    j.error_code=error.code||error.message||'RECOVERY_FAILED';
    j.phase='rollback_failed';
    saveJSON(file,j);
    throw error;
  }finally{unlock();}
}
