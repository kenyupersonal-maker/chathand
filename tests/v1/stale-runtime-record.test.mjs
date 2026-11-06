import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {acquireAppLock} from '../../app/v1/app-lock.mjs';
import {processFacts} from '../../app/v1/process-facts.mjs';
import {startupFixture} from '../support/startup-five-fixture.mjs';

function fixture(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-stale-record-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function write(dir,name,value,{old=false}={}){const f=path.join(dir,name);fs.writeFileSync(f,JSON.stringify(value),{mode:0o600});if(old)fs.utimesSync(f,1,1);return f;}
function sleeper(t){const p=spawn('/bin/sleep',['60'],{stdio:'ignore'});t.after(()=>{if(p.exitCode===null)p.kill('SIGTERM');});return p;}
function records(dir,pid,extra={},options={}){write(dir,'runtime.json',{pid,product:'ken-bridge',ui_origin:'http://127.0.0.1:9',admin_token:'a'.repeat(64),...extra},options);write(dir,'app.lock',{pid,...extra},options);}
function archived(dir,name){return fs.readdirSync(dir).filter(n=>n.startsWith(name+'.stale-'));}

test('legacy records from a previous boot are both archived while an unrelated live process is untouched',async t=>{
 const dir=fixture(t),p=sleeper(t);records(dir,p.pid,{}, {old:true});const result=await acquireAppLock(dir);
 assert.equal(p.exitCode,null);assert.equal(result.identity.pid,process.pid);
 assert.equal(archived(dir,'runtime.json').length,1);assert.equal(archived(dir,'app.lock').length,1);assert.equal(fs.existsSync(path.join(dir,'runtime.json')),false);
 const actual=JSON.parse(fs.readFileSync(path.join(dir,'app.lock')));const own=processFacts(process.pid);
 assert.equal(actual.start_seconds,own.start_seconds);assert.equal(actual.start_microseconds,own.start_microseconds);
});

test('a different process start identity makes both records stale even in the current boot',async t=>{
 const dir=fixture(t),p=sleeper(t),fact=processFacts(p.pid);records(dir,p.pid,{start_seconds:fact.start_seconds+1,start_microseconds:fact.start_microseconds});
 await acquireAppLock(dir);assert.equal(p.exitCode,null);assert.equal(archived(dir,'runtime.json').length,1);assert.equal(archived(dir,'app.lock').length,1);
});

test('a missing recorded process makes both records stale',async t=>{
 const dir=fixture(t),p=sleeper(t);p.kill('SIGTERM');await new Promise(resolve=>p.once('close',resolve));records(dir,p.pid);
 await acquireAppLock(dir);assert.equal(archived(dir,'runtime.json').length,1);assert.equal(archived(dir,'app.lock').length,1);
});

test('a record from before boot is stale even when it has no usable PID',async t=>{
 const dir=fixture(t);write(dir,'runtime.json',{pid:0},{old:true});write(dir,'app.lock',{}, {old:true});
 await acquireAppLock(dir);assert.equal(archived(dir,'runtime.json').length,1);assert.equal(archived(dir,'app.lock').length,1);
});

test('a matching live process keeps its lock and runtime records',async t=>{
 const dir=fixture(t),fact=processFacts(process.pid);records(dir,process.pid,{start_seconds:fact.start_seconds,start_microseconds:fact.start_microseconds});
 const before=fs.readFileSync(path.join(dir,'runtime.json'));
 await assert.rejects(acquireAppLock(dir),{code:'ALREADY_RUNNING'});
 assert.deepEqual(fs.readFileSync(path.join(dir,'runtime.json')),before);assert.equal(archived(dir,'runtime.json').length,0);assert.equal(archived(dir,'app.lock').length,0);
});

test('a live lock protects both records when only the runtime record is stale',async t=>{
 const dir=fixture(t),fact=processFacts(process.pid),p=sleeper(t);write(dir,'app.lock',{pid:process.pid,start_seconds:fact.start_seconds,start_microseconds:fact.start_microseconds});write(dir,'runtime.json',{pid:p.pid},{old:true});
 await assert.rejects(acquireAppLock(dir),{code:'ALREADY_RUNNING'});
 assert.equal(archived(dir,'runtime.json').length,0);assert.equal(archived(dir,'app.lock').length,0);assert.equal(p.exitCode,null);
});

test('a live runtime protects both records when only the lock is stale',async t=>{
 const dir=fixture(t),fact=processFacts(process.pid),p=sleeper(t);
 write(dir,'runtime.json',{pid:process.pid,start_seconds:fact.start_seconds,start_microseconds:fact.start_microseconds});write(dir,'app.lock',{pid:p.pid},{old:true});
 await assert.rejects(acquireAppLock(dir),{code:'ALREADY_RUNNING'});
 assert.equal(archived(dir,'runtime.json').length,0);assert.equal(archived(dir,'app.lock').length,0);assert.equal(p.exitCode,null);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'app.lock'))).pid,p.pid);
});

