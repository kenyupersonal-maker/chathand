import crypto from 'node:crypto';import test from 'node:test';import assert from 'node:assert/strict';
import {ConnectionController} from '../app/connection.mjs';
import {ConnectionGrace} from '../app/v1/connection-grace.mjs';
import {applyPermissionTier} from '../app/v1/permissions.mjs';
import {desktop} from './1052-a-fixture.mjs';
test('A2 unhealthy ready requires ten seconds AND three probes; startup running still fifteen seconds',()=>{
 let now=0,stops=0;const tunnel={child:{},stop(){stops++;this.child=null;}};
 const c=new ConnectionController({tunnel,state:{data:{},save(){}},clock:()=>now});c.desired=true;c.phase='ready';
 c.observe({});now=10000;c.observe({});assert.equal(stops,0);c.observe({});assert.equal(stops,1);
 tunnel.child={};c.phase='ready';c.observe({});now+=5000;c.observe({healthy:true,ready:true});assert.equal(c.unhealthy,null);
 c.phase='running';c.startedAt=now;now+=15001;c.observe({});assert.equal(stops,2);
});
test('A2 grace has one deadline, fresh recovery and identity/auth/route fences on all routes',()=>{
 for(const route of ['tunnel','relay','site']){let now=0;const g=new ConnectionGrace({now:()=>now});assert.equal(g.update(route,{identity:'A',healthy:false}),'revoke');g.update(route,{identity:'A',healthy:true});assert.equal(g.update(route,{identity:'A'}),'retain');now=599999;assert.equal(g.update(route,{identity:'A'}),'retain');now++;assert.equal(g.update(route,{identity:'A'}),'revoke');assert.equal(g.update(route,{identity:'A'}),'revoke');g.update(route,{identity:'A',healthy:true});assert.equal(g.update(route,{identity:'A'}),'retain');assert.equal(g.update(route,{identity:'B'}),'revoke');g.update(route,{identity:'B',healthy:true});assert.equal(g.update(route,{identity:'B',auth:true}),'revoke');}
});
test('A2 Site stale keeps original task, blocks execution freshness, expires with durable connection_lost receipt; same mode keeps authority',async t=>{
 const f=await desktop(t),a=f.app,l=a.tools.bSiteLocalStore;
 l.configureSite({site_id:'synthetic-site',owner_subject:'synthetic-owner',binding_id:crypto.randomUUID(),generation:1},{authenticated:true});l.health('site',{state:'healthy',verified:true,nonceEcho:true,generation:1});l.switchUser('site',{windowGesture:true});f.tick();
 // Synthetic policy-only task; this fixture does not prove authenticated Site transport ownership.
 const id=a.policy.begin({request_id:'authority-test',title:'temporary'},'chatgpt').task_id;
 const epoch=a.policy.epoch;await a.handle('/api/mode',{mode:'full',confirm:true});assert.equal(a.policy.epoch,epoch);assert.equal(a.policy.get(id).status,'active');
 await applyPermissionTier({state:a.state,store:a.store,policy:a.policy,adminAccess:{supported:()=>false,ready:()=>false}},{tier:'full'});assert.equal(a.policy.epoch,epoch);
 l.health('site',{state:'reconnecting',verified:true,generation:1});assert.equal(l.fresh(l.route('site')),false);assert.equal(a.policy.get(id).status,'active');assert.throws(()=>a.policy.require(id),{code:'CONNECTION_RECONNECTING'});await Promise.resolve();f.advance(599999);f.tick();assert.equal(a.policy.get(id).status,'active');await Promise.resolve();f.advance(1);f.tick();assert.equal(a.policy.get(id).status,'connection_lost');assert.equal(a.policy.receipts.read(id,'chatgpt').result.status,'connection_lost');
});
