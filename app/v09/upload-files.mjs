import fs from 'node:fs';
import path from 'node:path';

export const UPLOAD_CHUNK_BYTES = 256 * 1024;
export const UPLOAD_FILE_BYTES = 64 * 1024 * 1024;
const fault = code => Object.assign(new Error(code), {code, details: {stage:'file_read', replay_safe:false}});
const mimeTypes = {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.svg':'image/svg+xml','.heic':'image/heic','.bmp':'image/bmp','.tif':'image/tiff','.tiff':'image/tiff','.pdf':'application/pdf','.txt':'text/plain','.csv':'text/csv','.json':'application/json','.html':'text/html','.zip':'application/zip','.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav'};
const unchanged = (a,b) => ['dev','ino','size','mtimeNs','ctimeNs','nlink'].every(key=>a[key]===b[key]);

// Hold only the exact, scope-checked files for one pending browser operation.
// Paths and descriptors never enter the native-messaging payload.
export class UploadFiles {
 constructor(store, paths) {
  this.store=store;this.files=[];this.index=0;this.closed=false;
  if(!Array.isArray(paths)||paths.length<1||paths.length>10)throw fault('ARG_INVALID');
  try {
   for(const requested of paths){
    const resolved=store.resolve(requested),name=path.basename(resolved);
    if(!name||name.length>255||/[\\/\x00-\x1f\x7f]/.test(name))throw fault('UPLOAD_FILES_INVALID');
    const fd=fs.openSync(resolved,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    const file={requested,resolved,fd,offset:0};this.files.push(file);
    const stat=fs.fstatSync(fd,{bigint:true});
    if(!stat.isFile()||stat.nlink!==1n)throw fault('TYPE_BLOCKED');
    if(stat.size>BigInt(UPLOAD_FILE_BYTES))throw fault('FILE_TOO_LARGE');
    Object.assign(file,{stat,name,mimeType:mimeTypes[path.extname(name).toLowerCase()]||'application/octet-stream',size:Number(stat.size)});
   }
  } catch(error) {this.close();throw error;}
 }
 metadata(){return this.files.map(({name,mimeType,size})=>({name,mimeType,size}));}
 read(index,offset){
  if(this.closed)throw fault('BROWSER_REQUEST_EXPIRED');
  if(!Number.isSafeInteger(index)||index!==this.index||!Number.isSafeInteger(offset)||offset<0)throw fault('UPLOAD_CHUNK_INVALID');
  const file=this.files[index];if(!file||offset!==file.offset)throw fault('UPLOAD_CHUNK_INVALID');
  // Re-resolve through the current file policy on every read; never follow a new path.
  if(this.store.resolve(file.requested)!==file.resolved||!unchanged(file.stat,fs.lstatSync(file.resolved,{bigint:true}))||!unchanged(file.stat,fs.fstatSync(file.fd,{bigint:true})))throw fault('UPLOAD_FILE_CHANGED');
  const byteLength=Math.min(UPLOAD_CHUNK_BYTES,file.size-offset),buffer=Buffer.alloc(byteLength);
  let read=0;while(read<byteLength){const count=fs.readSync(file.fd,buffer,read,byteLength-read,offset+read);if(!count)throw fault('UPLOAD_FILE_CHANGED');read+=count;}
  if(!unchanged(file.stat,fs.fstatSync(file.fd,{bigint:true})))throw fault('UPLOAD_FILE_CHANGED');
  file.offset+=byteLength;const eof=file.offset===file.size;if(eof)this.index++;
  return {index,offset,byteLength,base64:buffer.toString('base64'),eof};
 }
 get complete(){return this.index===this.files.length;}
 close(){if(this.closed)return;this.closed=true;for(const file of this.files)try{fs.closeSync(file.fd);}catch{}}
}
