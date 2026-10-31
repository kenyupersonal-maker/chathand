import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {nativeFixture} from '../support/native-fixtures.mjs';
const root=path.resolve(new URL('../..',import.meta.url).pathname);
const mac=process.platform==='darwin';
let temporary,helper;
function run(command,args){const r=spawnSync(command,args,{cwd:root,encoding:'utf8',timeout:120000});assert.equal(r.status,0,r.stderr+r.stdout);return r.stdout;}
test.before(()=>{
  if(!mac)return;
  temporary=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-sqlite-descriptors-'));
  helper=nativeFixture('document_reader');
});
test.after(()=>{if(temporary)fs.rmSync(temporary,{recursive:true,force:true});});
function database(name){const file=path.join(temporary,name+'.sqlite');run('/usr/bin/python3',['-c',`import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);c.execute('create table records(name,amount)');c.executemany('insert into records values(?,?)',[('Ken',42),('中文',84)]);c.commit();c.close()`,file]);return file;}
test('local read-only mount exception requires every descriptor on the same local read-only mount',{skip:!mac},()=>{
  const source=path.join(temporary,'mount-conditions.c'),binary=path.join(temporary,'mount-conditions');
  fs.writeFileSync(source,`#include <sys/mount.h>
#include <assert.h>
#include <stdio.h>
extern int ch_sqlite_local_readonly_mounts(int,const struct statfs *);
int main(void){
  struct statfs mounts[4]={0};
  for(int i=0;i<4;i++){mounts[i].f_flags=MNT_LOCAL|MNT_RDONLY;mounts[i].f_fsid.val[0]=7;mounts[i].f_fsid.val[1]=11;}
  assert(ch_sqlite_local_readonly_mounts(1,mounts));
  assert(ch_sqlite_local_readonly_mounts(4,mounts));
  assert(!ch_sqlite_local_readonly_mounts(0,mounts));
  assert(!ch_sqlite_local_readonly_mounts(5,mounts));
  assert(!ch_sqlite_local_readonly_mounts(1,0));
  mounts[3].f_flags=MNT_RDONLY;assert(!ch_sqlite_local_readonly_mounts(4,mounts));
  mounts[3].f_flags=MNT_LOCAL;assert(!ch_sqlite_local_readonly_mounts(4,mounts));
  mounts[3].f_flags=MNT_LOCAL|MNT_RDONLY;mounts[3].f_fsid.val[1]++;
  assert(!ch_sqlite_local_readonly_mounts(4,mounts));
  puts("PASS local readonly mount conditions");return 0;
}`);
  run('/usr/bin/xcrun',['clang','-Wall','-Werror','-Wno-unused-parameter','native/SQLiteDescriptorVFS.c',source,'-lsqlite3','-o',binary]);
  assert.match(run(binary,[]),/PASS local readonly mount conditions/);
});
async function read(file,options={},ack=true){
  const fds=[file,file+'-wal',file+'-shm',file+'-journal'].map(p=>{try{return fs.openSync(p,'r');}catch(e){if(e.code==='ENOENT')return null;throw e;}});
  const mask=fds.reduce((m,fd,i)=>m|(fd===null?0:1<<i),0);
  const child=spawn(helper,['--sqlite',JSON.stringify({path:file,limit:100,descriptor_mask:mask,...options})],{timeout:10000,stdio:['pipe','pipe','pipe',...fds.map(fd=>fd??'ignore'),'pipe']});
  fds.forEach(fd=>{if(fd!==null)fs.closeSync(fd);});
  let output='',error='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b);child.stdin.on('error',()=>{});
  child.stdio[7].once('data',()=>child.stdin.end(ack?'1':'0'));
  const [code]=await once(child,'close');
  return {code,value:JSON.parse(output),error};
}
async function hold(file,mode){
  const script=mode==='wal'?`c.execute('pragma journal_mode=wal');c.execute('pragma wal_autocheckpoint=0');c.execute("insert into records values('wal',126)");c.commit()`:`c.execute('begin exclusive')`;
  const child=spawn('/usr/bin/python3',['-u','-c',`import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);${script};print('ready',flush=True);sys.stdin.readline();c.close()`,file],{timeout:15000,stdio:['pipe','pipe','pipe']});
  await once(child.stdout,'data');return async()=>{child.stdin.end('\n');await once(child,'close');};
}
test('native descriptor reader preserves page-based SELECT, parameters, blobs and row bounds',{skip:!mac},async()=>{
  const file=database('plain');
  const a=await read(file,{query:'SELECT amount, ?, ?, ?, ?, ?, zeroblob(2048) FROM records ORDER BY amount',parameters:'["中文",true,null,1.25,1234567890123]',limit:1});
  assert.equal(a.code,0,JSON.stringify(a));assert.equal(a.value.read_only,true);assert.equal(a.value.truncated,true);
  assert.deepEqual(a.value.rows[0].slice(0,6),[42,'中文',1,null,1.25,1234567890123]);
  assert.equal(a.value.rows[0][6].bytes,2048);assert.equal(a.value.rows[0][6].truncated,true);
  assert.deepEqual((await read(file,{query:'select :name, :amount',parameters:'{"name":"Ken","amount":42}'})).value.rows,[['Ken',42]]);
  assert.notEqual((await read(file,{query:'select ?',parameters:'[]'})).code,0);
});
test('native reader reads committed rows from a live WAL using system SHM locks',{skip:!mac},async()=>{
  const file=database('wal');const close=await hold(file,'wal');
  const snapshot=()=>[file,file+'-wal',file+'-shm'].map(p=>({mode:fs.statSync(p).mode,hash:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}));
  try{
    assert.ok(fs.existsSync(file+'-wal'));assert.ok(fs.existsSync(file+'-shm'));const before=snapshot();
    const result=await read(file,{query:'select amount from records where name=?',parameters:'["wal"]'});
    assert.equal(result.code,0,JSON.stringify(result));assert.deepEqual(result.value.rows,[[126]]);assert.deepEqual(snapshot(),before);
  }finally{await close();}
});
test('native reader pages a database above the 64 MiB document limit',{skip:!mac},async()=>{
  const file=database('large');
  run('/usr/bin/python3',['-c',`import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);c.execute('create table large(payload)');c.execute('insert into large values(zeroblob(73400320))');c.commit();c.close()`,file]);
  assert.ok(fs.statSync(file).size>64*1024*1024);
  const result=await read(file,{query:'SELECT length(payload) FROM large'});
  assert.equal(result.code,0,JSON.stringify(result));assert.deepEqual(result.value.rows,[[73400320]]);
});
test('native reader rejects absent parent ACK and an ordinary exclusive database lock promptly',{skip:!mac},async()=>{
  const file=database('locked');assert.notEqual((await read(file,{},false)).code,0);
  const close=await hold(file,'exclusive');const started=Date.now();
  try{const result=await read(file);assert.notEqual(result.code,0);assert.match(result.value.error.detail,/locked/);assert.ok(Date.now()-started<2500);}finally{await close();}
});
test('native query adapter retains output and two-second execution limits',{skip:!mac,timeout:10000},async()=>{
  const file=database('limits');
  const big=await read(file,{query:"SELECT printf('%.*c',1100000,'x')"});assert.notEqual(big.code,0);assert.match(big.value.error.detail,/OUTPUT_LIMIT/);
  const started=Date.now();const expensive=await read(file,{query:'WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x) SELECT sum(n) FROM x'});
  assert.notEqual(expensive.code,0);assert.match(expensive.value.error.detail,/interrupted/);assert.ok(Date.now()-started<4000);
});
