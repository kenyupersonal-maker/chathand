import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {FileStore} from '../../engine/src/core.mjs';
import {ExtensionBrowser} from '../../app/v09/extension-browser.mjs';
import {UploadFiles,UPLOAD_CHUNK_BYTES,UPLOAD_FILE_BYTES} from '../../app/v09/upload-files.mjs';
import {cleanHelper,frame,uploadChunkReply} from '../../app/v09/extension-host.mjs';
import {chromeStoreCompatibility} from '../../app/v1/chrome-store-contract.mjs';
import {storeTestDistribution,storeTestHelper} from '../support/chrome-store-fixture.mjs';

function fixture(t,{payload=true}={}){
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-upload-')),root=path.join(temporary,'work');fs.mkdirSync(root);
 const store=new FileStore(root,path.join(temporary,'state')),state={data:{mode:'auto',browser_enabled:true},project:()=>({path:root}),save(){}},policy={epoch:'epoch',permissionRevision:0,check(){},require(task){if(task!=='task')throw Object.assign(Error('revoked'),{code:'TASK_REVOKED'});}};
 const ext=new ExtensionBrowser(state,store,policy,{distribution:storeTestDistribution()}),session=crypto.randomUUID(),helper=storeTestHelper();if(payload)helper.features.push('upload_payload_v1');ext.heartbeat(session);ext.noteHelper(session,cleanHelper(helper));ext.pauseRequested=false;
 t.after(async()=>{await ext.closeAll();fs.rmSync(temporary,{recursive:true,force:true});});
 const start=(paths=['image.png'])=>ext.upload({task_id:'task',request_id:'upload-fixture',page_id:ext.epoch+':12',snapshot_id:'snapshot',ref:'file-ref',paths},'caller');
 const next=()=>ext.next(session,cleanHelper(helper));
 return {root,store,state,policy,ext,session,helper,start,next};
}
const bytes=count=>Buffer.alloc(count,127);
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');

test('versioned payload feature survives native hello and backend compatibility filtering',t=>{
 const f=fixture(t);f.helper.features.push('system_language_v1','invalid feature','1invalid');
 const hello=cleanHelper(f.helper);f.ext.noteHelper(f.session,hello);
 assert.ok(hello.features.includes('upload_payload_v1'));assert.ok(hello.features.includes('system_language_v1'));
 assert.equal(hello.features.some(feature=>feature.includes(' ')||feature==='1invalid'),false);
 assert.ok(chromeStoreCompatibility(f.ext.helper).features.includes('upload_payload_v1'));
});

test('old extension rejects upload without reading files while existing browser actions remain available',async t=>{
 const f=fixture(t,{payload:false});let reads=0;f.store.resolve=()=>{reads++;throw Error('must not read');};
 await assert.rejects(f.start(),{code:'CHROME_STORE_ACTION_UNSUPPORTED'});assert.equal(reads,0);
 const promise=f.ext.request('snapshot',{page_id:'12'},'caller','task'),request=f.next();assert.equal(request.action,'snapshot');f.ext.complete(f.session,request.id,{snapshot_id:'fresh'});assert.equal((await promise).snapshot_id,'fresh');
});

