import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {BSiteLocalStore} from '../../app/v1/b-site-store.mjs';

const installationId='c7403891-fbb1-4833-820a-fca957b4f024';
const siteId='privateSiteA',origin='https://private-a.chatgpt.site',owner='owner-fixture';
const sitePublicKey=crypto.randomBytes(32).toString('base64url');
const A=Object.freeze({api_key:'existing-a-secret',unrelated:{keep:true}});

class FileCredentials{
 constructor(file){this.file=file;fs.writeFileSync(file,JSON.stringify({openai:A,other:'keep'}),{mode:0o600});}
 readAll(){return JSON.parse(fs.readFileSync(this.file,'utf8'));}
 writeAll(all){const next=`${this.file}.next`;fs.writeFileSync(next,JSON.stringify(all),{mode:0o600});fs.renameSync(next,this.file);}
 get(key){return this.readAll()[key]??null;}
}

function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'b-site-local-commit-'));
 const credentials=new FileCredentials(path.join(root,'credentials.json'));
 const open=()=>new BSiteLocalStore({stateDir:root,installationId,existingA:true,resultKey:()=>Buffer.alloc(32)});
 const intentId=crypto.randomUUID(),bindingId=crypto.randomUUID();
 let store=open();
 // Only the local commit journal is exercised here; no remote request or real Keychain.
 store.db.prepare('INSERT INTO b_pair_intents(intent_id,pairing_hash,created_at,expires_at) VALUES(?,?,?,?)')
  .run(intentId,'a'.repeat(64),Date.now(),Date.now()+3600000);
 const initial=store.snapshot(),route=store.route('site');
 const commit={intent_id:intentId,site_id:siteId,owner_subject:owner,binding_id:bindingId,generation:1,
  previous_binding:route.binding_id,previous_generation:route.generation,
  previous_configured:route.configured,selection_revision:initial.revision};
 const staged={installation_id:installationId,site_id:siteId,site_origin:origin,
  owner_subject:owner,binding_id:bindingId,generation:1,site_public_key:sitePublicKey,
  device_credential:'d'.repeat(43),template_version:'fixture-v2',manifest_sha256:'b'.repeat(64)};
 const machine={site_id:siteId,site_origin:origin,bearer:'s'.repeat(48)};
 const stage=()=>{const all=credentials.readAll();all.site_b_stage=staged;all.site_b_machine_stage=machine;credentials.writeAll(all);};
 const restart=()=>{store.close();store=open();return store;};
 const cleanup=()=>{store.close();fs.rmSync(root,{recursive:true,force:true});};
 return {store:()=>store,credentials,commit,staged,machine,stage,restart,cleanup,initial};
}

for(const stagedBeforeCrash of [false,true])test(`PREPARED restart rolls back ${stagedBeforeCrash?'staged credentials':'empty stage'} while retaining A`,()=>{
 const f=fixture();
 try{
  f.store().prepareSiteCommit(f.commit);
  if(stagedBeforeCrash)f.stage();
  const reopened=f.restart();
  assert.deepEqual(reopened.recoverSiteCommit(f.credentials),{recovered:true,phase:'rolled_back'});
  assert.equal(reopened.siteCommit(),null);
  assert.equal(reopened.route('site').configured,0);
  assert.equal(reopened.snapshot().selected,'openai');
  const all=f.credentials.readAll();
  assert.deepEqual(all.openai,A);assert.equal(all.other,'keep');
  assert.equal(all.site_b_stage,undefined);assert.equal(all.site_b_machine_stage,undefined);
  assert.equal(all.site_b,undefined);
  assert.equal(reopened.db.prepare('SELECT used_at FROM b_pair_intents WHERE intent_id=?').get(f.commit.intent_id).used_at,null);
 }finally{f.cleanup();}
});

for(const promotedBeforeCrash of [false,true])test(`COMMITTED restart ${promotedBeforeCrash?'accepts prior promotion':'promotes stage'} and keeps A`,()=>{
 const f=fixture();
 try{
  f.store().prepareSiteCommit(f.commit);
  f.stage();
  f.store().decideSiteCommit({...f.commit,site_origin:origin,site_public_key:sitePublicKey});
  if(promotedBeforeCrash){
   const all=f.credentials.readAll();all.site_b=all.site_b_stage;all.site_b_machine=all.site_b_machine_stage;
   delete all.site_b_stage;delete all.site_b_machine_stage;f.credentials.writeAll(all);
  }
  const reopened=f.restart();
  assert.equal(reopened.siteCommit()?.phase,'COMMITTED');
  assert.equal(reopened.snapshot().routes.site.health_fresh,false);
  assert.deepEqual(reopened.recoverSiteCommit(f.credentials),{recovered:true,phase:'committed'});
  assert.equal(reopened.siteCommit(),null);
  assert.equal(reopened.route('site').binding_id,f.commit.binding_id);
  assert.equal(reopened.snapshot().selected,'openai');
  const all=f.credentials.readAll();
  assert.deepEqual(all.site_b,f.staged);assert.deepEqual(all.site_b_machine,f.machine);
  assert.deepEqual(all.openai,A);assert.equal(all.other,'keep');
  assert.equal(all.site_b_stage,undefined);assert.equal(all.site_b_machine_stage,undefined);
  assert.notEqual(reopened.db.prepare('SELECT used_at FROM b_pair_intents WHERE intent_id=?').get(f.commit.intent_id).used_at,null);
 }finally{f.cleanup();}
});
