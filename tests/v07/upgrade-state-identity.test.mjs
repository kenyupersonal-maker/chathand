import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {upgradeTransaction,recoverUpgrade} from '../../app/v07/upgrade-transaction.mjs';
import {InstallationPilot} from '../../app/v1/installation-pilot.mjs';

function fixture(t){
 const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-upgrade-identity-')));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const f={base,candidate:path.join(base,'candidate.app'),destination:path.join(base,'installed.app'),stateDir:path.join(base,'state'),backupRoot:path.join(base,'upgrades')};
 for(const dir of [f.candidate,f.destination,f.stateDir])fs.mkdirSync(dir,{mode:0o700});
 fs.writeFileSync(path.join(f.candidate,'version'),'new');fs.writeFileSync(path.join(f.destination,'version'),'old');fs.writeFileSync(path.join(f.stateDir,'desktop.json'),'old settings');
 new InstallationPilot(f.stateDir);
 f.identity=fs.readFileSync(path.join(f.stateDir,'installation-1049.json'));f.stat=fs.statSync(f.stateDir);
 f.hooks={validate:async()=>{},stop:async()=>{},start:async()=>{},verify:async()=>{throw Error('SETTING_NOT_RETAINED_BROWSER');},resume:async()=>{f.resumes=(f.resumes||0)+1;const pilot=new InstallationPilot(f.stateDir);assert.equal(pilot.data.installation_scope===pilot.scope,true,'old installation remains in its original scope');}};
 return f;
}
function journal(f){return JSON.parse(fs.readFileSync(path.join(f.backupRoot,'current.json'),'utf8'));}
function unchangedIdentity(f){const stat=fs.statSync(f.stateDir);assert.equal(stat.dev,f.stat.dev);assert.equal(stat.ino,f.stat.ino);assert.deepEqual(fs.readFileSync(path.join(f.stateDir,'installation-1049.json')),f.identity);}
function interrupted(f){
 const transaction=path.join(f.backupRoot,'interrupted'),stateBackup=path.join(transaction,'state-backup'),appBackup=path.join(transaction,'previous.app'),stage=path.join(f.base,'stage.app');
 fs.mkdirSync(transaction,{recursive:true,mode:0o700});fs.cpSync(f.stateDir,stateBackup,{recursive:true});fs.renameSync(f.destination,appBackup);fs.renameSync(f.candidate,f.destination);
 const j={format:1,id:'interrupted',phase:'new_installed',stateDir:f.stateDir,destination:f.destination,candidate:f.candidate,stage,appBackup,stateBackup,hadApp:true,hadState:true,stateBackupComplete:true,stop_attempted:true,new_app_installed:true};
 fs.writeFileSync(path.join(f.backupRoot,'current.json'),JSON.stringify(j));return {transaction,j};
}

test('failed verification restores settings and original installation bytes without changing the state root',async t=>{
 const f=fixture(t);f.hooks.migrate=async()=>{fs.writeFileSync(path.join(f.stateDir,'desktop.json'),'failed candidate settings');fs.writeFileSync(path.join(f.stateDir,'candidate-only'),'failure evidence');};
 const outcome=await upgradeTransaction(f);assert.equal(outcome.status,'ROLLED_BACK');assert.equal(outcome.error_code,'SETTING_NOT_RETAINED_BROWSER');assert.equal(f.resumes,1);unchangedIdentity(f);
 assert.equal(fs.readFileSync(path.join(f.stateDir,'desktop.json'),'utf8'),'old settings');assert.equal(fs.readFileSync(path.join(outcome.transaction,'failed-state/desktop.json'),'utf8'),'failed candidate settings');assert.equal(fs.readFileSync(path.join(outcome.transaction,'failed-state/candidate-only'),'utf8'),'failure evidence');assert.equal(fs.readFileSync(path.join(f.destination,'version'),'utf8'),'old');
 const copy=path.join(f.base,'unrelated-copy');fs.cpSync(f.stateDir,copy,{recursive:true});const copied=new InstallationPilot(copy);assert.equal(copied.data.installation_scope===copied.scope,false,'arbitrary copies still fail the unchanged scope guard');
});

test('interrupted recovery preserves the same inode, private identity and earlier failure evidence',async t=>{
 const f=fixture(t),{transaction}=interrupted(f);fs.mkdirSync(path.join(transaction,'interrupted-state'));fs.writeFileSync(path.join(transaction,'interrupted-state/previous'),'earlier evidence');fs.writeFileSync(path.join(f.stateDir,'desktop.json'),'interrupted settings');
 const result=await recoverUpgrade({backupRoot:f.backupRoot,hooks:f.hooks});assert.equal(result.status,'ROLLED_BACK_AFTER_INTERRUPTION');unchangedIdentity(f);assert.equal(f.resumes,1);assert.equal(fs.readFileSync(path.join(f.stateDir,'desktop.json'),'utf8'),'old settings');assert.equal(fs.readFileSync(path.join(transaction,'interrupted-state/previous'),'utf8'),'earlier evidence');assert.equal(fs.readFileSync(path.join(transaction,'interrupted-state.1/desktop.json'),'utf8'),'interrupted settings');
});

