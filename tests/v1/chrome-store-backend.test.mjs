import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {chromeDistribution,legacyChromeDistribution,requireLegacyInstaller} from '../../app/v1/chrome-distribution.mjs';
import {CHROME_STORE_ACTIONS,CHROME_STORE_REQUIRED_FEATURES,chromeStoreCompatibility} from '../../app/v1/chrome-store-contract.mjs';
import {chromeStoreStatus} from '../../app/v1/chrome-store-status.mjs';
import {storeHostMessageAllowed} from '../../app/v09/extension-host.mjs';
import {chromeStoreProfiles,validStoreProfile} from '../../app/v1/chrome-store-profiles.mjs';
import {ExtensionBrowser} from '../../app/v09/extension-browser.mjs';
import {ChromeInstallProbe} from '../../app/v1/chrome-install-probe.mjs';
import {publishHelper} from '../../app/v1/chrome-helper-source.mjs';
import {registerBrowserHost} from '../../app/v09/local-setup.mjs';
import {ensureBrowserHost,Repair} from '../../app/v1/repair.mjs';
import {ToolsRefresher} from '../../app/v1/tools-refresh.mjs';
// Ephemeral synthetic public identity for unit fixtures only. Never written into product config or a ZIP.
const {publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const der=publicKey.export({type:'spki',format:'der'}),key=der.toString('base64');
const id=[...crypto.createHash('sha256').update(der).digest().subarray(0,16)].map(v=>String.fromCharCode(97+(v>>4),97+(v&15))).join('');
const config={distribution:'chrome_web_store',extension_id:id,store_url:`https://chromewebstore.google.com/detail/${id}`,published:false};
const ready=chromeDistribution(config,{key}),pending=chromeDistribution();
const helper={version:'0.0.1',actions:[...CHROME_STORE_ACTIONS],features:[...CHROME_STORE_REQUIRED_FEATURES]};
function fixture(distribution=ready){const state={data:{browser_enabled:true,mode:'auto',extension_last_seen:Date.now()},project:()=>({path:'/synthetic'}),save(){}},policy={epoch:1,check(){},require(){},emit(){},tasks:new Map([['task',{status:'active'}]])},ext=new ExtensionBrowser(state,{},policy,{distribution});return {state,policy,ext};}
test('store config is pending by default, rejects old ID/key mismatch and noncanonical URLs; no product values are fabricated',()=>{
 assert.equal(ready.configuration_state,'ready');assert.equal(ready.store_published,false);assert.equal(pending.extension_id,null);
 for(const c of [undefined,{}, {...config,extension_id:'fdkpegpobipiidkdcjldomfbkemjdpfd'},{...config,extension_id:'a'.repeat(32)},{...config,store_url:'https://example.invalid/'+id},{...config,store_url:config.store_url+'?x=1'},{...config,store_url:'https://chromewebstore.google.com.evil/detail/'+id}])assert.equal(chromeDistribution(c,{key}).configuration_state,'pending');
 assert.equal(chromeDistribution(config,{key:'bad'}).configuration_state,'pending');assert.throws(()=>requireLegacyInstaller(pending),{code:'CHROME_INSTALL_LEGACY_DISABLED'});assert.doesNotThrow(()=>requireLegacyInstaller(legacyChromeDistribution()));
});
test('fixed v1 capabilities ignore version equality, optional language/self_reload and unknown features',()=>{
 assert.equal(CHROME_STORE_ACTIONS.length,23);assert.equal(chromeStoreCompatibility(helper).state,'compatible');
 assert.equal(chromeStoreCompatibility({...helper,version:'9999',features:[...helper.features,'self_reload','PRIVATE']}).state,'compatible');
 for(const action of CHROME_STORE_ACTIONS)assert.deepEqual(chromeStoreCompatibility({...helper,actions:helper.actions.filter(v=>v!==action)}).missing_actions,[action]);
 for(const feature of CHROME_STORE_REQUIRED_FEATURES)assert.deepEqual(chromeStoreCompatibility({...helper,features:helper.features.filter(v=>v!==feature)}).missing_features,[feature]);
 assert.equal(chromeStoreCompatibility(null).state,'unknown');assert.equal(chromeStoreCompatibility({...helper,actions:'all'}).state,'incompatible');
});
test('installation observation is new-ID scoped and independent of live connection',()=>{
 const old={extension_id:'a'.repeat(32),last_seen:5};assert.equal(chromeStoreStatus(ready,{observation:old}).installed,null);
 const observed={extension_id:id,last_seen:5};assert.equal(chromeStoreStatus(ready,{observation:observed,now:20000}).installation_state,'observed');assert.equal(chromeStoreStatus(ready,{observation:observed}).connected,false);
 const live=chromeStoreStatus(ready,{observation:observed,session:'s',lastSeen:100,now:101});assert.equal(live.connected,true);assert.equal(live.installation_state,'observed');assert.equal(chromeStoreStatus(pending,{observation:observed,session:'s',lastSeen:100,now:101}).installed,null);
});
test('bare constructors and publish/host preparation are pending with no Chrome file effects',async()=>{
 const {ext}=fixture(pending);assert.equal(ext.status().installation_state,'unknown');assert.throws(()=>ext.heartbeat(crypto.randomUUID()),{code:'CHROME_STORE_CONFIGURATION_PENDING'});assert.throws(()=>ext.request('snapshot',{},'caller','task'),{code:'CHROME_STORE_CONFIGURATION_PENDING'});
 const probe=new ChromeInstallProbe({});assert.throws(()=>probe.begin('Default'),{code:'CHROME_INSTALL_LEGACY_DISABLED'});assert.equal(probe.next('s'),null);
 assert.throws(()=>publishHelper({root:'/not-used',home:'/not-used',distribution:pending}),{code:'CHROME_INSTALL_LEGACY_DISABLED'});
 const io=new Proxy({},{get(){assert.fail('unexpected Chrome I/O')}});assert.equal(registerBrowserHost({root:'/not-used',home:'/not-used',io,distribution:pending}).registered,false);
 assert.equal(await ensureBrowserHost({distribution:pending,snapshot:async()=>({settings:{browser_enabled:true}}),io}),'pending');
 const refresh=new ToolsRefresher({invoke(){assert.fail('pending refresh made tool call')}});assert.equal((await refresh.waitHelper('update')).code,'CHROME_STORE_CONFIGURATION_PENDING');await ext.closeAll();
});
test('new-ID heartbeat completes observation without old installation probe/reload; current version alone cannot dispatch',async t=>{
 const {ext,state}=fixture();t.after(()=>ext.closeAll());ext.installProbe={next(){assert.fail('legacy probe')},stop(){assert.fail('legacy stop')}};ext.expected={version:'9999'};
 const session=crypto.randomUUID();ext.next(session,helper);ext.next(session,helper);assert.equal(ext.status().connected,true);assert.equal(ext.status().installation_state,'observed');assert.equal(state.data.chrome_store_observation.extension_id,id);assert.equal(ext.reloadControl(),null);assert.equal(ext.expectedHelper(),null);
 const request=ext.request('snapshot',{},'caller','task');request.catch(()=>{});const sent=ext.next(session,helper);assert.equal(sent.kind,'request');assert.equal(ext.authorize(session,sent.id).authorized,true);ext.complete(session,sent.id,{ok:true});assert.deepEqual(await request,{ok:true});
 ext.noteHelper(session,{...helper,version:'9999',features:[]});assert.throws(()=>ext.request('snapshot',{},'caller','task'),{code:'CHROME_STORE_INCOMPATIBLE'});assert.equal(ext.status().connected,true);assert.equal(ext.status().installation_state,'observed');
});
test('capability downgrade and revocation reject queued/delivered results; no automatic replay',async t=>{
 const {ext,state}=fixture();t.after(()=>ext.closeAll());const session=crypto.randomUUID();ext.next(session,helper);ext.pauseRequested=false;
 const p=ext.request('click',{},'caller','task');p.catch(()=>{});ext.next(session,{...helper,actions:[]});await assert.rejects(p,{code:'CHROME_STORE_INCOMPATIBLE'});assert.equal(ext.pending.size,0);
 ext.noteHelper(session,helper);const q=ext.request('snapshot',{},'caller','task');q.catch(()=>{});const sent=ext.next(session,helper);state.data.browser_enabled=false;ext.complete(session,sent.id,{should_not_land:true});await assert.rejects(q,{code:'TASK_REVOKED'});assert.equal(ext.pending.size,0);
});
test('profile chooser reads only Local State basic names; selected profile is not an install receipt',()=>{
 const paths=[];const io={lstatSync(file){paths.push(file);return {isFile:()=>true,isSymbolicLink:()=>false,size:100}},realpathSync:f=>f,readFileSync(file){paths.push(file);return JSON.stringify({profile:{info_cache:{Default:{name:'Main',email:'PRIVATE'},'Profile 1':{name:'Work',extensions:'PRIVATE'},'../escape':{name:'PRIVATE'}}}})}};
 assert.deepEqual(chromeStoreProfiles({home:'/synthetic',io,profile_id:'Profile 1'}),{profiles:[{id:'Default',name:'Main'},{id:'Profile 1',name:'Work'}],selected_profile:'Profile 1'});
 assert.ok(paths.every(f=>f.endsWith('/Local State')));assert.throws(()=>chromeStoreProfiles({home:'/synthetic',io,profile_id:'../x'}),{code:'CHROME_STORE_PROFILE_INVALID'});
});
test('refresh uses compatible connected store helper, not matching build or old-folder statuses',async()=>{
 const refresher=new ToolsRefresher({distribution:ready,invoke(){}});refresher.call=async()=>({selected_backend:'extension',extension:{connected:true,compatibility:{state:'compatible'},helper:{state:'wrong_folder',version:'old'}}});assert.deepEqual(await refresher.waitHelper('update'),{ok:true});
 refresher.call=async()=>({selected_backend:'extension',extension:{connected:true,compatibility:{state:'incompatible'}}});assert.equal((await refresher.waitHelper('update')).code,'CHROME_STORE_INCOMPATIBLE');
});
function serverFixture(distribution=ready){
 const source=fs.readFileSync(new URL('../../app/server.mjs',import.meta.url),'utf8');
 const start=source.indexOf("  case'/api/browser/extension/store/status':"),end=source.indexOf("  case'/api/browser/extension/reconnect':",start);assert.ok(start>0&&end>start);
 const pendingRegistrations=[],calls={profiles:0,register:0,optIn:0};
 const context={chromeDistribution:distribution,storePreparation:0,windowAuthorized:false,policy:{epoch:1,permissionRevision:0,check(){}},tools:{upgradePending:false},permissionChangePending:false,permissionRevocations:{blocked:false},state:{data:{browser_enabled:true}},capabilityOn:state=>state.data.browser_enabled!==false,storeMode:d=>d.distribution!=='legacy_unpacked',localHome:'/synthetic',storeStatus:()=>({connected:false}),chromeStoreProfiles:()=>{calls.profiles++;return {profiles:[{id:'Default',name:'Main'},{id:'Profile 1',name:'Work'}],selected_profile:null}},registerCurrentBrowserHost:async()=>{calls.register++;return await new Promise(resolve=>pendingRegistrations.push(resolve));},rememberBrowserOptIn:()=>calls.optIn++,fail:(code,message)=>{throw Object.assign(Error(message),{code})}};
 vm.createContext(context);vm.runInContext('async function run(route,d,windowAuthorized=false){switch(route){'+source.slice(start,end)+'}}',context);
 return {context,calls,pendingRegistrations,run:(route,data,windowAuthorized=false)=>context.run(route,data,windowAuthorized)};
}
test('actual prepare route returns pending fields before any Chrome read or host registration',async()=>{
 const f=serverFixture(pending),out=await f.run('/api/browser/extension/prepare',{});assert.equal(out.store_ready,false);assert.equal(out.config_state,'pending');assert.equal(out.error.code,'CHROME_STORE_CONFIGURATION_PENDING');assert.equal(out.extension_id,null);assert.deepEqual(f.calls,{profiles:0,register:0,optIn:0});
 await assert.rejects(f.run('/api/browser/extension/prepare',{store_url:'https://evil.invalid'}),{code:'ARG_INVALID'});
});
test('actual prepare/cancel rejects delayed old registration acknowledgement without profile verification or lease',async()=>{
 const f=serverFixture(),old=f.run('/api/browser/extension/prepare',{});old.catch(()=>{});assert.equal(f.calls.register,1);await f.run('/api/browser/extension/store/cancel',{});
 const current=f.run('/api/browser/extension/prepare',{});f.pendingRegistrations[0]({registered:true});await assert.rejects(old,{code:'INSTALL_ACCESS_CHANGED'});f.pendingRegistrations[1]({registered:true});const out=await current;
 assert.equal(out.distribution,'chrome_web_store');assert.equal(out.store_ready,true);assert.equal(out.store_published,false);assert.equal(out.selected_profile,null);assert.equal(out.profiles.length,2);assert.equal(out.lease_id,undefined);assert.equal(out.profile_verified,undefined);assert.equal(out.opened,undefined);
});
test('default-on store installation succeeds on the first Open Chrome after cancel and on Try Again',async()=>{
 const f=serverFixture();delete f.context.state.data.browser_enabled;
 await f.run('/api/browser/extension/store/cancel',{});
 for(let i=0;i<2;i++){
  const pending=f.run('/api/browser/extension/prepare',{},true);
  assert.equal(f.calls.register,i+1);
  f.pendingRegistrations[i]({registered:true});
  assert.equal((await pending).registered,true);
 }
 assert.equal(f.calls.optIn,2);
});
test('explicit store opt-in normalizes only an enabled default and rolls back a failed save',()=>{
 const source=fs.readFileSync(new URL('../../app/server.mjs',import.meta.url),'utf8'),start=source.indexOf(' function rememberBrowserOptIn('),end=source.indexOf(' function explicitBrowserInstallation(',start);
 for(const browser_enabled of [undefined,false,true]){
  let saves=0;const state={data:{...(browser_enabled===undefined?{}:{browser_enabled})},save(){saves++;}};
  const context={state,capabilityOn:()=>state.data.browser_enabled!==false};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  assert.equal(context.rememberBrowserOptIn(),browser_enabled===true);
  if(browser_enabled!==true)assert.equal(saves,0);
  assert.equal(context.rememberBrowserOptIn({defaultEnabled:true}),browser_enabled!==false);
  if(browser_enabled!==false){assert.equal(state.data.browser_enabled,true);assert.equal(state.data.browser_control_opt_in,true);}
 }
 const state={data:{},save(){throw Error('synthetic save failure');}},context={state,capabilityOn:()=>true};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 assert.throws(()=>context.rememberBrowserOptIn({defaultEnabled:true}),/synthetic save failure/);assert.deepEqual(state.data,{});
});
test('explicit store preparation cannot register after profile inspection changes authority or cancels its generation',async()=>{
 for(const change of ['browser','epoch','revision','cancel']){
  const f=serverFixture(),profiles=f.context.chromeStoreProfiles;
  f.context.chromeStoreProfiles=()=>{const result=profiles();if(change==='browser')f.context.state.data.browser_enabled=false;if(change==='epoch')f.context.policy.epoch++;if(change==='revision')f.context.policy.permissionRevision++;if(change==='cancel')f.context.storePreparation++;return result;};
  await assert.rejects(f.run('/api/browser/extension/prepare',{}),{code:'INSTALL_ACCESS_CHANGED'});
  assert.equal(f.calls.profiles,1);assert.equal(f.calls.register,0);
 }
});
test('actual registration wrapper never probes/publishes helper files in store mode or when pending',async()=>{
 const source=fs.readFileSync(new URL('../../app/server.mjs',import.meta.url),'utf8'),a=source.indexOf(' async function registerCurrentBrowserHost('),b=source.indexOf(' function withBrowserHostStatus(',a);assert.ok(a>0&&b>a);
 for(const distribution of [pending,ready]){
  let registrations=0;const context={chromeDistribution:distribution,storeMode:d=>d.distribution!=='legacy_unpacked',browserControlOptedIn:()=>true,state:{data:{}},tools:{upgradePending:false},browserHostPending:null,browserHostDenied:null,browserHostStatus:null,fs:new Proxy({},{get(){assert.fail('legacy helper filesystem read')}}),publishHelper(){assert.fail('legacy publication')},browserHost:{async register(){registrations++;return {registered:true}}},eventChanged(){},cleanError:e=>e,fail(code){throw Object.assign(Error(code),{code})}};
  vm.createContext(context);vm.runInContext(source.slice(a,b),context);const out=await context.registerCurrentBrowserHost();assert.equal(out.registered,distribution===ready);assert.equal(registrations,distribution===ready?1:0);
 }
});
test('actual registration recovery shares one pending attempt, retains a persistent denial and clears it only on success',async()=>{
 const source=fs.readFileSync(new URL('../../app/server.mjs',import.meta.url),'utf8'),a=source.indexOf(' async function registerCurrentBrowserHost('),b=source.indexOf(' function withBrowserHostStatus(',a);assert.ok(a>0&&b>a);
 let registrations=0;const flights=[];
 const context={chromeDistribution:ready,storeMode:d=>d.distribution!=='legacy_unpacked',browserControlOptedIn:()=>true,state:{data:{}},tools:{upgradePending:false},browserHostPending:null,browserHostDenied:{code:'CHROME_DATA_ACCESS_DENIED',message:'synthetic denial'},browserHostStatus:{status:'failed'},fs:new Proxy({},{get(){assert.fail('legacy helper filesystem access')}}),publishHelper(){assert.fail('legacy publication')},browserHost:{register(){registrations++;return new Promise((resolve,reject)=>flights.push({resolve,reject}));}},eventChanged(){},cleanError:e=>e,fail(code){throw Object.assign(Error(code),{code});}};
 vm.createContext(context);vm.runInContext(source.slice(a,b),context);
 const first=context.registerCurrentBrowserHost({retryAfterPermission:true}),second=context.registerCurrentBrowserHost({retryAfterPermission:true});
 const rejected=[assert.rejects(first,{code:'CHROME_DATA_ACCESS_DENIED'}),assert.rejects(second,{code:'CHROME_DATA_ACCESS_DENIED'})];assert.equal(registrations,1);
 flights[0].reject(Object.assign(Error('synthetic denial persists'),{code:'CHROME_DATA_ACCESS_DENIED'}));await Promise.all(rejected);assert.equal(context.browserHostDenied.code,'CHROME_DATA_ACCESS_DENIED');
 await assert.rejects(context.registerCurrentBrowserHost(),{code:'CHROME_DATA_ACCESS_DENIED'});assert.equal(registrations,1);
 const current=context.registerCurrentBrowserHost({retryAfterPermission:true});assert.equal(registrations,2);assert.equal(context.browserHostDenied.code,'CHROME_DATA_ACCESS_DENIED');flights[1].resolve({registered:true});assert.equal((await current).registered,true);assert.equal(context.browserHostDenied,null);
});
test('actual server gates every retired install route before old handlers',()=>{
 const source=fs.readFileSync(new URL('../../app/server.mjs',import.meta.url),'utf8');const line=source.split('\n').find(line=>line.includes("if(route.startsWith('/api/browser/extension/install/'))"));assert.ok(line);
 const check=new Function('route','requireLegacyInstaller','chromeDistribution',line);
 for(const route of ['profiles','start','status','progress','verify','finish','cancel','evidence'])assert.throws(()=>check('/api/browser/extension/install/'+route,requireLegacyInstaller,pending),{code:'CHROME_INSTALL_LEGACY_DISABLED'});
 assert.match(source,/install-authorize'\|\|req.url==='\/api\/extension\/install-result'\)requireLegacyInstaller/);
 assert.match(source,/if\(chromeDistribution.configuration_state==='ready'\)saveJSON\(extensionFile/);
});
test('store public key may be supplied in App config without mutating the submitted extension ZIP',()=>{
 assert.equal(chromeDistribution({...config,public_key:key},{key:'unrelated-submitted-manifest-key'}).configuration_state,'ready');
});
test('full repair helper step never opens Chrome or starts legacy recovery while configuration is pending',async()=>{
 const repair=new Repair({distribution:pending,registrationOnlyAfterOptIn:true,browserOptIn:true,snapshot:async()=>({enabled:false,settings:{access_enabled:false,browser_enabled:true,desktop_enabled:false},credentials:{healthy:true},automation:{browser:{extension:{connected:false}}}}),systemProxy:async()=> 'direct',openChromeInBackground(){assert.fail('repair opened Chrome')},restoreTunnel(){assert.fail('repair started network')},cleanupUpgrade:async()=>({cleaned:false}),mayReconnect:()=>false});
 const out=repair.start();for(let i=0;i<100&&out.status==='running';i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(out.status,'done');assert.equal(out.items.find(v=>v.id==='browser_helper').code,'CHROME_STORE_CONFIGURATION_PENDING');assert.equal(out.items.find(v=>v.id==='browser_host').code,'CHROME_STORE_CONFIGURATION_PENDING');
});

test('canonical profiles reject leading zeroes and every trailing line separator',()=>{
 for(const id of ['Default','Profile 0','Profile 1','Profile 999999'])assert.equal(validStoreProfile(id),true);
 for(const id of ['Profile 01','Profile 1000000','Default\n','Profile 1\n','Profile 1\r','Profile 1\u2028','Profile 1\u2029'])assert.equal(validStoreProfile(id),false);
 assert.equal(chromeDistribution({...config,store_url:config.store_url+'\n'},{key}).configuration_state,'pending');
 assert.equal(chromeDistribution({...config,store_url:`https://chromewebstore.google.com/detail/slug/${id}`},{key}).configuration_state,'pending');
});
test('store native host cannot forward retired reload or install probe even if a peer asks',()=>{
 assert.equal(storeHostMessageAllowed({control:'reload'}),false);assert.equal(storeHostMessageAllowed({kind:'install_probe'}),false);
 for(const message of [{control:'pause'},{control:'reconnect'},{kind:'request'},{kind:'status'}])assert.equal(storeHostMessageAllowed(message),true);
});
test('actual host registration pins only configured store origin in an isolated synthetic bundle and home',t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-store-host-fixture-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const root=path.join(base,'bundle'),home=path.join(base,'home'),binary=path.join(root,'bin/ChatHandBrowserHost');
 fs.mkdirSync(path.dirname(binary),{recursive:true});fs.writeFileSync(binary,'synthetic fixture only');
 const result=registerBrowserHost({root,home,platform:'darwin',distribution:ready,registrationOnlyAfterOptIn:true,browserEnabled:true,browserOptIn:true});
 assert.equal(result.registered,true);assert.equal(result.extension_id,id);assert.equal(result.extension_folder,undefined);
 const folder=path.join(home,'Library/Application Support/Google/Chrome/NativeMessagingHosts');
 assert.deepEqual(fs.readdirSync(folder),['com.kenyu.chathand.browser.json']);
 const manifest=JSON.parse(fs.readFileSync(path.join(folder,'com.kenyu.chathand.browser.json'),'utf8'));
 assert.deepEqual(manifest.allowed_origins,[`chrome-extension://${id}/`]);assert.equal(manifest.path,binary);
 assert.equal(registerBrowserHost({root,home,platform:'darwin',distribution:ready,registrationOnlyAfterOptIn:true,browserEnabled:true,browserOptIn:true}).backup_paths.length,0);
 assert.equal(fs.existsSync(path.join(home,'Library/Application Support/ChatHand')),false);
});
test('actual runtime publication always uses resolved store identity, including dependency injection against a stale config',()=>{
 const source=fs.readFileSync(new URL('../../app/server.mjs',import.meta.url),'utf8');
 const resolve=source.split('\n').find(line=>line.includes('const chromeDistribution=clientDeps.chromeDistribution??'));
 const publish=source.split('\n').find(line=>line.includes('saveJSON(extensionFile,'));assert.ok(resolve&&publish);
 for(const injected of [ready,pending]){
  const writes=[],context={clientDeps:{chromeDistribution:injected},readChromeDistribution(){assert.fail('injected store configuration was ignored')},pkg:'/synthetic',extensionConfig:{extension_id:'fdkpegpobipiidkdcjldomfbkemjdpfd'},extensionFile:'/synthetic/runtime.json',extensionToken:'synthetic-token',apiPort:1234,saveJSON:(file,value)=>writes.push({file,value})};
  vm.createContext(context);vm.runInContext(resolve+'\n'+publish,context);
  assert.equal(writes.length,injected===ready?1:0);
  if(writes.length)assert.equal(writes[0].value.extension_id,id);
 }
 // The obsolete raw parse must not throw before the resolver can return pending.
 assert.equal(source.includes('extensionConfig='),false);
});

test('profile chooser defaults to the last-used Chrome profile among two profiles',()=>{
 const paths=[],file='/synthetic/Library/Application Support/Google/Chrome/Local State';
 const io={lstatSync:f=>{paths.push(f);return {isFile:()=>true,isSymbolicLink:()=>false,size:100}},realpathSync:f=>{paths.push(f);return f},readFileSync:f=>{paths.push(f);return JSON.stringify({profile:{last_used:'Profile 1',info_cache:{Default:{name:'Main'},'Profile 1':{name:'Work'}}}})}};
 assert.deepEqual(chromeStoreProfiles({home:'/synthetic',io}),{profiles:[{id:'Default',name:'Main'},{id:'Profile 1',name:'Work'}],selected_profile:'Profile 1'});
 assert.ok(paths.every(p=>p===file));
 assert.equal(chromeStoreProfiles({home:'/synthetic',io,profile_id:'Default'}).selected_profile,'Default');
});

test('profile chooser leaves the choice unset when last-used is outside its two-profile list',()=>{
 const io={lstatSync:()=>({isFile:()=>true,isSymbolicLink:()=>false,size:100}),realpathSync:f=>f,readFileSync:()=>JSON.stringify({profile:{last_used:'Profile 9',info_cache:{Default:{name:'Main'},'Profile 1':{name:'Work'}}}})};
 const result=chromeStoreProfiles({home:'/synthetic',io});
 assert.deepEqual(result.profiles,[{id:'Default',name:'Main'},{id:'Profile 1',name:'Work'}]);assert.equal(result.selected_profile,null);
});

// 1081（Claude，Ken 10/27 10:03）：插件只缺后来加的动作（partial）照常用，只有用到缺的那个动作时报 CHROME_STORE_ACTION_UNSUPPORTED；
// 连第一版就有的动作都缺（incompatible）才整个停，请用户更新。
test('1081 a later action the extension does not have yet fails only that action; missing a first-version action stops everything',async t=>{
 const {ext}=fixture();t.after(()=>ext.closeAll());
 ext.storeContract={core:CHROME_STORE_ACTIONS.filter(v=>v!=='detach'),later:['detach']};
 const old={...helper,actions:helper.actions.filter(v=>v!=='detach')},session=crypto.randomUUID();
 ext.next(session,old);ext.next(session,old);
 assert.equal(ext.status().connected,true);assert.equal(ext.status().compatibility.state,'partial');assert.deepEqual(ext.status().compatibility.missing_later_actions,['detach']);
 assert.throws(()=>ext.request('detach',{},'caller','task'),{code:'CHROME_STORE_ACTION_UNSUPPORTED'});
 const request=ext.request('click',{},'caller','task');request.catch(()=>{});const sent=ext.next(session,old);assert.equal(sent.kind,'request');assert.equal(ext.authorize(session,sent.id).authorized,true);ext.complete(session,sent.id,{ok:true});assert.deepEqual(await request,{ok:true});
 ext.noteHelper(session,{...old,actions:old.actions.filter(v=>v!=='click')});
 assert.equal(ext.status().compatibility.state,'incompatible');assert.throws(()=>ext.request('snapshot',{},'caller','task'),{code:'CHROME_STORE_INCOMPATIBLE'});
 assert.equal(chromeStoreCompatibility({...helper,actions:[...helper.actions]},{later:['future_action']}).state,'partial','an action added later is never required');
});

// 1081（Claude，Ken 10/27 10:07）：「浏览器控制」里点「再试一次」：照旧让插件重连，应用店装的插件没连着时再在后台打开 Chrome、等它连上（刚失败过也再试）。
function reconnectFixture({connects=true,wake=true}={}){
 const source=fs.readFileSync(new URL('../../app/server.mjs',import.meta.url),'utf8');
 const start=source.indexOf("  case'/api/browser/extension/reconnect':"),end=source.indexOf("  case'/api/browser/extension/stop':",start);assert.ok(start>0&&end>start);
 const {ext}=fixture(),opened=[];ext.wakeWaitMs=400;ext.wake={at:Date.now(),connected:false};
 ext.wakeChrome=wake?()=>{opened.push(Date.now());if(connects)setTimeout(()=>{const s=crypto.randomUUID();ext.next(s,helper);ext.next(s,helper);},30);}:null;
 const context={chromeDistribution:ready,storeMode:d=>d.distribution!=='legacy_unpacked',requireStoreConfiguration(){},browserControlOptedIn:()=>true,policy:{epoch:1,permissionRevision:0,check(){},transitioning:false},
  tools:{upgradePending:false,automation:{browser:{extension:ext}}},executionResumeAllowed:true,permissionChangePending:false,permissionRevocations:{blocked:false},state:{data:{browser_enabled:true}},
  registerCurrentBrowserHost:async()=>({registered:true}),fail:(code,message)=>{throw Object.assign(Error(message),{code});}};
 vm.createContext(context);vm.runInContext('async function run(route,d){switch(route){'+source.slice(start,end)+'}}',context);
 return {ext,opened,run:()=>context.run('/api/browser/extension/reconnect',{})};
}
test('1081 “Try Again” on a store extension that is not connected reconnects, opens Chrome even right after a failed wake, and reports the result',async t=>{
 const ok=reconnectFixture();t.after(()=>ok.ext.closeAll());const epoch=ok.ext.epoch;
 const r=await ok.run();
 assert.equal(r.reconnecting,true,'the normal reconnect still goes out');assert.notEqual(ok.ext.epoch,epoch);
 assert.equal(ok.opened.length,1,'opens Chrome even though the last wake failed a moment ago');assert.equal(r.woken,true);assert.equal(r.connected,true);assert.equal(ok.ext.wake,null,'a successful wake clears the failure');
 const still=reconnectFixture({connects:false});t.after(()=>still.ext.closeAll());
 const s=await still.run();assert.equal(s.connected,false);assert.equal(still.opened.length,1);assert.equal(still.ext.wake?.connected,false,'still not connected: Browser Use keeps saying so');
 const isolated=reconnectFixture({wake:false});t.after(()=>isolated.ext.closeAll());
 const i=await isolated.run();assert.equal(i.reconnecting,true);assert.equal(i.woken,undefined,'tests and isolated runs never open Chrome');
});
