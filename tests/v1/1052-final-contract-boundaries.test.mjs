// ONE1052 final source-only affected contracts. No Site, Keychain, browser,
// daily process, build, install, or ChatGPT host calls are made by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {TOOLS} from '../../app/tools.mjs';
import {manifest} from '../../app/product.mjs';
import {generatedFiles} from '../../scripts/generate-version.mjs';
import {candidateUpgradeContract,verifyUpgradeContract} from '../../scripts/upgrade.mjs';
import {bundledSiteTarget} from '../../app/v1/b-site-trust.mjs';
import {BSitePairing} from '../../app/v1/b-site-pairing.mjs';
import {readPinnedSiteTemplate} from '../../app/v1/site-template-pin.mjs';
import {pairingBytesV2,edSign,rawPublicFromKey,encodeUrl64} from '../../app/v1/b-site-wire.mjs';

const repo=new URL('../../',import.meta.url);
const source=file=>fs.readFileSync(new URL("../../"+file,import.meta.url),'utf8');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const pkg=JSON.parse(source('package.json'));
const api=31;
const frozen=JSON.parse(source(`contracts/tools-v${api}.json`));
const old=JSON.parse(source('contracts/tools-v23.json'));

test('current immutable API definitions match the actual source tool schemas',()=>{
 assert.ok(Number.isSafeInteger(pkg.kenBridge.build_number)&&pkg.kenBridge.build_number>0);
 assert.equal(pkg.kenBridge.connector_api,api);
 assert.equal(manifest(TOOLS).connector_api,api);
 assert.equal(TOOLS.length,83);
 assert.deepEqual(TOOLS,frozen);
 assert.equal(manifest(TOOLS).schema_sha256,sha(JSON.stringify(frozen)));
 // API31 is locked, including every description and input schema.
 assert.equal(manifest(TOOLS).schema_sha256,'e1efe40af7052861d05103c20abecd9fc429824e6c040d4bb44efac2289bf05f');
 assert.equal(sha(JSON.stringify(old)),'34bb2398a68232b6d10d5350c4980b0cd6de1772b1d2b2870b43b76cae9379ea');
 const previous=new Map(old.map(t=>[t.name,t]));
 assert.deepEqual(TOOLS.filter(t=>!previous.has(t.name)).map(t=>t.name),['records_export','matter_write','matter_query','chathand_guide','chathand_host_flow_commit','run_capability']);
 assert.equal(TOOLS.filter(t=>previous.has(t.name)&&JSON.stringify(t)!==JSON.stringify(previous.get(t.name))).length,61);
 // Ken-approved item4 changed the widget source hash, so all three public
 // image-card descriptors now differ from API23 as well.
 for(const name of ['image_batch_start','image_batch_save','image_batch_status'])assert.notEqual(TOOLS.find(t=>t.name===name)._meta.ui.resourceUri,previous.get(name)._meta.ui.resourceUri);
 assert.deepEqual(old.filter(t=>!TOOLS.some(v=>v.name===t.name)).map(t=>t.name),['request_permission'],'API31 freezes the intentional retired-name boundary');
});

test('generated app version matches the build while the CWS version remains independently frozen',()=>{
 const files=generatedFiles(pkg);
 for(const [file,content] of Object.entries(files))
  assert.equal(source(file),content,'generated file stale: '+file);
 const browser=JSON.parse(source('browser-extension/manifest.json'));
 // Chrome Web Store is versioned independently from the desktop app build.
 assert.equal(browser.version,'1.0.0.1080');
 assert.equal(browser.version_name,'1.0.0-beta.30 (1080)');
 assert.equal(JSON.parse(source('plugins/chathand/.codex-plugin/plugin.json')).version,pkg.version);
});

