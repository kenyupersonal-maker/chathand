
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {createDesktop} from '../../app/server.mjs';
import {safeLink} from '../../app/v07/browser.mjs';

const rid=()=>crypto.randomUUID();

test('safeLink exposes only credential-free http/https targets',()=>{
  assert.equal(safeLink('https://example.com/file.iso'),'https://example.com/file.iso');
  for(const u of ['javascript:alert(1)','file:///etc/passwd','https://u:p@example.com/x','chrome://settings'])
    assert.equal(safeLink(u),null);
});

test('real isolated Chrome snapshot exposes href and streams verified downloads',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'kb09-download-'));
  const work=path.join(base,'work');fs.mkdirSync(work);
  const payload=crypto.randomBytes(2*1024*1024+137);
  const sha=crypto.createHash('sha256').update(payload).digest('hex');
  const server=http.createServer((req,res)=>{
    if(req.url==='/file.bin'){
      res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="fixture.bin"','Content-Length':String(payload.length)});
      res.end(payload);
    }else{
      res.writeHead(200,{'Content-Type':'text/html'});
      res.end('<title>Download fixture</title><a id="good" href="/file.bin" download>Download fixture</a><a id="bad" href="javascript:alert(1)">Unsafe</a>');
    }
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const app=await createDesktop({stateDir:path.join(base,'state'),defaultRoot:work});
  t.after(async()=>{await app.close();await new Promise(r=>server.close(r));fs.rmSync(base,{recursive:true,force:true});});
  app.state.data.browser_backend='isolated';app.state.save();
  app.tools.automation.browser.managed.headless=true;
  const call=(name,args={})=>app.tools.invoke(name,args,'download-test');
  const task=await call('begin_task',{request_id:rid(),title:'download'});
  let view=await call('browser_open',{task_id:task.task_id,request_id:rid(),url:'http://127.0.0.1:'+server.address().port+'/'});
  const link=view.elements.find(e=>e.name==='Download fixture');
  assert.ok(link);
  assert.match(link.href,/\/file\.bin$/);
  assert.equal(view.elements.find(e=>e.name==='Unsafe').href,null);
  const result=await call('browser_download',{task_id:task.task_id,request_id:rid(),page_id:view.page_id,snapshot_id:view.snapshot_id,ref:link.ref,path:'fixture.bin',expected_sha256:sha,max_bytes:3*1024*1024});
  assert.equal(result.verified_sha256,true);
  assert.equal(result.sha256,sha);
  assert.equal(result.bytes,payload.length);
  assert.ok(fs.readFileSync(path.join(work,'fixture.bin')).equals(payload));

  view=await call('browser_open',{task_id:task.task_id,request_id:rid(),url:'http://127.0.0.1:'+server.address().port+'/',page_id:view.page_id});
  const link2=view.elements.find(e=>e.name==='Download fixture');
  await assert.rejects(
    ()=>call('browser_download',{task_id:task.task_id,request_id:rid(),page_id:view.page_id,snapshot_id:view.snapshot_id,ref:link2.ref,path:'bad.bin',expected_sha256:'0'.repeat(64),max_bytes:3*1024*1024}),
    {code:'HASH_MISMATCH'}
  );
  assert.equal(fs.existsSync(path.join(work,'bad.bin')),false);
  assert.equal(fs.readdirSync(work).some(n=>n.startsWith('bad.bin.ken-download-')),false);
  await call('browser_close',{task_id:task.task_id,request_id:rid()});
  await call('finish_task',{task_id:task.task_id,success:false});
});
