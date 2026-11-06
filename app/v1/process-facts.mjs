import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const helper=path.join(root,'bin','ChatHandUpgradeControl');
const script=path.join(root,'scripts','process-facts-jxa.js');
const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin'};
function run(command,args){const r=spawnSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','ignore'],env});if(r.error||r.status!==0)throw Error('PROCESS_FACTS_UNAVAILABLE');try{return JSON.parse(r.stdout);}catch{throw Error('PROCESS_FACTS_UNAVAILABLE');}}
function darwin(pid){
 if(fs.existsSync(helper))return run(helper,['process-facts',String(pid)]);
 const raw=run('/usr/bin/osascript',['-l','JavaScript',script,'facts',String(pid)]);
 const result={};
 if(raw.boot){const boot=Buffer.from(raw.boot,'base64');if(boot.length!==16)throw Error('PROCESS_FACTS_UNAVAILABLE');result.boot_seconds=Number(boot.readBigInt64LE(0));result.boot_microseconds=boot.readInt32LE(8);}
 if(raw.count===0&&raw.error===3)return {...result,absent:true};
 if(raw.count!==136||!raw.process)return {...result,unknown:true};
 const data=Buffer.from(raw.process,'base64');if(data.length!==136||data.readUInt32LE(12)!==pid)throw Error('PROCESS_FACTS_UNAVAILABLE');
 return {...result,start_seconds:Number(data.readBigUInt64LE(120)),start_microseconds:Number(data.readBigUInt64LE(128))};
}
function linux(pid){
 const boot=Number(/^btime\s+(\d+)$/m.exec(fs.readFileSync('/proc/stat','utf8'))?.[1]);
 if(!Number.isSafeInteger(boot))throw Error('PROCESS_FACTS_UNAVAILABLE');
 let value;try{value=fs.readFileSync(`/proc/${pid}/stat`,'utf8');}catch(e){if(e.code==='ENOENT')return {boot_seconds:boot,boot_microseconds:0,absent:true};throw e;}
 const fields=value.slice(value.lastIndexOf(')')+2).split(' '),ticks=Number(fields[19]);
 const clock=spawnSync('/usr/bin/getconf',['CLK_TCK'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],env});const hz=Number(clock.stdout);
 if(!Number.isSafeInteger(ticks)||!Number.isSafeInteger(hz)||hz<=0)throw Error('PROCESS_FACTS_UNAVAILABLE');
 return {boot_seconds:boot,boot_microseconds:0,start_seconds:boot+Math.floor(ticks/hz),start_microseconds:Math.floor((ticks%hz)*1e6/hz)};
}
export function processFacts(pid){
 if(!Number.isSafeInteger(pid)||pid<=1||pid>2147483647)throw Error('PROCESS_FACTS_UNAVAILABLE');
 const facts=process.platform==='darwin'?darwin(pid):process.platform==='linux'?linux(pid):null;
 if(!facts||!facts.absent&&!facts.unknown&&(!Number.isSafeInteger(facts.start_seconds)||!Number.isSafeInteger(facts.start_microseconds)))throw Error('PROCESS_FACTS_UNAVAILABLE');
 return facts;
}
export function archiveRecord(file,observed){
 let current;try{current=fs.lstatSync(file,{bigint:true});}catch(e){if(e.code==='ENOENT')return false;throw e;}
 if(!current.isFile()||current.isSymbolicLink()||current.uid!==BigInt(process.getuid())||current.nlink!==1n||(current.mode&0o077n)!==0n)throw Error('STALE_RECORD_UNSAFE');
 if(current.dev!==observed.dev||current.ino!==observed.ino||current.mtimeNs!==observed.mtimeNs)return false;
 const target=`${file}.stale-${observed.dev}-${observed.ino}-${observed.mtimeNs}`;
 if(process.platform==='darwin'){
  const result=fs.existsSync(helper)?run(helper,['archive-stale-record',file,String(observed.dev),String(observed.ino),String(observed.mtimeNs)]):run('/usr/bin/osascript',['-l','JavaScript',script,'archive',file,target]);
  if(result.ok===true)return true;if([2,17].includes(result.errno))return false;throw Error('STALE_RECORD_UNSAFE');
 }
 try{fs.linkSync(file,target);const latest=fs.lstatSync(file,{bigint:true});if(latest.dev!==observed.dev||latest.ino!==observed.ino||latest.mtimeNs!==observed.mtimeNs)throw Error('STALE_RECORD_UNSAFE');fs.unlinkSync(file);return true;}catch(e){if(['ENOENT','EEXIST'].includes(e.code))return false;throw e;}
}
