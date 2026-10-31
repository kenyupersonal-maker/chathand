/** Private command output journal. App must authorize before each call.
 * Full text preserves the existing known-secret/ANSI redactor; no raw disk file.
 * Text records order completed redacted lines/EOF emissions across callbacks.
 * No restart/recovery API: current command-queue lifecycle only.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';

const HEADER=8,STREAMS=['stdout','stderr'];
const safeError=code=>Object.assign(new Error(code==='OUTPUT_SPOOL_CURSOR_EXPIRED'?'分页游标已过期；可重新从全文首段读取并核对位置，不要重跑命令。':code),{code});
const canonical=x=>JSON.stringify(Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])));
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
function writeAll(fd,buffer){let p=0;while(p<buffer.length){const n=fs.writeSync(fd,buffer,p,buffer.length-p);if(n<=0)throw safeError('OUTPUT_SPOOL_WRITE_FAILED');p+=n;}}
function readAll(fd,buffer,position){let p=0;while(p<buffer.length){const n=fs.readSync(fd,buffer,p,buffer.length-p,position+p);if(!n)throw safeError('OUTPUT_SPOOL_INTEGRITY');p+=n;}}
function escapedUnits(cp){const n=cp.charCodeAt(0);return cp==='\"'||cp==='\\'?6:n<32?([8,9,10,12,13].includes(n)?5:13):cp.length*2;}
const wireUnits=x=>{const a=JSON.stringify(x);return a.length+JSON.stringify(a).length-2;};

export class FullOutputSpool {
 constructor({parent,jobId,scope,maxEnvelopeChars=12000,envelopeReserve=2200,archiveLimitBytes=16*1024*1024}){
  if(!Number.isSafeInteger(archiveLimitBytes)||archiveLimitBytes<1||!path.isAbsolute(parent)||typeof jobId!=='string'||!jobId||!scope||Object.values(scope).some(v=>typeof v!=='string')||!Number.isSafeInteger(maxEnvelopeChars)||!Number.isSafeInteger(envelopeReserve)||envelopeReserve<1200||maxEnvelopeChars-envelopeReserve<128)throw safeError('OUTPUT_SPOOL_CONFIG');
  const st=fs.lstatSync(parent);if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0)throw safeError('OUTPUT_SPOOL_UNSAFE');
  this.directory=fs.mkdtempSync(path.join(parent,'job-output-'));fs.chmodSync(this.directory,0o700);this.directoryIdentity=fs.lstatSync(this.directory);
  try{
   this.fdText=fs.openSync(path.join(this.directory,'text.frames'),fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
   this.fdIndex=fs.openSync(path.join(this.directory,'index.frames'),fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  }catch{for(const fd of [this.fdText,this.fdIndex])if(fd!==undefined)try{fs.closeSync(fd);}catch{}throw safeError('OUTPUT_SPOOL_CREATE_FAILED');}
  this.textIdentity=fs.fstatSync(this.fdText);this.indexIdentity=fs.fstatSync(this.fdIndex);this.indexCount=0;
  this.jobId=jobId;this.scopeHash=digest(canonical(scope));this.key=crypto.randomBytes(32);this.tokens=new Map();this.plans=new Map();this.snapshotCache=new Map();this.tokenLimit=16384;this.tokenTtlMs=2*60*60*1000;
  this.archiveLimitBytes=archiveLimitBytes;this.archiveBytes=0;this.lastBatchBytes=0;this.batchCount=0;this.archiveFull=false;this.sealed=false;this.outputLimited=false;this.rawBytes=0;this.textBytes=0;this.textChars=0;this.committedFileBytes=0;this.failure=null;this.disposed=false;
  this.maxEnvelopeChars=maxEnvelopeChars;this.fragmentBudget=maxEnvelopeChars-envelopeReserve;
 }
 check(scope){if(this.disposed)throw safeError('OUTPUT_SPOOL_CLOSED');if(digest(canonical(scope))!==this.scopeHash)throw safeError('OUTPUT_SPOOL_SCOPE');}
 checkFile(fd,identity){const st=fs.fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.dev!==identity.dev||st.ino!==identity.ino)throw safeError('OUTPUT_SPOOL_INTEGRITY');}
 appendSanitized(stream,text){
  if(this.failure)throw safeError(this.failure);
  const index=STREAMS.indexOf(stream);if(this.disposed||this.sealed||index<0||typeof text!=='string')throw safeError('OUTPUT_SPOOL_STATE');
  try{this.checkFile(this.fdText,this.textIdentity);this.checkFile(this.fdIndex,this.indexIdentity);this.appendText(index,text);return this.archiveFull;}
  catch{this.failure='OUTPUT_SPOOL_WRITE_FAILED';throw safeError(this.failure);}
 }
 appendText(index,text){
  const frames=[],indices=[];let physical=0,logical=0,chars=0;
  for(let p=0;p<text.length;){let e=Math.min(text.length,p+32768);if(e<text.length&&text.charCodeAt(e-1)>=0xd800&&text.charCodeAt(e-1)<=0xdbff)e--;
   const part=text.slice(p,e),bytes=Buffer.from(part,'utf8'),h=Buffer.alloc(HEADER);h.writeUInt32LE(bytes.length,0);h.writeUInt32LE(index,4);frames.push(h,bytes);
   const entry=Buffer.alloc(24);entry.writeBigUInt64LE(BigInt(this.textBytes+logical),0);entry.writeBigUInt64LE(BigInt(this.committedFileBytes+physical),8);entry.writeUInt32LE(bytes.length,16);entry.writeUInt32LE(index,20);indices.push(entry);
   physical+=HEADER+bytes.length;logical+=bytes.length;chars+=part.length;p=e;
  }
  if(!indices.length)return;
  // Publish offsets only after both complete writes. A partial failure disables
  // this archive; a reader can never observe a half-committed batch.
  writeAll(this.fdText,Buffer.concat(frames));writeAll(this.fdIndex,Buffer.concat(indices));
  this.indexCount+=indices.length;this.committedFileBytes+=physical;this.textBytes+=logical;this.textChars+=chars;
  this.lastBatchBytes=physical+indices.length*24;this.archiveBytes+=this.lastBatchBytes;this.batchCount++;
  this.archiveFull=this.archiveBytes>=this.archiveLimitBytes;
 }
 seal(){if(this.sealed)return;if(this.failure)throw safeError(this.failure);try{fs.fsyncSync(this.fdText);fs.fsyncSync(this.fdIndex);this.sealed=true;}catch{this.failure='OUTPUT_SPOOL_WRITE_FAILED';throw safeError(this.failure);}}
 markOutputLimited(){this.outputLimited=true;}
 *segments(start,end,fileEnd){
  this.checkFile(this.fdText,this.textIdentity);this.checkFile(this.fdIndex,this.indexIdentity);let physical=0,logical=0;
  if(this.indexCount&&start){let lo=0,hi=this.indexCount-1;while(lo<hi){const mid=Math.ceil((lo+hi)/2),entry=Buffer.alloc(24);readAll(this.fdIndex,entry,mid*24);if(Number(entry.readBigUInt64LE(0))<=start)lo=mid;else hi=mid-1;}const entry=Buffer.alloc(24);readAll(this.fdIndex,entry,lo*24);logical=Number(entry.readBigUInt64LE(0));physical=Number(entry.readBigUInt64LE(8));}
  while(physical<fileEnd&&logical<end){const h=Buffer.alloc(HEADER);readAll(this.fdText,h,physical);const size=h.readUInt32LE(0),index=h.readUInt32LE(4);
   if(index>1||size>131072||physical+HEADER+size>fileEnd)throw safeError('OUTPUT_SPOOL_INTEGRITY');
   const bytes=Buffer.alloc(size);readAll(this.fdText,bytes,physical+HEADER);const a=Math.max(0,start-logical),b=Math.min(size,end-logical);
   if(a<b){const sub=bytes.subarray(a,b);let text;try{text=new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(sub);}catch{throw safeError('OUTPUT_SPOOL_CURSOR_BOUNDARY');}yield {stream:STREAMS[index],text};}
   logical+=size;physical+=HEADER+size;
  }
  if(logical<end)throw safeError('OUTPUT_SPOOL_INTEGRITY');
 }
 plan(start,end,fileEnd,budget=this.fragmentBudget){
  // Each budget profile scans only bytes appended since its previous snapshot.
  // Old snapshots copy positions, never mutable text or live page boundaries.
  let c=this.plans.get(budget);
  if(!c){c={pages:[],start:0,end:0,size:0,last:null,fileEnd:0};this.plans.set(budget,c);if(this.plans.size>8)this.plans.delete(this.plans.keys().next().value);}
  if(c.end<end)for(const segment of this.segments(c.end,end,fileEnd))for(const cp of segment.text){
   let overhead=c.last===segment.stream?0:wireUnits({stream:segment.stream,text:''})+(c.last===null?0:2),cost=overhead+escapedUnits(cp);
   if(c.size+cost>budget&&c.end>c.start){c.pages.push({start:c.start,end:c.end});c.start=c.end;c.size=0;c.last=null;overhead=wireUnits({stream:segment.stream,text:''});}
   if(c.last!==segment.stream){c.size+=overhead;c.last=segment.stream;}
   c.size+=escapedUnits(cp);c.end+=Buffer.byteLength(cp,'utf8');
  }
  c.fileEnd=fileEnd;
  const all=[...c.pages,{start:c.start,end:c.end}];
  const pages=all.filter(p=>p.end>start||p.start===end).map(p=>({start:Math.max(start,p.start),end:p.end}));return {all,pages:pages.length?pages:[{start,end:start}]};
 }
 token(descriptor){
  const now=Date.now();for(const [id,d] of this.tokens){if(now-d.issued<this.tokenTtlMs&&this.tokens.size<this.tokenLimit)break;this.tokens.delete(id);}
  const id=crypto.randomBytes(16).toString('base64url'),mac=crypto.createHmac('sha256',this.key).update(id).digest('base64url');descriptor.issued=now;descriptor.cursor=id+'.'+mac;this.tokens.set(id,descriptor);return descriptor.cursor;
 }
 descriptor(cursor){
  if(typeof cursor!=='string'||!/^[-A-Za-z0-9_]{22}\.[-A-Za-z0-9_]{43}$/.test(cursor))throw safeError('OUTPUT_SPOOL_CURSOR');const [id,mac]=cursor.split('.');
  const expected=crypto.createHmac('sha256',this.key).update(id).digest('base64url'),a=Buffer.from(mac,'ascii'),b=Buffer.from(expected,'ascii');
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b))throw safeError('OUTPUT_SPOOL_CURSOR');
  const d=this.tokens.get(id);if(!d||Date.now()-d.issued>this.tokenTtlMs)throw safeError('OUTPUT_SPOOL_CURSOR_EXPIRED');return d;
 }
 hasNew(cursor,scope){this.check(scope);const d=this.descriptor(cursor);return Boolean(d.snapshot)||this.textBytes>d.start||this.sealed||Boolean(this.failure);}
 read({scope,full_cursor=null,envelopeSize,extra={}}){
  this.check(scope);if(this.failure)throw safeError(this.failure);
  const size=typeof envelopeSize==='function'?envelopeSize:p=>JSON.stringify(p).length;
  const d=full_cursor===null?{start:0}:this.descriptor(full_cursor);
  // Reserve the actual two-copy RPC wrapper with worst numeric widths and two
  // fixed-width tokens. Notes are deferred by the outer RPC, never page text.
  const shell={format:'chathand-full-output-v1',job_id:this.jobId,segments:[],char_unit:'utf16_code_units',cursor_unit:'utf8_bytes_of_decoded_text',start_byte:999999999,end_byte:999999999,available_total_chars:999999999,available_total_bytes:999999999,available_raw_bytes:999999999,available_total_pages:999999999,snapshot_page:999999999,snapshot_remaining_pages:999999999,final_total:false,at_snapshot_end:false,capture_complete:true,capture_scope:'redacted_complete_lines_through_snapshot',output_limited:false,encoding:'utf8',ordering:'completed_line_callback_order',read_full_cursor:'x'.repeat(66),next_full_cursor:'x'.repeat(66),...extra};
  const budget=typeof envelopeSize==='function'?this.maxEnvelopeChars-size(shell):Math.min(this.fragmentBudget*2,this.maxEnvelopeChars-size(shell));
  if(budget<128)throw safeError('OUTPUT_SPOOL_ENVELOPE_BUDGET');
  if(!d.snapshot){
   const key=[this.textBytes,this.committedFileBytes,this.sealed,this.outputLimited,budget,d.start,JSON.stringify(extra)].join(':');let snapshot=this.snapshotCache.get(key);
   if(!snapshot){const planned=this.plan(d.start,this.textBytes,this.committedFileBytes,budget);snapshot={end:this.textBytes,fileEnd:this.committedFileBytes,chars:this.textChars,rawBytes:this.rawBytes,final:this.sealed,outputLimited:this.outputLimited,pages:planned.pages,availablePages:planned.all.length,extra:{...extra}};this.snapshotCache.set(key,snapshot);if(this.snapshotCache.size>16)this.snapshotCache.delete(this.snapshotCache.keys().next().value);}
   d.snapshot=snapshot;d.page=0;
  }
  if(!d.cursor)this.token(d);
  const s=d.snapshot,b=s.pages[d.page],segments=[];
  for(const segment of this.segments(b.start,b.end,s.fileEnd)){if(segments.at(-1)?.stream===segment.stream)segments.at(-1).text+=segment.text;else segments.push({...segment});}
  if(d.next===undefined)d.next=d.page+1<s.pages.length?this.token({start:b.end,snapshot:s,page:d.page+1}):s.final?null:this.token({start:b.end});
  const page={format:'chathand-full-output-v1',job_id:this.jobId,segments,
   char_unit:'utf16_code_units',cursor_unit:'utf8_bytes_of_decoded_text',start_byte:b.start,end_byte:b.end,
   available_total_chars:s.chars,available_total_bytes:s.end,available_raw_bytes:s.rawBytes,available_total_pages:s.availablePages,
   snapshot_page:d.page+1,snapshot_remaining_pages:s.pages.length-d.page-1,final_total:s.final,at_snapshot_end:d.page+1===s.pages.length,
   capture_complete:true,capture_scope:'redacted_complete_lines_through_snapshot',output_limited:s.outputLimited,encoding:'utf8',ordering:'completed_line_callback_order',read_full_cursor:d.cursor,next_full_cursor:d.next,...s.extra};
  if(size(page)>this.maxEnvelopeChars)throw safeError('OUTPUT_SPOOL_ENVELOPE_BUDGET');return page;
 }
 diskBytes(){let n=0;for(const fd of [this.fdText,this.fdIndex]){const st=fs.fstatSync(fd);if(!st.isFile())throw safeError('OUTPUT_SPOOL_INTEGRITY');n+=st.size;}return n;}
 dispose(){
  if(this.disposed)return;this.disposed=true;this.tokens.clear();this.plans.clear();this.snapshotCache.clear();
  for(const fd of [this.fdText,this.fdIndex])try{fs.closeSync(fd);}catch{}
  try{const d=fs.lstatSync(this.directory),id=this.directoryIdentity;if(!d.isDirectory()||d.isSymbolicLink()||d.dev!==id.dev||d.ino!==id.ino)return;
   for(const [name,identity] of [['text.frames',this.textIdentity],['index.frames',this.indexIdentity]])try{const file=path.join(this.directory,name),st=fs.lstatSync(file);if(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.dev===identity.dev&&st.ino===identity.ino)fs.unlinkSync(file);}catch{}
   try{fs.rmdirSync(this.directory);}catch{}
  }catch{}
 }

}

/** Reuses production redact(line) supplied by integration; never persists raw.
 * Buffers incomplete lines like the original OutputChannel, WITHOUT its 32KiB
 * omission. Thus a no-newline command can require up to its captured-text size
 * in transient memory; the existing hard output/kill policy remains external.
 */
