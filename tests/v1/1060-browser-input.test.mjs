import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {findChromeApp} from '../../app/v08/chrome-location.mjs';
import {BrowserDriver} from '../../browser-extension/driver.js';
import {INSTALL_HELPERS, screenshotInputMask} from '../../browser-extension/page-helper.js';
import {browserInputError, BrowserController} from '../../app/v07/browser.mjs';
import {snapshotNodes, PersonalChrome} from '../../app/v08/personal-chrome.mjs';

// Owned headless browser only. Every navigation/request is restricted to this loopback fixture.
// Chrome-extension transport metadata is adapted; page DOM, CDP, helpers and input are real.
const html = '<!doctype html><meta charset="utf-8"><title>1060 FAKE INPUT FIXTURE</title><style>body{font:16px monospace}input{width:220px}#editable{width:320px;height:45px;background:white;color:black}#visible-child{visibility:visible}canvas{display:block;background:#bcd;width:200px;height:100px}</style><main><h1>FAKE LOCAL TEST</h1><form id="form"><label>Password<input id="password" type="password" aria-label="Password"></label><button type="submit" aria-label="Login">Login</button></form><label>OTP<input id="otp" autocomplete="one-time-code" aria-label="OTP"></label><input id="plain" aria-label="Plain"><input aria-label="Read only" readonly><input aria-label="Disabled" disabled><input type="file" aria-label="Upload"><button type="button" aria-label="Submit">Submit</button><button type="button" aria-label="Send">Send</button><button type="button" aria-label="Pay">Pay</button><div id="editable" role="textbox" aria-label="Editor" contenteditable="true"><span id="visible-child">FAKE_EDITOR_ALPHA_ONLY</span></div><canvas id="canvas" width="200" height="100" aria-label="Fixture canvas"></canvas><p>Public fixture text.</p></main><script>window.counts={submit:0,click:0,canvas:0};document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();window.counts.submit++});document.querySelectorAll("button[type=button]").forEach(b=>b.addEventListener("click",()=>window.counts.click++));document.querySelector("canvas").addEventListener("click",()=>window.counts.canvas++);</script>';
let browser, server, origin;
test.before(async () => {
  server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  const app=findChromeApp();assert.ok(app,'Installed Chrome is required for this isolated fixture');
  browser=await chromium.launch({executablePath:path.join(app,'Contents/MacOS/Google Chrome'),headless:true,chromiumSandbox:true});
});
test.after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
async function fixture(t) {
  const context=await browser.newContext({viewport:{width:1000,height:750}});
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
  const page=await context.newPage();await page.goto(origin);
  const session=await context.newCDPSession(page),calls=[],hooks={afterInsert:null,afterCapture:null};
  const api={
    tabs:{get:async id=>({id,url:page.url(),title:'1060 FAKE INPUT FIXTURE',groupId:-1,windowId:1}),query:async()=>[],group:async()=>1,update:async()=>({}),reload:async()=>page.reload()},
    tabGroups:{get:async()=>({title:'Ken Bridge'}),query:async()=>[{id:1,title:'Ken Bridge'}],update:async()=>({})},
    windows:{update:async()=>({})},runtime:{getPlatformInfo:async()=>({os:'mac'})},
    debugger:{attach:async()=>{},detach:async()=>{},sendCommand:async(target,method,params={})=>{
      assert.equal(target.tabId,1);assert.equal(target.sessionId,undefined,'This fixture only has a main-frame CDP session');
      calls.push({method,params});
      const result=await session.send(method,params);
      if(method==='Input.insertText'&&hooks.afterInsert)await hooks.afterInsert();
      if(method==='Page.captureScreenshot'&&hooks.afterCapture)await hooks.afterCapture();
      return result;
    }}
  };
  const driver=new BrowserDriver(api,{experience:true,settleMs:20,pollMs:2,idleMs:60000,commandTimeoutMs:5000,actionabilityTimeoutMs:700});
  for(const name of ['Runtime.executionContextsCleared','Runtime.executionContextDestroyed','Page.frameNavigated'])session.on(name,params=>{void driver.onEvent({tabId:1},name,params);});
  t.after(async()=>{await driver.detachAll();await context.close();});
  return {driver,page,calls,hooks,context};
}
async function ref(f,name){const s=await f.driver.execute('snapshot',{page_id:'1',allow_personal:false});const node=s.elements.find(n=>n.name===name);assert.ok(node,'Expected fixture ref '+name);return node.ref;}
const clean=(receipt,fake)=>assert.equal(JSON.stringify(receipt).includes(fake),false,'Observation/receipt must not export fixture input');

