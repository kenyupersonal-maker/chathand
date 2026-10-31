import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {CredentialStore} from '../app/credentials.mjs';

function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kb053-creds-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,store:new CredentialStore(dir,{helperPath:'/synthetic/retired-helper-must-not-run'})};}

test('credentials are AES-256-GCM encrypted JSON, not plaintext',t=>{const f=fixture(t),secret='sk-test-fixture-super-secret',value={api_key:secret,tunnel_id:'tunnel_'+ 'a'.repeat(32),binary:'/tmp/tunnel-client'};f.store.set('tunnel',value);assert.deepEqual(f.store.get('tunnel'),value);const raw=fs.readFileSync(path.join(f.dir,'credentials.json'),'utf8');assert.ok(!raw.includes(secret));const box=JSON.parse(raw);assert.equal(box.algorithm,'aes-256-gcm');assert.equal(box.schema,1);assert.equal(fs.statSync(path.join(f.dir,'credentials.json')).mode&0o777,0o600);assert.equal(fs.statSync(path.join(f.dir,'credentials.key')).mode&0o777,0o600);assert.equal(fs.statSync(path.join(f.dir,'credentials.key')).size,32);});

test('same saved credentials survive a new process object',t=>{const f=fixture(t),value={api_key:'local-only-secret',tunnel_id:'tunnel_'+ 'b'.repeat(32),binary:'/tmp/tunnel-client'};f.store.set('tunnel',value);const reopened=new CredentialStore(f.dir);assert.deepEqual(reopened.get('tunnel'),value);assert.equal(reopened.status().tunnel,true);});

test('credential tampering is rejected',t=>{const f=fixture(t);f.store.set('tunnel',{api_key:'x',tunnel_id:'tunnel_x',binary:'/tmp/x'});const file=path.join(f.dir,'credentials.json'),box=JSON.parse(fs.readFileSync(file));box.ciphertext=box.ciphertext.slice(0,-4)+'AAAA';fs.writeFileSync(file,JSON.stringify(box),{mode:0o600});assert.throws(()=>f.store.get('tunnel'),{code:'CREDENTIAL_STORE_CORRUPT'});});

test('forget removes one provider without deleting another',t=>{const f=fixture(t);f.store.set('tunnel',{api_key:'a'});f.store.set('relay',{version:1,session:{access_token:'b'}});f.store.remove('tunnel');assert.equal(f.store.get('tunnel'),null);assert.deepEqual(f.store.get('relay'),{version:1,session:{access_token:'b'}});});

test('native app contains no Keychain APIs or Security framework import',()=>{const source=fs.readFileSync(new URL('../native/main.swift',import.meta.url),'utf8');for(const token of ['import Security','SecItem','kSecClass','keySave(','keyLoad(','relayKey('])assert.ok(!source.includes(token),token);});

test('normal credential code has no subprocess or Keychain adapter',()=>{const source=fs.readFileSync(new URL('../app/credentials.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/spawnSync|KeychainCredentialAdapter|SecItem|importLegacyCopy/);});
