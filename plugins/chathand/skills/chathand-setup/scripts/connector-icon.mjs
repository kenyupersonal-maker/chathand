import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Both shipped skill locations use the same public icon. This helper never
// locates a running App, reads its state, or submits a connector form.
export function connectorIcon(moduleURL=import.meta.url){
 const candidates=['../assets/ChatHand-plugin-icon.png','../../../ui/assets/app/ChatHand-plugin-icon.png'];
 for(const relative of candidates){
  const file=fileURLToPath(new URL(relative,moduleURL));
  let info;try{info=fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size<24||info.size>10*1024)throw Error('CONNECTOR_ICON_INVALID');
  const bytes=fs.readFileSync(file);
  if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.readUInt32BE(16)!==256||bytes.readUInt32BE(20)!==256)throw Error('CONNECTOR_ICON_INVALID');
  return {file_name:path.basename(file),path:file,mime_type:'image/png',width:256,height:256,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
 }
 throw Error('CONNECTOR_ICON_MISSING');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(connectorIcon()));}
 catch(e){console.error(JSON.stringify({status:'unavailable',code:/^CONNECTOR_ICON_/.test(e.message)?e.message:'CONNECTOR_ICON_UNAVAILABLE'}));process.exitCode=1;}
}
