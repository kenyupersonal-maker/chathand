import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const VENDOR_VERSION='1.9.0';
export const VENDOR_FILES=Object.freeze({
 'build/src/tools/screenshot.js':'dd300be39bbba7bd7fd094c1c3a50aee767ff3f301f2716d66b0fe01b1318065',
 'build/src/tools/input.js':'924710a7a0d4de836ba477bf35e13a37eeee72879b29408fa544c0a8373da0e9',
 'build/src/index.js':'793dd988623744d46395e586500b5405fd17694cc4bef98d6593bee01563374a',
 'build/src/ToolHandler.js':'49dd8d88257394e778573e3449af6e03fdc2fab73cc8370af26205aeecd8ab7d',
});
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
const HELPER_NAME='chathand-screenshot-redaction.mjs';
const marker='chathand-screenshot-adapter.json';
const MODIFICATION_NOTICE='// Modified by ChatHand: screenshot redaction and cancellation adapter. Original copyright and license notices are retained.\n';
function safeBytes(file){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||fs.realpathSync(file)!==file)throw Error('CHROME_SCREENSHOT_UNSAFE_VENDOR_FILE');return fs.readFileSync(file);}
function once(source,before,after){if(source.split(before).length!==2)throw Error('CHROME_SCREENSHOT_PATCH_ANCHOR_MISMATCH');return source.replace(before,after);}
export function patchedVendorSource(name,source){
 if(name==='build/src/tools/screenshot.js'){
  source="import {withRedactedScreenshot,rememberSensitiveTarget,isolatedScreenshotTarget,redactionResponseLine} from './"+HELPER_NAME+"';\n"+source;
  source=once(source,'? await request.page.getElementByUid(request.params.uid)','? await isolatedScreenshotTarget(await request.page.getElementByUid(request.params.uid), request.page.getAXNodeByUid(request.params.uid)?.backendNodeId)');
  source=once(source,'                let screenshot;','                if (element) { await rememberSensitiveTarget(element, request.page.getAXNodeByUid(request.params.uid)?.backendNodeId); await element.scrollIntoView(); }\n                const protectedCapture = await withRedactedScreenshot(page, async () => {\n                let screenshot;');
  source=once(source,'                if (request.params.uid) {','                return screenshot;\n                }, { signal: request.signal, fullPage: fullPage || Boolean(element) });\n                screenshot = protectedCapture.buffer;\n                response.appendResponseLine(redactionResponseLine(protectedCapture.redaction));\n                if (request.params.uid) {');
  // `screenshot` outside the private capture callback remains the vendor's
  // only byte source for filePath, >=2MB temp files and attachImage.
  source=source.replace('                screenshot = protectedCapture.buffer;','                const screenshot = protectedCapture.buffer;');
 }else if(name==='build/src/tools/input.js'){
  source="import {rememberSensitiveTarget} from './"+HELPER_NAME+"';\n"+source;
  source=once(source,'        const handle = __addDisposableResource(env_6, await page.getElementByUid(uid), false);','        const handle = __addDisposableResource(env_6, await page.getElementByUid(uid), false);\n        await rememberSensitiveTarget(handle, page.getAXNodeByUid(uid)?.backendNodeId);');
 }else if(name==='build/src/index.js'){
  source=once(source,'        }, async (params) => {\n            return await toolHandler.handle(params);','        }, async (params, extra) => {\n            return await toolHandler.handle(params, extra);');
 }else if(name==='build/src/ToolHandler.js'){
  source=once(source,'    async handle(params) {','    async handle(params, extra) {');
  source=once(source,'                        params,\n                        page,','                        params,\n                        page,\n                        signal: extra?.signal,');
 }
 return Object.hasOwn(VENDOR_FILES,name)?MODIFICATION_NOTICE+source:source;
}
export function unpatchedVendorSource(name,source){
 if(Object.hasOwn(VENDOR_FILES,name)){
  if(!source.startsWith(MODIFICATION_NOTICE))throw Error('CHROME_SCREENSHOT_PATCH_STAMP_MISMATCH');
  source=source.slice(MODIFICATION_NOTICE.length);
 }
 const imports={
  'build/src/tools/screenshot.js':"import {withRedactedScreenshot,rememberSensitiveTarget,isolatedScreenshotTarget,redactionResponseLine} from './"+HELPER_NAME+"';\n",
  'build/src/tools/input.js':"import {rememberSensitiveTarget} from './"+HELPER_NAME+"';\n",
 };
 if(imports[name]){if(!source.startsWith(imports[name]))throw Error('CHROME_SCREENSHOT_PATCH_STAMP_MISMATCH');source=source.slice(imports[name].length);}
 if(name==='build/src/tools/screenshot.js'){
  source=once(source,'? await isolatedScreenshotTarget(await request.page.getElementByUid(request.params.uid), request.page.getAXNodeByUid(request.params.uid)?.backendNodeId)','? await request.page.getElementByUid(request.params.uid)');
  source=once(source,'                if (element) { await rememberSensitiveTarget(element, request.page.getAXNodeByUid(request.params.uid)?.backendNodeId); await element.scrollIntoView(); }\n                const protectedCapture = await withRedactedScreenshot(page, async () => {\n                let screenshot;','                let screenshot;');
  source=once(source,'                return screenshot;\n                }, { signal: request.signal, fullPage: fullPage || Boolean(element) });\n                const screenshot = protectedCapture.buffer;\n                response.appendResponseLine(redactionResponseLine(protectedCapture.redaction));\n                if (request.params.uid) {','                if (request.params.uid) {');
 }else if(name==='build/src/tools/input.js')source=once(source,'        const handle = __addDisposableResource(env_6, await page.getElementByUid(uid), false);\n        await rememberSensitiveTarget(handle, page.getAXNodeByUid(uid)?.backendNodeId);','        const handle = __addDisposableResource(env_6, await page.getElementByUid(uid), false);');
 else if(name==='build/src/index.js')source=once(source,'        }, async (params, extra) => {\n            return await toolHandler.handle(params, extra);','        }, async (params) => {\n            return await toolHandler.handle(params);');
 else if(name==='build/src/ToolHandler.js'){
  source=once(source,'    async handle(params, extra) {','    async handle(params) {');
  source=once(source,'                        params,\n                        page,\n                        signal: extra?.signal,','                        params,\n                        page,');
 }
 return source;
}
export function verifyChromeScreenshotPatch(runtimeRoot){
 try{return verifyPatch(runtimeRoot);}catch(error){const code=/^CHROME_SCREENSHOT_[A-Z_]+$/.test(error.message)?error.message:'CHROME_SCREENSHOT_PATCH_INVALID';throw Object.assign(new Error(code),{code});}
}
function verifyPatch(runtimeRoot){
 const runtime=fs.realpathSync(path.resolve(runtimeRoot)),vendor=path.join(runtime,'node_modules/chrome-devtools-mcp');
 if(!fs.existsSync(vendor))throw Error('CHROME_SCREENSHOT_ADAPTER_MISSING');
 if(fs.realpathSync(vendor)!==vendor)throw Error('CHROME_SCREENSHOT_UNSAFE_VENDOR_FILE');
 if(JSON.parse(safeBytes(path.join(vendor,'package.json'))).version!==VENDOR_VERSION)throw Error('CHROME_SCREENSHOT_VENDOR_VERSION_MISMATCH');
 let stamp;try{stamp=JSON.parse(safeBytes(path.join(vendor,marker)));}catch{throw Error('CHROME_SCREENSHOT_ADAPTER_MISSING');}
 if(stamp.format!==1||stamp.vendor_version!==VENDOR_VERSION)throw Error('CHROME_SCREENSHOT_PATCH_STAMP_MISMATCH');
 const helper=safeBytes(path.join(vendor,'build/src/tools',HELPER_NAME));
 if(sha(helper)!==stamp.helper_sha256||sha(safeBytes(path.join(runtime,'app/v08/screenshot-redaction-helper.mjs')))!==stamp.helper_sha256)throw Error('CHROME_SCREENSHOT_PATCH_STAMP_MISMATCH');
 for(const name of Object.keys(VENDOR_FILES)){
  const source=safeBytes(path.join(vendor,name)).toString('utf8'),original=unpatchedVendorSource(name,source);
  if(sha(original)!==VENDOR_FILES[name]||patchedVendorSource(name,original)!==source||sha(source)!==stamp.files?.[name]?.patched_sha256||stamp.files?.[name]?.original_sha256!==VENDOR_FILES[name])throw Error('CHROME_SCREENSHOT_PATCH_STAMP_MISMATCH');
 }
 return stamp;
}
// Only an explicit copied runtime is mutable. The caller never patches its
// source node_modules, never downloads a different package and never trusts a
// package's self-declared hash. All originals are checked before any write.
export function patchChromeScreenshot(runtimeRoot,{helperFile=path.join(sourceRoot,'app/v08/screenshot-redaction-helper.mjs')}={}){
 const runtime=fs.realpathSync(path.resolve(runtimeRoot)),vendor=path.join(runtime,'node_modules/chrome-devtools-mcp');
 if(fs.existsSync(path.join(runtime,'.git'))||fs.realpathSync(vendor)!==vendor)throw Error('CHROME_SCREENSHOT_COPIED_RUNTIME_REQUIRED');
 const pkg=JSON.parse(safeBytes(path.join(vendor,'package.json')));
 if(pkg.version!==VENDOR_VERSION)throw Error('CHROME_SCREENSHOT_VENDOR_VERSION_MISMATCH');
 const helper=fs.readFileSync(helperFile),helperSha=sha(helper),expected={};
 for(const name of Object.keys(VENDOR_FILES)){
  const file=path.join(vendor,name),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||fs.realpathSync(file)!==file)throw Error('CHROME_SCREENSHOT_UNSAFE_VENDOR_FILE');
  const original=fs.readFileSync(file);expected[name]={original_sha256:VENDOR_FILES[name],source:original.toString('utf8'),current_sha256:sha(original)};
 }
 const stampPath=path.join(vendor,marker);
 if(fs.existsSync(stampPath)){
  const stamp=JSON.parse(safeBytes(stampPath));
  if(stamp.format!==1||stamp.vendor_version!==VENDOR_VERSION||stamp.helper_sha256!==helperSha||sha(safeBytes(path.join(vendor,'build/src/tools',HELPER_NAME)))!==helperSha)throw Error('CHROME_SCREENSHOT_PATCH_STAMP_MISMATCH');
  for(const [name,entry] of Object.entries(expected)){const original=unpatchedVendorSource(name,entry.source);if(sha(original)!==VENDOR_FILES[name]||patchedVendorSource(name,original)!==entry.source||stamp.files?.[name]?.original_sha256!==VENDOR_FILES[name]||entry.current_sha256!==stamp.files?.[name]?.patched_sha256)throw Error('CHROME_SCREENSHOT_PATCH_STAMP_MISMATCH');}
  return stamp;
 }
 for(const entry of Object.values(expected)){if(entry.current_sha256!==entry.original_sha256)throw Error('CHROME_SCREENSHOT_VENDOR_HASH_MISMATCH');entry.patched=patchedVendorSource(Object.keys(expected).find(key=>expected[key]===entry),entry.source);}
 for(const file of [stampPath,path.join(vendor,'build/src/tools',HELPER_NAME)])if(fs.existsSync(file)){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw Error('CHROME_SCREENSHOT_UNSAFE_VENDOR_FILE');}
 const stamp={format:1,vendor_version:VENDOR_VERSION,redaction_scope:'identified_sensitive_controls',helper_sha256:helperSha,files:{}};
 for(const [name,entry] of Object.entries(expected))stamp.files[name]={original_sha256:entry.original_sha256,patched_sha256:sha(entry.patched)};
 for(const [name,entry] of Object.entries(expected))fs.writeFileSync(path.join(vendor,name),entry.patched);
 fs.writeFileSync(path.join(vendor,'build/src/tools',HELPER_NAME),helper);
 fs.writeFileSync(stampPath,JSON.stringify(stamp,null,2)+'\n');
 return stamp;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const runtime=process.argv[2];if(!runtime||!path.isAbsolute(runtime))throw Error('EXPLICIT_COPIED_RUNTIME_REQUIRED');
 console.log(JSON.stringify(patchChromeScreenshot(runtime)));
}
