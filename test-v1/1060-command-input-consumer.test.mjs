// Source-only fake stdin. Queue captures real executable specifications, but
// no process is spawned and no credential, native, browser or platform API runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Writable} from 'node:stream';
import {Tools} from '../app/tools.mjs';
import {DesktopCommandQueue} from '../app/commands.mjs';
import {Blocks} from '../app/v1/permissions.mjs';
import {Confirmations} from '../app/v1/confirmations.mjs';
import {CallTrace} from '../app/call-trace.mjs';
import {commandInputConsumer} from '../app/v1/command-input.mjs';
import {cleanError} from '../engine/src/core.mjs';

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ch1060-input-')),audit=[],written=[];
 const store={root,stateDir:root,checkActive(){},resolve:()=>root,audit:e=>audit.push(e)};
 const state={data:{mode:'full',terminal_enabled:true,high_risk:{}}};
 const task={id:crypto.randomUUID(),status:'active',jobs:[]},policy={
  tasks:new Map([[task.id,task]]),jobOwners:new Map(),check(){},
  require(id){assert.equal(id,task.id);return task;}
 };
 const queue=new DesktopCommandQueue(store,{externalMaintenance:true});
 const tools=Object.assign(Object.create(Tools.prototype),{state,store,queue,policy,lastCalls:{},
  automation:{has:()=>false},features:{has:()=>false},imageBatch:{has:()=>false},
  blocks:new Blocks({audit:store.audit}),confirmations:new Confirmations({offerSettingsCards:false}),
  self:{home:root,paths:[],pids:()=>[],cmdlines:()=>[]}
 });
 const trace=new CallTrace(root,[{name:'command_input',annotations:{readOnlyHint:false}}]);
 function job(program='/bin/cat',args=[],extra={}){
  const proposed=queue.propose({program,args,request_id:crypto.randomUUID(),stdin_mode:'pipe'});
  const j=queue.jobs.get(proposed.job_id);
  Object.assign(j,{status:'running',started_at:Date.now(),pty:false,...extra,
   child:{stdin:new Writable({write(chunk,_encoding,next){written.push(chunk.toString());next();}})}});
  policy.jobOwners.set(j.id,task.id);task.jobs.push(j.id);return j;
 }
 async function input(j,text,options={}){
  const args={task_id:task.id,job_id:j.id,request_id:crypto.randomUUID(),text,...options};
  const id=trace.receiveRPC({method:'tools/call',params:{name:'command_input',arguments:args}},'local-mcp');
  try{const result=await tools.invoke('command_input',args,'local-mcp');trace.handled(id,{result});return result;}
  catch(e){trace.handlerException(id,e);throw e;}
 }
 t.after(async()=>{for(const j of queue.jobs.values()){j.child.stdin.destroy();j.child=null;j.status='completed';j.finished_at=Date.now();}await queue.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,audit,written,store,state,task,policy,queue,tools,trace,job,input};
}
test('approved plain system cat pipe receives synthetic command-looking data verbatim',async t=>{
 const f=fixture(t),j=f.job(),value='visudo\n';
 const result=await f.input(j,value,{close:true});
 assert.equal(result.status,'sent');assert.deepEqual(f.written,[value]);
 assert.doesNotMatch(JSON.stringify([result,f.audit,f.trace.entries]),/visudo/);
});

