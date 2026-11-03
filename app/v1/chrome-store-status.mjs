import {chromeStoreCompatibility} from './chrome-store-contract.mjs';
/** New-ID-only observation; legacy extension_last_seen is intentionally ignored. */
export function chromeStoreStatus(distribution,{session=null,lastSeen=0,helper=null,observation=null,now=Date.now(),contract}={}){
 const configured=distribution.configuration_state==='ready';
 const connected=configured&&!!session&&Number.isFinite(lastSeen)&&lastSeen>0&&now>=lastSeen&&now-lastSeen<7000&&helper?.session===session&&Number.isFinite(helper.seen_at)&&helper.seen_at>0&&now>=helper.seen_at&&now-helper.seen_at<7000;
 const observed=configured&&observation?.extension_id===distribution.extension_id&&Number.isFinite(observation.last_seen)&&observation.last_seen>0;
 return {...distribution,installed:connected?true:null,installation_previously_observed:observed,installation_state:observed?'observed':'unknown',installation_last_seen:observed?observation.last_seen:null,connected,connection_state:connected?'connected':'disconnected',state:connected?'connected':'disconnected',last_seen:configured&&lastSeen>0?lastSeen:null,compatibility:chromeStoreCompatibility(connected?helper:null,contract)};
}
// Window and model status share the same live installation claim. History is
// carried separately so disconnection never claims that the extension was removed.
export function browserModelStatus(value){
 const current=extension=>{
  if(extension?.distribution!=='chrome_web_store')return extension;
  const connected=extension.connected===true,presence=extension.presence,known=!connected&&['enabled','disabled','missing'].includes(presence?.state),ready=connected||known&&presence.state==='enabled'&&!presence.stalled,observed=extension.installation_previously_observed===true||extension.installation_state==='observed';
  return {...extension,installed:connected?true:null,installation_previously_observed:observed,installation_state:connected?'connected':'not_connected',available:ready,
   ...(known?{installed:presence.state!=='missing',installation_state:presence.state}:{}),
   detail:known?(presence.state==='missing'?(observed?'Chrome 插件已被移除。':'还没安装 Chrome 插件。'):presence.state==='disabled'?'Chrome 插件已被关闭。':presence.stalled?'Chrome 插件开着，但一直连不上 ChatHand。':'Chrome 插件已安装且已开启，可以使用浏览器控制。'):connected?'Chrome 插件已连接。':observed?'以前连接过 Chrome 插件，现在没有连接；这次状态检查没有读取网页。':'Chrome 插件现在没有连接；这次状态检查没有读取网页。',
   recovery:ready?null:known?(presence.state==='missing'?(observed?'请用户在 ChatHand 的「浏览器控制」点「重新安装」。':'请用户在 ChatHand 的「浏览器控制」点「安装插件」。'):presence.state==='disabled'?'请用户在 ChatHand 的「浏览器控制」点「去 Chrome 打开」。':'请用户在 ChatHand 的「浏览器控制」点「重新连接」。'):'请检查 Chrome 是否已打开、扩展是否启用或已被移除。关闭的扩展请重新启用；被移除的扩展请在 ChatHand 的浏览器控制中打开插件页面并重新添加。'};
 };
 const extension=current(value?.extension);
 return {...(value?.selected_backend==='extension'||value?.backend==='extension'?current(value):value),...(extension?{extension}:{})};
}
