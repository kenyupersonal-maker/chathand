import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {BSiteLocalStore} from '../app/v1/b-site-store.mjs';
import {BSiteHostProbes,B_HOST_PROBE_ENVELOPE} from '../app/v1/b-site-host-probes.mjs';
import {BSiteHttpTransport} from '../app/v1/b-site-http-transport.mjs';
import {BSiteWsTransport} from '../app/v1/b-site-ws-transport.mjs';
import {siteConnectionStages,safeSiteConnectionStages} from '../app/v1/site-connection-stages.mjs';
import {siteLinkFailure} from '../app/v1/site-link-health.mjs';
const id='11111111-1111-4111-8111-111111111111',bind='22222222-2222-4222-8222-222222222222',site='fixture_site',owner='fixture-owner',nonce='fixture_nonce_1069';
function local(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'b1069-standby-'));const s=new BSiteLocalStore({stateDir:dir,installationId:id,existingA:true});t.after(()=>{s.close();fs.rmSync(dir,{recursive:true,force:true});});s.health('openai',{state:'healthy',verified:true,nonceEcho:true});s.configureSite({site_id:site,owner_subject:owner,binding_id:bind,generation:1},{authenticated:true});s.health('site',{state:'healthy',verified:true,nonceEcho:true,generation:1});return s;}
const work=name=>({route:'site',principal:'site:'+owner,binding_id:bind,generation:1,tool_name:name,op_id:crypto.randomUUID(),created_at:Date.now(),start_before:Date.now()+10000,request_digest:'a'.repeat(64),args:{kind:B_HOST_PROBE_ENVELOPE,session_tag:'a'.repeat(64),tool_arguments:{nonce}}});
const channel={trusted_server:true,authenticated_device:true,site_id:site,owner_subject:owner,binding_id:bind,generation:1,transport_epoch:1,authenticated_session:'site:'+bind};
test('standby ledger executes only setup probes; revision change cannot mint a host capability',t=>{
 const s=local(t);const w=work('connection_check');s.admit(w,{authenticated:true});assert.equal(s.start(w.op_id,w).execute,true);assert.equal(s.selection().selected,'openai');
 assert.throws(()=>s.admit(work('read'),{authenticated:true}),{code:'B_ROUTE_NOT_SELECTED'});
 let observed=0;const probes=new BSiteHostProbes({local:s,installationId:id,transportEpoch:()=>1,receiptWriter:()=>{throw Error('must not issue');},onReadWrite:()=>{observed++;s.switchSetup('site',{authenticatedSetup:true,expectedRevision:s.selection().revision});probes.invalidate();}});
 const terminal={state:'completed',result_digest:'a'.repeat(64)};
 assert.equal(probes.observe({work:w,channel,terminal,outcome:{nonce,caller:'chatgpt',access_enabled:true,tool_count:10,instance_id:'fixture'}}).observed,true);
 const result=probes.observe({work:work('setup_write_probe'),channel,terminal,outcome:{nonce,recorded:true,read:true,write:true}});
 assert.equal(result.app_flow,'setup_only');assert.equal(observed,1);assert.equal(s.selection().selected,'site');assert.equal(s.currentHostReceipt(),null);assert.equal(probes.snapshot().verified,false);
 assert.throws(()=>s.switchSetup('openai',{authenticatedSetup:true,expectedRevision:0}),{code:'B_SELECTION_CHANGED'});
});
function transport(Type=BSiteHttpTransport,extra={}){
 const s={route:()=>({generation:1}),health(){}};
 return new Type({installationId:id,credentials:{get:()=>null},localStore:s,autoPoll:false,clock:()=>1800000000000,...extra});
}
test('HTTP precisely observes Cloudflare challenge and only a current authenticated success clears it',async()=>{
 const target={verified:true,site_id:site,site_origin:'https://fixture.chatgpt.site',owner_subject:owner,site_public_key:Buffer.alloc(32).toString('base64url')};
 const events=[];
 const tr=transport(BSiteHttpTransport,{onNetworkChallenge:e=>events.push(['challenge',e]),onNetworkChallengeCleared:e=>events.push(['clear',e]),resolveDeployment:async()=>target,fetchImpl:async url=>({status:403,url,redirected:false,headers:new Headers({'cf-mitigated':'challenge'})})});tr.machine=()=> 'fixture';
 await assert.rejects(tr.exchange('health',{}, {site_id:site,epoch:0,allowStopped:true}),{code:'B_SITE_NETWORK_CHALLENGE'});
 assert.equal(tr.networkChallenge.at,1800000000000);assert.deepEqual(events,[['challenge',{at:1800000000000,transport_epoch:0}]]);
 const stages=siteConnectionStages({transport:tr.stageStatus()});assert.deepEqual(safeSiteConnectionStages(stages).network_challenge,{at:1800000000000});
 tr.epoch=1;tr.noteNetworkResponse(403,new Headers({'cf-mitigated':'challenge'}),1);tr.noteAuthenticatedSuccess(0);assert.ok(tr.networkChallenge);tr.noteAuthenticatedSuccess(1);assert.equal(tr.networkChallenge,null);
 assert.equal(tr.noteNetworkResponse(403,new Headers(),1),false);assert.deepEqual(events.map(e=>[e[0],e[1].transport_epoch]),[['challenge',0],['challenge',1],['clear',1]]);
 tr.noteAuthenticatedSuccess(1);assert.equal(events.at(-1)[0],'clear');
 assert.equal(siteLinkFailure({configured:1,state:'reconnecting',reason:'B_SITE_NETWORK_CHALLENGE'},{phase:'reconnecting'}).immediate,false);
});
test('actual WS HTTP response handler identifies challenge and runtime acceptance clears it',async t=>{
 const tr=transport(BSiteWsTransport);tr.running=true;tr.sessionController=new AbortController();tr.current=()=>{};tr.target=async()=>({site_origin:'https://fixture.chatgpt.site'});tr.signedRelay=async()=>({});tr.machine=()=> 'fixture';
 const original=https.request;t.after(()=>{https.request=original;});
 https.request=()=>{const req=new EventEmitter();req.setTimeout=()=>{};req.end=()=>queueMicrotask(()=>req.emit('response',{statusCode:403,headers:{'cf-mitigated':'challenge'},resume(){}}));return req;};
 await assert.rejects(tr.upgrade({},0),{code:'B_SITE_NETWORK_CHALLENGE'});assert.ok(tr.networkChallenge);
 tr.fetchImpl=async url=>({url,redirected:false,status:200,headers:new Headers(),arrayBuffer:async()=>Buffer.from(JSON.stringify({accepted:true}))});
 await tr.relayPost({},0,'/relay/runtime',{});assert.equal(tr.networkChallenge,null);
});
test('WS challenge schedules a retry instead of stopping or treating it as lost authorization',async()=>{
 let scheduled=false;const states=[];
 const tr=transport(BSiteWsTransport,{setTimeoutFn:()=>{scheduled=true;return 1;},clearTimeoutFn:()=>{}});tr.running=true;tr.current=()=>{};tr.credentials.get=()=>({generation:1});tr.rpcDelivery=()=>{};tr.runtimeFactory=async()=>{throw Object.assign(Error('fixture'),{code:'B_SITE_NETWORK_CHALLENGE'});};tr.localStore.health=(_,v)=>states.push(v.state);
 await tr.run(0);assert.equal(scheduled,true);assert.equal(tr.running,true);assert.equal(states.at(-1),'reconnecting');
});
