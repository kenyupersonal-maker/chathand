import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {chromium} from 'playwright-core';
import {HIGH_RISK, NEVER, highRiskError} from '../../app/v1/high-risk.mjs';
import {capabilityError} from '../../app/v1/permissions.mjs';

const require=createRequire(import.meta.url),{start}=require('../ui/1012/server.js');
const root=path.resolve(import.meta.dirname,'../..');
const catalogs=Object.fromEntries(['zh','en'].map(lang=>[lang,JSON.parse(fs.readFileSync(path.join(root,'locales',lang+'.json'),'utf8'))]));
const chrome=process.env.CHATHAND_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shots=process.env.CHATHAND_PERMISSION_SHOTS;

test('permission list and confirmation use the selected language without changing permissions',{timeout:120000},async t=>{
 const server=await start();t.after(()=>server.close());
 const browser=await chromium.launch({headless:true,executablePath:chrome});t.after(()=>browser.close());
 if(shots){
  fs.mkdirSync(shots,{recursive:true});
  const before=await browser.newContext({viewport:{width:980,height:760}}),p=await before.newPage();
  await before.route('**/*',route=>new URL(route.request().url()).origin===server.url?route.continue():route.abort());
  await p.addInitScript(({risks,never,note})=>{window.__permissionFixture={risks,never,note};},{risks:HIGH_RISK,never:NEVER.map(n=>n.name),note:catalogs.zh['permissions.highRiskNote.folder']});
  const fake=fs.readFileSync(path.join(root,'tests/ui/1012/fake.js'),'utf8');
  await p.route('**/__fake.js',route=>route.fulfill({contentType:'text/javascript',body:fake.replace('return st;','st.high_risk.items=window.__permissionFixture.risks;st.high_risk_catalog=window.__permissionFixture.risks;st.permissions.never=window.__permissionFixture.never;st.permissions.high_risk_note=window.__permissionFixture.note;return st;')}));
  for(const file of ['app.js','local-text-catalogs.js','local-text-catalogs.mjs'])await p.route('**/'+file,route=>route.fulfill({contentType:'application/javascript',body:execFileSync('git',['show','origin/main:ui/'+file],{encoding:'utf8'})}));
  await p.goto(server.url+'/?task=none&conn=online&tier=light#tok.uikey');await p.waitForFunction(()=>typeof S==='object'&&S&&ChatHandStream.status()==='live');
  await p.evaluate(()=>{document.querySelector('#setupWizard').hidden=true;document.querySelector('#h10Host').hidden=true;document.querySelector('#app').inert=false;openDrawer('terminal');});
  for(const [lang,scheme] of [['zh','light'],['zh','dark'],['en','light']]){
   await p.emulateMedia({colorScheme:scheme});await p.evaluate(({lang,scheme})=>{S.settings.appearance=scheme;document.documentElement.dataset.theme=scheme;ChatHandText.update({locale:lang});regionKeys.clear();scheduleRender();},{lang,scheme});
   await p.locator('#risk-chatgpt_self').scrollIntoViewIfNeeded();await p.waitForTimeout(400);await p.screenshot({path:path.join(shots,`before-list-end-${lang}-${scheme}.png`)});
   await p.locator('#risk-chatgpt_self [data-toggle="risk:chatgpt_self"]').click();await p.waitForTimeout(400);await p.screenshot({path:path.join(shots,`before-dialog-${lang}-${scheme}.png`)});await p.locator('#modal [data-action="askNo"]').click();
  }
  await before.close();
 }
 const context=await browser.newContext({viewport:{width:980,height:760}});t.after(()=>context.close());
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/*',route=>new URL(route.request().url()).origin===server.url?route.continue():route.abort());
 await page.addInitScript(({risks,never,note})=>{window.__permissionFixture={risks,never,note};},{risks:HIGH_RISK,never:NEVER.map(n=>n.name),note:catalogs.zh['permissions.highRiskNote.folder']});
 const fake=fs.readFileSync(path.join(root,'tests/ui/1012/fake.js'),'utf8');
 assert.equal(fake.split('return st;').length,2);
 await page.route('**/__fake.js',route=>route.fulfill({contentType:'text/javascript',body:fake.replace('return st;','st.high_risk.items=window.__permissionFixture.risks;st.high_risk_catalog=window.__permissionFixture.risks;st.permissions.never=window.__permissionFixture.never;st.permissions.high_risk_note=window.__permissionFixture.note;return st;')}));
 await page.goto(server.url+'/?task=none&conn=online&tier=light#tok.uikey');
 await page.waitForFunction(()=>typeof S==='object'&&S&&ChatHandStream.status()==='live');
 await page.evaluate(()=>{document.querySelector('#setupWizard').hidden=true;document.querySelector('#h10Host').hidden=true;document.querySelector('#app').inert=false;openDrawer('terminal');});
 const original=await page.evaluate(()=>JSON.stringify({items:S.high_risk.items,settings:S.settings.high_risk}));
 async function locale(lang,scheme='light'){
  await page.emulateMedia({colorScheme:scheme});
  await page.evaluate(({lang,scheme})=>{S.settings.appearance=scheme;document.documentElement.dataset.theme=scheme;ChatHandText.update({locale:lang});regionKeys.clear();scheduleRender();},{lang,scheme});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 }
 async function screenshot(name){if(!shots)return;fs.mkdirSync(shots,{recursive:true});await page.waitForTimeout(400);await page.screenshot({path:path.join(shots,name+'.png')});}
 for(const [lang,scheme] of [['zh','light'],['zh','dark'],['en','light']]){
  await locale(lang,scheme);
  for(const risk of HIGH_RISK.filter(r=>r.group==='danger')){
   const row=page.locator('#risk-'+risk.id),content=await row.textContent();
   for(const field of ['name','what','harm'])assert.ok(content.includes(catalogs[lang][`permissions.risk.${risk.id}.${field}`]),`${lang} ${risk.id} ${field}`);
   assert.ok(content.includes(catalogs[lang][`permissions.level.${risk.level==='高'?'high':risk.level==='中'?'medium':'extreme'}`]),`${lang} ${risk.id} level`);
   if(lang==='en')assert.doesNotMatch(content,/\p{Script=Han}/u,`unexpected Chinese in ${risk.id}`);
  }
  assert.ok((await page.locator('#drawer .dp-note').allTextContents()).some(s=>s.includes(catalogs[lang]['permissions.highRiskNote.folder'])));
  const footer=await page.locator('#drawer .dp-foot').textContent();
  for(const n of NEVER)assert.ok(footer.includes(catalogs[lang][`permissions.never.${n.id}.name`]),`${lang} never ${n.id}`);
  await screenshot(`list-${lang}-${scheme}`);
  await page.locator('#risk-chatgpt_self').scrollIntoViewIfNeeded();await screenshot(`list-end-${lang}-${scheme}`);
  await page.locator('#risk-chatgpt_self [data-toggle="risk:chatgpt_self"]').click();await screenshot(`dialog-${lang}-${scheme}`);await page.locator('#modal [data-action="askNo"]').click();
  assert.equal(await page.locator('#drawerBody').evaluate(el=>el.scrollWidth>el.clientWidth),false,`${lang} horizontal overflow`);
 }
 for(const risk of HIGH_RISK.filter(r=>r.group==='danger')){
  await page.locator(`#risk-${risk.id} [data-toggle="risk:${risk.id}"]`).click();
  const modal=page.locator('#modal');await modal.waitFor({state:'visible'});
  const content=await modal.textContent();
  for(const field of ['name','what','harm'])assert.ok(content.includes(catalogs.en[`permissions.risk.${risk.id}.${field}`]),`dialog ${risk.id} ${field}`);
  assert.doesNotMatch(content,/\p{Script=Han}/u,`unexpected Chinese in ${risk.id} dialog`);
  if(risk.id==='chatgpt_self')await screenshot('dialog-en-light');
  await modal.locator('[data-action="askNo"]').click();await modal.waitFor({state:'hidden'});
 }
 assert.equal(await page.evaluate(()=>JSON.stringify({items:S.high_risk.items,settings:S.settings.high_risk})),original);
 assert.equal(await page.evaluate(()=>window.__calls.some(c=>c.kind==='post'&&c.name==='/api/settings'&&c.data?.high_risk)),false);
 await locale('zh');
 await page.setViewportSize({width:740,height:580});await locale('en');await page.locator('#risk-chatgpt_self [data-toggle="risk:chatgpt_self"]').click();
 assert.equal(await page.locator('#modal').evaluate(el=>el.scrollWidth>el.clientWidth),false,'narrow confirmation horizontal overflow');await screenshot('dialog-en-narrow');await page.locator('#modal [data-action="askNo"]').click();
 await page.evaluate(()=>{S.high_risk.items=[...S.high_risk.items,{id:'future',group:'danger',name:'Custom warning',what:'Custom action',harm:'Custom risk',level:'高',level_text:'高',cmd:'example'}];S.permissions.never=[...S.permissions.never,'Future policy'];regionKeys.clear();scheduleRender();});
 await locale('en');
 assert.match(await page.locator('#risk-future').textContent(),/Custom warning.*Custom action.*Custom risk/);
 assert.match(await page.locator('#drawer .dp-foot').textContent(),/Future policy/);
 const command='echo \"测试: example\"';
 for(const blocked of [highRiskError('chatgpt_self',{command}).details.blocked,capabilityError('browser',{command}).details.blocked]){
  const card={...blocked,id:'sample',state:'waiting',expires_at:Date.now()+60000,scopes:['always']};
  const text=await page.evaluate(card=>{const el=document.createElement('div');el.innerHTML=confirmationCard(card);return el.textContent;},card);
  const prefix=blocked.gate==='capability'?'permissions.capability.browser':'permissions.risk.chatgpt_self';
  for(const field of ['name','what',blocked.gate==='capability'?'risk':'harm'])assert.ok(text.includes(catalogs.en[`${prefix}.${field}`]),`card ${field}`);
  assert.ok(text.includes(command),'command must stay unchanged');
  assert.ok(!text.includes(blocked.cause.slice(command.length+1)),'known cause is localized');
 }
 const history=await page.evaluate(()=>{S.permissions.history=[{event_id:'sample',action:'grant',gate:'high_risk',id:'chatgpt_self',name:'操作 ChatGPT 自己的网页和桌面版',at:Date.now(),scope:'always'}];return pgAlwaysAllowed();});
 assert.ok(history.includes(catalogs.en['permissions.risk.chatgpt_self.name']));
 assert.doesNotMatch(history,/操作 ChatGPT/);
 assert.deepEqual(errors,[]);
});
