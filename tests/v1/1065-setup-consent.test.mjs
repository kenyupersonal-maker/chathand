// Source or a user-specified isolated package. No installed App/state, account,
// cloud, platform deployment, credentials, or actual ChatGPT UI is accessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {retiredChinese,retiredEnglish,retiredHits} from '../support/retired-consent.mjs';

const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const supplied=process.env.CHATHAND_1065_PACKAGE_ROOT;
function layout(input){
 const root=path.resolve(input);
 if(fs.existsSync(path.join(root,'Contents/Resources/runtime/app/server.mjs')))return {runtime:path.join(root,'Contents/Resources/runtime'),resources:path.join(root,'Contents/Resources'),kind:'app'};
 if(fs.existsSync(path.join(root,'runtime/app/server.mjs')))return {runtime:path.join(root,'runtime'),resources:root,kind:'resources'};
 if(fs.existsSync(path.join(root,'app/server.mjs'))&&fs.existsSync(path.join(root,'../codex/INSTALL.md')))return {runtime:root,resources:path.dirname(root),kind:'runtime'};
 assert.ok(fs.existsSync(path.join(root,'app/server.mjs'))&&fs.existsSync(path.join(root,'codex/INSTALL.md')),'source or isolated package root must contain product modules and its install guide');return {runtime:root,resources:root,kind:'source'};
}
const product=layout(supplied||source);
// Exact English counterparts from the pre-0013 catalog. Both Site prompts used
// the same account/system sentence; unrelated Chrome/macOS/manual help remains.
const keys=['ui.h10.prompts.localCreateSitePrompt','ui.h10.prompts.createSitePrompt','ui.h10.host.pluginSettingsInstructions','ui.h10.host.pairingHealthVerified','ui.wizard.allowAllActionsHint','ui.h10.views.assistedExplanation','ui.h10.views.assistedCopyExplanation','ui.h10.views.assistedProgressIntroduction','ui.h10.views.assistedInstallExplanation'];
const read=file=>fs.readFileSync(file,'utf8');
const skillRoots=['skills/chathand-setup','plugins/chathand/skills/chathand-setup'].map(value=>path.join(product.runtime,value));
const guide=path.join(product.resources,'codex/INSTALL.md');
const evidence={layout:product.kind,retired_chinese_phrases:retiredChinese.length,retired_english_fragments:retiredEnglish.length,phrase_hits:null,scanned_files:0,checked_languages:[],site_start_languages:[]};
function filesUnder(dir){if(!fs.existsSync(dir))return [];const out=[];for(const name of fs.readdirSync(dir)){const file=path.join(dir,name),st=fs.lstatSync(file);if(st.isSymbolicLink())continue;if(st.isDirectory()){if(!['node_modules','lib','bin','.git'].includes(name))out.push(...filesUnder(file));}else if(/\.(?:md|mjs|js|json|txt|html|swift|strings)$/.test(name))out.push(file);}return out;}
function saveEvidence(){const file=process.env.CHATHAND_1065_CONSENT_OUTPUT;if(file){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(evidence,null,2)+'\n');}}

test('1066 AI install verifies quarantine removal before any incoming app executable',()=>{
 const text=read(guide),install=text.split('## 5. ')[1].split('\n## 6.')[0];
 const block=install.split('```sh\n')[1].split('\n```')[0];
 const order=['ditto ', 'xattr -dr com.apple.quarantine', 'xattr -l ', 'QUARANTINE_STILL_PRESENT', '"$PWD/bin/node"', 'open -g "/Applications/ChatHand.app"'].map(value=>{const index=block.indexOf(value);assert.ok(index>=0,value+' is present');return index;});
 assert.deepEqual(order,[...order].sort((a,b)=>a-b));
 for(const root of skillRoots)assert.ok(read(path.join(root,'SKILL.md')).includes('codex/INSTALL.md'));
 for(const root of skillRoots){for(const file of ['SKILL.md','references/runbook.md','references/troubleshooting.md']){const body=read(path.join(root,file));assert.ok(!body.includes('macOS 隐私权限、手动首次放行'),'manual opening is not an AI-install prerequisite');}const body=read(path.join(root,'references/runbook.md'));assert.ok(body.includes('随包'));assert.ok(read(guide).includes('xattr -l /Applications/ChatHand.app'));assert.ok(read(guide).includes('这之后才允许运行新 App 内的可执行程序'));}
});

