import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createDesktop} from '../../app/server.mjs';
import {Updater} from '../../app/v1/update.mjs';

for(const min of [null,'9.9.9'])test('1096 newer-data read-only startup retains bytes while authenticated window starts update and receives progress: '+min,{timeout:15000},async t=>{
 const root=fs.mkdtempSync('/private/tmp/chathand-update-bubble-'),stateDir=path.join(root,'state'),home=path.join(root,'home'),work=path.join(root,'work');
 for(const dir of [stateDir,home])fs.mkdirSync(dir,{mode:0o700});
 const file=path.join(stateDir,'desktop.json'),original=JSON.stringify({format:'chathand-desktop-v2',...(min?{min_app_version:min}:{}),payload:{untouched:'SYNTHETIC_NEWER_DATA'}})+'\n';fs.writeFileSync(file,original,{mode:0o600});
 const before=fs.statSync(file),latestFile=path.join(root,'latest.json'),uiKey='a'.repeat(64);let updater,run,release;
 fs.writeFileSync(latestFile,JSON.stringify({format:'chathand-latest-v1',version:'9.9.9',build:9999,published_at:'2026-11-03T00:00:00Z',notes:'',min_macos:'14.0',tool_schema_sha256:'a'.repeat(64),dmg:{name:'ChatHand-9.9.9.dmg',url:'https://example.invalid/fixture.dmg',sha256:'b'.repeat(64),size:1000000},release_page:'https://example.invalid/releases'}));
 const app=await createDesktop({stateDir,defaultRoot:work,uiKey,lock:false,adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{
  currentAppPath:path.join(root,'Synthetic.app'),computerName:()=> 'Synthetic Update Mac',
  credentials:{get:()=>null,set(){assert.fail('No credential writes');},remove(){assert.fail('No credential removals');},status:()=>({healthy:true,tunnel:false,relay:false})},
  tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({ready:false,healthy:false,process_running:false})}),
  bSiteTransport:{setRpcDelivery(){},setRuntimeFactory(){},setHostFlow(){},close(){},stop(){},status:()=>({ready:false})},
  updaterFactory:deps=>{
   updater=new Updater({...deps,upgradeHome:path.join(root,'upgrades'),downloadsDir:path.join(home,'Downloads'),env:{CHATHAND_UPDATE_URL:pathToFileURL(latestFile).href},currentSystemProxy:()=>null,
    exec:async program=>{if(program==='/usr/bin/sw_vers')return {stdout:'15.7.5'};assert.fail('No external command: '+program);},spawn(){assert.fail('No real installer starts in this synthetic HTTP boundary test');}});
   // Exact installer behavior is already covered by update.test.mjs. This gate
   // checks the read-only state + native-window HTTP boundary without launching it.
   updater._install=async operation=>{run=operation;await new Promise(resolve=>release=resolve);};return updater;
  },
 }});
 t.after(async()=>{release?.();await run?.promise;await app.close();fs.rmSync(root,{recursive:true,force:true});});
 const origin='http://127.0.0.1:'+app.apiPort;
 const request=async(route,body,windowAuth=true)=>{const r=await fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+app.adminToken,'Content-Type':'application/json',...(windowAuth?{'X-ChatHand-UI':uiKey}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};};
 const state=(await request('/api/state')).body;
 assert.equal(app.state.readOnly,true);assert.equal(state.settings.auto_update,false);assert.equal(state.settings.auto_connect,false);
 assert.deepEqual(state.startup_notices,[{kind:'newer',format_version:'2',min_app_version:min}]);
 const checked=await request('/api/support/update',{});assert.equal(checked.status,200);assert.equal(checked.body.availability,'available');
 const refused=await request('/api/update/install',{version:'9.9.9'},false);assert.equal(refused.status,403);assert.equal(updater.run,null,'read-only update still requires the window gesture');
 const installed=await request('/api/update/install',{version:'9.9.9'});assert.equal(installed.status,200);assert.equal(installed.body.status,'downloading');
 assert.equal(updater.ai.origin,'native_ui');assert.equal(updater.ai.to.build,9999);
 for(const[state,extra]of [['downloading',{progress:.42,downloaded_bytes:420000,total_bytes:1000000}],['verifying',{}],['installing',{}],['restarting',{}]]){
  updater._set(run,state,extra);const snapshot=(await request('/api/state')).body;
  assert.equal(snapshot.update.install.state,state);if(state==='downloading')assert.equal(snapshot.update.progress,.42);
  assert.equal(fs.readFileSync(file,'utf8'),original);
 }
 const after=fs.statSync(file);assert.equal(after.ino,before.ino);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(after.mode,before.mode);
 assert.equal(fs.existsSync(work),false,'the read-only boot does not create a workspace');
});

