import {frameDocumentId, frameSupport, readFrameTree, resolveNodeInFrame} from './frame-tree.js';

export const UPLOAD_CHUNK_BYTES = 256 * 1024;
export const UPLOAD_FILE_BYTES = 64 * 1024 * 1024;
const CODES = new Set(['ACTION_CANCELLED','TASK_REVOKED','RESULT_REVOKED','TASK_EXPIRED','CDP_COMMAND_TIMEOUT','SNAPSHOT_STALE','ELEMENT_CHANGED','ELEMENT_DISABLED','ELEMENT_AMBIGUOUS','FILE_INPUT_REQUIRED','UPLOAD_FILES_INVALID','UPLOAD_CHUNK_INVALID','UPLOAD_MULTIPLE_REQUIRED','UPLOAD_FILE_CHANGED','APP_UPDATE_REQUIRED']);
const fault = code => Object.assign(new Error(code), {code});
export function uploadFiles(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 10) throw fault('UPLOAD_FILES_INVALID');
  let total = 0;
  for (const file of files) {
    if (!file || typeof file.name !== 'string' || !file.name || file.name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(file.name) || typeof file.mimeType !== 'string' || file.mimeType.length > 255 || /[\x00-\x1f\x7f]/.test(file.mimeType) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > UPLOAD_FILE_BYTES) throw fault('UPLOAD_FILES_INVALID');
    total += file.size;
  }
  if (total > 10 * UPLOAD_FILE_BYTES) throw fault('UPLOAD_FILES_INVALID');
  return files.map(({name,mimeType,size}) => ({name,mimeType,size}));
}
export function uploadChunk(chunk, index, offset, size) {
  const length = Math.min(UPLOAD_CHUNK_BYTES, size - offset);
  if (!chunk || chunk.index !== index || chunk.offset !== offset || chunk.byteLength !== length || chunk.eof !== (offset + length === size) || typeof chunk.base64 !== 'string' || chunk.base64.length !== 4 * Math.ceil(length / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.base64)) throw fault('UPLOAD_CHUNK_INVALID');
  const raw = atob(chunk.base64);
  if (raw.length !== length || btoa(raw) !== chunk.base64) throw fault('UPLOAD_CHUNK_INVALID');
  return chunk;
}
export function cancelUploads(driver, id) {
  for (const session of driver.activeUploads || []) if (id === undefined || session.id === id) {session.cancelled = true;void session.cleanup();}
}
// These functions execute only in a CDP isolated world; no buffers are exposed on window.
function begin(files) {
  if (!(this instanceof HTMLInputElement) || this.type !== 'file') return {error:'FILE_INPUT_REQUIRED'};
  if (!this.isConnected || this.ownerDocument !== document) return {error:'ELEMENT_CHANGED'};
  if (this.disabled || this.matches(':disabled')) return {error:'ELEMENT_DISABLED'};
  if (files.length > 1 && !this.multiple) return {error:'UPLOAD_MULTIPLE_REQUIRED'};
  return {node:this, files:files.map(file=>({...file, bytes:new Uint8Array(file.size), offset:0})), cancelled:false};
}
function receive(index, offset, base64) {
  if (this.cancelled || !this.node?.isConnected || this.node.ownerDocument !== document || this.node.type !== 'file') return 'ELEMENT_CHANGED';
  if (this.node.disabled || this.node.matches(':disabled')) return 'ELEMENT_DISABLED';
  const file=this.files[index];if (!file || file.offset!==offset) return 'UPLOAD_CHUNK_INVALID';
  const raw=atob(base64);if(raw.length>262144 || offset+raw.length>file.size) return 'UPLOAD_CHUNK_INVALID';
  for(let i=0;i<raw.length;i++)file.bytes[offset+i]=raw.charCodeAt(i);
  file.offset+=raw.length;return true;
}
function commit() {
  if(this.cancelled || !this.node?.isConnected || this.node.ownerDocument!==document || !(this.node instanceof HTMLInputElement) || this.node.type!=='file')return 'ELEMENT_CHANGED';
  if(this.node.disabled || this.node.matches(':disabled'))return 'ELEMENT_DISABLED';
  if(this.files.length>1 && !this.node.multiple)return 'UPLOAD_MULTIPLE_REQUIRED';
  if(this.files.some(file=>file.offset!==file.size))return 'UPLOAD_CHUNK_INVALID';
  const transfer=new DataTransfer();for(const file of this.files)transfer.items.add(new File([file.bytes],file.name,{type:file.mimeType}));
  // One assignment, followed by the same events as the vendored Playwright implementation.
  this.node.files=transfer.files;
  this.files=[];
  this.node.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
  this.node.dispatchEvent(new Event('change',{bubbles:true}));
  return true;
}
function clear() {this.cancelled=true;this.files=[];this.node=null;return true;}

