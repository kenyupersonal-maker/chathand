import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {pathToFileURL} from 'node:url';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {Updater} from '../app/v1/update.mjs';
import {makeLatestJSON} from '../scripts/make-latest-json.mjs';import {createUpgradeRunner} from '../scripts/upgrade.mjs';
const CURRENT=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url))).version;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),oldSha='a'.repeat(64),newSha='b'.repeat(64);
function fixture(t,{current=CURRENT,direct=true,gh=false,bytes=Buffer.from('isolated signed-app download fixture'),sleep,openURL}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-update-')),stateDir=path.join(dir,'state'),home=path.join(dir,'upgrades'),downloadsDir=path.join(dir,'Downloads'),latestFile=path.join(dir,'latest.json'),calls=[],installs=[];for(const p of [stateDir,downloadsDir])fs.mkdirSync(p,{recursive:true});
 const latest={format:'chathand-latest-v1',version:'9.0.0',build:9999,published_at:'2026-10-02T00:00:00Z',notes:'这一行是更新说明\n保留设置',min_macos:'14.0',tool_schema_sha256:newSha,dmg:{name:'ChatHand-9.0.0.dmg',url:'https://example.invalid/ChatHand-9.0.0.dmg',sha256:hash(bytes),size:bytes.length},release_page:'https://example.invalid/releases/v9.0.0'};fs.writeFileSync(latestFile,JSON.stringify(latest));
 const f={dir,stateDir,home,downloadsDir,latestFile,latest,calls,installs,bytes,gh,direct,busy:false,busyArgs:[],emitted:[],execOverride:null};
 const exec=async(program,args,options)=>{calls.push({program,args,options});if(f.execOverride){const result=await f.execOverride(program,args,options);if(result!==undefined)return result;}
  if(program==='/usr/bin/sw_vers')return {stdout:'15.7.5\n'};
  if(program.endsWith('/gh')){if(!f.gh)throw Object.assign(Error('FAKE_GH_UNAVAILABLE'),{code:'ENOENT'});return {stdout:args[0]==='auth'?'':JSON.stringify(f.latest)};}
  if(program==='/usr/bin/curl')throw Object.assign(Error('FAKE_NETWORK_DISABLED'),{code:22});
  if(program==='/usr/bin/hdiutil'){if(args[0]==='info')return {stdout:'<plist><dict/></plist>'};if(args[0]==='detach')return {stdout:''};const at=args.indexOf('-mountrandom'),volume=path.join(args[at+1],'mounted'),app=path.join(volume,'ChatHand.app'),runtime=path.join(app,'Contents/Resources/runtime');fs.mkdirSync(path.join(runtime,'bin'),{recursive:true});fs.mkdirSync(path.join(runtime,'scripts'));fs.writeFileSync(path.join(runtime,'package.json'),JSON.stringify({version:f.latest.version,kenBridge:{build_number:f.latest.build}}));fs.writeFileSync(path.join(runtime,'bin/node'),'fake-node');fs.writeFileSync(path.join(runtime,'scripts/upgrade.mjs'),'fake-upgrader');fs.writeFileSync(path.join(app,'Contents/Info.plist'),'fake-plist');return {stdout:`<plist><dict><key>mount-point</key><string>${volume}</string></dict></plist>`};}
  if(program==='/usr/bin/ditto'){fs.cpSync(args[0],args[1],{recursive:true});return {stdout:''};}
  if(program==='/usr/bin/codesign')return args[0]==='-d'?{stdout:'',stderr:'designated => identifier "com.kenyu.chathand" and certificate leaf = H"fixture"\n'}:{stdout:''};
  if(program==='/usr/libexec/PlistBuddy')return {stdout:args[1].includes('Identifier')?'com.kenyu.chathand':f.latest.version};
  if(program==='/usr/bin/xattr')return {stdout:''};throw Error('UNEXPECTED_FAKE_COMMAND');
 };
 const fakeSpawn=(program,args,options)=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.unref=()=>{child.unreferenced=true;};child.kill=()=>{queueMicrotask(()=>child.emit('close',null));return true;};calls.push({program,args,options,spawn:true});
  queueMicrotask(()=>{child.emit('spawn');if(program.endsWith('/bin/node')){installs.push({program,args,options,child});return;}if(program==='/usr/bin/curl'){const output=args[args.indexOf('--output')+1];fs.writeFileSync(output,f.bytes);child.stdout.end(f.direct?'200':'404');child.stderr.end();child.emit('close',f.direct?0:22);return;}if(program.endsWith('/gh')){const output=path.join(args[args.indexOf('--dir')+1],f.latest.dmg.name);fs.writeFileSync(output,f.bytes);child.emit('close',0);return;}child.emit('error',Error('UNEXPECTED_FAKE_SPAWN'));});return child;};
 f.updater=new Updater({stateDir,upgradeHome:home,currentAppPath:path.join(dir,'Current.app'),schemaSha:oldSha,version:current,busy:(...args)=>{f.busyArgs.push(args);return f.busy;},emit:(...args)=>f.emitted.push(args),exec,spawn:fakeSpawn,openURL:async url=>{f.opened=url;await openURL?.(f,url);},state:{data:{},save(){f.saved=true;}},env:{CHATHAND_UPDATE_URL:pathToFileURL(latestFile).href},currentSystemProxy:()=>null,downloadsDir,sleep});
 t.after(()=>{f.updater.close();fs.rmSync(dir,{recursive:true,force:true});});return f;
}
async function runInstall(f){await f.updater.check();f.updater.install(f.latest.version);const operation=f.updater.run;await operation.promise;return f.updater.snapshot();}

