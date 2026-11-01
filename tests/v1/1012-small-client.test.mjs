import test from 'node:test';import assert from 'node:assert/strict';
import {clientSettings,initializeClientSettings,applyClientSettings,clientNeedsInterface,requireClientInterface,computerName,KeyWatchBroker,KEY_PATTERN} from '../../app/v1/client-features.mjs';
import {rpc,toolListCapabilities,ToolListChangeProbe} from '../../engine/src/mcp.mjs';

test('settings defaults, persisted choices and atomic validation',()=>{
 for(const [input,expected] of [[{}, {appearance:'system',auto_update:true,skin:'default'}],[{appearance:'dark',auto_update:false},{appearance:'dark',auto_update:false,skin:'default'}],[{appearance:'invalid',auto_update:'yes'},{appearance:'system',auto_update:true,skin:'default'}]])assert.deepEqual(clientSettings(input),{...expected,ui_zoom:1.25,skin_revision:0});
 let saved=0;const state={data:{},save:()=>saved++};initializeClientSettings(state);initializeClientSettings(state);assert.equal(saved,1);
 for(const body of [{appearance:'blue'},{auto_update:0},{appearance:'light',auto_update:'yes'}]){assert.throws(()=>applyClientSettings(state,body),{code:'ARG_INVALID'});assert.equal(state.data.appearance,'system');}
 assert.deepEqual(applyClientSettings(state,{appearance:'light',auto_update:false}),{appearance:'light',auto_update:false});
});
test('UI-only actions require interface credentials; owner-authenticated setup routes stay distinct',()=>{
 const key='a'.repeat(64);const cases=[['/api/access',{enabled:true}],['/api/connect',{}],['/api/connect/restore',{}],['/api/setup/connect',{}],['/api/tunnel/configure',{}],['/api/support/repair',{}],['/api/tunnel/start',{}],['/api/tunnel/stop',{}],['/api/tunnel/forget',{}],['/api/relay/restore',{}],['/api/relay/stop',{}],['/api/relay/forget',{}],['/api/relay/pair',{}],['/api/setup/await-key',{}],['/api/setup/await-key/status',{}],['/api/setup/await-key/cancel',{}],['/api/settings',{auto_update:true}],['/api/settings',{appearance:'light'}],['/api/settings',{auto_connect:true}]];
 for(const [route,body] of cases){assert.equal(clientNeedsInterface(route,body),true,route);for(const provided of [null,'runtime-management-token'])assert.throws(()=>requireClientInterface(route,body,provided,key),{code:'UI_CONFIRM_REQUIRED'});assert.throws(()=>requireClientInterface(route,body,null,null),{code:'UI_CONFIRM_REQUIRED'});requireClientInterface(route,body,key,key);}
 assert.equal(clientNeedsInterface('/api/setup/key',{}),false,'setup key is owner-authenticated, not a window-only route');requireClientInterface('/api/setup/key',{},null,null);
 requireClientInterface('/api/access',{enabled:false},null,null);assert.equal(clientNeedsInterface('/api/settings',{notifications:false}),false);
});
test('key-watch expires, replaces, cancels and exposes only last four',()=>{
 let now=100;const watch=new KeyWatchBroker({now:()=>now}),tunnel='tunnel_abcdefgh';
 assert.throws(()=>watch.start('invalid'),{code:'TUNNEL_ID_INVALID'});assert.deepEqual(watch.start(tunnel),{active:true,received:false,last4:null});const old=watch.request().request;
 assert.equal(old.expires_at,600100);assert.equal(watch.received('tunnel_otherxxx','abcd'),false);watch.start(tunnel);assert.notEqual(watch.request().request.id,old.id);watch.cancel(old.id);assert.equal(watch.snapshot().active,true);
 assert.equal(watch.received(tunnel,'abcd'),true);assert.deepEqual(watch.snapshot(),{active:false,received:true,last4:'abcd'});assert.equal(watch.request().request,null);
 watch.start(tunnel);now+=600000;assert.equal(watch.snapshot().active,false);assert.equal(watch.received(tunnel,'abcd'),false);watch.start(tunnel);watch.close();assert.equal(watch.snapshot().active,false);
 for(const [text,valid] of [['sk-'+ 'a'.repeat(17),true],['sk-short',false],['not a key',false],['sk-'+ 'a'.repeat(16),false],['sk-'+ 'a'.repeat(17)+'!',false]])assert.equal(KEY_PATTERN.test(text),valid);
});
test('device name is ComputerName with a safe fallback',()=>{
 for(const [output,expected] of [['Ken 的 Mac\n','Ken 的 Mac'],['\n','fallback']])assert.equal(computerName({platform:'darwin',exec:(program,args)=>{assert.equal(program,'/usr/sbin/scutil');assert.deepEqual(args,['--get','ComputerName']);return output;},fallback:()=> 'fallback'}),expected);
 assert.equal(computerName({platform:'darwin',exec:()=>{throw Error();},fallback:()=> 'fallback'}),'fallback');
});
test('isolated list_changed probe emits once; production stays false with cache hints',async()=>{
 assert.deepEqual(toolListCapabilities(),{listChanged:false});
 for(const method of ['initialize','server/discover']){const response=await rpc({}, {},{jsonrpc:'2.0',id:1,method});assert.equal(response.result.capabilities.tools.listChanged,false);if(method==='server/discover'){assert.equal(response.result.ttlMs,300000);assert.equal(response.result.cacheScope,'private');}}
 const sent=[],old='a'.repeat(64),next='b'.repeat(64),probe=new ToolListChangeProbe(old);assert.equal(probe.capabilities().listChanged,true);assert.equal(await probe.notify(old,x=>sent.push(x)),false);assert.equal(await probe.notify(next,x=>sent.push(x)),true);assert.equal(await probe.notify(next,x=>sent.push(x)),false);assert.deepEqual(sent,[{jsonrpc:'2.0',method:'notifications/tools/list_changed'}]);
 const failed=new ToolListChangeProbe(old);await assert.rejects(failed.notify(next,()=>{throw Error('fixture transport');}));assert.equal(await failed.notify(next,x=>sent.push(x)),true);
});
