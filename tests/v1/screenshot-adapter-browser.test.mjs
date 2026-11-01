import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import http from 'node:http';
import crypto from 'node:crypto';
import {sensitiveRealm,redactionResponseLine} from '../../app/v08/screenshot-redaction-helper.mjs';
import {patchChromeScreenshot,VENDOR_FILES,unpatchedVendorSource,patchedVendorSource} from '../../scripts/patch-chrome-screenshot.mjs';
import {inflateSync} from 'node:zlib';
import {withRedactedScreenshot,rememberSensitiveTarget} from '../../app/v08/screenshot-redaction-helper.mjs';
import {findChrome} from '../support/real-chrome.mjs';
const vendor=process.env.CHATHAND_SCREENSHOT_VENDOR_SOURCE||new URL('../../node_modules/chrome-devtools-mcp',import.meta.url).pathname;
let browser,profile;
test.before(async()=>{
 const {puppeteer}=await import(pathToFileURL(path.join(vendor,'build/src/third_party/index.js')).href);
 profile=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-private-screenshot-'));
 browser=await puppeteer.launch({executablePath:findChrome(),headless:true,pipe:true,userDataDir:profile,defaultViewport:{width:800,height:600,deviceScaleFactor:1},args:['--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--password-store=basic','--use-mock-keychain','--mute-audio','--site-per-process'],handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false});
});
test.after(async()=>{if(browser)await browser.close();if(profile)fs.rmSync(profile,{recursive:true,force:true});});
// Tiny PNG decoder for our own opaque fake fixture; no screenshots are written.
function pixels(bytes){
 const chunks=[];let width,height,type;
 for(let offset=8;offset<bytes.length;){const size=bytes.readUInt32BE(offset),name=bytes.subarray(offset+4,offset+8).toString();const data=bytes.subarray(offset+8,offset+8+size);if(name==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.equal(data[8],8);type=data[9];}if(name==='IDAT')chunks.push(data);offset+=size+12;}
 const channels=type===6?4:3;assert.ok(type===2||type===6);const raw=inflateSync(Buffer.concat(chunks)),stride=width*channels,output=Buffer.alloc(stride*height);
 for(let y=0;y<height;y++){const filter=raw[y*(stride+1)];for(let x=0;x<stride;x++){const v=raw[y*(stride+1)+1+x],a=x>=channels?output[y*stride+x-channels]:0,b=y?output[(y-1)*stride+x]:0,c=y&&x>=channels?output[(y-1)*stride+x-channels]:0;let prediction=0;if(filter===1)prediction=a;else if(filter===2)prediction=b;else if(filter===3)prediction=Math.floor((a+b)/2);else if(filter===4){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);prediction=pa<=pb&&pa<=pc?a:pb<=pc?b:c;}else assert.equal(filter,0);output[y*stride+x]=(v+prediction)&255;}}
 return (x,y)=>[...output.subarray((y*width+x)*channels,(y*width+x)*channels+3)];
}
const fixture=`<style>body{margin:0}input,textarea,[contenteditable],secret-box,plain-box{position:absolute;box-sizing:border-box;width:200px;height:50px;border:0;padding:5px;background:rgb(30,200,90)}#password{left:20px;top:20px}#otp{left:20px;top:100px}#ordinary{left:300px;top:20px}#editor{left:300px;top:100px}#clock{position:absolute;top:300px}</style><input id=password type=password value=FAKE_PASSWORD><input id=otp autocomplete=one-time-code value=FAKE_OTP><input id=ordinary value=VISIBLE_ORDINARY><div id=editor contenteditable>VISIBLE_EDITOR</div><span id=clock>clock</span>`;
async function pageWith(html=fixture){const page=await browser.newPage();await page.setContent(html);return page;}
const capture=page=>()=>page.screenshot({type:'png'}).then(Buffer.from);
const masks=page=>page.evaluate(()=>document.querySelectorAll('[data-chathand-private-mask]').length);
async function cleans(page){assert.equal(await masks(page),0);}
test('ordinary form/editor/clock remain visible; password and OTP regions alone are opaque',async()=>{
 const page=await pageWith();try{
  await page.evaluate(()=>{setInterval(()=>{document.querySelector('#clock').textContent=String(Date.now());const item=document.createElement('span');item.textContent='ordinary chat';document.body.append(item);item.remove();},5);const descriptor=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');Object.defineProperty(HTMLInputElement.prototype,'value',{...descriptor,get(){throw Error('VALUE_READ_FORBIDDEN');}});});
  const result=await withRedactedScreenshot(page,capture(page));const pixel=pixels(result.buffer);
  assert.equal(result.redaction.masked_regions,2);assert.deepEqual(pixel(100,45),[0,0,0]);assert.deepEqual(pixel(100,125),[0,0,0]);assert.deepEqual(pixel(470,45),[30,200,90]);assert.deepEqual(pixel(470,125),[30,200,90]);await cleans(page);
 }finally{await page.close();}
});
test('metadata mark preserves sensitive node identity after password show-as-text toggle',async()=>{
 const page=await pageWith();try{const handle=await page.$('#password');assert.equal(await rememberSensitiveTarget(handle,await handle.backendNodeId()),true);await handle.dispose();await page.$eval('#password',node=>node.type='text');const result=await withRedactedScreenshot(page,capture(page));assert.deepEqual(pixels(result.buffer)(100,45),[0,0,0]);await cleans(page);}finally{await page.close();}
});
test('open shadow and an existing trusted closed-root target are protected locally',async()=>{
 const page=await pageWith(`<style>body{margin:0}secret-box,plain-box{display:block;width:200px;height:60px;background:rgb(30,200,90)}</style><secret-box id=open></secret-box><secret-box id=closed></secret-box><plain-box>ORDINARY_COMPONENT</plain-box><script>for(const [id,mode] of [['open','open'],['closed','closed']]){const root=document.getElementById(id).attachShadow({mode});const input=document.createElement('input');input.type='password';input.value='FAKE_SHADOW';input.style='width:150px;height:40px';root.append(input);if(mode==='closed')globalThis.fixtureClosedTarget=input;}</script>`);
 try{const target=await page.evaluateHandle(()=>globalThis.fixtureClosedTarget);assert.equal(await rememberSensitiveTarget(target,await target.backendNodeId()),true);await target.dispose();const result=await withRedactedScreenshot(page,capture(page));const pixel=pixels(result.buffer);assert.deepEqual(pixel(80,20),[0,0,0]);assert.deepEqual(pixel(80,80),[0,0,0]);assert.deepEqual(pixel(180,150),[30,200,90]);await cleans(page);}finally{await page.close();}
});
test('unknown closed decoration/content preserves ordinary component and declares unsupported coverage; bytes discarded',async()=>{
 const page=await pageWith(`<style>plain-box{display:block;width:200px;height:60px;background:rgb(220,40,40)}</style><plain-box></plain-box><script>const r=document.querySelector('plain-box').attachShadow({mode:'closed'});r.innerHTML='<input type=password value=FAKE_OPAQUE>';</script>`);
 try{const result=await withRedactedScreenshot(page,capture(page));assert.equal(result.redaction.masked_regions,0);assert.ok(result.redaction.redaction_limitations.includes('opaque_shadow_content_not_inspected'));assert.deepEqual(pixels(result.buffer)(190,60),[220,40,40]);await cleans(page);/* Unsupported coverage, not a secret-free image acceptance. */}finally{await page.close();}
});
test('mutation, mask removal/style override and same-URL document replacement discard capture and restore',async()=>{
 for(const action of ['move','remove','style','restore','moveRestore','navigate','new','frame']){
  const page=await pageWith();try{
   await assert.rejects(withRedactedScreenshot(page,async()=>{
    if(action==='move')await page.$eval('#password',node=>node.style.left='40px');
    if(action==='remove')await page.evaluate(()=>document.querySelector('[data-chathand-private-mask]').remove());
    if(action==='style')await page.evaluate(()=>document.querySelector('[data-chathand-private-mask]').style.setProperty('opacity','0','important'));
    if(action==='restore')await page.evaluate(()=>{const mask=document.querySelector('[data-chathand-private-mask]');mask.style.setProperty('opacity','0','important');mask.style.setProperty('opacity','1','important');});
    if(action==='moveRestore')await page.$eval('#password',node=>{node.style.left='40px';node.style.left='20px';});
    if(action==='frame')await page.evaluate(()=>{const frame=document.createElement('iframe');frame.srcdoc='<input type=password value=FAKE_NEW_FRAME>';document.body.append(frame);});
    if(action==='navigate')await page.goto('about:blank');
    if(action==='new')await page.evaluate(()=>{const input=document.createElement('input');input.type='password';document.body.append(input);});
    return capture(page)();
   }),error=>/^CHATHAND_SCREENSHOT_/.test(error.code));await cleans(page);
  }finally{await page.close();}
 }
});
test('success, capture failure, timeout and AbortSignal cleanup use original document promptly',async()=>{
 const page=await pageWith();try{
  await assert.rejects(withRedactedScreenshot(page,async()=>{throw Error('FAKE_SECRET_NOT_IN_ERROR');}),{code:'CHATHAND_SCREENSHOT_CAPTURE_FAILED'});await cleans(page);
  await assert.rejects(withRedactedScreenshot(page,()=>new Promise(()=>{}),{timeoutMs:150}),{code:'CHATHAND_SCREENSHOT_TIMEOUT'});await cleans(page);
  const controller=new AbortController();await assert.rejects(withRedactedScreenshot(page,async()=>{controller.abort();await new Promise(resolve=>setTimeout(resolve,50));return Buffer.from('discard');},{signal:controller.signal}),{code:'CHATHAND_SCREENSHOT_CANCELLED'});await cleans(page);
 }finally{await page.close();}
});
test('same-origin iframe controls are checked without masking the whole frame',async()=>{
 const page=await pageWith(`<style>iframe{position:absolute;border:0;left:20px;top:20px;width:250px;height:160px}</style><iframe srcdoc="<input type=password value=FAKE_FRAME style='width:150px;height:40px'>"></iframe>`);
 try{await page.frames()[1].waitForSelector('input');const result=await withRedactedScreenshot(page,capture(page));assert.ok(result.redaction.masked_regions>=1);await cleans(page);}finally{await page.close();}
});
test('ordinary textarea/select survive and explicit sensitive contenteditable alone is masked',async()=>{
 const page=await pageWith(`<style>textarea,select,[contenteditable]{position:absolute;width:200px;height:60px;background:rgb(30,200,90);border:0;left:20px}textarea{top:20px}select{top:100px}[contenteditable]{top:180px}</style><textarea>VISIBLE_NOTES</textarea><select><option>VISIBLE_OPTION</option></select><div contenteditable aria-label="API key">FAKE_EDITABLE_SECRET</div>`);
 try{const result=await withRedactedScreenshot(page,capture(page));const pixel=pixels(result.buffer);assert.equal(result.redaction.masked_regions,1);assert.deepEqual(pixel(190,60),[30,200,90]);assert.notDeepEqual(pixel(190,130),[0,0,0]);assert.deepEqual(pixel(190,220),[0,0,0]);await cleans(page);}finally{await page.close();}
});
test('cross-origin iframe fallback covers only its rectangle and declares that local limitation',async()=>{
 const child=http.createServer((request,response)=>{response.setHeader('Content-Type','text/html');response.end('<input type=password value=FAKE_CROSS_FRAME>');});
 await new Promise(resolve=>child.listen(0,'127.0.0.1',resolve));
 const server=http.createServer((request,response)=>{response.setHeader('Content-Type','text/html');response.end(`<style>iframe{position:absolute;left:20px;top:20px;width:250px;height:160px;border:0}#ordinary{position:absolute;left:300px;top:20px;width:200px;height:60px;background:rgb(30,200,90)}</style><iframe src="http://127.0.0.1:${child.address().port}/child"></iframe><div id=ordinary>VISIBLE_NEIGHBOR</div>`);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const page=await browser.newPage();
 try{await page.goto(`http://127.0.0.1:${server.address().port}/parent`,{timeout:5000,waitUntil:'domcontentloaded'});const frame=page.frames().find(frame=>frame.parentFrame());await frame.waitForSelector('input',{timeout:3000});const result=await withRedactedScreenshot(page,capture(page));assert.ok(result.redaction.redaction_limitations.includes('cross_origin_frames_masked'));const pixel=pixels(result.buffer);assert.deepEqual(pixel(100,100),[0,0,0]);assert.deepEqual(pixel(480,60),[30,200,90]);await cleans(page);}finally{await page.close();server.closeAllConnections();child.closeAllConnections();await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>child.close(resolve))]);}
});
test('lease expiry clears the old document overlays when the private owner stops renewing (fixture timing only)',async()=>{
 const page=await pageWith();try{const state=await page.mainFrame().isolatedRealm().evaluateHandle(sensitiveRealm,'prepare','lease-fixture',null,{leaseMs:100,fullPage:false});assert.ok(await masks(page)>0);await new Promise(resolve=>setTimeout(resolve,250));await cleans(page);await state.dispose();}finally{await page.close();}
});
let copiedRuntime,patchedScreenshot;
async function vendorHandler(){
 if(patchedScreenshot)return patchedScreenshot;
 copiedRuntime=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-vendor-handler-'));const destination=path.join(copiedRuntime,'node_modules/chrome-devtools-mcp');
 const names=['package.json',...Object.keys(VENDOR_FILES),'build/src/tools/ToolDefinition.js','build/src/tools/categories.js','build/src/third_party/index.js','build/src/third_party/lighthouse-devtools-mcp-bundle.js','build/src/utils/keyboard.js','build/src/utils/logger.js'];
 for(const name of names){
  const target=path.join(destination,name);fs.mkdirSync(path.dirname(target),{recursive:true});
  let bytes=fs.readFileSync(path.join(vendor,name));
  if(VENDOR_FILES[name]&&crypto.createHash('sha256').update(bytes).digest('hex')!==VENDOR_FILES[name]){
   const patched=bytes.toString('utf8'),original=unpatchedVendorSource(name,patched);
   if(crypto.createHash('sha256').update(original).digest('hex')!==VENDOR_FILES[name]||patchedVendorSource(name,original)!==patched)throw Error('FIXTURE_VENDOR_NOT_PINNED');
   bytes=Buffer.from(original);
  }
  fs.writeFileSync(target,bytes);
 }
 patchChromeScreenshot(copiedRuntime);patchedScreenshot=(await import(pathToFileURL(path.join(destination,'build/src/tools/screenshot.js')).href)).screenshot({});return patchedScreenshot;
}
test.after(()=>{if(copiedRuntime)fs.rmSync(copiedRuntime,{recursive:true,force:true});});
function responseFixture(){const lines=[],images=[],files=[];return {lines,images,files,appendResponseLine:line=>lines.push(line),attachImage:image=>images.push(image)};}
test('real patched vendor handler attaches only verified bytes and metadata; failure publishes/saves no image',async()=>{
 const handler=await vendorHandler(),page=await pageWith();
 try{
  const response=responseFixture(),context={saveFile:()=>assert.fail('unexpected file'),saveTemporaryFile:()=>assert.fail('unexpected temp')};
  await handler.handler({params:{format:'png'},page:{pptrPage:page}},response,context);assert.equal(response.images.length,1);assert.deepEqual(pixels(Buffer.from(response.images[0].data,'base64'))(100,45),[0,0,0]);assert.ok(response.lines.some(line=>line.startsWith('CHATHAND_SCREENSHOT_REDACTION ')));await cleans(page);
  const screenshot=page.screenshot.bind(page);page.screenshot=async options=>{await page.$eval('#password',node=>node.style.left='40px');return screenshot(options);};const failed=responseFixture();await assert.rejects(handler.handler({params:{format:'png',filePath:'/must-not-write'},page:{pptrPage:page}},failed,{saveFile:()=>assert.fail('raw file'),saveTemporaryFile:()=>assert.fail('raw temp')}),error=>/^CHATHAND_SCREENSHOT_/.test(error.code));assert.equal(failed.images.length,0);assert.equal(failed.lines.length,0);await cleans(page);
 }finally{await page.close();}
});
test('real vendor >=2MB branch persists only a verified masked PNG in a disposable output folder',async()=>{
 const handler=await vendorHandler(),page=await pageWith(),output=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-safe-image-'));
 try{
  await page.setViewport({width:1400,height:1000,deviceScaleFactor:1});
  await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=1400;canvas.height=1000;canvas.style='position:absolute;inset:0;z-index:-1';const context=canvas.getContext('2d'),image=context.createImageData(1400,1000);let seed=1234567;for(let offset=0;offset<image.data.length;offset+=4){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;image.data[offset]=seed&255;image.data[offset+1]=(seed>>>8)&255;image.data[offset+2]=(seed>>>16)&255;image.data[offset+3]=255;}context.putImageData(image,0,0);document.body.append(canvas);});
  const response=responseFixture();let saved=0;
  await handler.handler({params:{format:'png'},page:{pptrPage:page}},response,{saveTemporaryFile:async bytes=>{assert.ok(bytes.length>=2_000_000);assert.deepEqual(pixels(Buffer.from(bytes))(100,45),[0,0,0]);const filepath=path.join(output,'verified.png');fs.writeFileSync(filepath,bytes);saved++;return {filepath};},saveFile:()=>assert.fail('unexpected explicit file')});
  assert.equal(saved,1);assert.equal(response.images.length,0);assert.deepEqual(fs.readdirSync(output),['verified.png']);await cleans(page);
 }finally{await page.close();fs.rmSync(output,{recursive:true,force:true});}
});
test('real vendor fill hook marks metadata before a reveal-on-input event without storing its fake value',async()=>{
 await vendorHandler();const {fill}=await import(pathToFileURL(path.join(copiedRuntime,'node_modules/chrome-devtools-mcp/build/src/tools/input.js')).href);
 const page=await pageWith(fixture.replace('id=password type=password','id=password type=password oninput="this.type=\'text\'"'));
 try{const response=responseFixture();response.attachWaitForResult=()=>{};
  const fixtureHandle=await page.$('#password'),backendNodeId=await fixtureHandle.backendNodeId();await fixtureHandle.dispose();
  const requestPage={pptrPage:page,getElementByUid:()=>page.$('#password'),getAXNodeByUid:()=>({role:'textbox',children:[],backendNodeId}),waitForEventsAfterAction:async action=>{await action();return {};}};
  await fill.handler({params:{uid:'fake-password',value:'FAKE_FILL_ONLY',includeSnapshot:false},page:requestPage},response,{});
  assert.equal(await page.$eval('#password',node=>node.type),'text');assert.equal(response.lines.some(line=>line.includes('FAKE_FILL_ONLY')),false);
  const result=await withRedactedScreenshot(page,capture(page));assert.deepEqual(pixels(result.buffer)(100,45),[0,0,0]);await cleans(page);
 }finally{await page.close();}
});
test('known sensitive editable overflow geometry is covered without reading text',async()=>{
 const page=await pageWith(`<style>body{margin:0}[contenteditable]{position:absolute;left:20px;top:20px;width:120px;height:20px;background:white;overflow:visible;font:20px monospace;white-space:pre}</style><div contenteditable aria-label="Private key">FAKE_LINE_ONE\nFAKE_LINE_TWO\nFAKE_LINE_THREE</div>`);
 try{const result=await withRedactedScreenshot(page,capture(page));assert.deepEqual(pixels(result.buffer)(30,65),[0,0,0]);await cleans(page);}finally{await page.close();}
});
test('private realm lease still restores masks after its owning CDP session detaches (awake fixture only)',async()=>{
 const page=await pageWith();try{const session=await page.createCDPSession();const {frameTree}=await session.send('Page.getFrameTree');const {executionContextId}=await session.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'chathand-lease-detach-fixture',grantUniveralAccess:false});await session.send('Runtime.evaluate',{contextId:executionContextId,expression:`(${sensitiveRealm.toString()})('prepare','detached-lease',null,{leaseMs:100,fullPage:false})`,returnByValue:false,generatePreview:false});assert.ok(await masks(page)>0);await session.detach();await new Promise(resolve=>setTimeout(resolve,250));await cleans(page);}finally{await page.close();}
});
test('protected animations/full-page offscreen regions are explicit local limitations, ordinary animation/full-page still work',async()=>{
 const page=await pageWith(fixture+`<style>@keyframes pulse{to{opacity:.5}}#clock{animation:pulse 1s infinite}</style>`);
 try{await withRedactedScreenshot(page,capture(page));await cleans(page);await page.$eval('#password',node=>node.style.animation='pulse 1s infinite');await assert.rejects(withRedactedScreenshot(page,capture(page)),{code:'CHATHAND_SCREENSHOT_PROTECTED_ANIMATION'});await cleans(page);await page.setContent(`<style>body{height:1500px}input{position:absolute;top:1200px}</style><input type=password value=FAKE_OFFSCREEN>`);await assert.rejects(withRedactedScreenshot(page,()=>page.screenshot({type:'png',fullPage:true}),{fullPage:true}),{code:'CHATHAND_SCREENSHOT_FULLPAGE_REGION_UNSUPPORTED'});await cleans(page);await page.setContent('<div style="height:1500px;background:green">ORDINARY_LONG_PAGE</div>');const ordinary=await withRedactedScreenshot(page,()=>page.screenshot({type:'png',fullPage:true}),{fullPage:true});assert.ok(ordinary.buffer.length>0);await cleans(page);}finally{await page.close();}
});

