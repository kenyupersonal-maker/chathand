import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {siteDeliveryReady,runSiteExecution} from '../../app/v1/site-execution-context.mjs';
import {ExtensionBrowser} from '../../app/v09/extension-browser.mjs';
import {storeTestDistribution,storeTestHelper} from '../support/chrome-store-fixture.mjs';

const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function clock(t){let now=1;t.mock.method(performance,'now',()=>now);return {advance(ms){now+=ms;}};}
function browser(t){
 const state={data:{mode:'auto',browser_enabled:true},project:()=>({path:'/synthetic'}),save(){}},policy={epoch:1,permissionRevision:0,check(){},require(){},tasks:new Map()},session=crypto.randomUUID(),helper=storeTestHelper();
 const extension=new ExtensionBrowser(state,{},policy,{distribution:storeTestDistribution()});
 extension.next(session,helper);extension.pauseRequested=false;
 t.after(()=>extension.closeAll());
 return {extension,policy,state,poll:()=>extension.next(session,helper),session};
}

test('Site browser work reaches the next 400ms host poll after fast authorization',async t=>{
 const time=clock(t),f=browser(t);let starts=0;
 const response=runSiteExecution({assert(){},async beforeStart(){starts++;}},()=>f.extension.request('snapshot',{},'fixture','task'));
 assert.equal(f.poll().kind,'status');await flush();time.advance(400);
 const delivered=f.poll();assert.equal(delivered.kind,'request');assert.equal(delivered.action,'snapshot');assert.equal(starts,1);
 f.extension.complete(f.session,delivered.id,{ok:true});assert.deepEqual(await response,{ok:true});
});

test('OpenAI work keeps immediate host delivery without a Site start check',async t=>{
 clock(t);const f=browser(t),response=f.extension.request('snapshot',{},'fixture','task'),delivered=f.poll();
 assert.equal(delivered.kind,'request');f.extension.complete(f.session,delivered.id,{ok:true});assert.deepEqual(await response,{ok:true});
});

test('readiness expires after bounded scheduling headroom and reauthorizes',async t=>{
 const time=clock(t);let starts=0;const holder={siteExecution:{assert(){},async beforeStart(){starts++;}}};
 assert.equal(siteDeliveryReady(holder),false);await flush();time.advance(501);
 assert.equal(siteDeliveryReady(holder),false);await flush();assert.equal(starts,2);time.advance(400);assert.equal(siteDeliveryReady(holder),true);
});

test('an unfinished or rejected start check never grants delivery',async t=>{
 const time=clock(t);let reject;const holder={siteExecution:{assert(){},beforeStart:()=>new Promise((_,r)=>{reject=r;})}};
 assert.equal(siteDeliveryReady(holder),false);await flush();time.advance(400);assert.equal(siteDeliveryReady(holder),false);
 reject(Object.assign(Error('rejected'),{code:'WS_START_REJECTED'}));await flush();assert.throws(()=>siteDeliveryReady(holder),{code:'WS_START_REJECTED'});
});

for(const change of ['revoked','identity_changed','generation_changed'])test('current capability '+change+' blocks already-ready Site delivery',async t=>{
 const time=clock(t);let current=true;const holder={siteExecution:{assert(){if(!current)throw Object.assign(Error(change),{code:'WS_EXECUTION_EXPIRED'});},async beforeStart(){}}};
 assert.equal(siteDeliveryReady(holder),false);await flush();time.advance(400);current=false;
 assert.throws(()=>siteDeliveryReady(holder),{code:'WS_EXECUTION_EXPIRED'});
});

for(const change of ['epoch','permissionRevision','browser_enabled'])test('browser '+change+' change blocks ready Site work at the host poll',async t=>{
 const time=clock(t),f=browser(t),response=runSiteExecution({assert(){},async beforeStart(){}},()=>f.extension.request('snapshot',{},'fixture','task'));
 const rejection=assert.rejects(response,{code:'TASK_REVOKED'});assert.equal(f.poll().kind,'status');await flush();time.advance(400);
 if(change==='browser_enabled')f.state.data.browser_enabled=false;else f.policy[change]++;
 assert.equal(f.poll().kind,'status');await rejection;assert.equal(f.extension.pending.size,0);
});

test('revocation during an in-flight start check remains fail closed',async t=>{
 clock(t);let allowed=true,resolve;const holder={siteExecution:{assert(){if(!allowed)throw Object.assign(Error('revoked'),{code:'WS_EXECUTION_EXPIRED'});},beforeStart:()=>new Promise(r=>{resolve=r;})}};
 assert.equal(siteDeliveryReady(holder),false);await flush();allowed=false;resolve();await flush();assert.equal(holder.siteExecutionReadyAt,undefined);
 assert.throws(()=>siteDeliveryReady(holder),{code:'WS_EXECUTION_EXPIRED'});
});
