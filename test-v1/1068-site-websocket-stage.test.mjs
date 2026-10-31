import test from 'node:test';import assert from 'node:assert/strict';
import {SiteWebSocketObservation} from '../app/v1/site-websocket-observation.mjs';
import {siteConnectionStages,safeSiteConnectionStages} from '../app/v1/site-connection-stages.mjs';
import {projectNativeState} from '../app/v1/native-state.mjs';
import {diagnostic} from '../app/v1/support.mjs';
import {V412_SETTINGS} from '../app/v1/b-site-ws-transport.mjs';

test('websocket event times remain stable between polls and do not invent a disconnect cause',()=>{
 let now=1000;const observer=new SiteWebSocketObservation(()=>now);
 observer.note('connecting',1);now=1100;observer.note('connected',1);
 const connected=observer.snapshot();now=9000;assert.deepEqual(observer.snapshot(),connected);
 observer.note('disconnected',1);assert.deepEqual(observer.snapshot(),{state:'reconnecting',reason_code:'WS_DISCONNECTED_UNCLASSIFIED',observed_at:9000,connected_at:1100,disconnected_at:9000,transport_epoch:1});
 now=10000;observer.note('connected',1);assert.equal(observer.snapshot().disconnected_at,9000);assert.equal(observer.snapshot().connected_at,10000);
 now=10500;observer.note('heartbeat',1);assert.equal(observer.snapshot().heartbeat_ack_at,10500);assert.equal(observer.snapshot().observed_at,10000);
 now=11000;observer.note('connecting',2);assert.equal(observer.snapshot().disconnected_at,undefined);
 const current=observer.snapshot();observer.note('disconnected',1);assert.deepEqual(observer.snapshot(),current);
 assert.equal(V412_SETTINGS.rotateMs,75000);assert.equal(V412_SETTINGS.maxOperations,1392);
});

test('connection stages separate websocket events from heartbeat and successful tool calls; native and diagnostics use the same allowlist',()=>{
 const input={selected:'site',now:5000,transport:{transport_epoch:4,running:true,ready:true,authenticated:true,phase:'running',heartbeat_at:4000,websocket:{state:'connected',reason_code:'WS_CONNECTED',observed_at:3000,connected_at:3000,heartbeat_ack_at:4000,transport_epoch:4,private_data:'PRIVATE'}}};
 const stages=siteConnectionStages(input);assert.equal(stages.websocket.connected_at,3000);assert.equal(stages.websocket.heartbeat_at,4000);assert.equal(stages.last_call.state,'not_observed');
 const safe=safeSiteConnectionStages(stages);assert.doesNotMatch(JSON.stringify(safe),/PRIVATE/);
 assert.deepEqual(projectNativeState({site_b:{connection_stages:stages}}).site_b.connection_stages.websocket,safe.websocket);
 assert.deepEqual(diagnostic({site_b:{connection_stages:stages}}).connection_stages.websocket,safe.websocket);
 assert.deepEqual(siteConnectionStages({...input,now:6000}).websocket,stages.websocket);
 const stale=siteConnectionStages({...input,transport:{...input.transport,transport_epoch:5}});assert.equal(stale.websocket.state,'unknown');assert.equal(stale.websocket.connected_at,null);
});