test('fixed protection and UID capture never ask CDP to serialize DOM trees or attributes',async()=>{
 const page=await pageWith(fixture+'<iframe srcdoc="<input type=password value=FAKE_FRAME>"></iframe>');
 const handle=await page.$('#password'),backendNodeId=await handle.backendNodeId();
 // Backend ID preparation emulates the vendor's already existing AX metadata;
 // only the protection/capture interval below is audited, without another AX read.
 const forbidden=/^(?:DOM\.(?:describeNode|getDocument|requestChildNodes|requestNode|performSearch|getSearchResults)|DOMSnapshot\.|Runtime\.queryObjects|Accessibility\.)/;
 const calls=[],restores=[];
 const watch=session=>{const send=session.send;session.send=function(method,...args){calls.push(method);assert.equal(forbidden.test(method),false,method);return send.call(this,method,...args);};restores.push(()=>{session.send=send;});return session;};
 for(const session of new Set(page.frames().map(frame=>frame.client)))watch(session);
 const create=page.createCDPSession;page.createCDPSession=async function(...args){return watch(await create.apply(this,args));};
 try{
  assert.equal(await rememberSensitiveTarget(handle,backendNodeId),true);
  await withRedactedScreenshot(page,capture(page));
  const handler=await vendorHandler(),response=responseFixture();
  await handler.handler({params:{format:'png',uid:'fixture-existing-id'},page:{pptrPage:page,getElementByUid:()=>handle.evaluateHandle(node=>node),getAXNodeByUid:()=>({backendNodeId})}},response,{});
  assert.equal(response.images.length,1);assert.ok(calls.includes('DOM.resolveNode'));assert.ok(calls.includes('DOM.getFrameOwner'));await cleans(page);
 }finally{page.createCDPSession=create;for(const restore of restores)restore();await handle.dispose();await page.close();}
});
