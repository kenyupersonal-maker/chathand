// 1026 Pro: regression tests included in scripts/test-all.mjs's release groups.
// Every machine-facing admin effect is trapped BEFORE a desktop is created.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
import {AdminAccess,NoopAdminAccess,createDefaultAdminAccess,HELPER_OK} from '../../app/v1/admin-command.mjs';

const blocked = {code:'ADMIN_TEST_CONTEXT_BLOCKED'};

function systemTripwires(realHome) {
  const calls = [], restore = [];
  const protectedRoots = ['/etc/sudoers','/private/etc/sudoers','/etc/sudoers.d','/private/etc/sudoers.d',
    '/Library/PrivilegedHelperTools',path.join(realHome,'Library/Application Support/ChatHand')];
  const normalized = value => {
    if (value instanceof URL && value.protocol === 'file:') value = fileURLToPath(value);
    if (Buffer.isBuffer(value)) value = value.toString();
    return typeof value === 'string' ? path.resolve(value) : null;
  };
  const protectedPath = value => {const p=normalized(value);return p && protectedRoots.some(root=>p===root || p.startsWith(root+path.sep));};
  const denied = (method,args) => {calls.push({method,args:args.map(String)});throw Error('TEST_FORBIDDEN_SYSTEM_EFFECT: '+method);};
  for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync']) {
    const original=childProcess[name];
    childProcess[name]=function(...args) {
      const command=[args[0],...(Array.isArray(args[1])?args[1]:[])].join(' ');
      if (/(?:^|[\s/])(?:sudo|osascript)(?=\s|$)/.test(command)) return denied('child_process.'+name,args);
      return Reflect.apply(original,this,args);
    };
    restore.push(()=>{childProcess[name]=original;});
  }
  for (const name of ['statSync','lstatSync','existsSync','realpathSync','readFileSync','writeFileSync','openSync',
    'accessSync','readdirSync','rmSync','unlinkSync','renameSync','copyFileSync','cpSync','chmodSync','chownSync']) {
    const original=fs[name], dual=['renameSync','copyFileSync','cpSync'].includes(name);
    const wrapper=function(...args) {
      if (protectedPath(args[0]) || dual && protectedPath(args[1])) return denied('fs.'+name,args.slice(0,dual?2:1));
      return Reflect.apply(original,this,args);
    };
    if (name==='realpathSync' && original.native) wrapper.native=function(...args) {
      if(protectedPath(args[0]))return denied('fs.realpathSync.native',args.slice(0,1));
      return Reflect.apply(original.native,original,args);
    };
    fs[name]=wrapper;restore.push(()=>{fs[name]=original;});
  }
  syncBuiltinESMExports();
  return {calls,restore(){for(const fn of restore.reverse())fn();syncBuiltinESMExports();}};
}

async function fixture(action,{withoutTestContext=false}={}) {
  assert.ok(process.env.NODE_TEST_CONTEXT,'Run this file with node --test, never as a live app.');
  const realHome=os.homedir(),root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-admin-isolation-')));
  const keys=['HOME','USERPROFILE','LOCALAPPDATA','CHATHAND_STATE_DIR','KEN_BRIDGE_STATE_DIR','NODE_TEST_CONTEXT'];
  const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  const home=path.join(root,'home');fs.mkdirSync(home);
  process.env.HOME=home;process.env.USERPROFILE=home;process.env.LOCALAPPDATA=path.join(home,'AppData','Local');
  delete process.env.CHATHAND_STATE_DIR;delete process.env.KEN_BRIDGE_STATE_DIR;
  if(withoutTestContext)delete process.env.NODE_TEST_CONTEXT;
  const trip=systemTripwires(realHome);
  try {return await action({root,home,trip});}
  finally {
    trip.restore();
    for(const key of keys)if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];
    fs.rmSync(root,{recursive:true,force:true});
  }
}

function desktopDeps(root) {
  return {
    currentAppPath:path.join(root,'ChatHand.app'),computerName:()=> 'Admin isolation fixture',
    tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),
    updaterFactory:()=>({snapshot:()=>({status:'unknown',install:{state:'idle'}}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})
  };
}

const fakeEffects = calls => ({
  platform:'darwin',user:'fixture',
  stat:()=>({uid:0,mode:0o100755}),
  runSync:(program,args)=>{calls.push([program,...args]);return {status:0,stdout:args.includes('--check')?HELPER_OK+'\n':'',stderr:''};},
  run:async(program,args)=>{calls.push([program,...args]);return {status:0,stdout:'chathand-admin-installed\n',stderr:''};}
});

