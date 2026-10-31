import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {callOwner,quitOwner,quitContext,stopInstalledQuitHelper,inspectQuitProcess} from '../../skills/chathand-setup/scripts/setup.mjs';
const repo=fileURLToPath(new URL('../../',import.meta.url)),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const failure=(code='UI_CONFIRM_REQUIRED',status=403)=>Object.assign(Error(code),{code,...(status===undefined?{}:{status})});
function model({build=1065,version='1.0.0-beta.15',error=failure(),stops=true}={}){
 let clock=0,stopCount=0;const app='/fixture/Applications/ChatHand.app',node=app+'/Contents/Resources/runtime/bin/ChatHandNode',native={pid:501,ppid:1,path:app+'/Contents/MacOS/ChatHand',started:'native original'},backend={pid:502,ppid:501,path:node,started:'backend original'},live=new Map([[501,native],[502,backend]]),signals=[];
 const context={app,node,helper:app+'/Contents/Resources/runtime/bin/ken-upgrade-control',nativePaths:[native.path],nativeInfo:()=>({pids:[501],identities:[{pid:501,executable:native.path}]}),normalStop:async()=>{stopCount++;if(stops)live.clear();return {stopped:true};}};
 return {runtime:{pid:502},live,signals,context,stops:()=>stopCount,advance:ms=>{clock+=ms;},options:{context:()=>context,realpath:p=>p,programText:()=>true,inspect:pid=>{const value=live.get(pid);return value?{...value}:null;},probe:(pid,signal)=>{signals.push(signal);if(!live.has(pid))throw Object.assign(Error(),{code:'ESRCH'});},now:()=>clock,wait:async ms=>{clock+=ms;},timeoutMs:400,call:async(_,route)=>{if(route==='/api/state')return {node,lifecycle:{protocol:1},about:{build,version}};throw error;}}};
}
test('callOwner preserves real HTTP status with sanitized code, including invalid response bodies',async t=>{
 const server=http.createServer((q,r)=>{r.writeHead(403,{'Content-Type':'application/json'});r.end(q.url==='/invalid'?'not-json':'{"error":{"code":"UI_CONFIRM_REQUIRED"}}');});
 const sockets=new Set();server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const runtime={ui_origin:'http://127.0.0.1:'+server.address().port,admin_token:'fixture-only'};
 await assert.rejects(callOwner(runtime,'/quit',{}),e=>e.status===403&&e.code==='UI_CONFIRM_REQUIRED'&&!('body' in e));
 await assert.rejects(callOwner(runtime,'/invalid',{}),e=>e.status===403&&e.code==='OWNER_RESPONSE_INVALID');
 await assert.rejects(callOwner(runtime,'/quit',{},async()=>({ok:false,status:403,json:async()=>({error:'secret raw text'})})),e=>e.status===403&&e.code==='OWNER_REQUEST_FAILED'&&!e.message.includes('secret'));
});
test('real HTTP quit uses GET state and POST quit, for both legacy 403 and current owner acceptance',async()=>{
 for(const build of [1065,1066]){
  const d=model(),requests=[],sockets=new Set();
  const server=http.createServer((q,r)=>{let body='';q.on('data',chunk=>body+=chunk);q.on('end',()=>{
   requests.push({method:q.method,path:q.url,body});r.setHeader('Content-Type','application/json');
   if(q.url==='/api/state'){
    if(q.method!=='GET'){r.writeHead(400);r.end('{"error":{"code":"JSON_INVALID"}}');return;}
    r.end(JSON.stringify({node:d.context.node,lifecycle:{protocol:1},about:{build,version:build===1065?'1.0.0-beta.15':'1.0.0-beta.16'}}));return;
   }
   if(q.url==='/api/lifecycle/quit'&&q.method==='POST'&&body==='{}'){
    if(build===1065){r.writeHead(403);r.end('{"error":{"code":"UI_CONFIRM_REQUIRED"}}');}
    else{d.live.clear();r.end('{"accepted":true}');}return;
   }
   r.writeHead(405);r.end('{"error":{"code":"METHOD_NOT_ALLOWED"}}');
  });});
  server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
   const receipt=await quitOwner({...d.runtime,ui_origin:'http://127.0.0.1:'+server.address().port,admin_token:'fixture-only'},{...d.options,call:callOwner,now:Date.now,wait:delay,timeoutMs:1500});
   assert.deepEqual(requests,[{method:'GET',path:'/api/state',body:''},{method:'POST',path:'/api/lifecycle/quit',body:'{}'}]);
   assert.equal(receipt.native_exited,true);assert.equal(receipt.backend_exited,true);assert.equal(d.stops(),build===1065?1:0);assert.equal(receipt.method,build===1065?'installed_1065_helper_stop':'owner_api');
  }finally{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));}
 }
});
test('only exact 1065 plus real 403 UI_CONFIRM_REQUIRED uses installed normal stop and independently observes both PIDs gone',async()=>{
 const d=model(),result=await quitOwner(d.runtime,d.options);assert.equal(d.stops(),1);assert.equal(result.method,'installed_1065_helper_stop');assert.equal(result.helper_program,d.context.helper);assert.equal(result.native_exited,true);assert.equal(result.backend_exited,true);assert.ok(d.signals.every(signal=>signal===0));
});
test('new/unknown build, wrong version/status/code and malformed errors never invoke legacy stop',async()=>{
 const cases=[{build:1066},{build:1064},{build:'1065'},{build:null},{version:'1.0.0-beta.16'},{error:failure('UI_CONFIRM_REQUIRED',401)},{error:failure('UI_CONFIRM_REQUIRED',200)},{error:Object.assign(Error(),{code:'UI_CONFIRM_REQUIRED'})},{error:failure('OTHER_ERROR',403)},{error:failure('OWNER_RESPONSE_INVALID',403)},{error:failure('OWNER_UNREACHABLE',403)}];
 for(const options of cases){const d=model(options);await assert.rejects(quitOwner(d.runtime,d.options));assert.equal(d.stops(),0,JSON.stringify(options));assert.equal(d.live.size,2);assert.ok(d.signals.every(signal=>signal===0));}
});
test('stopped:true cannot substitute PID absence; identity changes before stop fail closed',async()=>{
 const d=model({stops:false});await assert.rejects(quitOwner(d.runtime,d.options),e=>e.code==='QUIT_TIMEOUT'&&e.quit_receipt.method==='installed_1065_helper_stop'&&!e.quit_receipt.native_exited&&!e.quit_receipt.backend_exited);assert.equal(d.stops(),1);assert.equal(d.live.size,2);
 for(const changed of ['path','started']){const x=model(),call=x.options.call;x.options.call=async(...args)=>{try{return await call(...args);}catch(e){x.live.set(502,{...x.live.get(502),[changed]:'changed'});throw e;}};await assert.rejects(quitOwner(x.runtime,x.options),{code:'QUIT_IDENTITY_CHANGED'});assert.equal(x.stops(),0);}
});
test('an original native or backend disappearing before helper dispatch cannot target a replacement App',async()=>{
 for(const removed of [[501],[502],[501,502]]){const d=model(),call=d.options.call;d.options.call=async(...args)=>{try{return await call(...args);}catch(e){for(const pid of removed)d.live.delete(pid);throw e;}};await assert.rejects(quitOwner(d.runtime,d.options),{code:'QUIT_IDENTITY_CHANGED'});assert.equal(d.stops(),0);assert.ok(d.signals.every(signal=>signal===0));}
});
function contextFixture(t,remove=true){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-quit-owned-'))),app=path.join(root,'Applications/ChatHand.app'),bin=path.join(app,'Contents/Resources/runtime/bin');fs.mkdirSync(bin,{recursive:true});for(const name of ['ChatHandNode','ken-upgrade-control','ChatHandUpgradeControl'])fs.writeFileSync(path.join(bin,name),'fixture',{mode:0o755});const pkg=path.join(app,'Contents/Resources/runtime/package.json');fs.writeFileSync(pkg,JSON.stringify({version:'1.0.0-beta.15',kenBridge:{build_number:1065}}));if(remove)t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,app,bin,pkg,node:path.join(bin,'ChatHandNode')};}
test('helper is resolved only inside the installed Node App and revalidated before stop',async t=>{
 const f=contextFixture(t),calls=[],context=quitContext({executable:f.node,stop:async(...args)=>{calls.push(args);return {stopped:true};}});await context.normalStop(300,new AbortController().signal);assert.equal(calls.length,1);assert.equal(calls[0][0],path.join(f.bin,'ken-upgrade-control'));assert.equal(calls[0][1],f.app);assert.equal(calls[0][2].timeoutMs,300);
 fs.writeFileSync(f.pkg,JSON.stringify({version:'1.0.0-beta.16',kenBridge:{build_number:1066}}));assert.throws(()=>context.normalStop(300),{code:'QUIT_IDENTITY_UNVERIFIED'});assert.equal(calls.length,1);
 fs.writeFileSync(f.pkg,JSON.stringify({version:'1.0.0-beta.15',kenBridge:{build_number:1065}}));fs.chmodSync(path.join(f.bin,'ChatHandUpgradeControl'),0o777);assert.throws(()=>context.normalStop(300),{code:'QUIT_IDENTITY_UNVERIFIED'});fs.chmodSync(path.join(f.bin,'ChatHandUpgradeControl'),0o755);
 for(const name of ['ken-upgrade-control','ChatHandUpgradeControl']){const file=path.join(f.bin,name),saved=file+'.saved';fs.renameSync(file,saved);fs.symlinkSync(saved,file);assert.throws(()=>quitContext({executable:f.node}),{code:'QUIT_IDENTITY_UNVERIFIED'});fs.unlinkSync(file);fs.renameSync(saved,file);}
});
function compile(source,output){const r=spawnSync('/usr/bin/xcrun',['clang','-x','c','-','-o',output],{input:source,encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr);}
test('helper subprocess is bounded without signalling either retained target process',{skip:process.platform!=='darwin',timeout:35000},async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-quit-child-'))),helper=path.join(root,'helper'),pidfile=path.join(root,'child.pid');let childPID;
 t.after(async()=>{if(childPID)for(let i=0;i<50;i++){try{process.kill(childPID,0);await delay(10);}catch(e){if(e.code==='ESRCH')break;throw e;}}if(childPID)assert.throws(()=>process.kill(childPID,0),{code:'ESRCH'});fs.rmSync(root,{recursive:true,force:true});});
 compile('#include <unistd.h>\n#include <signal.h>\n#include <stdio.h>\nint main(){signal(SIGTERM,SIG_IGN);FILE*f=fopen('+JSON.stringify(pidfile)+',"w");fprintf(f,"%d",getpid());fclose(f);while(1)pause();}',helper);
 const d=model({stops:false});d.options.now=Date.now;d.options.wait=delay;d.options.timeoutMs=350;d.context.normalStop=(budget,signal)=>stopInstalledQuitHelper(helper,d.context.app,{timeoutMs:budget,signal,launch:(...args)=>{const child=spawn(...args);childPID=child.pid;return child;}});const started=Date.now();
 await assert.rejects(quitOwner(d.runtime,d.options),{code:'QUIT_TIMEOUT'});assert.ok(Date.now()-started<800);assert.equal(d.live.size,2);assert.ok(d.signals.every(signal=>signal===0));if(fs.existsSync(pidfile))assert.equal(Number(fs.readFileSync(pidfile)),childPID);
});
// Console-only fake parent/backend and stop adapter. No NSApplication, LS, TCC or actual helper stop is invoked here.
test('real 1065 Node plus loopback 403 uses the installed fixture stop adapter, original native/backend really exit',{skip:process.platform!=='darwin'||!process.env.CHATHAND_QUIT_OLD_APP,timeout:45000},async t=>{
 const f=contextFixture(t,false),state=path.join(f.root,'home/data'),native=path.join(f.app,'Contents/MacOS/ChatHand'),home=path.join(f.root,'home'),incoming=path.join(f.root,'incoming'),old=path.join(process.env.CHATHAND_QUIT_OLD_APP,'Contents/Resources/runtime/bin');fs.mkdirSync(state,{recursive:true});fs.mkdirSync(path.dirname(native),{recursive:true});for(const name of ['node','ChatHandNode']){fs.copyFileSync(path.join(old,name),path.join(f.bin,name));fs.chmodSync(path.join(f.bin,name),0o755);}
 const release=path.join(state,'release'),pidfile=path.join(state,'parent.pid'),stopped=path.join(state,'stopped');
 compile('#include <unistd.h>\n#include <sys/wait.h>\nint main(int n,char**v){if(n!=4)return 2;pid_t p=fork();if(!p){execl(v[1],v[1],v[2],v[3],(char*)0);return 3;}int s;while(waitpid(p,&s,WNOHANG)==0)usleep(10000);return 0;}',native);
 compile('#include <stdio.h>\n#include <string.h>\n#include <unistd.h>\n#include <signal.h>\nint main(int n,char**v){if(n!=3)return 2;if(!strcmp(v[1],"info")){int pid=0;FILE*f=fopen('+JSON.stringify(pidfile)+',"r");if(!f)return 3;fscanf(f,"%d",&pid);fclose(f);printf("{\\"kernel_scan\\":true,\\"pids\\":[%d],\\"identities\\":[{\\"pid\\":%d,\\"executable\\":\\"%s/Contents/MacOS/ChatHand\\"}]}",pid,pid,v[2]);return 0;}if(strcmp(v[1],"stop"))return 4;FILE*f=fopen('+JSON.stringify(stopped)+',"w");fputs(v[0],f);fclose(f);f=fopen('+JSON.stringify(release)+',"w");fclose(f);int pid=0;f=fopen('+JSON.stringify(pidfile)+',"r");if(!f)return 5;fscanf(f,"%d",&pid);fclose(f);for(int i=0;i<300&&kill(pid,0)==0;i++)usleep(10000);puts("{\\"stopped\\":true}");return 0;}',path.join(f.bin,'ken-upgrade-control'));
 const backend=path.join(f.root,'backend.mjs');fs.writeFileSync(backend,`import fs from 'node:fs';import http from 'node:http';const state=process.argv[2],token='f'.repeat(64);const server=http.createServer((q,r)=>{if(q.headers.authorization!=='Bearer '+token){r.writeHead(401);r.end('{}');return;}r.setHeader('Content-Type','application/json');if(q.url==='/api/state'){r.end(JSON.stringify({node:process.execPath,lifecycle:{protocol:1},about:{build:1065,version:'1.0.0-beta.15'}}));return;}r.writeHead(403);r.end('{"error":{"code":"UI_CONFIRM_REQUIRED"}}');});server.listen(0,'127.0.0.1',()=>fs.writeFileSync(state+'/runtime.json',JSON.stringify({pid:process.pid,ui_origin:'http://127.0.0.1:'+server.address().port,admin_token:token})));setInterval(()=>{if(fs.existsSync(state+'/release'))server.close(()=>process.exit(0));},20).unref();setTimeout(()=>server.close(()=>process.exit(0)),20000).unref();`);
 const controller=path.join(f.root,'controller.mjs');fs.writeFileSync(controller,`import fs from 'node:fs';import {spawn} from 'node:child_process';const child=spawn(process.argv[2],process.argv.slice(3),{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidfile)},String(child.pid));child.on('exit',()=>process.exit(0));`);
 const node=path.join(f.bin,'node'),child=spawn(node,[controller,native,node,backend,state],{stdio:'ignore',env:{...process.env,HOME:home}});t.after(async()=>{fs.writeFileSync(release,'cleanup');for(let i=0;i<100&&child.exitCode===null;i++)await delay(30);assert.notEqual(child.exitCode,null,'own console processes exit through control file');fs.rmSync(f.root,{recursive:true,force:true});});
 let runtime;for(let i=0;i<100;i++){try{runtime=JSON.parse(fs.readFileSync(path.join(state,'runtime.json')));break;}catch{}await delay(20);}assert.ok(runtime);const nativePID=Number(fs.readFileSync(pidfile));assert.ok(inspectQuitProcess(nativePID));
 const script=path.join(incoming,'setup.mjs');fs.mkdirSync(incoming);fs.copyFileSync(path.join(repo,'skills/chathand-setup/scripts/setup.mjs'),script);const marker=path.join(incoming,'must-not-run'),evil=path.join(incoming,'preload.cjs');fs.writeFileSync(evil,'require("node:fs").writeFileSync('+JSON.stringify(marker)+',"bad")');
 const result=spawnSync('/usr/bin/env',['-u','NODE_OPTIONS','-u','NODE_PATH',node,'--no-addons',script,'quit'],{encoding:'utf8',timeout:15000,env:{...process.env,HOME:home,CHATHAND_STATE_DIR:state,NODE_OPTIONS:'--require '+evil,NODE_PATH:incoming}});assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout);assert.equal(receipt.method,'installed_1065_helper_stop');assert.equal(receipt.helper_program,path.join(f.bin,'ken-upgrade-control'));assert.equal(receipt.native_exited,true);assert.equal(receipt.backend_exited,true);assert.ok(receipt.elapsed_ms<12000);assert.equal(fs.readFileSync(stopped,'utf8'),path.join(f.bin,'ken-upgrade-control'));assert.equal(inspectQuitProcess(runtime.pid),null);assert.equal(inspectQuitProcess(nativePID),null);assert.equal(fs.existsSync(marker),false);assert.equal(result.stdout.includes('f'.repeat(64)),false);console.log(JSON.stringify({scope:'console fake backend/stop adapter, real original 1065 Node',native_pid:nativePID,backend_pid:runtime.pid,all_exited:true,elapsed_ms:receipt.elapsed_ms,authorization_api_used:false}));
});
test('INSTALL diagnoses a quit timeout and still waits for exit before replacing files',()=>{
 const text=fs.readFileSync(path.join(repo,'codex/INSTALL.md'),'utf8'),section=text.split('## 4. ')[1].split('## 5. ')[0];for(const phrase of ['HTTP、helper 和等待共用最多 12 秒','不得弹出任何 macOS 授权或自动化询问框','ChatHand → Quit','先查具体进程和退出状态','不备份、不复制、不移动','env -u NODE_OPTIONS -u NODE_PATH','--no-addons','不加载新盘其它脚本、可执行程序或 .node'])assert.ok(section.includes(phrase),phrase);
});
