import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDesktop} from '../app/server.mjs';
import {registerBrowserHost} from '../app/v09/local-setup.mjs';
import {storeTestDistribution} from '../test-support/chrome-store-fixture.mjs';

test('explicit owner store preparation recovers a real registration denial after access changes without public retry flags',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-store-recovery-'))),stateDir=path.join(root,'state'),home=path.join(stateDir,'integration-home'),bundle=path.join(root,'bundle'),distribution=storeTestDistribution(),UI='f'.repeat(64);
 let app,denied=true,registrations=0;t.after(async()=>{try{await app?.close();}finally{fs.rmSync(root,{recursive:true,force:true});}});
 const binary=path.join(bundle,'bin/ChatHandBrowserHost'),manifest=path.join(home,'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.kenyu.chathand.browser.json');
 fs.mkdirSync(path.dirname(binary),{recursive:true});fs.writeFileSync(binary,'synthetic nonexecutable host fixture');
 const localState=path.join(home,'Library/Application Support/Google/Chrome/Local State');fs.mkdirSync(path.dirname(localState),{recursive:true});fs.writeFileSync(localState,JSON.stringify({profile:{info_cache:{Default:{name:'Synthetic recovery profile'}}}}));
 const io=new Proxy(fs,{get(target,key){if(key==='mkdirSync')return (...args)=>{if(denied)throw Object.assign(Error('synthetic registration denial'),{code:'EPERM'});return target.mkdirSync(...args);};return target[key];}});
 app=await createDesktop({stateDir,defaultRoot:path.join(root,'work'),uiKey:UI,adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{
  chromeDistribution:distribution,computerName:()=> 'Synthetic registration recovery',
  tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),
  updaterFactory:()=>({snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request:null,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})}),
  toolsRefreshFactory:()=>({snapshot:()=>({state:'idle'}),run(){assert.fail('unexpected tools refresh')},clickByNumber(){assert.fail('unexpected tools refresh click')}}),
  browserHost:{expectedBinary:binary,manifestPath:[manifest],register(){registrations++;return registerBrowserHost({root:bundle,home,platform:'darwin',io,distribution,registrationOnlyAfterOptIn:true,browserEnabled:app.state.data.browser_enabled,browserOptIn:app.state.data.browser_control_opt_in});}}
 }});
 // Let the existing one-shot startup run with no Browser Use opt-in. It cannot retry later.
 await new Promise(resolve=>setTimeout(resolve,70));assert.equal(registrations,0);
 const post=async(route,body={},ui=false)=>{const response=await fetch(`http://127.0.0.1:${app.apiPort}`+route,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+app.adminToken,...(ui?{'X-Chathand-UI':UI}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(4000)});return {status:response.status,body:await response.json()};};
 await post('/api/access',{enabled:true},true);await post('/api/settings',{browser_enabled:true},true);
 const first=await post('/api/browser/extension/prepare');assert.equal(first.body.error.code,'CHROME_DATA_ACCESS_DENIED');assert.equal(registrations,1);assert.equal(fs.existsSync(manifest),false);
 denied=false;
 const recovered=await post('/api/browser/extension/prepare');assert.equal(recovered.body.registered,true);assert.equal(recovered.body.opened,undefined);assert.equal(registrations,2);assert.equal(JSON.parse(fs.readFileSync(manifest,'utf8')).allowed_origins[0],`chrome-extension://${distribution.extension_id}/`);
 denied=true;
 const again=await post('/api/browser/extension/prepare');assert.equal(again.body.error.code,'CHROME_DATA_ACCESS_DENIED');assert.equal(registrations,3);
 const stillDenied=await post('/api/browser/extension/prepare');assert.equal(stillDenied.body.error.code,'CHROME_DATA_ACCESS_DENIED');assert.equal(registrations,4);
 const reconnect=await post('/api/browser/extension/reconnect',{},true);assert.equal(reconnect.body.error.code,'CHROME_DATA_ACCESS_DENIED');assert.equal(registrations,4);
 const oldFlag=await post('/api/browser/extension/prepare',{retry_after_permission:true},true);assert.equal(oldFlag.body.error.code,'ARG_INVALID');assert.equal(registrations,4);
 await post('/api/settings',{browser_enabled:false},true);denied=false;
 const revoked=await post('/api/browser/extension/prepare');assert.equal(revoked.body.error.code,'INSTALL_ACCESS_CHANGED');assert.equal(registrations,4);
 await post('/api/settings',{browser_enabled:true},true);
 const current=await post('/api/browser/extension/prepare');assert.equal(current.body.registered,true);assert.equal(current.body.opened,undefined);assert.equal(registrations,5);
});
