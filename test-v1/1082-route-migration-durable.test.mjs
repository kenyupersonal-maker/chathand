import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {ChatGPTAppRoutes} from '../app/v1/chatgpt-app-routes.mjs';
import {DesktopState} from '../app/state.mjs';
import {createDesktop} from '../app/server.mjs';

test('migration save failures keep the original route assignment pending; existing maps never save or reattribute',()=>{
 let selected='openai',saves=0;const state={data:{chatgpt_app_name:'Original A'},save(){saves++;throw Error('synthetic persistence failure');}},apps=new ChatGPTAppRoutes({state,selected:()=>selected});
 assert.throws(()=>apps.persistMigration(),/synthetic persistence failure/);assert.equal(apps.migrationPending,true);selected='site';assert.equal(apps.entry('site').chatgpt_app_name,undefined);assert.equal(apps.entry('openai').chatgpt_app_name,'Original A');
 state.save=()=>{saves++;};apps.persistMigration();assert.equal(apps.migrationPending,false);apps.persistMigration();assert.equal(saves,2);
 const disk=JSON.parse(JSON.stringify(state.data)),restarted=new ChatGPTAppRoutes({state:{data:disk,save(){assert.fail('existing map must not be migrated again');}},selected:()=>selected});restarted.persistMigration();assert.equal(restarted.entry('openai').chatgpt_app_name,'Original A');assert.equal(restarted.entry('site').chatgpt_app_name,undefined);
});

async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1082-durable-migration-')),transport={epoch:1,setRpcDelivery(){},setRuntimeFactory(){},setHostFlow(){},status:()=>({running:true,ready:true,authenticated:true}),stop(){},close(){}};
 const create=()=>createDesktop({stateDir:path.join(root,'state'),defaultRoot:path.join(root,'work'),lock:false,adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{currentAppPath:path.join(root,'Fake.app'),credentials:{get:()=>null,status:()=>({}),publicStatus:()=>({}),set(){},remove(){}},bSiteTransport:transport,tunnelFactory:()=>({stop(){},snapshot:async()=>({ready:false,healthy:false,process_running:false})}),updaterFactory:()=>({snapshot:()=>({status:'unknown',install:{state:'idle'}}),start(){},close(){},cleanupLeftovers:()=>({cleaned:0})})}});
 let app=await create();const local=app.tools.bSiteLocalStore;local.configureOpenAI({verified:true});local.configureSite({site_id:'fixture-site',owner_subject:'fixture-owner',binding_id:crypto.randomUUID(),generation:1},{authenticated:true});app.state.data.access_enabled=false;app.state.data.auto_connect=false;app.state.save();const file=app.state.file;await app.close();app=null;
 const legacy=JSON.parse(fs.readFileSync(file));delete legacy.chatgpt_app_routes;legacy.chatgpt_app_identity={application_id:'fixture-original-openai'};legacy.chatgpt_app_name='Original OpenAI';fs.writeFileSync(file,JSON.stringify(legacy));
 t.after(async()=>{await app?.close();fs.rmSync(root,{recursive:true,force:true});});
 return {file,create,get app(){return app;},async boot(){app=await create();return app;},async close(){await app?.close();app=null;}};
}

test('legacy migration is durable before a paused healthy route switch and retains its ownership after restart',async t=>{
 const f=await fixture(t),app=await f.boot();assert.equal(app.policy.enabled,false);assert.equal(app.tools.bSiteLocalStore.selection().selected,'openai');
 const disk=JSON.parse(fs.readFileSync(f.file));assert.equal(disk.chatgpt_app_routes.openai.chatgpt_app_name,'Original OpenAI');assert.equal(disk.chatgpt_app_routes.site.chatgpt_app_name,undefined);
 app.tools.bSiteLocalStore.health('site',{state:'healthy',verified:true,nonceEcho:true,generation:1});const switched=await app.handle('/api/connection/use',{route:'site'});assert.equal(switched.ok,true,JSON.stringify(switched));assert.equal(switched.selected,'site');assert.equal(app.policy.enabled,false);
 await f.close();const restarted=await f.boot();assert.equal(restarted.tools.bSiteLocalStore.selection().selected,'site');assert.equal(restarted.state.data.chatgpt_app_routes.openai.chatgpt_app_name,'Original OpenAI');assert.equal(restarted.state.data.chatgpt_app_routes.site.chatgpt_app_name,undefined);
});

test('createDesktop rejects an unpersisted migration before any route can switch, then retries without reassignment',async t=>{
 const f=await fixture(t),save=DesktopState.prototype.save;let failed=false;
 DesktopState.prototype.save=function(){if(Object.hasOwn(this.data,'chatgpt_app_routes')){failed=true;throw Error('synthetic migration save failure');}return save.call(this);};
 try{await assert.rejects(()=>f.create(),/synthetic migration save failure/);}finally{DesktopState.prototype.save=save;}
 assert.equal(failed,true);assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(f.file)),'chatgpt_app_routes'),false);
 const restarted=await f.boot();assert.equal(restarted.tools.bSiteLocalStore.selection().selected,'openai');assert.equal(restarted.state.data.chatgpt_app_routes.openai.chatgpt_app_name,'Original OpenAI');assert.equal(restarted.state.data.chatgpt_app_routes.site.chatgpt_app_name,undefined);
});
