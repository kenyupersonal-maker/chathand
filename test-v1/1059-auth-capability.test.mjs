import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../ui/auth.js',import.meta.url),'utf8');
test('1059 legacy local credential fragment is cleared while the shared capability retains both headers and rejects external routes',async()=>{
 const owner='ab'.repeat(32),key='cd'.repeat(32),requests=[],window={},location={href:'http://127.0.0.1:1234/#'+owner+'.'+key,hash:'#'+owner+'.'+key,hostname:'127.0.0.1',origin:'http://127.0.0.1:1234',pathname:'/',search:''};let cleared=0;
 const context={window,location,URL,history:{state:null,replaceState(_state,_title,path){cleared++;assert.equal(path,'/');location.hash='';location.href=location.origin+path;}},fetch:async(route,options)=>{requests.push({route,options});return {ok:true};}};vm.runInNewContext(source,context);
 assert.equal(cleared,1);assert.equal(location.hash,'');assert.deepEqual(Object.keys(window.ChatHandAuth),['fetch']);assert.equal(context.token,undefined);assert.equal(context.key,undefined);
 await window.ChatHandAuth.fetch('/api/events');await window.ChatHandAuth.fetch('/api/state');assert.equal(requests.length,2);for(const {options} of requests){assert.equal(options.headers.Authorization,'Bearer '+owner);assert.equal(options.headers['X-ChatHand-UI'],key);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');}
 await assert.rejects(window.ChatHandAuth.fetch('https://example.invalid/api/state'),/LOCAL_API_ONLY/);await assert.rejects(window.ChatHandAuth.fetch('/not-api'),/LOCAL_API_ONLY/);assert.equal(requests.length,2);assert.equal(location.hash,'');
 const ordinary={hash:'#section',hostname:'127.0.0.1',href:'http://127.0.0.1:1234/#section'};vm.runInNewContext(source,{window:{},location:ordinary,URL,fetch:context.fetch,history:{replaceState(){assert.fail('ordinary navigation hash must survive');}}});assert.equal(ordinary.hash,'#section');
});
