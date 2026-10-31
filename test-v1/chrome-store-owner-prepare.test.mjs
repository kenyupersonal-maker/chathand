import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDesktop,needsInterface} from '../app/server.mjs';
import {registerBrowserHost} from '../app/v09/local-setup.mjs';
import {storeTestDistribution} from '../test-support/chrome-store-fixture.mjs';

test('real owner HTTP prepare needs no UI header, preserves authentication and browser/window guards',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-store-owner-'))),stateDir=path.join(root,'state'),work=path.join(root,'work'),bundle=path.join(root,'bundle'),home=path.join(stateDir,'integration-home'),distribution=storeTestDistribution(),UI='f'.repeat(64);
 let app,registrations=0;t.after(async()=>{try{await app?.close();}finally{fs.rmSync(root,{recursive:true,force:true});}});
 const binary=path.join(bundle,'bin/ChatHandBrowserHost'),dir=path.join(home,'Library/Application Support/Google/Chrome/NativeMessagingHosts');
 fs.mkdirSync(path.dirname(binary),{recursive:true});fs.writeFileSync(binary,'synthetic nonexecutable host fixture');
 const profileFile=path.join(home,'Library/Application Support/Google/Chrome/Local State');fs.mkdirSync(path.dirname(profileFile),{recursive:true});fs.writeFileSync(profileFile,JSON.stringify({profile:{info_cache:{Default:{name:'Synthetic profile'}}}}));
 app=await createDesktop({stateDir,defaultRoot:work,uiKey:UI,adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{
  chromeDistribution:distribution,computerName:()=> 'Synthetic store owner fixture',
  tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),
  updaterFactory:()=>({currentBuild:1080,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request:null,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})}),
  toolsRefreshFactory:()=>({snapshot:()=>({state:'idle'}),run(){assert.fail('unexpected tools refresh')},clickByNumber(){assert.fail('unexpected tools refresh click')}}),
  browserHost:{expectedBinary:binary,manifestPath:[path.join(dir,'com.kenyu.chathand.browser.json')],register(options){options.guard?.();registrations++;return registerBrowserHost({root:bundle,home,platform:'darwin',distribution,registrationOnlyAfterOptIn:true,browserEnabled:app.state.data.browser_enabled,browserOptIn:app.state.data.browser_control_opt_in});}}
 }});
 const post=async(route,body={},headers={})=>{const response=await fetch(`http://127.0.0.1:${app.apiPort}`+route,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+app.adminToken,...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(4000)});return {status:response.status,body:await response.json()};};
 const unauthenticated=await post('/api/browser/extension/prepare',{}, {Authorization:'Bearer invalid'});assert.equal(unauthenticated.status,401);assert.equal(registrations,0);
 await post('/api/access',{enabled:true},{'X-Chathand-UI':UI});
 await post('/api/settings',{browser_enabled:true},{'X-Chathand-UI':UI});
 const prepared=await post('/api/browser/extension/prepare');assert.equal(prepared.status,200);assert.equal(prepared.body.registered,true);assert.equal(prepared.body.extension_id,distribution.extension_id);assert.equal(prepared.body.selected_profile,'Default');assert.equal(prepared.body.opened,undefined);assert.equal(prepared.body.profile_verified,undefined);
 const manifest=JSON.parse(fs.readFileSync(path.join(dir,'com.kenyu.chathand.browser.json'),'utf8'));assert.deepEqual(manifest.allowed_origins,[`chrome-extension://${distribution.extension_id}/`]);
 for(const route of ['/api/browser/extension/store/cancel','/api/browser/extension/reconnect','/api/browser/extension/stop']){const blocked=await post(route);assert.equal(blocked.status,403);assert.equal(blocked.body.error.code,'UI_CONFIRM_REQUIRED');}
 await post('/api/settings',{browser_enabled:false},{'X-Chathand-UI':UI});const priorRegistrations=registrations;
 const disabled=await post('/api/browser/extension/prepare');assert.equal(disabled.body.error.code,'INSTALL_ACCESS_CHANGED');assert.equal(registrations,priorRegistrations);
 assert.equal(needsInterface('/api/browser/extension/prepare',{}),false);
 assert.equal(needsInterface('/api/browser/extension/prepare',{retry_after_permission:true}),true);
 await post('/api/access',{enabled:false},{'X-Chathand-UI':UI});const stopped=await post('/api/browser/extension/prepare');assert.equal(stopped.body.error.code,'LOCAL_DISABLED');
});
