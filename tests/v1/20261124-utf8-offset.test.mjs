import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {FileReader} from '../../app/v06/files.mjs';

function fixture(t,bytes){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-utf8-offset-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'content.txt');fs.writeFileSync(file,bytes);
 const store={
  checkActive(){},requireWorkspace(){},audit(){},
  openRead(request){assert.equal(request,file);const fd=fs.openSync(file,'r');return {fd,path:file,stat:fs.fstatSync(fd)};}
 };
 return {file,reader:new FileReader(store)};
}
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

test('offsets inside every byte of a three-byte Han character and four-byte emoji return their validated character start',async t=>{
 const value='a汉b🌈c🤖z',bytes=Buffer.from(value),{file,reader}=fixture(t,bytes);
 for(const character of ['汉','🌈','🤖']){
  const start=bytes.indexOf(Buffer.from(character)),width=Buffer.byteLength(character);
  for(let inside=1;inside<width;inside++){
   const requested=start+inside;
   const r=await reader.read({path:file,offset:requested,max_bytes:24});
   assert.equal(r.offset,start);
   assert.equal(r.requested_offset,requested);
   assert.equal(r.bytes_read,bytes.length-start);
   assert.equal(r.next_offset,null);
   assert.equal(r.content,value.slice(Buffer.from(value.slice(0)).subarray(0,start).toString().length));
   assert.equal(r.chunk_sha256,sha256(bytes.subarray(start)));
  }
 }
});

test('large mixed text pages losslessly using next_offset, with real byte lengths and hashes',async t=>{
 const body=('前缀漢字-A 8️⃣ 🌈🤖 English é 中间\\n').repeat(11000);
 const bytes=Buffer.from(body),{file,reader}=fixture(t,bytes);
 const parts=[];let offset=0,pages=0;
 while(true){
  const r=await reader.read({path:file,offset,max_bytes:4096});
  assert.equal(r.offset,offset);
  assert.equal(r.requested_offset,undefined);
  assert.ok(r.bytes_read>0&&r.bytes_read<=4096);
  assert.equal(r.bytes_read,Buffer.byteLength(r.content));
  assert.equal(r.chunk_sha256,sha256(bytes.subarray(offset,offset+r.bytes_read)));
  parts.push(Buffer.from(r.content));pages++;
  if(r.next_offset===null)break;
  assert.equal(r.next_offset,offset+r.bytes_read);
  offset=r.next_offset;
  assert.ok(pages<400,'paging must progress');
 }
 assert.ok(bytes.length>300000);
 assert.ok(pages>70);
 assert.deepEqual(Buffer.concat(parts),bytes);
});

test('ASCII and offset zero retain normal cursors; other encodings are not realigned',async t=>{
 const {file,reader}=fixture(t,Buffer.from('Plain English text only'));
 const zero=await reader.read({path:file,offset:0,max_bytes:7});
 assert.equal(zero.offset,0);assert.equal(zero.content,'Plain E');
 assert.equal(zero.next_offset,7);assert.equal(zero.requested_offset,undefined);
 const later=await reader.read({path:file,offset:5,max_bytes:7});
 assert.equal(later.offset,5);assert.equal(later.content,' Englis');assert.equal(later.bytes_read,7);
 const nonUtf=await reader.read({path:file,offset:5,max_bytes:7,encoding:'windows-1252'});
 assert.equal(nonUtf.offset,5);assert.equal(nonUtf.content,' Englis');
});

test('malformed UTF-8 remains an encoding error, including when the requested byte is a continuation',async t=>{
 for(const bytes of [Buffer.from([0x61,0xed,0xa0,0x80,0x62]),Buffer.from([0x61,0xf0,0x28,0x8c,0xbc,0x62]),Buffer.from([0x61,0x80,0x62]),Buffer.from([0x61,0xf0,0x9f])]){
  await t.test('invalid '+bytes.toString('hex'),async sub=>{
   const {file,reader}=fixture(sub,bytes);
   await assert.rejects(reader.read({path:file,offset:0,max_bytes:100}),{code:'ENCODING_INVALID'});
   const continuation=bytes.findIndex((b,i)=>i>0&&(b&0xc0)===0x80);
   if(continuation>0)await assert.rejects(reader.read({path:file,offset:continuation,max_bytes:100}),{code:'ENCODING_INVALID'});
  });
 }
});
