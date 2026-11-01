import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDesktop} from '../../app/server.mjs';
import {storeTestDistribution} from '../support/chrome-store-fixture.mjs';

test('only the current window can normalize default Browser Use; owner-only and explicit-off requests remain untouched',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1082-window-prepare-'))),stateDir=path.join(root,'state'),UI='ab'.repeat(32),profile=path.join(stateDir,'integration-home/Library/Application Support/Google/Chrome/Local State');
 fs.mkdirSync(path.dirname(profile),{recursive:true});fs.writeFileSync(profile,JSON.stringify({profile:{info_cache:{Default:{name:'Fixture'}}}}));
 let registrations=0;const app=await createDesktop({stateDir,defaultRoot:path.join(root,'work'),uiKey:UI,adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{chromeDistribution:storeTestDistribution(),currentAppPath:path.join(root,'Fake.app'),credentials:{get:()=>null,status:()=>({}),publicStatus:()=>({}),set(){},remove(){}},browserHost:{expectedBinary:path.join(root,'host'),manifestPath:[path.join(root,'host.json')],register(options){options.guard?.();registrations++;return {registered:true};}},tunnelFactory:()=>({stop(){},snapshot:async()=>({healthy:false,ready:false,process_running:false})}),bSiteTransport:{setRpcDelivery(){},setRuntimeFactory(){},setHostFlow(){},status:()=>({}),stop(){},close(){}},updaterFactory:()=>({snapshot:()=>({status:'unknown',install:{state:'idle'}}),start(){},close(){},settingsChanged(){},cleanupLeftovers:()=>({cleaned:0})})}});
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 const post=async(route,body={},key,owner=true)=>{const response=await fetch('http://127.0.0.1:'+app.apiPort+route,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+(owner?app.adminToken:'invalid'),...(key?{'x-chathand-ui':key}:{})},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
 await post('/api/access',{enabled:true},UI);
 let reads=0,stats=0;const read=fs.readFileSync,lstat=fs.lstatSync;
 t.mock.method(fs,'readFileSync',(file,...args)=>{if(String(file)===profile)reads++;return read(file,...args);});t.mock.method(fs,'lstatSync',(file,...args)=>{if(String(file)===profile)stats++;return lstat(file,...args);});
 assert.equal(app.state.data.browser_enabled,undefined);assert.equal(registrations,0);
 assert.equal((await post('/api/browser/extension/prepare',{},UI,false)).status,401);
 for(const key of [undefined,'incorrect-window-key'])assert.equal((await post('/api/browser/extension/prepare',{},key)).body.error.code,'INSTALL_ACCESS_CHANGED');
 assert.deepEqual({reads,stats,registrations},{reads:0,stats:0,registrations:0});assert.equal(app.state.data.browser_enabled,undefined);assert.equal(app.state.data.browser_control_opt_in,undefined);
 const prepared=await post('/api/browser/extension/prepare',{},UI);assert.equal(prepared.status,200);assert.equal(prepared.body.registered,true);assert.equal(reads,1);assert.equal(stats,1);assert.equal(registrations,1);assert.equal(app.state.data.browser_enabled,true);assert.equal(app.state.data.browser_control_opt_in,true);
 const saved=JSON.parse(fs.readFileSync(app.state.file));assert.equal(saved.browser_enabled,true);assert.equal(saved.browser_control_opt_in,true);
 assert.equal((await post('/api/browser/extension/prepare')).body.registered,true,'owner-only preparation stays compatible after an explicit setting exists');assert.equal(registrations,2);
 await post('/api/settings',{browser_enabled:false},UI);const before={reads,stats,registrations};
 for(const key of [undefined,UI])assert.equal((await post('/api/browser/extension/prepare',{},key)).body.error.code,'INSTALL_ACCESS_CHANGED');
 assert.deepEqual({reads,stats,registrations},before);assert.equal(app.state.data.browser_enabled,false);
 await post('/api/access',{enabled:false},UI);assert.equal((await post('/api/browser/extension/prepare',{},UI)).body.error.code,'LOCAL_DISABLED');assert.deepEqual({reads,stats,registrations},before);
});