test('907958 byte image crosses native frames with exact bytes and closes pinned files after success',async t=>{
 const f=fixture(t),content=crypto.randomBytes(907958);fs.writeFileSync(path.join(f.root,'图片.png'),content);
 const pending=f.start(['图片.png']),request=f.next(),source=f.ext.pending.get(request.id).uploadFiles;
 assert.deepEqual(request.args.files,[{name:'图片.png',mimeType:'image/png',size:907958}]);assert.equal(JSON.stringify(request).includes(f.root),false);assert.equal('paths' in request.args,false);
 const received=[];
 for(let offset=0;offset<content.length;offset+=UPLOAD_CHUNK_BYTES){
  const message={kind:'upload_chunk',id:request.id,chunk_id:crypto.randomUUID(),index:0,offset};
  const reply=await uploadChunkReply(message,async(route,body)=>{assert.equal(route,'/api/extension/upload-chunk');return f.ext.uploadChunk(f.session,body.id,body.index,body.offset);});
  assert.equal(reply.error,undefined);assert.ok(frame(reply).length<1024*1024);received.push(Buffer.from(reply.base64,'base64'));
 }
 assert.equal(received.length,4);assert.equal(sha(Buffer.concat(received)),sha(content));assert.equal(source.complete,true);
 f.ext.complete(f.session,request.id,{status:'completed',performed:'upload',files:1});assert.equal((await pending).performed,'upload');assert.equal(source.closed,true);assert.throws(()=>fs.fstatSync(source.files[0].fd),{code:'EBADF'});
 assert.throws(()=>f.ext.uploadChunk(f.session,request.id,0,0),{code:'BROWSER_REQUEST_EXPIRED'});
});

test('per-chunk authorization, same-session binding and strict offsets reject reads after revocation',async t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.root,'image.png'),bytes(UPLOAD_CHUNK_BYTES+17));
 const pending=f.start();pending.catch(()=>{});const request=f.next(),source=f.ext.pending.get(request.id).uploadFiles;
 assert.throws(()=>f.ext.uploadChunk(crypto.randomUUID(),request.id,0,0),{code:'BROWSER_REQUEST_EXPIRED'});
 assert.throws(()=>f.ext.uploadChunk(f.session,request.id,1,0),{code:'UPLOAD_CHUNK_INVALID'});
 assert.equal(f.ext.uploadChunk(f.session,request.id,0,0).byteLength,UPLOAD_CHUNK_BYTES);
 assert.throws(()=>f.ext.uploadChunk(f.session,request.id,0,0),{code:'UPLOAD_CHUNK_INVALID'});
 f.policy.permissionRevision++;assert.throws(()=>f.ext.uploadChunk(f.session,request.id,0,UPLOAD_CHUNK_BYTES),{code:'TASK_REVOKED'});assert.equal(source.files[0].offset,UPLOAD_CHUNK_BYTES);
 f.ext.cancelAll();await assert.rejects(pending,{code:'TASK_REVOKED'});assert.equal(source.closed,true);
});

test('browser shutdown and user stop prevent the next byte and discard late completions',async t=>{
 for(const reason of ['disabled','stopped','disconnect']){
  const f=fixture(t);fs.writeFileSync(path.join(f.root,'image.png'),bytes(UPLOAD_CHUNK_BYTES+1));const pending=f.start();pending.catch(()=>{});const request=f.next(),source=f.ext.pending.get(request.id).uploadFiles;
  f.ext.uploadChunk(f.session,request.id,0,0);
  if(reason==='disabled'){f.state.data.browser_enabled=false;assert.throws(()=>f.ext.uploadChunk(f.session,request.id,0,UPLOAD_CHUNK_BYTES),{code:'CAPABILITY_OFF'});f.ext.cancelAll();}
  else if(reason==='stopped')f.ext.userStop('task',{page_id:'12'});
  else {f.ext.lastSeen=Date.now()-8000;f.ext.connectionLost();}
  await assert.rejects(pending);assert.equal(source.closed,true);assert.equal(source.files[0].offset,UPLOAD_CHUNK_BYTES);assert.throws(()=>f.ext.uploadChunk(f.session,request.id,0,UPLOAD_CHUNK_BYTES),{code:'BROWSER_REQUEST_EXPIRED'});assert.deepEqual(f.ext.complete(f.session,request.id,{performed:'upload'}),{discarded:true});
 }
});

