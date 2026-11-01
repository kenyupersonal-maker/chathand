import {storeTestDistribution} from '../support/chrome-store-fixture.mjs';
const fixture=(t,options)=>productionFixture(t,{...options,chromeDistribution:storeTestDistribution()});
import test from 'node:test';
import assert from 'node:assert/strict';
import {nativePermissionRequests} from './1070-native-permission-retry-fixture.mjs';
import {fixture as productionFixture,waitFor} from './1070-chrome-server-fixture.mjs';

test('actual native permission recovery request retries the real server latch only with owner and current UI credentials',
 {skip:process.platform!=='darwin',timeout:150000},async t=>{
 const [recovery,ordinary]=nativePermissionRequests();
 let denied=true;
 const f=fixture(t,{browser:true,optedIn:true,preference:'none',register:()=>{
  if(denied)throw Object.assign(Error('Synthetic denial'),{code:'CHROME_DATA_ACCESS_DENIED'});
  return {registered:true};
 }});
 await f.building;await waitFor(()=>f.calls.registers===1);
 assert.equal((await f.post(ordinary.route,ordinary.body,{ui:false})).body.error.code,'CHROME_DATA_ACCESS_DENIED');assert.equal(f.calls.registers,2);
 await f.post('/api/browser/extension/reconnect');assert.equal(f.calls.registers,2);
 assert.equal((await f.post(recovery.route,recovery.body,{owner:false})).status,401);
 assert.equal((await f.post(recovery.route,recovery.body,{ui:false})).status,403);
 assert.equal(f.calls.registers,2);
 assert.equal((await f.post(recovery.route,recovery.body)).body.error.code,'ARG_INVALID');assert.equal(f.calls.registers,2);
 denied=false;const prepared=await f.post(ordinary.route,ordinary.body,{ui:false});assert.equal(prepared.body.registered,true);assert.equal(f.calls.registers,3);assert.equal(prepared.body.opened,undefined);
 });
