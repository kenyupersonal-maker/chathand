import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DesktopState} from '../app/state.mjs';
import {ScopedStore,AccessPolicy} from '../app/v06/access.mjs';
import {permissionTier,applyPermissionTier,permissionsInfo,setupOpenItems,Blocks,gateCommand,capabilityOf,withScopeNote,markUISeen} from '../app/v1/permissions.mjs';
import {HIGH_RISK,highRiskError} from '../app/v1/high-risk.mjs';
import {cleanError} from '../engine/src/core.mjs';
import {interfaceAuthorized} from '../app/server.mjs';

test('1012 legacy switches derive tier without changing onboarding or granting access', () => {
  const cases = [
    [{mode:'full',high_risk:{admin:true,autostart:true}},'full'],
    [{mode:'full',admin_requested:true,high_risk:{autostart:true}},'full'],
    [{mode:'auto',desktop_enabled:false},'light'],
    [{mode:'auto'},'custom'],
    [{mode:'full',high_risk:{autostart:true}},'custom'],
    [{mode:'full',terminal_enabled:false,high_risk:{admin:true,autostart:true}},'custom'],
    [{mode:'full',high_risk:{admin:true,autostart:true,erase:true}},'full'], // 旧 erase 不是可开启能力
    [{mode:'full',high_risk:{admin:true,autostart:true,power:true}},'custom'],
    [{mode:'auto',desktop_enabled:false,high_risk:{admin:true}},'custom'],
  ];
  for (const [data,expected] of cases) {
    const state={data:{setup_complete:true,...data}},before=structuredClone(state.data);
    assert.equal(permissionTier(state),expected);assert.deepEqual(state.data,before);
  }
});

test('1012 tier application switches scope and revokes jobs, keeps danger off and admin pending', async t => {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1012-tier-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const state=new DesktopState(path.join(base,'state'),{defaultRoot:path.join(base,'initial')}),store=new ScopedStore(state.project().path,state.dir);
  let revoked=0,installed=0,removed=0;
  const queue={list:()=>[],cancelAll(){revoked++;}},policy=new AccessPolicy(state,store,queue);
  const adminAccess={supported:()=>true,ready:()=>true,install(){installed++;},uninstall(){removed++;}};
  state.data.setup_complete=true;state.data.high_risk={erase:true};
  const deps={state,store,policy,adminAccess,home:base,revokeAdmin:async()=>{if(state.data.high_risk?.admin===true)adminAccess.uninstall();state.data.high_risk={...state.data.high_risk,admin:false};return {ok:true};}};
  await applyPermissionTier(deps,{tier:'full'});
  assert.equal(installed,0);assert.equal(state.data.high_risk.admin,false);assert.equal(state.data.admin_requested,true);
  assert.equal(permissionTier(state),'full');assert.equal(store.accessMode,'full');
  assert.equal(state.data.setup_complete,true);
  assert.deepEqual(setupOpenItems(state).map(x=>x.id),['admin','desktop','browser']);
  assert.ok(HIGH_RISK.filter(r=>r.group==='danger').every(r=>!state.data.high_risk[r.id]));
  state.data.high_risk.admin=true;
  await applyPermissionTier(deps,{tier:'light'});
  assert.equal(removed,1);assert.equal(permissionTier(state),'light');assert.equal(store.accessMode,'auto');
  assert.equal(state.project().path,fs.realpathSync(path.join(base,'ChatHand 工作区')));assert.equal(state.data.desktop_enabled,false);
  assert.equal(state.data.setup_workspace_confirmed,false);assert.ok(revoked>=2);
  assert.deepEqual(setupOpenItems(state).map(x=>x.id),['folder','browser']);
  state.data.setup_workspace_confirmed=true;
  const customFolder=path.join(base,'chosen');fs.mkdirSync(customFolder);
  await applyPermissionTier(deps,{tier:'light',folder:customFolder});
  assert.equal(state.project().path,fs.realpathSync(customFolder));assert.equal(state.data.setup_workspace_confirmed,false);
  for(const args of [{tier:'custom'},{tier:'light',folder:'relative'},{tier:'light',folder:state.dir},{tier:'light',folder:'/'}]) {
    const before=structuredClone(state.data);await assert.rejects(()=>applyPermissionTier(deps,args));assert.deepEqual(state.data,before);
  }
});

test('1012 actual HTTP credential predicate rejects missing/forged UI credentials and accepts only its window key', () => {
  const expected='fixture-window-key';
  for(const route of ['/api/permissions/tier','/api/ui/seen','/api/setup/workspace','/api/mode','/api/settings']) {
    const body=route==='/api/settings'?{high_risk:{admin:true}}:{};
    for(const [provided,key,allowed] of [[undefined,expected,false],[null,expected,false],['forged',expected,false],[expected,null,false],[undefined,null,false],[expected,expected,true]]) {
      assert.equal(interfaceAuthorized(route,body,provided,key),allowed,route);
    }
  }
  assert.equal(interfaceAuthorized('/api/settings',{keep_awake:true},undefined,null),true);
});

