import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {canonicalize} from 'json-canonicalize';
import {createDesktop} from '../../app/server.mjs';
import {BSiteLocalStore} from '../../app/v1/b-site-store.mjs';

const INS='f91b3e41-f0b7-4b59-a18d-5024525d44c2',BIND='f7207d10-dab3-4263-b19e-6a3aa44f06aa';
const SITE='privateSiteA',OWNER='synthetic-owner';
const SHA=x=>crypto.createHash('sha256').update(x).digest('hex');

test('Site RPC adapter keeps compact refs, error/image/card shapes and measured unknown in original encrypted result box',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'1052-d1-result-'))),stateDir=path.join(root,'state'),work=path.join(root,'work'),ledgerDir=path.join(root,'ledger');
 fs.mkdirSync(stateDir,{mode:0o700});fs.mkdirSync(work);fs.mkdirSync(ledgerDir,{mode:0o700});
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const app=await createDesktop({stateDir,defaultRoot:work,uiKey:'ed'.repeat(32),clientDeps:{
  currentAppPath:path.join(root,'ChatHand.app'),computerName:()=> 'Synthetic result adapter',
  tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),
  updaterFactory:()=>({currentBuild:1052,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request:null,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})
 }});
 t.after(async()=>app.close());
 app.tools.policy.enabled=true;app.store.paused=false;app.store.writesEnabled=true;
 app.tools.bSiteLocalStore={selection:()=>({selected:'site'})};
 const local=new BSiteLocalStore({stateDir:ledgerDir,installationId:INS,existingA:false,resultKey:()=>Buffer.alloc(32,8)});
 t.after(()=>local.close());
 local.configureSite({site_id:SITE,owner_subject:OWNER,binding_id:BIND,generation:1},{authenticated:true});
 local.health('site',{state:'healthy',verified:true,nonceEcho:true,generation:1});
 local.switchUser('site',{windowGesture:true});
 const ctx={sessionTag:'c'.repeat(64),setupPrincipal:`site-b:authenticated:${OWNER}:${BIND}:1`,
  connectionPrincipal:`site-b:${BIND}:1`,requestId:'site-adapter-fixture-0001'};
 async function record(output,{throws=false,failed=false}={}){
  app.tools.invoke=async()=>{if(throws)throw Object.assign(Error('synthetic failure'),{code:'SYNTH_FAIL'});return output;};
  const out=await app.tools.siteCall('bridge_info',{},ctx);
  assert.equal(out.failed,failed);
  const now=Date.now(),workItem={op_id:crypto.randomUUID(),route:'site',principal:'site:'+OWNER,binding_id:BIND,generation:1,
   tool_name:'bridge_info',request_digest:SHA(crypto.randomBytes(16)),created_at:now-1000,start_before:now+30000};
  assert.equal(local.admit(workItem,{authenticated:true}).replayed,false);
  assert.equal(local.start(workItem.op_id,workItem).execute,true);
  const committed=local.complete(workItem.op_id,workItem,out.value,{failed:out.failed});
  const saved=local.status(workItem.op_id,workItem,{includeResult:true});
  assert.equal(saved.result_digest,committed.result_digest);
  assert.equal(saved.result_digest,SHA(Buffer.from(canonicalize(saved.result),'utf8')));
  assert.equal(local.db.prepare('SELECT result_box FROM b_operations WHERE op_id=?').get(workItem.op_id).result_box.includes('synthetic failure'),false);
  return {out,committed,saved};
 }
 const compact=await record({text:'Long local text '.repeat(500)});
 assert.equal(compact.saved.result.output_summary?.compacted,true);
 assert.ok(compact.saved.result.output_summary.file_path.startsWith(work+path.sep));
 assert.equal(fs.readFileSync(compact.saved.result.output_summary.file_path,'utf8').includes('Long local text'),true);
 assert.deepEqual(compact.saved.result,compact.out.value);
 assert.equal(compact.committed.source_result_unavailable,false);
 const error=await record(null,{throws:true,failed:true});
 assert.equal(error.saved.state,'failed');assert.equal(error.saved.result.error.code,'SYNTH_FAIL');
 assert.equal(error.saved.result.executed,false);assert.deepEqual(error.saved.result,error.out.value);
 const image=await record({image_base64:'a'.repeat(1024),mimeType:'image/png',label:'picture'});
 assert.equal(image.saved.result.image_base64,'a'.repeat(1024));
 assert.equal(image.saved.result.mimeType,'image/png');
 const card=await record({label:'card',_card_meta:{'chathand/test-token':'synthetic'}});
 assert.deepEqual(card.saved.result._card_meta,{'chathand/test-token':'synthetic'});
 const unknown=await record({secret:'x'.repeat(70000)});
 assert.equal(unknown.committed.source_result_unavailable,true);
 assert.equal(unknown.saved.result.business_outcome,'unknown');
 assert.equal(unknown.saved.result.do_not_replay,true);
 assert.equal(Object.hasOwn(unknown.saved.result,'executed'),false,'unknown never claims non-execution');
 assert.equal(unknown.saved.result.source_result.bytes>65536,true);
 assert.equal(JSON.stringify(unknown.saved.result).includes('x'.repeat(100)),false);
});
