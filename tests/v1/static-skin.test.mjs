import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {chromium} from 'playwright-core';
import {createDesktop,needsInterface} from '../../app/server.mjs';
import {skinFile,clientSettings,validateClientSettings} from '../../app/v1/client-features.mjs';
import {MANAGEMENT_HTTP_ERRORS,managementHTTPError} from '../../app/v1/management-errors.mjs';
import {cleanError} from '../../engine/src/core.mjs';
import {DESKTOP_ERROR_CODES,BROWSER_ERROR_CODES} from '../../engine/src/control-errors.mjs';

const output=process.env.CHATHAND_STATIC_SKIN_OUTPUT;
const turn=()=>new Promise(setImmediate);
function gate(){let release;const promise=new Promise(resolve=>release=resolve);return {promise,release};}
async function until(predicate){const deadline=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<deadline,'isolated condition timed out');await turn();}}
async function fixture(t,{ui=true}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-static-skin-')),uiKey=ui?'d'.repeat(64):null;
 const f={root,app:null};
 const create=()=>createDesktop({stateDir:path.join(root,'state'),defaultRoot:path.join(root,'work'),uiKey,adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{computerName:()=> 'Isolated Mac',tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',key:'',tunnelId:'',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),updaterFactory:()=>({snapshot:()=>({status:'unknown',install:{state:'idle'}}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})}});
 f.app=await create();f.reopen=async()=>{await f.app.close();f.app=await create();};
 Object.defineProperty(f,'origin',{get:()=>`http://127.0.0.1:${f.app.apiPort}`});
 f.post=async(route,body={},auth='window')=>{const response=await fetch(f.origin+route,{method:'POST',headers:{'Content-Type':'application/json',...(auth==='none'?{}:{Authorization:'Bearer '+f.app.adminToken}),...(auth==='window'&&uiKey?{'X-ChatHand-UI':uiKey}:{})},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
 f.windowURL=query=>f.origin+'/'+(query?'?'+query:'')+'#'+f.app.adminToken+'.'+(uiKey||'');
 t.after(async()=>{await f.app.close();fs.rmSync(root,{recursive:true,force:true});});return f;
}

test('main service serves every index reference, parser registry and approved CSS with query/MIME/CSP; other paths are 404',async t=>{
 const f=await fixture(t),index=await fetch(f.origin+'/?skin=quiet-titanium&skinswitch=0');assert.equal(index.status,200);assert.match(index.headers.get('content-type'),/^text\/html/);
 const html=await index.text(),refs=[...html.matchAll(/\b(?:src|href)="(\/[^"]+)"/g)].map(row=>row[1]);
 assert.ok(refs.includes('/stream.js')&&refs.includes('/morph.js'));
 const css=['/skins/quiet-titanium.css','/skins/default.css'];
 for(const route of new Set([...refs,'/skins/registry.js',...css])){const response=await fetch(f.origin+route+'?skin=default');assert.equal(response.status,200,route);assert.match(response.headers.get('content-type'),/\.m?js$/.test(route)?/^text\/javascript/:/^text\/css/);assert.match(response.headers.get('content-security-policy'),/script-src 'self'/);assert.equal(response.headers.get('x-content-type-options'),'nosniff');}
 const registry=await (await fetch(f.origin+'/skins/registry.js')).text();for(const row of registry.matchAll(/css:'\/skins\/([^']+)\.css'/g))assert.ok(skinFile(row[1]),'registered CSS follows the server filename/existence rule');
 const denied=['/ui/app.js','/app/server.mjs','/app/v1/value-stats.mjs','/docs/plans/v1/1012-ui-contract.md','/desktop.json','/__proto__','/skins/no-such.css','/skins/quiet-titanium.css/extra','/skins/../app.js','/skins/%2e%2e%2fapp.js','/%2e%2e/app/server.mjs','/%73kin.js'];
 for(const route of denied){const code=await new Promise((resolve,reject)=>{const request=http.get({hostname:'127.0.0.1',port:f.app.apiPort,path:route},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);});assert.equal(code,404,route);}
 if(output){fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'static.json'),JSON.stringify({index:200,local_references:[...new Set(refs)],dynamic_registry:200,approved_css:css,denied_paths:denied.length,csp:true,mime:true},null,2));}
});

test('skin settings are typed, owner/window protected, validated before mutation, persistent, and leave tasks/approvals alone',async t=>{
 const f=await fixture(t);assert.equal(clientSettings().skin,'default');assert.equal(clientSettings({skin:'default'}).skin,'default');assert.equal(clientSettings({skin:'unknown'}).skin,'default');assert.equal(needsInterface('/api/settings',{skin:'default'}),true);
 for(const skin of [null,{},'unknown','../../app.js','__proto__',1])assert.throws(()=>validateClientSettings({skin}),{code:'ARG_INVALID'});
 assert.equal((await f.post('/api/settings',{skin:'quiet-titanium'},'none')).status,401);assert.equal((await f.post('/api/settings',{skin:'quiet-titanium'},'owner')).status,403);
 const withoutKey=await fixture(t,{ui:false});assert.equal((await withoutKey.post('/api/settings',{skin:'quiet-titanium'})).status,403);
 const active=f.app.policy.begin({request_id:'skin_active_task',title:'isolated task'},'chatgpt'),task=f.app.policy.tasks.get(active.task_id),status=task.status,approvals=f.app.policy.approvals.size;
 const before=structuredClone(f.app.state.data);
 for(const body of [{notifications:false,skin:'invalid'},{notifications:false,terminal_enabled:'bad',skin:'quiet-titanium'},{keep_awake:true,high_risk:{no_such:true},skin:'quiet-titanium'},{appearance:'dark',show_value:'bad',skin:'quiet-titanium'},{skin:'quiet-titanium',value_plan:'unknown'}]){const result=await f.post('/api/settings',body);assert.equal(result.status,400);assert.equal(result.body.error.code,'ARG_INVALID');assert.deepEqual(f.app.state.data,before);}
 const response=await f.post('/api/settings',{skin:'quiet-titanium'});assert.equal(response.status,200);assert.equal(response.body.skin,'quiet-titanium');assert.equal(response.body.skin_revision,1);assert.equal(task.status,status);assert.equal(f.app.policy.approvals.size,approvals);
 const save=f.app.state.save;f.app.state.save=()=>{throw Object.assign(Error('isolated disk failure'),{code:'ENOSPC'});};const failed=await f.post('/api/settings',{skin:'default'});f.app.state.save=save;assert.equal(failed.status,400);assert.equal(f.app.state.data.skin,'quiet-titanium');assert.equal(f.app.state.data.skin_revision,1);
 const disk=JSON.parse(fs.readFileSync(path.join(f.root,'state/desktop.json')));assert.equal(disk.skin,'quiet-titanium');assert.equal(disk.skin_revision,1);
 await f.reopen();assert.equal((await f.app.snapshot()).settings.skin,'quiet-titanium');assert.equal(f.app.state.data.skin_revision,1);
});

test('reset exposes its management HTTP error and keeps numbers; it is not a desktop/browser MCP error',async t=>{
 assert.deepEqual(MANAGEMENT_HTTP_ERRORS.VALUE_RESET_FAILED,{route:'/api/value/reset',status:400,message:'清零失败，请稍后重试。'});
 const isolated=managementHTTPError('/api/value/reset',{code:'VALUE_RESET_FAILED',message:'/private/secret',details:{password:'secret',text:'secret'}},cleanError);assert.deepEqual(isolated,{status:400,body:{error:{code:'VALUE_RESET_FAILED',message:'清零失败，请稍后重试。'}}});assert.doesNotMatch(JSON.stringify(isolated),/private|secret|password|details/);
 const f=await fixture(t),stats=f.app.tools.valueStats;
 const reply=await f.app.tools.rpc({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'connection_check',arguments:{}}});stats.drain();assert.equal(reply.result.isError,false);const before=stats.snapshot().lifetime.work;assert.ok(before>0);
 const writer=stats.writeFile;stats.writeFile=()=>{throw Error('isolated statistics disk failure');};
 const failed=await f.post('/api/value/reset');assert.equal(failed.status,400);assert.deepEqual(failed.body,{error:{code:'VALUE_RESET_FAILED',message:'清零失败，请稍后重试。'}});assert.equal(stats.snapshot().lifetime.work,before);assert.equal(stats.flush(),false);stats.writeFile=writer;
 assert.equal(DESKTOP_ERROR_CODES.includes('VALUE_RESET_FAILED'),false);assert.equal(BROWSER_ERROR_CODES.includes('VALUE_RESET_FAILED'),false);
});

test('headless main-service skin/state/SSE/workload and reopen smoke, with controlled late CSS/HTTP and failure recovery',async t=>{
 const f=await fixture(t),chrome=process.env.CHATHAND_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';assert.ok(fs.existsSync(chrome),'existing headless Chrome is required');
 f.app.state.data.setup_complete=true;f.app.state.data.tunnel={id:'isolated-static-skin'};f.app.state.save();
 const browser=await chromium.launch({headless:true,executablePath:chrome}),checks=[],pageErrors=[],external=[];let posts=[];
 t.after(async()=>{await browser.close();if(output){fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'browser.json'),JSON.stringify({checks,page_errors:pageErrors.length,external_resources:external.length,physical_browser_desktop:false},null,2));}});
 async function open({query='',stored,blockedStorage=false,delay=null,css404=false}={}){
  const context=await browser.newContext({viewport:{width:980,height:680},locale:'zh-CN',colorScheme:'light'});
  if(stored)await context.addInitScript(id=>localStorage.setItem('chathand-skin',id),stored);
  if(blockedStorage)await context.addInitScript(()=>{Storage.prototype.getItem=Storage.prototype.setItem=Storage.prototype.removeItem=function(){throw Error('isolated storage denied');};});
  await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==f.origin){external.push(url.protocol);return route.abort();}if(request.method()==='POST'&&url.pathname==='/api/settings'){const body=request.postDataJSON();if(body.skin!==undefined){const headers=request.headers();posts.push({skin:body.skin,owner:!!headers.authorization,window:!!headers['x-chathand-ui']});}}if(delay&&request.method()==='GET'&&['/api/state','/api/events'].includes(url.pathname))await delay.promise;if(css404&&url.pathname==='/skins/quiet-titanium.css')return route.fulfill({status:404,body:''});return route.continue();});
  const page=await context.newPage();page.setDefaultTimeout(6000);page.on('pageerror',error=>pageErrors.push(error.name));try{await page.goto(f.windowURL(query),{waitUntil:'domcontentloaded'});}catch{throw Error('isolated main-page navigation failed');}
  if(!delay)await page.waitForFunction(()=>S&&ChatHandStream.status()==='live'&&document.querySelector('#main > *'));return {context,page};
 }
 const check=(name,ok)=>{assert.ok(ok,name);checks.push({name,ok:true});};

 const firstState=gate();let view=await open({stored:'quiet-titanium',delay:firstState});await view.page.waitForFunction(()=>ChatHandSkin.current()==='default');check('injected backend skin is used before first state and old local memory is ignored',await view.page.evaluate(()=>document.documentElement.dataset.skinSaved==='default'));check('unknown first state never opens setup or blocks existing controls',await view.page.evaluate(()=>document.querySelector('#h10Host').hidden&&!document.querySelector('#app').inert));firstState.release();await view.page.waitForFunction(()=>S&&ChatHandStream.status()==='live'&&ChatHandSkin.current()==='default');check('backend state adoption does not POST',posts.length===0);
 await view.page.locator('[data-skin-action="toggle"]').click();await view.page.locator('[data-skin-card="quiet-titanium"] [data-skin-action="select"]').click();await view.page.waitForFunction(()=>ChatHandSkin.current()==='quiet-titanium'&&!ChatHandSkin.status().saving);check('existing switcher saves once with owner and window credentials',posts.length===1&&posts[0].owner&&posts[0].window);check('SSE state retains UI2 and morph hooks',await view.page.evaluate(()=>typeof ChatHandMorph==='object'&&!!window.ChatHandKeyWatch&&typeof wizardRefresh==='function'));
 const work=(await f.app.snapshot()).value.lifetime.work;const response=await fetch(`http://127.0.0.1:${f.app.mcpPort}/mcp`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json,text/event-stream','X-Ken-Bridge-Token':f.app.mcpToken},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'connection_check',arguments:{}}})});assert.equal(response.status,200);await response.json();await view.page.waitForFunction(previous=>S.value?.lifetime.work>previous,work);check('real isolated tools response reaches workload UI through SSE',await view.page.locator('#valueHeader').textContent()!=='');
 if(output)await view.page.screenshot({path:path.join(output,'main-quiet-titanium.png')});await view.context.close();

 await f.post('/api/settings',{skin:'default'});posts=[];view=await open();const delayedResponse=gate();let held=false;
 await view.page.route('**/api/settings',async route=>{const request=route.request();if(request.postDataJSON()?.skin==='quiet-titanium'&&!held){held=true;const response=await route.fetch();await delayedResponse.promise;return route.fulfill({response});}return route.continue();});
 await view.page.evaluate(()=>{window.__firstSkin=ChatHandSkin.set('quiet-titanium');});await until(()=>held);await view.page.evaluate(()=>{window.__lastSkin=ChatHandSkin.set('default');});delayedResponse.release();await view.page.evaluate(()=>Promise.all([window.__firstSkin,window.__lastSkin]));check('rapid clicks serialize actual writes and retain the last choice',f.app.state.data.skin==='default'&&await view.page.evaluate(()=>ChatHandSkin.current()==='default'));
 const revision=f.app.state.data.skin_revision;await view.page.evaluate(revision=>{ChatHandStream.stop();window.__mainNode=document.querySelector('#main > *');adoptPatch({settings:{...S.settings,skin:'quiet-titanium',skin_revision:revision-1}});adoptState({...S,settings:{...S.settings,skin:'quiet-titanium',skin_revision:revision-1}});},revision);await view.page.evaluate(()=>new Promise(requestAnimationFrame));check('late patch/full state cannot override the new revision or replace the main subtree',await view.page.evaluate(()=>ChatHandSkin.current()==='default'&&window.__mainNode===document.querySelector('#main > *')));await view.context.close();

 posts=[];view=await open();const delayedCSS=gate();let cssHeld=false;await view.page.route('**/skins/quiet-titanium.css',async route=>{cssHeld=true;await delayedCSS.promise;return route.continue();});await view.page.evaluate(()=>{window.__oldCSS=ChatHandSkin.set('quiet-titanium');});await until(()=>cssHeld);await view.page.evaluate(()=>ChatHandSkin.set('default'));delayedCSS.release();await view.page.evaluate(()=>window.__oldCSS);check('late old stylesheet cannot activate or save its stale choice',posts.length===1&&posts[0].skin==='default'&&await view.page.evaluate(()=>ChatHandSkin.current()==='default'&&!document.querySelector('link[data-chathand-skin]')));
 const save=f.app.state.save;f.app.state.save=()=>{throw Object.assign(Error('isolated disk failure'),{code:'ENOSPC'});};await view.page.evaluate(()=>ChatHandSkin.set('quiet-titanium'));f.app.state.save=save;await view.page.evaluate(()=>adoptPatch({settings:{...S.settings,skin:'default'}}));check('save failure keeps this window switched silently, including subsequent backend state',f.app.state.data.skin==='default'&&await view.page.evaluate(()=>ChatHandSkin.current()==='quiet-titanium'&&!ChatHandSkin.status().error&&!document.querySelector('#toast').textContent.includes('没保存成功')));const failedWindow=await open();check('a new window after failed save uses the unchanged backend choice',await failedWindow.page.evaluate(()=>ChatHandSkin.current()==='default'&&document.documentElement.dataset.skinSaved==='default'));await failedWindow.context.close();await view.page.unroute('**/skins/quiet-titanium.css');await view.page.evaluate(()=>ChatHandSkin.set('quiet-titanium'));check('a user retry saves successfully after disk recovery',f.app.state.data.skin==='quiet-titanium'&&await view.page.evaluate(()=>ChatHandSkin.current()==='quiet-titanium'&&!ChatHandSkin.status().error));await view.context.close();

 const oldPort=f.app.apiPort;await f.reopen();const reopenedState=gate();view=await open({stored:'default',delay:reopenedState});await view.page.waitForFunction(()=>ChatHandSkin.current()==='quiet-titanium');check('new origin/window uses saved skin before the delayed state after service reopen',f.app.apiPort!==oldPort&&await view.page.evaluate(()=>document.documentElement.dataset.skinSaved==='quiet-titanium'));reopenedState.release();await view.page.waitForFunction(()=>S&&ChatHandStream.status()==='live'&&ChatHandSkin.current()==='quiet-titanium');await view.context.close();
 for(const query of ['skin=default','skin=quiet-titanium','skin=unknown']){posts=[];view=await open({query,stored:'default'});await view.page.evaluate(()=>ChatHandSkin.set('quiet-titanium'));const expected=query==='skin=quiet-titanium'?'quiet-titanium':'default';check('URL priority remains fixed: '+query,posts.length===0&&await view.page.evaluate(id=>ChatHandSkin.current()===id,expected));await view.context.close();}
 posts=[];view=await open({blockedStorage:true});await view.page.evaluate(()=>ChatHandSkin.set('default'));check('unavailable local/session storage does not prevent server saving',f.app.state.data.skin==='default'&&posts.length===1&&await view.page.evaluate(()=>ChatHandSkin.current()==='default'));await view.context.close();
 await f.post('/api/settings',{skin:'quiet-titanium'});posts=[];view=await open({css404:true});await view.page.waitForFunction(()=>ChatHandSkin.current()==='default'&&!!ChatHandSkin.status().error);check('failed CSS keeps a usable default and does not change the saved backend choice',posts.length===0&&f.app.state.data.skin==='quiet-titanium'&&await view.page.locator('#main > *').count()>0);await view.context.close();
 check('no page errors or external resource loads',pageErrors.length===0&&external.length===0);
});