test('legacy live records from this boot keep the existing protection',async t=>{
 const dir=fixture(t),p=sleeper(t);records(dir,p.pid);
 await assert.rejects(acquireAppLock(dir),{code:'ALREADY_RUNNING'});
 assert.equal(archived(dir,'runtime.json').length,0);assert.equal(archived(dir,'app.lock').length,0);assert.equal(p.exitCode,null);
});

test('an unreadable or malformed companion record is not cleared as stale',async t=>{
 const dir=fixture(t),p=sleeper(t);write(dir,'runtime.json',{pid:p.pid},{old:true});fs.writeFileSync(path.join(dir,'app.lock'),'{broken',{mode:0o600});
 await assert.rejects(acquireAppLock(dir),{code:'ALREADY_RUNNING'});
 assert.equal(fs.readFileSync(path.join(dir,'app.lock'),'utf8'),'{broken');assert.equal(archived(dir,'runtime.json').length,0);
});

test('a stale runtime and invalid lock are archived without contacting the old address',async t=>{
 const dir=fixture(t),p=sleeper(t);let requests=0;
 const server=http.createServer((_,response)=>{requests++;response.end('{}');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 write(dir,'runtime.json',{pid:p.pid,product:'ken-bridge',admin_token:'a'.repeat(64),ui_origin:`http://127.0.0.1:${server.address().port}`},{old:true});write(dir,'app.lock',{pid:0});
 await acquireAppLock(dir);
 assert.equal(requests,0);assert.equal(p.exitCode,null);assert.equal(archived(dir,'runtime.json').length,1);assert.equal(archived(dir,'app.lock').length,1);
});

test('two simultaneous starters do not move each other’s new lock',async t=>{
 const dir=fixture(t),p=sleeper(t);records(dir,p.pid,{}, {old:true});
 const moduleURL=new URL('../../app/v1/app-lock.mjs',import.meta.url).href;
 const source=`import {acquireAppLock} from ${JSON.stringify(moduleURL)};try{await acquireAppLock(process.argv[1]);console.log('WON');process.stdin.resume();}catch(e){console.log(e.code||'FAILED');}`;
 const children=[0,1].map(()=>spawn(process.execPath,['--input-type=module','-e',source,dir],{stdio:['pipe','pipe','pipe']}));
 t.after(()=>children.forEach(c=>{c.stdin.end();if(c.exitCode===null)c.kill('SIGTERM');}));
 const line=c=>new Promise((resolve,reject)=>{let out='';c.stdout.setEncoding('utf8');c.stdout.on('data',part=>{out+=part;if(out.includes('\n'))resolve(out.trim().split('\n')[0]);});c.once('error',reject);c.once('close',()=>{if(!out)reject(Error('starter closed before reporting'));});});
 const outcomes=await Promise.all(children.map(line));assert.deepEqual(outcomes.sort(),['ALREADY_RUNNING','WON']);
 const owner=JSON.parse(fs.readFileSync(path.join(dir,'app.lock'),'utf8'));assert.ok(children.some(c=>c.pid===owner.pid));assert.equal(archived(dir,'runtime.json').length,1);assert.equal(archived(dir,'app.lock').length,1);assert.equal(p.exitCode,null);
});


test('the real isolated service starts from both stale records and writes its exact identity',{timeout:15000},async t=>{
 const p=sleeper(t);const f=await startupFixture(t,{prepare:f=>{records(f.stateDir,p.pid,{}, {old:true});fs.writeFileSync(path.join(f.stateDir,'unrelated-fixture.txt'),'unchanged');}});
 const state=await f.request('/api/state');assert.equal(state.status,200);assert.equal(p.exitCode,null);
 const lock=JSON.parse(fs.readFileSync(path.join(f.stateDir,'app.lock'))),runtime=JSON.parse(fs.readFileSync(path.join(f.stateDir,'runtime.json'))),actual=processFacts(f.child.pid);
 assert.equal(lock.pid,f.child.pid);assert.equal(runtime.pid,f.child.pid);for(const key of ['start_seconds','start_microseconds']){assert.equal(lock[key],actual[key]);assert.equal(runtime[key],actual[key]);}
 assert.equal(archived(f.stateDir,'runtime.json').length,1);assert.equal(archived(f.stateDir,'app.lock').length,1);assert.equal(fs.readFileSync(path.join(f.stateDir,'unrelated-fixture.txt'),'utf8'),'unchanged');assert.match(f.logs(),/STALE_RUNTIME_RECORD/);
});

test('a normal isolated exit and restart keeps the same data without stale backups',{timeout:15000},async t=>{
 const first=await startupFixture(t);assert.equal((await first.request('/api/state')).status,200);
 await first.close();assert.equal(fs.existsSync(path.join(first.stateDir,'runtime.json')),false);assert.equal(fs.existsSync(path.join(first.stateDir,'app.lock')),false);
 const second=await startupFixture(t,{existingRoot:first.root});assert.equal((await second.request('/api/state')).status,200);
 assert.equal(archived(first.stateDir,'runtime.json').length,0);assert.equal(archived(first.stateDir,'app.lock').length,0);await second.close();
});
