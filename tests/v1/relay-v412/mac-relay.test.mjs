import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {runWsClient,resolveExecutionMode} from '../../../app/v1/relay-v412/ws-relay-client.mjs';

const wall=()=>performance.timeOrigin+performance.now();
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function serverFrame(value){const bytes=Buffer.from(JSON.stringify(value));if(bytes.length<126)return Buffer.concat([Buffer.from([0x81,bytes.length]),bytes]);const head=Buffer.alloc(4);head[0]=0x81;head[1]=126;head.writeUInt16BE(bytes.length,2);return Buffer.concat([head,bytes]);}
function clientFrame(bytes){let length=bytes[1]&127,offset=2;if(length===126){length=bytes.readUInt16BE(2);offset=4;}else if(length===127){length=Number(bytes.readBigUInt64BE(2));offset=10;}const mask=bytes.subarray(offset,offset+4),payload=Buffer.from(bytes.subarray(offset+4,offset+4+length));for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];const opcode=bytes[0]&15;return {opcode,value:opcode===1?JSON.parse(payload.toString('utf8')):undefined};}

function makeRig({manifest={},queueBlockMs=0,cancelBeforeDispatch=false,noAck=false,reconnectAfterResult=false,ttl=60000,durationMs=260,templateVersion,prepareRuntime,runtimeManifest,runtimeSettings,lifecycle=[],deterministicRetry=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-v4-mac-')),key=crypto.randomBytes(32),events=[],taskId=`job-${crypto.randomUUID()}`,claimId=`claim-${crypto.randomUUID()}`,sentinel='LOCAL_RESULT_SENTINEL',rpc={jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'test_tool',arguments:{}}},request=Buffer.from(JSON.stringify(rpc));
 let calls=0,cacheAtResultStart,cacheAtAck,socket,connectionCount=0;
 const recordCache=()=>{const files=fs.readdirSync(path.join(root,'evidence/current')).filter(name=>name.startsWith('ws-result-cache-'));return JSON.parse(fs.readFileSync(path.join(root,'evidence/current',files[0]),'utf8'));};
 class FakeSocket extends EventEmitter{
  constructor(connectionId){super();this.connectionId=connectionId;}
  write(bytes){const frame=clientFrame(bytes);events.push(frame.value);if(frame.opcode!==1)return true;const f=frame.value;
   if(f.type==='ping')setImmediate(()=>this.fromSite({v:1,type:'pong',sequence:f.sequence,wall_start_ms:wall(),worker_reply_ms:wall()}));
   if(f.type==='activate'&&this.connectionId===1)setImmediate(()=>{
    this.fromSite({v:1,type:'task',job_id:taskId,claim_id:claimId,request_bytes:request.length,request_chunks:1,request_hash:digest(request),delivery_attempt:1,replayed:false,expires_at:wall()+20000});
    this.fromSite({v:1,type:'task-chunk',job_id:taskId,claim_id:claimId,sequence:0,data:request.toString('base64'),sha256:digest(request)});
    this.fromSite({v:1,type:'task-end',job_id:taskId,claim_id:claimId});
    if(cancelBeforeDispatch)this.fromSite({v:1,type:'cancel',job_id:taskId,claim_id:claimId});
    if(queueBlockMs){const until=performance.now()+queueBlockMs;while(performance.now()<until){}}
   });
   if(f.type==='start')setImmediate(()=>this.fromSite({v:1,type:'start-ack',job_id:taskId,claim_id:claimId,authorized:true,authorized_at_ms:wall()}));
   if(f.type==='resume')setImmediate(()=>this.fromSite({v:1,type:'resume-status',job_id:f.results[0].job_id,claim_id:f.results[0].claim_id,status:'claimed'}));
   if(f.type==='result-start')cacheAtResultStart=recordCache();
   if(f.type==='result-end'&&reconnectAfterResult&&this.connectionId===1)setImmediate(()=>this.destroy());
   else if(f.type==='result-end'&&!noAck)setImmediate(()=>{this.fromSite({v:1,type:'ack',job_id:taskId,claim_id:claimId,accepted:true});cacheAtAck=recordCache();});
   return true;
  }
  fromSite(value){this.emit('data',serverFrame(value));}
  destroy(){this.emit('close');}
 }
 socket=new FakeSocket();
 let connectCalls=0,retryNow=0;
 const retryOptions=deterministicRetry?{retryClock:()=>retryNow,random:()=>0,sleep:async ms=>{retryNow+=ms;await new Promise(resolve=>setTimeout(resolve,5));}}:{};
 const promise=runWsClient({...retryOptions,connect:async()=>{lifecycle.push('connect');connectCalls++;socket=new FakeSocket(++connectionCount);const connected=socket;setImmediate(()=>connected.fromSite({v:1,type:'ready',...(templateVersion===undefined?{}:{template_version:templateVersion})}));return {socket:connected};},execute:async()=>{calls++;return {response:{jsonrpc:'2.0',id:7,result:{value:sentinel}},elapsed_ms:2};},root,origin:taskId,durationMs,toolManifest:manifest,cacheKey:key,resultTtlMs:ttl,prepareRuntime,manifest:runtimeManifest,settings:runtimeSettings,log:entry=>events.push(entry)});
 return {root,promise,events,taskId,calls:()=>calls,connectCalls:()=>connectCalls,sentinel,cacheAtResultStart:()=>cacheAtResultStart,cacheAtAck:()=>cacheAtAck,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}

test('trusted read-only task skips start and ACK removes encrypted result data',async()=>{
 const rig=makeRig({manifest:{test_tool:{annotations:{readOnlyHint:true}}}});
 try{await rig.promise;assert.equal(rig.calls(),1);assert.equal(rig.events.some(e=>e?.type==='start'),false);assert.equal(rig.events.find(e=>e?.type==='result-start')?.execution_mode,'readonly');const saved=rig.cacheAtResultStart()[0];assert.ok(saved.ciphertext&&saved.iv&&saved.tag);assert.equal(JSON.stringify(saved).includes(rig.sentinel),false);const acked=rig.cacheAtAck()[0];assert.equal(acked.state,'acked');assert.equal('ciphertext'in acked,false);}finally{rig.cleanup();}
});

test('destructive hint requires start even when the task is immediate',async()=>{
 const rig=makeRig({manifest:{test_tool:{annotations:{destructiveHint:true}}}});
 try{await rig.promise;assert.equal(rig.events.some(e=>e.type==='start'),true);assert.equal(rig.events.find(e=>e.type==='result-start')?.execution_mode,'confirmed');}finally{rig.cleanup();}
});

test('V4.1 destructive first delivery on the active connection skips start',async()=>{
 const rig=makeRig({manifest:{test_tool:{annotations:{destructiveHint:true}}},templateVersion:'4.1.0'});
 try{await rig.promise;assert.equal(rig.events.some(e=>e?.type==='start'),false);assert.equal(rig.events.find(e=>e?.type==='result-start')?.execution_mode,'immediate');assert.equal(rig.calls(),1);}finally{rig.cleanup();}
});

test('write delayed over 100 ms requires start',async()=>{
 const rig=makeRig({queueBlockMs:130});
 try{await rig.promise;assert.equal(rig.events.some(e=>e.type==='start'),true);assert.equal(rig.events.find(e=>e.type==='result-start')?.execution_mode,'confirmed');}finally{rig.cleanup();}
});

test('V4.1 queued destructive write still requires start',async()=>{
 const rig=makeRig({manifest:{test_tool:{annotations:{destructiveHint:true}}},queueBlockMs:130,templateVersion:'4.1.0'});
 try{await rig.promise;assert.equal(rig.events.some(e=>e?.type==='start'),true);assert.equal(rig.events.find(e=>e?.type==='result-start')?.execution_mode,'confirmed');}finally{rig.cleanup();}
});

test('ready without template_version remains compatible with V4 destructive confirmation',async()=>{
 const rig=makeRig({manifest:{test_tool:{annotations:{destructiveHint:true}}}});
 try{await rig.promise;assert.equal(rig.events.some(e=>e?.type==='start'),true);assert.equal(rig.events.find(e=>e?.type==='result-start')?.execution_mode,'confirmed');}finally{rig.cleanup();}
});

test('unsupported Site template is explicitly rejected without executing tasks',async()=>{
 const rig=makeRig({manifest:{test_tool:{annotations:{destructiveHint:true}}},templateVersion:'5.0.0'});
 try{await assert.rejects(rig.promise,error=>error.code==='WS_TEMPLATE_VERSION_UNSUPPORTED');assert.equal(rig.calls(),0);assert.equal(rig.events.some(e=>e?.event==='template_rejected'),true);assert.equal(rig.events.some(e=>e?.type==='activate'),false);}finally{rig.cleanup();}
});

test('prepareRuntime receives host manifest and settings before the first connect',async()=>{
 const order=[],runtimeManifest={initialize:{protocolVersion:'2025-11-25'},tools:{tools:[{name:'test_tool'}]},resources:{resources:[]},resourceContents:[],serverDiscover:{}},runtimeSettings={mode:'fixture'};
 const rig=makeRig({prepareRuntime:async input=>{order.push('prepare');assert.equal(input.manifest,runtimeManifest);assert.equal(input.settings,runtimeSettings);},runtimeManifest,runtimeSettings,lifecycle:order,durationMs:260});
 try{await rig.promise;assert.deepEqual(order,['prepare','connect']);assert.equal(rig.connectCalls(),1);}finally{rig.cleanup();}
});

test('prepareRuntime failure rejects before connecting',async()=>{
 const rig=makeRig({prepareRuntime:async()=>{throw Object.assign(Error('fixture failure'),{code:'B_SITE_NETWORK_FAILED'});}});
 try{await assert.rejects(rig.promise,error=>error.code==='B_SITE_NETWORK_FAILED');assert.equal(rig.connectCalls(),0);assert.equal(rig.calls(),0);}finally{rig.cleanup();}
});

test('restoring an immediate write resends the cached result as confirmed without re-execution',async()=>{
 const rig=makeRig({manifest:{test_tool:{annotations:{}}},reconnectAfterResult:true,durationMs:900,deterministicRetry:true});
 try{await rig.promise;const modes=rig.events.filter(e=>e?.type==='result-start').map(e=>e.execution_mode);assert.deepEqual(modes,['immediate','confirmed']);assert.equal(rig.calls(),1);}finally{rig.cleanup();}
});

test('cancellation before dispatch prevents execution and does not ask for start',async()=>{
 const rig=makeRig({cancelBeforeDispatch:true});
 try{await rig.promise;assert.equal(rig.calls(),0);assert.equal(rig.events.some(e=>e?.type==='start'),false);assert.equal(rig.events.some(e=>e?.type==='unknown'&&e.job_id===rig.taskId),true);}finally{rig.cleanup();}
});

test('unacknowledged encrypted result expires to an identity-only tombstone',async()=>{
 const rig=makeRig({manifest:{test_tool:{readOnly:true}},noAck:true,ttl:60,durationMs:240});
 try{await rig.promise;const entry=JSON.parse(fs.readFileSync(path.join(rig.root,'evidence/current',fs.readdirSync(path.join(rig.root,'evidence/current')).find(name=>name.startsWith('ws-result-cache-'))),'utf8'))[0];assert.equal(entry.state,'expired');assert.equal('ciphertext'in entry,false);assert.equal(Object.keys(entry).sort().join(','),'claim_id,job_id,request_hash,state,tombstone_until');assert.equal(rig.calls(),1);}finally{rig.cleanup();}
});

test('destructive manifest classification wins over read-only annotation',()=>{
 assert.equal(resolveExecutionMode({rpc:{params:{name:'both'}},toolManifest:{both:{annotations:{readOnlyHint:true,destructiveHint:true}}}}),'confirmed');
});
