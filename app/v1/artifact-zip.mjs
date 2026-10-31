import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {fail} from '../../engine/src/core.mjs';
const table=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export function crc32(buf){let c=0xffffffff;for(const b of buf)c=table[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
export const artifactHash=b=>crypto.createHash('sha256').update(b).digest('hex');
export function safeArtifactPath(raw){
 if(typeof raw!=='string'||!raw||Buffer.byteLength(raw)>2048||/[\\:\u0000-\u001f\u007f]/u.test(raw)||raw.startsWith('/'))fail('ARTIFACT_PATH_INVALID','文件名不能包含路径穿越或系统特殊字符。');
 const p=raw.normalize('NFC'),parts=p.split('/');if(parts.length>32||parts.some(x=>!x||x==='.'||x==='..'||Buffer.byteLength(x)>240||/[ .]$/.test(x)))fail('ARTIFACT_PATH_INVALID','文件名或层级无效。');return p;
}
export function safeArtifactName(raw,fallback='文件'){const value=String(raw||fallback).normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu,'-').replace(/[ .]+$/u,'').trim().slice(0,100)||fallback;return safeArtifactPath(value);}
function zipError(code='ARTIFACT_ZIP_INVALID'){fail(code,'压缩包没有通过完整校验，未提交成果。');}
/** Validate the entire archive before any entry is written. UTF-8 bytes work without a flag. */
export function unpackArtifactZip(buf,{maxBytes=64*1024*1024,maxEntries=500,guard=()=>{}}={}){
 if(!Buffer.isBuffer(buf)||buf.length>50*1024*1024||buf.length<22)zipError();let end=-1;
 for(let n=buf.length-22;n>=Math.max(0,buf.length-65557);n--)if(buf.readUInt32LE(n)===0x06054b50&&n+22+buf.readUInt16LE(n+20)===buf.length){end=n;break;}
 if(end<0)zipError();const count=buf.readUInt16LE(end+10),size=buf.readUInt32LE(end+12),offset=buf.readUInt32LE(end+16);
 if(buf.readUInt16LE(end+4)||buf.readUInt16LE(end+6)||buf.readUInt16LE(end+8)!==count||count===0xffff||count>maxEntries||size===0xffffffff||offset===0xffffffff||offset+size!==end)zipError('ARTIFACT_ZIP_UNSUPPORTED');
 let cursor=offset,total=0;const names=new Map(),records=[],ranges=[];
 for(let i=0;i<count;i++){
  guard();if(cursor+46>end||buf.readUInt32LE(cursor)!==0x02014b50)zipError();const flags=buf.readUInt16LE(cursor+8),method=buf.readUInt16LE(cursor+10),crc=buf.readUInt32LE(cursor+16),packed=buf.readUInt32LE(cursor+20),bytes=buf.readUInt32LE(cursor+24),nl=buf.readUInt16LE(cursor+28),el=buf.readUInt16LE(cursor+30),cl=buf.readUInt16LE(cursor+32),local=buf.readUInt32LE(cursor+42);
  if(flags&~0x080e||flags&1||![0,8].includes(method)||buf.readUInt16LE(cursor+34)||[packed,bytes,local].includes(0xffffffff)||cursor+46+nl+el+cl>end||!nl)zipError('ARTIFACT_ZIP_UNSUPPORTED');
  let name;const raw=buf.subarray(cursor+46,cursor+46+nl);try{name=new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{zipError('ARTIFACT_ZIP_ENCODING');}
  const dir=name.endsWith('/');name=safeArtifactPath(dir?name.slice(0,-1):name);const key=name.toLowerCase();if(names.has(key))zipError('ARTIFACT_ZIP_NAME_CONFLICT');names.set(key,dir);
  const mode=(buf.readUInt32LE(cursor+38)>>>16)&0xf000;if(mode&&mode!==(dir?0x4000:0x8000))zipError('ARTIFACT_ZIP_LINK_BLOCKED');
  let extra=cursor+46+nl,extraEnd=extra+el;while(extra<extraEnd){if(extra+4>extraEnd)zipError();const id=buf.readUInt16LE(extra),len=buf.readUInt16LE(extra+2);if(extra+4+len>extraEnd)zipError();if([1,0x000d,0x756e].includes(id))zipError('ARTIFACT_ZIP_UNSUPPORTED');extra+=4+len;}
  if(total+bytes>maxBytes||bytes>Math.max(1024*1024,packed*1000)||dir&&(bytes||packed))zipError('ARTIFACT_ZIP_BUDGET');total+=bytes;
  if(local+30>offset||buf.readUInt32LE(local)!==0x04034b50||buf.readUInt16LE(local+6)!==flags||buf.readUInt16LE(local+8)!==method)zipError();const lnl=buf.readUInt16LE(local+26),lel=buf.readUInt16LE(local+28),start=local+30+lnl+lel,finish=start+packed;
  if(lnl!==nl||finish>offset||!buf.subarray(local+30,local+30+lnl).equals(raw))zipError();let rangeEnd=finish;
  if(flags&8){let d=finish;if(d+4<=offset&&buf.readUInt32LE(d)===0x08074b50)d+=4;if(d+12>offset||buf.readUInt32LE(d)!==crc||buf.readUInt32LE(d+4)!==packed||buf.readUInt32LE(d+8)!==bytes)zipError();rangeEnd=d+12;}
  else if(buf.readUInt32LE(local+14)!==crc||buf.readUInt32LE(local+18)!==packed||buf.readUInt32LE(local+22)!==bytes)zipError();
  ranges.push([local,rangeEnd]);records.push({path:name,dir,crc,packed,bytes,start,method});cursor+=46+nl+el+cl;
 }
 if(cursor!==end)zipError();ranges.sort((a,b)=>a[0]-b[0]);for(let i=1;i<ranges.length;i++)if(ranges[i][0]<ranges[i-1][1])zipError();
 for(const [name,dir] of names){const parts=name.split('/');for(let i=1;i<parts.length;i++){const parent=parts.slice(0,i).join('/');if(names.has(parent)&&names.get(parent)!==true)zipError('ARTIFACT_ZIP_NAME_CONFLICT');}void dir;}
 return records.filter(x=>!x.dir).map(x=>{guard();let data;try{const packed=buf.subarray(x.start,x.start+x.packed);if(x.method===0)data=Buffer.from(packed);else{const result=zlib.inflateRawSync(packed,{maxOutputLength:Math.min(maxBytes,Math.max(1,x.bytes)),info:true});if(result.engine.bytesWritten!==packed.length)zipError();data=result.buffer;}}catch{zipError();}if(data.length!==x.bytes||crc32(data)!==x.crc)zipError();return {path:x.path,data,bytes:data.length,sha256:artifactHash(data)};});
}
