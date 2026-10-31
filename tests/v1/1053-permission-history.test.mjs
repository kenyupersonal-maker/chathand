import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {PermissionHistory,bindPermissionHistory,permissionHistoryFor} from '../../app/v1/permission-history.mjs';
import {TOOLS} from '../../app/tools.mjs';
import {installUiTextContext} from '../support/ui-text-context.mjs';
import {desktop} from './1052-a-fixture.mjs';

test('D7 private log appends history, survives restart, keeps last200 and reads snapshots from memory',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'d7-log-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const h=new PermissionHistory(dir);for(let i=0;i<205;i++)assert.equal(h.append({action:'tier',tier:i%2?'full':'light',via:'home'}),true);
 assert.equal(h.rows.length,200);assert.equal(fs.readFileSync(h.file,'utf8').trim().split('\n').length,200);assert.equal(fs.statSync(h.file).mode&0o777,0o600);
 const read=new PermissionHistory(dir);assert.deepEqual(read.rows,h.rows);fs.renameSync(h.file,h.file+'.saved');assert.equal(read.view().length,200);
});

test('D7 real server logs only successful revokes and preset changes; settings and invalid confirmations do not create grant history',async t=>{
 const f=await desktop(t),a=f.app;
 assert.equal(TOOLS.some(tool=>tool.name==='request_permission'),false,'the retired permission-card tool is absent');
 assert.deepEqual((await a.snapshot()).permissions.history,[]);
 await a.handle('/api/settings',{browser_enabled:false});assert.deepEqual((await a.snapshot()).permissions.history,[]);
 await a.handle('/api/settings',{browser_enabled:true});assert.deepEqual((await a.snapshot()).permissions.history,[],'changing the switch does not fabricate a grant event');
 await assert.rejects(a.handle('/api/confirm/answer',{id:'old-card',scope:'always',via:'window',input:{human:true}}),{code:'ARG_INVALID'});
 assert.deepEqual((await a.snapshot()).permissions.history,[],'a rejected stale-card answer adds no history');
 const revoked=await a.handle('/api/permissions/revoke',{gate:'capability',id:'browser'});assert.equal(revoked.ok,true);assert.equal(a.state.data.browser_enabled,false);
 let rows=(await a.snapshot()).permissions.history;assert.equal(rows.length,1);assert.equal(rows[0].action,'revoke');assert.equal(rows[0].gate,'capability');assert.equal(rows[0].id,'browser');assert.equal(rows[0].active,false);
 await assert.rejects(a.handle('/api/permissions/revoke',{gate:'capability',id:'invented'}),{code:'ARG_INVALID'});assert.equal((await a.snapshot()).permissions.history.length,1,'a failed revoke adds no event');
 const preset=await a.handle('/api/permissions/tier',{tier:'full',source:'home'});rows=preset.permissions.history;assert.equal(rows.length,2);assert.equal(rows[0].action,'tier');assert.equal(rows[0].tier,'full');assert.equal(rows[0].via,'home');assert.equal(rows.filter(x=>x.action==='tier').length,1);
 const save=a.state.save;a.state.save=()=>{throw Error('synthetic persistence failure');};try{await assert.rejects(a.handle('/api/permissions/revoke',{gate:'capability',id:'browser'}),e=>e.code==='REVOCATION_PERSISTENCE_FAILED'&&e.applied===true&&e.do_not_replay===true);}finally{a.state.save=save;}
 assert.equal(a.state.data.browser_enabled,false,'failed persistence cannot restore revoked authority');assert.equal((await a.snapshot()).permissions.history.length,2,'unconfirmed persistence creates no successful history event');assert.equal(JSON.stringify(a.state.data).includes('permission-history'),false);
});

