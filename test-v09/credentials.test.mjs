import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as module from '../app/credentials.mjs';
const {CredentialStore}=module;
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-credentials-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}

test('all installations keep AES files even when a retired helper option is supplied',t=>{
 const dir=fixture(t),store=new CredentialStore(dir,{helperPath:path.join(dir,'never-execute-helper')});
 const secret={api_key:'fixture-only-secret',tunnel_id:'tunnel_fixture_123'};
 store.set('tunnel',secret);assert.deepEqual(store.get('tunnel'),secret);assert.equal(store.status().format,'local-encrypted-json');
 for(const name of ['credentials.json','credentials.key'])assert.equal(fs.statSync(path.join(dir,name)).mode&0o777,0o600);
 assert.equal(module.KeychainCredentialAdapter,undefined);assert.equal(module.KEYCHAIN_SERVICE,undefined);
});
test('copied encrypted files remain encrypted files and are never deleted or migrated',t=>{
 const root=fixture(t),source=path.join(root,'source'),target=path.join(root,'target');fs.mkdirSync(source);fs.mkdirSync(target);
 const value={api_key:'fixture-only-secret'};new CredentialStore(source).set('tunnel',value);
 for(const name of ['credentials.json','credentials.key'])fs.copyFileSync(path.join(source,name),path.join(target,name));
 const store=new CredentialStore(target,{helperPath:'/synthetic/missing'});assert.deepEqual(store.get('tunnel'),value);
 for(const name of ['credentials.json','credentials.key'])assert.equal(fs.existsSync(path.join(target,name)),true);
});
test('a non-file adapter is rejected without invoking it or writing credentials',t=>{
 const dir=fixture(t);let calls=0;assert.throws(()=>new CredentialStore(dir,{adapter:{get(){calls++;},set(){calls++;}}}),{code:'CREDENTIAL_BACKEND_UNSUPPORTED'});assert.equal(calls,0);
 assert.equal(fs.existsSync(path.join(dir,'credentials.json')),false);assert.equal(fs.existsSync(path.join(dir,'credentials.key')),false);
});
test('future API providers persist alongside every current connection section',t=>{
 const dir=fixture(t),store=new CredentialStore(dir,{adapter:null}),value={api_key:'synthetic-future'};
 for(const name of ['tunnel','relay','site_b','site_b_machine','future_provider','api.key:future'])store.set(name,value);
 assert.equal(Object.keys(store.readAll()).length,6);assert.deepEqual(new CredentialStore(dir).get('future_provider'),value);
});
test('unsafe prototype section and nested keys remain rejected',t=>{
 const dir=fixture(t),store=new CredentialStore(dir);
 for(const name of ['__proto__','prototype','constructor','bad/key',''])assert.throws(()=>store.set(name,{token:'synthetic'}),{code:'ARG_INVALID'});
 for(const value of [JSON.parse('{"__proto__":{"x":1}}'),{future:JSON.parse('{"constructor":{}}')}])assert.throws(()=>store.writeAll(value),{code:'ARG_INVALID'});
 assert.equal(fs.existsSync(path.join(dir,'credentials.key')),false);
});