export class FullOutputCapture {
 constructor(spool,redactor){if(typeof redactor!=='function')throw safeError('OUTPUT_SPOOL_REDACTOR');this.spool=spool;this.redactor=redactor;this.abandoned=false;this.limited=false;this.channels=STREAMS.map(()=>({decoder:new StringDecoder('utf8'),parts:[],pendingBytes:0,ended:false}));}
 accept(stream,bytes){const i=STREAMS.indexOf(stream),c=this.channels[i];if(this.abandoned||this.limited)return;if(!c||c.ended||!Buffer.isBuffer(bytes))throw safeError('OUTPUT_SPOOL_STATE');this.spool.rawBytes+=bytes.length;this.emit(i,c.decoder.write(bytes));}
 emit(i,decoded,final=false){
  const c=this.channels[i],sanitized=[];let from=0,at;
  while((at=decoded.indexOf('\n',from))!==-1){c.parts.push(decoded.slice(from,at+1));sanitized.push(this.redactor(c.parts.join('')));c.parts=[];c.pendingBytes=0;from=at+1;}
  if(from<decoded.length){const tail=decoded.slice(from);c.parts.push(tail);c.pendingBytes+=Buffer.byteLength(tail);}
  if(final&&c.parts.length){sanitized.push(this.redactor(c.parts.join('')));c.parts=[];c.pendingBytes=0;}
  if(sanitized.length&&this.spool.appendSanitized(STREAMS[i],sanitized.join(''))){
   // A physical archive cap does not cancel the command. Its ordinary output
   // and existing raw-output execution limit continue independently.
   this.limited=true;this.spool.markOutputLimited();for(const channel of this.channels){channel.parts=[];channel.pendingBytes=0;channel.ended=true;}this.spool.seal();
  }
 }
 endStream(stream){if(this.abandoned||this.limited)return;const i=STREAMS.indexOf(stream),c=this.channels[i];if(!c)throw safeError('OUTPUT_SPOOL_STATE');if(c.ended)return;this.emit(i,c.decoder.end(),true);c.ended=true;if(this.channels.every(x=>x.ended))this.spool.seal();}
 abandon(){this.abandoned=true;for(const c of this.channels){c.parts=[];c.pendingBytes=0;c.ended=true;}}
}

