import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {installSelectedApp,selectedPackageAction} from '../../skills/chathand-setup/scripts/install-and-start.mjs';

const id1='11111111-1111-4111-8111-111111111111',id2='22222222-2222-4222-8222-222222222222';
const failed=code=>Object.assign(Error(code),{code});

// Only this temporary tree is touched. OS effects are replaced; no installed
// App, real runtime, credentials, native launcher or account is accessed.
function fixture(t,{existing=true,build='1084',fault,connected=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-install-flow-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source.app'),target=path.join(root,'target.app');
  const old=path.join(root,'backup.app'),stage=path.join(root,'stage.app'),bad=path.join(root,'failed.app');
  const data=path.join(root,'user-data');fs.mkdirSync(data);fs.writeFileSync(path.join(data,'keep'),'unchanged');
  const write=(app,value)=>{fs.mkdirSync(app);fs.writeFileSync(path.join(app,'identity.json'),JSON.stringify(value));};
  write(source,{build,build_id:id2});if(existing)write(target,{build:'1085',build_id:id1});
  const events=[];let running=existing?'old':null;
  const record=step=>{events.push(step);if(fault===step)throw failed('SIMULATED_'+step.toUpperCase());};
  const identity=app=>JSON.parse(fs.readFileSync(path.join(app,'identity.json'),'utf8'));
  const ops={
    async inspect(app,{optional=false}={}){if(optional&&!fs.existsSync(app))return null;return {path:app,...identity(app)};},
    async stage(){record('stage');fs.cpSync(source,stage,{recursive:true});return stage;},
    async discardStage(app){fs.rmSync(app,{recursive:true,force:true});},
    async stop(){record('stop');running=null;},
    async backup(){record('backup');if(!fs.existsSync(target))return null;fs.renameSync(target,old);return old;},
    async place(app){record('place');assert.equal(running,null);fs.renameSync(app,target);},
    async verify(){record('verify');assert.ok(fs.existsSync(target));},
    async installSkill(){record('skill');},
    async start(){record('start');running=identity(target).build_id;},
    async doctor(){record('doctor');assert.equal(running,id2);return {connected,selected_route:'openai'};},
    async eject(){record('eject');},
    async retainFailed(){record('retain');fs.renameSync(target,bad);return bad;},
    async restore(){record('restore');fs.renameSync(old,target);}
  };
  return {source,target,old,bad,ops,events,identity,run:()=>installSelectedApp({source,target},ops),
    preserved:()=>assert.equal(fs.readFileSync(path.join(data,'keep'),'utf8'),'unchanged'),running:()=>running};
}

test('selected package installs regardless of public build; only the same package can skip copying',()=>{
  const incoming={path:'/source.app',build:'1084',build_id:id2};
  assert.equal(selectedPackageAction(incoming,{path:'/target.app',build:'1084',build_id:id1}),'install');
  assert.equal(selectedPackageAction(incoming,{path:'/target.app',build:'1085',build_id:id1}),'install');
  assert.equal(selectedPackageAction({...incoming,build_id:null},{path:'/target.app',build:'1084',build_id:null}),'install');
  assert.equal(selectedPackageAction(incoming,{path:'/target.app',build:'1084',build_id:id2}),'preserve');
});

test('fresh install reaches local readiness with no connection and returns the continuation path',async t=>{
  const f=fixture(t,{existing:false}),result=await f.run();
  assert.equal(result.status,'ready');assert.equal(result.next_action,'continue_setup');
  assert.equal(result.doctor.connected,false);assert.equal(result.setup_complete,false);
  assert.equal(result.app_path,f.target);assert.ok(result.skill_path.startsWith(f.target+'/'));
  assert.ok(f.events.indexOf('stop')<f.events.indexOf('place'));
  assert.ok(f.events.indexOf('verify')<f.events.indexOf('start'));
  assert.ok(f.events.indexOf('doctor')<f.events.indexOf('eject'));f.preserved();
});

test('a selected older package installs, preserves data, and a repeat does not back it up again',async t=>{
  const f=fixture(t),result=await f.run();
  assert.equal(result.action,'install');assert.equal(f.identity(f.target).build,'1084');
  assert.equal(f.identity(f.old).build,'1085');assert.equal(f.running(),id2);f.preserved();
  f.events.length=0;const again=await f.run();
  assert.equal(again.action,'preserve');assert.ok(!f.events.includes('backup'));f.preserved();
});

test('a quit failure leaves the installed files intact and exposes a continuation diagnosis',async t=>{
  const f=fixture(t,{fault:'stop'});
  await assert.rejects(f.run(),error=>{
    assert.equal(error.install_result.phase,'quit');
    assert.equal(error.install_result.next_action,'diagnose_and_resume');return true;
  });
  assert.equal(f.identity(f.target).build_id,id1);assert.equal(f.running(),'old');
  assert.ok(!fs.existsSync(f.old));f.preserved();
});

test('a failed new startup restores the previous App without touching saved data',async t=>{
  const f=fixture(t);const start=f.ops.start;let first=true;
  f.ops.start=async()=>{if(first){first=false;throw failed('APP_LAUNCH_FAILED');}return start();};
  await assert.rejects(f.run(),error=>{
    assert.equal(error.install_result.code,'APP_LAUNCH_FAILED');
    assert.equal(error.install_result.restored_previous,true);
    assert.equal(error.install_result.failed_app_path,f.bad);return true;
  });
  assert.equal(f.identity(f.target).build_id,id1);assert.equal(f.running(),id1);
  assert.equal(f.identity(f.bad).build_id,id2);f.preserved();
});

test('skill registration and disk eject failures do not undo a running verified installation',async t=>{
  const f=fixture(t);
  f.ops.installSkill=async()=>{throw failed('EACCES');};
  f.ops.eject=async()=>{throw failed('EBUSY');};
  const result=await f.run();
  assert.equal(result.status,'ready');assert.equal(f.running(),id2);
  assert.deepEqual(result.warnings.map(w=>w.next_action),['read_bundled_skill','eject_later']);
  assert.ok(!f.events.includes('restore'));f.preserved();
});
