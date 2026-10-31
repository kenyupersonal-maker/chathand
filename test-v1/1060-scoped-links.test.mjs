import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ScopedStore} from '../app/v06/access.mjs';
import {desktop} from './1052-a-fixture.mjs';

function fixture(t){const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1060-links-'))),root=path.join(base,'work');fs.mkdirSync(root);const store=new ScopedStore(root,path.join(base,'state'));store.writesEnabled=true;t.after(()=>fs.rmSync(base,{recursive:true,force:true}));return {root,store};}
test('ScopedStore rejects file and ancestor links before reading or writing, with actual path guidance',t=>{
 const {root,store}=fixture(t);fs.mkdirSync(path.join(root,'actual'));fs.writeFileSync(path.join(root,'actual/file'),'fake');
 fs.symlinkSync('actual/file',path.join(root,'link'));fs.symlinkSync('actual',path.join(root,'linked-dir'));
 for(const input of ['link','linked-dir/file','linked-dir/new']){
  assert.throws(()=>store.resolve(input,{missing:true}),e=>e.code==='LINK_BLOCKED'&&e.details.real_path.startsWith(path.join(root,'actual')));
 }
 assert.throws(()=>store.bytes('link'),{code:'LINK_BLOCKED'});
 assert.throws(()=>store.write('linked-dir/new','fake','MISSING','link-new-0001'),{code:'LINK_BLOCKED'});
 assert.equal(fs.existsSync(path.join(root,'actual/new')),false);
 assert.equal(store.bytes('actual/file').content,'fake');
});
test('public RPC file read, write and path info cannot follow an in-scope symlink',async t=>{
 const f=await desktop(t),id=await f.begin();fs.writeFileSync(path.join(f.work,'actual'),'fake');fs.symlinkSync('actual',path.join(f.work,'link'));
 for(const [name,args] of [['read_file',{path:'link'}],['get_file_info',{path:'link'}],['write_text',{task_id:id,path:'link',content:'changed',expected_sha256:'MISSING',operation_id:'public-link-write-01'}]]){
  const r=await f.rpc(name,args);assert.equal(r.isError,true);assert.equal(r.structuredContent.code,'LINK_BLOCKED',name);
 }
 assert.equal(fs.readFileSync(path.join(f.work,'actual'),'utf8'),'fake');
});