test('1060 real extension driver fills password and OTP, and Enter performs only local fixture submission',async t=>{
  const f=await fixture(t);
  for(const [name,id,fake] of [['Password','password','FAKE_PASSWORD_1060_ONLY'],['OTP','otp','FAKE_OTP_1060_ONLY']]){
    const result=await f.driver.execute('fill',{page_id:'1',ref:await ref(f,name),text:fake,confirm:false,allow_personal:false});
    assert.equal(result.status,'completed',result.error?.code);
    assert.equal(await f.page.locator('#'+id).evaluate((node,value)=>node.value===value,fake),true);
    clean(result,fake);clean(await f.driver.execute('snapshot',{page_id:'1'}),fake);clean(await f.driver.execute('read',{page_id:'1'}),fake);
  }
  const pressed=await f.driver.execute('press',{page_id:'1',ref:await ref(f,'Password'),key:'Enter',confirm:false});
  assert.equal(pressed.status,'completed',pressed.error?.code);assert.equal(await f.page.evaluate(()=>window.counts.submit),1);
  for(const name of ['Login','Submit','Send','Pay']){const result=await f.driver.execute('click',{page_id:'1',ref:await ref(f,name),confirm:false});assert.equal(result.status,'completed',result.error?.code);}
  assert.deepEqual(await f.page.evaluate(()=>window.counts),{submit:2,click:3,canvas:0});
});

test('1060 real read and snapshot retain ordinary editor text',async t=>{
  const f=await fixture(t),fake='FAKE_EDITOR_ALPHA_ONLY';
  for(const explicitRole of [true,false]){
    if(!explicitRole)await f.page.locator('#editable').evaluate(node=>node.removeAttribute('role'));
    assert.match(JSON.stringify(await f.driver.execute('snapshot',{page_id:'1'})),/FAKE_EDITOR_ALPHA_ONLY/);
    assert.match(JSON.stringify(await f.driver.execute('read',{page_id:'1'})),/FAKE_EDITOR_ALPHA_ONLY/);
    await f.page.evaluate(INSTALL_HELPERS);
  }
});

test('1060 screenshot mask keeps ordinary editor visible and covers identified sensitive editor',async t=>{
  const f=await fixture(t),a='FAKE_EDITOR_ALPHA_ONLY',b='FAKE_EDITOR_BRAVO_ONLY',clip=await f.page.locator('#editable').boundingBox();
  const beforeA=await f.page.screenshot({clip,caret:'hide'});await f.page.locator('#visible-child').evaluate((node,value)=>node.textContent=value,b);
  const beforeB=await f.page.screenshot({clip,caret:'hide'});assert.equal(beforeA.equals(beforeB),false,'Control: unmasked fake text must alter pixels');
  const run=(action)=>f.page.evaluate(({source,action})=>(0,eval)('('+source+')')(action,'fake-mask-token'),{source:screenshotInputMask.toString(),action});
  assert.equal(await run('apply'),true);assert.equal(await run('check'),true);const ordinaryB=await f.page.screenshot({clip,caret:'hide'});await f.page.locator('#visible-child').evaluate((node,value)=>node.textContent=value,a);const ordinaryA=await f.page.screenshot({clip,caret:'hide'});assert.equal(ordinaryA.equals(ordinaryB),false);await run('remove');
  await f.page.locator('#editable').evaluate(node=>node.setAttribute('aria-label','OTP editor'));
  assert.equal(await run('apply'),true);assert.equal(await run('check'),true);
  const maskedA=await f.page.screenshot({clip,caret:'hide'});await f.page.locator('#visible-child').evaluate((node,value)=>node.textContent=value,b);const maskedB=await f.page.screenshot({clip,caret:'hide'});
  try{assert.equal(maskedA.equals(maskedB),true,'Sensitive editor pixels must not vary with fake contents');assert.equal(await run('check'),false,'Protected content changed during capture');}finally{await run('remove');}
  assert.equal(await f.page.locator('#editable').evaluate(node=>getComputedStyle(node).visibility==='visible'&&getComputedStyle(node).opacity==='1'),true);
  assert.equal(await f.page.locator('#visible-child').evaluate((node,value)=>node.textContent===value,b),true);
});