test('1026 Pro: test defaults are inert, including explicit isolated=false',async()=>fixture(async({root,trip})=>{
  const access=createDefaultAdminAccess({stateDir:path.join(root,'state'),isolated:false});
  assert.ok(access instanceof NoopAdminAccess);assert.equal(access.supported(),false);assert.equal(access.ready({fresh:true}),false);
  assert.equal((await access.install()).status,'blocked');assert.equal(access.uninstall().status,'blocked');
  assert.deepEqual(trip.calls,[],'No sudo/osascript or protected filesystem access is permitted.');
}));

test('1026 Pro: direct real AdminAccess refuses effects and ignores a cached ready result',async()=>fixture(async({trip})=>{
  const access=new AdminAccess({platform:'darwin'});access.cache={at:Date.now(),ready:true};
  assert.equal(access.ready(),false);assert.equal(access.lastReason,'test_context_blocked');
  await assert.rejects(()=>access.install(),blocked);assert.throws(()=>access.uninstall(),blocked);
  assert.deepEqual(trip.calls,[]);
}));

test('1026 Pro: partial fake effects and boolean escape flags do not unlock real defaults',async()=>fixture(async({trip})=>{
  const invoked=[];
  for(const options of [{runSync:()=>invoked.push('sync')},{stat:()=>invoked.push('stat')},
    {run:async()=>invoked.push('async')},{allowInTests:true,platform:'darwin'},
    {...fakeEffects(invoked),runSync:childProcess.spawnSync},{...fakeEffects(invoked),stat:fs.statSync}]) {
    const access=new AdminAccess(options);
    assert.equal(access.ready({fresh:true}),false);await assert.rejects(()=>access.install(),blocked);assert.throws(()=>access.uninstall(),blocked);
  }
  assert.deepEqual(invoked,[]);assert.deepEqual(trip.calls,[]);
}));

test('1026 Pro: complete explicit fake effects still exercise normal admin semantics',async()=>fixture(async({trip})=>{
  const invoked=[],access=new AdminAccess(fakeEffects(invoked));
  assert.equal(access.ready(),true);assert.deepEqual(await access.install(),{status:'installed'});
  assert.deepEqual(access.uninstall(),{status:'removed'});assert.ok(invoked.some(call=>call.includes('--uninstall')));
  assert.deepEqual(trip.calls,[],'Fake functions recorded the request; no process was launched.');
}));

test('1026 Pro: replacing one injected effect cannot fall back to the real executor',async()=>fixture(async({trip})=>{
  const access=new AdminAccess(fakeEffects([]));access.runSync=childProcess.spawnSync;
  assert.equal(access.ready(),false);await assert.rejects(()=>access.install(),blocked);assert.throws(()=>access.uninstall(),blocked);
  assert.deepEqual(trip.calls,[]);
}));

test('1026 Pro: hard gate is sticky and also notices a test context added later',async()=>fixture(async({trip})=>{
  const initial=process.env.NODE_TEST_CONTEXT,createdInTest=new AdminAccess({platform:'darwin'});
  delete process.env.NODE_TEST_CONTEXT;
  try {
    assert.equal(createdInTest.ready(),false);await assert.rejects(()=>createdInTest.install(),blocked);assert.throws(()=>createdInTest.uninstall(),blocked);
    const createdBeforeTest=new AdminAccess({platform:'darwin'});process.env.NODE_TEST_CONTEXT=initial;
    assert.equal(createdBeforeTest.ready(),false);await assert.rejects(()=>createdBeforeTest.install(),blocked);assert.throws(()=>createdBeforeTest.uninstall(),blocked);
  } finally {process.env.NODE_TEST_CONTEXT=initial;}
  assert.deepEqual(trip.calls,[]);
}));

