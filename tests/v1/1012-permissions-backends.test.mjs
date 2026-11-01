import {storeTestDistribution,manifestStoreTestHelper} from '../support/chrome-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PersonalChrome} from '../../app/v08/personal-chrome.mjs';
import {NativeComputer} from '../../app/v07/computer.mjs';
import {Repair} from '../../app/v1/repair.mjs';
import {cleanError} from '../../engine/src/core.mjs';

test('1012 folder browser backend remains switch-gated and returns scope_note without attaching real Chrome', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1012-browser-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const state={data:{mode:'auto',browser_enabled:true},project:()=>({path:path.join(dir,'Folder')})},policy={epoch:1,fullArmed:false,check(){}};
  const transport={async call(){return {structuredContent:{pages:[{id:1,url:'https://fixture.invalid/',title:'Fixture'}]}};},async stop(){}};
  const browser=new PersonalChrome(state,{stateDir:dir},policy,{transportFactory:()=>transport,chromeInfo:()=>({installed:true,supported:true})});t.after(()=>browser.closeAll());
  browser.startConnect();await browser.pending;
  assert.equal(browser.status().connected,true);
  assert.ok(browser.status().details.scope_note.includes('Folder'));
  const list=await browser.tabs({action:'list'},'fixture');assert.equal(list.tabs.length,1);assert.ok(list.details.scope_note.includes('Folder'));
  assert.throws(()=>browser.download(),e=>cleanError(e).details.scope_note.includes('Folder'));
  state.data.browser_enabled=false;await assert.rejects(()=>browser.tabs({action:'list'},'fixture'),{code:'CAPABILITY_OFF'});
});

test('1012 folder desktop uses only a fake native reply, retains active-task and switch checks', async () => {
  const state={data:{mode:'auto',desktop_enabled:true},project:()=>({name:'Folder',path:'/tmp/Folder'})};
  let active=true;const policy={epoch:1,fullArmed:false,require(){if(!active)throw Object.assign(Error('inactive'),{code:'TASK_EXPIRED'});}};
  const computer=new NativeComputer(state,policy);computer.heartbeat({accessibility:true,screen_recording:true});
  const pending=computer.applications({task_id:'fixture'},'fixture'),request=computer.next().request;
  assert.ok(request);computer.complete(request.id,{applications:[],ttlMs:1000,cacheScope:'private'});
  const result=await pending;assert.ok(result.details.scope_note.includes('Folder'));assert.equal(result.ttlMs,1000);
  state.data.desktop_enabled=false;await assert.rejects(()=>computer.applications({task_id:'fixture'},'fixture'),{code:'CAPABILITY_OFF'});
  state.data.desktop_enabled=true;active=false;await assert.rejects(()=>computer.applications({task_id:'fixture'},'fixture'),{code:'TASK_EXPIRED'});
  computer.cancelAll();
});

test('1012 repair items 9/10 inspect helper and OS permissions in folder scope', async () => {
  for(const ready of [false,true]) {
    let now=0;const s={enabled:true,mode:'auto',permissions:{file_scope:'folder'},settings:{browser_enabled:true,desktop_enabled:true,connection_preference:'relay'},relay:{online:true},automation:{browser:{extension:{connected:ready,installed:true,helper:ready?manifestStoreTestHelper():null,compatibility:{state:ready?'compatible':'unknown'}}},computer:{permissions:{accessibility:ready,screen_recording:ready}}}};
    const repair=new Repair({distribution:storeTestDistribution(),snapshot:()=>s,now:()=>now,sleep:async ms=>{now+=ms;},systemProxy:()=>null,openChromeInBackground(){},cleanupUpgrade:()=>({cleaned:0})});
    const result=repair.start();for(let i=0;i<100&&result.status==='running';i++)await new Promise(r=>setImmediate(r));
    assert.equal(result.status,'done');
    for(const id of ['browser_helper','desktop_permissions']) {
      const item=result.items.find(x=>x.id===id);assert.equal(item.status,ready?'ok':'action');assert.notEqual(item.action?.kind,'scope_full');
    }
  }
});
