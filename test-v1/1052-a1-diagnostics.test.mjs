import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {DiagnosticEvents,installationSalt,validCardErrors} from '../app/diagnostic-events.mjs';
import {CallTrace,measureResponseLength} from '../app/call-trace.mjs';
import {TOOLS} from '../app/tools.mjs';
import {ResumeKeeper,sessionHashOf} from '../app/v1/resume.mjs';
import {RelayKeeper} from '../app/v1/relay-keeper.mjs';
import {fixture,authorize} from '../test/helpers.mjs';
const temp=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'ch1052-a1-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};
const rows=d=>fs.readFileSync(path.join(d,'diagnostics/events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
test('installation salt is stable across instances, differs per install and refuses symlink/hardlink/public salt',t=>{
 const a=temp(t),b=temp(t);assert.deepEqual(installationSalt(a),installationSalt(a));assert.notDeepEqual(installationSalt(a),installationSalt(b));
 const outside=path.join(b,'outside');fs.writeFileSync(outside,Buffer.alloc(32,1));const salt=path.join(a,'diagnostics/trace-salt');fs.unlinkSync(salt);fs.symlinkSync(outside,salt);assert.notDeepEqual(installationSalt(a),Buffer.alloc(32,1));assert.deepEqual(fs.readFileSync(outside),Buffer.alloc(32,1));
 fs.unlinkSync(salt);fs.linkSync(outside,salt);assert.notDeepEqual(installationSalt(a),Buffer.alloc(32,1));fs.unlinkSync(salt);fs.writeFileSync(salt,Buffer.alloc(32,1),{mode:0o644});assert.notDeepEqual(installationSalt(a),Buffer.alloc(32,1));
});
test('trace captures safe metadata before card redaction and measures the actual envelope',t=>{
 const d=temp(t),trace=new CallTrace(d,TOOLS),again=new CallTrace(d,TOOLS),body={method:'tools/call',id:'PRIVATE_REQUEST',params:{name:'command_result',arguments:{task_id:'PRIVATE_TASK',wait_ms:20000,brief:true,model:'PRIVATE_MODEL',password:'PRIVATE_SECRET'}}};
 const id=trace.receiveRPC(body,'PRIVATE_CALLER',{traceMetadata:{card:true}}),envelope={result:{structuredContent:{text:'中文内容'}}};trace.handled(id,envelope,measureResponseLength(envelope));
 const r=trace.entries.find(e=>e.event==='rpc_received');assert.equal(r.card,true);assert.equal(r.wait_ms,20000);assert.equal(r.brief,true);assert.equal(r.task_hash,again.hash('PRIVATE_TASK'));assert.equal(trace.entries.at(-1).response_bytes,Buffer.byteLength(JSON.stringify(envelope)));
 const text=fs.readFileSync(trace.file,'utf8');for(const marker of ['PRIVATE_TASK','PRIVATE_MODEL','PRIVATE_SECRET','PRIVATE_CALLER','PRIVATE_REQUEST','中文内容'])assert.ok(!text.includes(marker));
});
test('every supported event enforces a per-kind field whitelist; event files rotate to five total and writes fail safely',t=>{
 const d=temp(t),events=new DiagnosticEvents(d,{maxBytes:350,tools:['read_file']});const kinds=['conn.state','conn.unhealthy','conn.grace','access','revoke_all','task.end','cap','relay.checkpoint','relay.ctl','relay.unclaimed','relay.disable','stall','task.begin','block.nudge','wait.poll','wait.end','return.paged','relay.auto','card.errors'];
 for(const kind of kinds)assert.equal(events.record(kind,{task:'PRIVATE_TASK',job:'PRIVATE_JOB',model:'PRIVATE_MODEL',title:'PRIVATE_TITLE',stack:'PRIVATE_STACK',from:'/PRIVATE_PATH',source:'~PRIVATE',n:1,ms:2,code:'TASK_LIMIT',codes:['DEVICE_BUSY'],tool:'read_file'}),true);
 assert.equal(events.record('PRIVATE_UNKNOWN',{}),false);const files=fs.readdirSync(path.join(d,'diagnostics')).filter(f=>f.startsWith('events'));assert.equal(files.length,5);for(const f of files){const text=fs.readFileSync(path.join(d,'diagnostics',f),'utf8');assert.ok(Buffer.byteLength(text)<=350);assert.ok(!text.includes('PRIVATE'));for(const row of text.trim().split('\n').map(JSON.parse))for(const v of Object.values(row))if(typeof v==='string'){assert.ok(v.length<=80);assert.ok(!v.startsWith('/')&&!v.startsWith('~'));}}
 const file=path.join(d,'diagnostics/events.jsonl');fs.unlinkSync(file);fs.mkdirSync(file);assert.equal(events.record('access',{enabled:false}),false);assert.equal(events.write_failures,1);
});
test('card error reports are strict metadata with invalid payloads ignored',()=>{
 for(const bad of [null,[],{n:0,codes:[]},{n:1.2,codes:[]},{n:1,codes:['bad']},{n:1,codes:['X'.repeat(41)]},{n:1,codes:Array(6).fill('ERROR')}])assert.equal(validCardErrors(bad),null);
 assert.deepEqual(validCardErrors({n:2,codes:['DEVICE_BUSY','DEVICE_BUSY'],message:'PRIVATE'}),{n:2,codes:['DEVICE_BUSY']});assert.deepEqual(TOOLS.find(t=>t.name==='relay_card_control').inputSchema.properties.card_errors,{type:'object'});
});
test('real Tools private relay view acknowledges reports once per request; malformed reports do not break view or ordinary activity isolation',async t=>{
 const f=fixture(t),session='a1-session',principal='a1-principal',hash=sessionHashOf(principal,session),id=authorize(f,'chatgpt','a1-request',hash);let seq=0;
 const relay=new RelayKeeper({file:path.join(f.stateDir,'a1-relay.sqlite'),installationEligible:true,readTask:()=>({session_hash:hash,status:'active',enabled:true,stopped:false,paused:false,epoch:f.policy.epoch,revision:0,checkpoint_seq:1})});t.after(()=>relay.close());f.tools.relayKeeper=relay;
 const c=relay.checkpoint({task_id:id,checkpoint_seq:1,continuing:true},{caller:'chatgpt',session_hash:hash,transport:'mcp_app'}),token=c._relay_meta.card_token;
 const rpc=errors=>f.tools.rpc({jsonrpc:'2.0',id:++seq,method:'tools/call',params:{name:'relay_card_control',arguments:{action:'view',task_id:id,card_token:token,...(errors?{card_errors:errors}:{})},_meta:{'openai/session':session,'io.modelcontextprotocol/protocolVersion':'2026-07-28'}}},'chatgpt',{setupPrincipal:principal});
 const before=f.tools.trace.counters.tools_received;let out=await rpc({n:2,codes:['DEVICE_BUSY']});assert.equal(out.result.isError,false,JSON.stringify(out));assert.equal(out.result.structuredContent.relay.report_errors,true);assert.equal(rows(f.stateDir).filter(x=>x.kind==='card.errors').length,1);out=await rpc({n:-1,codes:['PRIVATE']});assert.equal(out.result.isError,false);await rpc();assert.equal(rows(f.stateDir).filter(x=>x.kind==='card.errors').length,1);assert.equal(f.tools.trace.counters.tools_received,before+3);assert.equal(f.tools.resume.sessions.size,0);assert.equal(f.tools.trace.entries.filter(x=>x.event==='rpc_received').at(-1).card,true);
 const widget=fs.readFileSync(new URL('../ui/task-widget.html',import.meta.url),'utf8');assert.match(widget,/report_errors===true\?\{n:cardErrN/);assert.match(widget,/cardErrN=Math.max\(0,cardErrN-sent.n\)/);
});
test('stall recording retains 500 and emits once per real transition',t=>{
 const d=temp(t),events=new DiagnosticEvents(d),r=new ResumeKeeper({stateDir:d,now:()=>1000000,events});r.sessions.set('s',{last_at:1,last_tool:'read_file',normal_end:false,pending:false,task_id:'task'});for(let i=0;i<501;i++)r.logStall({task_id:'task',title:'old behavior'},null,'data',{});assert.equal(r.data.stalls.length,500);r.stall({task_id:'task',session_hash:'s',status:'active'});const n=rows(d).length;r.stall({task_id:'task',session_hash:'s',status:'active'});assert.equal(rows(d).length,n);
});
test('current task lifecycle and cap hooks record real outcomes without payloads; forged from_card stays ordinary',async t=>{
 const f=fixture(t),principal='a1-lifecycle',session='lifecycle',hash=sessionHashOf(principal,session),id=authorize(f,'chatgpt','lifecycle-request',hash);let n=0;
 const rpc=(name,args)=>f.tools.rpc({jsonrpc:'2.0',id:++n,method:'tools/call',params:{name,arguments:args,_meta:{'openai/session':session}}},'chatgpt',{setupPrincipal:principal});
 const status=await rpc('task_status',{task_id:id,from_card:true});assert.equal(status.result.isError,false);assert.equal(f.tools.resume.sessions.has(hash),true);assert.equal(f.tools.trace.entries.findLast(e=>e.event==='rpc_received').card,true);
 f.policy.finish(id,'chatgpt');assert.equal(rows(f.stateDir).filter(e=>e.kind==='task.end').length,1);f.policy.finish(id,'chatgpt');assert.equal(rows(f.stateDir).filter(e=>e.kind==='task.end').length,1);
 f.policy.revokeAll('paused');assert.equal(rows(f.stateDir).at(-1).kind,'revoke_all');
 for(let i=0;i<300;i++)f.policy.tasks.set('cap-'+i,{id:'cap-'+i,status:'active',jobs:[],caller:'synthetic-other',session_hash:'other-'+i});const out=await rpc('begin_task',{request_id:'cap-request',title:'PRIVATE_TITLE'});assert.equal(out.result.structuredContent.code,'TASK_LIMIT');assert.equal(rows(f.stateDir).at(-1).kind,'cap');for(let i=0;i<300;i++)f.policy.tasks.delete('cap-'+i);
});
