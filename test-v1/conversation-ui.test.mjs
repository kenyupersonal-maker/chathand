import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {start}=require('../test-ui-port/harness/server.js');
const {launchBrowser,NATIVE_SHIM}=require('../test-ui-port/harness/common.js');
const fixtures=require('../test-ui-port/harness/fixtures.js');
test('workbench tasks show known source without invented return links and preserve explicit binding',{skip:process.platform!=='darwin'&&!process.env.CHATHAND_TEST_CHROME},async()=>{
 const srv=await start({port:0}),browser=await launchBrowser();
 try{
  const context=await browser.newContext({viewport:{width:1280,height:1000}});await context.addInitScript(NATIVE_SHIM);const page=await context.newPage();
  const s=fixtures.build('idle',Date.now()),old=s.activity.items.flatMap(g=>g.tasks).slice(0,2);
  const tasks=old.map((t,i)=>({...t,title:'归组任务'+(i+1),status:'completed',session_hash:'a'.repeat(64)}));
  s.tasks=[];s.activity={items:[{id:'session:'+ 'a'.repeat(64),title:'归组验收',tasks,link_source:'not_provided_by_host',conversation_url:null}]};
  await page.route('**/api/state',r=>r.fulfill({json:s}));await page.goto(srv.url+'/?s=idle#token');
  await page.waitForSelector('.recent .rr',{state:'attached'});assert.equal(await page.locator('.recent .rr').count(),2);
  assert.ok((await page.locator('.recent .rr-src').allTextContents()).every(text=>text==='归组验收'));
  await page.locator('[data-tab="done"]').first().click();assert.equal(await page.locator('.rl.all .rr').count(),2);
  await page.locator('.rl.all .rr').first().click();assert.equal(await page.locator('#drawerBody [data-action="openChatURL"]').count(),0);assert.equal(await page.locator('#modal').evaluate(e=>e.open),false);
  assert.equal((await page.evaluate(()=>window.__native)).some(x=>x.action==='focusURL'),false);assert.match(await page.locator('#drawerBody').innerText(),/归组验收/);
  await page.locator('#drawerBody [data-action="bindTask"]').click();assert.match(await page.locator('#modal').innerText(),/（可选）.*同一对话只需粘贴一次/);
  await page.locator('#closeModal').click();s.activity.items[0].conversation_url='https://chatgpt.com/c/test-chat';s.activity.items[0].link_source='auto_detected';
  await page.reload();await page.locator('[data-tab="done"]').first().click();await page.locator('.rl.all .rr').first().click();await page.getByText('自动关联',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'更改关联',exact:true}).count(),1);
 }finally{await browser.close();await srv.close();}
});