test('1060 uncertain insert sanitizes arbitrary code/message/details and never replays a batch step',async t=>{
  const f=await fixture(t),fake='FAKE_ERROR_ONLY',target=await ref(f,'Plain');
  f.hooks.afterInsert=()=>{throw Object.assign(Error(fake),{code:fake,details:{value:fake}});};
  const args={page_id:'1',operation_key:'fixture:unknown',steps:[{step_id:'once',action:'fill',ref:target,text:fake}]};
  const result=await f.driver.execute('batch',args);
  assert.equal(await f.page.locator('#plain').evaluate((node,value)=>node.value===value,fake),true,'Unknown result may have delivered input');
  assert.equal(result.steps[0].status,'failed_or_unknown');assert.equal(result.error.details.do_not_replay,true);clean(result,fake);
  const count=f.calls.filter(c=>c.method==='Input.insertText').length;
  const retry=await f.driver.execute('batch',args);assert.equal(retry.error.code,'STEP_ALREADY_ATTEMPTED');assert.equal(f.calls.filter(c=>c.method==='Input.insertText').length,count);
});

test('1060 coordinate click requires a current screenshot, finite viewport canvas and current document',async t=>{
  const f=await fixture(t),point=await f.page.locator('#canvas').evaluate(node=>{const r=node.getBoundingClientRect();return {x:r.x+20,y:r.y+20};});
  let snapshot=await f.driver.execute('snapshot',{page_id:'1'});
  let result=await f.driver.execute('click',{page_id:'1',snapshot_id:snapshot.snapshot_id,coordinate:true,...point,confirm:false});
  assert.equal(result.error.code,'SNAPSHOT_STALE');
  for(const invalid of [{x:NaN,y:10},{x:-1,y:10},{x:9999,y:10},{x:4,y:4}]){
    snapshot=await f.driver.execute('screenshot',{page_id:'1'});assert.ok(snapshot.image_base64,'Validated screenshot must exist');
    result=await f.driver.execute('click',{page_id:'1',snapshot_id:snapshot.snapshot_id,coordinate:true,...invalid,confirm:false});
    assert.equal(result.error.code,Number.isFinite(invalid.x)?'CANVAS_TARGET_REQUIRED':'ARG_INVALID');
  }
  snapshot=await f.driver.execute('screenshot',{page_id:'1'});
  result=await f.driver.execute('click',{page_id:'1',snapshot_id:snapshot.snapshot_id,coordinate:true,...point,confirm:false});
  assert.equal(result.status,'completed',result.error?.code);assert.equal(await f.page.evaluate(()=>window.counts.canvas),1);
  snapshot=await f.driver.execute('screenshot',{page_id:'1'});await f.page.reload();
  result=await f.driver.execute('click',{page_id:'1',snapshot_id:snapshot.snapshot_id,coordinate:true,...point});
  assert.equal(result.error.code,'SNAPSHOT_STALE');
});

test('1060 document replacement during capture discards the screenshot',async t=>{
  const f=await fixture(t);f.hooks.afterCapture=async()=>{f.hooks.afterCapture=null;await f.page.reload();};
  await assert.rejects(()=>f.driver.execute('screenshot',{page_id:'1'}),error=>error.code==='SCREENSHOT_REDACTION_UNAVAILABLE'&&!JSON.stringify(error).includes('image_base64'));
});

test('1060 real invalid file, readonly, disabled and key targets preserve guards',async t=>{
  const f=await fixture(t);
  for(const [name,code] of [['Upload','FILE_INPUT_REQUIRED'],['Read only','ELEMENT_EDITABLE'],['Disabled','ELEMENT_DISABLED']]){
    const target=await ref(f,name),count=f.calls.filter(c=>c.method.startsWith('Input.')).length;
    const result=await f.driver.execute('fill',{page_id:'1',ref:target,text:'FAKE_GUARD_1060_ONLY'});
    assert.equal(result.error.code,code);assert.equal(f.calls.filter(c=>c.method.startsWith('Input.')).length,count);
  }
  const result=await f.driver.execute('press',{page_id:'1',ref:await ref(f,'Plain'),key:'NOT_A_REAL_KEY'});assert.equal(result.error.code,'KEY_UNSUPPORTED');
});

test('1060 managed/personal input errors accept only fixed safe codes',()=>{
  const fake='FAKE_CODE_1060_ONLY',error=browserInputError(Object.assign(Error(fake),{code:fake,details:{text:fake}}));clean({code:error.code,message:error.message,details:error.details},fake);assert.equal(error.details.do_not_replay,true);
  assert.equal(browserInputError({code:'ACTION_CANCELLED'}).code,'ACTION_CANCELLED');
  assert.equal(browserInputError({code:'TASK_REVOKED'}).code,'TASK_REVOKED');
});

