import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {UpgradeGuard,armUpgradeGuard} from '../../app/v08/upgrade-guard.mjs';
import {Updater} from '../../app/v1/update.mjs';
import {reconcileStartupUpgrade} from '../../app/v1/upgrade-startup.mjs';
import {createDesktop} from '../../app/server.mjs';
import {DesktopState} from '../../app/state.mjs';
import {manifest,VERSION} from '../../app/product.mjs';
import {TOOLS} from '../../app/tools.mjs';
import {SIGNING_IDENTITY} from '../../scripts/signing.mjs';
import {recoverUpgrade,upgradeTransaction} from '../../app/v07/upgrade-transaction.mjs';
import {ToolListProof} from '../../app/v1/tool-list-proof.mjs';

const pkg=JSON.parse(fs.readFileSync(new URL('../../package.json',import.meta.url))),build=pkg.kenBridge.build_number;
const contract=manifest(TOOLS),oldVersion='1.0.0-beta.5',oldBuild=1054;
function put(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));}
function fixture(t,{phase='rollback_failed',markerBuild=false,candidate=true}={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1056-upgrade-'))),stateDir=path.join(root,'state'),home=path.join(root,'upgrades'),app=path.join(root,'ChatHand.app'),id='2026-10-17T00-00-00-000Z-123456ab',transaction=path.join(home,id),candidatePath=path.join(home,'staging/local-1054/ChatHand.app');
 fs.mkdirSync(stateDir,{recursive:true});fs.mkdirSync(home,{recursive:true});
 put(path.join(app,'Contents/Resources/runtime/package.json'),pkg);put(path.join(app,`Contents/Resources/runtime/contracts/tools-v${pkg.kenBridge.connector_api}.json`),TOOLS);fs.writeFileSync(path.join(app,'Contents/Info.plist'),'synthetic plist');
 if(candidate)put(path.join(candidatePath,'Contents/Resources/runtime/package.json'),{version:oldVersion,kenBridge:{build_number:oldBuild,bundle_id:'com.kenyu.chathand'}});
 const journal={format:1,id,phase,candidate:candidatePath,destination:app,stateDir,appBackup:path.join(transaction,'previous.app'),stateBackup:path.join(transaction,'state-backup'),created:'2026-10-17T00:00:00Z'};
 put(path.join(home,'current.json'),journal);put(path.join(transaction,'journal.json'),journal);
 armUpgradeGuard(stateDir,oldVersion,'old-guard',{adminEnabled:true,...(markerBuild?{build:oldBuild,transactionId:id}:{})});
 put(path.join(stateDir,'update-ai.json'),{at:Date.now()-10000,from:{version:'1.0.0-beta.4',build:1053},to:{version:oldVersion,build:oldBuild}});
 // Legacy runner used the short plist version and dropped build_to.
 put(path.join(stateDir,'update-pending.json'),{from:'1.0.0-beta.4',to:'1.0.0'});
 const resultFile=path.join(stateDir,'update-result.json');put(resultFile,{status:'ROLLBACK_FAILED',to:oldVersion,time:'2026-10-17T00:00:00Z'});const failure=fs.readFileSync(resultFile,'utf8'),journalBytes=fs.readFileSync(path.join(home,'current.json'),'utf8');
 const guard=new UpgradeGuard(stateDir,VERSION),calls=[],admin=[];
 const f={root,stateDir,home,app,guard,calls,admin,journal,failure,journalBytes,badSignature:false,badSigner:false,badPlist:false};
 const exec=async(program,args)=>{
  calls.push({program,args});
  if(program==='/usr/bin/codesign'){
   if(f.badSignature&&args.includes('--deep'))throw Error('synthetic signature failure');
   if(args[0]==='-d')return {stderr:`designated => identifier "com.kenyu.chathand" and certificate leaf = H"${f.badSigner?'wrong':SIGNING_IDENTITY}"\n`};
   return {stdout:''};
  }
  if(program==='/usr/libexec/PlistBuddy')return {stdout:args[1].includes('Identifier')?'com.kenyu.chathand':args[1].includes('ShortVersion')?VERSION.split('-')[0]:String(f.badPlist?build+1:build)};
  throw Error('EXTERNAL_COMMAND_FORBIDDEN');
 };
 f.make=extra=>new Updater({stateDir,upgradeHome:home,downloadsDir:path.join(root,'Downloads'),currentAppPath:app,version:VERSION,build,schemaSha:contract.schema_sha256,liveContract:contract,guard,exec,installerActive:async()=>false,finishUpgrade:proof=>{const out=guard.supersede(proof);admin.push('reconcile');return out;},...extra});
 f.exec=exec;f.updater=f.make();
 t.after(async()=>{await f.desktop?.close();f.updater.close();fs.rmSync(root,{recursive:true,force:true});});return f;
}

test('legacy version-only failed guard is superseded on verified newer startup; original failure and journal remain history',async t=>{
 const f=fixture(t);assert.equal((await f.updater.reconcileStartup()).reconciled,true);
 assert.equal(f.guard.inspect().active,false);assert.equal(f.guard.inspect().outcome,'superseded');assert.equal(f.guard.inspect().build,oldBuild);assert.deepEqual(f.admin,['reconcile']);
 assert.equal(fs.readFileSync(f.updater.resultFile,'utf8'),f.failure);assert.equal(JSON.parse(fs.readFileSync(path.join(f.home,'current.json'))).phase,'superseded');assert.equal(fs.readFileSync(path.join(f.home,f.journal.id,'journal.json'),'utf8'),f.journalBytes);
 assert.equal(f.updater.aiStatus().phase,'updated');assert.equal(f.updater.snapshot().install.state,'idle');assert.deepEqual(f.updater.aiStatus().target,{version:VERSION,build});
 const restart=f.make();t.after(()=>restart.close());restart._readResult();assert.equal(restart.aiStatus().phase,'updated');assert.equal(restart.snapshot().install.state,'idle');f.updater.ack();assert.equal(fs.readFileSync(f.updater.resultFile,'utf8'),f.failure);assert.equal(f.updater.snapshot().just_updated,null);assert.equal(f.updater.aiStatus().phase,'updated');assert.equal(f.updater.snapshot().just_updated,null);
 assert.ok(f.calls.some(x=>x.program==='/usr/bin/codesign'&&x.args.includes('--deep')));assert.ok(f.calls.some(x=>x.args.some(a=>a.startsWith('-R='))));
});
test('legacy missing candidate uses journal-associated matching AI and short-version pending metadata',async t=>{const f=fixture(t,{candidate:false});assert.equal((await f.updater.reconcileStartup()).reconciled,true);});
for(const phase of ['verifying','new_installed','rollback_failed'])test('dead interrupted '+phase+' journal does not permanently block newer verified installation',async t=>{const f=fixture(t,{phase});assert.equal((await f.updater.reconcileStartup()).reconciled,true);});
for(const [name,change] of [
 ['signature',f=>{f.badSignature=true;}],['signer',f=>{f.badSigner=true;}],['plist build',f=>{f.badPlist=true;}],
 ['future build',f=>{put(path.join(f.journal.candidate,'Contents/Resources/runtime/package.json'),{version:oldVersion,kenBridge:{build_number:build+1,bundle_id:'com.kenyu.chathand'}});}],
 ['active installer',f=>{f.updater.installerActive=async()=>true;}],['live lock',f=>put(path.join(f.home,'install.lock/owner.json'),{pid:process.pid})],
 ['conflicting old metadata',f=>put(path.join(f.stateDir,'update-ai.json'),{at:Date.now()-10000,to:{version:oldVersion,build:9999}})],
 ['unknown old build',f=>{fs.rmSync(f.journal.candidate,{recursive:true});put(path.join(f.stateDir,'update-ai.json'),{});}],
 ['contract',f=>{f.updater.liveContract={...contract,tool_count:82};}]
])test(name+' keeps the upgrade gate active with a usable manual instruction',async t=>{const f=fixture(t);change(f);assert.equal((await f.updater.reconcileStartup()).reconciled,false);assert.equal(f.guard.inspect().active,true);if(['active installer','live lock'].includes(name)){assert.equal(f.updater.value.install.state,'verifying');assert.equal(f.updater.value.install.code,'UPGRADE_STILL_RUNNING');assert.doesNotMatch(f.updater.value.install.message,/重新拖入/);}else assert.match(f.updater.value.install.message,/重新拖入/);assert.equal(fs.readFileSync(f.updater.resultFile,'utf8'),f.failure);});
test('superseded journal is terminal for recovery and permits a later normal transaction',async t=>{const f=fixture(t);await f.updater.reconcileStartup();assert.equal((await recoverUpgrade({backupRoot:f.home,hooks:{stop(){throw Error('must not stop current app');}}})).status,'NOTHING_TO_RECOVER');const nextCandidate=path.join(f.root,'Next.app');fs.mkdirSync(nextCandidate);fs.writeFileSync(path.join(nextCandidate,'proof'),'next');const out=await upgradeTransaction({candidate:nextCandidate,destination:f.app,stateDir:f.stateDir,backupRoot:f.home,hooks:{validate:async()=>{},stop:async()=>{},start:async()=>{},verify:async()=>({}),commit:async()=>{}}});assert.equal(out.status,'COMMITTED');assert.equal(fs.readFileSync(path.join(f.home,f.journal.id,'journal.json'),'utf8'),f.journalBytes);});

test('same build is never superseded, dead lock is reclaimed, and marker changes during verification are rejected',async t=>{
 const f=fixture(t);const verify=async()=>({verified:true,version:VERSION,build,schema_sha256:contract.schema_sha256});
 await assert.rejects(()=>reconcileStartupUpgrade({guard:f.guard,stateDir:f.stateDir,home:f.home,app:f.app,version:VERSION,build:oldBuild,verifyCurrent:verify,finish:p=>f.guard.supersede(p)}),/重新拖入/);
 put(path.join(f.home,'install.lock/owner.json'),{pid:99999999});
 await assert.rejects(()=>reconcileStartupUpgrade({guard:f.guard,stateDir:f.stateDir,home:f.home,app:f.app,version:VERSION,build,alive:()=>false,verifyCurrent:async()=>{armUpgradeGuard(f.stateDir,oldVersion,'changed');return verify();},finish:p=>f.guard.supersede(p)}));assert.equal(f.guard.inspect().active,true);
});
for(const enabled of [true,false])test('real createDesktop startup wires owner reconciliation and preserves user access intent='+enabled,async t=>{
 const f=fixture(t),state=new DesktopState(f.stateDir,{defaultRoot:path.join(f.root,'work')});state.data.access_enabled=enabled;state.data.connection_preference='none';state.data.auto_connect=false;state.data.high_risk={admin:false};state.save();let reconciles=0;
 const app=await createDesktop({stateDir:f.stateDir,defaultRoot:path.join(f.root,'work'),uiKey:'f'.repeat(64),adminAccess:{supported:()=>true,ready:()=>true,uninstall(){reconciles++;return {}; }},clientDeps:{currentAppPath:f.app,computerName:()=> 'Synthetic Mac',tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),updaterFactory:deps=>new Updater({...deps,upgradeHome:f.home,exec:f.exec,installerActive:async()=>false,aiDelayMs:60000}),toolsRefreshFactory:()=>({snapshot:()=>({state:'idle'}),run:async()=>{throw Error("UNEXPECTED_TOOLS_REFRESH_RUN");},clickByNumber:async()=>{throw Error("UNEXPECTED_TOOLS_REFRESH_CLICK");}})}});
 f.desktop=app;assert.equal(app.tools.upgradePending,false,JSON.stringify(app.tools.updater.value.install));assert.equal(app.tools.updater.aiStatus().phase,'updated');assert.equal(app.tools.state.data.access_enabled,enabled);assert.equal(app.tools.policy.enabled,enabled);assert.equal(app.tools.state.data.high_risk.admin,false);assert.equal(reconciles,1);assert.equal((await app.snapshot()).update.install.state,'idle');
 if(enabled){const source=await app.tools.invoke('begin_task',{request_id:'install_source_1056',title:'安装并导入76条待办'},'chatgpt');const u=app.tools.updater;u.latest={source:'local',version:VERSION,build:build+1,task_id:source.task_id};u.value.status='available';const started=await app.tools.invoke('install_update',{task_id:source.task_id,build:build+1},'chatgpt');assert.equal(app.tools.policy.get(source.task_id,'chatgpt').status,'active');assert.equal(app.tools.policy.get(started.installation_task.task_id,'chatgpt').status,'installing');assert.equal(app.tools.policy.receipts.read(started.installation_task.task_id),null);assert.doesNotMatch(started.installation_task.title,/导入/);assert.equal((await app.snapshot()).tasks.find(t=>t.task_id===started.installation_task.task_id).status,'installing');}
});
test('tool-list absence is unknown; only a schema mismatch asserts old tools; connection checks never create proof',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1056-tools-'));t.after(()=>fs.rmSync(root,{recursive:true}));const proof=new ToolListProof(root),identity='a'.repeat(24),args={identity,currentSchema:contract.schema_sha256,build};assert.equal(proof.status(args).state,'unknown');assert.doesNotMatch(proof.status(args).message,/还是旧工具/);
 proof.record({identity,at:Date.now(),schema_sha256:contract.schema_sha256,build:build-1});assert.equal(proof.status(args).state,'current');proof.record({identity,at:Date.now(),schema_sha256:'0'.repeat(64),build});assert.equal(proof.status(args).state,'stale');assert.equal(proof.status({...args,identity:'b'.repeat(24)}).state,'unknown');
});