test('1026 Pro: without NODE_TEST_CONTEXT only the canonical daily state gets real capability',async()=>fixture(async({root,home,trip})=>{
  const daily=process.platform==='win32'?path.join(process.env.LOCALAPPDATA,'ChatHand','data'):path.join(home,'Library/Application Support/ChatHand/data');
  const other=path.join(root,'other-state');fs.mkdirSync(daily,{recursive:true});fs.mkdirSync(other);
  fs.writeFileSync(path.join(daily,'desktop.json'),'{}');
  assert.ok(createDefaultAdminAccess({stateDir:daily}) instanceof AdminAccess,'Construction only; never invoke machine effects.');
  assert.ok(createDefaultAdminAccess({stateDir:other}) instanceof NoopAdminAccess);
  assert.ok(createDefaultAdminAccess({stateDir:daily,isolated:true}) instanceof NoopAdminAccess);
  assert.ok(createDefaultAdminAccess() instanceof NoopAdminAccess);
  assert.ok(createDefaultAdminAccess({stateDir:'relative'}) instanceof NoopAdminAccess);
  assert.ok(createDefaultAdminAccess({stateDir:path.join(root,'missing')}) instanceof NoopAdminAccess);
  if(process.platform!=='win32') {
    const alias=path.join(root,'daily-alias');fs.symlinkSync(daily,alias,'dir');
    assert.ok(createDefaultAdminAccess({stateDir:alias}) instanceof AdminAccess);
  }
  assert.deepEqual(trip.calls,[]);
},{withoutTestContext:true}));

test('1026 Pro: standalone SandboxQueue also uses an inert default',async()=>fixture(async({root,trip})=>{
  const {SandboxQueue}=await import('../../app/v06/terminal.mjs');
  const queue=Object.create(SandboxQueue.prototype);queue.store={stateDir:path.join(root,'state')};
  assert.ok(queue.adminAccess instanceof NoopAdminAccess);assert.strictEqual(queue.adminAccess,queue.adminAccess);
  const explicit={supported:()=>false,ready:()=>false};queue.adminAccess=explicit;assert.strictEqual(queue.adminAccess,explicit);
  assert.deepEqual(trip.calls,[]);
}));

for(const enabled of [false,true])test('1026 Pro: createDesktop without adminAccess makes zero sudo calls; saved admin='+enabled,async()=>fixture(async({root,trip})=>{
  const {createDesktop}=await import('../../app/server.mjs');const {DesktopState}=await import('../../app/state.mjs');
  const stateDir=path.join(root,'state'),work=path.join(root,'work');const saved=new DesktopState(stateDir,{defaultRoot:work});
  saved.data.high_risk={admin:enabled};saved.data.admin_requested=enabled;saved.save();
  let app;
  try {
    // Intentionally NO adminAccess: this is the production-default regression.
    app=await createDesktop({stateDir,defaultRoot:work,clientDeps:desktopDeps(root)});
    assert.ok(app.queue.adminAccess instanceof NoopAdminAccess);assert.strictEqual(app.tools.blocks.adminAccess,app.queue.adminAccess);
    assert.equal(app.queue.adminAccess.ready({fresh:true}),false);await app.handle('/api/upgrade/commit',{});
  } finally {await app?.close();}
  assert.deepEqual(trip.calls,[],'Creating, reconciling and closing a test desktop must never reach sudo or the real helper.');
}));

test('1026 Pro: isolated service without NODE_TEST_CONTEXT remains inert',async()=>fixture(async({root,trip})=>{
  const {createDesktop}=await import('../../app/server.mjs');let app;
  try {
    app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:path.join(root,'work'),clientDeps:desktopDeps(root)});
    assert.ok(app.queue.adminAccess instanceof NoopAdminAccess);assert.equal(app.queue.adminAccess.ready(),false);
    await app.handle('/api/upgrade/commit',{});
  } finally {await app?.close();}
  assert.deepEqual(trip.calls,[]);
},{withoutTestContext:true}));

test('1026 Pro: an explicitly supplied fake is preserved and records the existing reconciliation reason',async()=>fixture(async({root,trip})=>{
  const {createDesktop}=await import('../../app/server.mjs');let removed=0,ready=true,app;
  const fake={supported:()=>true,ready:()=>ready,async install(){return {status:'installed'};},uninstall(){removed++;ready=false;return {status:'removed'};}};
  try {
    const stateDir=path.join(root,'state');
    app=await createDesktop({stateDir,defaultRoot:path.join(root,'work'),adminAccess:fake,clientDeps:desktopDeps(root)});
    assert.strictEqual(app.queue.adminAccess,fake);assert.equal(removed,1);
    const events=JSON.parse(fs.readFileSync(path.join(stateDir,'admin-events.json'),'utf8'));
    assert.equal(events.at(-1).reason,'startup_reconcile');assert.equal(events.at(-1).result,'removed');
  } finally {await app?.close();}
  assert.deepEqual(trip.calls,[]);
}));
