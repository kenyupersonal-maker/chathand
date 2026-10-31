import {chromeDistribution,storeMode} from './chrome-distribution.mjs';
import {chromeStoreUsable} from './chrome-store-contract.mjs';
import {chromeAccessOperation} from './chrome-data-access.mjs';
import {messageMetadata} from './message-metadata.mjs';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';

export const REPAIR_ITEMS=[
 ['paused','AI 暂停状态'],['credentials','连接设置'],['tunnel','连接程序'],
 ['proxy_match','系统代理'],['proxy_alive','代理软件'],['cloud','ChatGPT 连接'],
 ['chatgpt_tools','ChatGPT 中的工具'],['browser_host','Chrome 插件登记'],
 ['browser_helper','Chrome 插件'],['desktop_permissions','桌面控制授权'],
 ['login_item','开机启动'],['upgrade_leftover','上次升级'],
];
const result=(status,message='',action,key=null,params={})=>({status,message,...messageMetadata('message',key,params),...(action?{action}: {})});
const action=(kind,label)=>({kind,label,...messageMetadata('label',kind==='chrome_data_access'?'ui.chrome.dataAccess.openSettings':'repair.action.'+kind+'.label')});
const off=()=>result('skipped','已关闭，不检查',undefined,'repair.common.off.message');
const capabilityOn=(s,id)=>s.settings?.[id+'_enabled']!==false&&s.permissions?.capabilities?.[id]?.enabled!==false;
const explicitBrowserOptIn=deps=>(typeof deps.browserOptIn==='function'?deps.browserOptIn():deps.browserOptIn)===true;
const browserFilesAllowed=(s,deps)=>capabilityOn(s,'browser')&&(deps.registrationOnlyAfterOptIn!==true||s.settings?.browser_enabled===true&&explicitBrowserOptIn(deps));
const relay=s=>s.settings?.connection_preference==='relay'||s.relay?.online===true;
const selectedSite=s=>s.site_b?.selected==='site';
const siteHealthy=s=>{const route=s.site_b?.routes?.site;return route?.configured===true&&route.state==='healthy'&&route.health_fresh===true;};
const localReady=s=>s.connection?.process_running===true&&s.connection?.ready===true&&s.connection?.healthy===true;
export function proxyAddress(value){
 if(!value||value==='direct')return null;
 try{const u=new URL(value),port=Number(u.port||(u.protocol==='https:'?443:u.protocol==='http:'?80:0));
  const host=u.hostname.replace(/^\[|\]$/g,'');
  if(!['http:','https:','socks:','socks5:'].includes(u.protocol)||!port||port>65535||(!net.isIP(host)&&!/^([A-Za-z0-9-]+\.)*[A-Za-z0-9-]+$/.test(host)))return null;
  return {host,port,address:(net.isIP(host)===6?'['+host+']':host)+':'+port};
 }catch{return null;}
}
const proxyKey=value=>{const p=proxyAddress(value);return p?p.address:'direct';};
export function probePort(host,port,ms=1500){return new Promise(resolve=>{
 let socket,settled=false;const finish=ok=>{if(settled)return;settled=true;clearTimeout(timer);socket?.destroy();resolve(ok);};
 const timer=setTimeout(()=>finish(false),ms);
 try{socket=net.connect({host,port});socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));}catch{finish(false);}
});}
function registered(host,{io=fs,diagnostic=()=>{},distribution=chromeDistribution()}={}){
 const files=Array.isArray(host?.manifestPath)?host.manifestPath:[host?.manifestPath];
 if(!host?.expectedBinary||files.some(f=>!f))return false;
 const current=files.filter(file=>path.basename(file)==='com.kenyu.chathand.browser.json');
 // A current registration never requires a second legacy file. Legacy-only
 // descriptors remain readable for older installed extensions.
 return (current.length?current:files).every(file=>{try{return chromeAccessOperation({flow:'repair',operation:'read',pathKind:'native_host',diagnostic},()=>{
  const st=io.lstatSync(file);if(!st.isFile()||st.isSymbolicLink())return false;
  const m=JSON.parse(io.readFileSync(file,'utf8'));
  return ['com.kenyu.chathand.browser','org.kenbridge.browser'].includes(m.name)&&path.basename(file)===m.name+'.json'&&m.path===host.expectedBinary&&m.type==='stdio'&&Array.isArray(m.allowed_origins)&&m.allowed_origins.length===1&&/^chrome-extension:\/\/[a-p]{32}\/$/.test(m.allowed_origins[0])&&(!storeMode(distribution)||m.allowed_origins[0]===`chrome-extension://${distribution.extension_id}/`);
 });}catch(e){if(e.code==='CHROME_DATA_ACCESS_DENIED')throw e;return false;}});
}
export async function ensureBrowserHost(deps){
 try{const s=await deps.snapshot();if(!browserFilesAllowed(s,deps))return 'skipped';if(storeMode(deps.distribution??chromeDistribution())&&(deps.distribution?.configuration_state!=='ready'))return 'pending';
  if(registered(deps.browserHost,{io:deps.io,diagnostic:deps.chromeDataDiagnostic,distribution:deps.distribution}))return 'ok';
  if(typeof deps.browserHost?.register!=='function')return 'failed';
  const registration=await deps.browserHost.register({flow:'repair',distribution:deps.distribution,registrationOnlyAfterOptIn:deps.registrationOnlyAfterOptIn===true,browserEnabled:s.settings?.browser_enabled,browserOptIn:explicitBrowserOptIn(deps)});if(registration?.skipped)return 'skipped';return registered(deps.browserHost,{io:deps.io,diagnostic:deps.chromeDataDiagnostic,distribution:deps.distribution})?'fixed':'failed';
 }catch(e){if(e.code==='CHROME_DATA_ACCESS_DENIED')throw e;return 'failed';}
}
const checks=[
 async ctx=>{const s=await ctx.snapshot();return s.enabled===false?result('action','AI 已暂停',action('resume','恢复'),'repair.paused.paused.message'):result('ok');},
 async ctx=>{const s=await ctx.snapshot();if(selectedSite(s))return s.site_b?.routes?.site?.configured===true&&s.credentials?.healthy===true&&s.credentials?.site_b===true?result('ok'):result('action','尚未连接 ChatGPT',action('open_wizard','打开设置向导'),'repair.credentials.notConnected.message');if(relay(s))return result('skipped','快捷连接无需检查此项',undefined,'repair.common.relaySkip.message');
  if(!s.settings?.tunnel?.tunnel_id)return result('action','尚未连接 ChatGPT',action('open_wizard','打开设置向导'),'repair.credentials.notConnected.message');
  return s.credentials?.healthy===true?result('ok'):result('action','运行密钥丢失，请重新填写',action('open_wizard','打开设置向导'),'repair.credentials.keyMissing.message');},
 async ctx=>{const s=await ctx.snapshot();if(selectedSite(s))return result('skipped');if(relay(s))return result('skipped','快捷连接无需检查此项',undefined,'repair.common.relaySkip.message');
  if(ctx.paused(s))return off();if(localReady(s))return result('ok');
  return await ctx.reconnect()?result('fixed'):result('failed','连接程序无法启动',undefined,'repair.common.tunnelFailed.message');},
 async ctx=>{const s=await ctx.snapshot();if(selectedSite(s))return result('skipped');if(relay(s))return result('skipped','快捷连接无需检查此项',undefined,'repair.common.relaySkip.message');
  if(ctx.paused(s))return off();const proxy=await ctx.systemProxy();
  if(proxyKey(proxy)===proxyKey(s.connection?.control_plane?.proxy))return result('ok');
  return await ctx.reconnect()?result('fixed'):result('failed','连接程序无法启动',undefined,'repair.common.tunnelFailed.message');},
 async ctx=>{const proxy=proxyAddress(await ctx.systemProxy());if(!proxy)return result('skipped','未设置代理，不检查',undefined,'repair.proxy_alive.noProxy.message');
  ctx.proxyAlive=await ctx.probePort(proxy.host,proxy.port,1500);
  return ctx.proxyAlive?result('ok'):result('action',`代理软件未运行（${proxy.address}），请打开代理软件`,undefined,'repair.common.proxyOff.message',{address:proxy.address});},
 async ctx=>{let s=await ctx.snapshot();if(selectedSite(s)){if(s.settings?.access_enabled===false)return off();return siteHealthy(s)?result('ok'):result('failed','这台 Mac 无法连接 ChatGPT',undefined,'repair.cloud.relayOffline.message');}if(relay(s))return s.relay?.online===true?result('ok'):result('failed','这台 Mac 无法连接 ChatGPT',undefined,'repair.cloud.relayOffline.message');
  if(ctx.paused(s))return off();if(s.connection?.control_plane?.state==='up')return result('ok');
  if(!ctx.reconnected)await ctx.reconnect();
  if(await ctx.wait(x=>x.connection?.control_plane?.state==='up',30000,{connection:true}))return result('fixed');
  const proxy=proxyAddress(await ctx.systemProxy());
  if(proxy&&ctx.proxyAlive===false)return result('failed',`代理软件未运行（${proxy.address}），请打开代理软件`,undefined,'repair.common.proxyOff.message',{address:proxy.address});
  return result('failed',proxy&&ctx.proxyAlive===true?'代理可用，但无法访问 OpenAI，请尝试更换节点':'这台 Mac 无法访问 OpenAI',undefined,proxy&&ctx.proxyAlive===true?'repair.cloud.proxyNoOpenAI.message':'repair.cloud.noOpenAI.message');},
 async ctx=>{const s=await ctx.snapshot();if(s.tools_list_status&&s.tools_list_status.state!=='current')return s.tools_list_status.state==='unknown'?result('skipped',s.tools_list_status.message,undefined,s.tools_list_status.message_key,s.tools_list_status.message_params):result('action',s.tools_list_status.message,action('open_chatgpt','打开 ChatGPT'),s.tools_list_status.message_key,s.tools_list_status.message_params);return s.setup_test?.status==='read_only'?result('action','ChatGPT 只能读取、无法写入：请在 ChatGPT 插件页打开 ChatHand，点击「刷新工具」',action('open_chatgpt','打开 ChatGPT'),'repair.chatgpt_tools.readOnly.message'):result('ok');},
 async ctx=>{try{const status=await ensureBrowserHost({...ctx.deps,snapshot:ctx.snapshot});if(status==='pending')return {...result('action'),code:'CHROME_STORE_CONFIGURATION_PENDING'};return result(status,status==='skipped'?'已关闭，不检查':status==='failed'?'Chrome 插件登记没修好':'',undefined,status==='skipped'?'repair.common.off.message':status==='failed'?'repair.browser_host.failed.message':null);}catch(e){if(e.code!=='CHROME_DATA_ACCESS_DENIED')throw e;ctx.chromeAccessDenied=true;return {...result('action','Chrome 设置访问被拒',action('chrome_data_access','打开隐私与安全性'),'ui.chrome.dataAccess.blocked'),code:e.code};}},
 async ctx=>{if(ctx.chromeAccessDenied)return {...result('action','Chrome 设置访问被拒',action('chrome_data_access','打开隐私与安全性'),'ui.chrome.dataAccess.blocked'),code:'CHROME_DATA_ACCESS_DENIED'};let s=await ctx.snapshot();if(!browserFilesAllowed(s,ctx.deps))return off();
  if(storeMode(ctx.deps.distribution??chromeDistribution())){
   if(ctx.deps.distribution?.configuration_state!=='ready')return {...result('action'),code:'CHROME_STORE_CONFIGURATION_PENDING'};
   let ext=s.automation?.browser?.extension;
   // 1081（Claude，Ken 10/27）：装过、只是没连上：Chrome 多数时候只是没开，先在后台打开它、等插件连上，跟旧装法一样。
   // 打开了还是没连上，按钮是「打开插件页面」（插件被删了在那页重新添加）；这台 Mac 打不开 Chrome，就说装 Chrome。
   if(ext?.connected!==true&&(ext?.installed===true||ext?.last_seen)){
    let opened=true;try{await ctx.openChromeInBackground();}catch(e){opened=e?.message!=='CHROME_OPEN_FAILED';}
    // 结果也记到插件那边（noteWakeFailed），「浏览器控制」页跟这里说的一样。
    if(!opened){ctx.deps.noteWakeFailed?.({chrome_open_failed:true});return {...result('action','无法在这台 Mac 上打开 Google Chrome',action('download_chrome','下载 Chrome'),'repair.browser_helper.noChrome.message'),code:'EXTENSION_DISCONNECTED'};}
    if(await ctx.wait(x=>x.automation?.browser?.extension?.connected===true&&chromeStoreUsable(x.automation.browser.extension.compatibility),10000))return result('fixed');
    s=await ctx.snapshot();ext=s.automation?.browser?.extension;
    if(ext?.connected!==true){ctx.deps.noteWakeFailed?.({});return {...result('action','已打开 Chrome，但插件仍未连接',action('open_extension_page','打开插件页面'),'repair.browser_helper.wakeFailed.message'),code:'EXTENSION_DISCONNECTED'};}
   }
   // 1081（Claude，Ken 10/27 10:03）：插件旧到用不了才算出了问题，说要更新，按钮「打开插件页面」；只缺后来加的动作照常能用，不算。
   if(ext?.connected===true&&ext.compatibility?.state==='incompatible')return {...result('action','Chrome 插件需要更新后才能继续使用',action('open_store_page','打开插件页面'),'repair.browser_helper.mismatch.message'),code:'CHROME_STORE_INCOMPATIBLE'};
   return ext?.connected===true&&chromeStoreUsable(ext?.compatibility)?result('ok'):{...result('action',undefined,action('install_helper','安装')),code:ext?.connected?'CHROME_STORE_INCOMPATIBLE':'EXTENSION_DISCONNECTED'};
  }
  if(s.automation?.browser?.extension?.connected===true)return result('ok');
  await ctx.openChromeInBackground();
  if(await ctx.wait(x=>x.automation?.browser?.extension?.connected===true,10000))return result('fixed');
  s=await ctx.snapshot();const ext=s.automation?.browser?.extension||{};
  return ext.installed===true||ext.last_seen||s.settings?.extension_last_seen?result('action','Chrome 插件无法连接',action('reconnect_browser','重新连接'),'repair.browser_helper.disconnected.message'):result('action','Chrome 插件未安装',action('install_helper','安装'),'repair.browser_helper.notInstalled.message');},
 async ctx=>{const s=await ctx.snapshot();if(!capabilityOn(s,'desktop'))return off();
  const p=s.automation?.computer?.permissions||{},missing=[p.accessibility!==true&&'辅助功能',p.screen_recording!==true&&'屏幕录制'].filter(Boolean);
  return missing.length?result('action','缺少'+missing.join('和')+'授权',action('grant_permission','前往授权'),p.accessibility!==true?(p.screen_recording!==true?'repair.desktop_permissions.missingBoth.message':'repair.desktop_permissions.missingAccessibility.message'):'repair.desktop_permissions.missingScreenRecording.message'):result('ok');},
 async ctx=>ctx.body.login_item_requires_approval===true?result('action','开机启动需要在系统设置中允许',action('open_login_items','打开系统设置'),'repair.login_item.needsApproval.message'):result('ok'),
 async ctx=>{const r=await ctx.cleanupUpgrade();return result(r?.cleaned? 'fixed':'ok');},
];
function summary(items){
 const count=status=>items.filter(x=>x.status===status).length,fixed=count('fixed'),action_needed=count('action'),failed=count('failed');
 let text=fixed?`已修复 ${fixed} 项`:'全部正常';
 if(action_needed)text=(fixed?text+'，':'')+`${action_needed} 项需手动处理`;
 if(failed)text=(fixed||action_needed?text+'，':'')+`${failed} 项未能修复，可点击「请 AI 检查」`;
 const parts=[fixed&&'fixed',action_needed&&'actionNeeded',failed&&'failed'].filter(Boolean);
 return {text,fixed,action_needed,failed,...messageMetadata('text','repair.summary.'+(parts.length?parts[0]+parts.slice(1).map(p=>p[0].toUpperCase()+p.slice(1)).join(''):'allOk'),{fixed,actionNeeded:action_needed,failed})};
}
function bounded(fn,ms){if(ms<=0)return Promise.reject(Error('REPAIR_TIMEOUT'));return new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(Error('REPAIR_TIMEOUT')),Math.max(1,ms));
 Promise.resolve().then(fn).then(resolve,reject).finally(()=>clearTimeout(timer));
});}
export class Repair {
 constructor(deps){this.deps={now:Date.now,sleep:ms=>new Promise(r=>setTimeout(r,ms)),probePort,...deps};this.value=null;}
 current(){return this.value;}
 start(body={}){
  if(this.value?.status==='running')return this.value;
  const value={id:crypto.randomUUID(),status:'running',started_at:this.deps.now(),finished_at:null,items:REPAIR_ITEMS.map(([id,title])=>({id,title,...messageMetadata('title','repair.'+id+'.title'),status:'pending',message:'',...messageMetadata('message')})),summary:null};
  this.value=value;queueMicrotask(()=>void this.run(value,{login_item_requires_approval:body?.login_item_requires_approval===true}));return value;
 }
 async run(value,body){
  const deps=this.deps,deadline=deps.now()+60000,wallDeadline=Date.now()+60000;
  const remaining=()=>Math.max(0,Math.min(deadline-deps.now(),wallDeadline-Date.now()));
  const ctx={deps,body,reconnected:false,proxyAlive:null,paused:s=>s.settings?.access_enabled===false||deps.mayReconnect?.()===false,
   snapshot:()=>bounded(()=>deps.snapshot(),remaining()),systemProxy:()=>bounded(()=>deps.systemProxy(),remaining()),
   probePort:(...args)=>bounded(()=>deps.probePort(...args),Math.min(1500,remaining())),
   openChromeInBackground:()=>bounded(()=>deps.openChromeInBackground(),Math.min(2000,remaining())),
   cleanupUpgrade:()=>bounded(()=>deps.cleanupUpgrade(),remaining()),
  };
  ctx.wait=async(predicate,ms,{connection=false}={})=>{const until=deps.now()+Math.min(ms,remaining());while(remaining()>0){
   const snapshot=await ctx.snapshot();if(connection&&ctx.paused(snapshot))return false;if(predicate(snapshot))return true;const left=Math.min(until-deps.now(),remaining());if(left<=0)return false;
   await deps.sleep(Math.min(250,left));
  }return false;};
  ctx.reconnect=async()=>{if(ctx.paused(await ctx.snapshot()))return false;const until=deps.now()+Math.min(15000,remaining());
   const started=await bounded(()=>deps.restoreTunnel(),Math.min(15000,remaining()));if(started?.ok===false)return false;ctx.reconnected=true;
   return ctx.wait(localReady,Math.max(0,until-deps.now()),{connection:true});
  };
  for(let i=0;i<checks.length;i++){
   const item=value.items[i];item.status='running';
   try{if(remaining()<=0)throw Error('REPAIR_TIMEOUT');Object.assign(item,await bounded(()=>checks[i](ctx),remaining()));}
   catch{Object.assign(item,result('failed','此项检查失败',undefined,'repair.common.checkFailed.message'));}
  }
  value.summary=summary(value.items);value.finished_at=deps.now();value.status='done';
 }
}
