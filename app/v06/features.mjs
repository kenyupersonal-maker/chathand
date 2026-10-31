import {PACING} from '../v1/pacing.mjs';
import fs from 'node:fs';
import {VERSION} from '../product.mjs';
import {FileReader,inspectFile} from './files.mjs';
import {SearchManager} from './search.mjs';
import {systemInspect,gitInspect,desktopAction} from './diagnostics.mjs';
import {Changes,editFile,taskHistory} from './changes.mjs';
import {fail,withFileTask} from '../../engine/src/core.mjs';
import {IMAGE_BATCH_URI,LEGACY_IMAGE_BATCH_URI,widgetURI} from '../v1/image-batch.mjs';
import {splitCardResult} from '../v1/card-meta.mjs';
import {publishedWidgetKind} from '../v1/widget-resource-aliases.mjs';
export const TASK_URI=widgetURI('task','../../ui/task-widget.html');
// Official CSP aliases: camelCase MCP fields, snake_case OpenAI fields.
// Offline assets need no network origins; no domain is fabricated.
export const widgetResourceMeta=()=>({ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}},'openai/widgetPrefersBorder':true,'openai/widgetCSP':{connect_domains:[],resource_domains:[]}});
export const LEGACY_TASK_URI='ui://ken-bridge/task-v06.html';
const str={type:'string'},int=(min,max)=>({type:'integer',minimum:min,maximum:max});
const tool=(name,description,properties,required=[],read=true)=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint:read,destructiveHint:!read,openWorldHint:false,idempotentHint:read}});
export const FEATURE_TOOLS=[
  tool('read_file','Read a local document in the current access scope. Text uses byte offset + returned next_offset and fingerprint, not line numbers. DOCX uses paragraph offset; CSV uses row offset; PDF uses zero-based page offset. XLSX uses sheet/range. SQLite runs read-only SQL; formulas and macros never execute. Images return actual image content. 写文件用 write_text，建文件夹用 create_directory，跑命令用 propose_command；看不到就先加载 ChatHand 的全部工具。',{path:str,format:{...str,enum:['auto','text','docx','xlsx','csv','plist','sqlite','pdf','image']},offset:int(0,Number.MAX_SAFE_INTEGER),limit:int(1,1000),max_bytes:int(4,131072),encoding:str,fingerprint:str,sheet:str,range:str,query:str,parameters:str},['path']),
  tool('get_file_info','Read file size, modification time and fingerprint; SHA-256 is included only for files up to 8 MiB.',{path:str},['path']),
  tool('edit_file','Replace exactly one matching text block in a UTF-8 file up to 8 MiB. Requires current SHA-256 and stable operation_id. Backup is saved before the atomic write.',{task_id:str,path:str,old_text:str,new_text:str,expected_sha256:str,operation_id:str},['task_id','path','old_text','new_text','expected_sha256','operation_id'],false),
  tool('start_search','Start a cancellable local search in the current scope. files uses simple * and ? wildcards; content uses literal text. Results explicitly disclose scan limits and skipped files. Use search_results until completed; do not equate a partial search with absence. 带path和file_pattern先缩小范围，即使整台电脑也不从根搜；incomplete时缩小路径，不换词从头扫。',{path:str,query:str,type:{...str,enum:['files','content']},file_pattern:str,include_hidden:{type:'boolean'},case_sensitive:{type:'boolean'},max_results:int(1,1000)},['query']),
  tool('search_results','Read a bounded page from this authenticated session’s search. For stable pagination, let the scan finish, then follow next_offset/next_cursor. While running, results are only provisional; incomplete/scan-budget limits explicitly prevent full-count claims. wait_ms 0–20000等到完成或到时，在这一轮里等，不要空轮询。',{search_id:str,offset:int(0,1000),limit:int(1,100),cursor:{type:'string',maxLength:100},wait_ms:int(0,PACING.wait.poll_ms)},['search_id']),
  tool('stop_search','Stop only the identified search. Does not change files or permissions.',{search_id:str},['search_id'],false),
  tool('system_inspect','Read system, process, listening port or disk diagnostics. No network traffic probes, secret environment variables, or process termination.',{section:{...str,enum:['summary','processes','ports','disk']}}),
  tool('git_inspect','Read repository status, working-tree diff, recent log or current branch. No commits, checkout, restore, hooks, external diffs or text-conversion execution.',{path:str,action:{...str,enum:['status','diff','log','branch']}}),
  tool('desktop_action','Reveal an allowed local file in Finder or open an HTTPS/localhost preview URL. Requires an active task; does not grant screen, keyboard or mouse control.',{task_id:str,action:{...str,enum:['reveal','open_url']},path:str,url:str},['task_id','action'],false),
  tool('task_history','Page this authenticated caller’s current-project AND current-session tasks, including all safe saved receipts (not merely the first 2,000). limit 1–100, default 20. Compact task summaries by default; detail:true returns the original full records. Follow next_offset with next_cursor; a changed snapshot refuses stale cursors. total is null when some source entries are unreadable; truncated/incomplete are explicit. Stored receipts never grant execution.',{detail:{type:'boolean'},limit:int(1,100),offset:int(0,Number.MAX_SAFE_INTEGER),cursor:{type:'string',maxLength:100}}),
  tool('task_changes','Read metadata for a task’s file changes; optional operation_id returns up to 300 lines before/after, only when the current scope still permits the file.',{task_id:str,operation_id:str},['task_id']),
  {...tool('show_task','Render the status and recorded file changes of one existing task. Only call it when chathand_forecast in a result asks for it or the user asks to see the task. 普通任务开工不调它，结果卡由 finish_task 出。 Read task_status first when deciding whether more execution is needed; this render tool never starts or resumes work.',{task_id:str},['task_id']),_meta:{ui:{resourceUri:TASK_URI},'openai/outputTemplate':TASK_URI}}
];
export class Features {
  constructor(state,store,queue,policy){
    Object.assign(this,{state,store,queue,policy});this.reader=new FileReader(store);this.search=new SearchManager(store,policy);this.changes=new Changes(store,policy);
    const prev=policy.onRevoke;policy.onRevoke=reason=>{prev?.(reason);this.cancel();};
  }
  cancel(){this.reader.cancel();this.search.cancelAll();}
  has(name){return FEATURE_TOOLS.some(t=>t.name===name);}
  async invoke(name,o,caller,{session_hash=null}={}){
    const {store,policy}=this;policy.check();
    const epoch=policy.epoch;let result;
    switch(name){
      case 'read_file':return this.reader.read(o);
      case 'get_file_info':return inspectFile(store,o.path);
      case 'edit_file':policy.require(o.task_id,caller);return this.changes.capture(o.task_id,name,o,()=>withFileTask(store,policy.get(o.task_id,caller),()=>editFile(store,o)));
      case 'start_search':return this.search.start(o,caller,session_hash);
      case 'search_results':return this.search.results(o.search_id,caller,session_hash,o.offset??0,o.limit??50,o.cursor??null,o.wait_ms??0);
      case 'stop_search':return this.search.stop(o.search_id,caller,session_hash);
      case 'system_inspect':result=await systemInspect(store,o.section);break;
      case 'git_inspect':result=await gitInspect(store,o);break;
      case 'desktop_action':policy.require(o.task_id,caller);return desktopAction(store,o);
      case 'task_history':return taskHistory(policy,caller,o,session_hash);
      case 'task_changes':return o.operation_id?this.changes.preview(o.task_id,o.operation_id,caller):{changes:this.changes.read(o.task_id,caller)};
      case 'show_task':return {task:policy.view(policy.get(o.task_id,caller)),changes:this.changes.read(o.task_id,caller),scope:this.state.data.mode,version:VERSION};
      default:fail('TOOL_UNKNOWN','工具不存在。');
    }
    policy.check();if(epoch!==policy.epoch)fail('RESULT_REVOKED','权限已改变，诊断结果已丢弃。');return result;
  }
  resources(){return {resources:[{uri:TASK_URI,name:'ChatHand task',mimeType:'text/html;profile=mcp-app'},{uri:IMAGE_BATCH_URI,name:'ChatHand 连续出图',mimeType:'text/html;profile=mcp-app'}]};}
  resource(uri){
    if(typeof uri==='string'&&/^ui:\/\/chathand\/probe-[a-f0-9]{10}\.html$/.test(uri))fail('RESOURCE_MISSING','探针已退出，请用 ChatHand 窗口或 Mac 通知授权。');
    // 旧地址（还开着的老对话会来要）也给现在的卡片。
    const kind=publishedWidgetKind(uri);
    const file=uri===TASK_URI||uri===LEGACY_TASK_URI||kind==='task'?'../../ui/task-widget.html':uri===IMAGE_BATCH_URI||uri===LEGACY_IMAGE_BATCH_URI||kind==='image-batch'?'../../ui/image-batch-widget.html':null;if(!file)fail('RESOURCE_MISSING','界面资源不存在。');
    return {contents:[{uri,mimeType:'text/html;profile=mcp-app',text:fs.readFileSync(new URL(file,import.meta.url),'utf8'),_meta:widgetResourceMeta()}]};
  }
}
export function toolResult(raw){
  const {value:result,meta:cardMeta}=splitCardResult(raw),extra=cardMeta===undefined?{}:{_meta:cardMeta};
  if(result?.image_base64){const {image_base64,...meta}=result;return {content:[{type:'text',text:JSON.stringify(meta)},{type:'image',mimeType:result.mimeType,data:image_base64}],structuredContent:meta,isError:false,...extra};}
  return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:false,...extra};
}
