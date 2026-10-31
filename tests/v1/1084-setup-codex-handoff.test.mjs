import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {setupHandoff} from '../../app/v1/setup-handoff.mjs';
import {renderH10} from '../../ui/h10/views.mjs';
import {installCatalogs} from '../../ui/local-text.mjs';
import {installUiTextContext} from '../support/ui-text-context.mjs';

const read=file=>fs.readFileSync(new URL("../../"+file,import.meta.url),'utf8');
const app=read('ui/app.js'),host=read('ui/h10/host.mjs');
const dispatch=app.slice(app.indexOf('async function openLocalSetupHandoff('),app.indexOf('async function openChatGPT('));
const plain=value=>JSON.parse(JSON.stringify(value));

test('a failed clipboard does not block opening Codex; native failures keep their reason and never open web Work',async()=>{
 for(const copied of [true,false])for(const response of [
  {opened:true,dispatched:true},
  {opened:false,error_code:'CHATGPT_DESKTOP_UNAVAILABLE',reason:'scheme_unavailable'},
  {opened:false,error_code:'CHATGPT_OPEN_FAILED',native_error_domain:'NSOSStatusErrorDomain',native_error_code:-10814},
  null,
  Object.assign(Error('fixture'),{code:'NATIVE_BRIDGE_UNAVAILABLE'})
 ]){
  const calls=[],box=vm.createContext({window:{},copyText:async text=>{calls.push(['copy',text]);if(!copied)throw Error('copy unavailable');},
   native:async(action,args)=>{calls.push([action,args]);if(response instanceof Error)throw response;return response;},toast:()=>{throw Error('quiet dispatch must not toast');}});
  installUiTextContext(box);vm.runInContext(dispatch,box);
  const prompt='C++ & mode=chat?x#1\n中文';
  const result=plain(await box.window.openLocalSetupHandoff({prompt},{quiet:true}));
  assert.deepEqual(calls.map(x=>x[0]),['copy','openSetupConversation']);assert.equal(calls[1][1].prompt,prompt);
  assert.equal(result.copied,copied);assert.equal(result.auto_sent,false);
  assert.equal(result.opened,response?.opened===true);assert.equal(result.prefill_requested,response?.opened===true);
  if(response?.opened===true)continue;
  assert.equal(result.error_code,response?.error_code||response?.code||'CHATGPT_OPEN_FAILED');
  if(response?.reason)assert.equal(result.reason,response.reason);
  if(response?.native_error_code)assert.equal(result.native_error_code,response.native_error_code);
  assert.match(result.warning,copied?/提示词已复制/:/未能复制/);
 }
});

test('retry uses the original add or repair handoff and returns to the existing conversation after setup starts',async()=>{
 const launch=host.slice(host.indexOf('async function launchAssistedHandoff('),host.indexOf('function startOpenAIAssisted('));
 const retry=host.slice(host.indexOf("   case'retry-assisted':"),host.indexOf("   case'recheck-site':"));
 for(const route of ['site','openai'])for(const intent of ['add','repair']){
  const original=setupHandoff({appPath:'/tmp/ChatHand.app',route,intent,locale:'zh',siteOrigin:'https://fixture.example'});
  const calls=[],box=vm.createContext({assistHandoff:original,assistedCopied:false,assistedWeb:false,prefill:'unconfirmed',noticeText:'',busy:false,b:{},
   uiText:key=>key,model:()=>({assistedOpenFailed:!box.started}),
   backToChatGPT:async()=>{calls.push('return');return true;},
   window:{openLocalSetupHandoff:async(h,options)=>{calls.push({handoff:plain(h),options:plain(options)});return calls.length===1?{opened:false,copied:true,error_code:'CHATGPT_OPEN_FAILED',warning:'retry'}:{opened:true,copied:true,prefill_requested:true};}}});
  vm.runInContext(launch+'\nglobalThis.run=async()=>{switch("retry-assisted"){'+retry+'}};',box);
  await box.launchAssistedHandoff();
  assert.equal(box.assistHandoff.openFailed,true);assert.equal(box.assistHandoff.openErrorCode,'CHATGPT_OPEN_FAILED');
  await box.run();
  assert.equal(box.assistHandoff.openFailed,false);assert.equal(box.prefill,'confirmed');
  assert.equal(calls[1].handoff.prompt,original.prompt);assert.equal(calls[1].handoff.route,route);assert.equal(calls[1].handoff.intent,intent);
  assert.deepEqual(calls[1].options,{quiet:true});
  box.started=true;await box.run();assert.equal(calls.at(-1),'return');assert.equal(calls.length,3);
 }
});

test('the failed handoff is visible with retry and copy actions in both languages',t=>{
 t.after(()=>installCatalogs({locale:'zh'}));
 for(const locale of ['zh','en']){
  installCatalogs({locale});
  const copy=JSON.parse(read('locales/'+locale+'.json'));
  const output=renderH10({provenance:'host',screen:'f7',connectionRoute:'site',setupMode:'assisted',assistedOpenFailed:true,
   assistedWaiting:true,assistedWaitingIntro:copy['ui.window.openLocalSetupHandoff.failedCopied'],
   steps:[{state:'done'},{state:'done'},{state:'attention'},{state:'pending'},{state:'pending'}]});
  assert.ok(output.includes(copy['ui.h10.views.assistedOpenFailedTitle']));
  assert.match(output,/data-action="retry-assisted"/);assert.match(output,/data-action="copy-assisted"/);
  assert.doesNotMatch(output,/data-action="back-to-chatgpt"/);
 }
});