function privateRecords(f,result){
 const disk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?disk(path.join(dir,e.name)):fs.readFileSync(path.join(dir,e.name),'utf8'));
 return JSON.stringify([result,f.audit,f.trace.entries,f.tools.blocks.items,f.tools.confirmations.snapshot(),disk(f.root)]);
}
test('single dash is data, preserving exact bytes and replay identity without storing input contents in receipts',async t=>{
 const f=fixture(t),j=f.job('/bin/cat',['-']),value='visudo FAKE_LITERAL_1060\n';
 const request_id=crypto.randomUUID(),first=await f.input(j,value,{request_id,close:true});
 const replay=await f.input(j,value,{request_id,close:true});
 assert.equal(first.status,'sent');assert.equal(replay.replayed,true);assert.equal(first.input_id,replay.input_id);
 assert.deepEqual(f.written,[value]);
 await assert.rejects(f.input(j,value+'changed',{request_id,close:true}),{code:'OP_CONFLICT'});
 assert.equal(f.written.length,1);assert.ok(!privateRecords(f,[first,replay]).includes('FAKE_LITERAL_1060'));
});
test('data exemption depends on executable identity, arguments and pipe mode, not names or hints',t=>{
 const f=fixture(t),j=f.job();assert.equal(commandInputConsumer(j),'data');
 const unknown=[
  {program:'/tmp/cat'}, {program:'cat'}, {program:'/bin/sh'},
  {program:'/usr/bin/env',args:['cat']}, {programIdentity:'changed'},
  {args:['fixture.txt']},{args:['-n']},{args:['--help']},{args:['-','-']},
  {stdin_mode:'closed'},{pty:true},{admin:{display:['cat']}},
  {started_at:undefined}
 ];
 for(const delta of unknown)assert.equal(commandInputConsumer({...j,...delta,
  title:'ordinary data reader',inputHint:'ordinary_data',consumer:'data',safe_stdin:true
 }),'executable_or_unknown',JSON.stringify(delta));
 const copy=path.join(f.root,'cat');fs.copyFileSync(j.program,copy);fs.chmodSync(copy,0o700);
 assert.equal(commandInputConsumer(f.job(copy)),'executable_or_unknown');
});
for(const program of ['/bin/sh',process.execPath,'/usr/bin/env'])test('executable or unknown '+path.basename(program)+' input retains command checks without private text in diagnostics',async t=>{
 const f=fixture(t),j=f.job(program,program==='/usr/bin/env'?['cat']:[]);
 const marker='FAKE_PRIVATE_STDIN_1060',value='visudo '+marker+'\n';
 await assert.rejects(f.input(j,value),e=>{
  assert.equal(e.code,'NEVER_ALLOWED');assert.equal(e.details.never_id,'password');
  assert.ok(!privateRecords(f,cleanError(e)).includes(marker));return true;
 });
 assert.equal(f.written.length,0);
 assert.equal(f.tools.confirmations.pending({task_id:f.task.id}),null);
});
test('PTY and unrecognized cat arguments keep executable-input checking',async t=>{
 const f=fixture(t);
 for(const j of [f.job('/bin/cat',[],{pty:true}),f.job('/bin/cat',['-n'])]){
  await assert.rejects(f.input(j,'visudo FAKE_PTY_INPUT_1060\n'),{code:'NEVER_ALLOWED'});
 }
 assert.equal(f.written.length,0);
});
test('terminal and queue switches still govern plain data input',async t=>{
 const f=fixture(t),j=f.job();
 f.state.data.terminal_enabled=false;
 await assert.rejects(f.input(j,'visudo\n'),{code:'CAPABILITY_OFF'});
 f.state.data.terminal_enabled=true;f.queue.enabled=false;
 await assert.rejects(f.input(j,'visudo\n'),{code:'COMMANDS_DISABLED'});
 assert.equal(f.written.length,0);
});
test('high-risk executable stdin honors the actual off/on switch and scope without exposing typed content',async t=>{
 const f=fixture(t),j=f.job('/bin/sh'),marker='FAKE_HIGH_RISK_INPUT_1060',value='rm -rf ~/Documents; # '+marker+'\n';
 await assert.rejects(f.input(j,value),e=>{
  assert.equal(e.code,'HIGH_RISK_DISABLED');assert.equal(e.details.risk_id,'bulk_delete');
  assert.ok(!privateRecords(f,cleanError(e)).includes(marker));return true;
 });
 f.state.data.high_risk.bulk_delete=true;f.state.data.mode='auto';
 await assert.rejects(f.input(j,value),e=>{
  assert.equal(e.code,'NEEDS_FULL_ACCESS');assert.ok(!privateRecords(f,cleanError(e)).includes(marker));return true;
 });
 f.state.data.mode='full';assert.equal((await f.input(j,value)).status,'sent');
 assert.deepEqual(f.written,[value]);
});
test('actual approved consumer is rechecked before its input; a data-looking value cannot enter a password entrypoint',async t=>{
 const f=fixture(t),j=f.job(),marker='FAKE_SYSTEM_PASSWORD_INPUT_1060';
 // Simulate legacy approved jobs; no privileged entrypoint is launched.
 for(const [program,args,code] of [
  ['/usr/sbin/visudo',[],'NEVER_ALLOWED'],
  ['/usr/bin/sudo',['-S','cat'],'ADMIN_FORM_UNSUPPORTED'],
  ['/usr/bin/sudo',['cat'],'ADMIN_FORM_UNSUPPORTED'],
  ['/usr/bin/su',[],'PROGRAM_BLOCKED']
 ]){
  Object.assign(j,{program,args,consumer:'data',title:'cat-like reader'});
  f.state.data.high_risk.admin=true;
  await assert.rejects(f.input(j,marker+'\n'),e=>{
   assert.equal(e.code,code);assert.ok(!privateRecords(f,cleanError(e)).includes(marker));return true;
  });
 }
 assert.equal(f.written.length,0);
});
test('actual job high-risk command remains subject to switches even for harmless-looking input',async t=>{
 const f=fixture(t),j=f.job('/bin/sh',['-c','rm -rf ~/Documents']);
 await assert.rejects(f.input(j,'FAKE_ORDINARY_LINE_1060\n'),e=>e.code==='HIGH_RISK_DISABLED'&&e.details.risk_id==='bulk_delete');
 assert.equal(f.written.length,0);
});
test('known data input still obeys job existence, closed-pipe, size and task checks',async t=>{
 const f=fixture(t),j=f.job();
 await assert.rejects(f.input({...j,id:crypto.randomUUID()},'visudo\n'),{code:'JOB_MISSING'});
 await assert.rejects(f.input(j,'x'.repeat(16385)),{code:'ARG_INVALID'});
 await assert.rejects(f.input(j,'x\0'),{code:'ARG_INVALID'});
 f.policy.require=()=>{throw Object.assign(Error('fake revoked task'),{code:'TASK_REVOKED'});};
 await assert.rejects(f.input(j,'visudo\n'),{code:'TASK_REVOKED'});
 f.policy.require=()=>f.task;j.child.stdin.end();
 await assert.rejects(f.input(j,'visudo\n'),{code:'STDIN_ALREADY_CLOSED'});
 assert.equal(f.written.length,0);
});
