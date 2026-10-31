import test from 'node:test';
import assert from 'node:assert/strict';
import {consolidatedTaskCard} from '../../app/v1/card-task-view.mjs';
const task_id='12345678-1234-4234-8234-123456789abc';
function task(extra={}){return {task_id,title:'整理资料',status:'active',checkpoint_seq:20,...extra};}
test('long valid receipt paths cannot turn a successful result into an oversized Site card; omitted rows are disclosed',()=>{
 const paths=Array.from({length:80},(_,i)=>Array.from({length:12},()=> 'folder-'+'x'.repeat(75)).join('/')+'/result-'+i+'.txt');
 const changes=paths.map((path,i)=>({task_id,status:'applied',tool:'write_text',path,time:i}));
 const card=consolidatedTaskCard(task(),{changes});
 assert.ok(Buffer.byteLength(JSON.stringify(card),'utf8')<=32768);
 assert.ok(card.files.length>0&&card.files.length<80);
 assert.equal(card.coverage.omitted_files,80-card.files.length);
 assert.equal(card.files.at(-1).path,paths.at(-1));
 for(const file of card.files)assert.equal(file.reveal.arguments.path,file.path);
});
test('large Chinese checkpoint history keeps latest location, with bounded whole rows and truthful omissions',()=>{
 const checkpoints=Array.from({length:100},(_,i)=>({at:i,block:i+1,total:100,done:'完成'.repeat(100),next:'接续'.repeat(100)}));
 const card=consolidatedTaskCard(task({checkpoint_seq:100,last_checkpoint:checkpoints.at(-1),stall:{stalled:true}}),{checkpoints});
 assert.ok(Buffer.byteLength(JSON.stringify(card),'utf8')<=32768);
 assert.equal(card.progress.block,100);assert.equal(card.stopped_at.block,100);
 assert.ok(card.timeline.some(row=>row.block===100));
 assert.equal(card.timeline.filter(row=>row.kind==='checkpoint').length+card.coverage.omitted_checkpoints,100);
});