test('partial restore copy failure retains root, backup and candidate evidence, then recovery can retry',async t=>{
 const f=fixture(t),original=fs.cpSync;f.hooks.migrate=async()=>fs.writeFileSync(path.join(f.stateDir,'desktop.json'),'failed candidate settings');
 fs.cpSync=(from,to,options)=>{if(to===f.stateDir&&path.basename(from)==='state-backup'){fs.writeFileSync(path.join(to,'partial-restore'),'partial bytes');throw Object.assign(Error('INJECTED_RESTORE_COPY'),{code:'ENOSPC'});}return original(from,to,options);};
 try{await assert.rejects(()=>upgradeTransaction(f),{code:'ROLLBACK_FAILED'});}finally{fs.cpSync=original;}
 const j=journal(f);assert.equal(j.phase,'rollback_failed');assert.equal(j.rollback_error,'ENOSPC');assert.equal(fs.statSync(f.stateDir).ino,f.stat.ino);assert.equal(f.resumes,undefined);assert.deepEqual(fs.readFileSync(path.join(j.stateBackup,'installation-1049.json')),f.identity);assert.equal(fs.readFileSync(path.join(path.dirname(j.appBackup),'failed-state/desktop.json'),'utf8'),'failed candidate settings');
 const result=await recoverUpgrade({backupRoot:f.backupRoot,hooks:f.hooks});assert.equal(result.status,'ROLLED_BACK_AFTER_INTERRUPTION');unchangedIdentity(f);assert.equal(fs.readFileSync(path.join(path.dirname(j.appBackup),'interrupted-state/partial-restore'),'utf8'),'partial bytes');
});

test('partial contents move failure never deletes evidence and recovery can finish in the original root',async t=>{
 const f=fixture(t),original=fs.renameSync;fs.writeFileSync(path.join(f.stateDir,'z-last'),'last entry');
 fs.renameSync=(from,to)=>{if(from===path.join(f.stateDir,'z-last')&&path.basename(path.dirname(to)).startsWith('failed-state'))throw Object.assign(Error('INJECTED_RESTORE_MOVE'),{code:'EACCES'});return original(from,to);};
 try{await assert.rejects(()=>upgradeTransaction(f),{code:'ROLLBACK_FAILED'});}finally{fs.renameSync=original;}
 const j=journal(f);assert.equal(j.rollback_error,'EACCES');assert.equal(fs.statSync(f.stateDir).ino,f.stat.ino);assert.equal(fs.readFileSync(path.join(f.stateDir,'z-last'),'utf8'),'last entry');assert.deepEqual(fs.readFileSync(path.join(path.dirname(j.appBackup),'failed-state/installation-1049.json')),f.identity);assert.equal(f.resumes,undefined);
 assert.equal((await recoverUpgrade({backupRoot:f.backupRoot,hooks:f.hooks})).status,'ROLLED_BACK_AFTER_INTERRUPTION');unchangedIdentity(f);
});

for(const kind of ['symlink-state','symlink-backup','overlapping-backup','missing-root'])test('recovery refuses '+kind+' without moving the surviving state contents',async t=>{
 const f=fixture(t),{transaction,j}=interrupted(f),originalRoot=f.stateDir;
 if(kind==='symlink-state'){fs.renameSync(f.stateDir,f.stateDir+'-real');fs.symlinkSync(f.stateDir+'-real',f.stateDir);}
 if(kind==='symlink-backup'){fs.renameSync(j.stateBackup,j.stateBackup+'-real');fs.symlinkSync(j.stateBackup+'-real',j.stateBackup);}
 if(kind==='overlapping-backup'){
  // The journal passes its transaction-parent checks, but tries to archive a
  // state root containing the transaction/backup itself. Reject before moving.
  j.stateDir=f.base;fs.writeFileSync(path.join(f.backupRoot,'current.json'),JSON.stringify(j));
 }
 if(kind==='missing-root')fs.renameSync(f.stateDir,f.stateDir+'-retained');
 await assert.rejects(()=>recoverUpgrade({backupRoot:f.backupRoot,hooks:f.hooks}));assert.equal(f.resumes,undefined);
 const retained=kind==='symlink-state'?originalRoot+'-real':kind==='missing-root'?originalRoot+'-retained':originalRoot;
 assert.deepEqual(fs.readFileSync(path.join(retained,'installation-1049.json')),f.identity);assert.equal(fs.readFileSync(path.join(retained,'desktop.json'),'utf8'),'old settings');assert.equal(fs.existsSync(path.join(transaction,'interrupted-state')),false);
});
