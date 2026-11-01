import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright-core';
import {findChromeApp} from '../../app/v08/chrome-location.mjs';
import {findChrome,launchChrome,FakeChrome,startServer} from '../support/real-chrome.mjs';
import {BrowserDriver} from '../../browser-extension/driver.js';
import {UPLOAD_CHUNK_BYTES, UPLOAD_FILE_BYTES, uploadFiles, uploadChunk} from '../../browser-extension/upload.js';

const html='<!doctype html><title>Upload fixture</title><input id="default" type="FILE" multiple><input id="labelled" type="file" aria-label="Media"><input id="multi" type="file" aria-label="Multiple media" multiple><script>window.events=[];document.addEventListener("input",e=>events.push([e.target.id,e.type]));document.addEventListener("change",e=>events.push([e.target.id,e.type]));</script>';
let browser,server,origin;
test.before(async()=>{server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;const app=findChromeApp();assert.ok(app);browser=await chromium.launch({executablePath:path.join(app,'Contents/MacOS/Google Chrome'),headless:true,chromiumSandbox:true});});
test.after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
async function fixture(t,id='default'){
 const context=await browser.newContext();await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());const page=await context.newPage();await page.goto(origin);const cdp=await context.newCDPSession(page),calls=[],hooks={before:null};
 const api={tabs:{get:async()=>({id:1,url:page.url(),title:'Upload fixture'}),group:async()=>1},debugger:{attach:async()=>{},detach:async()=>{},sendCommand:async(target,method,params={})=>{calls.push({method,params});if(hooks.before)await hooks.before(method,params);return cdp.send(method,params);}}};
 const driver=new BrowserDriver(api,{experience:true,settleMs:1,pollMs:1,idleMs:60000,commandTimeoutMs:2000});
 for(const method of ['Runtime.executionContextsCleared','Runtime.executionContextDestroyed','Page.frameNavigated'])cdp.on(method,params=>{void driver.onEvent({tabId:1},method,params);});
 t.after(async()=>{await driver.detachAll();await context.close();});
 const snapshot=await driver.execute('snapshot',{page_id:'1'}),backend=(await cdp.send('DOM.describeNode',{objectId:(await cdp.send('Runtime.evaluate',{expression:'document.getElementById('+JSON.stringify(id)+')'})).result.objectId})).node.backendNodeId;
 const descriptor=[...driver.locators.values()].find(node=>node.backend===backend);assert.ok(descriptor,'Fixture AX file input');
 return {context,page,cdp,driver,calls,hooks,args:{page_id:'1',snapshot_id:snapshot.snapshot_id,ref:descriptor.ref,operation_key:crypto.randomUUID()}};
}
const metadata=(name,data)=>({name,mimeType:'application/octet-stream',size:data.length});
function source(buffers,hook){return async(index,offset)=>{if(hook)await hook(index,offset);const bytes=buffers[index].subarray(offset,offset+UPLOAD_CHUNK_BYTES);return {index,offset,byteLength:bytes.length,base64:bytes.toString('base64'),eof:offset+bytes.length===buffers[index].length};};}
const resultFiles=f=>f.page.evaluate(async()=>Promise.all([...document.querySelectorAll('input')].flatMap(node=>[...node.files].map(async file=>({name:file.name,type:file.type,size:file.size,bytes:[...new Uint8Array(await file.arrayBuffer())]})))));
const zero=async f=>{assert.deepEqual(await resultFiles(f),[]);assert.deepEqual(await f.page.evaluate(()=>events),[]);assert.equal(f.driver.activeUploads?.size||0,0);assert.equal(f.calls.some(call=>call.method==='DOM.setFileInputFiles'),false);};

