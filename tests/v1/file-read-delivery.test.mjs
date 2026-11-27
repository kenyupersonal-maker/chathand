import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {PACING} from '../../app/v1/pacing.mjs';
import {fixture} from './1070-chrome-server-fixture.mjs';

async function readOnly(t){
  const f=fixture(t,{preference:'none'});
  await f.building;
  t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  f.app.store.writesEnabled=false;
  return f;
}

async function callPage(f,name,args){
  const {status,body}=await f.rpc(name,args);
  assert.equal(status,200);
  assert.equal(body.result.isError,false,JSON.stringify(body.result.structuredContent));
  const page=body.result.structuredContent;
  assert.deepEqual(JSON.parse(body.result.content[0].text),page);
  assert.equal(page.output_summary,undefined);
  assert.ok(JSON.stringify(page).length<=PACING.return_limit_chars);
  return page;
}

test('all 172 directory entries reach the caller by following the returned pages',async t=>{
  const f=await readOnly(t);
  const folder=path.join(f.app.store.root,'history');
  fs.mkdirSync(folder);
  const names=Array.from({length:172},(_,i)=>String(i).padStart(3,'0')+'-'+('历史数据abc'.repeat(8))+'.txt');
  for(const name of names)fs.writeFileSync(path.join(folder,name),'');

  let page=await callPage(f,'list_directory',{path:'history',limit:300});
  assert.ok(page.entries.length<172);
  const received=[];
  for(let pages=0;;pages++){
    assert.ok(pages<5);
    assert.equal(page.total,172);
    assert.equal(page.offset,received.length);
    assert.equal(page.incomplete,false);
    received.push(...page.entries.map(entry=>entry.name));
    if(!page.next_call){
      assert.equal(page.truncated,false);
      assert.equal(page.next_offset,null);
      assert.equal(page.next_cursor,null);
      break;
    }
    assert.equal(page.truncated,true);
    assert.equal(page.next_offset,received.length);
    assert.equal(page.next_call.name,'list_directory');
    assert.deepEqual(page.next_call.arguments,{path:'history',limit:300,offset:received.length,cursor:page.next_cursor});
    page=await callPage(f,page.next_call.name,page.next_call.arguments);
  }
  assert.deepEqual(received,names);
  assert.equal(fs.existsSync(path.join(f.app.store.root,'ChatHand-工具返回.noindex')),false);
});

for(const encoding of ['utf-8','utf-16le'])test('visible '+encoding+' pages preserve every byte position, even with JSON escaping',async t=>{
  const f=await readOnly(t);
  const content=Array.from({length:1200},(_,i)=>i+' 反斜线\\\\\\ "引号" 🌈\u001e\u001f\n').join('');
  const bytes=Buffer.from(content,encoding==='utf-8'?'utf8':'utf16le');
  const filename='history.cpp';
  fs.writeFileSync(path.join(f.app.store.root,filename),bytes);

  const parts=[];
  let offset=0,fingerprint;
  for(let pages=0;offset!==null;pages++){
    assert.ok(pages<30);
    const page=await callPage(f,'read_file',{path:filename,encoding,offset,max_bytes:12500,...(fingerprint?{fingerprint}:{})});
    assert.equal(page.offset,offset);
    assert.equal(page.total_bytes,bytes.length);
    assert.ok(page.bytes_read>0&&page.bytes_read<=12500);
    const end=offset+page.bytes_read;
    const source=bytes.subarray(offset,end);
    assert.equal(page.chunk_sha256,crypto.createHash('sha256').update(source).digest('hex'));
    assert.deepEqual(Buffer.from(page.content,encoding==='utf-8'?'utf8':'utf16le'),source);
    assert.equal(page.next_offset,end===bytes.length?null:end);
    assert.equal(page.truncated,end!==bytes.length);
    parts.push(page.content);
    offset=page.next_offset;
    fingerprint=page.fingerprint;
  }
  assert.ok(parts.length>1);
  assert.equal(parts.join(''),content);
  assert.equal(fs.existsSync(path.join(f.app.store.root,'ChatHand-工具返回.noindex')),false);
});
