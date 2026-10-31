import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {compactToolReturn} from '../app/v1/return-archive.mjs';
import {toolResult} from '../app/v06/features.mjs';
import {CallTrace,measureResponseLength} from '../app/call-trace.mjs';
import {taskWaitState} from '../app/v1/wait-state.mjs';
import {RelayKeeper} from '../app/v1/relay-keeper.mjs';
import {TaskReceipts} from '../app/task-receipts.mjs';
import {ResumeKeeper} from '../app/v1/resume.mjs';
import {TOOLS} from '../app/tools.mjs';
import {parseActivityNotes,appendActivityNote,readActivityNotes} from '../app/v1/activity-notes.mjs';

test('1049 activity: real line breaks; legacy separators are decoded only outside JSON strings',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ch1049-notes-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'activity.jsonl');
 const a={event:'one',summary:'正文里字面的 \\n、对象符号 { } 和引号 " 都不能被替换'};
 const b={event:'two',summary:'第二条\n真正含换行的正文'};
 appendActivityNote(file,a);appendActivityNote(file,b);
 const actual=fs.readFileSync(file,'utf8');
 assert.equal(actual,JSON.stringify(a)+'\n'+JSON.stringify(b)+'\n');
 assert.deepEqual(readActivityNotes(file),[a,b]);
 const legacy=JSON.stringify(a)+'\\n'+JSON.stringify(b)+'\\n';
 assert.deepEqual(parseActivityNotes(legacy),[a,b]);
 assert.equal(a.summary,parseActivityNotes(legacy)[0].summary);
 assert.throws(()=>parseActivityNotes(JSON.stringify(a)+'BROKEN'+JSON.stringify(b)),SyntaxError);
});


test('1049 large text: only payload is archived; refs, nonce and receipts remain in visible result',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ch1049-returns-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store={root,checkActive(write){assert.equal(write,true);},writable(rel){return path.join(root,rel);}};
 const content=Array.from({length:250},(_,i)=>'长结果 '+i+'：这段是本地分段读取的文字。').join('\n');
 const source={content,ref:'frame:21',refs:[{ref:'element:4'}],nonce:'public-sample-nonce',permissions:{read:true},receipt_id:'receipt-X',next_offset:2400};
 const privateResult=compactToolReturn(source,{store,tool:'read_text'});
 assert.equal(privateResult,source);assert.equal(privateResult.nonce,source.nonce);assert.equal(fs.existsSync(path.join(root,'ChatHand-工具返回.noindex')),false,'nonce/private-bearing result never lands in an AI-readable archive');
 const publicSource={...source};delete publicSource.nonce;const compact=compactToolReturn(publicSource,{store,tool:'read_text'});
 assert.equal(compact.ref,source.ref);
 assert.deepEqual(compact.refs,source.refs);
 assert.equal(Object.hasOwn(compact,'nonce'),false);
 assert.deepEqual(compact.permissions,source.permissions);
 assert.equal(compact.receipt_id,source.receipt_id);
 assert.equal(compact.next_offset,source.next_offset);
 assert.equal(compact.output_summary.compacted,true);
 assert.ok(compact.content.length<content.length);
 assert.equal(fs.readFileSync(compact.output_summary.file_path,'utf8'),content);
 assert.equal(fs.statSync(compact.output_summary.file_path).mode&0o777,0o600);
 assert.equal(compact.output_summary.read_segments.tool,'read_file');
 assert.ok(!JSON.stringify(toolResult(compact)).includes(content));
 assert.equal(Object.hasOwn(compact,'structuredContent'),false);
 const segment={content:'一'.repeat(2800)};
 assert.equal(compactToolReturn(segment,{store,tool:'read_file',args:{path:compact.output_summary.file_path,max_bytes:3000}}),segment);
 assert.equal(compactToolReturn(source,{store,tool:'command_result',args:{full:true}}),source);
});

