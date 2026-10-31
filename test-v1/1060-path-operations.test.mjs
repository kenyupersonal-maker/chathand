import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ProjectStore} from '../app/store.mjs';
import {digest,MAX_FILE_BYTES,saveJSON} from '../engine/src/core.mjs';

function fixture(t){
 const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-path-1060-'))),root=path.join(base,'work'),state=path.join(base,'state');
 fs.mkdirSync(root);const store=new ProjectStore(root,state);store.writesEnabled=true;
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));return {base,root,state,store};
}
function tree(root,name='source'){
 const dir=path.join(root,name);fs.mkdirSync(dir);fs.mkdirSync(path.join(dir,'nested'));fs.mkdirSync(path.join(dir,'empty'));
 fs.writeFileSync(path.join(dir,'nested','binary'),Buffer.from([0,255,1,2,128]));fs.chmodSync(path.join(dir,'nested','binary'),0o640);
 fs.writeFileSync(path.join(dir,'.env'),'fake-value');return dir;
}
function crossDevice(t,src){
 const rename=fs.renameSync,link=fs.linkSync;
 t.mock.method(fs,'renameSync',(a,b)=>{if(a===src&&!path.basename(b).startsWith('.chathand-move-'))throw Object.assign(Error('simulated cross-device'),{code:'EXDEV'});return rename(a,b);});
 t.mock.method(fs,'linkSync',(a,b)=>{if(a===src)throw Object.assign(Error('simulated cross-device'),{code:'EXDEV'});return link(a,b);});
}
function interceptDestinationWrites(t,dest,action){
 const open=fs.openSync,write=fs.writeSync,close=fs.closeSync,fds=new Set();
 t.mock.method(fs,'openSync',(p,flags,...args)=>{const fd=open(p,flags,...args);if((p===dest||String(p).startsWith(dest+path.sep))&&typeof flags==='number'&&(flags&fs.constants.O_WRONLY))fds.add(fd);return fd;});
 t.mock.method(fs,'closeSync',fd=>{fds.delete(fd);return close(fd);});
 t.mock.method(fs,'writeSync',(...args)=>fds.has(args[0])?action(write,args):write(...args));
}
function expectUnknown(store,id,fn){assert.equal(JSON.parse(fs.readFileSync(store.operationFile(id))).status,'prepared');assert.throws(fn,{code:'OP_INCOMPLETE'});}

