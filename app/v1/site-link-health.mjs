// A recoverable transport outage may retain only the same configured identity.
export const SITE_TRANSIENT_REASONS=Object.freeze(['B_SITE_NETWORK_CHALLENGE','B_SITE_NETWORK_FAILED','B_SITE_REQUEST_TIMEOUT','B_REMOTE_TRANSIENT','B_REMOTE_RATE_LIMITED','WS_CONNECT_FAILED','WS_UPGRADE_TIMEOUT']);
export function siteLinkFailure(route,transport={}){
 if(!route?.configured)return {immediate:true,reason:'not_configured'};
 if(transport.phase==='unconfigured_or_stopped')return {immediate:true,reason:'transport_stopped'};
 const reason=route.reason||transport.last_error_code||null;
 if(route.state==='auth_required')return {immediate:true,reason:reason||'auth_required'};
 if(reason&&(/^(?:WS_UPGRADE_HTTP_(?:408|429|5[0-9]{2}))$/.test(reason)||['WS_CLOSED','WS_CLOCK_TIMEOUT','WS_START_TIMEOUT','WS_CHUNK_ACK_TIMEOUT','WS_FRAME_PROTOCOL','WS_CONTROL_PROTOCOL','WS_FRAGMENT_PROTOCOL','WS_PROTOCOL_INVALID'].includes(reason))&&['running','reconnecting'].includes(transport.phase))return {immediate:false,reason};
 if(reason&&SITE_TRANSIENT_REASONS.includes(reason))return {immediate:false,reason};
 if(route.state==='failed'||reason&&/^(?:B_|WS_)/.test(reason))return {immediate:true,reason:reason||'failed'};
 return {immediate:false,reason};
}
