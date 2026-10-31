import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {BSiteLocalStore} from '../app/v1/b-site-store.mjs';
import {BSitePairing} from '../app/v1/b-site-pairing.mjs';
const now=1800000000000;
const other={openai_fixture:{retained:true},unrelated:{value:'untouched'}};
class FixtureCredentials{
 constructor(file){this.file=file;this.failWrites=0;this.failAfterWrites=0;this.writeAll(other);}
 readAll(){return JSON.parse(fs.readFileSync(this.file,'utf8'));}
 writeAll(value){if(this.failWrites){this.failWrites--;throw Object.assign(Error('ordinary injected credential save failure'),{code:'EIO'});}const next=this.file+'.next';fs.writeFileSync(next,JSON.stringify(value),{mode:0o600});fs.renameSync(next,this.file);if(this.failAfterWrites){this.failAfterWrites--;throw Object.assign(Error('ordinary injected lost save confirmation'),{code:'EIO'});}}
 get(key){return this.readAll()[key]??null;}
}
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'site-forget-commit-'))),installationId=crypto.randomUUID(),credentials=new FixtureCredentials(path.join(root,'fixture-credentials.json'));let local;
 const open=()=>new BSiteLocalStore({stateDir:root,installationId,existingA:true,now:()=>now,resultKey:()=>Buffer.alloc(32,7)});local=open();
 const material=(binding_id,generation,site_id='fixtureSiteA')=>({installation_id:installationId,site_id,site_origin:'https://fixture-only.example',owner_subject:'fixture-owner',binding_id,generation,site_public_key:Buffer.alloc(32,8).toString('base64url'),device_credential:'synthetic-private-material-do-not-persist-in-decision'});
 const machine=saved=>({site_id:saved.site_id,site_origin:saved.site_origin,bearer:'synthetic-bearer-material-do-not-persist-in-decision'});
 const setActive=(saved)=>{const all=credentials.readAll();all.site_b=saved;all.site_b_machine=machine(saved);credentials.writeAll(all);};
 const configured=()=>{const saved=material(crypto.randomUUID(),1);local.configureSite(saved,{authenticated:true});setActive(saved);return saved;};
 const setup=(phase,{previous=false,recovery=false}={})=>{
  if(previous)configured();
  const prev=local.route('site'),intent=local.ensureIntent(credentials),commit={intent_id:intent.intent_id,site_id:'fixtureSiteB',owner_subject:'fixture-owner',binding_id:crypto.randomUUID(),generation:prev.generation+1,previous_binding:prev.binding_id,previous_generation:prev.generation,previous_configured:prev.configured,selection_revision:local.selection().revision},staged=material(commit.binding_id,commit.generation,commit.site_id);
  if(recovery){const pairing_id=crypto.randomUUID(),claim_digest='a'.repeat(64);local.stagePairRecovery({pairing_id,intent_id:intent.intent_id,claim_digest,site_id:commit.site_id,expires_at:now+100000},{pairing_id,claim_digest,site_id:commit.site_id,previous_binding:prev.binding_id,previous_generation:prev.generation,claim:{installation_id:installationId},private_fixture:'synthetic-recovery-material-do-not-persist-in-decision'},credentials);}
  local.prepareSiteCommit(commit);const all=credentials.readAll();all.site_b_stage=staged;all.site_b_machine_stage=machine(staged);credentials.writeAll(all);
  if(phase!=='PREPARED')local.decideSiteCommit({...commit,site_origin:staged.site_origin,site_public_key:staged.site_public_key});
  if(phase==='normal')local.recoverSiteCommit(credentials);
  const route=local.route('site');return {commit,staged,expected:{binding_id:route.binding_id,generation:route.generation}};
 };
 const pairing=()=>new BSitePairing({installationId,credentials,localStore:local,transport:{epoch:0,stop(){}},resolveDeployment:()=>null,templatePin:()=>{throw Error('No template/network access expected');},now:()=>now});
 const restart=()=>{local.close();local=open();return local;};t.after(()=>{local.close();fs.rmSync(root,{recursive:true,force:true});});return {root,installationId,credentials,material,configured,setup,pairing,restart,store:()=>local};
}
function assertForgotten(f){
 const local=f.store();assert.equal(local.route('site').configured,0);assert.equal(local.route('site').binding_id,null);assert.equal(local.route('site').generation,0);assert.equal(local.siteCommit(),null);assert.equal(local.siteForget(),null);assert.equal(local.selection().selected,'openai');assert.deepEqual(f.credentials.readAll(),other);assert.equal(local.db.prepare('SELECT * FROM b_pair_recovery').get(),undefined);
}
for(const phase of ['normal','PREPARED','COMMITTED'])for(const previous of [false,true])test('forget '+phase+' with '+(previous?'previous active credentials':'no prior binding')+' cancels exact recovery and permits fresh pairing',t=>{
 const f=fixture(t),{expected}=f.setup(phase,{previous,recovery:phase!=='normal'});assert.equal(f.pairing().forget(expected).forgotten,true);assertForgotten(f);const local=f.restart();assert.deepEqual(local.recoverSiteCommit(f.credentials),{recovered:false});const next=local.ensureIntent(f.credentials),route=local.route('site');assert.doesNotThrow(()=>local.prepareSiteCommit({intent_id:next.intent_id,site_id:'fixtureSiteC',owner_subject:'fixture-owner',binding_id:crypto.randomUUID(),generation:1,previous_binding:route.binding_id,previous_generation:route.generation,previous_configured:route.configured,selection_revision:local.selection().revision}));
});
for(const phase of ['PREPARED','COMMITTED'])test('forget '+phase+' remains valid after native revoke lowers configured but keeps binding/generation',t=>{
 const f=fixture(t),{expected}=f.setup(phase,{previous:true,recovery:true});f.store().revokeSite({...expected,authenticatedNative:true});assert.equal(f.store().route('site').configured,0);f.pairing().forget(expected);assertForgotten(f);assert.equal(f.store().revocationPending(expected.binding_id,expected.generation),true);
});
for(const phase of ['normal','PREPARED','COMMITTED'])test('credential save failure after '+phase+' forget reloads and completes deletion before any promotion',t=>{
 const f=fixture(t),{expected}=f.setup(phase,{previous:true,recovery:phase!=='normal'}),before=f.credentials.readAll();f.credentials.failWrites=1;assert.throws(()=>f.pairing().forget(expected),{code:'EIO'});assert.deepEqual(f.credentials.readAll(),before);assert.equal(f.store().siteCommit(),null);assert.ok(f.store().siteForget());assert.equal(f.store().route('site').binding_id,null);
 const scope=f.store().siteForget().scope_json;for(const marker of ['synthetic-private-material','synthetic-bearer-material','synthetic-recovery-material'])assert.equal(scope.includes(marker),false);
 assert.throws(()=>f.store().configureSite(f.material(crypto.randomUUID(),2),{authenticated:true}),{code:'B_SITE_FORGET_PENDING'});assert.throws(()=>f.store().prepareSiteCommit({intent_id:crypto.randomUUID(),site_id:'fixtureSiteC',owner_subject:'fixture-owner',binding_id:crypto.randomUUID(),generation:1}),{code:'B_SITE_FORGET_PENDING'});
 const local=f.restart();assert.deepEqual(local.recoverSiteCommit(f.credentials),{recovered:true,phase:'forgotten'});assertForgotten(f);assert.doesNotThrow(()=>local.ensureIntent(f.credentials));
});
for(const retryCurrent of [false,true])test('pending forget retry accepts '+(retryCurrent?'current empty route':'original expected binding')+' only until cleanup finishes',t=>{
 const f=fixture(t),{expected}=f.setup('COMMITTED',{previous:true});f.credentials.failWrites=1;assert.throws(()=>f.pairing().forget(expected),{code:'EIO'});assert.equal(f.pairing().forget(retryCurrent?{binding_id:null,generation:0}:expected).forgotten,true);assertForgotten(f);assert.throws(()=>f.pairing().forget(expected),{code:'B_REVOKE_BINDING_CHANGED'});
});
test('ensureIntent first finishes a pending forget, and cannot create a new intent if cleanup still fails',t=>{
 const f=fixture(t),{expected}=f.setup('COMMITTED');f.credentials.failWrites=2;assert.throws(()=>f.pairing().forget(expected),{code:'EIO'});const count=f.store().db.prepare('SELECT COUNT(*) AS n FROM b_pair_intents').get().n;assert.throws(()=>f.store().ensureIntent(f.credentials),{code:'EIO'});assert.equal(f.store().db.prepare('SELECT COUNT(*) AS n FROM b_pair_intents').get().n,count);assert.ok(f.store().siteForget());assert.ok(f.store().ensureIntent(f.credentials).intent_id);assert.equal(f.store().siteForget(),null);assert.equal(f.credentials.get('site_b'),null);
});
test('a credential replacement which succeeds but loses its confirmation is safe to finish after reload',t=>{
 const f=fixture(t),{expected}=f.setup('COMMITTED',{previous:true});f.credentials.failAfterWrites=1;assert.throws(()=>f.pairing().forget(expected),{code:'EIO'});assert.deepEqual(f.credentials.readAll(),other);assert.ok(f.store().siteForget());f.restart().recoverSiteCommit(f.credentials);assertForgotten(f);
});
for(const section of ['site_b','site_b_stage'])test('forget refuses a different '+section+' identity and retains its materials and commit',t=>{
 const f=fixture(t),{expected}=f.setup('COMMITTED',{previous:true});const all=f.credentials.readAll();all[section]={...all[section],binding_id:crypto.randomUUID()};f.credentials.writeAll(all);assert.throws(()=>f.pairing().forget(expected),{code:'B_REVOKE_BINDING_CHANGED'});assert.deepEqual(f.credentials.readAll(),all);assert.equal(f.store().siteCommit().phase,'COMMITTED');assert.equal(f.store().siteForget(),null);
});
test('cleanup never clears newer credential identity inserted while a forget decision is pending',t=>{
 const f=fixture(t),{expected}=f.setup('COMMITTED');f.credentials.failWrites=1;assert.throws(()=>f.pairing().forget(expected),{code:'EIO'});const all=f.credentials.readAll();all.site_b=f.material(crypto.randomUUID(),99);all.site_b_machine={site_id:all.site_b.site_id,site_origin:all.site_b.site_origin,bearer:'synthetic-newer-material'};f.credentials.writeAll(all);f.restart();assert.throws(()=>f.store().recoverSiteCommit(f.credentials),{code:'B_REVOKE_BINDING_CHANGED'});assert.deepEqual(f.credentials.readAll(),all);assert.ok(f.store().siteForget());
});
test('a PREPARED commit which no longer belongs to the route cannot be cancelled by forget',t=>{
 const f=fixture(t);f.setup('PREPARED',{previous:true});const next=f.material(crypto.randomUUID(),3);f.store().configureSite(next,{authenticated:true});const expected={binding_id:next.binding_id,generation:next.generation},before=f.credentials.readAll();assert.throws(()=>f.pairing().forget(expected),{code:'B_REVOKE_BINDING_CHANGED'});assert.equal(f.store().siteCommit().phase,'PREPARED');assert.deepEqual(f.credentials.readAll(),before);assert.equal(f.store().siteForget(),null);
});
test('forget keeps highwater, revocation and terminal result evidence while cancelling admitted work',t=>{
 const f=fixture(t),{expected}=f.setup('COMMITTED');f.store().recoverSiteCommit(f.credentials);const local=f.store();local.health('site',{state:'healthy',verified:true,nonceEcho:true,generation:expected.generation});local.switchUser('site',{windowGesture:true});
 const spec=()=>({op_id:crypto.randomUUID(),route:'site',principal:'site:fixture-owner',binding_id:expected.binding_id,generation:expected.generation,tool_name:'read_file',request_digest:'b'.repeat(64),created_at:now,start_before:now+10000});
 const completed=spec(),admitted=spec();local.admit(completed,{authenticated:true});local.start(completed.op_id,completed);local.complete(completed.op_id,completed,{ok:true});local.admit(admitted,{authenticated:true});const terminal=local.op(completed.op_id),highwater=local.db.prepare('SELECT * FROM b_binding_highwater').all();local.revokeSite({...expected,authenticatedNative:true});f.pairing().forget(expected);
 assert.deepEqual(local.op(completed.op_id),terminal);assert.equal(local.op(admitted.op_id).state,'cancelled');assert.deepEqual(local.db.prepare('SELECT * FROM b_binding_highwater').all(),highwater);assert.equal(local.revocationPending(expected.binding_id,expected.generation),true);assertForgotten(f);
});
test('ordinary COMMITTED recovery without a forget still promotes and clears its own transaction',t=>{
 const f=fixture(t),{commit}=f.setup('COMMITTED',{previous:true});const local=f.restart();assert.deepEqual(local.recoverSiteCommit(f.credentials),{recovered:true,phase:'committed'});assert.equal(local.siteCommit(),null);assert.equal(f.credentials.get('site_b').binding_id,commit.binding_id);assert.equal(local.route('site').binding_id,commit.binding_id);assert.equal(local.siteForget(),null);assert.deepEqual(f.credentials.get('openai_fixture'),other.openai_fixture);
});

