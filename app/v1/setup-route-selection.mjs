import {fail} from '../../engine/src/core.mjs';
/** Selecting a handoff is read-only. The store's revision-zero openai row is
 * bootstrap state, not evidence of a user's choice. */
export function setupRouteSelection({explicit,selection,openai,site,state={}}={}){
 if(explicit!==undefined){if(!['openai','site'].includes(explicit))fail('ARG_INVALID','连接方式无效。');return explicit;}
 if(selection?.selected==='site')return 'site';
 if(selection?.selected==='openai'&&(selection.revision>0||openai?.configured===1||!!state.tunnel||['tunnel','relay'].includes(state.connection_preference)))return 'openai';
 if(site?.configured===1)return 'site';
 return 'openai';
}
