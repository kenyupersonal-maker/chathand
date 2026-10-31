// 1051: locally-owned matter records are data, never execution instructions.
import {fail} from '../../engine/src/core.mjs';
const s=n=>({type:'string',maxLength:n});
const obj=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const arr=(items,n)=>({type:'array',items,maxItems:n});
export const matterId={type:'string',pattern:'^CH-[1-9][0-9]*$'};
const states={type:'string',enum:['deferred','waiting_user','waiting_ai','resolved']};
const op={type:'string',pattern:'^[A-Za-z0-9_-]{1,96}$'};
const raw=obj({speaker:{type:'string'},text:{type:'string'},ref:{type:'string'},locator:{type:'string'},sha256:{type:'string'}},['speaker']);
const context=obj({speaker:{type:'string'},text:{type:'string'}},['speaker','text']);
const source=obj({kind:{type:'string',enum:['current','forwarded','suspected','imported']},label:{type:'string'},url:{type:'string'}},['kind']);
const evidence=obj({kind:{type:'string',enum:['user_report','source_report','screenshot','tool_receipt','independent_check','user_close']},ref:{type:'string'},sha256:{type:'string'},note:{type:'string'}},['kind','note']);
export const matterEntry=obj({operation_id:op,action:{type:'string',enum:['create','append','delete','restore']},id:matterId,base_revision:{type:'integer',minimum:1},title:s(60),raw,context:arr(context,4),source,understanding:s(600),answer:s(1200),state:states,waiting_for:s(160),evidence:arr(evidence,6),task_id:s(36),create_anyway:{type:'boolean'}},['operation_id','action']);
// The finish schema is intentionally concise; validateMatterEntry enforces the full
// write contract server-side, including lengths, enums and forbidden fields.
export const finishEntry=obj({
 operation_id:op,action:{type:'string',enum:['create','append']},id:matterId,
 base_revision:{type:'integer',minimum:1},title:s(60),raw:{type:'object'},
 context:{type:'array'},source:{type:'object'},understanding:s(600),answer:s(1200),
 state:states,waiting_for:s(160),evidence:{type:'array'}
},['operation_id','action']);
export const matterBeginField=arr(matterId,10);
export const matterFinishField=arr(finishEntry,10);
export const MATTER_RECORDING_RULE='用户说记一下、记录一下、记下来、帮我记、记个待办、提醒我、别忘了、先放着、回头再、以后再说，或 note/remember/remind me/later，先 matter_write（默认deferred）；写了文件也要建待办事项，文件路径放 raw.ref 或 evidence.ref。只有用户明确只要文档、存文件或出报告、没有记录意图时，才只写文件。保存成功后说「记下了，在『记一下』里」。';
export const MATTER_RECORDING_NOTE={kind:'matter_recording',zh:'记录类请求先 matter_write；写文件也要建待办事项并附 raw.ref/evidence.ref。明确仅文档/文件/报告才只写文件；保存成功说「记下了，在『记一下』里」。',en:'Record requests use matter_write first. Also create the matter when writing a file; attach its path in raw.ref/evidence.ref. Only explicit document/file/report-only intent skips it.'};
export const MATTER_TOOLS=[
 {name:'matter_write',description:'记一下 记录一下 记下来 帮我记 记个待办 提醒我 别忘了 先放着 回头再 以后再说 note remember remind me later：先记/Record first(默认deferred)。文件也记/file too:raw.ref/evidence.ref；仅明确只要文档/文件/报告例外。Only explicit document/file/report-only intent skips.成功/Saved说「记下了，在『记一下』里」。原话来源理解分开；同operation_id重试；不授权执行；软删可恢复。',inputSchema:obj({request_id:s(96),entries:arr(matterEntry,10)},['request_id','entries']),annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false,idempotentHint:true}},
 {name:'matter_query',description:'按编号或关键词查事项、旧答复和经过，返回当前版本，默认摘要分页；无会话证据不猜当前对话。',inputSchema:obj({ids:arr(matterId,10),selection_id:s(64),query:s(120),state:arr(states,4),scope:{type:'string',enum:['all','current_project','current_conversation']},view:{type:'string',enum:['summary','detail','history']},limit:{type:'integer',minimum:1,maximum:20},cursor:s(200)}),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true}}
];
export const MATTER_DELTAS={
 begin:{description:'matter_ids接手返各新版本；提示≠接手。',field:matterBeginField},
 finish:{description:'新建事项/追加本轮答复+文件ref；同操作号幂等、异文冲突；任务成功≠事项了结。',field:matterFinishField}
};
const cp=v=>[...String(v||'')].length;
const bad=(msg,code='MATTER_INVALID')=>fail(code,msg);
const string=(v,n,required=false)=>{if(v===undefined){if(required)bad('缺少必填字段');return;}if(typeof v!=='string'||cp(v)>n)bad('事项字段格式或长度不正确');};
const plain=(o,keys,required=[])=>{if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).some(k=>!keys.includes(k))||required.some(k=>!Object.hasOwn(o,k)))bad('事项字段不正确');};
const list=(a,n)=>{if(a===undefined)return;if(!Array.isArray(a)||a.length>n)bad('事项列表长度不正确');};
const validateRaw=r=>{if(r===undefined)return;plain(r,['speaker','text','ref','locator','sha256'],['speaker']);string(r.speaker,80,true);for(const k of ['text','ref','locator','sha256'])string(r[k],{text:12000,ref:2048,locator:200,sha256:64}[k]);if(!r.text&&!r.ref)bad('原话或原文引用不能为空');if(r.sha256&&!/^[a-f0-9]{64}$/i.test(r.sha256))bad('原文摘要格式不正确');};
export function validateMatterEntry(e,{finish=false}={}){
 plain(e,Object.keys(matterEntry.properties),['operation_id','action']);
 if(typeof e.operation_id!=='string'||!/^[A-Za-z0-9_-]{1,96}$/.test(e.operation_id))bad('operation_id 不正确');
 if(!['create','append',...(finish?[]:['delete','restore'])].includes(e.action))bad('事项动作不支持');
 if(e.action==='create'){string(e.title,60,true);if(!e.title.trim())bad('事项标题不能为空');validateRaw(e.raw);if(!e.raw?.text&&!e.raw?.ref)bad('新事项缺少原话');if(e.id!==undefined||e.base_revision!==undefined)bad('新事项编号由本机分配');}
 else{if(typeof e.id!=='string'||!/^CH-[1-9]\d*$/.test(e.id)||!Number.isInteger(e.base_revision)||e.base_revision<1)bad('事项编号/版本不正确');validateRaw(e.raw);}
 if(e.action==='append'&&!e.raw&&!e.answer&&!e.understanding&&!e.waiting_for&&!e.state&&!e.title&&!e.context&&!e.evidence)bad('追加内容为空');
 if(typeof e.create_anyway!=='undefined'&&typeof e.create_anyway!=='boolean')bad('查重选择错误');
 for(const k of ['title','understanding','answer','waiting_for','task_id'])string(e[k],{title:60,understanding:600,answer:1200,waiting_for:160,task_id:36}[k]);
 if(e.state!==undefined&&!states.enum.includes(e.state))bad('事项状态无效');
 if(e.state==='resolved'&&!e.answer&&!e.waiting_for&&!e.evidence?.some(x=>x.kind==='user_close'))bad('了结需要对应证据或理由');
 if(e.context!==undefined){list(e.context,4);for(const c of e.context){plain(c,['speaker','text'],['speaker','text']);string(c.speaker,80,true);string(c.text,600,true);}}
 if(e.source!==undefined){plain(e.source,['kind','label','url'],['kind']);if(!source.properties.kind.enum.includes(e.source.kind))bad('来源类型无效');string(e.source.label,120);string(e.source.url,2048);}
 if(e.evidence!==undefined){list(e.evidence,6);for(const x of e.evidence){plain(x,['kind','ref','sha256','note'],['kind','note']);if(!evidence.properties.kind.enum.includes(x.kind))bad('证据类型无效');string(x.ref,2048);string(x.sha256,64);string(x.note,200,true);}}
 return structuredClone(e);
}
export function validateMatterWrite(a,{finish=false}={}){plain(a,['request_id','entries'],['request_id','entries']);if(typeof a.request_id!=='string'||!/^[A-Za-z0-9_-]{8,96}$/.test(a.request_id))bad('批次请求编号无效');list(a.entries,10);if(!a.entries?.length)bad('事项列表不能为空');return a.entries.map(x=>validateMatterEntry(x,{finish}));}
export function validateMatterQuery(a={}){plain(a,Object.keys(MATTER_TOOLS[1].inputSchema.properties));list(a.ids,10);for(const id of a.ids||[])if(typeof id!=='string'||!/^CH-[1-9]\d*$/.test(id))bad('事项编号不正确');list(a.state,4);for(const state of a.state||[])if(!states.enum.includes(state))bad('事项状态不正确');for(const k of ['selection_id','query','cursor'])string(a[k],{selection_id:64,query:120,cursor:200}[k]);if(a.scope&&!['all','current_project','current_conversation'].includes(a.scope))bad('事项范围无效');if(a.view&&!['summary','detail','history'].includes(a.view))bad('事项视图无效');if(a.limit!==undefined&&(!Number.isInteger(a.limit)||a.limit<1||a.limit>20))bad('分页长度无效');return a;}
export function redactMatterText(v){if(typeof v!=='string')return v;return v.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]{5,})/gi,'[REDACTED]').replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi,'[REDACTED]');}
export function scrubMatter(value){if(typeof value==='string')return redactMatterText(value);if(Array.isArray(value))return value.map(scrubMatter);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,scrubMatter(v)]));return value;}
