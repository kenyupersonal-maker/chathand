import test from 'node:test';import assert from 'node:assert/strict';import {shouldKeepAwake,KEEP_AWAKE_ACTIVITY_MS} from '../../app/v1/support.mjs';import {desktop} from './1052-a-fixture.mjs';
test('forty-five-minute tool activity boundary excludes idle/pending tasks and future or absent timestamps',()=>{
 const now=10000000,task={task_id:'one',status:'active'},decide=(last,extra={})=>shouldKeepAwake({tasks:[task],settings:{},lastActivity:()=>last,...extra},{now});
 assert.equal(KEEP_AWAKE_ACTIVITY_MS,2700000);assert.equal(decide(now-44*60000-59000),true);assert.equal(decide(now-45*60000),true);assert.equal(decide(now-45*60000-1000),false);assert.equal(decide(0),false);assert.equal(decide(now+1000),false);assert.equal(decide(now,{tasks:[{...task,status:'pending_approval'}]}),false);
 for(const mode of ['task','service'])assert.equal(decide(0,{jobs:[{status:'running',mode}]}),true);
 for(const status of ['completed','failed','pending_approval'])assert.equal(decide(0,{jobs:[{status,mode:'service'}]}),false);
 assert.equal(decide(now,{settings:{keep_awake:false},jobs:[{status:'running',mode:'service'}]}),false);
});
test('full and native snapshots use the same real tool clock; state reads never refresh that clock',async t=>{
 const f=await desktop(t),a=f.app,id=await f.begin();const original=a.tools.resume.lastActivity.bind(a.tools.resume);let last=Date.now()-45*60000-1000;a.tools.resume.lastActivity=task=>task===id?last:original(task);
 const headers={Authorization:`Bearer ${a.adminToken}`,'X-ChatHand-UI':a.uiKey},native=()=>fetch(`http://127.0.0.1:${a.apiPort}/api/native/state`,{headers}).then(r=>r.json());
 assert.equal((await a.snapshot()).keep_awake,false);assert.equal((await native()).keep_awake,false);assert.equal(a.tools.resume.lastActivity(id),last);
 last=Date.now()-44*60000;assert.equal((await a.snapshot()).keep_awake,true);assert.equal((await native()).keep_awake,true);
 a.state.data.keep_awake=false;assert.equal((await native()).keep_awake,false);
});
