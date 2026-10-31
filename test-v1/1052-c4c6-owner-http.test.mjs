import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDesktop,needsInterface} from '../app/server.mjs';
import {CredentialStore} from '../app/credentials.mjs';
import {readPinnedSiteTemplate} from '../app/v1/site-template-pin.mjs';

test('isolated owner HTTP guards C4/C6 routes and returns only public setup fields',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-c4c6-http-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const stateDir=path.join(root,'state'),work=path.join(root,'work');
 fs.mkdirSync(stateDir,{mode:0o700});fs.mkdirSync(work,{mode:0o700});
 const ui='ab'.repeat(32),nativeOwnerKey='cd'.repeat(32),pin=readPinnedSiteTemplate();assert.equal(pin.source_kind,'bundled_local');
 const credentials=new CredentialStore(stateDir,{adapter:null});
 const transport={epoch:0,status:()=>({factory:'synthetic_http_fixture'}),start(){},stop(){this.epoch++},
  async beginV2(){throw Object.assign(Error('synthetic offline Site'),{code:'B_SITE_OFFLINE'});},
  async completeRecoveredV2(){throw Error('no complete')},async health(){throw Error('no health')}};
 const app=await createDesktop({stateDir,defaultRoot:work,uiKey:ui,nativeOwnerKey,clientDeps:{siteNetworkFetch:async()=>new Response(null,{status:200}),credentials,bSiteTransport:transport,
  bSiteTemplatePin:()=>pin,currentAppPath:path.join(root,'ChatHand.app'),computerName:()=> 'Fixture',
  tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),
  updaterFactory:()=>({currentBuild:1050,snapshot:()=>({status:'unknown',install:{state:'idle'}}),
   forAI:()=>({status:'unknown',request:null,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})}});
 t.after(async()=>app.close());
 const endpoint='http://127.0.0.1:'+app.apiPort,secret='synthetic-service-credential-'.padEnd(48,'s');
 const post=async(route,body={},owner=true,interfaceKey=false,origin=`http://127.0.0.1:${app.apiPort}`)=>{
  const headers={'content-type':'application/json',...(owner?{authorization:'Bearer '+app.adminToken}:{}),
   ...(interfaceKey?{'x-chathand-ui':ui}:{}),...(origin?{origin}:{})};
  const response=await fetch(endpoint+route,{method:'POST',headers,body:JSON.stringify(body)});
  return {status:response.status,data:await response.json()};
 };
 const site='/api/setup/site',watch='/api/site-b/enrollment/watch',stop=watch+'/stop',
  dismiss='/api/site-b/paired-notice/dismiss';
 const input={format:'chathand-site-v2',site_origin:'https://private-a.chatgpt.site',
  site_id:'privateSiteA',service_credential:secret};
 assert.equal((await post(site,input,false)).status,401);
 const invalid=await post(site,{format:'old'},true,false);
 assert.notEqual(invalid.status,403);
 assert.equal(invalid.data.error.code,'B_SETUP_SITE_FORMAT');
 for(const route of [watch,stop,dismiss])assert.equal((await post(route,{},false,true)).status,401,'an arbitrary UI key is not owner authentication');
 for(const route of [watch,stop]){
  assert.equal(needsInterface(route,{}),false,route+' is loopback-owner authenticated');
  const owned=await post(route,{},true,false);assert.notEqual(owned.status,403,route+' accepts owner route without falsely requiring UI_ONLY');
 }
 assert.equal(needsInterface(dismiss,{}),true);
 assert.equal((await post(dismiss,{notice_id:'fixture'},true,false)).status,403,'paired notice dismissal remains UI_ONLY');
 assert.equal((await post(dismiss,{notice_id:'fixture'},true,false,'https://evil.example')).status,403,'wrong origin remains rejected');
 // The current owner route creates a local pairing intent from the bundled
 // source; only then does the passive public snapshot expose its SHA descriptor.
 const started=await post('/api/setup/site/start',{},true,true);
 assert.equal(started.status,200,JSON.stringify(started.data));assert.equal(started.data.template_sha256,pin.template_sha256);
 const before=await fetch(endpoint+'/api/state',{headers:{authorization:'Bearer '+app.adminToken}});
 assert.equal(before.status,200);
 const source=(await before.json()).site_b.verified_template_source;
 assert.equal(source?.source_kind,'bundled_local');assert.equal(source?.template_sha256,pin.template_sha256);
 assert.equal((await post(site,input,true,true,'https://evil.example')).status,403,'wrong origin cannot submit owner Site setup');
 const lease=await post(watch,{},true,true);
 assert.equal(lease.status,200,JSON.stringify(lease.data));
 assert.equal(lease.data.watching,true);
 assert.ok(lease.data.expires_at>Date.now()&&lease.data.expires_at-Date.now()<=15*60*1000);
 assert.equal((await post(stop,{},true,true)).data.watching,false);
 const accepted=await post(site,input,true,true);
 assert.equal(accepted.status,200,JSON.stringify(accepted.data));
 assert.deepEqual(accepted.data,{phase:'pairing',origin:input.site_origin});
 assert.equal(JSON.stringify(accepted).includes(secret),false);
 const stateResponse=await fetch(endpoint+'/api/state',{headers:{authorization:'Bearer '+app.adminToken}});
 assert.equal((await stateResponse.text()).includes(secret),false);
 const stale=await post(dismiss,{notice_id:'00000000-0000-4000-8000-000000000000'},true,true);
 assert.equal(stale.data.error.code,'B_NOTICE_STALE');
});
