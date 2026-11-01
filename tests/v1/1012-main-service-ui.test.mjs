import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {createDesktop} from '../../app/server.mjs';

// Complement the resource allowlist in 1012-static-assets and save/SSE scenarios in static-skin:
// this exercises the previously missing first-launch setup route, with actual server/client files.
test('unconfigured real main service loads setup and all client modules: two saved skins by two schemes',async t=>{
 if(process.env.CHATHAND_UI_OUTPUT)fs.mkdirSync(process.env.CHATHAND_UI_OUTPUT,{recursive:true});
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1012-main-ui-')),prior=process.env.CHATHAND_STATE_DIR;
 process.env.CHATHAND_STATE_DIR=path.join(root,'state');let app,browser;const rows=[];
 t.after(async()=>{await browser?.close();await app?.close();fs.rmSync(root,{recursive:true,force:true});if(prior===undefined)delete process.env.CHATHAND_STATE_DIR;else process.env.CHATHAND_STATE_DIR=prior;const out=process.env.CHATHAND_UI_OUTPUT;if(out){fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'real-main-ui.json'),JSON.stringify({rows,temporary_state:true,native_permissions:false,account_credentials:false,physical_app_acceptance:false},null,2));}});
 const uiKey='e'.repeat(64);
 app=await createDesktop({stateDir:process.env.CHATHAND_STATE_DIR,defaultRoot:path.join(root,'work'),uiKey,adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{computerName:()=> 'Isolated Mac',tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),updaterFactory:()=>({snapshot:()=>({status:'unknown',install:{state:'idle'}}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})}});
 const origin=`http://127.0.0.1:${app.apiPort}`;
 const snapshot=await app.snapshot();
 assert.ok(['full','light','custom'].includes(snapshot.permissions.tier));
 assert.ok(snapshot.high_risk.items.every(item=>item.group===(['admin','autostart'].includes(item.id)?'common':'danger')));
 assert.ok(Array.isArray(snapshot.setup.open_items));assert.deepEqual(snapshot.setup.key_watch,{active:false,received:false,last4:null});
 assert.ok(Array.isArray(snapshot.ui.seen));assert.equal(snapshot.settings.appearance,'system');assert.equal(snapshot.settings.auto_update,true);
 assert.equal(typeof snapshot.connection.device_name,'string');assert.equal(typeof snapshot.settings.show_value,'boolean');assert.equal(typeof snapshot.value.quota.week_tokens,'number');
 // Protected interface routes cannot be invoked with owner-only credentials.
 for(const[route,body]of [['/api/permissions/tier',{tier:'full'}],['/api/ui/seen',{key:'permissions_hint'}],['/api/setup/await-key',{tunnel_id:'tunnel_fixture1234'}],['/api/value/reset',{}],['/api/settings',{show_value:false}],['/api/settings',{skin:'quiet-titanium'}]]){
  const response=await fetch(origin+route,{method:'POST',headers:{Authorization:'Bearer '+app.adminToken,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,403,route);assert.equal((await response.json()).error.code,'UI_CONFIRM_REQUIRED',route);
 }
 const eventsDenied=await fetch(origin+'/api/events',{headers:{Authorization:'Bearer '+app.adminToken}});assert.equal(eventsDenied.status,403);assert.equal((await eventsDenied.json()).error.code,'UI_CONFIRM_REQUIRED');
 browser=await chromium.launch({headless:true,executablePath:process.env.CHATHAND_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 for(const skin of ['default','quiet-titanium'])for(const scheme of ['light','dark']){
  const save=await fetch(origin+'/api/settings',{method:'POST',headers:{Authorization:'Bearer '+app.adminToken,'X-ChatHand-UI':uiKey,'Content-Type':'application/json'},body:JSON.stringify({skin})});assert.equal(save.status,200);await save.json();
  const context=await browser.newContext({viewport:{width:980,height:680},colorScheme:scheme,locale:'zh-CN'}),page=await context.newPage();const errors=[],resources=[],remote=[];
  const row={skin,scheme,resources,errors,remote,ok:false};rows.push(row);
  try{
   await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==origin){remote.push(u.origin);return route.abort();}return route.continue();});
   page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
   page.on('response',r=>{if(['script','stylesheet'].includes(r.request().resourceType()))resources.push({path:new URL(r.url()).pathname,status:r.status()});});
   try{await page.goto(origin+'/#'+app.adminToken+'.'+uiKey,{waitUntil:'domcontentloaded'});}catch{throw new Error('isolated main-page navigation failed');}
   await page.waitForFunction(()=>typeof ChatHandStream==='object'&&typeof ChatHandMorph==='object'&&typeof ChatHandSkin==='object'&&S&&ChatHandStream.status()==='live');
   await page.waitForFunction(()=>document.querySelector('#h10Host [data-screen="f6"]'));
   await page.evaluate(()=>document.fonts.ready);
   assert.equal(await page.evaluate(()=>document.documentElement.dataset.skinSaved),skin);
   assert.equal(await page.evaluate(()=>ChatHandSkin.current()),skin);
   assert.equal(await page.evaluate(()=>document.documentElement.dataset.scheme),scheme);
   assert.equal(await page.evaluate(()=>!!S.settings.setup_complete),false);
   assert.equal(await page.locator('#h10Host button').count()>0,true,'ChatGPT setup choice is available');
   assert.ok(resources.every(r=>r.status===200),JSON.stringify(resources));assert.deepEqual(errors,[]);assert.deepEqual(remote,[]);
   row.modules=['ChatHandStream','ChatHandMorph','ChatHandSkin'];row.setup='h10-f6';row.ok=true;
   if(process.env.CHATHAND_UI_OUTPUT)await page.screenshot({path:path.join(process.env.CHATHAND_UI_OUTPUT,`real-main-${skin}-${scheme}.png`)});
  }finally{await context.close();}
 }
 assert.equal(rows.length,4);
});