async function target(driver,id,args,generation) {
  const known=driver.locators.get(id+':'+args.ref),tab=await driver.page(id,generation);
  if(!known || known.url!==tab.url)throw fault('SNAPSHOT_STALE');
  const info=await readFrameTree(driver,id,generation,tab.url),frame=info.frames.find(item=>item.id===known.frameId);
  if(!frame || known.documentId!==frameDocumentId(frame))throw fault('SNAPSHOT_STALE');
  const support=frameSupport(info,frame);if(!support.supported)throw fault('ELEMENT_CHANGED');
  const tree=await driver.sendFrame(id,frame.id,'Accessibility.getFullAXTree',{frameId:frame.id},generation);
  const matches=(tree.nodes||[]).filter(node=>!node.ignored && String(node.role?.value||'')===known.role && String(node.name?.value||'').slice(0,400)===known.name && node.backendDOMNodeId);
  if(matches.length>1)throw fault('ELEMENT_AMBIGUOUS');
  if(matches.length===1&&matches[0].backendDOMNodeId!==known.backend)throw fault('ELEMENT_CHANGED');
  // Hidden file inputs disappear from AX. Only retain their original backend node.
  const backend=known.backend;
  const resolved=await resolveNodeInFrame(driver,id,frame.id,backend,generation,'ChatHand.Upload');
  const sessionId=driver.frameSession(id,frame.id);
  try {
    const checked=await driver.sendFrame(id,frame.id,'Runtime.callFunctionOn',{objectId:resolved.objectId,functionDeclaration:'function(){return {valid:this instanceof HTMLInputElement&&this.type==="file"&&this.isConnected&&this.ownerDocument===document,hidden:!this.getClientRects().length||getComputedStyle(this).visibility==="hidden",disabled:this.disabled||this.matches(":disabled")};}',returnByValue:true},generation);
    const state=checked.result?.value;
    if(checked.exceptionDetails || !state?.valid || (!matches.length&&!state.hidden))throw fault('ELEMENT_CHANGED');
    if(state.disabled)throw fault('ELEMENT_DISABLED');
    return {known,frame,objectId:resolved.objectId,backend,sessionId};
  } catch(error) {
    // Cleanup bypasses generation guards, so cancellation also releases the handle.
    let timer;try {await Promise.race([Promise.resolve().then(()=>driver.api.debugger.sendCommand({tabId:id,...(sessionId?{sessionId}:{})},'Runtime.releaseObject',{objectId:resolved.objectId})).catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,500);})]);}finally{clearTimeout(timer);}
    throw error;
  }
}

