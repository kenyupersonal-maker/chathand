import crypto from 'node:crypto';
import fs from 'node:fs';
const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
export const VERSION=pkg.version;
export const RUNTIME_API=pkg.kenBridge.runtime_api;
export const CONNECTOR_API=pkg.kenBridge.connector_api;
// Same visibility metadata used by host manifests; registry/contract stay complete.
export const isPrivateTool=tool=>tool?._meta?.['openai/visibility']==='private'||Array.isArray(tool?._meta?.ui?.visibility)&&!tool._meta.ui.visibility.includes('model');
export const modelTools=tools=>tools.filter(tool=>!isPrivateTool(tool));
export const manifest=tools=>({version:VERSION,connector_api:CONNECTOR_API,tool_count:tools.length,tool_names:tools.map(t=>t.name),schema_sha256:crypto.createHash('sha256').update(JSON.stringify(tools)).digest('hex')});
/** Connection state is observation-based, never an optimistic UI-only green tick. */
export function readiness({connection,lastCheck,enabled,relay}){
 const relayVerified=lastCheck?.caller?.startsWith('relay:')===true; const privateVerified=lastCheck?.caller==='chatgpt';
 if(relay?.online)return {stage:relayVerified?'verified':'waiting_for_ai',title:relayVerified?'账号连接已验证':'设备在线，等待 AI 验证',can_execute:!!enabled};
 if(connection?.display?connection.display.connected===true:connection?.ready&&connection?.healthy&&connection?.process_running)return {stage:privateVerified?'verified':'waiting_for_ai',title:connection.display?.title||(privateVerified?'ChatGPT 连接已验证':'连接已就绪，等待 AI 验证'),can_execute:!!enabled};
 if(connection?.display)return {stage:connection.process_running?'connecting':'not_connected',title:connection.display.title,can_execute:false};
 if(connection?.process_running)return {stage:'connecting',title:'正在建立连接',can_execute:false};
 return {stage:'not_connected',title:'连接你的 AI',can_execute:false};
}
