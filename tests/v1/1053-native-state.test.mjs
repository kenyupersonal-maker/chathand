import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {desktop} from './1052-a-fixture.mjs';
import {projectNativeState,NATIVE_STATE_FIELDS} from '../../app/v1/native-state.mjs';
import {TaskReceipts} from '../../app/task-receipts.mjs';

test('native projection includes every native-consumed field while excluding receipt/output/permission payloads',()=>{
 const row=Object.fromEntries([...new Set(Object.values(NATIVE_STATE_FIELDS).flat())].map(k=>[k,k]));
 const state={error:{code:'SYNTHETIC'},settings:{notifications:false,appearance:'dark',ui_zoom:1.5,mode:'full',conversations:[row],api_key:'must-not-copy'},connection:{automatic:{phase:'ready',other:'omit'},control_plane:{state:'up'},ready:true,healthy:true,error:{code:'example'},display:{text:'reserved'}},relay:{online:true},project:{name:'p',path:'/synthetic',scope:'computer'},update:{status:'available',version:'v',install:{state:'idle'},downloaded_bytes:400},keep_awake:true,lifecycle:{exit_requested:false},instance_id:'fixture',enabled:true,mode:'full',events:[row],confirmations:[{...row,item:{id:'cap',secret:'omit'}}],tasks:[{...row,stdout:'omit'}],jobs:[{...row,stdout:'omit'}],approvals:[row],inputs:[row],setup:{key_watch:{active:true}},site_b:{enrollment_watch:{watching:true,watch_id:'id',expires_at:123,stopped_id:'old'}},computer:{pending:1},history:['omit'],activity:['omit'],value:{omit:true}};
 const out=projectNativeState(state);assert.deepEqual(Object.keys(out.settings).sort(),['appearance','conversations','mode','notifications','ui_zoom']);
 for(const field of ['tasks','jobs','events','approvals','inputs'])assert.deepEqual(Object.keys(out[field][0]).sort(),NATIVE_STATE_FIELDS[field].slice().sort());
 assert.deepEqual(out.confirmations[0].item,{id:'cap'});assert.deepEqual(out.connection.display,{text:'reserved'});assert.equal(out.setup.key_watch.active,true);assert.equal(out.site_b.enrollment_watch.watch_id,'id');assert.equal(out.computer.pending,1);assert.equal(out.error.code,'SYNTHETIC');
 assert.doesNotMatch(JSON.stringify(out),/must-not-copy|stdout|history|activity|downloaded_bytes/);
});
test('only double-authenticated native reads renew lease; idle request remains pending and authorization fences stay active',async t=>{
 const f=await desktop(t),a=f.app,computer=a.tools.automation.computer,origin=`http://127.0.0.1:${a.apiPort}`,owner={Authorization:`Bearer ${a.adminToken}`},headers={...owner,'X-ChatHand-UI':a.uiKey};
 computer.lastSeen=Date.now()-6000;const previous=computer.lastSeen;
 for(const h of [{},owner,{...owner,'X-ChatHand-UI':'wrong'}]){const r=await fetch(origin+'/api/native/state',{headers:h});assert.ok([401,403].includes(r.status));await r.json();assert.equal(computer.lastSeen,previous);}
 await fetch(origin+'/api/state',{headers:owner}).then(r=>r.json());assert.equal(computer.lastSeen,previous);
 const read=a.policy.receipts.read;a.policy.receipts.read=()=>assert.fail('native endpoint must never read receipts');
 const res=await fetch(origin+'/api/native/state',{headers});assert.equal(res.status,200);const snapshot=await res.json();a.policy.receipts.read=read;
 assert.ok(computer.lastSeen>previous);assert.equal(computer.nativeStatus,null,'lease never grants OS permissions');assert.equal(snapshot.computer.pending,0);assert.equal('history' in snapshot,false);
 a.state.data.desktop_enabled=true;const id=await f.begin();
 const pending=computer.request('applications',{},id,'chatgpt');let settled=false;pending.then(()=>{settled=true;},()=>{settled=true;});
 assert.equal(settled,false);const live=await fetch(origin+'/api/native/state',{headers}).then(r=>r.json());assert.equal(live.computer.pending,1);
 const request=computer.next().request;assert.ok(request);assert.equal(computer.authorize(request.id).id,request.id);
 a.policy.permissionRevision++;assert.throws(()=>computer.authorize(request.id),{code:'COMPUTER_REQUEST_EXPIRED'});computer.complete(request.id,{ok:true});await assert.rejects(pending);assert.equal(computer.pending.size,0);
});
test('receipt cache incrementally reads content, returns isolated copies across authenticated callers, and detects replacement/deletion/corruption',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-receipt-cache-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const receipts=new TaskReceipts(root),id=crypto.randomUUID(),result={task_id:id,status:'completed',execution_complete:true,terminal:true,finished_at:1,jobs:[]};receipts.save(id,'owner',true,result);assert.equal(receipts.cachedStatus(id),'completed');receipts.cache.clear();
 let reads=0;const original=fs.readFileSync;fs.readFileSync=function(file,...args){if(String(file).endsWith(id+'.json'))reads++;return original.call(this,file,...args);};t.after(()=>{fs.readFileSync=original;});
 const first=receipts.read(id,'owner');first.result.status='mutated';assert.equal(receipts.read(id,'owner').result.status,'completed');assert.equal(reads,1);
 assert.equal(receipts.read(id,'other').result.status,'completed','receipt storage does not impose a stale connector/session binding');
 const entries=receipts.entries();assert.equal(receipts.entries(),entries);assert.equal(receipts.directorySnapshot.count,1);
 const file=path.join(receipts.dir,id+'.json');fs.writeFileSync(file,'bad');assert.throws(()=>receipts.read(id),{code:'TASK_RECEIPT_INVALID'});fs.unlinkSync(file);assert.equal(receipts.entries().length,0);assert.equal(receipts.read(id),null);
});
