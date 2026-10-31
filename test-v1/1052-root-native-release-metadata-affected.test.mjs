// The private Site release bridge is retired. GitHub/local DMG updates remain.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDesktop} from '../app/server.mjs';
import * as product from '../app/product.mjs';
import {bundledSiteTarget} from '../app/v1/b-site-trust.mjs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('candidate product has no private Site release URL or runtime bootstrap',()=>{
 const pkg=JSON.parse(read('package.json')),raw=JSON.parse(read('connectors/product.json'));
 assert.equal(pkg.kenBridge.connector_api,31);assert.equal(product.CONNECTOR_API,31);
 assert.equal(raw.schema,1);assert.equal(Object.hasOwn(raw,'release'),false);
 assert.equal(raw.relay_url,null);assert.equal(raw.connector_install_url,null);
 assert.equal(raw.public_service_status,'NOT_DEPLOYED');
 assert.equal(Object.hasOwn(product,'releaseDescriptor'),false);
 assert.doesNotMatch(read('connectors/product.json'),/chatgpt\.site|release\/bridge/);
});

test('private release metadata cannot fabricate B device trust',()=>{
 const targets=JSON.parse(read('connectors/site-b-targets.json'));
 assert.deepEqual(targets.deployments,[]);assert.equal(bundledSiteTarget('unregistered-test-site'),null);
 assert.doesNotMatch(read('connectors/product.json'),/SITE_SIGNING_PUBLIC_KEY|OWNER_SUBJECT_PIN|SIWC/);
});

test('product endpoint strips stale release input and retains the unrelated local DMG/update entry points',()=>{
 const server=read('app/server.mjs'),native=read('native/main.swift'),updater=read('app/v1/update.mjs');
 assert.match(server,/req\.method==='GET'&&req\.url==='\/api\/product-config'/);
 assert.match(server,/const \{release,\.\.\.bundled\}=JSON\.parse/);
 assert.match(server,/return send\(res,200,bundled\)/);assert.doesNotMatch(server,/releaseDescriptor|release_descriptor/);
 assert.match(native,/case "chooseReleaseDMG"/);assert.match(native,/interfaceKeyShared && ownsService && data\.isEmpty/);
 assert.match(native,/p\.allowedFileTypes = \["dmg"\]/);assert.match(updater,/requestLocal/);
 assert.match(read('scripts/upgrade.mjs'),/candidate/);
});


test('authenticated product-config HTTP response contains no private release entry',async t=>{
 const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'retired-release-'))),work=path.join(base,'work');fs.mkdirSync(work);
 const app=await createDesktop({stateDir:path.join(base,'state'),defaultRoot:work,uiKey:'aa'.repeat(32),clientDeps:{
  currentAppPath:path.join(base,'ChatHand.app'),computerName:()=> 'Synthetic retirement fixture',
  tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),
  updaterFactory:()=>({snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})
 }});
 t.after(async()=>{await app.close();fs.rmSync(base,{recursive:true,force:true});});
 const url='http://127.0.0.1:'+app.apiPort+'/api/product-config';
 assert.equal((await fetch(url)).status,401);
 const response=await fetch(url,{headers:{authorization:'Bearer '+app.adminToken}});assert.equal(response.status,200);
 const body=await response.json();assert.deepEqual(body,JSON.parse(read('connectors/product.json')));
 assert.equal(Object.hasOwn(body,'release'),false);assert.equal(Object.hasOwn(body,'release_descriptor'),false);
 assert.doesNotMatch(JSON.stringify(body),/release\/bridge|chatgpt\.site/);
});
