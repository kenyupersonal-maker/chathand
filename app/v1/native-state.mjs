/** Minimal projection consumed by native poll/menu/features. No history/output/value. */
import {safeSiteConnectionStages} from './site-connection-stages.mjs';
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
export const NATIVE_STATE_FIELDS=Object.freeze({
 settings:['notifications','appearance','ui_zoom','mode','chatgpt_app_missing','chatgpt_app_identity','chatgpt_app_detail_url'],
 conversations:['id','project_id','title'],
 events:['id','kind','task_id','confirm_id','permission_id','title','body','scopes','admin','proxy','conversation_id'],
 confirmations:['id','item','task_id','state'],
 tasks:['task_id','title','status','created_at','jobs','conversation_id','project_id'],
 jobs:['job_id','status','process_alive','cleanup_pending'],approvals:['task_id','status'],inputs:['job_id','status'],
});
export function projectNativeState(value){
 const settings=pick(value.settings,NATIVE_STATE_FIELDS.settings);
 settings.conversations=(value.settings?.conversations||[]).map(v=>pick(v,NATIVE_STATE_FIELDS.conversations));
 const connection=pick(value.connection,['ready','healthy','error','display']);
 connection.automatic=pick(value.connection?.automatic,['phase']);connection.control_plane=pick(value.connection?.control_plane,['state']);
 const result={...(value.network_challenge_notification?{network_challenge_notification:pick(value.network_challenge_notification,['episode','at'])}:{}),...(value.setup_activity?{setup_activity:pick(value.setup_activity,['active','last_at','last_command','route','finished_at'])}:{}),settings,connection,tools_refresh:pick(value.tools_refresh,['detail_url']),relay:pick(value.relay,['online']),project:pick(value.project,['name','path','scope']),update:{...pick(value.update,['status','version']),install:pick(value.update?.install,['state'])},enabled:value.enabled,mode:value.mode,keep_awake:value.keep_awake,lifecycle:pick(value.lifecycle,['exit_requested']),instance_id:value.instance_id,installation_id:value.installation_id,
  setup:{key_watch:pick(value.setup?.key_watch,['active'])},site_b:{selected:value.site_b?.selected,...(value.site_b?.binding_replaced?{binding_replaced:pick(value.site_b.binding_replaced,['device_name','at'])}:{}),enrollment_watch:pick(value.site_b?.enrollment_watch,['watching','watch_id','expires_at','stopped_id','stopped_reason'])},computer:{pending:value.computer?.pending||0}};
 for(const field of ['events','tasks','jobs','approvals','inputs'])result[field]=(value[field]||[]).map(v=>pick(v,NATIVE_STATE_FIELDS[field]));
 const connectionStages=safeSiteConnectionStages(value.site_b?.connection_stages);if(connectionStages)result.site_b.connection_stages=connectionStages;
 result.confirmations=(value.confirmations||[]).map(v=>({...pick(v,['id','task_id','state']),item:pick(v.item,['id'])}));
 if(value.error!==undefined)result.error=value.error;
 return result;
}
