import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {run,parseSiteLine} from '../skills/chathand-setup/scripts/setup.mjs';

const origin='https://private-a.chatgpt.site',siteId='privateSiteA',secret='synthetic-service-bearer-'.padEnd(48,'x');
const line=JSON.stringify({format:'chathand-site-v2',site_origin:origin,site_id:siteId,service_credential:secret});
const route=(revision,site_id=siteId)=>({configured:true,state:'healthy',health_fresh:true,origin,site_id,revision});
const snapshot=(revision,{phase='configured',site_id=siteId,noticeAt=1_000_000}={})=>({site_b:{selected:'site',
 routes:{site:route(revision,site_id)},pairing:{phase,target_site:site_id,pending_until:phase==='pairing'?1_100_000:null},
 paired_notice:{notice_id:'fixture-notice',origin,paired_at:noticeAt}}});

async function exercise(phase,states){
 let time=1_000_000,index=0,posted=0;
 const call=async(_runtime,path,body)=>{
  if(path==='/api/setup/site'){
   posted++;assert.deepEqual(body,parseSiteLine(line));return {phase,origin};
  }
  assert.equal(path,'/api/state');
  if(index++===0){const before=snapshot(4);before.site_b.routes.site.state='reconnecting';
   before.site_b.routes.site.health_fresh=false;return before;}
  return states[Math.min(index-2,states.length-1)];
 };
 const result=await run(['site'],{locate:()=>({}),call,stdin:async()=>line,now:()=>time,
  wait:async ms=>{time+=ms;}});
 assert.equal(posted,1);
 assert.equal(JSON.stringify(result).includes(secret),false);
 return {result,polls:index-1};
}

test('C6 ignores an old healthy route and waits for this pairing to finish',async()=>{
 const old=snapshot(4),pending=snapshot(5,{phase:'pairing',noticeAt:1_000_001}),
  complete=snapshot(6,{noticeAt:1_000_002});
 const {result,polls}=await exercise('pairing',[old,pending,complete]);
 assert.equal(result.phase,'paired');assert.equal(polls,3);
 const stale=await exercise('pairing',[old]);
 assert.equal(stale.result.status,'SITE_PAIRING_PENDING');assert.equal(stale.polls,60);
});

test('C6 credential update requires the requested Site and a fresh health revision',async()=>{
 const old=snapshot(4),wrong=snapshot(5,{site_id:'differentSite'}),current=snapshot(6);
 const {result,polls}=await exercise('credential_updated',[old,wrong,current]);
 assert.equal(result.phase,'credential_updated');assert.equal(polls,3);
});

test('C6 site input has exact private shape and both shipped script copies match',()=>{
 assert.throws(()=>parseSiteLine(JSON.stringify({...JSON.parse(line),extra:'x'})),{code:'SITE_LINE_INVALID'});
 assert.throws(()=>parseSiteLine(JSON.stringify({...JSON.parse(line),site_origin:'https://outside.example'})),{code:'SITE_LINE_INVALID'});
 assert.equal(fs.readFileSync(new URL('../skills/chathand-setup/scripts/setup.mjs',import.meta.url),'utf8'),
  fs.readFileSync(new URL('../plugins/chathand/skills/chathand-setup/scripts/setup.mjs',import.meta.url),'utf8'));
});

test('C6 connect preserves a healthy selected Site without reading stdin or posting a credential',async()=>{
 let calls=0;
 const result=await run(['connect'],{locate:()=>({}),call:async(_runtime,path)=>{
  assert.equal(path,'/api/state');calls++;return snapshot(4);
 },stdin:async()=>assert.fail('healthy Site must not read stdin')});
 assert.equal(result.preserved_existing_connection,true);
 assert.equal(calls,1);
});

test('C6 connect preserves healthy local OpenAI when its cloud check is down',async()=>{
 let calls=0;
 const result=await run(['connect'],{locate:()=>({}),call:async(_runtime,path)=>{
  assert.equal(path,'/api/state');calls++;return {connection:{ready:true,healthy:true,
   control_plane:{state:'down'}},site_b:{selected:'openai'}};
 },stdin:async()=>assert.fail('healthy local connection must not read stdin')});
 assert.equal(result.preserved_existing_connection,true);
 assert.match(result.network_problem,/网络连不上 OpenAI/);
 assert.equal(calls,1);
});