test('upload descriptors and chunks enforce 64 MiB, ten-file, offset, padding and exact chunk boundaries',()=>{
 const file={name:'fixture.bin',mimeType:'application/octet-stream',size:UPLOAD_FILE_BYTES};assert.equal(uploadFiles(Array(10).fill(file)).length,10);
 for(const files of [[],Array(11).fill(file),[{...file,size:UPLOAD_FILE_BYTES+1}],[{...file,size:-1}],[{...file,name:'/local/private/path'}]])assert.throws(()=>uploadFiles(files),{code:'UPLOAD_FILES_INVALID'});
 const chunk={index:0,offset:0,byteLength:1,base64:'AA==',eof:true};assert.equal(uploadChunk(chunk,0,0,1),chunk);
 for(const changed of [{...chunk,index:1},{...chunk,offset:1},{...chunk,eof:false},{...chunk,base64:'AB=='},{...chunk,byteLength:2}])assert.throws(()=>uploadChunk(changed,0,0,1),{code:'UPLOAD_CHUNK_INVALID'});
});

test('unlabelled multiple input bypasses AX/Playwright default-name mismatch and transfers exact bytes once',async t=>{
 const f=await fixture(t),bytes=Buffer.alloc(UPLOAD_CHUNK_BYTES+137);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
 const result=await f.driver.execute('upload',{...f.args,files:[metadata('fixture.bin',bytes)]},{readUploadChunk:source([bytes])});
 assert.equal(result.status,'completed',JSON.stringify(result.error));const files=await resultFiles(f);assert.equal(files.length,1);assert.equal(Buffer.from(files[0].bytes).equals(bytes),true);assert.deepEqual(await f.page.evaluate(()=>events),[['default','input'],['default','change']]);
 assert.equal(f.calls.some(c=>c.method==='DOM.setFileInputFiles'),false);assert.equal(f.driver.activeUploads.size,0);assert.ok(f.calls.some(c=>c.method==='Runtime.releaseObjectGroup'));
});

test('labelled input, hidden original input, empty file and multiple files all receive payloads',async t=>{
 for(const id of ['labelled','multi']){
  const f=await fixture(t,id);await f.page.locator('#'+id).evaluate(node=>node.style.display='none');
  const buffers=id==='multi'?[Buffer.from('first'),Buffer.alloc(0),Buffer.from('last')]:[Buffer.from('labelled')];let emptyReads=0;
  const result=await f.driver.execute('upload',{...f.args,files:buffers.map((data,index)=>metadata(index+'.bin',data))},{readUploadChunk:source(buffers,(index)=>{if(buffers[index].length===0)emptyReads++;})});
  assert.equal(result.status,'completed',JSON.stringify(result.error));assert.deepEqual((await resultFiles(f)).map(file=>Buffer.from(file.bytes)),buffers);assert.equal(emptyReads,id==='multi'?1:0);
 }
});

