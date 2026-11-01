import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BSiteLocalStore} from '../../app/v1/b-site-store.mjs';

test('C1 new installation selects OpenAI without granting configured or healthy state',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-c1-initial-'));
 const options={stateDir:root,installationId:'11111111-1111-4111-8111-111111111111',existingA:false};
 let store=new BSiteLocalStore(options);
 try{
  assert.equal(store.selection().selected,'openai');
  assert.equal(store.route('openai').configured,0);
  assert.equal(store.route('site').configured,0);
  assert.equal(store.fresh(store.route('openai')),false);
  store.configureSite({site_id:'c1_fixture',owner_subject:'fixture-owner',binding_id:'22222222-2222-4222-8222-222222222222',generation:1},{authenticated:true});
  store.health('site',{state:'healthy',verified:true,nonceEcho:true,generation:1});
  store.switchUser('site',{windowGesture:true});
  store.close();store=new BSiteLocalStore(options);
  assert.equal(store.selection().selected,'site','restart preserves the existing user selection');
 }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});