test('1060 personal text fallback suppresses private descendant lines but retains sibling labels',()=>{
  const fake='FAKE_TEXT_FALLBACK_1060_ONLY';
  const nodes=snapshotNodes({content:[{type:'text',text:'uid=root RootWebArea "Fixture"\n  uid=field textbox "OTP"\n    uid=value StaticText "'+fake+'"\n  uid=button button "Continue"'}]});
  clean(nodes,fake);assert.ok(nodes.some(n=>n.name==='Continue'));assert.ok(nodes.some(n=>n.name==='OTP'));
});

test('1060 personal screenshot accepts only a redacted vendor receipt',async t=>{
  const calls=[],state={data:{mode:'full',active:'fixture',browser_backend:'personal'},save(){}},policy={epoch:1,check(){}},transport={redacted:true,call:async function(name){calls.push(name);if(name==='list_pages')return {structuredContent:{pages:[{id:1,url:'http://127.0.0.1/fixture',title:'Fixture'}]}};if(name==='take_screenshot')return {content:[{type:'text',text:this.redacted?'CHATHAND_SCREENSHOT_REDACTION {"redaction_scope":"identified_sensitive_controls","redaction_limitations":["opaque_shadow_content_not_inspected"],"masked_regions":1}':'Took a screenshot.'},{type:'image',mimeType:'image/jpeg',data:'ZmFrZQ=='}]};throw Error('Unexpected call');},stop:async()=>{}};
  const c=new PersonalChrome(state,{stateDir:'/tmp/1060-fake-unused'},policy,{transportFactory:()=>transport,chromeInfo:()=>({installed:true,supported:true,minimum_major:144})});t.after(()=>c.closeAll());
  await c.connect();const p=(await c.tabs({action:'list'},'fixture')).tabs[0];
  const shot=await c.screenshot({page_id:p.page_id},'fixture');assert.equal(shot.redaction_scope,'identified_sensitive_controls');assert.equal(shot.masked_regions,1);transport.redacted=false;await assert.rejects(()=>c.screenshot({page_id:p.page_id},'fixture'),{code:'CHATHAND_SCREENSHOT_METADATA_MISSING'});assert.equal(calls.includes('take_screenshot'),true);
});

function managedFor(f){
  const state={data:{mode:'full',active:'fixture'}},controller=new BrowserController(state,{stateDir:'/tmp/1060-fake-unused'},{epoch:1,check(){}},{headless:true});
  controller.pages.set('fixture',{page:f.page,session:{key:controller.key('fixture')}});
  return controller;
}
test('1060 managed screenshot is masked and discarded on same-URL document or frame replacement',async t=>{
  for(const scenario of ['stable','reload','frame']){
    const f=await fixture(t),controller=managedFor(f),capture=f.page.screenshot.bind(f.page);
    if(scenario!=='stable')f.page.screenshot=async args=>{const image=await capture(args);if(scenario==='reload')await f.page.reload();else await f.page.evaluate(()=>document.body.append(document.createElement('iframe')));return image;};
    if(scenario==='stable'){const shot=await controller.screenshot({page_id:'fixture'},'fixture');assert.ok(shot.image_base64);assert.equal(Buffer.from(shot.image_base64,'base64')[0],255);}
    else await assert.rejects(()=>controller.screenshot({page_id:'fixture'},'fixture'),{code:'SCREENSHOT_REDACTION_UNAVAILABLE'});
  }
});
test('1060 unknown closed shadow is disclosed as screenshot coverage limit',async t=>{
  for(const backend of ['managed','extension']){
    const f=await fixture(t);await f.page.evaluate(()=>{const host=document.body.appendChild(document.createElement('div'));const root=host.attachShadow({mode:'closed'});const input=root.appendChild(document.createElement('input'));input.value='FAKE_CLOSED_SHADOW_ONLY';});
    const action=backend==='managed'?()=>managedFor(f).screenshot({page_id:'fixture'},'fixture'):()=>f.driver.execute('screenshot',{page_id:'1'});
    const shot=await action();assert.ok(shot.image_base64);assert.ok(shot.redaction_limitations.includes('opaque_shadow_content_not_inspected'));
  }
});