test('file latest checks versions, notes, schema, bad sources, minimum macOS and release generation',async t=>{
 const f=fixture(t);let status=await f.updater.check();assert.equal(status.status,'available');assert.equal(status.notes,f.latest.notes);assert.equal(status.tool_schema_changed,true);assert.equal(f.updater.dismiss(f.latest.version).dismissed,f.latest.version);assert.equal(f.saved,true);
 f.latest.version=CURRENT;f.latest.build=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url))).kenBridge.build_number;fs.writeFileSync(f.latestFile,JSON.stringify(f.latest));assert.equal((await f.updater.check()).status,'up_to_date');f.latest.version='9.0.0';f.latest.min_macos='99.0';fs.writeFileSync(f.latestFile,JSON.stringify(f.latest));assert.equal((await f.updater.check()).status,'up_to_date');
 fs.writeFileSync(f.latestFile,'not-json');assert.equal((await f.updater.check()).status,'unknown');fs.unlinkSync(f.latestFile);assert.equal((await f.updater.check()).status,'unknown');assert.equal(f.calls.some(c=>c.program==='/usr/bin/curl'&&c.args.includes('--max-time')),true);
 const dmg=path.join(f.dir,'ChatHand-fixture.dmg'),notes=path.join(f.dir,'notes.txt');fs.writeFileSync(dmg,f.bytes);fs.writeFileSync(notes,'发布说明\n第二行');const generated=await makeLatestJSON({dmg,url:f.latest.dmg.url,notes});const data=JSON.parse(fs.readFileSync(generated.file));assert.equal(data.dmg.sha256,hash(f.bytes));assert.equal(data.dmg.size,f.bytes.length);assert.equal(data.notes,'发布说明\n第二行');assert.match(data.tool_schema_sha256,/^[a-f0-9]{64}$/);
});
test('bad SHA refuses installation, removes the download and never launches an upgrader',async t=>{
 const f=fixture(t);f.latest.dmg.sha256='c'.repeat(64);fs.writeFileSync(f.latestFile,JSON.stringify(f.latest));const status=await runInstall(f);assert.equal(status.install.state,'failed');assert.equal(status.install.message,'安装包校验不对，没有安装');assert.equal(f.installs.length,0);assert.equal(fs.existsSync(path.join(f.home,'downloads',f.latest.dmg.name)),false);
 // Signature failure must reject the staged app just as early as an invalid digest.
 const badSigner=fixture(t);badSigner.execOverride=(program,args)=>{if(program==='/usr/bin/codesign'&&args.some(a=>a.startsWith('-R=')))throw Error('FAKE_WRONG_SIGNER');};assert.equal((await runInstall(badSigner)).install.state,'failed');assert.equal(badSigner.installs.length,0);assert.equal(fs.existsSync(path.join(badSigner.home,'staging',badSigner.latest.version)),false);
});
test('busy work waits, then detached installation receives destination/result; cancelling waits is idle',async t=>{
 let release;const gate=new Promise(resolve=>{release=resolve;}),f=fixture(t,{sleep:()=>gate});f.busy=true;await f.updater.check();assert.throws(()=>f.updater.install('8.0.0'),{code:'UPDATE_VERSION_MISMATCH'});assert.equal(f.updater.install(f.latest.version).install.state,'waiting_tasks');const operation=f.updater.run;await new Promise(resolve=>setImmediate(resolve));assert.equal(f.installs.length,0);f.busy=false;release();await operation.promise;
 assert.equal(f.updater.snapshot().install.state,'restarting');assert.equal(f.installs.length,1);const call=f.installs[0];assert.equal(call.options.detached,true);assert.equal(call.child.unreferenced,true);assert.equal(call.args[call.args.indexOf('--destination')+1],path.join(f.dir,'Current.app'));assert.equal(call.args[call.args.indexOf('--result')+1],path.join(f.stateDir,'update-result.json'));assert.equal(call.options.env.CHATHAND_STATE_DIR,f.stateDir);assert.equal(fs.existsSync(path.join(f.home,'staging',f.latest.version,'payload-manifest.json')),true);
 const runner=createUpgradeRunner({packageRoot:path.join(f.home,'staging',f.latest.version),destination:path.join(f.dir,'Current.app'),stateDir:f.stateDir,backupRoot:f.home});assert.equal(typeof runner.hooks.verify,'function');assert.throws(()=>createUpgradeRunner({packageRoot:f.dir,destination:'/tmp/not-an-app',stateDir:f.stateDir,backupRoot:f.home}),/APP_DESTINATION_REQUIRED/);
 const waiting=fixture(t,{sleep:()=>new Promise(()=>{})});waiting.busy=true;await waiting.updater.check();waiting.updater.install(waiting.latest.version);const cancelled=waiting.updater.run;await new Promise(resolve=>setImmediate(resolve));assert.equal(waiting.updater.cancel().install.state,'idle');await cancelled.promise;assert.equal(waiting.installs.length,0);
});
test('browser fallback accepts only a new matching DMG and preserves other Downloads files',async t=>{
 const f=fixture(t,{direct:false,openURL:g=>{fs.writeFileSync(path.join(g.downloadsDir,'Other.dmg'),g.bytes);fs.writeFileSync(path.join(g.downloadsDir,'ChatHand-wrong-size.dmg'),'short');fs.writeFileSync(path.join(g.downloadsDir,'ChatHand (1).dmg'),g.bytes);}});const status=await runInstall(f);assert.equal(status.install.state,'restarting');assert.equal(f.opened,f.latest.dmg.url);assert.equal(f.installs.length,1);assert.deepEqual(fs.readFileSync(path.join(f.downloadsDir,'Other.dmg')),f.bytes);assert.equal(fs.readFileSync(path.join(f.downloadsDir,'ChatHand-wrong-size.dmg'),'utf8'),'short');assert.deepEqual(fs.readFileSync(path.join(f.downloadsDir,'ChatHand (1).dmg')),f.bytes);
 const authenticated=fixture(t,{direct:false,gh:true});assert.equal((await runInstall(authenticated)).install.state,'restarting');assert.equal(authenticated.opened,undefined);assert.equal(authenticated.calls.some(c=>c.spawn&&c.program.endsWith('/gh')&&c.args.includes(`b${authenticated.latest.build}`)),true);
});
test('committed/rolled-back startup results survive until ack; cleanup removes only old unused update files',async t=>{
 const f=fixture(t,{current:'9.0.0'}),pending=path.join(f.stateDir,'update-pending.json'),result=path.join(f.stateDir,'update-result.json');fs.writeFileSync(pending,JSON.stringify({from:'1.0.0-beta.2',to:'9.0.0',schema_from:oldSha}));f.updater.start();assert.equal(f.updater.snapshot().just_updated,null);fs.writeFileSync(result,JSON.stringify({status:'COMMITTED',from:'1.0.0-beta.2',to:'9.0.0',schema_from:newSha}));await new Promise(resolve=>setTimeout(resolve,550));assert.deepEqual(f.updater.snapshot().just_updated,{from:'1.0.0-beta.2',to:'9.0.0',tool_schema_changed:true});assert.deepEqual(f.updater.ack(),{acked:true});assert.equal(fs.existsSync(pending)||fs.existsSync(result),false);assert.equal(f.updater.snapshot().just_updated,null);
 const rollback=fixture(t);fs.writeFileSync(path.join(rollback.stateDir,'update-pending.json'),'{}');fs.writeFileSync(path.join(rollback.stateDir,'update-result.json'),JSON.stringify({status:'ROLLED_BACK',from:'1.0.0-beta.2',to:'9.0.0'}));rollback.updater.start();assert.equal(rollback.updater.snapshot().install.state,'failed');rollback.updater.ack();assert.equal(rollback.updater.snapshot().install.state,'idle');assert.equal(fs.existsSync(path.join(rollback.stateDir,'update-result.json')),false);rollback.updater.close();fs.writeFileSync(path.join(rollback.stateDir,'update-result.json'),JSON.stringify({status:'ROLLBACK_FAILED'}));rollback.updater.start();assert.match(rollback.updater.snapshot().install.message,/还没恢复/);
 for(const dir of ['staging/old','staging/current','downloads','backup-keep'])fs.mkdirSync(path.join(f.home,dir),{recursive:true});const oldPart=path.join(f.home,'downloads','old.part'),complete=path.join(f.home,'downloads','keep.dmg'),journal=path.join(f.home,'current.json');fs.writeFileSync(oldPart,'partial');fs.writeFileSync(complete,'keep');fs.writeFileSync(journal,JSON.stringify({phase:'verifying',candidate:path.join(f.home,'staging/current/ChatHand.app')}));const ago=new Date(Date.now()-2*60*60*1000);for(const file of [oldPart,path.join(f.home,'staging/old'),path.join(f.home,'staging/current')])fs.utimesSync(file,ago,ago);assert.deepEqual(await f.updater.cleanupLeftovers(),{cleaned:2});assert.equal(fs.existsSync(complete)&&fs.existsSync(journal)&&fs.existsSync(path.join(f.home,'backup-keep'))&&fs.existsSync(path.join(f.home,'staging/current')),true);
});