test('arbitrary binary file moves, recycles and restores without relaxing text limits',t=>{
 const {root,store}=fixture(t),bytes=Buffer.alloc(MAX_FILE_BYTES+17,255);bytes[0]=0;fs.writeFileSync(path.join(root,'binary'),bytes);
 assert.throws(()=>store.read('binary'),{code:'FILE_TOO_LARGE'});const h=store.pathInfo('binary');assert.equal(h.sha256,digest(bytes));
 const moved=store.move('binary','renamed',h.sha256,'binary-move-01');assert.equal(moved.type,'file');assert.equal(fs.existsSync(path.join(root,'binary')),false);
 assert.equal(store.move('binary','renamed',h.sha256,'binary-move-01').replayed,true);
 const recycled=store.trash('renamed',h.sha256,'binary-trash-01');assert.equal(store.trash('renamed',h.sha256,'binary-trash-01').replayed,true);
 assert.equal(fs.existsSync(path.join(root,'renamed')),false);assert.match(recycled.location,/不是系统/);
 store.restoreTrash(recycled.trash_id,'binary-restore-01');assert.deepEqual(fs.readFileSync(path.join(root,'renamed')),bytes);
 assert.equal(store.restoreTrash(recycled.trash_id,'binary-restore-01').replayed,true);
});
test('directory hash is deterministic; same-device move/trash/restore preserve empty dirs and modes',t=>{
 const {root,store,state}=fixture(t);tree(root);const before=store.pathInfo('source');assert.equal(before.hash_kind,'chathand-directory-v1');assert.equal(before.entries,5);
 store.move('source','moved',before.sha256,'directory-move-01');assert.equal(store.pathInfo('moved').sha256,before.sha256);assert.equal(fs.existsSync(path.join(root,'source')),false);
 assert.equal(store.move('source','moved',before.sha256,'directory-move-01').replayed,true);
 const result=store.trash('moved',before.sha256,'directory-trash-01');assert.ok(fs.statSync(path.join(state,'recycle',result.trash_id+'.payload')).isDirectory());
 store.restoreTrash(result.trash_id,'directory-restore-01');assert.equal(store.pathInfo('moved').sha256,before.sha256);assert.equal(fs.statSync(path.join(root,'moved/nested/binary')).mode&0o777,0o640);
 assert.equal(store.restoreTrash(result.trash_id,'directory-restore-01').replayed,true);
});
for(const kind of ['file','directory'])test(`${kind} cross-device move verifies contents then removes source`,t=>{
 const {root,store}=fixture(t),src=path.join(root,'source');if(kind==='directory')tree(root);else fs.writeFileSync(src,Buffer.from([0,255,2]));
 const h=store.pathInfo('source').sha256;crossDevice(t,src);store.move('source','target',h,'cross-device-01');
 assert.equal(fs.existsSync(src),false);assert.equal(store.pathInfo('target').sha256,h);assert.equal(fs.readdirSync(root).some(n=>n.startsWith('.chathand-move-')),false);
});
for(const kind of ['file','directory'])test(`${kind} partial cross-device write leaves original intact and cannot replay`,t=>{
 const {root,store}=fixture(t),src=path.join(root,'source');if(kind==='directory')tree(root);else fs.writeFileSync(src,Buffer.from([0,255,2]));
 const h=store.pathInfo('source').sha256;crossDevice(t,src);
 interceptDestinationWrites(t,path.join(root,'target'),(write,args)=>{write(args[0],args[1],args[2],1);throw Object.assign(Error('simulated partial write'),{code:'ENOSPC'});});
 assert.throws(()=>store.move('source','target',h,'partial-copy-01'),{code:'ENOSPC'});assert.equal(store.pathInfo('source').sha256,h);
 expectUnknown(store,'partial-copy-01',()=>store.move('source','target',h,'partial-copy-01'));
});
test('cross-device corrupt copy is rejected before source removal',t=>{
 const {root,store}=fixture(t),src=path.join(root,'source');fs.writeFileSync(src,'fake-original');const h=store.pathInfo('source').sha256;crossDevice(t,src);
 interceptDestinationWrites(t,path.join(root,'target'),(write,[fd,data,...rest])=>write(fd,Buffer.alloc(data.length,88),...rest));
 assert.throws(()=>store.move('source','target',h,'corrupt-copy-01'),{code:'COPY_VERIFY_FAILED'});assert.equal(store.pathInfo('source').sha256,h);
});
test('copy fails if source changes during transfer; source is not removed',t=>{
 const {root,store}=fixture(t),src=path.join(root,'source');fs.writeFileSync(src,'fake-original');const h=store.pathInfo('source').sha256;crossDevice(t,src);
 const close=fs.closeSync;let changed=false;t.mock.method(fs,'closeSync',fd=>{const r=close(fd);if(!changed&&fs.existsSync(path.join(root,'target'))){changed=true;fs.writeFileSync(src,'fake-new-value');}return r;});
 assert.throws(()=>store.move('source','target',h,'changed-copy-01'),{code:'FILE_CHANGED'});assert.equal(fs.readFileSync(src,'utf8'),'fake-new-value');
});
test('partial source removal failure reconstructs source from verified copy and retains unknown receipt',t=>{
 const {root,store}=fixture(t),src=tree(root),h=store.pathInfo('source').sha256;crossDevice(t,src);const rm=fs.rmSync;
 t.mock.method(fs,'rmSync',(p,opts)=>{if(path.basename(p).startsWith('.chathand-move-')){fs.unlinkSync(path.join(p,'.env'));throw Object.assign(Error('simulated removal failure'),{code:'EACCES'});}return rm(p,opts);});
 assert.throws(()=>store.move('source','target',h,'remove-failure-01'),{code:'EACCES'});assert.equal(store.pathInfo('source').sha256,h);assert.equal(store.pathInfo('target').sha256,h);
 expectUnknown(store,'remove-failure-01',()=>store.move('source','target',h,'remove-failure-01'));
});
test('same-device unlink and directory rename failure leave original intact',t=>{
 const {root,store}=fixture(t);fs.writeFileSync(path.join(root,'file'),'fake');tree(root);const fh=store.pathInfo('file').sha256,dh=store.pathInfo('source').sha256;
 const unlink=fs.unlinkSync,rename=fs.renameSync;
 t.mock.method(fs,'unlinkSync',p=>{if(p===path.join(root,'file'))throw Object.assign(Error('simulated unlink failure'),{code:'EPERM'});return unlink(p);});
 t.mock.method(fs,'renameSync',(a,b)=>{if(a===path.join(root,'source'))throw Object.assign(Error('simulated rename failure'),{code:'EACCES'});return rename(a,b);});
 assert.throws(()=>store.move('file','file-target',fh,'same-file-failure'),{code:'EPERM'});assert.equal(store.pathInfo('file').sha256,fh);assert.equal(fs.existsSync(path.join(root,'file-target')),false);
 assert.throws(()=>store.move('source','dir-target',dh,'same-dir-failure'),{code:'EACCES'});assert.equal(store.pathInfo('source').sha256,dh);assert.equal(fs.existsSync(path.join(root,'dir-target')),false);
});
for(const linkType of ['symlink','hardlink'])test(`${linkType} root and descendant are rejected without mutation`,t=>{
 const {root,store,base}=fixture(t);fs.writeFileSync(path.join(base,'outside'),'fake');const dir=tree(root),link=path.join(dir,'linked');
 if(linkType==='symlink')fs.symlinkSync(path.join(base,'outside'),link);else fs.linkSync(path.join(base,'outside'),link);
 assert.throws(()=>store.pathInfo('source/linked'),{code:'LINK_BLOCKED'});assert.throws(()=>store.trash('source','0'.repeat(64),'linked-trash-01'),{code:'LINK_BLOCKED'});
 assert.ok(fs.existsSync(dir));assert.equal(fs.readFileSync(path.join(base,'outside'),'utf8'),'fake');
});
test('scope, root, data ancestors and runtime App remain protected',t=>{
 const {root,store,base}=fixture(t);assert.throws(()=>store.pathInfo('../outside'),{code:'PATH_INVALID'});
 assert.throws(()=>store.move('.','moved','0'.repeat(64),'root-move-01'));assert.throws(()=>store.trash('/','0'.repeat(64),'root-trash-01'));
 const outer=path.join(root,'outer');fs.mkdirSync(outer);const nested=new ProjectStore(root,path.join(outer,'data'));nested.writesEnabled=true;
 assert.throws(()=>nested.trash('outer','0'.repeat(64),'self-data-trash'),{code:'PATH_BLOCKED'});
 store.runtimeRoot=path.join(root,'Fake.app');fs.mkdirSync(store.runtimeRoot);fs.writeFileSync(path.join(store.runtimeRoot,'fake'),'fake');
 assert.throws(()=>store.trash('Fake.app','0'.repeat(64),'self-app-trash'),{code:'PATH_BLOCKED'});
 assert.throws(()=>store.setRoot(store.stateDir),{code:'ROOT_STATE_OVERLAP'});assert.ok(fs.existsSync(base));
});
test('conflicts, destination exists, descendant move and operation-id conflicts preserve sources',t=>{
 const {root,store}=fixture(t);tree(root);const h=store.pathInfo('source').sha256;fs.mkdirSync(path.join(root,'target'));
 assert.throws(()=>store.move('source','target',h,'existing-move-01'),{code:'EEXIST'});
 assert.throws(()=>store.move('source','source/new',h,'nested-move-01'),{code:'PATH_INVALID'});
 assert.throws(()=>store.trash('source','0'.repeat(64),'hash-trash-01'),{code:'HASH_CONFLICT'});
 assert.throws(()=>store.trash('source',h,'hash-trash-01'),{code:'OP_CONFLICT'});assert.equal(store.pathInfo('source').sha256,h);
});
test('restore never overwrites existing destination; legacy text receipts still restore',t=>{
 const {root,store,state}=fixture(t);fs.writeFileSync(path.join(root,'file'),'fake-original');const h=store.pathInfo('file').sha256,r=store.trash('file',h,'restore-conflict-trash');
 fs.writeFileSync(path.join(root,'file'),'fake-new');assert.throws(()=>store.restoreTrash(r.trash_id,'restore-conflict-01'),{code:'HASH_CONFLICT'});assert.equal(fs.readFileSync(path.join(root,'file'),'utf8'),'fake-new');
 const id='00000000-0000-4000-8000-000000000001';saveJSON(path.join(state,'recycle',id+'.json'),{root,path:'legacy',content:'fake-legacy',sha256:digest('fake-legacy'),mode:0o600});
 store.restoreTrash(id,'legacy-restore-01');assert.equal(fs.readFileSync(path.join(root,'legacy'),'utf8'),'fake-legacy');
});
test('prepared/unknown records never rerun, applied replay survives restart',t=>{
 const {root,state,store}=fixture(t);fs.writeFileSync(path.join(root,'source'),'fake');const h=store.pathInfo('source').sha256;
 store.move('source','target',h,'restart-move-01');const restarted=new ProjectStore(root,state);restarted.writesEnabled=true;
 assert.equal(restarted.move('source','target',h,'restart-move-01').replayed,true);
 for(const status of ['prepared','unknown']){const id='receipt-'+status;saveJSON(store.operationFile(id),{kind:'trash_path',fingerprint:digest(JSON.stringify([root,'trash_path',['target',h]])),status});assert.throws(()=>restarted.trash('target',h,id),{code:'OP_INCOMPLETE'});}
 assert.equal(store.pathInfo('target').sha256,h);
});

