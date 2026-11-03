import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {startupFixture} from '../support/startup-five-fixture.mjs';

const desktop=f=>path.join(f.stateDir,'desktop.json');
const stamp=file=>{const s=fs.statSync(file);return {bytes:fs.readFileSync(file),ino:s.ino,mode:s.mode,mtime:s.mtimeMs};};

test('actual CLI opens generic version/schema business fields without treating them as a newer format',async t=>{
 const f=await startupFixture(t,{prepare:f=>{const file=desktop(f),v=JSON.parse(fs.readFileSync(file));Object.assign(v,{version:999,schema:'business-schema',format:'foreign-v99',unknown:{preserve:true}});fs.writeFileSync(file,JSON.stringify(v));}});
 const state=(await f.request('/api/state')).body;
 assert.deepEqual(state.startup_notices,[]);assert.equal(state.settings.version,999);assert.equal(state.settings.schema,'business-schema');
 const saved=JSON.parse(fs.readFileSync(desktop(f)));assert.equal(saved.format,'foreign-v99');assert.deepEqual(saved.unknown,{preserve:true});
});

for(const minimum of [null,'9.9.9'])test('actual CLI opens explicit newer data with protected original bytes and a usable version notice: '+minimum,async t=>{
 let before;
 const f=await startupFixture(t,{prepare:f=>{fs.writeFileSync(desktop(f),JSON.stringify({format:'chathand-desktop-v2',version:2,schema:2,...(minimum?{min_app_version:minimum}:{}),payload:{private_original:'SYNTHETIC_ORIGINAL'}})+'\n');before=stamp(desktop(f));}});
 const state=(await f.request('/api/state')).body;
 assert.deepEqual(state.startup_notices,[{kind:'newer',format_version:'2',min_app_version:minimum}]);
 for(const key of ['access_enabled','auto_connect','auto_update','terminal_enabled','browser_enabled','desktop_enabled'])assert.equal(state.settings[key],false,key);
 assert.equal((await f.request('/api/settings',{notifications:false})).status,200);
 assert.equal((await f.request('/api/state')).body.settings.notifications,false);
 assert.deepEqual(stamp(desktop(f)),before);assert.doesNotMatch(f.logs(),/SYNTHETIC_ORIGINAL/);
 assert.equal(fs.readdirSync(f.stateDir).some(name=>name.startsWith('desktop.unreadable-')),false);
 await f.close();assert.deepEqual(stamp(desktop(f)),before);
});

test('actual CLI opens with a missing workspace, prompts at file entry, and creates only after the requested recovery',async t=>{
 let preserved;
 const f=await startupFixture(t,{prepare:f=>{fs.writeFileSync(path.join(f.work,'project.txt'),'ORIGINAL_PROJECT');preserved=path.join(f.home,'preserved-project');fs.renameSync(f.work,preserved);}});
 assert.equal((await f.request('/api/state')).body.project.workspace.status,'unchecked');assert.equal(fs.existsSync(f.work),false);
 const checked=await f.request('/api/workspace/check',{});assert.equal(checked.body.project.workspace.status,'missing');assert.equal(checked.body.project.workspace.can_recreate,true);assert.equal(fs.existsSync(f.work),false);
 assert.equal((await f.request('/api/workspace/recreate',{})).status,200);assert.equal(fs.statSync(f.work).isDirectory(),true);assert.deepEqual(fs.readdirSync(f.work),[]);assert.equal(fs.readFileSync(path.join(preserved,'project.txt'),'utf8'),'ORIGINAL_PROJECT');
});

for(const [label,bytes]of [['JSON',Buffer.from('{"broken":')],['UTF-8',Buffer.from([0xff,0xfe,0x00])],['shape',Buffer.from('{"projects":null,"conversations":false}')]])test('actual CLI preserves only the corrupt settings file and opens safe defaults: '+label,async t=>{
 const f=await startupFixture(t,{prepare:f=>{fs.writeFileSync(desktop(f),bytes,{mode:0o600});fs.writeFileSync(path.join(f.work,'untouched.txt'),'PROJECT_UNTOUCHED');fs.writeFileSync(path.join(f.stateDir,'unrelated.json'),'UNRELATED_UNTOUCHED');}});
 const state=(await f.request('/api/state')).body;assert.equal(state.settings.settings_recovery_notice,true);
 for(const key of ['access_enabled','auto_connect','auto_update','terminal_enabled','browser_enabled','desktop_enabled'])assert.equal(state.settings[key],false,key);
 const backups=fs.readdirSync(f.stateDir).filter(name=>name.startsWith('desktop.unreadable-'));assert.equal(backups.length,1);assert.deepEqual(fs.readFileSync(path.join(f.stateDir,backups[0])),bytes);
 assert.equal(fs.readFileSync(path.join(f.work,'untouched.txt'),'utf8'),'PROJECT_UNTOUCHED');assert.equal(fs.readFileSync(path.join(f.stateDir,'unrelated.json'),'utf8'),'UNRELATED_UNTOUCHED');assert.equal(state.project.workspace_create_pending,undefined);
 assert.equal((await f.request('/api/settings/recovery/dismiss',{})).status,200);assert.equal((await f.request('/api/state')).body.settings.settings_recovery_notice,false);
});

