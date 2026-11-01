import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {desktop} from './1052-a-fixture.mjs';
import {locateRuntime,run} from '../../skills/chathand-setup/scripts/setup.mjs';

test('site-start exposes only the two approved network messages in the actual helper CLI',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ch1083-helper-'));
 const cases=[
  ['SITE_NETWORK_CHALLENGED','这台 Mac 当前的网络会被 Site 的网络验证（Cloudflare）拦截，多半是在用代理或 VPN。请改用 OpenAI 通道，或关闭代理或 VPN 后重试。'],
  ['SITE_NETWORK_UNREACHABLE','无法连接 ChatGPT Site，请检查网络后重试，或改用 OpenAI 通道。'],
  ['SYNTHETIC_OTHER_ERROR',undefined]
 ];
 let code='',notifications=0;
 const server=http.createServer((req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url==='/api/state'){res.end('{}');return;}
  if(req.url==='/api/setup/assistant-seen'){notifications++;res.end('{"ok":true}');return;}
  if(req.url==='/api/setup/site/start'){res.statusCode=403;res.end(JSON.stringify({error:{code,message:'synthetic untrusted server message'}}));return;}
  res.statusCode=404;res.end('{}');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
 fs.writeFileSync(path.join(root,'runtime.json'),JSON.stringify({pid:process.pid,ui_origin:`http://127.0.0.1:${server.address().port}`,admin_token:'a'.repeat(64),setup_helper_token:'b'.repeat(64)}),{mode:0o600});
 const script=fileURLToPath(new URL('../../skills/chathand-setup/scripts/setup.mjs',import.meta.url));
 for(const [next,expected] of cases){
  code=next;
  const result=await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[script,'site-start'],{env:{...process.env,CHATHAND_STATE_DIR:root},stdio:['ignore','pipe','pipe']});
   let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
   child.on('error',reject);child.on('close',exit=>resolve({exit,stdout,stderr}));
  });
  assert.equal(result.exit,1);assert.equal(result.stdout,'');assert.ok(!result.stderr.includes('synthetic untrusted server message'));
  const value=JSON.parse(result.stderr);assert.equal(value.code,next);assert.equal(value.message,expected);assert.equal(value.secrets_printed,false);
 }
 assert.equal(notifications,cases.length);
});

test('English App language reaches the real helper CLI for both fixed Site network messages',async t=>{
 let mode='clear';
 const previous=process.env.CHATHAND_SYSTEM_LOCALE;process.env.CHATHAND_SYSTEM_LOCALE='en';
 let f;
 try{f=await desktop(t,{siteNetworkFetch:async()=>{
   if(mode==='unreachable')throw Error('private network details');
   return mode==='clear'?new Response(null,{status:200}):new Response(null,{status:403,headers:{'cf-mitigated':'challenge'}});
  }});
 }finally{if(previous===undefined)delete process.env.CHATHAND_SYSTEM_LOCALE;else process.env.CHATHAND_SYSTEM_LOCALE=previous;}
 const script=fileURLToPath(new URL('../../skills/chathand-setup/scripts/setup.mjs',import.meta.url));
 const cli=()=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[script,'site-start'],{env:{...process.env,CHATHAND_STATE_DIR:path.join(f.root,'state')},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  child.on('error',reject);child.on('close',exit=>resolve({exit,stdout,stderr}));
 });
 const cases=[
  ['challenge','SITE_NETWORK_CHALLENGED','Cloudflare’s network check blocks this Mac’s current network, often because of a proxy or VPN. Use the OpenAI Tunnel, or turn off the proxy or VPN and try again.'],
  ['unreachable','SITE_NETWORK_UNREACHABLE','Can’t reach ChatGPT Site. Check your network and try again, or use the OpenAI Tunnel.']
 ];
 for(const [next,code,message] of cases){
  mode=next;await f.app.handle('/api/setup/site/network-check',{force:true});
  const result=await cli();
  assert.equal(result.exit,1);assert.equal(result.stdout,'');assert.ok(!result.stderr.includes('private network details'));
  const value=JSON.parse(result.stderr);assert.equal(value.code,code);assert.equal(value.message,message);assert.equal(value.secrets_printed,false);
 }
 const before=(await f.app.snapshot()).setup_activity;
 assert.equal(before.active,false);assert.equal(before.last_at,null);
 const runtime=locateRuntime({stateDir:path.join(f.root,'state'),probe:()=>{}});
 const setLanguage=async(locale,ui)=>fetch(runtime.ui_origin+'/api/native/state',{headers:{authorization:'Bearer '+runtime.admin_token,'x-chathand-ui-locale':locale,...(ui?{'x-chathand-ui':f.app.uiKey}:{})}});
 assert.equal((await setLanguage('zh',false)).status,403);
 assert.equal((await setLanguage('zh',true)).status,200);
 const after=(await f.app.snapshot()).setup_activity;
 for(const key of ['active','last_at','last_command','route','finished_at','seen_at'])assert.equal(after[key],before[key]);
 mode='challenge';await f.app.handle('/api/setup/site/network-check',{force:true});
 const changed=await cli(),chinese=JSON.parse(changed.stderr);
 assert.equal(changed.exit,1);assert.equal(chinese.code,'SITE_NETWORK_CHALLENGED');
 assert.equal(chinese.message,'这台 Mac 当前的网络会被 Site 的网络验证（Cloudflare）拦截，多半是在用代理或 VPN。请改用 OpenAI 通道，或关闭代理或 VPN 后重试。');
 assert.equal((await setLanguage('en',false)).status,403);
 const stale=JSON.parse((await cli()).stderr);assert.equal(stale.message,chinese.message);
 assert.equal((await setLanguage('en',true)).status,200);
 const recovered=JSON.parse((await cli()).stderr);assert.equal(recovered.message,cases[0][2]);
});

test('helper observation bounds a stalled locale response body',async()=>{
 const runtime={ui_origin:'http://127.0.0.1:1',admin_token:'a'.repeat(64),setup_helper_token:'b'.repeat(64)};
 const started=Date.now();
 const result=await run(['doctor'],{locate:()=>runtime,seenFetch:async()=>({ok:true,json:()=>new Promise(()=>{})}),call:async()=>({connection:{ready:true,healthy:true}})});
 assert.equal(result.connected,true);assert.ok(Date.now()-started<2500);
});
