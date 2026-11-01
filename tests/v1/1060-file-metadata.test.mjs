import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {ProjectStore} from '../../app/store.mjs';

function fixture(t){
 const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-metadata-1060-'))),root=path.join(base,'work');fs.mkdirSync(root);
 const store=new ProjectStore(root,path.join(base,'state'));store.writesEnabled=true;
 t.after(()=>fs.rmSync(base,{force:true,recursive:true}));return {base,root,store};
}
function stamp(p,directory=false){
 execFileSync('/usr/bin/xattr',['-w','org.chathand.fake','fake metadata',p]);
 execFileSync('/usr/bin/xattr',['-wx','org.chathand.binary','00ff0080',p]);
 execFileSync('/usr/bin/xattr',['-wx','com.apple.FinderInfo','5445535446414b45000000000000000000000000000000000000000000000000',p]);
 execFileSync('/bin/chmod',['+a',directory?'everyone allow read,readattr,file_inherit,directory_inherit':'everyone allow read',p]);
 if(!directory)fs.writeFileSync(p+'/..namedfork/rsrc','fake resource fork');
 fs.utimesSync(p,946684800,946684801);fs.chmodSync(p,0o1750);
}
function metadata(p){
 const s=fs.statSync(p,{bigint:true});
 return {mode:s.mode&0o7777n,atime:s.atimeNs,mtime:s.mtimeNs,birth:s.birthtimeNs,
  attrs:execFileSync('/usr/bin/xattr',['-lx',p],{encoding:'utf8'}),
  acl:execFileSync('/bin/ls',['-lde',p],{encoding:'utf8'}).split('\n').slice(1).join('\n')};
}
function cross(t,src){
 for(const name of ['linkSync','renameSync']){const original=fs[name];t.mock.method(fs,name,(a,b,...args)=>{if(a===src&&!path.basename(b).startsWith('.chathand-move-'))throw Object.assign(Error('fake EXDEV'),{code:'EXDEV'});return original(a,b,...args);});}
}
for(const action of ['move','trash-restore','restore'])for(const directory of [false,true])test(`${action} preserves macOS metadata for ${directory?'tree':'file'}`,t=>{
 const {root,store}=fixture(t),src=path.join(root,'source');
 if(directory){fs.mkdirSync(src);fs.mkdirSync(path.join(src,'empty'));fs.writeFileSync(path.join(src,'fake'),'fake bytes');stamp(path.join(src,'fake'));stamp(path.join(src,'empty'),true);}else fs.writeFileSync(src,'fake bytes');
 stamp(src,directory);const paths=directory?['','empty','fake']:[''];
 const before=paths.map(p=>metadata(path.join(src,p)));assert.ok(before[0].mode&0o1000n,'fixture actually has sticky bit');
 const hash=store.pathInfo('source').sha256;
 // Fixture inspection and pathInfo read the resource/data forks. Start the operation
 // with known access times, then restore special bits cleared by utimes.
 paths.forEach((p,i)=>{const f=path.join(src,p);fs.utimesSync(f,946684800,946684801);fs.chmodSync(f,Number(before[i].mode));});
 if(action!=='restore')cross(t,src);
 let dest;
 if(action==='move'){store.move('source','target',hash,'metadata-move');dest=path.join(root,'target');assert.equal(fs.existsSync(src),false);}
 else {const r=store.trash('source',hash,'metadata-trash');store.restoreTrash(r.trash_id,'metadata-restore');dest=src;assert.equal(store.restoreTrash(r.trash_id,'metadata-restore').replayed,true);}
 paths.forEach((p,i)=>assert.deepEqual(metadata(path.join(dest,p)),before[i],p||'root'));
});
test('missing helper leaves EXDEV source and restore payload, never a successful receipt',t=>{
 const {base,root,store}=fixture(t),src=path.join(root,'source');fs.writeFileSync(src,'fake');stamp(src);const before=metadata(src),hash=store.pathInfo('source').sha256;
 const recycled=store.trash('source',hash,'helper-trash');const payload=path.join(store.stateDir,'recycle',recycled.trash_id+'.payload');
 const old=process.env.CHATHAND_FILE_METADATA_HELPER;process.env.CHATHAND_FILE_METADATA_HELPER=path.join(base,'missing-helper');t.after(()=>{if(old===undefined)delete process.env.CHATHAND_FILE_METADATA_HELPER;else process.env.CHATHAND_FILE_METADATA_HELPER=old;});
 assert.throws(()=>store.restoreTrash(recycled.trash_id,'helper-restore'),{code:'FILE_METADATA_HELPER_UNAVAILABLE'});assert.equal(fs.existsSync(src),false);const after=metadata(payload);assert.deepEqual({...after,atime:before.atime},before); // reads may advance source atime on failure
 fs.writeFileSync(src,'fake');stamp(src);cross(t,src);assert.throws(()=>store.move('source','target',hash,'helper-move'),{code:'FILE_METADATA_HELPER_UNAVAILABLE'});assert.equal(fs.existsSync(src),true);
 assert.throws(()=>store.move('source','target',hash,'helper-move'),{code:'OP_INCOMPLETE'});
});
test('metadata changed after verified copy is detected before removal and source is returned',t=>{
 const {root,store}=fixture(t),src=path.join(root,'source');fs.writeFileSync(src,'fake');stamp(src);const hash=store.pathInfo('source').sha256;cross(t,src);
 const rename=fs.renameSync;t.mock.method(fs,'renameSync',(a,b)=>{const r=rename(a,b);if(a===src&&path.basename(b).startsWith('.chathand-move-'))execFileSync('/usr/bin/xattr',['-w','org.chathand.fake','fake changed metadata',b]);return r;});
 assert.throws(()=>store.move('source','target',hash,'metadata-race'),{code:'FILE_METADATA_UNPRESERVED'});assert.equal(execFileSync('/usr/bin/xattr',['-p','org.chathand.fake',src],{encoding:'utf8'}).trim(),'fake changed metadata');
 assert.throws(()=>store.move('source','target',hash,'metadata-race'),{code:'OP_INCOMPLETE'});
});
test('metadata loss in destination is rejected before removing source',t=>{
 const {root,store}=fixture(t),src=path.join(root,'source'),dest=path.join(root,'target');fs.writeFileSync(src,'fake');stamp(src);const hash=store.pathInfo('source').sha256;cross(t,src);
 const stat=fs.lstatSync;t.mock.method(fs,'lstatSync',(p,...rest)=>{if(p===dest&&rest[0]?.bigint&&fs.existsSync(dest)){const listed=execFileSync('/usr/bin/xattr',[dest],{encoding:'utf8'});if(listed.includes('org.chathand.fake'))execFileSync('/usr/bin/xattr',['-d','org.chathand.fake',dest]);}return stat(p,...rest);});
 assert.throws(()=>store.move('source','target',hash,'metadata-corrupt'),{code:'FILE_METADATA_UNPRESERVED'});assert.equal(fs.existsSync(src),true);
});
test('resource forks larger than 64 MiB are streamed and preserved',t=>{
 const {root,store}=fixture(t),src=path.join(root,'source');fs.writeFileSync(src,'fake');fs.writeFileSync(src+'/..namedfork/rsrc',Buffer.alloc(64*1024*1024+1,42));cross(t,src);
 store.move('source','target',store.pathInfo('source').sha256,'metadata-large-fork');assert.equal(fs.existsSync(src),false);assert.deepEqual(fs.readFileSync(path.join(root,'target')+'/..namedfork/rsrc'),Buffer.alloc(64*1024*1024+1,42));
});
test('native metadata endpoint refuses links, wrong identities and never creates destination',t=>{
 const {base}=fixture(t),f=path.join(base,'fake');fs.writeFileSync(f,'fake');const s=fs.statSync(f),identity={dev:String(s.dev),ino:String(s.ino)};
 function call(source,extra={}){const r=spawnSync(process.env.CHATHAND_FILE_METADATA_HELPER,[],{input:JSON.stringify({version:1,action:'path-metadata',operation:'capture',source,identity,...extra}),encoding:'utf8'});assert.equal(r.status,1);return JSON.parse(r.stdout).error.code;}
 assert.equal(call(f,{identity:{...identity,ino:'0'}}),'ARTIFACT_HASH_CHANGED');fs.symlinkSync(f,path.join(base,'link'));assert.equal(call(path.join(base,'link')),'ARTIFACT_LINK_UNSAFE');
 fs.linkSync(f,path.join(base,'hard'));assert.equal(call(f),'ARTIFACT_LINK_UNSAFE');fs.unlinkSync(path.join(base,'hard'));
 const dest=path.join(base,'absent');assert.equal(call(f,{operation:'copy',destination:dest,destination_identity:identity,atime_ns:'0'}),'FILE_GONE');assert.equal(fs.existsSync(dest),false);
});
test('partial source removal reconstructs metadata as well as bytes',t=>{
 const {root,store}=fixture(t),src=path.join(root,'source');fs.mkdirSync(src);fs.writeFileSync(path.join(src,'fake'),'fake bytes');stamp(path.join(src,'fake'));stamp(src,true);
 const hash=store.pathInfo('source').sha256,before=metadata(path.join(src,'fake'));cross(t,src);const rm=fs.rmSync;
 t.mock.method(fs,'rmSync',(p,options)=>{if(path.basename(p).startsWith('.chathand-move-')){fs.unlinkSync(path.join(p,'fake'));throw Object.assign(Error('fake removal failure'),{code:'EACCES'});}return rm(p,options);});
 assert.throws(()=>store.move('source','target',hash,'metadata-rollback'),{code:'EACCES'});const after=metadata(path.join(src,'fake'));assert.deepEqual({...after,atime:before.atime},before);
 assert.equal(fs.readFileSync(path.join(src,'fake'),'utf8'),'fake bytes');assert.throws(()=>store.move('source','target',hash,'metadata-rollback'),{code:'OP_INCOMPLETE'});
});
test('fresh APFS nanosecond modification and creation timestamps survive a copy',t=>{
 const {root,store}=fixture(t),src=path.join(root,'source');fs.writeFileSync(src,'fake fractional timestamps');const hash=store.pathInfo('source').sha256,before=metadata(src);
 assert.notEqual(before.mtime%1000000n,0n,'fixture supplies sub-millisecond mtime');cross(t,src);store.move('source','target',hash,'metadata-nanoseconds');assert.deepEqual(metadata(path.join(root,'target')),before);
});
test('a substituted destination inode is never given the source metadata',t=>{
 const {base,root,store}=fixture(t),src=path.join(root,'source'),dest=path.join(root,'target');fs.writeFileSync(src,'fake source');stamp(src);const hash=store.pathInfo('source').sha256;cross(t,src);
 const close=fs.closeSync;let foreign;
 t.mock.method(fs,'closeSync',fd=>{const r=close(fd);if(!foreign&&fs.existsSync(dest)){fs.renameSync(dest,path.join(base,'own-displaced-copy'));fs.writeFileSync(dest,'fake foreign destination');execFileSync('/usr/bin/xattr',['-w','org.chathand.foreign','fake untouched',dest]);foreign=metadata(dest);}return r;});
 assert.throws(()=>store.move('source','target',hash,'metadata-destination-race'),{code:'FILE_METADATA_UNPRESERVED'});assert.deepEqual(metadata(dest),foreign);assert.equal(fs.readFileSync(dest,'utf8'),'fake foreign destination');assert.equal(fs.existsSync(src),true);
});