test('file replacement and same-inode edits stop transfer; original workspace scope is reapplied',t=>{
 for(const change of ['replace','edit','scope']){
  const f=fixture(t),name=path.join(f.root,'image.png');fs.writeFileSync(name,bytes(UPLOAD_CHUNK_BYTES+10));const files=new UploadFiles(f.store,['image.png']);t.after(()=>files.close());files.read(0,0);
  if(change==='replace'){fs.renameSync(name,path.join(f.root,'previous.png'));fs.writeFileSync(name,bytes(UPLOAD_CHUNK_BYTES+10));}
  else if(change==='edit'){fs.appendFileSync(name,'changed');}
  else f.store.resolve=()=>{throw Object.assign(Error('scope revoked'),{code:'PATH_BLOCKED'});};
  assert.throws(()=>files.read(0,UPLOAD_CHUNK_BYTES),{code:change==='scope'?'PATH_BLOCKED':'UPLOAD_FILE_CHANGED'});
 }
});

test('file scope, symlink, hard-link, file count and 64 MiB boundary are enforced before transfer',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.root,'image.png'),'x');fs.symlinkSync('image.png',path.join(f.root,'link.png'));
 assert.throws(()=>new UploadFiles(f.store,['../image.png']),{code:'PATH_INVALID'});assert.throws(()=>new UploadFiles(f.store,['link.png']),{code:'LINK_BLOCKED'});assert.throws(()=>new UploadFiles(f.store,[]),{code:'ARG_INVALID'});assert.throws(()=>new UploadFiles(f.store,Array(11).fill('image.png')),{code:'ARG_INVALID'});
 fs.linkSync(path.join(f.root,'image.png'),path.join(f.root,'hard.png'));assert.throws(()=>new UploadFiles(f.store,['hard.png']),{code:'LINK_BLOCKED'});
 const boundary=path.join(f.root,'boundary.bin');fs.writeFileSync(boundary,'');fs.truncateSync(boundary,UPLOAD_FILE_BYTES);const files=new UploadFiles(f.store,['boundary.bin']);assert.equal(files.metadata()[0].size,UPLOAD_FILE_BYTES);files.close();fs.truncateSync(boundary,UPLOAD_FILE_BYTES+1);assert.throws(()=>new UploadFiles(f.store,['boundary.bin']),{code:'FILE_TOO_LARGE'});
});

test('empty and multiple files advance only at EOF and preserve metadata',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.root,'empty.txt'),'');fs.writeFileSync(path.join(f.root,'next.jpg'),'abc');const files=new UploadFiles(f.store,['empty.txt','next.jpg']);t.after(()=>files.close());
 assert.deepEqual(files.read(0,0),{index:0,offset:0,byteLength:0,base64:'',eof:true});assert.equal(files.read(1,0).base64,'YWJj');assert.equal(files.complete,true);assert.throws(()=>files.read(1,0),{code:'UPLOAD_CHUNK_INVALID'});
});

test('native chunk protocol rejects malformed requests and strips arbitrary errors and response extras',async()=>{
 let reads=0;const message={kind:'upload_chunk',id:'request',chunk_id:'chunk',index:0,offset:0},request=async()=>{reads++;return {index:0,offset:0,byteLength:1,base64:'eA==',eof:true,private_path:'/private/fixture'};};
 assert.equal(await uploadChunkReply({...message,index:10},request),null);assert.equal(await uploadChunkReply({...message,offset:-1},request),null);assert.equal(reads,0);
 const ok=await uploadChunkReply(message,request);assert.equal('private_path' in ok,false);
 const denied=await uploadChunkReply(message,async()=>{throw Object.assign(Error('private contents'),{code:'TASK_REVOKED',private_path:'secret'});});assert.deepEqual(denied.error,{code:'TASK_REVOKED'});assert.equal(JSON.stringify(denied).includes('private'),false);
 const unknown=await uploadChunkReply(message,async()=>{throw Object.assign(Error('private contents'),{code:'arbitrary'});});assert.deepEqual(unknown.error,{code:'UPLOAD_READ_FAILED'});
 const huge=await uploadChunkReply(message,async()=>({index:0,offset:0,byteLength:UPLOAD_CHUNK_BYTES+1,base64:'x',eof:true}));assert.deepEqual(huge.error,{code:'UPLOAD_READ_FAILED'});
});