test('D7 persisted synthetic grant history groups by date, links only its saved conversation and has settings arrows without revoke controls',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'d7-view-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const history=new PermissionHistory(dir);
 const origin=Date.now()-1000;assert.equal(history.append({action:'grant',gate:'capability',id:'browser',name:'浏览器控制',scope:'always',origin_since:origin,via:'chat',conversation:{title:'Bound fixture',url:'https://chatgpt.com/c/fixture'}}),true);
 assert.equal(history.append({action:'revoke',gate:'capability',id:'terminal',name:'命令执行',scope:'always',origin_since:null,via:'window'}),true);history.rows[0].at=Date.now()-86400000;
 const snapshot={permissions:{history:history.view({allowed:[{gate:'capability',id:'browser'}],origins:{'capability:browser':{since:origin}},tier:'light'}),history_status:history.status()}};
 assert.equal(snapshot.permissions.history[1].active,true);assert.equal(snapshot.permissions.history[0].active,false);
 const source=fs.readFileSync(new URL('../../ui/app.js',import.meta.url),'utf8'),start=source.indexOf('function pgAlwaysAllowed()'),end=source.indexOf('\n/* 1052',start),box={S:snapshot,E:x=>String(x??''),ibtn:(_i,label,action,id)=>`<button data-action="${action}" data-id="${id}">${label}</button>`};
 vm.createContext(box);installUiTextContext(box);vm.runInContext(source.slice(start,end),box);
 box.S={permissions:{history:[]}};assert.match(vm.runInContext('pgAlwaysAllowed()',box),/尚未在对话或窗口中授予权限/);box.S=snapshot;
 const html=vm.runInContext('pgAlwaysAllowed()',box);assert.match(html,/Bound fixture/);assert.match(html,/data-action="openChatURL"/);assert.match(html,/data-action="permissionHistorySettings"/);assert.match(html,/已撤回/);assert.doesNotMatch(html,/revokeAlwaysAllowed|>撤回<|data-action="switch"/);assert.equal((html.match(/<section/g)||[]).length,2);
});

test('D7 malformed history stays unavailable; a successful revoke survives history write failure without snapshot rereads',async t=>{
 const f=await desktop(t),a=f.app,file=path.join(f.root,'state/permission-history.jsonl'),original=permissionHistoryFor(a.state);
 fs.writeFileSync(file,'{broken JSON\n');bindPermissionHistory(a.state,new PermissionHistory(a.state.dir));let snap=await a.snapshot();
 assert.equal(snap.permissions.history_status.available,false);assert.equal(snap.permissions.history_status.error_code,'PERMISSION_HISTORY_UNAVAILABLE');assert.deepEqual(snap.permissions.history,[]);
 fs.renameSync(file,file+'.bad');bindPermissionHistory(a.state,original);
 if(a.state.data.browser_enabled!==true)await a.handle('/api/settings',{browser_enabled:true});fs.mkdirSync(file);
 const result=await a.handle('/api/permissions/revoke',{gate:'capability',id:'browser'});assert.equal(result.ok,true);assert.equal(a.state.data.browser_enabled,false);assert.equal(permissionHistoryFor(a.state).status().persisted,false);
 let reads=0;const read=fs.readFileSync;fs.readFileSync=function(name,...args){if(name===file)reads++;return read.call(this,name,...args);};try{snap=await a.snapshot();await a.snapshot();}finally{fs.readFileSync=read;}
 assert.equal(reads,0);assert.equal(snap.permissions.history_status.error_code,'PERMISSION_HISTORY_SAVE_FAILED');assert.equal(snap.permissions.history.length,0);
 const source=fs.readFileSync(new URL('../../ui/app.js',import.meta.url),'utf8'),start=source.indexOf('function pgAlwaysAllowed()'),end=source.indexOf('\n/* 1052',start),box={S:snap,E:x=>String(x??''),ibtn:()=>''};vm.createContext(box);installUiTextContext(box);vm.runInContext(source.slice(start,end),box);
 const html=vm.runInContext('pgAlwaysAllowed()',box),unavailable=vm.runInContext('TH("ui.window.pgAlwaysAllowed.text")',box),empty=vm.runInContext('TH("ui.window.pgAlwaysAllowed.text2")',box);
 assert.ok(html.includes(unavailable));assert.ok(!html.includes(empty));
});