test('1012 open items compute done, waiting, cancelled and restart plus both desktop grants', () => {
  const state={data:{mode:'full',admin_requested:true,high_risk:{autostart:true}},project:()=>({path:'/tmp/project'})};
  let items=setupOpenItems(state,{computer:{permissions:{accessibility:true,screen_recording:false}}});
  assert.equal(items[1].detail.accessibility,true);assert.equal(items[1].detail.screen_recording,false);assert.equal(items[1].status,'todo');
  state.data.setup_open_status={admin:'waiting'};assert.equal(setupOpenItems(state)[0].status,'waiting');
  state.data.setup_open_status.admin='cancelled';assert.equal(setupOpenItems(state)[0].status,'cancelled');
  state.data.high_risk.admin=true;
  items=setupOpenItems(state,{adminReady:true,computer:{permissions:{accessibility:true,screen_recording:true}},browser:{connected:true,installed:true}});
  assert.ok(items.every(x=>x.status==='done'));
  assert.equal(setupOpenItems(state,{computer:{permissions:{accessibility:true,screen_recording:true,needs_restart:true}}})[1].status,'needs_restart');
  assert.equal(setupOpenItems(state,{computer:{permissions:{step:'accessibility'}}})[1].status,'waiting');
});

test('1012 common errors tell AI to return to computer, never retry; notices dedupe across tasks and dismissal', () => {
  let now=1000;const events=[],blocks=new Blocks({now:()=>now,emit:(kind,data)=>events.push({kind,...data})});
  const state={data:{mode:'full'}},specs=[['admin','sudo',['true']],['autostart','crontab',['-r']]];
  for(const [id,program,args] of specs) {
    for(let i=0;i<3;i++)assert.throws(()=>gateCommand({state,blocks,task:{id:'task-'+i},spec:{program,args}}),e=>{
      const d=cleanError(e).details;assert.equal(d.group,'common');assert.equal(d.requires_local_user,true);assert.equal(d.retry,false);
      assert.ok(d.local_action.includes('开启位置：'+d.where_to_enable));
      assert.doesNotMatch(d.local_action,/确认卡|request_permission|task_status/);
      assert.equal(d.requires_computer_password,id==='admin');
      if(id==='admin')assert.ok(d.local_action.includes('电脑密码只能由你在 macOS 的密码框中输入'));
      assert.equal(d.blocked.confirm,null);assert.equal(d.blocked.answer_in_chat,false);
      assert.match(d.instructions_for_ai.join(' '),/不要(?:反复)?重?试/);return true;
    });
    assert.equal(events.filter(x=>x.kind==='permission_required'&&x.permission_id===id).length,1);
  }
  blocks.dismiss(blocks.list()[0].block_id);blocks.notifyPermission('admin');
  now+=599999;assert.equal(blocks.notifyPermission('admin'),false);now++;assert.equal(blocks.notifyPermission('admin'),true);
  assert.ok(events.filter(x=>x.kind==='permission_required').every(x=>x.page==='settings'&&x.section==='commands'&&!('command' in x)));
  blocks.adminAccess={supported:()=>true,ready:()=>false};state.data.high_risk={admin:true};
  assert.throws(()=>gateCommand({state,blocks,spec:{program:'sudo',args:['true']}}),e=>e.code==='ADMIN_SETUP_REQUIRED'&&e.details.requires_computer_password);
});

test('1012 additive permission guidance and persisted seen flags exclude credential text', () => {
  assert.deepEqual(HIGH_RISK.filter(x=>x.group==='common').map(x=>x.id),['admin','autostart']);
  assert.deepEqual(HIGH_RISK.filter(x=>x.group==='danger').map(x=>x.id),['bulk_delete','keychain','pipe_run','gatekeeper','bulk_perm','power','chatgpt_self']);
  assert.equal(highRiskError('erase').code,'NEVER_ALLOWED');
  for(const name of ['browser_batch','browser_read','browser_find'])assert.equal(capabilityOf(name),'browser');
  for(const name of ['computer_observe','computer_read','computer_batch'])assert.equal(capabilityOf(name),'desktop');
  const state={data:{mode:'auto'},project:()=>({path:'/tmp/工作区'}),save(){}};
  assert.equal(withScopeNote(state,{ttlMs:123,cacheScope:'private'}).details.scope_note,'文件范围是『工作区』：不要改动这个文件夹以外的文件；要下载、保存，存进这个文件夹。');
  assert.equal(withScopeNote(state,{ttlMs:123}).ttlMs,123);
  assert.equal(permissionsInfo(state).download_run_note,'先下载到文件、看过内容再运行。');
  for(let i=0;i<2;i++)markUISeen(state,'permissions_hint');assert.deepEqual(state.data.ui_seen,['permissions_hint']);
  assert.throws(()=>markUISeen(state,'bad key'),{code:'ARG_INVALID'});
  const synthetic='sk-synthetic_fixture_do_not_use';
  const error=highRiskError('admin',{command:'sudo echo '+synthetic}),clean=JSON.stringify(cleanError(error));
  assert.equal(clean.includes(synthetic),false);
  const b=new Blocks();b.record({kind:'high_risk',id:'admin',command:synthetic});assert.equal(JSON.stringify(b.list()).includes(synthetic),false);
});
