import test from 'node:test';import assert from 'node:assert/strict';import {desktop} from './1052-a-fixture.mjs';import {applyPermissionTier} from '../../app/v1/permissions.mjs';
test('preinstall3 default desktop capability reduction revokes even with identical mode and root',async t=>{
 const f=await desktop(t),a=f.app;await a.handle('/api/mode',{mode:'auto'});delete a.state.data.desktop_enabled;a.state.data.high_risk={};const id=await f.begin();
 let calls=0;const revoke=a.policy.revokeAll;a.policy.revokeAll=function(reason){assert.equal(reason,'permission_changed');calls++;return revoke.call(this,reason);};
 await applyPermissionTier({state:a.state,store:a.store,policy:a.policy,adminAccess:{supported:()=>false}},{tier:'light',folder:f.work});a.policy.revokeAll=revoke;
 assert.equal(calls,1);assert.equal(a.policy.get(id).status,'permission_changed');assert.equal(a.state.data.desktop_enabled,false);
});
