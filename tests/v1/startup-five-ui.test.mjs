import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {startupFixture} from '../support/startup-five-fixture.mjs';

const output=process.env.CHATHAND_STARTUP_SHOTS;
test('real startup notices render in Chinese light/dark and English light, with working download and dismiss controls',{timeout:90000},async t=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHATHAND_TEST_CHROME?{executablePath:process.env.CHATHAND_TEST_CHROME}:{})});t.after(()=>browser.close());
 if(output)fs.mkdirSync(output,{recursive:true});
 for(const name of ['before','newer-format','newer-version','settings-recovered','lock-recovered']){
  let original;
  const f=await startupFixture(t,{prepare:f=>{
   const file=path.join(f.stateDir,'desktop.json');
   if(name.startsWith('newer')){original=JSON.stringify({format:'chathand-desktop-v2',...(name==='newer-version'?{min_app_version:'9.9.9'}:{}),payload:{preserve:true}});fs.writeFileSync(file,original);}
   if(name==='settings-recovered')fs.writeFileSync(file,'{broken');
   if(name==='lock-recovered')fs.writeFileSync(path.join(f.stateDir,'app.lock'),'{broken');
  }});
  const context=await browser.newContext({viewport:{width:980,height:680},locale:'zh-CN'}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',route=>new URL(route.request().url()).origin===f.origin?route.continue():route.abort());
  await context.addInitScript(()=>{window.__startupNativeCalls=[];window.webkit={messageHandlers:{native:{postMessage(message){window.__startupNativeCalls.push(message);queueMicrotask(()=>window.nativeReply?.({id:message.id,result:message.action==='getLocalTextCatalogs'?{locale:'zh',preference:'zh'}:{}}));}}}};});
  await page.goto(f.origin+'/#'+f.adminToken+'.'+f.uiKey,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>typeof S==='object'&&S&&ChatHandStream.status()==='live');
  if(name==='before'){
   if(await page.locator('#h10Host [data-action="dismiss"]').isVisible())await page.locator('#h10Host [data-action="dismiss"]').click();
   if(await page.locator('#drawer[open]').count())await page.evaluate(()=>closeDrawer());await page.waitForFunction(()=>!document.querySelector('#drawer').open);
  }else{
   assert.equal(await page.locator('#drawer[open]').count(),0,name+': startup recovery explanation must be visible before automatic connection setup');
   assert.equal(await page.locator('#h10Host:not([hidden])').count(),0,name);
  }
  const selector=name==='settings-recovered'?'[data-k="settings-recovery"]':name==='lock-recovered'?'[data-k="startup-lock_recovered"]':'#bubble';
  if(name==='lock-recovered'){await page.waitForFunction(()=>(S?.startup_notices||[]).some(notice=>notice.kind==='lock_recovered'));assert.equal(await page.locator(selector).count(),0,'a recovered startup record needs no action and is not shown (Ken 11/3)');}
  else if(name!=='before')await page.locator(selector).waitFor({state:'visible'});
  for(const[locale,scheme]of [['zh','light'],['zh','dark'],['en','light']]){
   await page.emulateMedia({colorScheme:scheme});await page.evaluate(locale=>ChatHandText.update({locale}),locale);await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   if(name==='newer-version')assert.match(await page.locator(selector).textContent(),/9\.9\.9/);
   if(name==='newer-format'){assert.doesNotMatch(await page.locator(selector).textContent(),/9\.9\.9/);assert.match(await page.locator(selector).textContent(),/2/);}
   if(output)await page.screenshot({path:path.join(output,name+'-'+locale+'-'+scheme+'.png'),fullPage:true});
  }
  await page.setViewportSize({width:740,height:680});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  if(name.startsWith('newer')){assert.equal(await page.locator('#bubble [data-action="checkUpdate"]').isVisible(),true);assert.equal(await page.locator('[data-action="startupDownload"]').count(),0);assert.equal(await page.evaluate(()=>__startupNativeCalls.some(message=>message.action==='openExternal')),false);assert.equal(fs.readFileSync(path.join(f.stateDir,'desktop.json'),'utf8'),original);}
  if(name==='settings-recovered'){await page.locator('[data-action="settingsRecoveryDismiss"]').click();await page.locator(selector).waitFor({state:'hidden'});assert.equal((await f.request('/api/state')).body.settings.settings_recovery_notice,false);}
  assert.deepEqual(errors,[]);await context.close();await f.close();
 }
});