test('1066 shipped first-install shell stops before runtime or open when clearing or verifying quarantine fails',t=>{
 const block=read(guide).split('## 5. ')[1].split('```sh\n')[1].split('\n```')[0];
 for(const mode of ['ok','clear-failed','list-failed','still-present']){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-install-order-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const app=path.join(dir,'Applications/ChatHand.app'),volume=path.join(dir,'Volumes/ChatHand'),bin=path.join(dir,'bin'),log=path.join(dir,'calls');fs.mkdirSync(path.join(app,'Contents/Resources/runtime/bin'),{recursive:true});fs.mkdirSync(bin);
  const wrapper=(file,body)=>{fs.writeFileSync(file,'#!/bin/sh\n'+body+'\n',{mode:0o700});};
  for(const name of ['ditto','codesign','hdiutil','open'])wrapper(path.join(bin,name),'printf "%s\\n" '+name+' >> "$ORDER_LOG"');
  wrapper(path.join(app,'Contents/Resources/runtime/bin/node'),'printf "%s\\n" runtime >> "$ORDER_LOG"');
  wrapper(path.join(bin,'xattr'),'printf "xattr-%s\\n" "$1" >> "$ORDER_LOG"\nif [ "$1" = -dr ] && [ "$ORDER_MODE" = clear-failed ]; then exit 1; fi\nif [ "$1" = -l ]; then\n [ "$ORDER_MODE" != list-failed ] || exit 1\n if [ "$ORDER_MODE" = still-present ]; then printf "com.apple.quarantine: fixture\\n"; fi\nfi\nexit 0');
  const script=block.replaceAll('/Applications/ChatHand.app',app).replaceAll('/Volumes/ChatHand',volume);
  const result=spawnSync('/bin/sh',['-c',script],{encoding:'utf8',env:{PATH:bin+':/usr/bin:/bin',ORDER_LOG:log,ORDER_MODE:mode},timeout:5000});
  const calls=fs.readFileSync(log,'utf8').trim().split('\n');assert.equal(result.status,mode==='ok'?0:1);
  if(mode==='ok')assert.deepEqual(calls,['ditto','codesign','xattr--dr','xattr--l','hdiutil','runtime','open']);
  else {assert.ok(!calls.includes('runtime'));assert.ok(!calls.includes('open'));assert.ok(!calls.includes('hdiutil'));}
 }
});

test('1065 shipped setup instructions and first-party payload contain none of the eleven retired consent phrases',()=>{
 const required=[guide,...skillRoots.flatMap(root=>['SKILL.md','references/runbook.md','references/troubleshooting.md'].map(file=>path.join(root,file)))];
 for(const file of required)assert.ok(fs.existsSync(file),'required setup instruction exists: '+path.relative(product.resources,file));
 const roots=['app','ui','connectors','cloud','contracts','scripts','browser-extension','skills','plugins','locales'].map(value=>path.join(product.runtime,value));roots.push(path.join(product.resources,'codex'),path.join(product.resources,'locales'));
 const files=[...new Set([...required,...roots.flatMap(filesUnder)])],hits=files.flatMap(file=>retiredHits(read(file),path.relative(product.resources,file)));
 // The exported install guides are required in every source distribution.
 // Internal maintained guides are checked by tests/development/installation-docs.test.mjs.
 if(product.kind==='source')for(const file of ['docs/INSTALL.md','docs/INSTALL.en.md'])hits.push(...retiredHits(read(path.join(product.runtime,file)),file));
 evidence.phrase_hits=hits.length;evidence.scanned_files=files.length;saveEvidence();assert.deepEqual(hits,[]);
});

test('1065 install and runbook explicitly assign all-tools and real ChatGPT setup to AI while keeping route/system boundaries',()=>{
 const install=read(guide);assert.match(install,/SKILL\.md/);assert.match(install,/plan-check/);
 for(const root of skillRoots){
  const skill=read(path.join(root,'SKILL.md')),plan=read(path.join(root,'plan-check.md')),runbook=read(path.join(root,'references/runbook.md'));
  for(const target of ['plan-check.md','references/runbook.md','references/troubleshooting.md'])assert.ok(skill.includes(']('+target+')'),'skill indexes its one authoritative rule/workflow: '+target);
  const ai=plan.split('\n').find(line=>line.startsWith('AI ')&&line.includes('允许使用所有工具'));assert.ok(ai,'the permission assignment belongs to the AI role');for(const step of ['创建或复用','连接','开发者模式','新对话测试'])assert.ok(ai.includes(step),'AI completes '+step);
  for(const humanStep of ['电脑密码','Touch ID','登录密码','验证码','Chrome','添加扩展程序','辅助功能','屏幕录制'])assert.ok(plan.includes(humanStep),'explicit human/system boundary stays in the one role rule: '+humanStep);
  assert.match(plan,/不能代输密码/);assert.match(plan,/绕过平台实际拒绝/);assert.match(plan,/用户看得见的浏览器/);assert.match(plan,/正确页面切到最前/);assert.match(plan,/完成后核实际结果再继续/);assert.match(plan,/ChatHand 自身的权限档位和高危开关仍有效/);
  const build=JSON.parse(read(path.join(product.runtime,'package.json'))).kenBridge?.build_number||0;
  if(product.kind==='source'||build>=1083)assert.match(runbook,/首次未选路线默认 OpenAI 通道/);else assert.match(runbook,/OpenAI.*只在用户选它时配置|只在已选择这条路时执行/);
  assert.match(runbook,/按 ZIP 的 `STEPS\.md`/);assert.match(runbook,/同一 Site 项目/);assert.match(runbook,/正式接口/);assert.match(runbook,/不能把真实凭据放参数、heredoc、文件或日志/);
  assert.match(runbook,/新开普通对话/);assert.match(runbook,/真实调用 `connection_check` 和 `setup_write_probe`/);assert.match(runbook,/不从本机伪造调用/);assert.match(skill,/不把本机自检冒充 ChatGPT 真实验收/);assert.match(runbook,/真实详情页/);
  for(const file of ['SKILL.md','plan-check.md','references/runbook.md','references/troubleshooting.md'])assert.equal(read(path.join(root,file)),read(path.join(skillRoots[0],file)),'generated skill mirror stays exact: '+file);
 }
 for(const base of [...new Set([path.join(product.resources,'locales'),path.join(product.runtime,'locales')])])for(const lang of ['zh','en']){
  const table=JSON.parse(read(path.join(base,lang+'.json')));for(const key of keys){assert.equal(typeof table[key],'string',key+' exists');assert.ok(table[key].trim(),key+' is nonempty');assert.deepEqual(retiredHits(table[key],key),[]);}
  evidence.checked_languages.push(lang);
 }
 saveEvidence();
});

