// 1052 D1 / R04（Claude 写，Codex 审和测）：一次工具调用的身份，只从服务端给的上下文来。
// 五样东西分开，各管各的：
// - transportSource：哪条入口送进来的。只认服务端接线写的 local_http / relay / site_b；
//   进程内直接调用（测试、内部刷新）记成 direct_rpc。请求体、_meta、参数里写什么都不算。
// - connectionPrincipal：已认证的连接主体（隧道令牌、中转账号、Site 的 owner+binding+generation）
//   的摘要标记。只来自服务端上下文。
// - sessionBinding：principal 加上 ChatGPT 给的会话号算出来的会话摘要。会话号本身是客户端给的，
//   单独不算身份；只有和已认证的 principal 绑在一起才算。
// - mcpProtocolVersion：客户端自报的协议版本，只决定回包格式和卡片走法，从不用来判断身份或路线。
// - invocationClass：ordinary（模型调用）/ private_card（已证明的私有卡片）/ host_probe（Site 的固定探针）。
import crypto from 'node:crypto';
import {sessionHashOf} from './resume.mjs';

export const TRANSPORT_SOURCES=Object.freeze(['local_http','relay','site_b']);
export const A_TRANSPORTS=Object.freeze(['local_http','relay']);
const CLASSES=new Set(['ordinary','private_card','host_probe']);

export function principalTag(principal){
 if(typeof principal!=='string'||!principal||principal.length>4096)return null;
 return 'cp:'+crypto.createHash('sha256').update('chathand-connection-principal-v1\0'+principal).digest('hex').slice(0,48);
}

// serverContext comes from server/relay/Site wiring in this process. body is
// the JSON-RPC request; only its _meta session string and protocol version are
// read, and neither can change transportSource or connectionPrincipal.
export function callContext(serverContext={},body=null,{invocationClass='ordinary'}={}){
 const source=TRANSPORT_SOURCES.includes(serverContext?.transport)?serverContext.transport:'direct_rpc';
 const principal=typeof serverContext?.connectionPrincipal==='string'&&serverContext.connectionPrincipal?serverContext.connectionPrincipal:serverContext?.setupPrincipal;
 const meta=body?.params?._meta,session=typeof meta?.['openai/session']==='string'?meta['openai/session']:undefined;
 const modern=meta?.['io.modelcontextprotocol/protocolVersion']==='2026-07-28';
 const mcpProtocolVersion=modern?'2026-07-28':'legacy';
 return Object.freeze({
  transportSource:source,
  connectionPrincipal:principalTag(principal),
  sessionBinding:sessionHashOf(serverContext?.setupPrincipal,session),
  mcpProtocolVersion,
  invocationClass:CLASSES.has(invocationClass)?invocationClass:'ordinary',
  // A network route is not an MCP version. Authenticated Site carries the
  // private App contract without pretending that its client reported a date.
  cardDomain:source==='site_b'?'site_b':mcpProtocolVersion,
  relayMode:source==='site_b'||modern?'mcp_app':'legacy',
  // The old single `transport` value that card/relay code still keys on.
  // Site keeps its own label; everything else is the protocol label, as before.
  legacyTransport:source==='site_b'?'site_b':mcpProtocolVersion,
  session,
  setupPrincipal:serverContext?.setupPrincipal
 });
}
