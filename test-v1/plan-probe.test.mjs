import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {PlanProbe,PROBE_METHODS,PROBE_INTERVAL_MS,findCodex,planId} from '../app/v1/plan-probe.mjs';

const NOW=new Date(2026,9,3,12).getTime();
const account={account:{type:'chatgpt',email:'private-account@example.invalid',planType:'pro_5x',authToken:'fake-sensitive-token'}};
function fakeServer(t,{replies={'account/read':account},garbage=false,silent=false}={}){
 const calls=[];let child,starts=0;
 const spawnProcess=(_file,args)=>{starts++;assert.deepEqual(args,['app-server']);child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null,kills:0});let buffer='',initialized=false;
 child.kill=()=>{child.kills++;child.exitCode=0;child.emit('close',0);return true;};
 child.stdin.on('data',chunk=>{buffer+=chunk.toString();let at;while((at=buffer.indexOf('\n'))>=0){const request=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);calls.push(request);if(silent)continue;if(garbage){child.stdout.write('not-json\n');continue;}
 if(request.method==='initialized'){initialized=true;continue;}
 let result,error;if(request.method==='initialize')result={serverInfo:{name:'fake'}};else if(!initialized)error={code:-32000,message:'Not initialized'};else if(!Object.hasOwn(replies,request.method))error={code:-32601,message:'Unsupported fake method'};else result=replies[request.method];
 child.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,...(error?{error}:{result})})+'\n');}});return child;};
 const probe=new PlanProbe({findExecutable:()=>'/synthetic/codex',spawnProcess,now:()=>NOW,timeoutMs:100});t.after(()=>probe.close());return {probe,calls,child:()=>child,starts:()=>starts};
}
test('fake app-server initializes and probes only account/read without refreshing the token',async t=>{
 assert.deepEqual(PROBE_METHODS,['account/read']);const f=fakeServer(t);const result=await f.probe.read();assert.equal(result.handshake,'ok');assert.equal(result.plan,'pro_5x');assert.equal(result.plan_type,'pro_5x');assert.equal(result.week_tokens,null);
 assert.deepEqual(f.calls.map(call=>call.method),['initialize','initialized','account/read']);assert.deepEqual(f.calls.find(call=>call.method==='account/read').params,{refreshToken:false});assert.ok(f.child().kills>0);
 assert.doesNotMatch(JSON.stringify(result),/email|private-account|authToken|fake-sensitive-token/);assert.deepEqual(result.methods,{'account/read':'ok'});
});
test('1012 plan aliases map prolite to Pro 5x and pro to Pro 20x; unknown strings retain fallback',async t=>{
 for(const [raw,expected] of [['prolite','pro_5x'],['pro','pro_20x'],[' ProLite ','pro_5x'],['team',null],['unknown',null],['pro_lite',null],['Pro 5x','pro_5x'],['pro-20x','pro_20x'],['Plus','plus']])assert.equal(planId(raw),expected);
 for(const [raw,expected] of [['prolite','pro_5x'],['pro','pro_20x'],['team',null]]){const f=fakeServer(t,{replies:{'account/read':{account:{email:'private-account@example.invalid',planType:raw}}}});const value=await f.probe.read();assert.equal(value.plan,expected);assert.equal(value.plan_type,raw);assert.equal(value.week_tokens,null);assert.deepEqual(Object.keys(value.methods),['account/read']);assert.doesNotMatch(JSON.stringify(value),/private-account|email/);}
});
test('account read failure retains unknown plan and reports its own fallback status',async t=>{
 const f=fakeServer(t,{replies:{}});const result=await f.probe.read();assert.equal(result.plan,null);assert.equal(result.methods['account/read'],'unsupported');assert.equal(result.week_tokens,null);
});
test('timeout closes a short-lived process without throwing',async t=>{
 const f=fakeServer(t,{silent:true});f.probe.timeoutMs=25;const keepAlive=setTimeout(()=>{},500);try{const result=await f.probe.read();assert.equal(result.handshake,'timeout');assert.ok(f.child().kills>0);assert.equal(result.methods['account/read'],'not_attempted');}finally{clearTimeout(keepAlive);}
});
test('malformed app-server output is discarded without throwing or exposing raw content',async t=>{
 const f=fakeServer(t,{garbage:true});const value=await f.probe.read();assert.equal(value.handshake,'malformed');assert.equal(value.plan,null);assert.doesNotMatch(JSON.stringify(value),/not-json/);
});
test('missing executable and failed finder/spawn never throw',async()=>{
 for(const options of [{findExecutable:()=>null},{findExecutable:()=>{throw Error('private-account@example.invalid');}},{findExecutable:()=>'/synthetic/codex',spawnProcess:()=>{throw Error('private-account@example.invalid');}}]){const probe=new PlanProbe(options);const value=await probe.read();assert.equal(value.plan,null);assert.doesNotMatch(JSON.stringify(value),/private-account|email/);probe.close();}
});
test('six-hour cache deduplicates concurrent probes and subsequent reads',async t=>{
 const f=fakeServer(t);const first=await Promise.all([f.probe.read(),f.probe.read()]);assert.deepEqual(first[0],first[1]);assert.equal(f.starts(),1);await f.probe.read();assert.equal(f.starts(),1);
});
test('restart cache retains plan and probe timestamp but discards any legacy quota',async t=>{
 let now=NOW;const saved={plan:'pro_5x',week_tokens:675_000_000,calibrated_at:NOW-60_000};let finds=0;
 const probe=new PlanProbe({initialProbe:saved,lastAttempt:saved.calibrated_at,now:()=>now,findExecutable:()=>{finds++;return null;}});t.after(()=>probe.close());const cached=await probe.read();assert.equal(finds,0);assert.equal(cached.plan,'pro_5x');assert.equal(cached.week_tokens,null);assert.equal(cached.calibrated_at,saved.calibrated_at);
 now+=PROBE_INTERVAL_MS;const actualFailure=await probe.read();assert.equal(finds,1);assert.equal(actualFailure.plan,null);assert.equal(actualFailure.week_tokens,null);assert.equal(actualFailure.methods['account/read'],'not_found');
});
test('app bundle executable is preferred to PATH; no authentication file discovery',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-plan-find-')),app=path.join(root,'ChatGPT.app'),bundled=path.join(app,'Contents/Resources/codex-cli/bin/codex'),bin=path.join(root,'bin'),fallback=path.join(bin,'codex');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.dirname(bundled),{recursive:true});fs.mkdirSync(bin);fs.writeFileSync(bundled,'fake',{mode:0o700});fs.writeFileSync(fallback,'fake',{mode:0o700});assert.equal(findCodex({applications:[app],searchPath:bin}),bundled);fs.unlinkSync(bundled);assert.equal(findCodex({applications:[app],searchPath:bin}),fallback);assert.equal(findCodex({applications:[],searchPath:''}),null);
});
