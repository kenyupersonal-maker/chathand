import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {CredentialStore} from '../app/credentials.mjs';
import {FILE_WRITE_LOCK} from '../app/credential-revision.mjs';
const module=fileURLToPath(new URL('../app/credentials.mjs',import.meta.url)),revisionModule=fileURLToPath(new URL('../app/credential-revision.mjs',import.meta.url));
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1055-files-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function child(source){const c=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';c.stdout.on('data',v=>stdout+=v);c.stderr.on('data',v=>stderr+=v);const done=once(c,'exit').then(([code,signal])=>({code,signal,stdout,stderr}));return {c,done};}
async function until(fn){const end=Date.now()+5000;while(!fn()){assert.ok(Date.now()<end,'synthetic lock owner reached its pause');await new Promise(r=>setTimeout(r,10));}}

test('exclusive full-store creation preserves all sections and never replaces either existing destination',t=>{
 const dir=fixture(t),store=new CredentialStore(dir),all={tunnel:{api_key:'synthetic-A'},relay:{token:'synthetic-B'},site_b:{private_key:'synthetic-C'},site_b_machine:{bearer:'synthetic-D'},future_api:{api_key:'synthetic-E'},site_b_intents:{pending:[]}};assert.equal(store.writeAll(all,{exclusive:true}).saved,true);assert.deepEqual(store.readAll(),all);assert.equal(store.status().verified,true);
 const before=Object.fromEntries(['credentials.key','credentials.json'].map(n=>[n,fs.readFileSync(path.join(dir,n))]));assert.throws(()=>store.writeAll({future_api:{api_key:'different'}},{exclusive:true}),{code:'CREDENTIAL_STORE_EXISTS'});for(const [name,bytes] of Object.entries(before))assert.deepEqual(fs.readFileSync(path.join(dir,name)),bytes);
});
test('exclusive stops for a key-only, ciphertext-only or dangling symlink without reading or replacing it',t=>{
 for(const name of ['credentials.key','credentials.json','symlink']){const dir=fixture(t),file=path.join(dir,name==='symlink'?'credentials.key':name);if(name==='symlink')fs.symlinkSync(path.join(dir,'absent'),file);else fs.writeFileSync(file,'synthetic-existing',{mode:0o600});const store=new CredentialStore(dir);store.readEncrypted=()=>assert.fail('exclusive must not read existing secret files');assert.throws(()=>store.writeAll({future_api:{api_key:'synthetic'}},{exclusive:true}),{code:'CREDENTIAL_STORE_EXISTS'});if(name==='symlink')assert.equal(fs.lstatSync(file).isSymbolicLink(),true);else assert.equal(fs.readFileSync(file,'utf8'),'synthetic-existing');}
});
test('cross-process writers merge independent sections under one complete transaction',async t=>{
 const dir=fixture(t),workers=Array.from({length:6},(_,n)=>child(`import {CredentialStore} from ${JSON.stringify(module)};const s=new CredentialStore(${JSON.stringify(dir)},{lockTimeoutMs:5000});for(let i=0;i<8;i++)s.set('provider_${n}_'+i,{api_key:'synthetic-'+i});`));const results=await Promise.all(workers.map(x=>x.done));for(const r of results)assert.equal(r.code,0,r.stderr);const all=new CredentialStore(dir).readAll();assert.equal(Object.keys(all).length,48);for(let n=0;n<6;n++)for(let i=0;i<8;i++)assert.deepEqual(all['provider_'+n+'_'+i],{api_key:'synthetic-'+i});
});
test('two exclusive processes yield exactly one creator and preserve its complete store',async t=>{
 const dir=fixture(t),source=n=>`import {CredentialStore} from ${JSON.stringify(module)};try{new CredentialStore(${JSON.stringify(dir)}).writeAll({provider:{value:${n}}},{exclusive:true});console.log('created');}catch(e){if(e.code!=='CREDENTIAL_STORE_EXISTS')throw e;console.log('exists');}`;const a=child(source(1)),b=child(source(2)),results=await Promise.all([a.done,b.done]);for(const r of results)assert.equal(r.code,0,r.stderr);assert.deepEqual(results.map(r=>r.stdout.trim()).sort(),['created','exists']);assert.ok([1,2].includes(new CredentialStore(dir).get('provider').value));
});
test('live owner is never stolen by mtime; dead owner token is reclaimed without a stale lock timeout',async t=>{
 const dir=fixture(t),paused=path.join(dir,'synthetic-owner-ready');new CredentialStore(dir).set('tunnel',{api_key:'synthetic-before'});const owner=child(`import fs from 'node:fs';import {withCredentialFileLock} from ${JSON.stringify(revisionModule)};withCredentialFileLock(${JSON.stringify(dir)},()=>{fs.writeFileSync(${JSON.stringify(paused)},'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);});`);t.after(()=>{try{owner.c.kill('SIGKILL');}catch{}});await until(()=>fs.existsSync(paused));fs.utimesSync(path.join(dir,FILE_WRITE_LOCK),1,1);const store=new CredentialStore(dir,{lockTimeoutMs:30});assert.throws(()=>store.set('relay',{token:'synthetic-live'}),{code:'CREDENTIAL_BUSY'});assert.equal(store.get('tunnel').api_key,'synthetic-before');owner.c.kill('SIGKILL');await owner.done;store.set('relay',{token:'synthetic-after'});assert.equal(store.get('relay').token,'synthetic-after');assert.equal(fs.existsSync(path.join(dir,FILE_WRITE_LOCK)),false);
});
test('unattributed orphan lock returns bounded busy and does not change ciphertext or collide with old helper lock',t=>{
 const dir=fixture(t),store=new CredentialStore(dir,{lockTimeoutMs:20});store.set('tunnel',{api_key:'synthetic-before'});const file=path.join(dir,'credentials.json'),before=fs.readFileSync(file);fs.writeFileSync(path.join(dir,'credential-revision.lock'),'synthetic-retired-lock');fs.mkdirSync(path.join(dir,FILE_WRITE_LOCK));fs.writeFileSync(path.join(dir,FILE_WRITE_LOCK,'unknown'),'not-an-owner');const start=performance.now();assert.throws(()=>store.set('relay',{token:'synthetic'}),{code:'CREDENTIAL_BUSY'});assert.ok(performance.now()-start<500);assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.readFileSync(path.join(dir,'credential-revision.lock'),'utf8'),'synthetic-retired-lock');
});
test('key and ciphertext hardlinks are rejected without cache reuse or automatic file deletion',t=>{
 for(const name of ['credentials.key','credentials.json']){const dir=fixture(t),store=new CredentialStore(dir);store.set('tunnel',{api_key:'synthetic-A'});fs.linkSync(path.join(dir,name),path.join(dir,'synthetic-extra-link'));assert.equal(store.status().verified,false);assert.throws(()=>store.get('tunnel'));assert.equal(fs.existsSync(path.join(dir,'synthetic-extra-link')),true);assert.equal(fs.statSync(path.join(dir,name)).nlink,2);}
});
