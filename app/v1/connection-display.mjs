import {messageMetadata} from './message-metadata.mjs';
/** Public presentation only; execution authorization remains in ConnectionGrace/policy. */
export function connectionDisplay(c,{now=Date.now(),proxyProbe=null}={}){
 const a=c?.automatic||{},cp=c?.control_plane||{},local=!!(c?.process_running&&c?.healthy&&c?.ready);
 const display=(state,tone,title,detail='',connected=false,keys={})=>({state,tone,title,detail,connected,...messageMetadata('title',keys.title_key),...messageMetadata('detail',keys.detail_key),last_confirmed_at:cp.last_success_at||null,...(proxyProbe?{probe:proxyProbe}:{})});
 if(!local){
  if(a.error_code==='CREDENTIAL_SAVE_FAILED')return display('local_error','red','连接信息保存失败','请检查本机存储后重试。',false,{title_key:'connection.saveFailed.title',detail_key:'connection.saveFailed.detail'});
  if(a.phase==='needs_login')return display('local_error','red','连接信息未通过验证','请检查密钥与通道权限。',false,{title_key:'connection.authFailed.title',detail_key:'connection.authFailed.detail'});
  if(a.phase==='needs_retry')return display('local_error','red','暂时无法连接',a.message||'请检查网络后重试。',false,{title_key:'connection.retry.title',detail_key:a.message?null:'connection.retry.detail'});
  if(a.phase==='offline')return display('offline','red','网络连接不可用','请检查后重试。',false,{title_key:'connection.offline.title',detail_key:'connection.offline.detail'});
  if(['connecting','running','reconnecting','starting','restoring'].includes(a.phase))return display('connecting','gray','正在连接 ChatGPT','',false,{title_key:'connection.connecting.title'});
  return display('offline','red','尚未连接 ChatGPT',a.message||'',false,{title_key:'connection.notConnected.title'});
 }
 const episode=a.cloud_retry?.started_at,since=Math.min(cp.down_since??now,Number.isFinite(episode)?episode:now),age=Math.max(0,now-since),callRecent=Number.isFinite(cp.last_call_success_at)&&now-cp.last_call_success_at<15000;
 if(callRecent)return display('up','green','已连接','',true,{title_key:'connection.connected.title'});
 if(cp.state==='up')return display('up','green','已连接','',true,{title_key:'connection.connected.title'});
 if(cp.state==='down')return display('down','red','无法连接',proxyProbe?.reachable===false&&proxyProbe.via_system_proxy===true?'代理节点可能已断开':cp.down_since?'云端持续无响应':'云端无响应',false,{title_key:'connection.down.title',detail_key:proxyProbe?.reachable===false&&proxyProbe.via_system_proxy===true?'connection.downProxyNode.detail':cp.down_since?'connection.downStill.detail':'connection.downNoReply.detail'});
 if(cp.state==='checking'){
  if(age>=120000)return display('down','red','无法连接','云端持续无响应',false,{title_key:'connection.down.title',detail_key:'connection.downStill.detail'});
  if(age>=15000)return {...display('up','green','已连接','',true,{title_key:'connection.connected.title'}),last_confirmed_at:null,settings_warning:{tone:'yellow',title:'云端状态待确认',detail:'本机通道仍在运行，正在核对云端状态。',...messageMetadata('title','connection.cloudPending.title'),...messageMetadata('detail','connection.cloudPending.detail')}};
 }
 return display('up','green','已连接','',true,{title_key:'connection.connected.title'});
}