test('cross-device directory trash is recoverable and copy failure never becomes recycled',t=>{
 const {root,store,state}=fixture(t),src=tree(root),h=store.pathInfo('source').sha256;crossDevice(t,src);
 const recycled=store.trash('source',h,'cross-trash-01');assert.equal(fs.existsSync(src),false);store.restoreTrash(recycled.trash_id,'cross-restore-01');assert.equal(store.pathInfo('source').sha256,h);
 const other=tree(root,'other'),oh=store.pathInfo('other').sha256;const rename=fs.renameSync;
 t.mock.method(fs,'renameSync',(a,b)=>{if(a===other)throw Object.assign(Error('simulated cross-device'),{code:'EXDEV'});return rename(a,b);});
 interceptDestinationWrites(t,path.join(state,'recycle'),()=>{throw Object.assign(Error('simulated no space'),{code:'ENOSPC'});});
 assert.throws(()=>store.trash('other',oh,'failed-trash-01'),{code:'ENOSPC'});assert.equal(store.pathInfo('other').sha256,oh);
 const record=JSON.parse(fs.readFileSync(store.operationFile('failed-trash-01')));assert.equal(record.status,'prepared');
 assert.throws(()=>store.restoreTrash(record.trash_id,'failed-restore-01'),{code:'OP_INCOMPLETE'});
});
test('failed restore retains complete recyclable payload and cannot replay partial destination',t=>{
 const {root,store}=fixture(t);tree(root);const h=store.pathInfo('source').sha256,recycled=store.trash('source',h,'restore-fault-trash');
 interceptDestinationWrites(t,path.join(root,'source'),()=>{throw Object.assign(Error('simulated write failure'),{code:'ENOSPC'});});
 assert.throws(()=>store.restoreTrash(recycled.trash_id,'restore-fault-01'),{code:'ENOSPC'});
 expectUnknown(store,'restore-fault-01',()=>store.restoreTrash(recycled.trash_id,'restore-fault-01'));
 const payload=path.join(store.stateDir,'recycle',recycled.trash_id+'.payload');assert.deepEqual(fs.readFileSync(path.join(payload,'nested/binary')),Buffer.from([0,255,1,2,128]));
});
test('lost final receipt after mutation stays prepared and is never automatically repeated',t=>{
 const {root,store}=fixture(t);fs.writeFileSync(path.join(root,'source'),'fake');const h=store.pathInfo('source').sha256,rename=fs.renameSync,receipt=store.operationFile('lost-receipt-01');
 t.mock.method(fs,'renameSync',(a,b)=>{if(b===receipt&&fs.existsSync(path.join(root,'target')))throw Object.assign(Error('simulated receipt failure'),{code:'EIO'});return rename(a,b);});
 assert.throws(()=>store.move('source','target',h,'lost-receipt-01'),{code:'EIO'});assert.equal(store.pathInfo('target').sha256,h);assert.equal(fs.existsSync(path.join(root,'source')),false);
 expectUnknown(store,'lost-receipt-01',()=>store.move('source','target',h,'lost-receipt-01'));
});
test('source changed at final rename is put back without overwriting its new contents',t=>{
 const {root,store}=fixture(t),src=path.join(root,'source');fs.writeFileSync(src,'fake-original');const h=store.pathInfo('source').sha256;crossDevice(t,src);
 const rename=fs.renameSync;t.mock.method(fs,'renameSync',(a,b)=>{const result=rename(a,b);if(a===src&&path.basename(b).startsWith('.chathand-move-'))fs.writeFileSync(b,'fake-concurrent-change');return result;});
 assert.throws(()=>store.move('source','target',h,'changed-at-removal'),{code:'COPY_VERIFY_FAILED'});assert.equal(fs.readFileSync(src,'utf8'),'fake-concurrent-change');
 expectUnknown(store,'changed-at-removal',()=>store.move('source','target',h,'changed-at-removal'));
});
