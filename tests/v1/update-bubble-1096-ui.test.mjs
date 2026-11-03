import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {chromium} from 'playwright-core';
const require=createRequire(import.meta.url),{start}=require('../ui/1012/server.js');
const output=process.env.CHATHAND_UPDATE_SHOTS;
const chrome=process.env.CHATHAND_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const locales=[['zh','light'],['zh','dark'],['en','light']];

test('1096 real UI: older-data notice moves into update bubble; update click, progress, failure and completion remain in app',{timeout:120000},async t=>{
 const server=await start();t.after(()=>server.close());
 const browser=await chromium.launch({headless:true,executablePath:chrome});t.after(()=>browser.close());
 if(output)fs.mkdirSync(output,{recursive:true});
 const errors=[];
 async function open({before=false}={}){
  const context=await browser.newContext({viewport:{width:980,height:680},locale:'zh-CN'}),page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',route=>new URL(route.request().url()).origin===server.url?route.continue():route.abort());
  if(before)for(const file of ['app.js','local-text-catalogs.js','local-text-catalogs.mjs'])await page.route('**/'+file,route=>route.fulfill({contentType:'application/javascript',body:execFileSync('git',['show','7f101f9:ui/'+file],{encoding:'utf8'})}));
  await page.goto(server.url+'/?task=none&conn=offline&tier=light&auto_update=0&update=available#tok.uikey');
  await page.waitForFunction(()=>typeof S==='object'&&S&&ChatHandStream.status()==='live');
  return {context,page};
 }
 async function set(page,{notice='version',status='available',auto=false,local=false}={}){
  await page.evaluate(({notice,status,auto,local})=>{
   const u={status,availability:'available',version:'9.9.9',current_build:1095,build:9999,notes:'',install:{state:['available','unknown','checking','updated','up_to_date'].includes(status)?'idle':status},...(local?{source:'local',request_id:'local:9999'}:{})};
   if(status==='downloading')Object.assign(u,{progress:.42,downloaded_bytes:42000000,total_bytes:100000000});
   if(status==='failed')Object.assign(u.install,{rolled_back:true,message_key:'update.rolledBack.message',message:'更新失败，请重试。'});
   if(status==='updated')u.just_updated={from:S.version,to:'9.9.9',build_to:9999,tool_schema_changed:false};
   S.startup_notices=notice?[{kind:'newer',format_version:'2',min_app_version:notice==='version'?'9.9.9':null}]:[];
   S.settings.auto_update=auto;S.update=u;S.tools_refresh={state:'idle'};bubbleHidden.clear();regionKeys.clear();scheduleRender();
  },{notice,status,auto,local});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 }
 async function shot(page,name,locale,scheme){
  await page.emulateMedia({colorScheme:scheme});await page.evaluate(({locale,scheme})=>{S.settings.appearance=scheme;document.documentElement.dataset.theme=scheme;ChatHandText.update({locale});scheduleRender();},{locale,scheme});
  await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,name);
  const geometry=await page.locator('#bubble').evaluate(el=>{const b=el.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:innerWidth,height:innerHeight};});
  if(await page.locator('#bubble').isVisible())assert.ok(geometry.left>=0&&geometry.top>=0&&geometry.right<=geometry.width&&geometry.bottom<=geometry.height,JSON.stringify(geometry));
  if(output)await page.screenshot({path:path.join(output,name+'-'+locale+'-'+scheme+'.png')});
 }
 if(output){const {page,context}=await open({before:true});
  for(const notice of ['version','format']){await set(page,{notice});for(const[locale,scheme]of locales)await shot(page,'before-'+notice,locale,scheme);}
  await context.close();
 }
 const {page,context}=await open();t.after(()=>context.close());
 for(const [name,options]of [
  ['newer-version',{}],['newer-format',{notice:'format'}],['newer-unknown',{status:'unknown'}],['newer-checking',{status:'checking'}],
  ['newer-downloading',{status:'downloading'}],['newer-verifying',{status:'verifying'}],['newer-installing',{status:'installing'}],
  ['newer-failed',{status:'failed'}],['newer-still-required',{status:'updated'}],['updated',{notice:null,status:'updated'}],['available-auto-on',{notice:null,auto:true}],
 ]){
  await set(page,options);await page.locator('#bubble').waitFor({state:'visible'});
  assert.equal(await page.locator('#rail [data-k="startup-newer"]').count(),0,name);
  if(name==='newer-version')assert.match(await page.locator('#bubble').textContent(),/9\.9\.9/);
  if(name==='newer-still-required')assert.match(await page.locator('#bubble').textContent(),/9\.9\.9/);
  if(name==='newer-format')assert.match(await page.locator('#bubble').textContent(),/2/);
  if(name==='newer-checking')assert.equal(await page.locator('#bubble [data-action="updateInstall"]').count(),0);
  if(name==='newer-downloading')assert.equal(await page.locator('#bubble [role="progressbar"]').getAttribute('aria-valuenow'),'42');
  for(const[locale,scheme]of locales)await shot(page,'after-'+name,locale,scheme);
 }
 await set(page);await page.evaluate(()=>openDrawer('settings'));
 for(const[locale,scheme]of locales){await shot(page,'after-settings',locale,scheme);assert.equal(await page.locator('#drawer [data-k="startup-newer"]').count(),0);}
 await page.evaluate(()=>closeDrawer());await page.waitForFunction(()=>!document.querySelector('#drawer').open);
 await page.setViewportSize({width:740,height:580});for(const[locale,scheme]of locales)await shot(page,'after-narrow',locale,scheme);
 // Real keyboard activation follows the same update endpoint. No native download/open command is used.
 await set(page);await page.evaluate(()=>{window.__calls=[];document.querySelector('#bubble [data-action="updateInstall"]').focus();});
 await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab');
 assert.equal(await page.evaluate(()=>document.activeElement?.dataset.action),'updateInstall');
 await page.keyboard.press('Enter');
 await page.waitForFunction(()=>__calls.some(c=>c.name==='/api/update/install'));
 const install=await page.evaluate(()=>__calls.filter(c=>c.name==='/api/update/install'));
 assert.equal(install.length,1);assert.equal(install[0].data.version,'9.9.9');
 assert.equal(await page.evaluate(()=>__calls.some(c=>c.kind==='native'&&c.name==='openExternal')),false);
 await page.waitForFunction(()=>S.update.status==='downloading');await page.waitForFunction(()=>S.update.status==='verifying');await page.waitForFunction(()=>S.update.status==='installing');await page.waitForFunction(()=>S.update.status==='updated');
 // Changing the startup notice alone must repaint the bubble (stream patch boundary).
 await set(page,{notice:null,status:'unknown'});await page.locator('#bubble').waitFor({state:'hidden'});
 await page.evaluate(()=>__push({startup_notices:[{kind:'newer',format_version:'2',min_app_version:'9.9.9'}]}));
 await page.locator('#bubble').waitFor({state:'visible'});
 assert.deepEqual(errors,[]);
});
