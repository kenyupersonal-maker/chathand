import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {BSiteLocalStore} from '../app/v1/b-site-store.mjs';
import {BSitePairing} from '../app/v1/b-site-pairing.mjs';
for(const stale of [false,true])test(`abandon persists failure through section credentials with orphan ${stale}`,t=>{
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'site-abandon-compat-')),installationId=crypto.randomUUID();
 const localStore=new BSiteLocalStore({stateDir,installationId,existingA:true});
 t.after(()=>{localStore.close();fs.rmSync(stateDir,{recursive:true,force:true});});
 const data=new Map(stale?[['site_b_pair_recovery',{pairing_id:'orphan'}]]:[]);
 const credentials={get:k=>data.get(k)??null,set:(k,v)=>data.set(k,v),remove:k=>data.delete(k)};
 const pairing=new BSitePairing({installationId,localStore,credentials,resolveDeployment:async()=>null,transport:{epoch:0}});
 assert.deepEqual(pairing.abandonSitePairing(),{phase:'failed',error_code:'B_PAIRING_ABANDONED'});
 assert.equal(data.has('site_b_pair_recovery'),false);assert.equal(pairing.pending,null);
 assert.equal(localStore.db.prepare('SELECT error_code FROM b_pair_failure').get().error_code,'B_PAIRING_ABANDONED');
});
