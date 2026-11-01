import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {start}=require('../ui/harness/server.js');
const {launchBrowser,NATIVE_SHIM}=require('../ui/harness/common.js');
const fixtures=require('../ui/harness/fixtures.js');

test('1048 task stop, revocation details and offline connection choice use only their intended targets',{skip:process.platform!=='darwin'&&!process.env.CHATHAND_TEST_CHROME},async()=>{
 const srv=await start({port:0}),browser=await launchBrowser();
 try{
  const context=await browser.newContext({viewport:{width:1280,height:1000}});await context.addInitScript(NATIVE_SHIM);const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const state=fixtures.build('run',Date.now()),first=state.tasks[0];state.tasks.push({...first,task_id:'second-independent-task',title:'第二个任务',jobs:[]});
  state.permissions={tier:'custom',history_status:{available:true,persisted:true,error_code:null},history:[{event_id:'synthetic-grant',action:'grant',gate:'capability',id:'browser',name:'浏览器控制',at:Date.now(),scope:'always',via:'window',active:true}],always_allowed:[{gate:'capability',id:'browser',name:'浏览器控制',since:null,via:'settings'}]};const mutations=[];let receivedRevoke;const revokeReceipt=new Promise(resolve=>{receivedRevoke=resolve;});
  await page.route('**/api/state',r=>r.fulfill({json:state}));
  await page.route('**/api/tasks/stop',r=>{const body=r.request().postDataJSON();mutations.push({path:'/api/tasks/stop',body});state.tasks.find(t=>t.task_id===body.id).status='cancelled';return r.fulfill({json:{ok:true}});});
  await page.route('**/api/access',r=>{mutations.push({path:'/api/access'});return r.fulfill({json:{}});});
  await page.route('**/api/automation/stop',r=>{mutations.push({path:'/api/automation/stop'});return r.fulfill({json:{}});});
  await page.route('**/api/permissions/revoke',r=>{const body=r.request().postDataJSON();mutations.push({path:'/api/permissions/revoke',body});state.permissions.always_allowed=[];receivedRevoke();return r.fulfill({json:{ok:true}});});
  await page.goto(srv.url+'/?s=run#token');const stop=page.getByRole('button',{name:'停止',exact:true}),displayedId=await stop.getAttribute('data-id');assert.equal(displayedId,'second-independent-task');await stop.click();
  assert.deepEqual(mutations,[{path:'/api/tasks/stop',body:{id:displayedId}}]);assert.equal(state.tasks[0].status,'active');assert.equal(state.enabled,true);
  assert.equal(await page.locator('.rail-stick .always-allowed').count(),0);
  const hint=page.getByRole('button',{name:'知道了',exact:true});if(await hint.isVisible())await hint.click();await page.locator('.rail-stick [data-action="drawer"][data-id="settings"]').click();
  await page.locator('#drawerBody [data-id="alwaysAllowed"]').click();assert.match(await page.locator('#drawerBody').innerText(),/浏览器控制/);assert.doesNotMatch(await page.locator('#drawerBody').innerText(),/时间未知/);
  assert.equal(await page.getByRole('button',{name:'撤回',exact:true}).count(),0,'history is read-only');await page.getByRole('button',{name:'在设置中查看',exact:true}).click();assert.match(await page.locator('#drawerBody').innerText(),/浏览器控制/);
  // Keep the existing synthetic revoke route/body contract independently of the retired history button.
  await page.evaluate(()=>fetch('/api/permissions/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gate:'capability',id:'browser'})}));await revokeReceipt;assert.equal(await page.locator('#modal [data-action="askYes"]').count(),0,'revocation is direct; undo is the reviewed recovery path');
  assert.deepEqual(mutations.at(-1),{path:'/api/permissions/revoke',body:{gate:'capability',id:'browser'}});
  state.settings.connection_preference='relay';state.connection.ready=false;state.connection.healthy=false;state.connection.control_plane.state='down';state.relay={online:false,paired:true};await page.reload();
  assert.equal(await page.locator('.cc-a use').getAttribute('href'),'#i-site');assert.equal(await page.locator('.cc-n b').innerText(),'OpenAI 快捷连接');
  state.settings.connection_preference='tunnel';state.relay.online=true;await page.reload();
  assert.equal(await page.locator('.cc-a use').getAttribute('href'),'#i-tunnel');assert.equal(await page.locator('.cc-n b').innerText(),'OpenAI 通道');assert.deepEqual(errors,[]);
 }finally{await browser.close();await srv.close();}
});