test('pair recovery also gives a pending forget priority over its orphan cleanup path',t=>{
 const f=fixture(t),{expected}=f.setup('COMMITTED',{recovery:true});f.credentials.failWrites=1;assert.throws(()=>f.pairing().forget(expected),{code:'EIO'});assert.equal(f.store().pairRecovery(f.credentials),null);assertForgotten(f);
});
test('new intent material while forget is pending is retained as an identity conflict',t=>{
 const f=fixture(t),{expected}=f.setup('COMMITTED');f.credentials.failWrites=1;assert.throws(()=>f.pairing().forget(expected),{code:'EIO'});const all=f.credentials.readAll();all.site_b_intents={...all.site_b_intents,[crypto.randomUUID()]:'synthetic-new-intent-material'};f.credentials.writeAll(all);assert.throws(()=>f.store().recoverSiteCommit(f.credentials),{code:'B_REVOKE_BINDING_CHANGED'});assert.deepEqual(f.credentials.readAll(),all);assert.ok(f.store().siteForget());
});
test('a failed authority transaction rolls back the forget decision, commit cancellation and route together',t=>{
 const f=fixture(t),{expected}=f.setup('COMMITTED',{previous:true,recovery:true}),local=f.store(),before=f.credentials.readAll(),route=local.route('site'),commit=local.siteCommit(),forget=local.forgetRouteInside;
 t.mock.method(local,'forgetRouteInside',()=>{throw Object.assign(Error('ordinary injected authority failure'),{code:'EIO'});});assert.throws(()=>f.pairing().forget(expected),{code:'EIO'});assert.deepEqual(local.route('site'),route);assert.deepEqual(local.siteCommit(),commit);assert.equal(local.siteForget(),null);assert.ok(local.db.prepare('SELECT * FROM b_pair_recovery').get());assert.deepEqual(f.credentials.readAll(),before);t.mock.restoreAll();assert.equal(local.forgetRouteInside,forget);f.pairing().forget(expected);assertForgotten(f);
});
