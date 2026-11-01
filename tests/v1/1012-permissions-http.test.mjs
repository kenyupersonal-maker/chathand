import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDesktop,needsInterface} from '../../app/server.mjs';

async function fixture(t,{key=true}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1012-http-')),uiKey=key?'ca'.repeat(32):null;
  let installed=0,ready=false,installStatus='installed';
  const adminAccess={supported:()=>true,ready:()=>ready,async install(){installed++;if(installStatus==='installed')ready=true;return {status:installStatus};},uninstall(){ready=false;},uninstallForRevocation(){ready=false;return {status:'removed',absence_confirmed:ready===false};}};
  let app;
  t.after(async()=>{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  app=await createDesktop({stateDir:path.join(dir,'state'),defaultRoot:path.join(dir,'work'),uiKey,adminAccess});
  const post=async(route,body,{ui=false}={})=>{
    const response=await fetch(`http://127.0.0.1:${app.apiPort}${route}`,{method:'POST',headers:{Authorization:'Bearer '+app.adminToken,'Content-Type':'application/json',...(ui&&uiKey?{'X-ChatHand-UI':uiKey}:{})},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  return {app,post,get installed(){return installed;},set installStatus(s){installStatus=s;}};
}

test('1012 HTTP tier and seen require window credentials even when no window key was supplied', async t => {
  for(const key of [true,false]) {
    await t.test(key?'window key present':'window key missing',async t=>{
      const f=await fixture(t,{key});
      for(const [route,body] of [['/api/permissions/tier',{tier:'full'}],['/api/ui/seen',{key:'permissions_hint'}],['/api/setup/workspace',{}]]) {
        assert.equal(needsInterface(route,body),true);
        const r=await f.post(route,body);assert.equal(r.status,403);assert.equal(r.body.error.code,'UI_CONFIRM_REQUIRED');
      }
      assert.equal(f.installed,0);assert.notEqual(f.app.state.data.mode,'full');
    });
  }
});

test('1012 real local HTTP exposes full/light/custom, admin pending/done/cancelled, native statuses and persistent seen', async t => {
  const f=await fixture(t),{app}=f;
  app.state.data.setup_complete=true;app.state.save();
  let r=await f.post('/api/permissions/tier',{tier:'full'},{ui:true});assert.equal(r.status,200);assert.equal(r.body.permissions.tier,'full');assert.equal(f.installed,0);
  let s=await app.snapshot();assert.equal(s.settings.high_risk.admin,false);assert.equal(s.settings.admin_requested,true);assert.equal(s.settings.setup_complete,true);
  assert.deepEqual(s.setup.open_items.map(x=>[x.id,x.status]),[['admin','todo'],['desktop','todo'],['browser','todo']]);
  assert.equal(s.high_risk.items.filter(x=>x.group==='common').length,2);
  f.installStatus='cancelled';r=await f.post('/api/settings',{high_risk:{admin:true}},{ui:true});assert.equal(r.body.error.code,'ADMIN_SETUP_CANCELLED');
  assert.equal((await app.snapshot()).setup.open_items[0].status,'cancelled');assert.equal(app.state.data.high_risk.admin,false);
  f.installStatus='installed';r=await f.post('/api/settings',{high_risk:{admin:true}},{ui:true});assert.equal(r.status,200);
  await app.handle('/api/computer/heartbeat',{accessibility:true,screen_recording:true,needs_restart:true,step:'complete'});
  s=await app.snapshot();assert.equal(s.setup.open_items[0].status,'done');assert.equal(s.setup.open_items[1].status,'needs_restart');
  await app.handle('/api/computer/heartbeat',{accessibility:true,screen_recording:true,needs_restart:false,step:'complete'});
  assert.equal((await app.snapshot()).setup.open_items[1].status,'done');
  r=await f.post('/api/settings',{desktop_enabled:false},{ui:true});assert.equal(r.body.permissions.tier,'custom');
  r=await f.post('/api/permissions/tier',{tier:'light'},{ui:true});assert.equal(r.body.permissions.tier,'light');
  r=await f.post('/api/setup/workspace',{},{ui:true});assert.equal(r.body.confirmed,true);
  assert.equal((await app.snapshot()).setup.open_items[0].status,'done');
  for(let i=0;i<2;i++)assert.equal((await f.post('/api/ui/seen',{key:'permissions_hint'},{ui:true})).status,200);
  s=await app.snapshot();assert.deepEqual(s.ui.seen,['permissions_hint']);
  const disk=JSON.parse(fs.readFileSync(path.join(app.state.dir,'desktop.json'),'utf8'));assert.deepEqual(disk.ui_seen,['permissions_hint']);
  assert.ok(Object.keys(s.settings.high_risk).filter(x=>!['admin','autostart'].includes(x)).every(x=>s.settings.high_risk[x]===false));
});

test('1012 MCP blocked administrator and scheduled-task commands carry settings guidance without permission cards', async t => {
  const f=await fixture(t),{app}=f;let id=0,session='permissions-1012-initial';
  const call=async(name,args)=>{
    const r=await fetch(`http://127.0.0.1:${app.mcpPort}/mcp`,{method:'POST',headers:{'X-Ken-Bridge-Token':app.mcpToken,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args,_meta:{'openai/session':session}}})});
    return (await r.json()).result;
  };
  for(const [permission,program,args] of [['admin','sudo',['true']],['autostart','crontab',['-r']]]) {
     // Independent conversation fixtures; each task keeps its session for both attempts.
     session='permissions-1012-'+permission;
    const task=(await call('begin_task',{request_id:'1012-task-'+permission,title:'Fixture permissions',new_task:true})).structuredContent.task_id;assert.ok(task);
    for(let i=0;i<2;i++) {
      const r=await call('propose_command',{task_id:task,request_id:`1012-${permission}-${i}`,program,args});
      assert.equal(r.structuredContent.code,'HIGH_RISK_DISABLED');assert.equal(r.structuredContent.details.risk_id,permission);
      assert.equal(r.structuredContent.details.requires_local_user,true);assert.equal(r.structuredContent.details.blocked.confirm,null);assert.equal(r.structuredContent.details.blocked.answer_in_chat,false);assert.equal(r.structuredContent.recovery.automatic_retry,false);
    }
  }
  const snapshot=await app.snapshot(),events=snapshot.events.filter(x=>x.kind==='confirmation_required');
  assert.equal(events.length,0);assert.deepEqual(snapshot.confirmations,[]);assert.equal(f.installed,0);
  assert.equal(app.queue.list().length,0);
});