test('64 MiB boundary transfers through bounded CDP messages and yields matching browser SHA-256',async t=>{
 const f=await fixture(t),bytes=Buffer.alloc(UPLOAD_FILE_BYTES,0x6b),hash=createHash('sha256').update(bytes).digest('hex');let chunks=0;
 const result=await f.driver.execute('upload',{...f.args,files:[metadata('boundary.bin',bytes)]},{readUploadChunk:source([bytes],()=>chunks++)});assert.equal(result.status,'completed',JSON.stringify(result.error));assert.equal(chunks,256);
 const actual=await f.page.evaluate(async()=>{const file=document.getElementById('default').files[0];return {size:file.size,hash:[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('')};});assert.deepEqual(actual,{size:UPLOAD_FILE_BYTES,hash});
 const chunkCalls=f.calls.filter(call=>call.method==='Runtime.callFunctionOn'&&call.params.functionDeclaration.includes('function receive'));
 assert.equal(chunkCalls.length,256);assert.ok(chunkCalls.every(call=>call.params.arguments[2].value.length<=4*Math.ceil(UPLOAD_CHUNK_BYTES/3)));
});

test('non-multiple and ambiguous inputs reject before reading bytes',async t=>{
 for(const scenario of ['single','ambiguous']){
  const f=await fixture(t,scenario==='single'?'labelled':'default');if(scenario==='ambiguous')await f.page.locator('#default').evaluate(node=>node.after(node.cloneNode()));
  let reads=0;const result=await f.driver.execute('upload',{...f.args,files:[metadata('one',Buffer.from('x')),metadata('two',Buffer.from('y'))]},{readUploadChunk:async()=>{reads++;throw Error('must not read');}});
  assert.equal(result.error.code,scenario==='single'?'UPLOAD_MULTIPLE_REQUIRED':'ELEMENT_AMBIGUOUS');assert.equal(reads,0);await zero(f);
 }
});

test('same-named replacement before upload never receives bytes from the observed input',async t=>{
 const f=await fixture(t),bytes=Buffer.from('must stay local');
 await f.page.locator('#default').evaluate(node=>node.replaceWith(node.cloneNode()));
 let reads=0;const result=await f.driver.execute('upload',{...f.args,files:[metadata('guard.bin',bytes)]},{readUploadChunk:async()=>{reads++;throw Error('replacement must not receive bytes');}});
 assert.equal(result.error.code,'ELEMENT_CHANGED');assert.equal(reads,0);await zero(f);
});

test('replacement, navigation, cancellation, detach, and final authorization revocation produce zero assignments',async t=>{
 for(const scenario of ['replacement','navigation','cancel','detach','revoke','disabled']){
  const f=await fixture(t),bytes=Buffer.from('guard'),files=[metadata('guard.bin',bytes)];let transferred=false;
  const result=await f.driver.execute('upload',{...f.args,files},{authorize:async()=>{if(scenario==='revoke'&&transferred)throw Object.assign(Error('private path must not escape'),{code:'TASK_REVOKED'});},readUploadChunk:source([bytes],async()=>{transferred=true;if(scenario==='replacement')await f.page.locator('#default').evaluate(node=>node.replaceWith(node.cloneNode()));if(scenario==='navigation')await f.page.reload();if(scenario==='cancel')f.driver.cancel(1);if(scenario==='detach')f.driver.noteDetached(1);if(scenario==='disabled')await f.page.locator('#default').evaluate(node=>node.disabled=true);})});
  assert.equal(result.status,'failed',scenario);assert.equal(result.error.details.do_not_replay,true);assert.equal(JSON.stringify(result).includes('private path must not escape'),false);await zero(f);
 }
});

test('corrupted chunks and unknown CDP failures remain bounded, sanitized and clear isolated buffers',async t=>{
 for(const scenario of ['chunk','cdp','timeout']){
  const f=await fixture(t),bytes=Buffer.from('guard');
  if(scenario!=='chunk')f.hooks.before=async(method,params)=>{if(method==='Runtime.callFunctionOn'&&params.functionDeclaration.includes('function receive')){if(scenario==='timeout')await new Promise(resolve=>setTimeout(resolve,2200));else throw Object.assign(Error('/private/fake-path bytes must not leak'),{details:{private:'fake'}});}};
  const read=source([bytes]);const result=await f.driver.execute('upload',{...f.args,files:[metadata('guard.bin',bytes)]},{readUploadChunk:async(index,offset)=>({...await read(index,offset),...(scenario==='chunk'?{offset:1}:{})})});
  assert.equal(result.status,'failed');assert.equal(result.error.code,scenario==='chunk'?'UPLOAD_CHUNK_INVALID':scenario==='timeout'?'CDP_COMMAND_TIMEOUT':'BROWSER_ACTION_FAILED');assert.equal(JSON.stringify(result).includes('/private/fake-path'),false);await zero(f);
 }
});


test('ordinary target diagnostic overlay enables DOM before Overlay without dispatching input',async t=>{
 const f=await fixture(t,'labelled');await f.driver.prepare(1,'click',f.args,f.driver.generation);
 const methods=f.calls.map(call=>call.method),overlay=methods.indexOf('Overlay.enable'),dom=methods.indexOf('DOM.enable');
 assert.ok(dom>=0&&overlay>dom);assert.ok(methods.indexOf('Overlay.highlightNode')>overlay);await zero(f);
});


test('new extension rejects legacy App paths with update recovery and no path or byte access',async t=>{
 const f=await fixture(t),secret='/private/legacy-path-never-read.png',before=f.calls.length;
 let reads=0;const result=await f.driver.execute('upload',{...f.args,paths:[secret]},{readUploadChunk:async()=>{reads++;throw Error('legacy App must not read bytes');}});
 assert.equal(reads,0);assert.equal(result.error.code,'APP_UPDATE_REQUIRED');assert.equal(result.error.details.recovery,'update_chathand');assert.equal(result.error.details.stage,'validate');assert.equal(JSON.stringify(result).includes(secret),false);
 assert.equal(f.calls.slice(before).some(call=>call.method==='DOM.resolveNode'||call.params.functionDeclaration?.includes('function begin')),false);await zero(f);
});

test('cross-origin real iframe upload keeps resolve, payload, commit and cleanup on the exact flat child session',async t=>{
 const owned=await launchChrome(findChrome()),api=new FakeChrome(owned.cdp),driver=new BrowserDriver(api,{experience:true,settleMs:1,pollMs:1,idleMs:60000}),calls=[];api.wire(driver);
 const site=await startServer({'/parent':(req,res,url)=>'<!doctype html><input id="parent" type="file" aria-label="Media"><iframe onload="this.dataset.loaded=1" src="http://localhost:'+url.port+'/child"></iframe>', '/child':'<!doctype html><input id="child" type="file" aria-label="Media" multiple><script>window.events=[];for(const type of ["input","change"])document.addEventListener(type,e=>events.push(e.type));</script>','/favicon.ico':''});
 t.after(async()=>{await driver.detachAll();await api.dispose();await owned.close();await site.close();});
 const send=api.debugger.sendCommand;api.debugger.sendCommand=async(target,method,params={})=>{calls.push({target:{...target},method,params});return send(target,method,params);};
 const tab=await api.tabs.create({url:site.base+'/parent',active:false}),end=Date.now()+5000;let loaded=false;
 while(Date.now()<end){try{loaded=await api.evaluate(tab.id,'document.querySelector("iframe")?.dataset.loaded==="1"');}catch{}if(loaded)break;await new Promise(resolve=>setTimeout(resolve,20));}assert.equal(loaded,true);
 const snapshot=await driver.execute('snapshot',{page_id:String(tab.id)}),child=snapshot.elements.find(node=>node.name==='Media'&&node.frame_id!==snapshot.frame_id);assert.ok(child,JSON.stringify(snapshot.unsupported_frames));
 const childSession=driver.frameSession(tab.id,child.frame_id);assert.ok(childSession,'Cross-origin file target must have a flat child session');
 const data=Buffer.alloc(UPLOAD_CHUNK_BYTES+23,0xa7),start=calls.length,result=await driver.execute('upload',{page_id:String(tab.id),snapshot_id:snapshot.snapshot_id,ref:child.ref,files:[metadata('child.bin',data)],operation_key:crypto.randomUUID()},{readUploadChunk:source([data])});
 assert.equal(result.status,'completed',JSON.stringify(result.error));assert.equal(await api.evaluate(tab.id,'document.getElementById("parent").files.length'),0);
 const selected=await owned.cdp.send('Runtime.evaluate',{expression:'(async()=>({events:window.events,files:await Promise.all([...document.getElementById("child").files].map(async file=>({name:file.name,size:file.size,hash:[...new Uint8Array(await crypto.subtle.digest("SHA-256",await file.arrayBuffer()))].map(x=>x.toString(16).padStart(2,"0")).join("")})))}))()',returnByValue:true,awaitPromise:true},childSession);
 assert.equal(selected.exceptionDetails,undefined);assert.deepEqual(selected.result.value,{events:['input','change'],files:[{name:'child.bin',size:data.length,hash:createHash('sha256').update(data).digest('hex')}]});
 const uploadCalls=calls.slice(start).filter(call=>call.method==='DOM.resolveNode'||call.method==='Runtime.releaseObjectGroup'||['function begin','function receive','function commit','function clear'].some(name=>call.params.functionDeclaration?.includes(name)));
 assert.ok(uploadCalls.some(call=>call.params.functionDeclaration?.includes('function commit')));assert.ok(uploadCalls.every(call=>call.target.sessionId===childSession),'Every target/payload/commit/cleanup command must retain the child session');assert.equal(driver.activeUploads.size,0);
});
