import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {withRedactedScreenshot,REDACTION_SCOPE,readRedactionMetadata} from '../app/v08/screenshot-redaction-helper.mjs';
import {patchChromeScreenshot,VENDOR_FILES} from '../scripts/patch-chrome-screenshot.mjs';
test('redaction result declares the limited identified-control contract',()=>{
 assert.equal(REDACTION_SCOPE,'identified_sensitive_controls');
 assert.deepEqual(readRedactionMetadata({content:[{type:'text',text:'CHATHAND_SCREENSHOT_REDACTION '+JSON.stringify({redaction_scope:REDACTION_SCOPE,redaction_limitations:['opaque_shadow_content_not_inspected']})}]}).redaction_limitations,['opaque_shadow_content_not_inspected']);
 assert.throws(()=>readRedactionMetadata({content:[]}),/METADATA_MISSING/);
});
test('patch rejects wrong vendor version/hash before changing package files',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-patch-'));
 try{const folder=path.join(root,'node_modules/chrome-devtools-mcp');fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'package.json'),JSON.stringify({version:'wrong'}));assert.throws(()=>patchChromeScreenshot(root),/VERSION_MISMATCH/);assert.deepEqual(fs.readdirSync(folder),['package.json']);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
const sourceVendor=process.env.CHATHAND_SCREENSHOT_VENDOR_SOURCE||new URL('../node_modules/chrome-devtools-mcp',import.meta.url).pathname;
test('copied vendor receives reproducible checksummed handler and rejects drift/tampered stamps',async()=>{
 const {verifyChromeScreenshotPatch}=await import('../scripts/patch-chrome-screenshot.mjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-vendor-'));
 try{
  const vendor=path.join(root,'node_modules/chrome-devtools-mcp');fs.mkdirSync(vendor,{recursive:true});fs.copyFileSync(path.join(sourceVendor,'package.json'),path.join(vendor,'package.json'));
  for(const name of Object.keys(VENDOR_FILES)){const destination=path.join(vendor,name);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(path.join(sourceVendor,name),destination);}
  fs.mkdirSync(path.join(root,'app/v08'),{recursive:true});fs.copyFileSync(new URL('../app/v08/screenshot-redaction-helper.mjs',import.meta.url),path.join(root,'app/v08/screenshot-redaction-helper.mjs'));
  const original=fs.readFileSync(path.join(vendor,'build/src/tools/screenshot.js'),'utf8');
  fs.appendFileSync(path.join(vendor,'build/src/tools/input.js'),'\n');assert.throws(()=>patchChromeScreenshot(root),/HASH_MISMATCH/);assert.equal(fs.readFileSync(path.join(vendor,'build/src/tools/screenshot.js'),'utf8'),original);
  fs.copyFileSync(path.join(sourceVendor,'build/src/tools/input.js'),path.join(vendor,'build/src/tools/input.js'));
  const stamp=patchChromeScreenshot(root);assert.deepEqual(patchChromeScreenshot(root),stamp);assert.deepEqual(verifyChromeScreenshotPatch(root),stamp);
  const second=path.join(root,'second-copy'),secondVendor=path.join(second,'node_modules/chrome-devtools-mcp');
  fs.mkdirSync(secondVendor,{recursive:true});fs.copyFileSync(path.join(sourceVendor,'package.json'),path.join(secondVendor,'package.json'));
  for(const name of Object.keys(VENDOR_FILES)){const destination=path.join(secondVendor,name);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(path.join(sourceVendor,name),destination);}
  assert.deepEqual(patchChromeScreenshot(second),stamp);
  for(const name of [...Object.keys(VENDOR_FILES),'build/src/tools/chathand-screenshot-redaction.mjs','chathand-screenshot-adapter.json'])assert.deepEqual(fs.readFileSync(path.join(secondVendor,name)),fs.readFileSync(path.join(vendor,name)));
  const patched=fs.readFileSync(path.join(vendor,'build/src/tools/screenshot.js'),'utf8');assert.ok(patched.indexOf('withRedactedScreenshot(page')<patched.indexOf('context.saveTemporaryFile'));assert.ok(patched.indexOf('protectedCapture.buffer')<patched.indexOf('response.attachImage'));
  assert.deepEqual(patched.slice(patched.indexOf('        schema:'),patched.indexOf('        blockedByDialog:')),original.slice(original.indexOf('        schema:'),original.indexOf('        blockedByDialog:')));
  fs.appendFileSync(path.join(vendor,'build/src/tools/screenshot.js'),'\n//drift');const fakeStamp=JSON.parse(fs.readFileSync(path.join(vendor,'chathand-screenshot-adapter.json'),'utf8'));fakeStamp.files['build/src/tools/screenshot.js'].patched_sha256='fake';fs.writeFileSync(path.join(vendor,'chathand-screenshot-adapter.json'),JSON.stringify(fakeStamp));assert.throws(()=>verifyChromeScreenshotPatch(root),/MISMATCH/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('source checkout and linked vendor cannot be patched in place',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-no-source-patch-'));
 try{fs.mkdirSync(path.join(root,'node_modules'));fs.symlinkSync(sourceVendor,path.join(root,'node_modules/chrome-devtools-mcp'));assert.throws(()=>patchChromeScreenshot(root),/COPIED_RUNTIME_REQUIRED/);fs.writeFileSync(path.join(root,'.git'),'fixture');assert.throws(()=>patchChromeScreenshot(root),/COPIED_RUNTIME_REQUIRED/);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('transport retains the no-evaluation switch and refuses only unpatched external screenshot calls',async()=>{
 const {ChromeTransport,backendArguments}=await import('../app/v08/chrome-transport.mjs');
 const args=backendArguments({workspace:'/tmp/private-fixture'});assert.ok(args.includes('--no-javascript-evaluation'));assert.equal(args.some(arg=>arg==='--javascript-evaluation'),false);
 const transport=new ChromeTransport({workspace:'/tmp/private-fixture'});let started=0;transport.start=async()=>{started++;};transport.tools=[{name:'list_pages'},{name:'take_screenshot'}];transport.rpc=async()=>({content:[]});
 await transport.call('list_pages');assert.equal(started,1);
 await assert.rejects(transport.call('take_screenshot'),error=>/^CHROME_SCREENSHOT_/.test(error.code));assert.equal(started,1);
});
test('structured-content-only redaction receipt is recognized without page text inspection',()=>{
 assert.equal(readRedactionMetadata({structuredContent:{message:'CHATHAND_SCREENSHOT_REDACTION '+JSON.stringify({redaction_scope:REDACTION_SCOPE,redaction_limitations:['opaque_shadow_content_not_inspected'],masked_regions:2})}}).masked_regions,2);
});
