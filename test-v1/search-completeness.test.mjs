import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './1070-chrome-server-fixture.mjs';

// Production HTTP handlers with in-memory listeners and synthetic state only.
// No commands, external connectors, file permission changes or real App are used.
async function isolated(t){
 const f=fixture(t,{preference:'none'});await f.building;
 t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
 return {...f,work:f.app.store.root};
}
const lines=count=>Array.from({length:count},(_,i)=>'needle '+i).join('\n');
async function search(f){
 const response=await f.rpc('search_text',{query:'needle',path:'.'});
 assert.equal(response.status,200);assert.equal(response.body.result.isError,false);
 return response.body.result.structuredContent;
}
function completeness(result,count,complete){
 assert.equal(result.matches.length,count);assert.equal(result.at_least,count);
 assert.equal(result.truncated,!complete);assert.equal(result.incomplete,!complete);
 assert.equal(result.results_complete,complete);assert.equal(result.total,complete?count:null);
 assert.equal(result.next_offset,null);assert.equal(result.next_cursor,null);
}

for(const count of [100,101])test(`search_text distinguishes ${count} matches in one text file`,{timeout:10000},async t=>{
 const f=await isolated(t);fs.writeFileSync(path.join(f.work,'text.txt'),lines(count));
 const result=await search(f);completeness(result,100,count===100);
 assert.equal(result.matches[99].line,100);assert.equal(result.matches[99].text,'needle 99');
});

for(const count of [100,101])test(`search_text distinguishes ${count} matches across nested text files`,{timeout:10000},async t=>{
 const f=await isolated(t);fs.mkdirSync(path.join(f.work,'nested'));
 fs.writeFileSync(path.join(f.work,'nested','first.txt'),lines(60));
 fs.writeFileSync(path.join(f.work,'last.txt'),lines(count-60));
 completeness(await search(f),100,count===100);
});

test('exactly 100 matches remain complete after scanning later nonmatching text and excluded binary',{timeout:10000},async t=>{
 const f=await isolated(t);fs.writeFileSync(path.join(f.work,'a.txt'),lines(100));
 fs.writeFileSync(path.join(f.work,'b.txt'),'ordinary nonmatching text');
 fs.writeFileSync(path.join(f.work,'c.bin'),Buffer.from('needle\0binary'));
 completeness(await search(f),100,true);
});

for(const withSmallText of [false,true])test(`oversized valid UTF-8 makes ${withSmallText?'mixed':'single-file'} search incomplete without increasing read limits`,{timeout:10000},async t=>{
 const f=await isolated(t),large=path.join(f.work,'large.txt');
 fs.writeFileSync(large,'x'.repeat(8*1024*1024+1)+'\nneedle\n');
 if(withSmallText)fs.writeFileSync(path.join(f.work,'small.txt'),'needle');
 assert.throws(()=>f.app.store.bytes('large.txt'),e=>e.code==='FILE_TOO_LARGE');
 completeness(await search(f),withSmallText?1:0,false);
 assert.equal(fs.statSync(large).size,8*1024*1024+9);
});

test('synthetic read failure leaves total unknown while retaining readable text matches',{timeout:10000},async t=>{
 const f=await isolated(t);fs.writeFileSync(path.join(f.work,'a.txt'),'needle');
 fs.writeFileSync(path.join(f.work,'b.txt'),'needle');
 const bytes=f.app.store.bytes.bind(f.app.store);
 t.mock.method(f.app.store,'bytes',input=>{
  if(input==='a.txt')throw Object.assign(Error('Synthetic unreadable text'),{code:'EACCES'});
  return bytes(input);
 });
 const result=await search(f);completeness(result,1,false);assert.equal(result.matches[0].path,'b.txt');
});

test('pause during text reads cannot be reported as a complete search',{timeout:10000},async t=>{
 const f=await isolated(t);for(const name of ['a.txt','b.txt','c.txt'])fs.writeFileSync(path.join(f.work,name),'needle');
 const bytes=f.app.store.bytes.bind(f.app.store);let blocked=0;
 t.mock.method(f.app.store,'bytes',input=>{
  if(input==='b.txt')f.app.store.paused=true;
  try{return bytes(input);}catch(error){assert.equal(error.code,'PAUSED');blocked++;throw error;}
 });
 const result=await search(f);completeness(result,1,false);assert.equal(result.matches[0].path,'a.txt');
 assert.equal(blocked,2);assert.throws(()=>f.app.store.search('needle'),e=>e.code==='PAUSED');
});

test('unsupported text encoding leaves completeness unknown but explicit binary exclusion does not',{timeout:10000},async t=>{
 const f=await isolated(t);fs.writeFileSync(path.join(f.work,'a.bin'),Buffer.from('needle\0binary'));
 completeness(await search(f),0,true);
 fs.writeFileSync(path.join(f.work,'b.txt'),Buffer.from([0xff,0xfe,0x61]));
 completeness(await search(f),0,false);
});
