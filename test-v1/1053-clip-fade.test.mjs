import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{start}=require('../test-ui-port/harness/server.js');
const {launchBrowser,NATIVE_SHIM}=require('../test-ui-port/harness/common.js');
const fixtures=require('../test-ui-port/harness/fixtures.js');

test('natural initial layout, true clipping and streamed long-to-short changes calibrate fade without resize',{skip:process.platform!=='darwin'&&!process.env.CHATHAND_TEST_CHROME},async()=>{
 const srv=await start({port:0}),browser=await launchBrowser();
 try{
  const context=await browser.newContext({viewport:{width:1440,height:650}});await context.addInitScript(NATIVE_SHIM);
  const now=Date.now(),base=fixtures.build('run',now),id=base.tasks[0].task_id;
  const short={...base,tasks:[{...base.tasks[0],title:'核对周报里的数字和图表',jobs:[]}],activity:{items:[]},jobs:[]};
  const long=structuredClone(short);long.tasks[0].jobs=Array.from({length:9},(_,i)=>'synthetic-'+i);
  long.jobs=long.tasks[0].jobs.map((job_id,i)=>({job_id,program:'fixture',args:['stage-'+i],status:i===8?'running':'exited',exit_code:i===8?null:0,started_at:now-(20-i)*60000,finished_at:i===8?null:now-(19-i)*60000,process_alive:i===8,last_line:'合成状态，不执行命令'}));
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>{const u=new URL(r.request().url());return u.origin===srv.url?r.continue():r.abort();});
  await page.route('**/api/state',r=>r.fulfill({json:short}));
  await page.route('**/api/task-changes',r=>r.fulfill({json:{changes:[]}}));
  // The actual stream parser receives authenticated-shaped synthetic input;
  // no private application state or DOM is modified by the test.
  await page.addInitScript(()=>{const fetch0=window.fetch.bind(window);window.fetch=(url,opt)=>{
   if(String(url)==='/api/events')return Promise.resolve(new Response(new ReadableStream({start(c){window.__testState=s=>c.enqueue(new TextEncoder().encode('event: state\ndata: '+JSON.stringify(s)+'\n\n'));}}),{headers:{'Content-Type':'text/event-stream'}}));return fetch0(url,opt);
  };});
  await page.goto(srv.url+'/?s=run#token');await page.waitForSelector('.task-content>.tl-link');
  await page.waitForTimeout(650);
  const info=sel=>page.locator(sel).first().evaluate(el=>({scroll:el.scrollHeight,client:el.clientHeight,fade:el.classList.contains('fade')}));
  const initial=await info('.task-content>.tl-link');assert.ok(initial.scroll<=initial.client+1,JSON.stringify(initial));assert.equal(initial.fade,false,'natural initial short timeline must settle without resize');
  await page.evaluate(s=>window.__testState(s),long);await page.waitForFunction(()=>document.querySelector('.task-content>.tl-link')?.classList.contains('fade'));
  const clipped=await info('.task-content>.tl-link');assert.ok(clipped.scroll>clipped.client+1);
  await page.evaluate(s=>window.__testState(s),short);await page.waitForFunction(()=>{const el=document.querySelector('.task-content>.tl-link');return el&&el.scrollHeight<=el.clientHeight+1&&!el.classList.contains('fade');});
  // Separate synthetic task with five actual output rows; neither file IO nor command execution occurs.
  const output=structuredClone(long);output.tasks[0].task_id='synthetic-output';
  await page.unroute('**/api/task-changes');await page.route('**/api/task-changes',r=>r.fulfill({json:{changes:Array.from({length:5},(_,i)=>({time:now-i*1000,status:'applied',tool:'write_file',path:'/synthetic/output-'+i+'.md',operation_id:'synthetic-output-'+i}))}}));
  await page.evaluate(s=>window.__testState(s),output);await page.waitForFunction(()=>document.querySelector('.task-output-list')?.classList.contains('fade'));
  const outputs=await info('.task-output-list');assert.ok(outputs.scroll>outputs.client+1);
  await page.evaluate(s=>window.__testState(s),short);await page.waitForFunction(()=>!document.querySelector('.task-output-list')&&!document.querySelector('.task-content>.tl-link.fade'));
  assert.equal(await page.evaluate(()=>[...clipNodes].every(([node,owner])=>node.isConnected&&owner.isConnected)),true,'disconnected observed nodes are released after state render');
  assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.querySelector('.task-content>.tl-link').classList.contains('fade')),false);
 }finally{await browser.close();await srv.close();}
});
