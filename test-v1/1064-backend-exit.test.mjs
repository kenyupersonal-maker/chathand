// Isolated real CLI processes only; no installed state, credentials or cloud calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const entry=fileURLToPath(new URL('../app/server.mjs',import.meta.url));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function start(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-exit1064-')),state=path.join(root,'state');
 fs.mkdirSync(path.join(root,'home'),{recursive:true});
 const env={...process.env,HOME:path.join(root,'home'),CODEX_HOME:path.join(root,'home','.codex'),CHATHAND_STATE_DIR:state,KEN_BRIDGE_STATE_DIR:state};
 for(const name of ['CHATHAND_UI_KEY_STDIN','CHATHAND_OWNER_PIPE','KEN_BRIDGE_OWNER_PID','CHATHAND_REHEARSAL_ROOT','CHATHAND_REHEARSAL_HOME'])delete env[name];
 // A retained dependency handle reproduces the old CLI's post-close liveness.
 env.CHATHAND_UI_KEY_STDIN='1';const uiKey='ab'.repeat(32);
 const child=spawn(process.execPath,['--import','data:text/javascript,setInterval(()=>{},1000)',entry],{env,cwd:root,stdio:['pipe','pipe','pipe']});
 child.stdin.end(uiKey+'\n');
 let output='',errors='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}fs.rmSync(root,{recursive:true,force:true});});
 const end=Date.now()+8000;while(!output.includes('本机执行服务已启动')&&Date.now()<end&&child.exitCode===null)await pause(20);
 assert.ok(output.includes('本机执行服务已启动'),'isolated CLI became ready');
 const runtimeFile=path.join(state,'runtime.json'),runtime=JSON.parse(fs.readFileSync(runtimeFile));assert.equal(runtime.pid,child.pid);
 return {child,exited,state,runtime,runtimeFile,uiKey,errors:()=>errors};
}
for(const action of ['shutdown','SIGTERM'])test('1064 CLI '+action+' completes teardown and exits even with a retained dependency handle',{timeout:15000},async t=>{
 const f=await start(t);
 if(action==='shutdown'){
  const response=await fetch(f.runtime.ui_origin+'/api/shutdown',{method:'POST',headers:{Authorization:'Bearer '+f.runtime.admin_token,'Content-Type':'application/json','X-ChatHand-UI':f.uiKey},body:'{}'});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});
 }else assert.equal(f.child.kill('SIGTERM'),true);
 const result=await Promise.race([f.exited,pause(8000).then(()=>({timeout:true}))]);
 assert.equal(result.timeout,undefined,'CLI PID exited after complete close');assert.deepEqual(result,{code:0,signal:null});
 assert.equal(fs.existsSync(f.runtimeFile),false);assert.equal(fs.existsSync(path.join(f.state,'app.lock')),false);
 await assert.rejects(()=>fetch(f.runtime.ui_origin+'/api/state',{signal:AbortSignal.timeout(1000)}));
 assert.doesNotMatch(f.errors(),/UnhandledPromiseRejection|uncaughtException/);
});

test('1064 native takeover and relaunch diagnostics preserve categorical outcomes without arbitrary payloads',async t=>{
 const {readNativeTimeline}=await import('../app/diagnostic-events.mjs');const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-lifecycle-diagnostic1064-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'diagnostics'),{mode:0o700});
 const codes=['ORPHAN_ALREADY_CLOSED','INSTANCE_SCOPE_MISSING','RELAUNCH_SIGNATURE_UNKNOWN','RELAUNCH_CANCELLED','RELAUNCH_START_TIMEOUT','RELAUNCH_FAILED','ORPHAN_GRACEFUL_TIMEOUT','ORPHAN_TERM_TIMEOUT','ORPHAN_FORCE_KILL'];
 fs.writeFileSync(path.join(root,'diagnostics/native-events.jsonl'),codes.map(code=>JSON.stringify({at:new Date().toISOString(),phase:code.startsWith('RELAUNCH')?'relaunch':'instance',code,pid:123,build:1064,unknown:'fixture private payload'})).join('\n')+'\n',{mode:0o600});
 const timeline=readNativeTimeline(root);assert.deepEqual(timeline.events.map(event=>event.code),codes);assert.ok(timeline.events.every(event=>event.pid===123));assert.doesNotMatch(JSON.stringify(timeline),/fixture private payload|unknown/);
});
