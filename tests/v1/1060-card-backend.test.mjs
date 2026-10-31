import test from 'node:test';
import assert from 'node:assert/strict';
import {consolidatedTaskCard,cardTaskView} from '../../app/v1/card-task-view.mjs';
import {withTaskCard,splitCardResult,observableToolResult} from '../../app/v1/card-meta.mjs';
import {H8Cards,cardObserverBody} from '../../app/v1/h8-cards.mjs';
import {widgetShellPresentation} from '../../app/v1/widget-shell.mjs';
import {Features,TASK_URI,LEGACY_TASK_URI,widgetResourceMeta,toolResult} from '../../app/v06/features.mjs';
import {IMAGE_BATCH_URI,LEGACY_IMAGE_BATCH_URI} from '../../app/v1/image-batch.mjs';
const checkpoints=[{at:10,block:1,total:3,done:'Read\nsource',next:'Write file'},{at:20,block:2,total:3,done:'Saved file',next:'Review output'}];
const task={task_id:'task-one',title:'One\n task',status:'active',checkpoint_seq:2,last_checkpoint:checkpoints[1],recent_steps:[{at:15,tool:'write_text',target:'DO_NOT_COPY_COMMAND',ok:true,ms:3}]};
test('root identity and timeline use actual records, never similar titles or caller metadata',()=>{
 const card=consolidatedTaskCard({...task,parent_title:'One task',session_hash:'PRIVATE',_meta:{nonce:'PRIVATE'}},{checkpoints});
 assert.equal(card.card_id,'task-one');assert.equal(card.scope,'task');assert.equal(card.title,'One  task');assert.deepEqual(card.timeline.map(x=>x.kind),['checkpoint','step','checkpoint']);assert.equal(card.progress.next,'Review output');assert.equal(card.timeline[0].done,'Read source');assert.equal(JSON.stringify(card).includes('PRIVATE'),false);assert.equal(JSON.stringify(card).includes('DO_NOT_COPY_COMMAND'),false);
 assert.notEqual(consolidatedTaskCard({...task,task_id:'task-two'}).card_id,card.card_id);
 assert.equal(consolidatedTaskCard({title:'One task'}),null);
});
test('bounded real history explicitly discloses omissions and keeps latest checkpoint IDs',()=>{
 const history=Array.from({length:25},(_,i)=>({at:i,block:i+1,done:'step '+i}));
 const card=consolidatedTaskCard({...task,checkpoint_seq:30},{checkpoints:history});
 // 30 real checkpoints minus 20 shown: five already pruned, five cropped here.
 assert.equal(card.timeline.filter(x=>x.kind==='checkpoint').length,20);assert.equal(card.coverage.omitted_checkpoints,10);assert.ok(card.timeline.some(x=>x.id==='task-one:checkpoint:30'));assert.equal(consolidatedTaskCard(task).coverage.checkpoints,'latest_only');
 assert.ok(JSON.stringify(cardTaskView(task)).length<=2000);
});
test('stall status uses supplied existing threshold decision; terminal/unknown and stop location stay truthful',()=>{
 assert.equal(consolidatedTaskCard({...task,stall:{stalled:false,quiet_ms:999999}}).status,'active');
 assert.equal(consolidatedTaskCard({...task,stall:{stalled:true}}).tone,'warning');
 const stop=consolidatedTaskCard({...task,status:'cancelled',end_reason:'user_stop'});assert.equal(stop.status,'stopped');assert.equal(stop.stopped_at.step,'Review output');assert.equal(stop.controls.continue.enabled,false);
 assert.equal(consolidatedTaskCard({...task,do_not_replay:true}).status,'unknown');assert.equal(stop.recovery.replay_completed,false);
 const blocked=consolidatedTaskCard({...task,blocker:{step:'Review attachment'}});assert.equal(blocked.stopped_at.step,'Review attachment');assert.equal(blocked.status,'blocked');
});
test('file list uses applied change receipts only and never fabricates host file IDs',()=>{
 const changes=[{tool:'write_text',path:'old.txt',status:'applied'},{tool:'move_path',path:'old.txt',destination:'new.txt',status:'applied'},{tool:'write_text',path:'delete.txt',status:'applied'},{tool:'trash_path',path:'delete.txt',status:'applied'},{tool:'save_files',status:'applied',files:[{path:'out/report.pdf',bytes:123},{path:'../escape'},{path:'https://private.invalid/file'},{path:'bad\npath'}]},{tool:'write_text',path:'failed.txt',status:'failed'},{tool:'write_text',path:'other.txt',status:'applied',task_id:'other'}];
 const card=consolidatedTaskCard(task,{changes});assert.deepEqual(card.files.map(f=>f.path),['new.txt','out/report.pdf']);
 assert.deepEqual(card.files[1].reveal.arguments,{task_id:'task-one',action:'reveal',path:'out/report.pdf'});assert.equal(card.files[1].download.status,'unverified');assert.equal(card.files[1].attachment.status,'unverified');assert.equal(JSON.stringify(card).includes('fileId'),false);
});
function fixture(){
 let now=1000,seq=2;
 const t={id:'task-one',status:'active',caller:'fixture',session_hash:'a'.repeat(64),project_id:'project',connection_principal:'fixture-connection'};
 const policy={enabled:true,epoch:1,permissionRevision:1,state:{data:{active:'project'}},tasks:new Map([[t.id,t]]),require(id,caller){const x=this.tasks.get(id);if(!x||x.caller!==caller||x.status!=='active')throw Error('TASK_OWNER');return x;}};
 const cards=new H8Cards({policy,now:()=>now,checkpointForTask:()=>seq});
 const args=[t.id,t.caller,t.session_hash,'mcp_app'];
 return {t,policy,cards,args,advance(){now+=9999999;},checkpoint(){seq++;}};
}
test('private metadata survives shaping and neither model output nor observers receive nonces/paths',()=>{
 const f=fixture(),meta=f.cards.taskControls(...f.args,{actions:['continue','stop']});
 const raw=withTaskCard({task_id:task.task_id,_card_meta:{...meta,'chathand/card_nonce':'existing-option-nonce','chathand/relay_card_token':'existing-relay-token'}},task,{checkpoints,changes:[{tool:'write_text',status:'applied',path:'private-output.txt'}]});
 const out=toolResult(raw);assert.equal(out._meta['chathand/card_nonce'],'existing-option-nonce');assert.equal(out._meta['chathand/relay_card_token'],'existing-relay-token');assert.equal(out._meta['chathand/task_card'].controls.stop.enabled,true);
 const model=JSON.stringify([out.content,out.structuredContent,observableToolResult(out)]);for(const secret of ['private-output.txt',meta['chathand/task_control_nonce'],'existing-option-nonce','existing-relay-token'])assert.equal(model.includes(secret),false);
 assert.deepEqual(splitCardResult(raw).value,{task_id:task.task_id});
 const body=cardObserverBody({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'card_answer',arguments:{nonce:meta['chathand/task_control_nonce'],choice:'stop'}}});assert.deepEqual(body.params.arguments,{});
 assert.equal(widgetShellPresentation('task_checkpoint',{},'en').task_card_meta_key,'chathand/task_card');
});
test('task control targets the nonce task only, consumes once, never dispatches work itself',()=>{
 const f=fixture(),m=f.cards.taskControls(...f.args,{actions:['stop']}),nonce=m['chathand/task_control_nonce'];
 assert.throws(()=>f.cards.consumeTaskControl(nonce,'continue',...f.args.slice(1)),{code:'CONFIRM_NONCE_INVALID'});
 const result=f.cards.consumeTaskControl(nonce,'stop',...f.args.slice(1));assert.equal(result.task_id,'task-one');assert.equal(result.scope,'task');assert.equal(f.t.status,'active');
 assert.throws(()=>f.cards.consumeTaskControl(nonce,'stop',...f.args.slice(1)),{code:'CONFIRM_NONCE_INVALID'});assert.equal(f.cards.proveConsumedCard(nonce,...f.args.slice(1)),true);
});
for(const mutation of ['caller','session','transport','checkpoint','epoch','revision','project','connection','expired','unknown','terminal'])test('task control rejects stale or foreign '+mutation,()=>{
 const f=fixture(),nonce=f.cards.taskControls(...f.args,{actions:['continue','stop']})['chathand/task_control_nonce'],args=f.args.slice(1);
 if(mutation==='caller')args[0]='other';if(mutation==='session')args[1]='b'.repeat(64);if(mutation==='transport')args[2]='other';if(mutation==='checkpoint')f.checkpoint();if(mutation==='epoch')f.policy.epoch++;if(mutation==='revision')f.policy.permissionRevision++;if(mutation==='project')f.t.project_id='other';if(mutation==='connection')f.t.connection_principal='other';if(mutation==='expired')f.advance();if(mutation==='unknown')f.cards.unknownTasks.add(f.t.id);if(mutation==='terminal')f.t.status='completed';
 assert.throws(()=>f.cards.consumeTaskControl(nonce,'stop',...args),{code:'CONFIRM_NONCE_INVALID'});
});
test('CSP metadata has compatible allowlists and no invented domain on every built-in resource',()=>{
 const expected=widgetResourceMeta();assert.deepEqual(expected.ui.csp,{connectDomains:[],resourceDomains:[]});assert.deepEqual(expected['openai/widgetCSP'],{connect_domains:[],resource_domains:[]});assert.equal(expected.ui.domain,undefined);assert.equal(expected['openai/widgetDomain'],undefined);
 for(const uri of [TASK_URI,LEGACY_TASK_URI,IMAGE_BATCH_URI,LEGACY_IMAGE_BATCH_URI])assert.deepEqual(Features.prototype.resource.call({},uri).contents[0]._meta,expected);
});
test('checkpoint option mint preserves existing private fields and ordinary nonce validation',()=>{
 const f=fixture();f.cards.register('skip_step',async()=>({ok:true}));
 const shaped=f.cards.checkpoint({task_id:'task-one',checkpoint_seq:2,checkpoint:{blocked:{options:[{label:'skip',action:'skip_step'}]}},_card_meta:{'chathand/relay_card_token':'existing-private-token'}},...f.args.slice(1));
 assert.equal(shaped._card_meta['chathand/relay_card_token'],'existing-private-token');
 const nonce=shaped._card_meta['chathand/card_nonce'];assert.equal(f.cards.consume(nonce,'1',...f.args.slice(1)).task_id,'task-one');assert.throws(()=>f.cards.consume(nonce,'1',...f.args.slice(1)),{code:'CONFIRM_NONCE_INVALID'});
});
test('optional connection principal retains null normalization; new issuance supersedes old control',()=>{
 const f=fixture();delete f.t.connection_principal;
 const old=f.cards.taskControls(...f.args,{actions:['stop']})['chathand/task_control_nonce'];const current=f.cards.taskControls(...f.args,{actions:['stop']})['chathand/task_control_nonce'];
 assert.equal(f.cards.provePrivateNonce(old,...f.args.slice(1)),false);assert.equal(f.cards.consumeTaskControl(current,'stop',...f.args.slice(1)).connection_principal,null);
});