test('installer process observation is scoped to this destination or this product staging, never a foreign fixture',async t=>{const f=fixture(t);let output='';const u=f.make({installerActive:null,exec:async()=>({stdout:output})});t.after(()=>u.close());output=`100 /tmp/foreign/bin/node /tmp/foreign/scripts/upgrade.mjs --install /tmp/package --destination /tmp/Other.app --result /tmp/result`;assert.equal(await u._installerActive(),false);output=`101 /tmp/node /tmp/scripts/upgrade.mjs --install /tmp/package --destination ${f.app} --result /tmp/result`;assert.equal(await u._installerActive(),true);output=`102 /tmp/node /tmp/scripts/upgrade.mjs --recover /tmp/foreign`;assert.equal(await u._installerActive(),false);output=`103 /tmp/node ${f.home}/staging/local-1054/ChatHand.app/Contents/Resources/runtime/scripts/upgrade.mjs --recover ${f.home}/staging/local-1054`;assert.equal(await u._installerActive(),true);});

for(const succeeds of [true,false])test('live installer exit retries startup reconciliation and reaches '+(succeeds?'verified completion':'a guarded real failure'),async t=>{
 const f=fixture(t);let active=true;f.updater.installerActive=async()=>active;
 if(!succeeds)f.badSignature=true;
 await f.updater.reconcileStartup();assert.equal(f.updater.value.install.state,'verifying');assert.ok(f.updater.startupRetryTimer);
 active=false;const end=Date.now()+3000;while(Date.now()<end&&f.updater.value.install.state==='verifying')await new Promise(r=>setTimeout(r,25));
 assert.equal(f.updater.value.install.state,succeeds?'idle':'failed');assert.equal(f.guard.inspect().active,!succeeds);assert.equal(f.updater.startupRetryTimer,null);
 if(!succeeds)assert.match(f.updater.value.install.message,/重新拖入/);assert.equal(fs.readFileSync(f.updater.resultFile,'utf8'),f.failure);
});
test('closing updater cancels startup retry without weakening the guard',async t=>{const f=fixture(t);f.updater.installerActive=async()=>true;await f.updater.reconcileStartup();assert.ok(f.updater.startupRetryTimer);f.updater.close();assert.equal(f.updater.startupRetryTimer,null);assert.equal(f.guard.inspect().active,true);});

test('same-build interrupted installer exits verifying with the original guard still active',async t=>{const f=fixture(t);let active=true;f.updater.installerActive=async()=>active;f.updater.currentBuild=oldBuild;await f.updater.reconcileStartup();assert.equal(f.updater.value.install.state,'verifying');active=false;const end=Date.now()+3000;while(Date.now()<end&&f.updater.value.install.state==='verifying')await new Promise(r=>setTimeout(r,25));assert.equal(f.updater.value.install.state,'failed');assert.equal(f.updater.value.install.code,'UPGRADE_NOT_SUPERSEDED');assert.equal(f.guard.inspect().active,true);assert.equal(f.updater.startupRetryTimer,null);});
