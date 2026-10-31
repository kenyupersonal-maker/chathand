import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {desktop} from './1052-a-fixture.mjs';import {taskProfile} from '../app/v1/task-profile.mjs';import {ResumeKeeper} from '../app/v1/resume.mjs';import {PACING} from '../app/v1/pacing.mjs';import {chathandGuide,GUIDE_TOPICS} from '../app/v1/guide.mjs';import {compactToolReturn} from '../app/v1/return-archive.mjs';
test('A4 archive trims short-node arrays to 12000 UTF16 units, preserves full JSON; 3MiB text and readonly failure are honest',async t=>{
 const f=await desktop(t),store=f.app.store,original={status:'ok',next_cursor:'next-page',nodes:Array.from({length:400},(_,i)=>({ref:'ref-'+i,text:'display text '.repeat(12)}))};
 const out=compactToolReturn(original,{store,tool:'browser_snapshot'});assert.ok(JSON.stringify(out).length<=12000);assert.equal(out.output_summary.saved,true);assert.equal(out.nodes.length+out.output_summary.omitted_items['$.nodes'],400);assert.deepEqual(JSON.parse(fs.readFileSync(out.output_summary.file_path,'utf8')),original);assert.equal(out.next_cursor,'next-page');
 const large={text:'actual text 内容。'.repeat(240000)},big=compactToolReturn(large,{store,tool:'read_file'});assert.equal(big.output_summary.saved,true);assert.equal(fs.readFileSync(big.output_summary.file_path,'utf8'),large.text);
 const denied=compactToolReturn(original,{store:{checkActive(){throw Error('readonly');}},tool:'browser_snapshot'});assert.ok(JSON.stringify(denied).length<=12000);assert.equal(denied.output_summary.saved,false);assert.equal(denied.output_summary.pagination.next_cursor,'next-page');assert.equal(denied.output_summary.file_path,undefined);
 const secret={text:'ordinary '.repeat(3000),_card_meta:{nonce:'private'}},image={mimeType:'image/png',data_base64:'a'.repeat(30000)};assert.equal(compactToolReturn(secret,{store,tool:'x'}),secret);assert.equal(compactToolReturn(image,{store,tool:'x'}),image);
});
test('A4 more than 32MiB UTF8 is not written and reports an honest smaller-query fallback',async t=>{
 const f=await desktop(t),r=compactToolReturn({text:'文 '.repeat(8500000)},{store:f.app.store,tool:'read_text'});assert.equal(r.output_summary.saved,false);assert.match(r.output_summary.note,/缩小范围/);assert.ok(JSON.stringify(r).length<=12000);
});

test('A4 archive never moves private authority metadata or a nonce/witness/host capability into readable workspace',async t=>{
 const f=await desktop(t),text='visible '.repeat(4000);
 for(const key of ['_meta','_card_meta','nonce','private_nonce','witness','host_capability','relay_permit_token','relay_card_token']){const value={text,[key]:'synthetic-private-marker'};assert.equal(compactToolReturn(value,{store:f.app.store,tool:'private-boundary'}),value);}
 assert.equal(fs.existsSync(path.join(f.work,'ChatHand-工具返回.noindex')),false);
});