// The installer's restart check must compare future data with itself, not with
// the temporary settings shown by a read-only startup.
const {captureUpgradeSettings,verifyRetainedUpgradeSettings,UPGRADE_SETTINGS,retainedUpgradeSetting}=await import('../../scripts/upgrade.mjs');
const {DesktopState}=await import('../../app/state.mjs');
const {clientSettings}=await import('../../app/v1/client-features.mjs');
for(const min of [null,'9.9.9'])test('1096 installer accepts protected newer-data bytes after read-only restart and rejects changed or missing data: '+min,t=>{
 const root=fs.mkdtempSync('/private/tmp/chathand-update-retention-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'desktop.json'),original=JSON.stringify({format:'chathand-desktop-v2',...(min?{min_app_version:min}:{}),payload:{untouched:true},high_risk:{admin:true},connection_preference:'tunnel',auto_connect:true})+'\n';
 fs.writeFileSync(file,original,{mode:0o600});
 const baseline=captureUpgradeSettings(root),state=new DesktopState(root,{defaultRoot:path.join(root,'work'),deferWorkspace:true});
 const defaults={...state.data,...clientSettings(state.data)};
 assert.equal(state.readOnly,true);assert.equal(baseline.settings,null,'future fields never grant admin access or request a connection during upgrade');
 assert.equal(UPGRADE_SETTINGS.some(field=>!retainedUpgradeSetting(JSON.parse(original),defaults,field)),true,'the former settings comparison rejected an unchanged read-only startup');
 assert.doesNotThrow(()=>verifyRetainedUpgradeSettings(baseline,defaults,root));assert.equal(fs.readFileSync(file,'utf8'),original);
 fs.writeFileSync(file,original+' ');assert.throws(()=>verifyRetainedUpgradeSettings(baseline,defaults,root),/SETTING_NOT_RETAINED_NEWER_DATA/);
 fs.unlinkSync(file);assert.throws(()=>verifyRetainedUpgradeSettings(baseline,defaults,root),/SETTING_NOT_RETAINED_NEWER_DATA/);
 const other=path.join(root,'other.json');fs.writeFileSync(other,original);fs.symlinkSync(other,file);assert.throws(()=>verifyRetainedUpgradeSettings(baseline,defaults,root),/SETTING_NOT_RETAINED_NEWER_DATA/);
});

test('1096 installer still verifies every supported-format setting after restart',t=>{
 const root=fs.mkdtempSync('/private/tmp/chathand-update-retention-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const state=new DesktopState(root,{defaultRoot:path.join(root,'work')});const baseline=captureUpgradeSettings(root),after={...state.data,...clientSettings(state.data),access_enabled:true,show_value:true,value_plan:'auto'};
 assert.equal(baseline.newerDataSha256,null);assert.doesNotThrow(()=>verifyRetainedUpgradeSettings(baseline,after,root));
 for(const field of ['projects','active','auto_update','access_enabled','appearance','skin'])assert.throws(()=>verifyRetainedUpgradeSettings(baseline,{...after,[field]:field==='auto_update'||field==='access_enabled'?false:'CHANGED'},root),new RegExp('SETTING_NOT_RETAINED_'+field.toUpperCase()));
});
