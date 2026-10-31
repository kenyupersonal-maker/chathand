import {localText} from '../i18n.mjs';
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import zlib from 'node:zlib';
import {fail} from '../../engine/src/core.mjs';
const bad=()=>fail('INSTALL_EVIDENCE_INVALID',localText('chrome.evidenceInvalid'));
const crcTable=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc(bytes){let n=0xffffffff;for(const byte of bytes)n=crcTable[(n^byte)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
/** Only a small, noninterlaced RGB/RGBA PNG with no text/exif/ICC metadata. */
export function evidencePNG(raw){
 if(typeof raw!=='string'||raw.length>2800000||!raw.length||raw.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(raw))bad();
 const bytes=Buffer.from(raw,'base64');if(bytes.length>2*1024*1024||bytes.toString('base64')!==raw||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))bad();
 let at=8,width,height,channels,end=false,seenIDAT=false;const data=[];
 while(at<bytes.length){if(at+12>bytes.length)bad();const size=bytes.readUInt32BE(at),next=at+12+size;if(next>bytes.length)bad();const type=bytes.toString('ascii',at+4,at+8),chunk=bytes.subarray(at+8,at+8+size);if(bytes.readUInt32BE(next-4)!==crc(bytes.subarray(at+4,next-4)))bad();
  if(at===8&&type!=='IHDR')bad();
  if(type==='IHDR'){if(width||size!==13)bad();width=chunk.readUInt32BE(0);height=chunk.readUInt32BE(4);channels=chunk[9]===2?3:chunk[9]===6?4:0;if(!width||!height||width>1600||height>1200||chunk[8]!==8||!channels||chunk[10]||chunk[11]||chunk[12])bad();}
  else if(type==='IDAT'){seenIDAT=true;data.push(chunk);}
  else if(type==='IEND'){if(size||!seenIDAT||next!==bytes.length)bad();end=true;}
  else if(!['gAMA','cHRM','sRGB','pHYs'].includes(type)||seenIDAT)bad();
  at=next;
 }
 if(!end)bad();let inflated;try{inflated=zlib.inflateSync(Buffer.concat(data),{maxOutputLength:10*1024*1024});}catch{bad();}
 const row=width*channels+1;if(inflated.length!==row*height)bad();for(let y=0;y<height;y++)if(inflated[y*row]>4)bad();
 return bytes;
}
export function archiveInstallEvidence({stateDir,image_base64}){
 const bytes=evidencePNG(image_base64),base=fs.realpathSync(stateDir),folder=path.join(base,'chrome-install-evidence');
 try{fs.mkdirSync(folder,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
 const stat=fs.lstatSync(folder);if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(folder)!==folder)bad();
 const name='chrome-install-'+crypto.randomUUID()+'.png',file=path.join(folder,name);fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600});return {file:path.join('chrome-install-evidence',name),bytes:bytes.length};
}
