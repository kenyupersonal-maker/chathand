import crypto from 'node:crypto';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {createDesktop} from '../../app/server.mjs';
const script=fileURLToPath(new URL('./fake-tunnel.mjs',import.meta.url));
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function until(fn,ms=10000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await sleep(40);}throw Error('TEST_WAIT_TIMEOUT');}
export function makeBinary(dir){const f=path.join(dir,'test-tunnel-client'),quote=s=>"'"+s.replaceAll("'","'\\''")+"'";fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(f,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,{mode:0o700});return f;}
export async function fixture(t){
 const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'kb054-oneclick-'))),stateDir=path.join(base,'state'),defaultRoot=path.join(base,'work');
 const config={tunnel_id:'tunnel_'+ 'd'.repeat(32),api_key:'sk-offline-test-key-only',binary:makeBinary(base)};
 const uiKey=crypto.randomBytes(32).toString('hex');
 const f={base,stateDir,defaultRoot,config,uiKey,b:await createDesktop({stateDir,defaultRoot,uiKey})};
 f.restart=async()=>{await f.b.close();f.b=await createDesktop({stateDir,defaultRoot,uiKey});return f.b;};
 f.connect=async()=>{await f.b.handle('/api/connect',config);return waitReady(f.b);};
 t.after(async()=>{await f.b.close();fs.rmSync(base,{recursive:true,force:true});});return f;
}
export async function waitReady(b){return until(async()=>{const s=await b.snapshot();return s.connection.automatic.phase==='ready'&&s.enabled?s:false;});}
export async function realWork(b,key){
 const t=await b.tools.invoke('begin_task',{request_id:'task-'+key,title:'One click test '+key});
 const w=await b.tools.invoke('write_text',{task_id:t.task_id,path:key+'.txt',content:'ONECLICK_'+key+'\n',operation_id:'write-'+key,expected_sha256:'MISSING'});
 const j=await b.tools.invoke('propose_command',{task_id:t.task_id,request_id:'command-'+key,program:process.execPath,args:['-e','console.log("ONECLICK_TERMINAL_OK")'],cwd:'.',wait_ms:2000});
 const end=await b.tools.invoke('finish_task',{task_id:t.task_id});return {t,w,j,end};
}

export async function waitAuthRejected(b){return until(async()=>{await b.snapshot();return b.controller.phase==='needs_login'&&!b.tunnel.child&&!b.tunnel.doctorChild;});}