test('1065 actual isolated createDesktop and setup.mjs site-start return the current prompt in both languages without a consent handoff',{timeout:15000},async t=>{
 const [{createDesktop},{run},{siteCreationHandoff},{installCatalogs}]=await Promise.all([import(pathToFileURL(path.join(product.runtime,'app/server.mjs'))),import(pathToFileURL(path.join(skillRoots[0],'scripts/setup.mjs'))),import(pathToFileURL(path.join(product.runtime,'ui/h10/prompts.mjs'))),import(pathToFileURL(path.join(product.runtime,'ui/local-text.mjs')))]);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-consent1065-')),sections={};let app,networkChecks=0;
 t.after(async()=>{await app?.close();installCatalogs({locale:'zh'});fs.rmSync(dir,{recursive:true,force:true});});
 const credentials={get:key=>sections[key]||null,set:(key,value)=>{sections[key]=value;},remove:key=>{delete sections[key];},readAll:()=>structuredClone(sections),writeAll:value=>{for(const key of Object.keys(sections))delete sections[key];Object.assign(sections,structuredClone(value));},status:()=>({healthy:true,tunnel:false})};
 app=await createDesktop({stateDir:path.join(dir,'state'),defaultRoot:path.join(dir,'work'),adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{siteNetworkFetch:async()=>{networkChecks++;return new Response(null,{status:200});},credentials,computerName:()=> 'Consent Fixture',currentAppPath:null,tunnelFactory:()=>({child:null,doctorChild:null,key:'',tunnelId:'',stop(){},snapshot:async()=>({ready:false,healthy:false,process_running:false})}),bSiteTransport:{epoch:0,start(){},stop(){},close(){},status:()=>({ready:false})},updaterFactory:()=>({snapshot:()=>({status:'unknown',install:{state:'idle'}}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})}),maintenanceClock:{setInterval:()=>({unref(){}}),clearInterval(){}}}});
 app.state.data.auto_connect=false;
 const call=async(_runtime,route,body)=>{const response=await fetch('http://127.0.0.1:'+app.apiPort+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+app.adminToken,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.equal(response.status,200,'isolated owner route '+route);return response.json();};
 for(const locale of ['zh','en']){
  installCatalogs({locale});const result=await run(['site-start'],{locate:()=>({}),call});
  const descriptor=(await app.snapshot()).site_b.verified_template_source,expected=siteCreationHandoff(descriptor).prompt;
  // Boolean assertions deliberately never print private prompt/intent contents.
  assert.ok(typeof result.prompt==='string'&&result.prompt.length>100,'a real current Site prompt was returned');assert.ok(result.prompt===expected,'helper returns the same production prompt as the current UI');assert.ok(retiredHits(result.prompt,'prompt').length===0,'site-start prompt contains no retired consent handoff');assert.ok(locale==='zh'?result.prompt.includes('不要公开发布'):result.prompt.includes('Do not publish it publicly'),'private publication boundary remains');assert.ok(typeof result.watch_id==='string'&&result.expires_at>Date.now(),'site-start still arms the pending enrollment watch');assert.ok(fs.existsSync(result.template_path),'the real bundled template remains available');evidence.site_start_languages.push(locale);
 }
 const build=JSON.parse(read(path.join(product.runtime,'package.json'))).kenBridge?.build_number||0;
 assert.equal(networkChecks,product.kind==='source'||build>=1083?1:0,'new Site start uses the fake check and reuses its cached result');
 saveEvidence();
});