// Only the app calls this after taking its exclusive state lock. Unknown files,
// symlinks, different owners and hard links are left untouched.
export function cleanupCommandOutput(parent){
 let removed=0,skipped=0;let st;try{st=fs.lstatSync(parent);}catch(e){if(e.code==='ENOENT')return {removed,skipped};throw e;}
 const owned=x=>x.uid===process.getuid();
 if(!st.isDirectory()||st.isSymbolicLink()||!owned(st)||(st.mode&0o077))return {removed,skipped:1};
 for(const name of fs.readdirSync(parent)){
  if(!/^job-output-[A-Za-z0-9]{6}$/.test(name)){skipped++;continue;}
  const dir=path.join(parent,name);try{const d=fs.lstatSync(dir);if(!d.isDirectory()||d.isSymbolicLink()||!owned(d)||(d.mode&0o077))throw Error();
   const names=fs.readdirSync(dir);if(names.some(n=>!['text.frames','index.frames'].includes(n)))throw Error();
   for(const n of names){const f=fs.lstatSync(path.join(dir,n));if(!f.isFile()||f.isSymbolicLink()||f.nlink!==1||!owned(f)||(f.mode&0o077))throw Error();}
   for(const n of names)fs.unlinkSync(path.join(dir,n));fs.rmdirSync(dir);removed++;
  }catch{skipped++;}
 }return {removed,skipped};
}