test('upgrade expected is read from a candidate frozen payload, never user params or API23 lock',t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'one1052-contract-source-'));
 t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const runtime=path.join(tmp,'candidate-source','Contents','Resources','runtime');
 fs.mkdirSync(path.join(runtime,'contracts'),{recursive:true});
 fs.writeFileSync(path.join(runtime,'package.json'),source('package.json'));
 fs.writeFileSync(path.join(runtime,'contracts',`tools-v${api}.json`),source(`contracts/tools-v${api}.json`));
 const expected=candidateUpgradeContract(path.join(tmp,'candidate-source'),{platform:'darwin'});
 assert.deepEqual(expected,manifest(TOOLS));
 assert.equal(verifyUpgradeContract(manifest(TOOLS),expected),true);
 for(const wrong of [{connector_api:23},{tool_count:expected.tool_count-1},{schema_sha256:'a'.repeat(64)}])
  assert.throws(()=>verifyUpgradeContract({...expected,...wrong},expected),/TOOLS_MISMATCH/);
 const server=source('app/server.mjs');
 assert.match(server,/refreshContract=manifest\(TOOLS\)/);
 assert.match(server,/expected:\(\)=>\(\{\.\.\.refreshIdentity/);
 assert.doesNotMatch(server,/expected:\(\)=>\(\{\.\.\.params/);
});

test('B source transport is explicitly unconfigured; synthetic grant is not accepted',async()=>{
 const deployments=JSON.parse(source('connectors/site-b-targets.json')).deployments;
 assert.deepEqual(deployments,[]);
 assert.equal(bundledSiteTarget('site_fixture_1052'),null);
 const fake={snapshot:()=>({selected:'site',routes:{site:{configured:false,health_fresh:false,generation:0,site_id:null}}}),siteOrigin:()=>null};
 const pairing=new BSitePairing({installationId:'11111111-1111-4111-8111-111111111111',
  localStore:fake,credentials:{},resolveDeployment:async()=>{throw Error('must not call untrusted target resolver')},
  transport:null,templatePin:()=>null});
 assert.equal(pairing.snapshot().transport_adapter_configured,false);
 await assert.rejects(pairing.importGrant({
  site_id:'site_fixture_1052',site_origin:'https://site-b.example',
  enrollment_grant:'a'.repeat(64)
 },{nativeUI:true}),e=>e.code==='B_SITE_TRANSPORT_UNAVAILABLE');
 assert.equal(pairing.pending,null);
 assert.equal(pairing.snapshot().configured,false);
});

test('F11 native paste validates owner/source, format and current intent/installation without a foreground gesture',async()=>{
 const swift=source('native/main.swift'),host=source('ui/h10/host.mjs');
 assert.match(swift,/message\.frameInfo\.isMainFrame,let page=message\.frameInfo\.request\.url,page\.scheme=="http",page\.host=="127\.0\.0\.1",page\.port==URL\(string:origin\)\?\.port/);
 assert.match(swift,/case "pasteSiteGrant":[\s\S]{0,120}guard interfaceKeyShared && ownsService/);
 assert.match(host,/!e\.metaKey\|\|e\.key\.toLowerCase\(\)!=='v'\|\|!overlay\.contains\(document\.activeElement\)/);
 assert.match(host,/native\?\.\('pasteSiteGrant',\{trigger:'command_v'\}\)/);assert.doesNotMatch(host,/enrollment_grant\s*:/);
 const installation='11111111-1111-4111-8111-111111111111',body={format:'chathand-site-v2',site_id:'synthetic_assertion',site_origin:'https://synthetic-assertion.chatgpt.site',service_credential:'synthetic-assertion-fixture'.padEnd(48,'x')},pin=readPinnedSiteTemplate();let now=1700000000000,hasIntent=true,alter=claim=>claim,completeCalls=0;
 const key=crypto.generateKeyPairSync('ed25519'),intent={intent_id:'22222222-2222-4222-8222-222222222222',secret:'synthetic-intent-only'},expectedHash='a'.repeat(64),localStore={route:()=>({binding_id:null,generation:0,configured:0}),selection:()=>({revision:0}),pairRecovery:()=>null,activeIntent:()=>hasIntent?intent:null,intentByHash:hash=>hasIntent&&hash===expectedHash?intent:null},credentials={get:()=>null};
 const transport={epoch:0,async beginV2(request){const claim=alter({protocol_version:'2',site_id:body.site_id,site_origin:body.site_origin,owner_subject:'fixture-owner',installation_id:request.installation_id,device_public_key_id:request.public_key_id,pairing_id:'33333333-3333-4333-8333-333333333333',client_nonce:request.client_nonce,server_nonce:encodeUrl64(Buffer.alloc(32,1)),issued_at:String(now/1000),expires_at:String(now/1000+240),pairing_hash:expectedHash,template_version:pin.template_version,manifest_sha256:pin.manifest_sha256,site_public_key:encodeUrl64(rawPublicFromKey(key.publicKey))});return {claim,site_signature:edSign(key.privateKey,pairingBytesV2(claim))};},async completeRecoveredV2(){completeCalls++;throw Error('must not complete a rejected claim');}};
 const pairing=new BSitePairing({installationId:installation,credentials,localStore,resolveDeployment:async()=>null,transport,templatePin:()=>pin,now:()=>now});
 await assert.rejects(()=>pairing.importGrant(body),{code:'B_PAIRING_INPUT'});
 await assert.rejects(()=>pairing.importGrant({...body,format:'foreign-format'},{nativeUI:true}),{code:'B_PAIRING_INPUT'});
 await assert.rejects(()=>pairing.importGrant({...body,extra:true},{nativeUI:true}),{code:'B_PAIRING_INPUT'});
 await assert.rejects(()=>pairing.importGrant({...body,site_origin:'https://foreign.example.test'},{nativeUI:true}),{code:'B_ORIGIN_INVALID'});
 hasIntent=false;await assert.rejects(()=>pairing.importGrant(body,{nativeUI:true}),{code:'B_PAIRING_INTENT_MISSING'});hasIntent=true;
 for(const mutate of [claim=>({...claim,installation_id:'44444444-4444-4444-8444-444444444444'}),claim=>({...claim,pairing_hash:'b'.repeat(64)})]){alter=mutate;assert.equal((await pairing.importGrant(body,{nativeUI:true})).accepted,true);await assert.rejects(()=>pairing.pairV2(),{code:'B_PAIRING_BINDING'});assert.equal(pairing.pending,null);}
 alter=claim=>claim;assert.equal((await pairing.importGrant(body,{nativeUI:true})).accepted,true);const begin=transport.beginV2;transport.beginV2=async request=>({...await begin(request),site_signature:encodeUrl64(Buffer.alloc(64))});await assert.rejects(()=>pairing.pairV2(),{code:'B_PAIRING_SIGNATURE'});
 await pairing.importGrant(body,{nativeUI:true});now=pairing.pending.expires_at+1;await assert.rejects(()=>pairing.pairV2(),{code:'B_GRANT_EXPIRED'});assert.equal(completeCalls,0);
});

test('H10 completion remains unavailable without independent current-installation host proof',()=>{
 const store=source('app/v1/b-site-store.mjs'),host=source('ui/h10/host.mjs');
 assert.match(store,/host_attestation:[^;\n]*'not_verified'/);
 assert.match(host,/host_attestation==='verified_current_installation'/);
 assert.match(host,/r\?\.source==='trusted_host'/);
 assert.match(host,/r\?\.site_id===b\.routes\.site\.site_id/);
 assert.match(host,/r\?\.generation===b\.routes\.site\.generation/);
 assert.doesNotMatch(source('app/server.mjs'),/host_attestation:\s*'verified_current_installation'/);
});