test('1049 large result: no archiving of images, base64, private card metadata or secrets',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ch1049-private-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store={root,checkActive(){},writable(rel){return path.join(root,rel);}};
 const big='隐私样例'.repeat(1500);
 const cases=[
  {content:big,image_base64:'aW1hZ2U=',mimeType:'image/png'},
  {content:big,_card_meta:{'chathand/card_nonce':'PRIVATE_NONCE'}},
  {content:big,_meta:{'widget/private':'PRIVATE_META'}},
  {content:big,secret:'PRIVATE_SECRET'},
  {content:big,blob:Buffer.from(crypto.randomBytes(3500)).toString('base64')}
 ];
 for(const value of cases)assert.equal(compactToolReturn(value,{store,tool:'read_file'}),value);
 assert.equal(fs.existsSync(path.join(root,'ChatHand-工具返回.noindex')),false);
});


test('1049 traces numeric return length for each completed local call, never payload',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ch1049-length-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const trace=new CallTrace(root,[{name:'read_text',annotations:{readOnlyHint:true}}]);
 const sample={jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'绝不入日志_PRIVATE_SAMPLE'}],structuredContent:{content:'绝不入日志_PRIVATE_SAMPLE'}}};
 const measured=measureResponseLength(sample);
 assert.equal(measured.chars,JSON.stringify(sample).length);
 assert.equal(measured.bytes,Buffer.byteLength(JSON.stringify(sample)));
 assert.ok(measured.bytes>measured.chars);
 const id=trace.receiveRPC({method:'tools/call',params:{name:'read_text',arguments:{path:'a.txt'}}},'owner');
 trace.handled(id,sample,measured);
 const stored=fs.readFileSync(trace.file,'utf8');
 assert.ok(!stored.includes('绝不入日志_PRIVATE_SAMPLE'));
 const last=JSON.parse(stored.trim().split('\n').at(-1));
 assert.equal(last.response_chars,measured.chars);
 assert.equal(last.response_bytes,measured.bytes);
 assert.equal(last.ack_scope,'local_handler_only');
 assert.equal(measureResponseLength(null).bytes,0);
});


test('1049 wait state: command, AI next step and external conditions are disjoint',()=>{
 const task={status:'active',jobs:['job-1']};
 const base={task,jobs:[],confirmations:[]};
 assert.equal(taskWaitState(base).kind,'ai');
 assert.equal(taskWaitState({...base,jobs:[{job_id:'job-1',status:'running',process_alive:true}]}).kind,'command');
 assert.equal(taskWaitState({...base,jobs:[{job_id:'job-other',status:'running',process_alive:true}]}).kind,'ai');
 assert.equal(taskWaitState({...base,confirmations:[{state:'waiting'}]}).kind,'external');
 assert.equal(taskWaitState({...base,checkpoint:{last_checkpoint:{waiting_user:true}}}).kind,'external');
 assert.equal(taskWaitState({...base,artifactBusy:true}).kind,'external');
 assert.equal(taskWaitState({...base,inputs:[{job_id:'job-1',status:'pending_approval'}]}).kind,'external');
 assert.equal(taskWaitState({...base,task:{status:'pending_approval',jobs:[]}}).kind,'external');
 assert.equal(taskWaitState({...base,task:{status:'completed',jobs:[]}}),null);
 const widget=fs.readFileSync(new URL('../ui/task-widget.html',import.meta.url),'utf8');
 assert.ok(widget.includes("t.wait_state?.label"));
});


test('1049 archived 1048 expired+superseded receipt stays byte-for-byte unchanged',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ch1049-receipts-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const records=new TaskReceipts(root),caller='fixture-owner';
 const oldId=crypto.randomUUID(),newId=crypto.randomUUID();
 const receipt=id=>({task_id:id,status:'expired',end_reason:'superseded',terminal:true,execution_complete:false,finished_at:123456789,jobs:[]});
 records.saveRevocation(oldId,caller,receipt(oldId));
 const file=path.join(root,'task-receipts',oldId+'.json');
 const before=fs.readFileSync(file);
 const read=records.read(oldId,caller);
 assert.equal(read.result.status,'expired');
 assert.equal(read.result.end_reason,'superseded');
 assert.deepEqual(fs.readFileSync(file),before);
 records.saveRevocation(newId,caller,{...receipt(newId),status:'superseded'});
 assert.equal(records.read(newId,caller).result.status,'superseded');
 const main=fs.readFileSync(new URL('../ui/app.js',import.meta.url),'utf8');
 const widget=fs.readFileSync(new URL('../ui/task-widget.html',import.meta.url),'utf8');
 assert.match(main,/t\.end_reason==='superseded'/);
 assert.match(widget,/t\.end_reason==='superseded'/);
});

