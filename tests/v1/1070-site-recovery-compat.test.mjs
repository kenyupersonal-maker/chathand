import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {BSiteLocalStore} from '../../app/v1/b-site-store.mjs';
function fixture(t){
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'site-recovery-compat-'));
 const local=new BSiteLocalStore({stateDir,installationId:crypto.randomUUID(),existingA:true});
 t.after(()=>{local.close();fs.rmSync(stateDir,{recursive:true,force:true});});
 return local;
}
for(const api of ['section','bulk'])for(const stale of [false,true])test(`no recovery row: ${api} API, stale material ${stale}`,t=>{
 const local=fixture(t);let data={unrelated:{keep:true},...(stale?{site_b_pair_recovery:{pairing_id:'orphan'}}:{})},writes=0;
 const credentials=api==='section'?{get:k=>data[k]??null,set(k,v){data[k]=v;writes++;},remove(k){delete data[k];writes++;}}:
 {readAll:()=>structuredClone(data),writeAll(v){data=structuredClone(v);writes++;}};
 assert.equal(local.pairRecovery(credentials),null);
 local.cancelPairRecovery(credentials);
 assert.deepEqual(data,{unrelated:{keep:true}});assert.equal(writes,stale?1:0);
});
test('a real recovery row cannot be treated as absent by a section-only store',t=>{
 const local=fixture(t),pairing=crypto.randomUUID(),intent=crypto.randomUUID();
 local.db.prepare('INSERT INTO b_pair_recovery(id,pairing_id,intent_id,claim_digest,site_id,expires_at) VALUES(1,?,?,?,?,?)').run(pairing,intent,'a'.repeat(64),'fixture',Date.now()+60000);
 let removes=0;const credentials={get:()=>null,set(){},remove(){removes++;}};
 assert.throws(()=>local.pairRecovery(credentials),TypeError);
 assert.equal(local.db.prepare('SELECT pairing_id FROM b_pair_recovery').get().pairing_id,pairing);assert.equal(removes,0);
 assert.throws(()=>local.pairRecovery({readAll:()=>({})}),{code:'B_PAIR_RECOVERY_UNCONFIRMED'});
});
test('orphan cleanup failure propagates instead of reporting successful cancellation',t=>{
 const local=fixture(t);
 assert.throws(()=>local.cancelPairRecovery({get:()=>({pairing_id:'orphan'}),remove(){throw Error('synthetic cleanup failure');}}),/synthetic cleanup failure/);
});
