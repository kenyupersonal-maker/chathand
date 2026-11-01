import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createUpgradeRunner} from './upgrade.mjs';
import {nativeFixture} from '../tests/support/native-fixtures.mjs';

// No installed App, real service, account or user state is used. Native checks
// invoke only the scope validator and helper refusals before any App launch.
const stateKeys=['CHATHAND_STATE_DIR','KEN_BRIDGE_STATE_DIR'];
const upgradeKey=key=>stateKeys.includes(key)||key.startsWith('CHATHAND_REHEARSAL_');
async function withEnvironment(values,work){
 const prior=Object.fromEntries(Object.entries(process.env).filter(([key])=>upgradeKey(key)));
 const clear=()=>{for(const key of Object.keys(process.env))if(upgradeKey(key))delete process.env[key];};
 clear();Object.assign(process.env,values);
 try{return await work();}finally{clear();Object.assign(process.env,prior);}
}
function fixture(t){
 const root=fs.mkdtempSync(path.join(fs.realpathSync('/tmp'),'chathand-1060-rehearsal-upgrade-env-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const f={root,home:path.join(root,'home'),stateDir:path.join(root,'state'),packageRoot:path.join(root,'package'),destination:path.join(root,'InstalledFixture.app'),backupRoot:path.join(root,'backups'),calls:[]};
 for(const dir of [f.home,f.stateDir,f.packageRoot,f.destination])fs.mkdirSync(dir,{mode:0o700});
 fs.writeFileSync(path.join(root,'.rehearsal-root.json'),JSON.stringify({format:1,purpose:'1060 isolated rehearsal'}),{mode:0o600});
 f.executeCommand=(program,args,options)=>{
  f.calls.push({program,args,options});
  if(args[0]==='info')return {status:0,stdout:JSON.stringify({kernel_scan:true,pids:[],identities:[]})};
  if(args[0]==='--self-check')return {status:0,stdout:JSON.stringify({version:'1.0.0-old'})};
  assert.equal(args[0],'start','only mocked lifecycle commands are permitted');
  return {status:0,stdout:'{}'};
 };
 f.runner=options=>createUpgradeRunner({...f,...options});
 f.rehearsal={CHATHAND_STATE_DIR:f.stateDir,KEN_BRIDGE_STATE_DIR:f.stateDir,CHATHAND_REHEARSAL_ROOT:root,CHATHAND_REHEARSAL_HOME:f.home};
 return f;
}
function ordinary(environment){
 for(const key of stateKeys)assert.equal(Object.hasOwn(environment,key),false,key+' must not reach an ordinary App launch');
 assert.equal(Object.keys(environment).some(key=>key.startsWith('CHATHAND_REHEARSAL_')),false);
}

for(const inherited of ['primary','legacy','both'])test('ordinary candidate and recovery starts remove '+inherited+' state overrides',async t=>{
 const f=fixture(t),environment={};
 if(inherited!=='legacy')environment.CHATHAND_STATE_DIR=f.stateDir;
 if(inherited!=='primary')environment.KEN_BRIDGE_STATE_DIR=path.join(f.root,'old-state-override');
 await withEnvironment(environment,async()=>{
  const runner=f.runner();
  await runner.hooks.start(f.destination,true);
  await runner.hooks.start(f.destination,false);
  assert.deepEqual(f.calls.map(call=>call.args),[['start',f.destination,'--upgrade-verification'],['start',f.destination]]);
  for(const call of f.calls)ordinary(call.options.env);
  for(const [key,value] of Object.entries(environment))assert.equal(process.env[key],value,'the installer keeps its own state selection');
 });
});

test('ordinary stop inspection and a start without overrides keep a clean helper environment',async t=>{
 const f=fixture(t);
 await withEnvironment({CHATHAND_STATE_DIR:f.stateDir,KEN_BRIDGE_STATE_DIR:f.stateDir},async()=>{
  await f.runner().hooks.stop(f.destination);
  assert.equal(f.calls.length,2);
  assert.ok(f.calls.every(call=>call.args[0]==='info'));
  for(const call of f.calls)ordinary(call.options.env);
 });
 f.calls.length=0;
 await withEnvironment({},async()=>{
  await f.runner().hooks.start(f.destination,false);
  ordinary(f.calls[0].options.env);
  assert.equal(f.calls[0].options.env.PATH,process.env.PATH);
 });
});

test('rollback resume starts the old App with a clean environment and verifies its mocked runtime',async t=>{
 const f=fixture(t);let started=false,checked=false;
 const executeCommand=(program,args,options)=>{
  const result=f.executeCommand(program,args,options);
  if(args[0]==='start'){
   ordinary(options.env);started=true;
   fs.writeFileSync(path.join(f.stateDir,'runtime.json'),JSON.stringify({pid:process.pid,ui_origin:'http://127.0.0.1:1',admin_token:'synthetic-upgrade-scope-token'}));
  }
  return result;
 };
 t.mock.method(globalThis,'fetch',async url=>{
  assert.equal(started,true);assert.equal(url,'http://127.0.0.1:1/api/state');checked=true;
  return {ok:true,json:async()=>({version:'1.0.0-old',lifecycle:{exit_requested:false}})};
 });
 await withEnvironment({CHATHAND_STATE_DIR:f.stateDir,KEN_BRIDGE_STATE_DIR:f.stateDir},async()=>{
  assert.deepEqual(await f.runner({executeCommand}).hooks.resume(f.destination),{resumed:true,version:'1.0.0-old'});
 });
 assert.equal(checked,true);
 assert.deepEqual(f.calls.map(call=>call.args[0]),['info','--self-check','start']);
});

test('explicit isolated fixture launches still bind both state aliases to the requested directory',async t=>{
 const f=fixture(t);
 await withEnvironment({CHATHAND_STATE_DIR:path.join(f.root,'stale')},async()=>{
  await f.runner({isolatedLaunch:true}).hooks.start(f.destination,true);
  for(const key of stateKeys)assert.equal(f.calls[0].options.env[key],f.stateDir);
 });
});

test('rehearsal CLI launches preserve their scope without the imported isolatedLaunch option',async t=>{
 const f=fixture(t);
 await withEnvironment(f.rehearsal,async()=>{
  const runner=f.runner();
  await runner.hooks.start(f.destination,true);await runner.hooks.start(f.destination,false);
  for(const {options:{env}} of f.calls){
   assert.equal(env.CHATHAND_STATE_DIR,f.stateDir);
   assert.equal(env.CHATHAND_REHEARSAL_ROOT,f.root);assert.equal(env.CHATHAND_REHEARSAL_HOME,f.home);
  }
 });
});

test('incomplete rehearsal markers reach native validation without falling back to an ordinary launch',async t=>{
 const f=fixture(t),partial={CHATHAND_STATE_DIR:f.stateDir,CHATHAND_REHEARSAL_HOME:f.home};
 await withEnvironment(partial,async()=>{
  await f.runner().hooks.start(f.destination,false);
  for(const [key,value] of Object.entries(partial))assert.equal(f.calls[0].options.env[key],value);
 });
});

test('compiled native scope rejects the leaked state, accepts fixed starts and retains rehearsal isolation',{skip:process.platform!=='darwin'},async t=>{
 const f=fixture(t),probe=nativeFixture('upgrade_launch_scope_fixture');
 const check=env=>{
  const result=spawnSync(probe,[f.stateDir,f.destination],{env,encoding:'utf8',timeout:5000});
  assert.equal(result.error,undefined);assert.equal(result.signal,null);
  return {status:result.status,scope:result.stdout.trim()};
 };
 const leaked={CHATHAND_STATE_DIR:f.stateDir};
 assert.deepEqual(check(leaked),{status:1,scope:'INSTANCE_ISOLATION_REQUIRED'});
 await withEnvironment(leaked,async()=>{
  const runner=f.runner();await runner.hooks.start(f.destination,true);await runner.hooks.start(f.destination,false);
  for(const call of f.calls)assert.deepEqual(check(call.options.env),{status:0,scope:'production'});
 });
 f.calls.length=0;
 await withEnvironment(f.rehearsal,async()=>{
  await f.runner().hooks.start(f.destination,true);
  assert.deepEqual(check(f.calls[0].options.env),{status:0,scope:'rehearsal'});
 });
 f.calls.length=0;
 await withEnvironment({CHATHAND_STATE_DIR:f.stateDir,CHATHAND_REHEARSAL_HOME:f.home},async()=>{
  await f.runner().hooks.start(f.destination,false);
  assert.deepEqual(check(f.calls[0].options.env),{status:1,scope:'INSTANCE_ISOLATION_REQUIRED'});
  const helper=spawnSync(nativeFixture('upgrade_control'),['start',f.destination],{env:f.calls[0].options.env,encoding:'utf8',timeout:5000});
  assert.equal(helper.error,undefined);assert.equal(helper.status,2);
  assert.deepEqual(JSON.parse(helper.stdout),{error:'REHEARSAL_ROOT_REQUIRED'});
 });
});
