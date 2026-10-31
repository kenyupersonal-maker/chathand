/** Evidence stages only. Never grants execution or infers platform registration. */
export const SITE_MANIFEST_REQUEST_LIMIT_BYTES=1900000;
const number=v=>Number.isSafeInteger(v)&&v>=0?v:null;
const timestamp=v=>Number.isSafeInteger(v)&&v>0?v:null;
const code=v=>typeof v==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(v)?v:null;
const SHA=/^[a-f0-9]{64}$/;
export function runtimeManifestMetrics(manifest,settings){
 const manifestBytes=Buffer.byteLength(JSON.stringify(manifest),'utf8'),requestBytes=Buffer.byteLength(JSON.stringify({manifest,settings}),'utf8');
 return {manifest_bytes:manifestBytes,request_bytes:requestBytes,limit_bytes:SITE_MANIFEST_REQUEST_LIMIT_BYTES,headroom_bytes:SITE_MANIFEST_REQUEST_LIMIT_BYTES-requestBytes,tool_count:manifest.tools?.tools?.length||0,resource_count:manifest.resources?.resources?.length||0,alias_count:Math.max(0,Object.keys(manifest.resourceContents||{}).length-(manifest.resources?.resources?.length||0))};
}
export function siteConnectionStages({selected='openai',route={},pairing={},transport={},app={},now=Date.now()}={}){
 const selectedRoute=selected==='site'?'site':'openai',configured=route.configured===1||route.configured===true,epoch=number(transport.transport_epoch);
 const raw=transport.runtime_manifest||{},current=epoch!==null&&raw.transport_epoch===epoch;
 const manifestState=current&&['preparing','uploading','accepted','rejected'].includes(raw.state)?raw.state:'unknown';
 const manifest={state:manifestState,reason_code:current?code(raw.reason_code)||'MANIFEST_NOT_OBSERVED':'MANIFEST_NOT_OBSERVED_CURRENT_SESSION',observed_at:current?number(raw.observed_at):null,
  request_bytes:current?number(raw.request_bytes):null,manifest_bytes:current?number(raw.manifest_bytes):null,limit_bytes:current?number(raw.limit_bytes):SITE_MANIFEST_REQUEST_LIMIT_BYTES,
  headroom_bytes:current&&Number.isSafeInteger(raw.headroom_bytes)?raw.headroom_bytes:null,tool_count:current?number(raw.tool_count):null,resource_count:current?number(raw.resource_count):null,alias_count:current?number(raw.alias_count):null,
  revision:current&&SHA.test(raw.revision||'')?raw.revision:null,accepted_at:manifestState==='accepted'?number(raw.accepted_at):null,transport_epoch:epoch,remote_limit_bytes:current?number(raw.remote_limit_bytes):null,row_budget_bytes:current?number(raw.row_budget_bytes):null,row_limit_bytes:current?number(raw.row_limit_bytes):null};
 const verified=timestamp(route.last_verified),fresh=route.state==='healthy'&&verified!==null&&now>=verified&&now-verified<30000;
 const ready=transport.ready===true&&transport.authenticated===true&&transport.phase==='running';
 const reachable=selectedRoute==='site'&&configured&&ready&&fresh;
 const failure=code(transport.last_error_code)||code(route.reason);
 const deviceState=reachable?'reachable':selectedRoute!=='site'?'unknown':!configured?'unconfigured':transport.running===false?'stopped':transport.phase==='reconnecting'?'reconnecting':'unreachable';
 const call=transport.last_successful_call||{},succeededAt=timestamp(call.succeeded_at),sameCall=epoch!==null&&call.transport_epoch===epoch,age=succeededAt!==null&&now>=succeededAt?now-succeededAt:null;
 const recent=reachable&&sameCall&&age!==null&&age<15000;
 const registered=app.registered_locally===true,missing=app.missing===true,retest=app.retest_required===true;
 const observations=[timestamp(pairing.updated_at),current?timestamp(raw.observed_at):null,verified,succeededAt,timestamp(app.observed_at),timestamp(app.missing_detected_at),timestamp(transport.heartbeat_at)].filter(at=>at!==null);
 const ws=transport.websocket||{},wsCurrent=epoch!==null&&ws.transport_epoch===epoch;
 const websocket={state:wsCurrent&&['connecting','connected','reconnecting','disconnected','stopped'].includes(ws.state)?ws.state:'unknown',reason_code:wsCurrent?code(ws.reason_code)||'WS_NOT_OBSERVED':'WS_NOT_OBSERVED_CURRENT_SESSION',observed_at:wsCurrent?timestamp(ws.observed_at):null,connected_at:wsCurrent?timestamp(ws.connected_at):null,disconnected_at:wsCurrent?timestamp(ws.disconnected_at):null,heartbeat_at:wsCurrent?timestamp(ws.heartbeat_ack_at):null,transport_epoch:epoch};
 if(websocket.observed_at!==null)observations.push(websocket.observed_at);
 const challenge=transport.network_challenge;
 const network_challenge=challenge?.transport_epoch===epoch&&timestamp(challenge?.at)!==null?{at:challenge.at}:null;
 return {version:1,network_challenge,selected_route:selectedRoute,observed_at:observations.length?Math.max(...observations):null,
  websocket,
  pairing:{state:configured?'paired':pairing.phase==='pairing'?'pairing':'unconfigured',reason_code:configured?'PAIRING_SAVED':code(pairing.error_code)||'PAIRING_NOT_CONFIGURED',observed_at:number(pairing.updated_at),configured},
  manifest,
  device:{state:deviceState,reason_code:reachable?'DEVICE_HEARTBEAT_CURRENT':selectedRoute!=='site'?'SITE_ROUTE_NOT_SELECTED':failure||(!configured?'PAIRING_NOT_CONFIGURED':ready?'DEVICE_HEALTH_STALE':'DEVICE_NOT_REACHABLE'),observed_at:verified,ready,health_fresh:fresh,heartbeat_at:number(transport.heartbeat_at),transport_epoch:epoch},
  chatgpt_app:{state:missing?'missing':!registered?'unknown':retest?'retest_required':'recorded',reason_code:missing?'APP_REPORTED_MISSING':!registered?'APP_REGISTRATION_NOT_OBSERVED':retest?'APP_RETEST_REQUIRED':'APP_IDENTITY_RECORDED',observed_at:number(app.observed_at),registered_locally:registered,retest_required:retest,missing_detected_at:number(app.missing_detected_at),platform_verification:'unknown'},
  last_call:{state:succeededAt===null?'not_observed':recent?'succeeded':'historical',reason_code:succeededAt===null?'SUCCESSFUL_CALL_NOT_OBSERVED':recent?'SUCCESSFUL_CALL_CURRENT_SESSION':'HISTORICAL_CALL_DOES_NOT_PROVE_CONNECTIVITY',observed_at:succeededAt,succeeded_at:succeededAt,transport_epoch:number(call.transport_epoch),current_binding:sameCall}
 };
}
const stages={websocket:['state','reason_code','observed_at','connected_at','disconnected_at','heartbeat_at','transport_epoch'],pairing:['state','reason_code','observed_at','configured'],manifest:['state','reason_code','observed_at','request_bytes','manifest_bytes','limit_bytes','headroom_bytes','tool_count','resource_count','alias_count','revision','accepted_at','transport_epoch','remote_limit_bytes','row_budget_bytes','row_limit_bytes'],device:['state','reason_code','observed_at','ready','health_fresh','heartbeat_at','transport_epoch'],chatgpt_app:['state','reason_code','observed_at','registered_locally','retest_required','missing_detected_at','platform_verification'],last_call:['state','reason_code','observed_at','succeeded_at','transport_epoch','current_binding']};
const states=new Set(['connecting','connected','disconnected','unknown','paired','pairing','unconfigured','preparing','uploading','accepted','rejected','reachable','stopped','reconnecting','unreachable','missing','retest_required','recorded','not_observed','succeeded','historical']);
const booleans=new Set(['configured','ready','health_fresh','registered_locally','retest_required','current_binding']);
/** Same whitelist for diagnostics and native transport; no IDs, URLs or payloads. */
export function safeSiteConnectionStages(value){
 if(value?.version!==1)return null;
 const result={version:1,network_challenge:timestamp(value.network_challenge?.at)!==null?{at:value.network_challenge.at}:null,selected_route:value.selected_route==='site'?'site':'openai',observed_at:number(value.observed_at)};
 for(const [name,keys] of Object.entries(stages))result[name]=Object.fromEntries(keys.map(key=>{const v=value[name]?.[key];return [key,key==='state'?states.has(v)?v:'unknown':key==='reason_code'?code(v)||'REDACTED':key==='platform_verification'?'unknown':key==='revision'?SHA.test(v||'')?v:null:booleans.has(key)?v===true:key==='headroom_bytes'&&Number.isSafeInteger(v)?v:number(v)];}));
 return result;
}
