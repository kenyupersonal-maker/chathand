import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {BSiteHttpTransport} from '../app/v1/b-site-http-transport.mjs';

const origin='https://fixture1070.chatgpt.site',siteId='fixture1070';
const pending={site_id:siteId,origin,bearer:'synthetic-only-'.repeat(4)};
const request={protocol_version:'3',site_id:siteId,site_origin:origin};
function json(url,value,status=200){
 const response=new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 Object.defineProperty(response,'url',{value:url});return response;
}
function transport(t,fetchImpl){
 const value=new BSiteHttpTransport({installationId:crypto.randomUUID(),credentials:{get:()=>null},localStore:{},fetchImpl,autoPoll:false});
 t.after(()=>value.close());return value;
}
test('1070 only an explicit legacy health version maps a v3 fields error; each begin rechecks health',async t=>{
 let version='1068-site-b-v5';const calls=[];
 const tr=transport(t,async(url,init)=>{calls.push([url,init.method]);
  assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
  if(url.endsWith('/health')){assert.equal(init.body,undefined);return json(url,{template_version:version});}
  return json(url,{error_code:'B_FIELDS_INVALID'},400);
 });
 for(const [remote,protocol,code] of [
  ['1068-site-b-v5','3','B_REBIND_UNSUPPORTED'],['1068-site-b-v5','2','B_FIELDS_INVALID'],
  ['1069-site-b-v6','3','B_FIELDS_INVALID'],['1070-site-b-v7','3','B_FIELDS_INVALID'],
  [undefined,'3','B_FIELDS_INVALID'],[null,'3','B_FIELDS_INVALID'],['unknown','3','B_FIELDS_INVALID']]){
  version=remote;await assert.rejects(tr.beginV2({...request,protocol_version:protocol},pending),{code});
 }
 assert.deepEqual(calls,Array.from({length:7},()=>[[origin+'/health','GET'],[origin+'/pair/begin','POST']]).flat());
 assert.equal(tr.pendingPairSite,null);
});
test('1070 failed, redirected or stale health never starts pairing or masquerades as an old template',async t=>{
 for(const kind of ['offline','redirect','stale'])await t.test(kind,async t=>{
  let count=0;const tr=transport(t,async url=>{count++;assert.equal(url,origin+'/health');
   if(kind==='stale')tr.stop();
   return json(kind==='redirect'?'https://other.chatgpt.site/health':url,{},kind==='offline'?503:200);
  });
  await assert.rejects(tr.beginV2(request,pending),{code:{offline:'B_REMOTE_TRANSIENT',redirect:'B_UNTRUSTED_HTTP_RESPONSE',stale:'B_LIFECYCLE_CHANGED'}[kind]});
  assert.equal(count,1);assert.equal(tr.pendingPairSite,null);
 });
});