test('1049 guidance: cooperative checkpoint alone cannot send without an active single-use permit',t=>{
 const desc=TOOLS.find(tool=>tool.name==='task_checkpoint').description;
 assert.doesNotMatch(desc,/90秒/);
 assert.match(desc,/继续本轮/);
 const resume=new ResumeKeeper();
 const cp=resume.checkpoint('guidance-task',{done:'第六块完成',next:'接着做：测试',block:6,total:6});
 assert.match(cp.round_guidance,/不结束|continue/i);
 assert.equal(cp.waiting_user,false);
 const guidance=fs.readFileSync(new URL('../app/v1/workflow.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(guidance,/接近90秒/);
 assert.match(guidance,/checkpoint never arms automatic continuation/);
 assert.match(guidance,/未经许可绝不模拟发送/);
 const toolsSource=fs.readFileSync(new URL('../app/tools.mjs',import.meta.url),'utf8');
 assert.ok(toolsSource.includes("continuing:!args.waiting_user&&typeof args.next==='string'&&args.next.trim().startsWith('接着做')"),'checkpoint records continuing intent; the actual private interruption gate owns arming');
 const widget=fs.readFileSync(new URL('../ui/task-widget.html',import.meta.url),'utf8');
 assert.ok(widget.includes("action:'claim'")&&widget.includes("action:'begin_dispatch'"));
 assert.ok(widget.includes("if(!dispatch?.send)return;"),'widget checks the consumed permit before official sending');
 assert.ok(widget.includes('window.openai.sendFollowUpMessage'));
 assert.ok(!widget.includes("send('ui/message'"),'old parallel message sender stays retired');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ch1049-stage1-guidance-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const ctx={caller:'synthetic-only',session_hash:'a'.repeat(64),transport:'mcp_app'};
 let now=100_000,seq=0;
 const relay=new RelayKeeper({file:path.join(dir,'relay.sqlite'),now:()=>now,installationEligible:true,
  readTask:()=>({status:'active',enabled:true,stopped:false,paused:false,session_hash:ctx.session_hash,epoch:0,revision:0,checkpoint_seq:seq,manual_resume_allowed:true,auto_allowed:true})});
 t.after(()=>relay.close());
 const id='fixture-stage1-task';
 seq=1;
 assert.equal(relay.checkpoint({task_id:id,checkpoint_seq:seq,continuing:false},ctx).armed,false,'ordinary checkpoint never arms');
 seq=2;
 assert.equal(relay.checkpoint({task_id:id,checkpoint_seq:seq,continuing:true,waiting_user:true},ctx).armed,false,'waiting for user cannot arm');
 seq=3;
 const checkpoint=relay.checkpoint({task_id:id,checkpoint_seq:seq,continuing:true,waiting_user:false},ctx);assert.equal(checkpoint.armed,false,'checkpoint itself never sends');const armed=relay.interruption({task_id:id},ctx);
 assert.equal(armed.relay.state,'armed');
 const token=armed._relay_meta.card_token;
 assert.equal(relay.claim({task_id:id,card_token:token,mode:'auto'},ctx).granted,false,'20-second wait is mandatory');
 now+=20_001;
 const claimed=relay.claim({task_id:id,card_token:token,mode:'auto'},ctx);
 assert.equal(claimed.granted,true);
 assert.equal(relay.beginDispatch({task_id:id,permit_token:claimed.permit_token},ctx).send,true);
 assert.equal(relay.beginDispatch({task_id:id,permit_token:claimed.permit_token},ctx).send,false,'consumed permit cannot authorize two sends');
});