for(const contents of ['{broken',JSON.stringify({pid:0}),JSON.stringify({pid:'not-a-pid'})])test('actual CLI treats malformed app.lock as stale when no recorded service is alive: '+contents,async t=>{
 const f=await startupFixture(t,{prepare:f=>fs.writeFileSync(path.join(f.stateDir,'app.lock'),contents)});
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir,'app.lock'))).pid,f.child.pid);assert.deepEqual((await f.request('/api/state')).body.startup_notices,[{kind:'lock_recovered'}]);
});

function staleRuntime(f,port){
 fs.writeFileSync(path.join(f.stateDir,'app.lock'),'{broken');
 fs.writeFileSync(path.join(f.stateDir,'runtime.json'),JSON.stringify({product:'ken-bridge',pid:process.pid,version:'synthetic-version',ui_origin:'http://127.0.0.1:'+port,admin_token:'c'.repeat(64)}));
}

test('actual CLI opens through a bad lock when a recycled live PID has a closed loopback endpoint',async t=>{
 const endpoint=net.createServer();await new Promise(resolve=>endpoint.listen(0,'127.0.0.1',resolve));
 const port=endpoint.address().port;await new Promise((resolve,reject)=>endpoint.close(error=>error?reject(error):resolve()));
 const f=await startupFixture(t,{prepare:f=>staleRuntime(f,port)});
 assert.equal((await f.request('/api/state')).status,200);
 assert.deepEqual((await f.request('/api/state')).body.startup_notices,[{kind:'lock_recovered'}]);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir,'app.lock'))).pid,f.child.pid);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir,'runtime.json'))).pid,f.child.pid);
});

test('actual CLI keeps the bad-lock protection when a connected endpoint has an uncertain response timeout',async t=>{
 const sockets=new Set();let connected=false,requestReceived=false;
 const endpoint=net.createServer(socket=>{connected=true;sockets.add(socket);socket.once('data',()=>{requestReceived=true;});socket.once('close',()=>sockets.delete(socket));});
 await new Promise(resolve=>endpoint.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>endpoint.close(resolve));});
 const port=endpoint.address().port;
 const f=await startupFixture(t,{expectFailure:true,prepare:f=>staleRuntime(f,port)});
 assert.equal(connected,true);assert.equal(requestReceived,true);
 assert.deepEqual(await f.exit,{status:72,signal:null});assert.match(f.logs(),/STARTUP_ALREADY_RUNNING/);
 assert.equal(fs.readFileSync(path.join(f.stateDir,'app.lock'),'utf8'),'{broken');
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir,'runtime.json'))).pid,process.pid);
});

test('a real service with a corrupt app.lock still rejects a second service using the same data',async t=>{
 const first=await startupFixture(t),runtime=stamp(path.join(first.stateDir,'runtime.json'));
 fs.writeFileSync(path.join(first.stateDir,'app.lock'),'{broken');
 const second=await startupFixture(t,{existingRoot:first.root,expectFailure:true});
 assert.deepEqual(await second.exit,{status:72,signal:null});assert.match(second.logs(),/STARTUP_ALREADY_RUNNING/);assert.deepEqual(stamp(path.join(first.stateDir,'runtime.json')),runtime);assert.equal((await first.request('/api/state')).status,200);
});

test('a valid lock belonging to a real service still rejects a second same-data service',async t=>{
 const first=await startupFixture(t),second=await startupFixture(t,{existingRoot:first.root,expectFailure:true});
 assert.deepEqual(await second.exit,{status:72,signal:null});assert.match(second.logs(),/STARTUP_ALREADY_RUNNING/);assert.equal((await first.request('/api/state')).status,200);
});