// ---- request_update (build 1018): a build ChatGPT made on this Mac, installed only by the user's click ----
/** A fake locally built ChatHand.app (what scripts/build-v09.mjs would produce) under the fixture directory. */
function localApp(f,{name='built',version='9.0.0',build=9999,bundleId='com.kenyu.chathand',package:withPackage=true}={}){
 const app=path.join(f.dir,name,'ChatHand.app'),runtime=path.join(app,'Contents/Resources/runtime');
 fs.mkdirSync(path.join(runtime,'bin'),{recursive:true});fs.mkdirSync(path.join(runtime,'scripts'),{recursive:true});
 if(withPackage)fs.writeFileSync(path.join(runtime,'package.json'),JSON.stringify({version,kenBridge:{build_number:build,bundle_id:bundleId}}));
 fs.writeFileSync(path.join(runtime,'bin/node'),'fake-node');fs.writeFileSync(path.join(runtime,'scripts/upgrade.mjs'),'fake-upgrader');fs.writeFileSync(path.join(app,'Contents/Info.plist'),'fake-plist');
 return app;
}
const codesignVerify=args=>args[0]==='--verify'&&args.includes('--deep'),codesignRequirement=args=>args[0]==='--verify'&&args.some(a=>a.startsWith('-R='));
async function assertRejectedUnchanged(f,input,code){
 const before=f.updater.snapshot(),beforeAI=f.updater.forAI(),emitted=f.emitted.length;
 await assert.rejects(()=>f.updater.requestLocal(input),{code});
 assert.deepEqual(f.updater.snapshot(),before);assert.deepEqual(f.updater.forAI(),beforeAI);assert.equal(f.updater.local,null);assert.equal(f.emitted.length,emitted);assert.equal(f.updater.run,null);
}
test('requestLocal refuses bad input with the right error code and leaves every state untouched',async t=>{
 const f=fixture(t),good=localApp(f);
 // Not an installed app: development or isolated environments cannot be replaced.
 const real=f.updater.app;f.updater.app=null;await assertRejectedUnchanged(f,{app_path:good},'UPDATE_UNAVAILABLE');f.updater.app=real;
 for(const app_path of [undefined,'',42,'ChatHand.app','./built/ChatHand.app',path.join(f.dir,'built'),path.join(f.dir,'missing','ChatHand.app'),good+'\0'])await assertRejectedUnchanged(f,{app_path},'UPDATE_APP_INVALID');
 // A symbolic link to a good .app, and a plain file called *.app, are not accepted.
 const link=path.join(f.dir,'link.app');fs.symlinkSync(good,link,'dir');await assertRejectedUnchanged(f,{app_path:link},'UPDATE_APP_INVALID');
 const plain=path.join(f.dir,'plain.app');fs.writeFileSync(plain,'not a bundle');await assertRejectedUnchanged(f,{app_path:plain},'UPDATE_APP_INVALID');
 // ChatHand's own upgrade directory, state directory and the running app are never an install source.
 await assertRejectedUnchanged(f,{app_path:localApp({...f,dir:f.home},{name:'inside'})},'UPDATE_APP_INVALID');
 await assertRejectedUnchanged(f,{app_path:localApp({...f,dir:f.stateDir},{name:'inside'})},'UPDATE_APP_INVALID');
 // Wrong identity inside the package: bundle id, version, build number, or missing/unparsable package.json.
 await assertRejectedUnchanged(f,{app_path:localApp(f,{name:'bundle',bundleId:'com.example.other'})},'UPDATE_APP_INVALID');
 await assertRejectedUnchanged(f,{app_path:localApp(f,{name:'nobuild',build:0})},'UPDATE_APP_INVALID');
 await assertRejectedUnchanged(f,{app_path:localApp(f,{name:'badversion',version:'not a version'})},'UPDATE_APP_INVALID');
 await assertRejectedUnchanged(f,{app_path:localApp(f,{name:'nopackage',package:false})},'UPDATE_APP_INVALID');
 // Info.plist disagreeing with the runtime package is caught before any signature work.
 f.execOverride=(program,args)=>{if(program==='/usr/libexec/PlistBuddy'&&args[1].includes('Identifier'))return {stdout:'com.example.other'};};
 await assertRejectedUnchanged(f,{app_path:good},'UPDATE_APP_INVALID');f.execOverride=null;
 f.execOverride=(program,args)=>{if(program==='/usr/libexec/PlistBuddy'&&!args[1].includes('Identifier'))return {stdout:'1.2.3'};};
 await assertRejectedUnchanged(f,{app_path:good},'UPDATE_APP_INVALID');f.execOverride=null;
 // Not newer than the running build: same version and same or lower build, or a lower version.
 await assertRejectedUnchanged(f,{app_path:localApp(f,{name:'same',version:CURRENT,build:f.updater.currentBuild})},'UPDATE_NOT_NEWER');
 await assertRejectedUnchanged(f,{app_path:localApp(f,{name:'lowerbuild',version:CURRENT,build:f.updater.currentBuild-1})},'UPDATE_NOT_NEWER');
 await assertRejectedUnchanged(f,{app_path:localApp(f,{name:'lowerversion',version:'0.0.1',build:99999})},'UPDATE_NOT_NEWER');
 // Signature and signer checks.
 f.execOverride=(program,args)=>{if(program==='/usr/bin/codesign'&&codesignVerify(args))throw Error('FAKE_BAD_SIGNATURE');};
 await assertRejectedUnchanged(f,{app_path:good},'UPDATE_SIGNATURE_INVALID');f.execOverride=null;
 f.execOverride=(program,args)=>{if(program==='/usr/bin/codesign'&&args[0]==='-d')return {stdout:'',stderr:'Executable=/x\n'};};
 await assertRejectedUnchanged(f,{app_path:good},'UPDATE_SIGNER_UNKNOWN');
 f.execOverride=(program,args)=>{if(program==='/usr/bin/codesign'&&args[0]==='-d')return {status:1,stdout:'',stderr:'denied'};};
 await assertRejectedUnchanged(f,{app_path:good},'UPDATE_SIGNER_UNKNOWN');f.execOverride=null;
 f.calls.length=0;f.execOverride=(program,args)=>{if(program==='/usr/bin/codesign'&&codesignRequirement(args))throw Error('FAKE_WRONG_SIGNER');};
 await assertRejectedUnchanged(f,{app_path:good},'UPDATE_SIGNER_MISMATCH');f.execOverride=null;
 // The requirement is read from the app that is running now and checked against the candidate.
 const read=f.calls.find(c=>c.program==='/usr/bin/codesign'&&c.args[0]==='-d'),check=f.calls.find(c=>c.program==='/usr/bin/codesign'&&codesignRequirement(c.args));
 assert.equal(read.args.at(-1),f.updater.app);assert.equal(check.args[1],'-R=identifier "com.kenyu.chathand" and certificate leaf = H"fixture"');assert.equal(check.args.at(-1),fs.realpathSync(good));
 // Another install already running blocks any new request.
 f.updater.value.install={state:'downloading'};await assertRejectedUnchanged(f,{app_path:good},'UPDATE_IN_PROGRESS');f.updater.value.install={state:'idle'};
 // Nothing above was recorded as a request, and nothing touched the network or the disk image tool.
 assert.equal(f.calls.some(c=>c.program==='/usr/bin/hdiutil'||c.program==='/usr/bin/curl'||c.program==='/usr/bin/ditto'||c.spawn),false);assert.equal(f.updater.forAI().request,null);
});
test('requestLocal accepts a good build: available as local, announced once, never installed automatically and kept across checks',async t=>{
 const f=fixture(t),app=localApp(f);f.updater.automaticAllowed=true;f.updater.state.data.auto_update=true;
 const result=await f.updater.requestLocal({app_path:app,note:'  把按钮\n改成蓝色\t',task_id:'task_1',conversation_title:'  修按钮  '});
 assert.equal(result.status,'waiting_user');assert.equal(result.version,'9.0.0');assert.equal(result.build,9999);assert.deepEqual(result.current,{version:CURRENT,build:f.updater.currentBuild});assert.match(result.message_for_user,/接着装/);assert.ok(result.next_steps.some(s=>s.includes('install_update')));assert.equal(result.install_how,'install_update_after_user_agrees'); /* 1027 起 ChatGPT 申请完就自己装 */
 const s=f.updater.snapshot();assert.equal(s.status,'available');assert.equal(s.availability,'available');assert.equal(s.source,'local');assert.equal(s.request_id,'local:9999');assert.equal(s.version,'9.0.0');assert.equal(s.build,9999);assert.equal(s.notes,'把按钮 改成蓝色');assert.equal(s.from_chat,'修按钮');assert.equal(s.request.status,'waiting_user');assert.equal(s.install.state,'idle');
 assert.deepEqual(f.emitted,[['update_requested',{version:'9.0.0',build:9999}]]);
 const ai=f.updater.forAI();assert.equal(ai.status,'available');assert.equal(ai.install_state,'idle');assert.equal(ai.request.status,'waiting_user');assert.equal(ai.just_updated,null);assert.deepEqual(ai.current,{version:CURRENT,build:f.updater.currentBuild});assert.equal(JSON.stringify(ai).includes(app),false,'forAI shows state only, no paths');
 // auto_update on and automatic installs allowed: still waits for the user.
 assert.equal(f.updater.maybeAutoInstall(),false);assert.equal(f.updater.settingsChanged(),false);assert.equal(f.updater.install('local:9999',{automatic:true}).install.state,'idle');assert.equal(f.updater.run,null);assert.equal(f.installs.length,0);
 // A re-check must neither hit the network nor drop the pending request, even if latest.json is gone.
 fs.unlinkSync(f.latestFile);f.calls.length=0;const checked=await f.updater.check();assert.equal(checked.status,'available');assert.equal(checked.source,'local');assert.equal(checked.request_id,'local:9999');assert.equal(f.calls.length,0);assert.equal(f.updater.run,null);assert.equal(f.installs.length,0);
 // A newer request replaces the older one and is announced again; the dismissed-version setting is untouched by requests.
 const again=await f.updater.requestLocal({app_path:localApp(f,{name:'built2',build:10000}),note:''});assert.equal(again.build,10000);assert.equal(f.updater.snapshot().request_id,'local:10000');assert.equal(f.emitted.length,2);assert.equal(f.updater.state.data.update_dismissed_version,undefined);
 assert.throws(()=>f.updater.install('local:9999'),{code:'UPDATE_VERSION_MISMATCH'});
});
test('installing a local request copies the app, runs every check, and starts the new package upgrader; the requesting task does not hold it back',async t=>{
 const f=fixture(t),app=localApp(f),stage=path.join(f.home,'staging','local-9999');
 await f.updater.requestLocal({app_path:app,note:'改按钮',task_id:'task_1'});f.updater.busy=except=>{f.busyArgs.push([except]);return except!=='task_1';};
 assert.throws(()=>f.updater.install('9.0.0'),{code:'UPDATE_VERSION_MISMATCH'});assert.throws(()=>f.updater.install('local:1'),{code:'UPDATE_VERSION_MISMATCH'});
 f.calls.length=0;f.busyArgs.length=0;const started=f.updater.install('local:9999');assert.equal(started.install.state,'verifying');await f.updater.run.promise;
 const snap=f.updater.snapshot();assert.equal(snap.install.state,'restarting');assert.equal(snap.status,'installing');assert.equal(f.updater.forAI().request.status,'installing');
 assert.ok(f.busyArgs.length>0&&f.busyArgs.every(a=>a[0]==='task_1'),'busy() is always asked with the requesting task excluded');
 // No download or disk-image path: the app is copied from the requested path to staging/local-<build>.
 assert.equal(f.calls.some(c=>c.program==='/usr/bin/hdiutil'||c.program==='/usr/bin/curl'||c.program.endsWith('/gh')),false);
 const staged=path.join(stage,'ChatHand.app'),ditto=f.calls.filter(c=>c.program==='/usr/bin/ditto');assert.equal(ditto.length,1);assert.deepEqual(ditto[0].args,[fs.realpathSync(app),staged]);
 assert.equal(fs.existsSync(path.join(stage,'payload-manifest.json')),true);assert.equal(JSON.parse(fs.readFileSync(path.join(stage,'payload-manifest.json'))).version,'9.0.0');
 const order=f.calls.filter(c=>!c.spawn).map(c=>c.program+' '+c.args.join(' '));const at=re=>order.findIndex(x=>re.test(x));
 assert.ok(at(/ditto/)>=0&&at(/ditto/)<at(/codesign --verify --deep --strict .*staging\/local-9999\/ChatHand\.app$/));assert.ok(at(/codesign --verify --deep --strict .*staging/)<at(/codesign --verify -R=/)&&at(/-R=.* .*staging/)<at(/PlistBuddy .*staging/)&&at(/PlistBuddy .*staging/)<at(/xattr -dr com\.apple\.quarantine .*staging/));
 // The new package's own node runs its own upgrade script against the running app, detached.
 assert.equal(f.installs.length,1);const call=f.installs[0],runtime=path.join(staged,'Contents/Resources/runtime');assert.equal(call.program,path.join(runtime,'bin/node'));assert.equal(call.args[0],path.join(runtime,'scripts/upgrade.mjs'));assert.equal(call.args[1],'--install');assert.equal(call.args[2],stage);assert.equal(call.args[call.args.indexOf('--destination')+1],path.join(f.dir,'Current.app'));assert.equal(call.args[call.args.indexOf('--result')+1],path.join(f.stateDir,'update-result.json'));assert.equal(call.options.detached,true);assert.equal(call.child.unreferenced,true);assert.equal(call.options.env.CHATHAND_STATE_DIR,f.stateDir);
 // The pending record lets the next start tell "installed that build" from "still the old build".
 const pending=JSON.parse(fs.readFileSync(path.join(f.stateDir,'update-pending.json')));assert.equal(pending.from,CURRENT);assert.equal(pending.to,'9.0.0');assert.equal(pending.build_from,f.updater.currentBuild);assert.equal(pending.build_to,9999);assert.equal(pending.source,'local');
 // Waiting for other work: a request from a task that is not the one asked about waits (busy() true for everyone else).
 const waiting=fixture(t,{sleep:()=>new Promise(()=>{})});await waiting.updater.requestLocal({app_path:localApp(waiting),task_id:'task_2'});waiting.updater.busy=()=>true;assert.equal(waiting.updater.install('local:9999').install.state,'waiting_tasks');const op=waiting.updater.run;await new Promise(resolve=>setImmediate(resolve));assert.equal(waiting.installs.length,0);assert.equal(waiting.updater.cancel().install.state,'idle');await op.promise;assert.equal(waiting.installs.length,0);
});
test('a local install whose staged copy fails verification is reported as failed and never launches the upgrader',async t=>{
 const f=fixture(t);await f.updater.requestLocal({app_path:localApp(f),note:'x',task_id:'task_1'});
 f.execOverride=(program,args)=>{if(program==='/usr/bin/codesign'&&codesignVerify(args)&&args.at(-1).includes('/staging/'))throw Error('FAKE_STAGED_BAD_SIGNATURE');};
 f.updater.install('local:9999');await f.updater.run.promise;const s=f.updater.snapshot();assert.equal(s.install.state,'failed');assert.equal(s.install.message,'安装包检查没通过，没有安装');assert.equal(f.updater.forAI().request.status,'failed');assert.equal(f.installs.length,0);assert.equal(fs.existsSync(path.join(f.home,'staging','local-9999')),false);assert.equal(fs.existsSync(path.join(f.stateDir,'update-pending.json')),false);
 // The original app stays where it was.
 assert.equal(fs.existsSync(path.join(f.dir,'built','ChatHand.app/Contents/Info.plist')),true);
});
test('declining a local request clears it without remembering a dismissed version, and a re-check goes back to the network',async t=>{
 const f=fixture(t);assert.throws(()=>f.updater.dismiss('local:9999'),{code:'UPDATE_VERSION_MISMATCH'});
 await f.updater.requestLocal({app_path:localApp(f),note:'x',task_id:'task_1'});
 f.updater.run={fake:true};assert.throws(()=>f.updater.dismiss('local:9999'),{code:'UPDATE_IN_PROGRESS'});f.updater.run=null;assert.equal(f.updater.snapshot().status,'available');
 assert.throws(()=>f.updater.dismiss('local:1'),{code:'UPDATE_VERSION_MISMATCH'});assert.equal(f.updater.snapshot().status,'available');
 assert.deepEqual(f.updater.dismiss('local:9999'),{dismissed:'local:9999'});
 const s=f.updater.snapshot();assert.equal(s.status,'unknown');assert.equal(s.dismissed_version,null);assert.equal(s.version,undefined);assert.equal(s.source,undefined);assert.equal(s.request_id,undefined);assert.equal(s.request.status,'declined');assert.equal(s.request.build,9999);assert.equal(f.updater.state.data.update_dismissed_version,undefined);assert.equal(f.saved,undefined);assert.equal(f.updater.local,null);
 const ai=f.updater.forAI();assert.equal(ai.request.status,'declined');assert.equal(ai.status,'unknown');
 // With the request gone, checking uses latest.json again (the remote 9.0.0 fixture) and is not tagged local.
 const checked=await f.updater.check();assert.equal(checked.status,'available');assert.equal(checked.source,undefined);assert.equal(checked.version,'9.0.0');
});
test('start-up result for a local install: the new build is confirmed, an unchanged build is a failure',async t=>{
 const write=(f,pending,result)=>{fs.writeFileSync(path.join(f.stateDir,'update-pending.json'),JSON.stringify(pending));fs.writeFileSync(path.join(f.stateDir,'update-result.json'),JSON.stringify(result));};
 const committed={status:'COMMITTED',from:'1.0.0-beta.2',to:'9.0.0',schema_from:newSha};
 // Built and installed: same version string, newer build.
 const ok=fixture(t,{current:'9.0.0'});ok.updater.currentBuild=1018;write(ok,{from:'1.0.0-beta.2',to:'9.0.0',schema_from:oldSha,build_from:1017,build_to:1018,source:'local'},committed);
 assert.equal(ok.updater._readResult(),false);assert.deepEqual(ok.updater.snapshot().just_updated,{from:'1.0.0-beta.2',to:'9.0.0',tool_schema_changed:true,build_from:1017,build_to:1018});assert.equal(ok.updater.snapshot().status,'updated');assert.deepEqual(ok.updater.forAI().just_updated,ok.updater.snapshot().just_updated);assert.equal(ok.updater.snapshot().install.state,'idle');
 // The version matches but the build is not the one that was asked for: reported as failed, not as updated.
 const stale=fixture(t,{current:'9.0.0'});stale.updater.currentBuild=1017;write(stale,{from:'1.0.0-beta.2',to:'9.0.0',schema_from:oldSha,build_from:1017,build_to:1018,source:'local'},committed);
 assert.equal(stale.updater._readResult(),false);const s=stale.updater.snapshot();assert.equal(s.just_updated,null);assert.equal(s.install.state,'failed');assert.equal(s.install.rolled_back,true);assert.match(s.install.message,/1018/);assert.match(s.install.message,/1017/);assert.equal(s.status,'failed');
 // build_from is optional in the record; a record from before this feature behaves as before (no build fields).
 const noFrom=fixture(t,{current:'9.0.0'});noFrom.updater.currentBuild=1018;write(noFrom,{from:'1.0.0-beta.2',to:'9.0.0',schema_from:oldSha,build_to:1018},committed);assert.equal(noFrom.updater._readResult(),false);assert.deepEqual(noFrom.updater.snapshot().just_updated,{from:'1.0.0-beta.2',to:'9.0.0',tool_schema_changed:true,build_to:1018});
 const legacy=fixture(t,{current:'9.0.0'});write(legacy,{from:'1.0.0-beta.2',to:'9.0.0',schema_from:oldSha},committed);assert.equal(legacy.updater._readResult(),false);assert.deepEqual(legacy.updater.snapshot().just_updated,{from:'1.0.0-beta.2',to:'9.0.0',tool_schema_changed:true});
});
