import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {RelayKeeper} from '../../app/v1/relay-keeper.mjs';
test('terminal relay history never scans while active relay work is maintained at most every fifteen seconds',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-relay-idle-'));let now=100000,status='active';const keeper=new RelayKeeper({file:path.join(dir,'state.sqlite'),now:()=>now,readTask:()=>({status,enabled:true}),taskState:id=>id==='active'?status:'completed'});t.after(()=>{keeper.close();fs.rmSync(dir,{recursive:true,force:true});});
 keeper._tx(state=>{for(let i=0;i<100;i++)state.tasks['terminal'+i]={id:'terminal'+i,card:{state:'cancelled',at:now,ready_at:null}};});
 let scans=0;const sweep=keeper._sweep.bind(keeper);keeper._sweep=state=>{scans++;return sweep(state);};
 for(let i=0;i<300;i++){now+=1000;keeper.maintain();}assert.equal(scans,0);
 keeper._tx(state=>{state.tasks.active={id:'active',card:{state:'armed',at:now,ready_at:now+1000}};});scans=0;
 for(let i=0;i<60;i++){now+=1000;keeper.maintain();}assert.equal(scans,4);
 status='completed';now+=15000;assert.equal(keeper.maintenanceDue(),false);keeper.maintain();assert.equal(scans,4);
});
test('explicit transactions still sweep permits immediately even inside the maintenance interval',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-relay-permit-'));let now=1000;const keeper=new RelayKeeper({file:path.join(dir,'state.sqlite'),now:()=>now,readTask:()=>({status:'active'}),taskState:()=> 'active'});t.after(()=>{keeper.close();fs.rmSync(dir,{recursive:true,force:true});});
 keeper._tx(state=>{state.tasks.active={id:'active',card:{state:'permit',at:now,ready_at:null,permit:{from:'armed',expires_at:now+100}}};});now+=101;assert.equal(keeper.maintenanceDue(),false);const state=keeper._tx(state=>state.tasks.active.card.state);assert.equal(state,'armed');
});