export async function performUpload(driver,id,args,generation,authorize,options={}) {
  let stage='validate',session,node,bufferId,committing=false;
  try {
    if(Array.isArray(args.paths)&&args.files===undefined)throw fault('APP_UPDATE_REQUIRED');
    const files=uploadFiles(args.files);if(typeof options.readUploadChunk!=='function')throw fault('UPLOAD_CHUNK_INVALID');
    if(authorize)await authorize();driver.assertCurrent(generation);
    stage='target';node=await target(driver,id,args,generation);
    const raw=(method,params)=>Promise.resolve().then(()=>driver.api.debugger.sendCommand({tabId:id,...(node.sessionId?{sessionId:node.sessionId}:{})},method,params));
    const group='ChatHand.Upload.'+crypto.randomUUID();
    session={id,cancelled:false,cleanup:async()=>{let timer;try{await Promise.race([(async()=>{if(bufferId)await raw('Runtime.callFunctionOn',{objectId:bufferId,functionDeclaration:clear.toString(),returnByValue:true}).catch(()=>{});await raw('Runtime.releaseObjectGroup',{objectGroup:group}).catch(()=>{});await raw('Runtime.releaseObject',{objectId:node.objectId}).catch(()=>{});})(),new Promise(resolve=>{timer=setTimeout(resolve,500);})]);}finally{clearTimeout(timer);}}};
    driver.activeUploads ||= new Set();driver.activeUploads.add(session);
    const current=()=>{driver.assertCurrent(generation);if(session.cancelled||!driver.attached.has(id)||driver.frameSession(id,node.frame.id)!==node.sessionId)throw fault('ACTION_CANCELLED');};
    const call=async(objectId,fn,values=[],byValue=true)=>{current();const result=await driver.sendFrame(id,node.frame.id,'Runtime.callFunctionOn',{objectId,functionDeclaration:fn.toString(),arguments:values.map(value=>({value})),returnByValue:byValue},generation);current();if(result.exceptionDetails)throw fault('UPLOAD_EXECUTION_FAILED');return byValue?result.result?.value:result.result;};
    const sameDocument=async()=>{current();const tab=await driver.page(id,generation),info=await readFrameTree(driver,id,generation,tab.url),frame=info.frames.find(frame=>frame.id===node.frame.id);if(tab.url!==node.known.url || !frame || frameDocumentId(frame)!==node.known.documentId)throw fault('SNAPSHOT_STALE');current();};
    stage='prepare';current();const prepared=await driver.sendFrame(id,node.frame.id,'Runtime.callFunctionOn',{objectId:node.objectId,functionDeclaration:begin.toString(),arguments:[{value:files}],objectGroup:group,returnByValue:false},generation);bufferId=prepared.result?.objectId;current();if(prepared.exceptionDetails)throw fault('UPLOAD_EXECUTION_FAILED');
    if(!bufferId)throw fault('UPLOAD_EXECUTION_FAILED');
    const initial=await call(bufferId,function(){return this.error||true;});if(initial!==true)throw fault(CODES.has(initial)?initial:'UPLOAD_EXECUTION_FAILED');
    stage='transfer';
    for(let index=0;index<files.length;index++)for(let offset=0;offset<files[index].size || offset===0;offset+=UPLOAD_CHUNK_BYTES){
      current();if(authorize)await authorize();current();await sameDocument();
      const chunk=uploadChunk(await options.readUploadChunk(index,offset),index,offset,files[index].size);current();
      const result=await call(bufferId,receive,[index,offset,chunk.base64]);if(result!==true)throw fault(CODES.has(result)?result:'UPLOAD_EXECUTION_FAILED');
    }
    stage='commit';await sameDocument();if(authorize)await authorize();current();
    // Revalidate after authorization as it can yield to navigation or DOM replacement.
    await sameDocument();current();committing=true;
    const result=await call(bufferId,commit);if(result!==true){committing=false;throw fault(CODES.has(result)?result:'UPLOAD_EXECUTION_FAILED');}
    return {performed:'upload',files:files.length};
  } catch(error) {
    const code=CODES.has(error?.code)?error.code:'BROWSER_ACTION_FAILED';
    throw Object.assign(fault(code),{details:{stage,method:'isolated_file_payload',category:CODES.has(error?.code)?'guard':'execution',...(code==='APP_UPDATE_REQUIRED'?{recovery:'update_chathand'}:{}),delivery_unconfirmed:committing,do_not_replay:true,replay_safe:false}});
  } finally {if(session){session.cancelled=true;await session.cleanup();driver.activeUploads.delete(session);}}
}
