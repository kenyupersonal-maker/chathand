import {READ_TASK_INTERNAL} from './v1/read-task-tracker.mjs';
import {OnboardingTelemetry,onboardingFailure} from './onboarding-telemetry.mjs';
import {t as displayText} from './i18n.mjs';
import {PACING} from './v1/pacing.mjs';
import {CapabilityRegistry,RUN_CAPABILITY_TOOL} from './v1/capabilities.mjs';
import {AutoTaskExecution,AUTO_TASK_INTERNAL,AUTO_TASK_IDENTITY,AUTO_TASK_WRAPPER_TOOLS} from './v1/auto-task-execution.mjs';
import {widgetShellPresentation} from './v1/widget-shell.mjs';
import {protocolIcons} from './v1/protocol-icons.mjs';
import {chathandGuide} from './v1/guide.mjs';
import {briefJob,jobRunning} from './v1/command-brief.mjs';
import {inputReplay} from './v1/input-retention.mjs';
import {cardTaskView} from './v1/card-task-view.mjs';
import {TaskContinuity} from './v1/task-continuity.mjs';
import {beforeSiteExecution,assertSiteExecution,currentSiteExecution} from './v1/site-execution-context.mjs';
import {bindActivity} from './v09/product-model.mjs';
import {SetupTest} from './v1/setup-test.mjs';
import {createSetupProgress} from './v09/setup-progress.mjs';
import {ValueStats,TOOL_CATEGORIES} from './v1/value-stats.mjs';
import {ArtifactImportManager,ARTIFACT_TOOLS,artifactObserverArgs,artifactObserverBody} from './v1/artifact-import.mjs';
import {ImageBatchManager,IMAGE_BATCH_TOOLS,validateImageBatchToolArgs} from './v1/image-batch.mjs';
import {Features,FEATURE_TOOLS,toolResult,TASK_URI} from './v06/features.mjs';
import {editFile} from './v06/changes.mjs';
import {desktopAction} from './v06/diagnostics.mjs';
import {splitCardResult,observableToolResult,withTaskCard} from './v1/card-meta.mjs';
import {Automation,AUTOMATION_TOOLS} from './v07/automation.mjs';
import {COMPUTER_TOOL_UPGRADES,COMPUTER_INSTRUCTIONS,DESKTOP_OPEN_PATH_FIELDS,validateComputerToolArgs} from './v07/computer.mjs';
import {BROWSER_EXPERIENCE_TOOLS,browserToolDefinition,invokeBrowserExperience,validateBrowserTool} from './v09/browser-experience-tools.mjs';
import {NEW_TOOLS_CONVERSATION_NOTE} from './v1/tool-list-proof.mjs';
import {WORKFLOW_INSTRUCTIONS,errorRecovery} from './v1/workflow.mjs';
import {blockedForError,scopeReceipt} from './v1/blocked.mjs';
import {Confirmations,bindConfirmations,commandHash} from './v1/confirmations.mjs';
import {H8Cards,CARD_ACTIONS,cardObserverBody} from './v1/h8-cards.mjs';
import {digestJob} from './v1/output-digest.mjs';
import {CommandCompletionNotes} from './v1/command-completion.mjs';
import {DiagnosticEvents,validCardErrors} from './diagnostic-events.mjs';
import {CallTrace,measureResponseLength} from './call-trace.mjs';
import {appendActivityNote,readTaskActivity} from './v1/activity-notes.mjs';
import {HistoryExporter} from './v1/history-export.mjs';
import {compactToolReturn} from './v1/return-archive.mjs';
import {taskWaitState} from './v1/wait-state.mjs';
import {ResumeKeeper,sessionHashOf} from './v1/resume.mjs';import {STEP_WORDS} from './v1/tools-refresh.mjs';import {MATTER_RECORDING_RULE,MATTER_RECORDING_NOTE,MATTER_TOOLS,MATTER_DELTAS,matterBeginField,matterFinishField,validateMatterEntry,validateMatterWrite,validateMatterQuery} from './v1/matter-contract.mjs';
import {VERSION,manifest,modelTools,isPrivateTool} from './product.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {TOOLS as LEGACY,validate,withCacheHints,toolListCapabilities} from '../engine/src/mcp.mjs';
import {cleanError,fail} from '../engine/src/core.mjs';
import {APP_ROOT} from './v06/access.mjs';
import {callContext,A_TRANSPORTS} from './v1/call-context.mjs';
import {Blocks,CAPABILITIES,capabilityOf,capabilityOn,capabilityAllowed,capabilityError,gateCommand,permissionsInfo,adminReadyFor,selfInfo} from './v1/permissions.mjs';
// Retired names are rejection sentries only, never registered tools.
const RETIRED_CARD_TOOLS=new Set(['card_probe','card_probe_report']);
// Private evidence is server-local, never a model/widget-supplied JSON property.
const VERIFIED_PRIVATE_CARD=Symbol('verified_private_card');
// 1052 D1: rpc() computes the route decision once, from the server context only.
const ROUTE_REFUSAL=Symbol('route_refusal');
const OBSERVER_REVISION=Symbol('observer_revision');
// Presenting an already scoped file does not advance task execution, regardless
// of whether the caller is a model or widget. It remains an audited tool call.
const presentationReveal=(name,args)=>name==='desktop_action'&&args?.action==='reveal';
const s={type:'string'}, schema=(props={},required=[])=>({type:'object',properties:props,required,additionalProperties:false});
const tool=(name,description,props,required=[],read=false)=>({name,description,inputSchema:schema(props,required),annotations:{readOnlyHint:read,destructiveHint:!read,openWorldHint:true,idempotentHint:read}});
const OUTPUT_DEFAULT='新产出的文件默认放进当前工作区；一次产出多个文件时，在工作区建立以任务命名的子文件夹。只有用户明确指定位置，或任务本身是在修改已有位置时，才写到工作区外。 New artifacts go to the current workspace by default; multiple outputs go in a task-named subfolder. Write elsewhere only when the user explicitly specifies a destination or the task is inherently modifying an existing location.';
const KNOWN_LIMITS=Object.freeze([
 {zh:'对话里出图只认用户自己发的消息，卡片替用户发的也不算；批量出图让用户把全部描述发在一条消息里，一次出一张，每张出完提醒用户发「继续」。',en:'Chat image generation follows user-sent messages only (not card-sent ones); for batches, have the user send all descriptions in one message, generate one image at a time, and remind the user to send “继续” after each.'},
 {zh:'长命令查到最终结果再汇报；查不到就明确说还在跑并给出编号。',en:'For long-running commands, check the final result before reporting; if no final result is available, say it is still running and include the ID.'},
 {zh:'走不通就停下说明，给选项，不悄悄换做法。',en:'If an approach is blocked, stop, report the exact blocker, and offer options instead of silently changing methods.'},
 {zh:'日常不建议切到 Work 模式。',en:'For ordinary ChatHand work, staying in Chat mode is recommended instead of switching to Work.'}
]);
const REPLY_FORMAT=Object.freeze({
 zh:'ChatHand 已经把「结果」（summary）和「你要做」（user_action）做成卡片，显示在这条回复上面。回复里不要再写这两行，只补用户用得上的细节，最多 5 行：成果位置、下一步；真有没过的测试或报错，再写它的原话。全都过了就不提失败，也不写「没有失败」这类话；不写过程，不写没出问题的检查。',
 en:'ChatHand already shows Result (summary) and Your move (user_action) as a card above this reply. Do not repeat them; add at most 5 short lines the user can use: file locations and the next step, plus the exact error only when something actually failed. If nothing failed, do not mention failures at all (no "there were no failures" line). No step-by-step narration, no checks that passed.'
});
// 1027 起 ChatGPT 申请完更新就自己接着装（install_update），用户不用去窗口点。
const AI_INSTALL_ACTION='无需操作，ChatGPT 将继续安装新版并告知结果。';
// 「你要做」由 ChatHand 定：它知道的状态（等用户点安装）优先，其次用 AI 填的，最后给默认。
function finishUserAction(args,updater,success){
 if(args.user_action!==undefined&&typeof args.user_action!=='string')fail('ARG_INVALID','user_action 需要是一句话。');
 try{if(updater?.forAI?.()?.request?.status==='waiting_user')return AI_INSTALL_ACTION;}catch{/* 读不到更新状态就用 AI 填的 */}
 const own=(args.user_action||'').trim();if(own)return own;
 return success?'无需操作。':'';
}
const WRITE_HELP='写文件用 write_text，建文件夹用 create_directory，跑命令用 propose_command；看不到就先加载 ChatHand 的全部工具。';
const beginGuidance=(store,profile={trial:"medium"})=>({
 split:{zh:`先估大小，小活直接做完；中大活按${profile.trial}拆块（约${PACING.block[profile.trial].calls}次调用或${PACING.block[profile.trial].ms/60000}分钟）。每块记进度后接着做，不结束这一轮；长命令用command_result(wait_ms:${PACING.wait.poll_ms},brief:true)在这一轮等，每${PACING.wait.note_ms/60000}分钟记进度。只有等用户或全部完成才结束。拿不准先看chathand_guide。`,en:`Use ${profile.trial} blocks: about ${PACING.block[profile.trial].calls} calls or ${PACING.block[profile.trial].ms/60000} minutes. Checkpoint and continue in this turn. Wait for commands with wait_ms:${PACING.wait.poll_ms},brief:true; checkpoint every ${PACING.wait.note_ms/60000} minutes. Finish only when complete or waiting for the user.`},
 completion_standard:{
  zh:'用户要的东西做成并核对过就 success=true，中途出错但修好也算成功；任何一部分没做成就 success=false。收尾时调用一次 finish_task，并用 summary 写 40 字以内的一句话，说明结果和成果位置。',
  en:'Use success=true when the requested result is completed and verified, even if intermediate errors were fixed. Use success=false if any part remains incomplete. Finish every task once with finish_task and a <=40-character summary that states the result and artifact location.'
 },
 workflow:[
  '用户说停止任务时必须实际调用task_stop。先列编号清单、方法和成果位置；分块推进，每块记task_checkpoint后接着做，不结束这一轮。只有真的等用户或全部完成才交回。每项最多重试2次。开工不调show_task，返回要求才调。 Make a numbered checklist with method and destination. Checkpoint each block and continue in the same turn; stop only for real user waiting or completed work. Retry each item at most twice; do not render show_task at startup.',
  '命令返回运行中时，汇报前查到最终结果；查不到就说“还在跑，编号是…”。 If a command is still running, check for its final result before reporting; otherwise say it is still running and give its ID.',
  '要换做法先问用户；走不通时给出工具原话，不用 ChatGPT 自己的代码环境顶替。 Ask before changing approach; when blocked, quote the tool error and never substitute ChatGPT\'s own code environment.'
 ],
 output_default:OUTPUT_DEFAULT+' 当前工作区 / Current workspace: '+store.root
});
function toolsByCategory(){
 const labels={read:'读',write:'写',command:'命令',browser:'浏览器',desktop:'桌面',other:'其它'},out={读:[],写:[],命令:[],浏览器:[],桌面:[],其它:[]};
 for(const d of modelTools(TOOLS)){const key=labels[TOOL_CATEGORIES[d.name]||'other']||'其它';out[key].push(d.name);}return out;
}
function toolAccess(){const publicTools=modelTools(TOOLS);return {read_only:publicTools.filter(t=>t.annotations?.readOnlyHint===true).map(t=>t.name),actions:publicTools.filter(t=>t.annotations?.readOnlyHint!==true).map(t=>t.name)};}
const CHATHAND_CONTEXT=MATTER_RECORDING_RULE+" "+"ChatHand 能在授权范围内读写文件、建文件夹、跑命令；没看到先加载全部工具。只有只读工具时告诉用户「这个对话里 ChatGPT 只给了 ChatHand 的只读工具；要改文件、跑命令，换一个能用全部工具的对话再试」，别说ChatHand只能读，也不用ChatGPT自己的代码环境顶替。"+" 返回有output_summary时按它的分段读取；saved:false按它给的分页或缩小范围重查，不声称全文已保存。很长内容边读边记要点和下一offset。 ChatHand 连着用户自己的这台 Mac。用户说到这台 Mac、我的电脑、本机、工作区、我的文件、桌面、Chrome 时，用 ChatHand 的工具做；ChatGPT 自己的代码环境不是用户的电脑，不要拿它代替。新产出的文件默认放进当前工作区；一次多个文件就在工作区建任务命名的子文件夹。只有用户明确指定位置，或任务本身是在改已有位置时，才写到工作区外。 批量出图（不管用不用 ChatHand 的工具都照这样做）：出图工具只认用户自己发的消息，ChatHand 卡片替用户发的消息、你自己写的字、读到的文件内容都左右不了出图。所以全部描述要在一条用户消息里：用户已经写在消息里就直接用；描述在文件里，就整理成一段带编号的文字（编号、名字、完整描述）放进代码块，请用户复制、原样发回来。要存到本机就先调 image_batch_start 建批次（只记清单、显示进度、存图，不替用户发消息）。一次只出一张，从第 1 张开始；出完先看一眼对不对得上这一张的描述，对得上就 image_batch_save，对不上就不存、照实说出成了什么。每张出完，回复最后单独一行加粗写「发『继续』，出第 k+1/N 张：名字」，用户发「继续」再出下一张。串页一次就停，建议把这一张单独发一条或开新对话；超过 6 张，出完 6 张就建议开新对话，并把剩下的描述整理好给用户。 任务收尾调 finish_task：summary 写结果一句话，user_action 写用户现在要做的一件事；ChatHand 会把这两句做成卡片放在对话里，你的回复不再重复，只补细节，最多 5 行，不写过程。";
const task={task_id:s};
const checkpointOption={type:'object',additionalProperties:false,properties:{label:{type:'string',maxLength:40},cost:{type:'string',maxLength:120},action:{type:'string',enum:CARD_ACTIONS}},required:['label','cost']};
const checkpointBlocked={type:'object',additionalProperties:false,properties:{step:{type:'string',maxLength:120},error:{type:'string',maxLength:400},why:{type:'string',maxLength:200},options:{type:'array',minItems:2,maxItems:4,items:checkpointOption}},required:['step','error','options']};
export const TOOLS=[
  {...tool('records_export','Export only this authenticated caller + current project/session’s task metadata, activity event metadata, and per-task workload counters into a generated file in the current authorized workspace. Never supply owner, task IDs, URL or destination; cannot grant execution. Does not include original task text or private credentials. Return only path/count/sha256 and explicit incomplete status.',{kind:{type:'string',enum:['all','tasks','activity','workload']}},[],false),annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false,idempotentHint:false}},
  ...MATTER_TOOLS,
 ...FEATURE_TOOLS.map(t=>t.name==='desktop_action'?{...t,description:'Reveal an allowed file, open a preview URL, or use open_path to open a scoped local file with its default App through ChatHand. open_path requires stable request_id and an active task; it works in folder scope without granting mouse/keyboard control. Packages, disk images and applications require local confirmation. No execution arguments or passwords are accepted.',inputSchema:{...t.inputSchema,properties:{...t.inputSchema.properties,...DESKTOP_OPEN_PATH_FIELDS}}}:t),
 ...AUTOMATION_TOOLS.filter(t=>!COMPUTER_TOOL_UPGRADES.some(c=>c.name===t.name)).map(browserToolDefinition),
 ...COMPUTER_TOOL_UPGRADES,
 ...BROWSER_EXPERIENCE_TOOLS,
 tool('setup_status','Read shared setup progress state. Returns only step status and completion metadata.',{},[],true),
 tool('setup_claim','Claim one setup step for one owner. Already completed steps are not replayed and conflicting owners are rejected.',{step_id:s,owner:s},['step_id','owner']),
 tool('setup_done','Mark one setup step completed with a bounded result. It records the state only and does not grant permissions.',{step_id:s,result:s},['step_id']),
 tool('log_note','只记任务过程。 Stores only redacted activity metadata, decisions, external tool references and errors; never private reasoning or secrets.',{...task,event:{type:'string',maxLength:60},summary:{type:'string',maxLength:500},kind:{type:'string',maxLength:40},reference:{type:'string',maxLength:500}},['task_id','event','summary']),
 tool('connection_check','Verify the live product version and complete tool schema. Safe while execution is paused; never grants permission. Call this after refreshing the connector.',{nonce:s},[],true),
 tool('bridge_info',CHATHAND_CONTEXT+' Check actual local service version, workspace, mode and Node path. Read before starting. Does not authorize execution.',{},[],true),
 tool('begin_task','Create one task with stable request_id. If this conversation still has an unfinished task, this returns TASK_OPEN_IN_CONVERSATION with its task_id: continue that task, or finish it first, or pass new_task:true for a truly separate job. Task-wide local approval replaces per-command approval in auto mode. If pending, keep task_id and wait; never recreate. Every started task must be closed once with finish_task. conversation_id is an optional user-saved bookmark, not verified chat identity. conversation_title: 这段对话在做什么，10 个字以内。',{request_id:s,title:{type:'string',description:'12个字以内，写用户要做成什么；不用编号、路径、英文代号。'},model:{type:'string',description:'可选：填你知道的模型名；只存归类。'},trial:{type:'string',enum:['fine','medium','coarse'],description:'默认medium；平常省略，D3按试验卡填。'},conversation_id:s,conversation_title:{type:'string',maxLength:10},new_task:{type:'boolean'}},['request_id','title']),
 tool('task_status','Read existing task or saved completion receipt, plus last_checkpoint, recent_steps, stall and forecast. No execution and no permission changes. Poll at most once per turn. If terminal=true stop; if pending_approval wait for the user. wait_ms <=20000. 收到「继续」先调它，从 last_checkpoint 接着做，做过的不重做。 include_activity:true 读这个任务的 log_note 记录，activity_offset/activity_limit 分页。',{...task,wait_ms:{type:'integer',minimum:0,maximum:20000},from_card:{type:'boolean',description:'只给卡片显示用，不填。'},include_activity:{type:'boolean',description:'带上这个任务的 log_note 记录。'},activity_offset:{type:'integer',minimum:0},activity_limit:{type:'integer',minimum:1,maximum:50}},['task_id'],true),
 tool('task_checkpoint',"每块做完记done、next（接着做：），记完继续本轮；本次交办做完就finish_task，下一阶段新任务。等用户或外部复核/回话用waiting_user:true，next写「等你：…」或「等：谁/什么」。只存进度和私有只读进度卡，不自动发。走不通带blocked问用户选，choice记选择；被OpenAI拦下也一样，error照抄原话，没有就「没看到原话」。 done/next人话，不贴命令路径。",{...task,done:{type:'string',maxLength:200},next:{type:'string',maxLength:200},block:{type:'integer',minimum:1,maximum:99},total:{type:'integer',minimum:1,maximum:99},waiting_user:{type:'boolean'},blocked:checkpointBlocked,choice:{type:'string',maxLength:60}},['task_id','done']),
 tool('chathand_guide','只读场景手册：split、long_command、big_read、batch_files、code_change、browser、install、images、resume、naming。无topic或未知topic回清单；无需开任务，不读本机文件。',{topic:{type:'string'}},[],true),
 tool('task_resume_claim','只给 ChatHand 的任务卡用：停住后卡片替用户发「继续」前先领一次。 Card-only: claim the single automatic “继续” for a stalled task.',{...task},['task_id']),
 tool('task_stop','停止指定任务，不重新授权。用户明确要求停止时必须实际调用本工具；先校验当前任务所属连接和会话，停止本机任务并撤销接力。仅说停了无效。',{...task},['task_id']),
 tool('finish_task','任务收尾标准：用户要的东西做成并核对过就 success=true，中途出错但已修好仍算成功；任何一部分没做成就 success=false。无论成没成都用 summary 写一句话（建议 40 字以内，最多 80 字），说明做成了什么，或卡在哪一步和原因，并写明成果位置。user_action 写用户现在要做的一件事（60 字以内，写清去哪儿点什么，不写「如果…就…」；没有就不填，success=false 时写一句用户能照着做的话）。ChatHand 会把 summary 和 user_action 做成卡片显示在对话里，回复不要重复这两句，照返回里的 reply_format 写。只在所有运行中操作已结束后调用一次，SEARCH_LIMIT、JOB_BUSY 是暂时的，不是收尾的理由；历史中途失败不会阻止 success=true；同样参数重试会原样返回已存回执（replayed=true），不要改写。',{...task,success:{type:'boolean'},summary:{type:'string',maxLength:80},user_action:{type:'string',maxLength:60}},['task_id']),
 tool('list_conversations','List only explicitly user-bound conversation bookmarks in current project; no chat contents or scraped history.',{},[],true),
 ...LEGACY.filter(t=>!['bridge_info','write_text','restore_file','propose_command','command_input'].includes(t.name)).map(t=>{const d=structuredClone(t);if(['list_directory','read_text'].includes(d.name))d.description+=' '+WRITE_HELP;return d;}),
 ...LEGACY.filter(t=>['write_text','restore_file','propose_command','command_input'].includes(t.name)).map(t=>({...structuredClone(t),description:t.name==='propose_command'?'Execute on this Mac under an active task and macOS sandbox. auto/full modes apply the task grant. Real stdout/stderr, stdin and persistent service. Stable request_id; pending is not executed.':t.name==='command_input'?'Send ordinary stdin under the job\'s active task grant. No passwords.':t.name==='write_text'?t.description.replace('Local write switch required.','Active task permission required.')+' 没指定位置就放工作区。':t.description.replace('Local write switch required.','Active task permission required.'),inputSchema:{...structuredClone(t.inputSchema),properties:{...structuredClone(t.inputSchema.properties),...task},required:[...t.inputSchema.required,'task_id']}})),
 tool('create_directory','Create one directory; parent must exist. Stable operation_id. 没指定位置就放工作区。',{...task,path:s,operation_id:s},['task_id','path','operation_id']),
 tool('move_path','Move/rename one ordinary text file, without overwrite. Confirm source SHA first. Directory moves via terminal.',{...task,from:s,to:s,expected_sha256:s,operation_id:s},['task_id','from','to','expected_sha256','operation_id']),
 tool('trash_path','Recoverably delete one ordinary text file into Ken Bridge recycle storage; not OS Trash. Directories and arbitrary binary operations via terminal.',{...task,path:s,expected_sha256:s,operation_id:s},['task_id','path','expected_sha256','operation_id']),
 tool('restore_trash','Restore a recycled text file only if destination is missing.',{...task,trash_id:s,operation_id:s},['task_id','trash_id','operation_id']),
 tool('search_text','Literal text search, bounded to 1000 files, 100 matches; no regex.',{query:s,path:s},['query'],true),
 {...tool('setup_write_probe','Record the current setup test write capability. Call connection_check first with the same nonce in the same ChatGPT session. Does not create a task or change user files.',{nonce:s},['nonce']),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
 tool('operation_status','Read a pending file approval result; do not recreate the operation.',{approval_id:s},['approval_id'],true),
 ...ARTIFACT_TOOLS,...IMAGE_BATCH_TOOLS,
 // 1029 K：自动刷新认不出按钮时，ChatGPT 只从刷新器给出的候选里按意思选一个编号；ChatHand 再核对后点击。
 {...tool('tools_refresh_click','ChatHand 自动刷新工具时认不出「刷新工具」按钮（别的语言、页面改版），upgrade_status 的 tools_refresh.state 是 needs_ai，里面列了 ChatHand 那一页上的按钮（number、role、name、box）。照 tools_refresh.rules 认出「刷新/更新这个应用的工具」的那一个，把编号和你认为的意思交给这个工具，ChatHand 核对后去点，再看 ChatGPT 有没有来拿新的工具清单。删除、卸载、断开、改名、编辑、权限这类按钮不要选；拿不准就别调，把候选和理由告诉用户。',{number:{type:'integer',minimum:1,maximum:30},meaning:{type:'string',maxLength:200}},['number','meaning']),annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true,idempotentHint:false}},
 // 1027：用户在对话里同意更新以后，ChatGPT 在同一轮里装完、等 ChatHand 重启回来、看工具清单刷新了没有（Ken 10/7 定）。
 {...tool('relay_card_control','Private MCP App relay card control, never model-visible. Token-bearing calls are restricted to a real authenticated MCP App transport.',{action:{type:'string',enum:['view','claim','begin_dispatch','report','cancel','interruption']},task_id:s,card_token:s,mode:{type:'string',enum:['auto','manual']},request_id:s,permit_token:s,attempt_id:s,report_token:s,outcome:{type:'string',enum:['accepted','rejected','unknown']},error_code:{type:'integer'},definitely_not_sent:{type:'boolean'},output_conflict:{type:'boolean'},input_conflict:{type:'boolean'},interruption_token:s,card_errors:{type:'object'}},['action','task_id']),annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false,idempotentHint:false},_meta:{'openai/visibility':'private','openai/widgetAccessible':true,ui:{visibility:['app']}}},
 {...tool('card_answer','Private ChatHand card submission. Requires the card-only request capability and the same task/session; never called by the model.',{nonce:{type:'string',pattern:'^[a-f0-9]{64}$'},choice:{type:'string',maxLength:10}},['nonce','choice']),annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false,idempotentHint:false},_meta:{'openai/visibility':'private','openai/widgetAccessible':true,ui:{visibility:['app']}}},
 {...tool('install_update',"装已经准备好的 ChatHand 新版：request_update 核对过的本机包，或者发布仓库里的正式版（bridge_info.update.installable 里有）。只在用户在对话里明确说要更新以后调（开发 ChatHand 时，用户让你收尾、申请更新，就算同意了）。task_id 填你现在这个任务：ChatHand 单独创建只包含安装的任务，约 2 秒后开始装；新版自检通过才显示成功，原任务不因此变成成功。装的时候 ChatHand 会重启，15–40 秒里调用会失败，这是正常的，这一轮不要结束：接着调 upgrade_status（wait_s:25），失败了隔几秒再调，最多等 2 分钟，直到 phase 是 updated；tools_refresh 告诉你 ChatHand 有没有替用户在 ChatGPT 里刷新工具。最后用一两句告诉用户结果；装好后的检查新开一个任务做。",{...task,build:{type:'integer',minimum:1,description:'要装的构建号（bridge_info.update.installable.build），对不上就不装。'}},[]),annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false,idempotentHint:false}},
 {...tool('request_update',"请用户把这台 Mac 上的 ChatHand 换成你刚做好的新版（只用于开发 ChatHand 自己）。调用前：测试通过；package.json 的 kenBridge.build_number 比现在的大（现在的看 bridge_info.client_build），已运行 node scripts/generate-version.mjs 并提交；用 node scripts/build-v09.mjs --output <新文件夹>/ChatHand.app 打出签名包。app_path 填那个 ChatHand.app 的绝对路径，note 用一句话写这一版改了什么。ChatHand 会核对：bundle id、和现在同一张签名证书、构建号更新；过了就在它自己的窗口弹出安装卡并发通知。过了以后接着调 install_update（task_id 填这个任务），在这一轮里装完、等它重启回来，照返回里的 next_steps 做。不要用 install_update 以外的办法装，也不要替用户在窗口里点。安装时 ChatHand 会重启，连接断开半分钟左右是正常的。装好后调 bridge_info：client_build 变成新构建号，就是装好了；再新开一个任务做装好后的检查。",{...task,app_path:s,note:{type:'string',maxLength:300,description:"这一版改了什么，一句话，会显示在安装卡上。"}},['task_id','app_path']),annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false,idempotentHint:true}}
].map(d=>structuredClone(d));
TOOLS.push(structuredClone(RUN_CAPABILITY_TOOL));
TOOLS.find(t=>t.name==='task_checkpoint').inputSchema.properties.withdraw_confirm={type:'string',description:'撤回这个任务自己尚未作答的确认（cf_ 开头）；不能批准确认。'};
// New fields only on begin/finish; checkpoint deliberately has no matter updates.
for(const [name,delta,key] of [['begin_task',MATTER_DELTAS.begin,'matter_ids'],['finish_task',MATTER_DELTAS.finish,'matter_updates']]){const def=TOOLS.find(t=>t.name===name);def.inputSchema.properties[key]=delta.field;def.description+=' '+delta.description;}
TOOLS.find(t=>t.name==='propose_command').inputSchema.properties.pty={type:'boolean'};
TOOLS.find(t=>t.name==='propose_command').description='Run a real local command under an active task. Read bridge_info first. macOS uses Seatbelt and supports pty=true. Windows requires full access, a packaged Job Object helper and pty=false; its commands run with current-account file and network permissions. Preserve request_id, read output and stop services before finishing. 输出长时默认显示失败段和末尾；要原文用command_result(full:true)分页。结果不明时保留原request_id并查询原job，不为找回输出重新执行。';
for(const name of ['edit_file','write_text'])TOOLS.find(t=>t.name===name).description+=' On HASH_CONFLICT read, compare, then decide; never just replace the SHA or guess concurrent writers.';
TOOLS.find(t=>t.name==='command_result').inputSchema.properties.full={type:'boolean',description:'true：不摘要，按稳定位置分页返回脱敏原文，不是一次给全；每页约12000字符，沿next_full_cursor续取。'};
TOOLS.find(t=>t.name==='command_result').inputSchema.properties.full_cursor={type:'string',maxLength:100,description:'上一页的next_full_cursor，原样传回；不与整数cursor混用。'};
TOOLS.find(t=>t.name==='command_result').description+=' full:true按稳定位置分页给脱敏原文，不摘要；沿next_full_cursor续取，结束且游标为null才读完，运行中总量未定。full不与非零旧cursor混用。output_limited表示命令输出超限被停止，只含已收到内容。非full默认给失败段与末尾；output_reduced/output_retention/cursor_gap/cursor_gaps标记内存缩减，partial_event_cursors标记事件内损失，不把稀疏或局部输出说成完整。沿上一next_cursor向前读取，保留原游标编号；旧会话缺档案不可恢复，不重新执行补输出。';
TOOLS.find(t=>t.name==='list_commands').description='列出当前连接可查询的命令，默认最新20条，limit 1–100、offset分页，running_only只看运行中；返回total/next_offset。每条仅摘要，输出用command_result。 含仍保留的已结束记录，不含输出；不保证重启后完整恢复。Only this connector session; not a list of all system processes.';
TOOLS.find(t=>t.name==='list_commands').inputSchema.properties={limit:{type:'integer',minimum:1,maximum:100},offset:{type:'integer',minimum:0},running_only:{type:'boolean'}};
TOOLS.find(t=>t.name==='command_result').inputSchema.properties.brief={type:'boolean'};
TOOLS.find(t=>t.name==='command_result').description+=` brief:true只回状态和最后3行（合计300字），等满wait_ms或结束才回。结束后不带brief再看结果，不重跑原job。`;
TOOLS.find(t=>t.name==='propose_command').description+=` 默认120秒超时；timeout_ms task最长1小时，service最长24小时。同时最多4条，第5条JOB_BUSY，等现有的结束再提交，不换法绕过。running时在这一轮command_result(wait_ms:${PACING.wait.poll_ms},brief:true)等，每${PACING.wait.note_ms/60000}分钟记进度再接着等。`;
export const SITE_HOST_TOOL={...tool('chathand_host_flow_commit','Private application-flow receipt. Requires the authenticated connection capability; never called by the model.',{capability:{type:'string',pattern:'^[-_A-Za-z0-9]{43}$'}},['capability']),annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false,idempotentHint:false},_meta:{'openai/visibility':'private','openai/widgetAccessible':true,ui:{visibility:['app']}}};
TOOLS.splice(TOOLS.findIndex(t=>t.name==='install_update'),0,SITE_HOST_TOOL);
const privateCardTool=name=>['card_answer','relay_card_control','chathand_host_flow_commit'].includes(name);
const toolDefinition=name=>TOOLS.find(t=>t.name===name);
const validatePrivateArgs=(name,args)=>{try{validate(toolDefinition(name),args);}catch{fail('ARG_INVALID','私有卡片参数无效。');}};
export const siteToolDirectory=()=>TOOLS;
// Bounded lists expose a stable page cursor. Neither listing nor searching grants commands.
const directoryDefinition=TOOLS.find(t=>t.name==='list_directory');
Object.assign(directoryDefinition.inputSchema.properties,{limit:{type:'integer',minimum:1,maximum:300},offset:{type:'integer',minimum:0},cursor:{type:'string',maxLength:100}});
directoryDefinition.description+=' 默认最多300条；结果标明visible total、truncated、next_cursor。目录变化须从第一页重查。';
TOOLS.find(t=>t.name==='search_text').description='Fast literal search in the permitted workspace, capped at 1,000 files/100 matches; truncated results do not prove absence. For pages use start_search then search_results and inspect completion and limits. For full counts/analysis only with existing command authorization, run rg or Python over explicitly authorized files. This does not enlarge file scope or grant command access.';
for(const name of ['start_search','stop_search']){const d=TOOLS.find(t=>t.name===name);d.annotations={...d.annotations,destructiveHint:false,idempotentHint:name==='stop_search'};}
// Lifecycle/status tools operate on this private local state, not open internet entities.
for(const d of TOOLS){
 if(d.name==='begin_task')d.annotations={...d.annotations,readOnlyHint:false,destructiveHint:false,openWorldHint:false,idempotentHint:false};
 if(['connection_check','bridge_info','task_status','list_conversations','operation_status','list_commands','command_result','input_status','list_directory','read_text','search_text'].includes(d.name))d.annotations={...d.annotations,readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true};
 if(['finish_task','create_directory'].includes(d.name))d.annotations={...d.annotations,readOnlyHint:false,destructiveHint:false,openWorldHint:false,idempotentHint:true};
 if(['finish_task','task_checkpoint','setup_write_probe'].includes(d.name))d._meta={ui:{resourceUri:TASK_URI},'openai/outputTemplate':TASK_URI};
 if(d.name==='task_status')d._meta={'openai/widgetAccessible':true};
 if(d.name==='task_resume_claim'){d._meta={'openai/visibility':'private','openai/widgetAccessible':true};d.annotations={...d.annotations,readOnlyHint:false,destructiveHint:false,openWorldHint:false,idempotentHint:false};}
 if(d.name==='task_checkpoint')d.annotations={...d.annotations,readOnlyHint:false,destructiveHint:false,openWorldHint:false,idempotentHint:false};
 if(['write_text','restore_file','move_path','trash_path','restore_trash'].includes(d.name))d.annotations={...d.annotations,readOnlyHint:false,destructiveHint:true,openWorldHint:false};
 if(['propose_command','command_input','cancel_command'].includes(d.name))d.annotations={...d.annotations,readOnlyHint:false,destructiveHint:true,openWorldHint:true};
}
// API29: private setup/activity records do not modify user files or external entities.
for(const name of ['log_note','setup_claim','setup_done']){
 const d=TOOLS.find(t=>t.name===name);d.annotations={...d.annotations,destructiveHint:false,openWorldHint:false};
}
// Waiting observes the existing external page; it does not edit it.
TOOLS.find(t=>t.name==='browser_wait_for').annotations.destructiveHint=false;
// Card stop uses the same task-local cancellation as task_stop.
TOOLS.find(t=>t.name==='card_answer').annotations={...TOOLS.find(t=>t.name==='card_answer').annotations,destructiveHint:true,openWorldHint:true};
// API31 descriptor delta only. Historical flags stay in receipt fingerprints.
const personalFlags=new Set(['browser_open','browser_tabs','browser_snapshot','browser_action','browser_screenshot','browser_upload','browser_download','browser_batch','browser_read','browser_find','browser_wait_for']);
export function api31ValidationArgs(name,args){
 if(!args||typeof args!=='object'||Array.isArray(args))return args;
 const copy={...args},drop=(o,key)=>{if(Object.hasOwn(o,key)){if(typeof o[key]!=='boolean')fail('ARG_INVALID','历史参数 '+key+' 必须是布尔值。');delete o[key];}};
 if(personalFlags.has(name))drop(copy,'allow_personal');
 if(['browser_action','computer_action'].includes(name))drop(copy,'confirm');
 if(['browser_batch','computer_batch'].includes(name)&&Array.isArray(copy.steps))copy.steps=copy.steps.map(step=>{if(!step||typeof step!=='object'||Array.isArray(step))return step;const out={...step};drop(out,'confirm');return out;});
 return copy;
}
for(const d of TOOLS){
 const remove=(schema,key)=>{delete schema.properties[key];schema.required=schema.required.filter(k=>k!==key);};
 if(personalFlags.has(d.name))remove(d.inputSchema,'allow_personal');
 if(['browser_action','computer_action'].includes(d.name))remove(d.inputSchema,'confirm');
 if(['browser_batch','computer_batch'].includes(d.name))remove(d.inputSchema.properties.steps.items,'confirm');
 if(d.name==='run_capability')d.inputSchema.required=[];
 if(['task_status','task_stop','desktop_action'].includes(d.name))d._meta={...d._meta,'openai/widgetAccessible':true,ui:{...d._meta?.ui,visibility:['model','app']}};
}
const descriptionEdits={
 begin_task:[['If this conversation still has an unfinished task, this returns TASK_OPEN_IN_CONVERSATION with its task_id: continue that task, or finish it first, or pass new_task:true for a truly separate job. Task-wide local approval replaces per-command approval in auto mode. If pending, keep task_id and wait; never recreate.','An unfinished task in this conversation is reused unless new_task:true requests a separate job. Tasks start automatically within the current switches and file scope; retries preserve request_id and arguments.']],
 browser_action:[['Login/submit/pay/send require prior user confirmation plus confirm:true. Password/OTP stay manual. ',''],['Coordinate click requires confirm:true and a recent screenshot snapshot_id','Coordinate click requires a recent screenshot snapshot_id']],
 browser_batch:[['Login, submit, pay and send need prior user confirmation and confirm:true. Password/OTP stay manual. ','']],
 computer_batch:[[' Submit/pay/send steps require confirm:true plus user intent.','']],
 desktop_action:[['Packages, disk images and applications require local confirmation. ','']],
 browser_tabs:[['Existing tab close requires explicit user intent. ','']],
 task_status:[['; if pending_approval wait for the user','']],
 command_result:[['wait_ms up to 20s; pending approval is not a running job.','wait_ms up to 20s.']],
 operation_status:[['Read a pending file approval result','Read a file operation result']],
 input_status:[['Read approval status of an input request','Read status of an input request']],
 browser_status:[['Ken Bridge extension','ChatHand extension']],
 request_update:[['package.json 的 kenBridge.build_number','新版构建号']],
 command_input:[['No passwords.','Never the macOS login password.']],
 task_stop:[['先校验当前任务所属连接和会话，','']]
};
for(const [name,edits] of Object.entries(descriptionEdits)){const d=TOOLS.find(t=>t.name===name);for(const [old,next] of edits)d.description=d.description.replace(old,next);}
for(const [name,description] of Object.entries({
 move_path:'Move/rename a regular file (including binary) or directory without overwrite. Read get_file_info first and use its sha256, including directory snapshot hashes. Cross-device copies are verified before source removal. Reuse the same operation_id and arguments; inspect any incomplete/unknown operation instead of replaying it.',
 trash_path:'Move a regular file (including binary) or directory into ChatHand recoverable recycle storage, not OS Trash. Read get_file_info first and use its sha256. Reuse the same operation_id and arguments; incomplete/unknown operations must be inspected, never repeated.',
 restore_trash:'Restore a recycled regular file or directory only if its destination is missing. Reuse the same operation_id and arguments. Legacy text recycle receipts remain supported.',
 get_file_info:'Read file size, modification time, fingerprint and complete SHA-256 for a regular file or directory. Directory hashes use chathand-directory-v1 and traverse all descendants; use the returned sha256 for move_path or trash_path.',
 run_capability:RUN_CAPABILITY_TOOL.description.replace('Unknown names or invalid parameters do not execute.','Missing or unknown capability returns the current local extra_capabilities list (name, description, inputSchema, readOnly) without execution. parameters defaults to {} for known capabilities; invalid parameters do not execute.')
}))TOOLS.find(t=>t.name===name).description=description;
export function mergeNotes(...values){const notes=values.filter(Boolean).flatMap(n=>{const {also,...first}=n;return [first,...(Array.isArray(also)?also:[])];});return notes.length?{...notes[0],...(notes.length>1?{also:notes.slice(1)}:{})}:null;}
for(const d of TOOLS)if(isPrivateTool(d))d._meta={...d._meta,ui:{...(d._meta.ui||{}),visibility:['app']}};
export class Tools {
 constructor(state,store,queue,policy){Object.assign(this,{state,store,queue,policy});this.blocks=new Blocks({audit:e=>store.audit?.(e),emit:(kind,data)=>policy.emit?.(kind,data)});this.confirmations=new Confirmations({offerSettingsCards:false,audit:e=>store.audit?.(e),emit:(kind,data)=>{policy.emit?.(kind,data);if(['confirmation_answered','confirmation_input_rejected'].includes(kind))this.resume?.after(null,'确认结果',{task_id:data.task_id,path:data.message},{},false);},now:Date.now});bindConfirmations(state,this.confirmations);policy.confirmations=this.confirmations;this.imageBatch=new ImageBatchManager(store,policy);this.self=selfInfo({stateDir:store.stateDir,appRoot:APP_ROOT,extraPids:()=>this.selfPids?.()||[],extraCmdlines:()=>this.selfCmdlines?.()||[]});queue.onSandboxDenied=job=>{const t=policy.tasks?.get(policy.jobOwners?.get(job.id));job.blocked=scopeReceipt({command:[job.program,...job.args].join(' '),reason:job.needsFullAccess});this.confirmations.create({blocked:job.blocked,task_id:t?.id,session_hash:t?.session_hash,conversation_title:t?.conversation_title||t?.title,hash:commandHash({program:job.program,args:job.args,cwd:job.absoluteCwd})});this.blocks.record({kind:'scope',id:'sandbox',name:'整台电脑',command:[job.program,...job.args].join(' '),reason:'被「只在这个文件夹里」的系统沙箱挡住：'+job.needsFullAccess,blocked:job.blocked,task_id:t?.id??null,conversation_id:t?.conversation_id??null});};this.features=new Features(state,store,queue,policy);this.automation=new Automation(state,store,policy);this.lastCalls={};this.lastCheck=null;this.setupTest=new SetupTest();this.setupProgress=createSetupProgress();this.trace=store.stateDir?new CallTrace(store.stateDir,TOOLS):null;this.events=store.stateDir?new DiagnosticEvents(store.stateDir,{salt:this.trace?.salt,tools:TOOLS.map(t=>t.name)}):null;policy.diagnostics=this.events;this.resume=new ResumeKeeper({events:this.events,stateDir:store.stateDir||null,emit:(kind,data)=>policy.emit?.(kind,data)});this.taskContinuity=new TaskContinuity(policy,this.resume,this.features.changes);this.commandNotes=new CommandCompletionNotes({readJob:(id,caller,hash)=>{
  policy.check();const owner=policy.jobOwners.get(id),t=owner?policy.get(owner,caller):null;
  if(!t||t.session_hash!==hash)return null;const j=queue.jobs?.get(id);if(!j)return null;
  return {job_id:id,task_id:owner,status:j.status,exit_code:j.exit_code,signal:j.signal,started_at:j.started_at,finished_at:j.finished_at,process_alive:!!j.child||j.process_alive===true,cleanup_pending:!!j.cleanupPending||j.cleanup_pending===true};
 }});this.confirmations.contextForTask=(id,{allowEpochTransition=false}={})=>{const t=policy.get(id);if(!policy.enabled||store.paused||t.status!=='active'||t.root!==store.root||t.project_id!==state.data.active||t.epoch!==policy.epoch&&!(allowEpochTransition&&policy.transitioning&&t.epoch+1===policy.epoch))fail('CONFIRMATION_STATE','任务或权限已变更，此确认已失效。');return {caller:t.caller,session_hash:t.session_hash,epoch:policy.epoch,revision:policy.permissionRevision||0};};this.h8Cards=new H8Cards({policy,confirmations:this.confirmations,checkpointForTask:id=>this.resume?.tasks.get(id)?.checkpoint_seq||0,controlContext:id=>this.cardControlContext?.get(id)||null});this.artifacts=new ArtifactImportManager({store,policy,changes:this.features.changes,runtimeRoot:APP_ROOT});this.imageBatch.artifacts=this.artifacts;this.resume.waitState=id=>this.taskWaitState(id);this.resume.jobState=id=>{const j=queue.jobs.get(id);return j?{mode:j.mode,status:j.status,started_at:j.started_at,finished_at:j.finished_at,timeout_ms:j.timeout_ms,exit_code:j.exit_code,process_alive:!!j.child||j.process_alive===true,cleanup_pending:!!j.cleanupPending||j.cleanup_pending===true}:null;};policy.artifacts=this.artifacts;policy.hasUncertainWork=id=>this.automation.ops.busy(id)||this.automation.ops.uncertainTasks?.has(id)||this.h8Cards.unknownTasks.has(id);this.initializeValueStats();this.initializeExtraCapabilities();this.autoTasks=store.stateDir?new AutoTaskExecution({stateDir:store.stateDir,policy,capabilities:()=>this.extraCapabilities.list()}):null;}
 registerCardAction(name,handler){this.h8Cards.register(name,handler);}
 initializeExtraCapabilities(){
  this.extraCapabilities=new CapabilityRegistry({existingNames:TOOLS.map(t=>t.name),guard:(entry,parameters,{caller,context})=>{
   this.policy.check();if(this.upgradePending)fail('UPGRADE_VERIFYING','应用正在完成升级自检');
   if(!entry.readOnly&&!entry.handlesTaskPreparation){this.policy.getBound(parameters.task_id,caller,sessionHashOf(context.setupPrincipal,context.session),context.connectionPrincipal||null);this.policy.require(parameters.task_id,caller);}
   if(entry.handlesTaskPreparation){const cap=capabilityOf(parameters.tool,parameters.arguments);if(cap&&!capabilityAllowed(this.state,cap,{task_id:parameters.task_id}))throw capabilityError(cap,{command:parameters.tool});}
   for(const cap of entry.permissions){if(!Object.hasOwn(CAPABILITIES,cap))fail('CAPABILITY_REGISTRATION_INVALID','本机能力权限定义无效');if(!capabilityAllowed(this.state,cap,{task_id:parameters.task_id}))throw capabilityError(cap,{command:entry.name});}
  }});
  this.extraCapabilities.register({name:'execute_task_step',description:'带稳定编号续做一次尚未执行的本机任务步骤；只在原工具返回 call_run_capability 配方时使用，原样保留 request_id。',inputSchema:{type:'object',properties:{request_id:{type:'string',pattern:'^[A-Za-z0-9_-]{8,96}$'},task_id:{type:'string'},tool:{type:'string',enum:AUTO_TASK_WRAPPER_TOOLS},arguments:{type:'object',additionalProperties:true}},required:['request_id','task_id','tool','arguments'],additionalProperties:false},readOnly:false,handlesTaskPreparation:true,run:async(parameters,{caller,context})=>{
   const {request_id,task_id,tool,arguments:arguments_}=parameters;
   if(arguments_?.task_id!==task_id)fail('CAPABILITY_ARGUMENT_INVALID','内外任务编号不一致。');
   const identity=Object.freeze({kind:'wrapper',namespace:'execute_task_step',id:request_id});
   return this.invoke(tool,arguments_,caller,{...context,[AUTO_TASK_IDENTITY]:identity});
  }});
  this.extraCapabilities.register({name:'contract_status',description:'核对 API31 工具合同的实际冻结状态、离线卡片壳协议和可用的额外能力类别。',inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},readOnly:true,run:()=>{
   const current=manifest(TOOLS),file=new URL('../contracts/api31-freeze.json',import.meta.url);let frozen=null;try{frozen=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
   return {connector_api:current.connector_api,tool_count:current.tool_count,schema_sha256:current.schema_sha256,api31_frozen:current.connector_api===31&&frozen?.connector_api===31&&current.schema_sha256===frozen?.schema_sha256,freeze_status:frozen?'present':'not_generated',shell_protocol:1,offline_shell:true,capability_categories:['contract_diagnostics']};
  }});
 }
 commitCheckpoint({task_id,checkpoint_seq,choice,via,input}={}){if(via!=='window'||input?.human!==true)fail('CONFIRM_NOT_HUMAN','请在 ChatHand 窗口亲自选择。');return this.h8Cards.windowOption({task_id,checkpoint_seq,choice},this.resume);}
 initializeValueStats(){try{this.valueStats=new ValueStats({stateDir:this.store.stateDir,tools:TOOLS,getTask:id=>this.policy.tasks.get(id)});this.policy.valueStats=this.valueStats;}catch{/* Optional statistics never prevent service startup. */}}
 toolsRefreshNote(hash,name){
  if(!hash||['upgrade_status','tools_refresh_click'].includes(name)||this.toolsRefresh?.running)return null;
  this.toolsRefreshNoted??=new Set();if(this.toolsRefreshNoted.has(hash))return null;
  const v=this.toolsRefresh?.snapshot?.(),states=new Set(['needs_ai','not_found','ambiguous','failed','unverified','unavailable','helper_outdated','helper_broken']);if(!v||!states.has(v.state))return null;
  const finished=Number(v.finished_at||0);if(!finished||v.clicked===true)return null; // 点击后无论结果如何都禁止凭无关 tools/list 提示再次刷新。
  this.toolsRefreshNoted.add(hash);
  if(v.state==='needs_ai')return {kind:'tools_refresh',zh:'ChatHand 刚更新过，ChatGPT 里的 ChatHand 工具还是旧的：先调 upgrade_status，照 tools_refresh.rules 认出「刷新工具」按钮，调 tools_refresh_click 替用户刷新，然后接着做原来的事。',en:'ChatHand was just updated but ChatGPT still has the old ChatHand tools. Call upgrade_status, use tools_refresh.rules to identify the refresh-tools button, call tools_refresh_click, then continue the original task.'};
  return {kind:'tools_refresh',zh:`ChatHand 刚更新过，没能替用户刷新 ChatGPT 里的工具（${v.message||v.state}）：先告诉用户去 ChatGPT 设置 → 插件 → ChatHand，点「刷新工具」，再接着做。`,en:`ChatHand was just updated but could not refresh the ChatHand tools in ChatGPT (${v.message||v.state}). First tell the user to go to ChatGPT Settings → Plugins → ChatHand and click Refresh tools, then continue.`};
 }
 // 1027：装新版这一轮里 ChatGPT 问进度。wait_s>0 时 ChatHand 等到有结果（装好、没装上、要重启）或时间到再回。
 upgradeView(){
  const u=this.updater?.aiStatus?.()||{phase:'idle',current:{version:VERSION,build:this.updater?.currentBuild??null},target:null,install_state:'idle',just_updated:null,tools_changed:null,request:null};
  const r=this.toolsRefresh?.snapshot?.()||null,phase=this.upgradePending&&u.phase!=='failed'?'verifying':u.phase;
  const refresh=u.tools_changed===false?{state:'not_needed'}:r&&r.state!=='idle'?{state:r.state,...(r.message?{message:r.message}:{}),...(r.stopped_at?{stopped_at:r.stopped_at}:{}),...(Array.isArray(r.steps)&&r.steps.length?{steps:r.steps}:{}),...Object.fromEntries(['tool_list_status','waiting','lang','buttons','rules','learned','bring_existing_tab','confirmation','correlation','clicked','code','proof_current','target_attested'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]]))}:{state:u.tools_changed?'pending':'unknown'};
  const words={
   starting:'马上开始装，ChatHand 还没重启。接着调 upgrade_status（wait_s:25）。',
   installing:`正在核对、准备新版（${u.install_state}），ChatHand 还没重启。接着调 upgrade_status（wait_s:25）。`,
   restarting:'ChatHand 正在重启：接下来 15–40 秒的调用会失败，这是正常的。隔几秒再调 upgrade_status（wait_s:25），最多等 2 分钟。',
   verifying:'新版已经起来了，正在自检（这时别的工具会报 UPGRADE_VERIFYING）。接着调 upgrade_status（wait_s:25）。',
   failed:`没装上：${u.install_message||'看 ChatHand 窗口'}。照实告诉用户，请他看 ChatHand 窗口。`,
   idle:'现在没有在装新版。'};
  let message=words[phase]||'';
  if(phase==='updated'){
   const base=`已装好构建 ${u.current?.build}。`;
   message=refresh.state==='not_needed'?base+'工具没变，不用刷新。':refresh.state==='refreshed'?base+(refresh.target_attested===true?'目标页面已核验绑定的新工具清单；不能据此证明某个旧对话已更新。':'这条连接已取到当前工具表；目标页面未取得绑定证明，不能据此证明某个旧对话已更新。'):refresh.state==='needs_ai'?base+(refresh.message||''):['needs_user','unverified','dispatch_unconfirmed','host_error'].includes(refresh.state)?base+(refresh.message||'自动刷新未完成。请用户前往已打开的 ChatGPT 标签页，手动点击「刷新工具」。'):refresh.state==='running'&&refresh.waiting==='helper_manual'?base+`ChatHand 在等用户重新加载 Chrome 插件：${refresh.message||''}。现在就把这条提示告诉用户，请他做完回你一句，再调 upgrade_status（wait_s:25）。`:refresh.state==='running'&&refresh.waiting==='helper_update'?base+'Chrome 插件正在换成新版，ChatHand 等它好了接着刷新；再调一次 upgrade_status（wait_s:25）。':refresh.state==='running'||refresh.state==='pending'?base+'ChatHand 正在替用户刷新 ChatGPT 里的工具，再调一次 upgrade_status（wait_s:25）看结果。':refresh.state==='unknown'?base+'要是新工具没出来，请用户去 ChatGPT 设置里 ChatHand 那一页，拉到最下面点「刷新工具」。':base+`工具刷新没成（${refresh.message||refresh.state}${refresh.stopped_at?`；卡在「${STEP_WORDS[refresh.stopped_at]||refresh.stopped_at}」`:''}），请用户去 ChatGPT 设置里 ChatHand 那一页，拉到最下面点「刷新工具」。`;
  }
  if(phase==='updated'&&u.tools_changed)message+=' '+NEW_TOOLS_CONVERSATION_NOTE;
  return {version:VERSION,phase,current:u.current,target:u.target,install_state:u.install_state,...(u.install_message?{install_message:u.install_message}:{}),tools_changed:u.tools_changed,tools_refresh:refresh,message};
 }
 async upgradeStatus(args={}){
  if(args.wait_s!==undefined&&!(Number.isInteger(args.wait_s)&&args.wait_s>=0&&args.wait_s<=25))fail('ARG_INVALID','wait_s 要是 0–25 的整数。');
  const until=Date.now()+(args.wait_s||0)*1000,settled=v=>['updated','failed','idle','restarting'].includes(v.phase)&&!(v.phase==='updated'&&['running','pending'].includes(v.tools_refresh.state));
  let v=this.upgradeView();while(Date.now()<until&&!settled(v)){await new Promise(r=>setTimeout(r,400));v=this.upgradeView();}
  return v;
 }
 async invoke(name,args={},caller='chatgpt',context={}){
  try{
  if(currentSiteExecution()){await beforeSiteExecution();assertSiteExecution();}context.signal?.throwIfAborted();
  const cardDomain=context.cardDomain||context.transport||'legacy',relayMode=context.relayMode||(context.transport==='site_b'||context.transport==='2026-07-28'?'mcp_app':'legacy');
  const definition=toolDefinition(name),validationArgs=api31ValidationArgs(name,args);if(!definition)fail('TOOL_UNKNOWN','不支持该工具。');if(name==='card_answer'){if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['nonce','choice'].includes(k))||typeof args.nonce!=='string'||!/^[a-f0-9]{64}$/.test(args.nonce)||typeof args.choice!=='string'||!args.choice||args.choice.length>10)fail('CONFIRM_NONCE_INVALID','此卡片已失效，请查看原任务状态或 ChatHand 窗口。');}else if((name.startsWith('image_batch_')||ARTIFACT_TOOLS.some(t=>t.name===name)))validateImageBatchToolArgs(definition,validationArgs);else if(['task_checkpoint'].includes(name)||name.startsWith('browser_'))validateBrowserTool(definition,validationArgs);else if(name.startsWith('computer_')||name==='desktop_action'&&args.action==='open_path')validateComputerToolArgs(definition,validationArgs);else if(name==='matter_write')validateMatterWrite(args);else if(name==='matter_query')validateMatterQuery(args);else if(name==='begin_task'&&args.matter_ids!==undefined){if(!Array.isArray(args.matter_ids)||args.matter_ids.length>10||new Set(args.matter_ids).size!==args.matter_ids.length||args.matter_ids.some(id=>typeof id!=='string'||!/^CH-[1-9]\d*$/.test(id)))fail('MATTER_INVALID','开工事项列表无效');const {matter_ids,...rest}=args;validate(definition,rest);}else if(name==='finish_task'&&args.matter_updates!==undefined){if(!Array.isArray(args.matter_updates)||args.matter_updates.length>10)fail('MATTER_INVALID','收尾事项列表无效');for(const e of args.matter_updates)validateMatterEntry(e,{finish:true});const {matter_updates,...rest}=args;validate(definition,rest);}else if(name==='run_capability'){validate(definition,validationArgs);if(args.capability!==undefined&&!/^[a-z][a-z0-9_]{0,63}$/.test(args.capability))fail('ARG_INVALID','capability 格式无效。');if(args.parameters!==undefined&&(!args.parameters||typeof args.parameters!=='object'||Array.isArray(args.parameters)||![Object.prototype,null].includes(Object.getPrototypeOf(args.parameters))))fail('ARG_INVALID','parameters 必须是对象。');}else validate(definition,validationArgs);const {state,store,queue,policy:p}=this;
  // Every external A MCP transport has been owner-authenticated by server/relay.
  // While Site is selected, it may only receive a route-choice notice; do not
  // inspect files/tasks or execute an action. A recovery never switches back.
  // 1052 D1: rpc() passes the server-set transportSource; a direct in-process
  // caller may still pass the old `transport` label. Neither comes from the body.
  {const refused=Tools.prototype.routeRefusal.call(this,context.transportSource||context.transport,name);if(refused)return refused;}
  if(!presentationReveal(name,args))this.lastCalls[caller]={time:Date.now(),tool:name,route:(context.transportSource||context.transport)==='site_b'?'site':'openai'};
  if(!context[READ_TASK_INTERNAL]){
   if(this.readTasks?.eligible(name,caller,context)){p.check();return this.readTasks.execute(name,args,caller,context,()=>this.invoke(name,args,caller,{...context,[READ_TASK_INTERNAL]:true}));}
   this.readTasks?.promote(name,args,caller,context);
  }
  if(this.autoTasks&&!context[AUTO_TASK_INTERNAL]&&this.autoTasks.needsTask(name,args)&&!(name==='desktop_action'&&args.action==='reveal')){
   p.check();
   if(this.upgradePending)fail('UPGRADE_VERIFYING','应用正在完成升级自检');
   {const cap=capabilityOf(name,args);if(cap&&!capabilityAllowed(state,cap,{task_id:args.task_id}))throw capabilityError(cap,{command:name});}
   if(['write_text','create_directory'].includes(name))store.writable(args.path,true);
   if(name==='edit_file')store.writable(args.path);
   if(name==='move_path'&&!fs.existsSync(store.operationFile(args.operation_id))){store.writable(args.from);store.writable(args.to,true);}
   if(name==='trash_path'&&!fs.existsSync(store.operationFile(args.operation_id)))store.writable(args.path);
   if(name==='propose_command'){queue.active();store.resolve(args.cwd??'.',{directory:true});}
   if(!this.autoTasks.live(args.task_id)&&name==='command_input'&&!this.autoTasks.hasRecord(name,args,context)){
    const {task_id,...spec}=args,replay=inputReplay(queue,spec);if(replay)return {...replay,task_created:false,execution_state:'completed'};
    const job=queue.jobs?.get(args.job_id);if(!job||!p.jobOwners.has(args.job_id))fail('JOB_MISSING','找不到原命令；不能向未知命令输入。');
    if(!jobRunning(job))fail('JOB_NOT_RUNNING','原命令已经结束；不能再向它输入。');
   }
   if(!this.autoTasks.live(args.task_id)&&name==='propose_command'&&!this.autoTasks.hasRecord(name,args,context)&&/^[A-Za-z0-9_-]{8,96}$/.test(args.request_id)&&(queue.list().some(j=>j.request_id===args.request_id)||fs.existsSync(path.join(queue.dir,args.request_id+'.json'))))
    fail('REPLAY_PREVIOUS_SESSION','这条命令编号已有记录；请查询原 job_id，不要用新任务重新执行。');
   if(!this.autoTasks.live(args.task_id)&&this.autoTasks.kind(name,args)?.namespace==='file'&&!this.autoTasks.hasRecord(name,args,context)&&fs.existsSync(store.operationFile(args.operation_id))){
    const replay={write_text:()=>store.write(args.path,args.content,args.expected_sha256,args.operation_id),restore_file:()=>store.restore(args.receipt_id,args.operation_id),create_directory:()=>store.mkdir(args.path,args.operation_id),move_path:()=>store.move(args.from,args.to,args.expected_sha256,args.operation_id),trash_path:()=>store.trash(args.path,args.expected_sha256,args.operation_id),restore_trash:()=>store.restoreTrash(args.trash_id,args.operation_id),edit_file:()=>editFile(store,args)};
    const result=replay[name]();return {...result,task_created:false,previous_task_id:args.task_id,execution_state:'completed'};
   }
   if(!this.autoTasks.live(args.task_id)&&this.autoTasks.kind(name,args)?.namespace==='ui'&&!this.autoTasks.hasRecord(name,args,context)){
    // Query the original journal before replacing task_id. Its fingerprint and
    // unknown-result semantics must not be hidden by a newly reserved task.
    const replay=this.automation.ops.previous(name,args,caller);if(replay)return replay;
   }
   if(!this.autoTasks.live(args.task_id)&&['save_files','expect_download'].includes(name)&&!this.autoTasks.hasRecord(name,args,context)){
    const old=this.artifacts?.records.get(this.artifacts.key(args.task_id,args.request_id));
    if(old){const result=await (name==='save_files'?this.artifacts.save(args,caller,sessionHashOf(context.setupPrincipal,context.session)):this.artifacts.expect(args,caller,sessionHashOf(context.setupPrincipal,context.session)));return {...result,task_created:false,execution_state:result.status};}
   }
   const hash=sessionHashOf(context.setupPrincipal,context.session);
   return this.autoTasks.execute(name,args,caller,{...context,session_hash:hash},async resolved=>{
    const rebound=resolved.task_id!==args.task_id;
    if(rebound)this.resume?.before(hash,name,resolved);
    try{const result=await this.invoke(name,resolved,caller,{...context,[AUTO_TASK_INTERNAL]:true});if(rebound)this.resume?.after(hash,name,resolved,result,false);return result;}
    catch(e){if(rebound)this.resume?.after(hash,name,resolved,null,true);throw e;}
   });
  }
  // Signed Site B probes use a separate, nonserializable helper. They cannot
  // mutate A's SetupTest and cannot bypass the current permission/selection gate.
  const siteProbe=context.transport==='site_b'&&['connection_check','setup_write_probe'].includes(name);
  if(siteProbe){
   p.check();
   const route=this.bSiteLocalStore?.route('site');
   if(!this.bSiteLocalStore?.fresh(route))
    fail('B_HOST_ROUTE_UNAVAILABLE','当前 Site 不具备有效的连接状态。');
  }
  if(name==='chathand_host_flow_commit'){
   if(context.transportSource!=='site_b'||context.invocationClass!=='private_card'||!context.hostReceipt?.consume)fail('B_HOST_CAP_UNVERIFIED','当前绑定的应用内连接回执尚未通过验证。');
   return context.hostReceipt.consume(args.capability);
  }
  if(name==='setup_write_probe'){
   if(siteProbe){
    if(!context.hostProbe?.write)fail('B_HOST_SESSION_MISSING','缺少当前应用流程的有效会话关联。');
    return context.hostProbe.write(args.nonce);
   }
   return this.setupTest.record('write',args.nonce,context.session,context.setupPrincipal);
  }
  if(name==='connection_check'){
   if(!siteProbe&&args.nonce){
    try{this.setupTest.record('read',args.nonce,context.session,context.setupPrincipal);}
    catch(e){if(e.code!=='SETUP_SESSION_MISSING')throw e;}
   }
   const info={...((({tool_names,...canonical})=>canonical)(manifest(TOOLS))),instance_id:this.trace?.instance_id||store.instance_id||null,
    nonce:args.nonce||crypto.randomUUID(),time:Date.now(),caller,access_enabled:p.enabled};
   if(!siteProbe)this.lastCheck=info; // B never writes A's setup/connection evidence.
   return siteProbe&&context.hostProbe?.read?context.hostProbe.read(args.nonce,info):info;
  }
  // 1027：装新版的这一轮里，ChatGPT 要在 ChatHand 重启前后一直能问到进度，所以 upgrade_status 不受暂停和升级自检拦。只读。
  if(name==='upgrade_status')return await this.upgradeStatus(args);
  if(this.upgradePending)fail('UPGRADE_VERIFYING','应用正在完成升级自检，暂不执行 AI 操作。');
  p.check();
  if(name==='tools_refresh_click'){if(!this.toolsRefresh?.clickByNumber)fail('TOOLS_REFRESH_UNAVAILABLE','这个环境没有自动刷新工具。');return await this.toolsRefresh.clickByNumber({number:args.number,meaning:args.meaning});}
  if(name==='setup_status')return {steps:this.setupProgress.snapshot()};
  if(name==='setup_claim')return this.setupProgress.claim(args.step_id,args.owner);
  if(name==='setup_done')return this.setupProgress.done(args.step_id,args.result);
  if(name==='log_note'){
   const t=p.require(args.task_id,caller);
   const dir=path.join(store.stateDir,'activity-records');
   fs.mkdirSync(dir,{recursive:true,mode:0o700});
   const file=path.join(dir,t.id+'.jsonl');
   const note={event:args.event,kind:args.kind||'activity',summary:args.summary,reference:args.reference||null,at:new Date().toISOString()};
   appendActivityNote(file,note);
   return {recorded:true,path:file,event:note.event};
  }
  const session_hash=sessionHashOf(context.setupPrincipal,context.session),pendingConfirm=this.confirmations?.pending({task_id:args.task_id,session_hash});
  // Existing cards retain nonce validation; pending legacy cards never block a new action.
  // Matter records use only the authenticated local-user journal. No external TaskPolicy grant is created.
  if(name==='matter_query'){if(!this.matterStore)fail(this.matterUnavailableCode||'MATTER_UNAVAILABLE','本机事项库记录无法核对，操作已暂停');validateMatterQuery(args);return this.matterStore.query(args,{project_id:state.data.active,session_hash});}
  if(name==='matter_write'){
   if(!this.matterStore)fail(this.matterUnavailableCode||'MATTER_UNAVAILABLE','本机事项库记录无法核对，操作已暂停');
   const entries=validateMatterWrite(args);
   for(const entry of entries)if(entry.task_id){
    const task=p.getBound(entry.task_id,caller,session_hash,context.connectionPrincipal||null);
    if(task.project_id!==state.data.active)fail('ROOT_CHANGED','事项关联任务的工作区已改变');
   }
   return this.matterStore.write(args,{project_id:state.data.active,session_hash,recorded_in:{kind:'authenticated_connector',project_id:state.data.active,session_hash}});
  }
  if(name==='relay_card_control'){
    if(context.invocationClass!=='private_card'||relayMode!=='mcp_app')fail('RELAY_APP_ONLY','接力控制只允许官方 MCP App 私有工具。');
    const ctx={caller,session_hash:sessionHashOf(context.setupPrincipal,context.session),transport:relayMode};
    if(!ctx.session_hash)fail('RELAY_CONTEXT_INVALID','当前连接没有可验证的会话。');
    const relay=this.relayKeeper;if(!relay)fail('RELAY_NOT_READY','接力服务尚未就绪。');
    if(args.action==='interruption'){const witness=this.h8Cards.consumeRelayInterruption(args.interruption_token,args.task_id,caller,ctx.session_hash,cardDomain);const pending=relay.interruption({task_id:args.task_id},ctx,witness);const {_relay_meta,...safe}=pending;return {...safe,...(_relay_meta?.card_token?{_card_meta:{'chathand/relay_card_token':_relay_meta.card_token}}:{})};}
    if(args.action==='view'){const status=relay.view(args,ctx);const t=p.get(args.task_id,caller);if(t.session_hash!==ctx.session_hash)fail('RELAY_CARD_INVALID','任务不属于当前会话。');const meta=this.interruptionMetadata(args.task_id,caller,context);const errors=validCardErrors(args.card_errors);if(errors)this.events?.record('card.errors',errors);return {relay:{...status,report_errors:true},task:this.privateTaskView(t),...(meta?{_card_meta:meta}:{})};}
    if(args.action==='claim'){const granted=relay.claim({task_id:args.task_id,card_token:args.card_token,mode:args.mode,request_id:args.request_id},ctx);if(!granted.granted)return granted;const {permit_token,...safe}=granted;return {...safe,_card_meta:{'chathand/relay_permit_token':permit_token}};}
    if(args.action==='begin_dispatch')return relay.beginDispatch({task_id:args.task_id,permit_token:args.permit_token},ctx);
    if(args.action==='report')return relay.report({attempt_id:args.attempt_id,report_token:args.report_token,outcome:args.outcome,error_code:args.error_code??null,definitely_not_sent:args.definitely_not_sent===true,output_conflict:args.output_conflict??null,input_conflict:args.input_conflict??null},ctx);
    if(args.action==='cancel')return relay.cancel({task_id:args.task_id,card_token:args.card_token},ctx);
    fail('RELAY_ARGUMENT_INVALID','无效的卡片动作。');
   }
   if(name==='card_answer'){if(this.h8Cards.proveConsumedCard(args.nonce,caller,session_hash,cardDomain))fail('RELAY_CARD_SUPERSEDED','这张卡片已经处理，请使用当前的卡片。');if(args.choice==='status'){
    if(this.h8Cards.provePermissionStatus(args.nonce,caller,session_hash,cardDomain))return this.h8Cards.permissionStatus(args.nonce,caller,session_hash,cardDomain);
    const image=this.h8Cards.imageObservation(args.nonce,caller,session_hash,cardDomain);
    if(image){const batch=this.imageBatch.get(image.batch_id);if(batch.binding?.task_id!==image.task_id||batch.binding.caller!==caller||batch.binding.session_hash!==session_hash)fail('CONFIRM_NONCE_INVALID','此卡片已失效，请查看原任务状态或 ChatHand 窗口。');this.artifacts.guard(batch.binding);return this.imageBatch.view(batch);}
    const id=this.h8Cards.observation(args.nonce,caller,session_hash,cardDomain);
    if(id){const task=p.view(p.get(id,caller)),meta=this.interruptionMetadata(id,caller,context);return {task:this.privateTaskView(p.get(id,caller)),...(meta?{_card_meta:meta}:{})};}
    return this.h8Cards.status(args.nonce,caller,session_hash,cardDomain);
   }if(['stop','continue'].includes(args.choice))return this.taskCardControl(args,caller,{...context,cardDomain,relayMode});
   const card=this.h8Cards.consume(args.nonce,args.choice,caller,session_hash,cardDomain);if(card.request.startsWith('option:'))return this.h8Cards.answerOption(card,this.resume);if(typeof this.commitConfirmation!=='function')fail('CONFIRMATION_UNAVAILABLE','这个环境无法提交确认，请使用 ChatHand 窗口。');return this.commitConfirmation({id:card.request.slice(11),scope:args.choice,via:'chat',cardContext:card});}
  {const cap=capabilityOf(name,args);if(cap&&!capabilityAllowed(state,cap,{task_id:args.task_id}))throw capabilityError(cap,{command:name});}
  if(BROWSER_EXPERIENCE_TOOLS.some(tool=>tool.name===name))return await Tools.prototype.controlResult.call(this,invokeBrowserExperience(this.automation,name,args,caller),name,args,context);
  if(name==='computer_observe')return await Tools.prototype.controlResult.call(this,this.automation.ops.read(args.task_id,caller,()=>this.automation.computer.observe(args,caller)),name,args,context);
  if(name==='computer_batch')return await Tools.prototype.controlResult.call(this,this.automation.ops.run(name,args,caller,()=>this.automation.computer.batch(args,caller)),name,args,context);
  if(name==='desktop_action'&&args.action==='open_path')return await Tools.prototype.controlResult.call(this,this.automation.ops.run(name,args,caller,()=>this.automation.computer.openPath(args,caller,store)),name,args,context);
  if(name==='automation_stop'){this.relayKeeper?.cancelAll('stopped');this.artifacts.cancelAll();}
  if(this.automation.has(name))return await Tools.prototype.controlResult.call(this,this.automation.invoke(name,args,caller),name,args,context);
  if(name==='finish_task'&&this.automation.ops.busy(args.task_id))fail('TASK_BUSY','浏览器或桌面操作尚未结束。');
  if(name==='install_update'){
   if(!this.updater?.aiPlan)fail('UPDATE_UNAVAILABLE','这个环境不能更新 ChatHand。');
   const plan=this.updater.aiPlan({build:args.build??null}),mine=args.task_id?p.require(args.task_id,caller):null,jobs=queue.list();
   const own=[mine];if(plan.request_task&&plan.request_task!==mine?.id)try{own.push(p.get(plan.request_task,caller));}catch{/* 别的连接开的任务不替它收尾 */}
   const open=own.filter(t=>t&&t.status==='active');
   for(const t of open)if(t.jobs.some(id=>jobs.some(j=>j.job_id===id&&j.process_alive)))fail('UPDATE_TASK_BUSY','这个任务里还有命令在跑，先停掉（cancel_command）再装。');
   return this.updater.aiInstall(plan,{session_hash:sessionHashOf(context.setupPrincipal,context.session),caller,sourceTask:mine,source_task_ids:open.map(t=>t.id)});
  }
  if(name==='request_update'){const t=p.require(args.task_id,caller);if(!this.updater)fail('UPDATE_UNAVAILABLE','这个环境不能更新 ChatHand。');const jobs=queue.list();if(t.jobs.some(id=>jobs.some(j=>j.job_id===id&&j.process_alive)))fail('UPDATE_TASK_BUSY','这个任务里还有命令在跑，先停掉（cancel_command）再申请。');const title=t.conversation_title||(t.session_hash&&state.data.session_groups?.[t.session_hash]?.title)||null;return await this.updater.requestLocal({app_path:args.app_path,note:args.note||'',task_id:t.id,conversation_title:title});}
  if(this.artifacts?.has(name)){if(name==='artifact_status')return this.artifacts.status(args,caller,session_hash);this.artifacts.binding(args.task_id,caller,session_hash);const actionArgs={...artifactObserverArgs(args,name),source_fingerprint:crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex')};return p.fileAction(p.require(args.task_id,caller),name,actionArgs,()=>name==='save_files'?this.artifacts.save(args,caller,session_hash):this.artifacts.expect(args,caller,session_hash));}
  if(name==='finish_task'&&this.artifacts?.busy(args.task_id))fail('TASK_BUSY','成果接收或下载等待还没有结束。');
  if(this.imageBatch.has(name)){
   const result=await this.imageBatch.invoke(name,args,caller,{session_hash}),batch=result?.batch_id&&this.imageBatch.get(result.batch_id),binding=batch?.binding;
   if(binding?.caller===caller&&binding.session_hash===session_hash&&p.get(binding.task_id,caller).status==='active')return {...result,_card_meta:{'chathand/image_batch_observation_nonce':this.h8Cards.imageObservationToken(batch.batch_id,binding.task_id,caller,session_hash,cardDomain)}};
   return result;
  }
  if(name==='records_export'){
   this.historyExporter??=new HistoryExporter({store,policy:p,getValueStats:()=>this.valueStats});
   return this.historyExporter.export(args,{caller,session_hash});
  }
  if(name==='desktop_action'&&args.action==='reveal'){p.getBound(args.task_id,caller,session_hash,context.connectionPrincipal||null);store.checkActive();store.resolve(args.path);return this.revealPath(args);}
  if(this.features.has(name)){const r=await this.features.invoke(name,args,caller,{session_hash});if(name==='show_task'&&r?.task){const progress=this.resume.view(r.task);return {...r,task:{...r.task,...progress,wait_state:taskWaitState({task:r.task,jobs:queue.list(),confirmations:this.confirmations?.forTask(args.task_id)||[],checkpoint:progress,artifactBusy:!!this.artifacts?.busy(args.task_id),inputs:[...(queue.inputs?.values()||[])]})},...(session_hash&&r.task.status==='active'?{_card_meta:{'chathand/observation_nonce':this.h8Cards.observationToken(args.task_id,caller,session_hash,cardDomain)}}:{})};}return r;}
  if(name==='chathand_guide')return chathandGuide(args.topic);
  if(name==='run_capability'){if(!this.extraCapabilities.entries.has(args.capability))return {discovery:true,executed:false,extra_capabilities:this.extraCapabilities.list()};return this.extraCapabilities.call(args.capability,args.parameters??{},{caller,context});}
  if(name==='bridge_info')return {...store.info(),extra_capabilities:this.extraCapabilities.list(),output_default:OUTPUT_DEFAULT+' 当前工作区 / Current workspace: '+store.root,known_limits:KNOWN_LIMITS.map(x=>({...x})),tools_by_category:toolsByCategory(),tool_access:toolAccess(),permissions:permissionsInfo(state,{adminReady:adminReadyFor(state,queue.adminAccess)}),client_version:VERSION,client_build:this.updater?.currentBuild??null,update:this.updater?.forAI?.()??null,manifest:((({tool_names,...canonical})=>canonical)(manifest(TOOLS))),project_id:state.data.active,policy:{mode:state.data.mode,full_armed:p.fullArmed,task_required_for_mutations:false,automatic_task_creation:true,task_approval:'automatic'},caller,startup_timing:this.events?.startupSnapshot?.()||[],terminal:queue.status()};
  if(name==='begin_task'){
   if(!this.matterStore&&Array.isArray(args.matter_ids)&&args.matter_ids.length)
    fail(this.matterUnavailableCode||'MATTER_UNAVAILABLE','事项库记录无法核对，不能认领事项');
   const session_hash=sessionHashOf(context.setupPrincipal,context.session);
   if(session_hash&&args.new_task!==true&&!p.requests.has(caller+':'+args.request_id)){const open=[...p.tasks.values()].find(t=>t.session_hash===session_hash&&t.caller===caller&&['active','pending_approval'].includes(t.status));if(open){const reused=p.reuse(open.id,args,caller,{session_hash,connection_principal:context.connectionPrincipal||null});const adopted=this.readTasks?.adoptTitle(open.id,args.title);return {...(adopted?p.view(open):reused),...this.resume.view(p.view(open)),replayed:true,reused_open_task:true,chathand_note:MATTER_RECORDING_NOTE};}}
   const previous=args.new_task!==true&&!p.requests.has(caller+':'+args.request_id)?this.taskContinuity.latestCancelled(caller,session_hash):null;
   const result=p.begin(args,caller,{session_hash,connection_principal:context.connectionPrincipal||null});
   if(!result.replayed)this.taskContinuity.carry(result.task_id,previous,session_hash);
   // 1026：明说是另一件事（new_task:true）时，同一段对话里没收尾、也没在跑命令的旧任务收起来，记成「被新任务接替了」。
   if(!result.replayed&&args.new_task===true&&session_hash)for(const old of [...p.tasks.values()])if(old.id!==result.task_id&&old.session_hash===session_hash&&old.caller===caller)p.endQuietly(old,'superseded');
   const ext=this.automation.browser.extension;
   if(!result.replayed&&session_hash&&!state.data.session_groups?.[session_hash]?.conversation_id&&ext.status().connected){
    try{const detected=await ext.request('detect_generating_chat',{},caller,result.task_id);if(detected?.url&&/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+$/.test(detected.url)&&!state.data.session_groups?.[session_hash]?.conversation_id){p.require(result.task_id,caller);bindActivity(p,state,{task_id:result.task_id,url:detected.url,title:state.data.session_groups[session_hash].title,source:'auto_detected'});}}catch{/* Optional browser evidence never prevents task creation. */}
   }
   const base={...(result.replayed?result:{...p.view(p.get(result.task_id,caller)),guidance:beginGuidance(store,result)}),chathand_note:MATTER_RECORDING_NOTE,...(!result.replayed&&this.extraCapabilities.list().length?{extra_capabilities:this.extraCapabilities.list()}:{})};
   if(!this.matterStore)return {...base,matters_available:false,matter_error_code:this.matterUnavailableCode||'MATTER_UNAVAILABLE'};
   const ids=args.matter_ids||[];
   if(!Array.isArray(ids)||ids.length>10||ids.some(id=>typeof id!=='string'||!/^CH-[1-9]\d*$/.test(id)))fail('MATTER_INVALID','事项列表无效');
   const matterMeta={project_id:state.data.active,session_hash};
   const accepted=ids.length?await this.matterStore.claim(p.get(result.task_id,caller),ids,matterMeta):{matters_saved:true,matters:[]};
   const related=ids.length?[]:this.matterStore.query({limit:3,scope:'current_project'},matterMeta).items.filter(v=>v.state!=='resolved').slice(0,3);
   return {...base,...accepted,related_matters:related.map(({id,revision,title,state})=>({id,revision,title,state}))};
  }
  if(name==='task_status'){let t=p.get(args.task_id,caller);const until=Date.now()+(args.wait_ms||0),waiting=this.confirmations?.pending({task_id:args.task_id});if(waiting&&args.wait_ms)this.confirmations.waiter(args.task_id,true);try{while(Date.now()<until&&(t.status==='pending_approval'||waiting&&this.confirmations?.snapshot().some(c=>c.id===waiting.id&&['waiting','applying'].includes(c.state)))){await new Promise(r=>setTimeout(r,60));t=p.get(args.task_id,caller);}const v=p.view(t),progress=this.resume.view(v),confirmations=this.confirmations?.forTask(args.task_id)||[];const activity=args.include_activity===true?{activity_notes:readTaskActivity({policy:p,stateDir:store.stateDir,taskId:args.task_id,caller,sessionHash:session_hash,offset:args.activity_offset??0,limit:args.activity_limit??10})}:{};return {...(args.from_card===true?{}:{...v,...progress}),wait_state:taskWaitState({task:v,jobs:queue.list(),confirmations,checkpoint:progress,artifactBusy:!!this.artifacts?.busy(args.task_id),inputs:[...(queue.inputs?.values()||[])]}),...(args.from_card===true?this.privateTaskView(t):activity),...this.h8Cards.optionState(args.task_id),...(args.from_card===true?{}:{confirmations}),...(args.from_card===true?(()=>{const meta=this.interruptionMetadata(args.task_id,caller,context,{snapshot:context.stallWitness,observerRevision:context.observerRevision,ignoreInflight:true});return meta?{_card_meta:meta}:{};})():{})};}finally{if(waiting&&args.wait_ms)this.confirmations.waiter(args.task_id,false);}}
  if(name==='task_checkpoint'){p.require(args.task_id,caller);if(args.withdraw_confirm){if(!/^cf_[a-f0-9]{16}$/.test(args.withdraw_confirm))fail('ARG_INVALID','withdraw_confirm 需要有效的确认编号。');this.confirmations?.withdraw(args.withdraw_confirm,args.task_id);}this.h8Cards.invalidateCheckpoint(args.task_id);const saved=this.resume.checkpoint(args.task_id,args);
   const rendered=this.h8Cards.checkpoint(saved,caller,session_hash,cardDomain);
   if(!this.relayKeeper||!session_hash)return rendered;
   const ctx={caller,session_hash,transport:relayMode};
   const armed=this.relayKeeper.checkpoint({task_id:args.task_id,checkpoint_seq:saved.checkpoint_seq,continuing:!args.waiting_user&&typeof args.next==='string'&&args.next.trim().startsWith('接着做'),waiting_user:args.waiting_user===true},ctx);
   this.events?.record('relay.checkpoint',{task:args.task_id,seq:saved.checkpoint_seq,continuing:!args.waiting_user&&typeof args.next==='string'&&args.next.trim().startsWith('接着做'),waiting_user:args.waiting_user===true,card:!!armed?._relay_meta?.card_token});
   const meta=armed?._relay_meta?.card_token?{'chathand/relay_card_token':armed._relay_meta.card_token}:{};
   return {...rendered,...(armed?.relay?{relay:armed.relay}:{}),...(armed?.instruction?{relay_instruction:armed.instruction}:{}),...(Object.keys(meta).length?{_card_meta:{...(rendered._card_meta||{}),...meta}}:{})};}
  if(name==='task_resume_claim'){return {granted:false,reason:'old_parallel_sender_disabled'};}
  if(name==='task_stop')return this.stopTask(args.task_id,caller,context);
  if(name==='finish_task'){
   const success=args.success??true,matterStore=this.matterStore,updates=args.matter_updates||[];
   if(!matterStore&&updates.length)fail(this.matterUnavailableCode||'MATTER_UNAVAILABLE','事项库记录无法核对，不能收尾事项');
   if(updates.length&&!session_hash)fail('MATTER_CONVERSATION_UNVERIFIED','事项收尾需当前经过验证的会话');
   if(updates.length)p.getBound(args.task_id,caller,session_hash,context.connectionPrincipal||null);
   const task=p.get(args.task_id,caller),old=matterStore?.pending.get(args.task_id);
   const linked=matterStore&&[...matterStore.items.values()].some(v=>v.task_id===args.task_id&&v.state==='waiting_ai'&&!v.deleted);
   if(matterStore&&(updates.length||old||linked)){
    if(task.completion&&!old)fail('MATTER_FINISH_CONFLICT','原任务已结束，不能新加不同事项收尾内容');
    matterStore.prepareFinish(task,task.caller||caller,updates,{project_id:task.project_id,session_hash:task.session_hash,receipt_owner_hash:p.receipts?.owner(task.caller||caller)||null});
   }
   const done=p.finish(args.task_id,caller,success,args.summary??'',finishUserAction(args,this.updater,success));
   const matters=matterStore?await matterStore.applyFinish(args.task_id,task.caller||caller,{project_id:task.project_id,session_hash:task.session_hash}):
    {matters_saved:false,matters:[],matter_error_code:this.matterUnavailableCode||'MATTER_UNAVAILABLE'};
   let changes=[];try{changes=this.features.changes.read(args.task_id,caller).slice(-6);}catch{}
   return {...done,...matters,task_terminal:done.terminal===true,changes,scope:state.data.mode,reply_format:{...REPLY_FORMAT}};
  }
  if(name==='list_conversations')return {conversations:state.data.conversations.filter(c=>c.project_id===state.data.active),source:'user_saved_only'};
  if(name==='list_directory')return store.list(args.path||'.',args);
  if(name==='read_text')return store.read(args.path,args.start_line??1,args.max_lines??250);
  if(name==='search_text'){const r=store.search(args.query,args.path||'.');return {...r,total:r.truncated?null:r.matches.length,at_least:r.matches.length,incomplete:r.truncated===true,results_complete:r.truncated!==true,next_offset:null,next_cursor:null,continuation:'start_search + search_results; full counts require existing command permission and authorized files'};}
  if(name==='list_commands'){
   const limit=args.limit??20,offset=args.offset??0;let jobs=queue.list().filter(j=>{const t=p.tasks.get(p.jobOwners.get(j.job_id));return t?.caller===caller&&t.session_hash===session_hash&&(!args.running_only||jobRunning(j));}).sort((a,b)=>b.created_at-a.created_at||b.job_id.localeCompare(a.job_id));
   const project=j=>({job_id:j.job_id,status:j.status,program:[j.program,...(j.args||[])].join(' ').slice(0,160),exit_code:j.exit_code,created_at:j.created_at,finished_at:j.finished_at});const page=jobs.slice(offset,offset+limit);while(page.length>1&&JSON.stringify(page.map(project)).length>7400)page.pop();return {jobs:page.map(project),total:jobs.length,offset,limit,next_offset:offset+page.length<jobs.length?offset+page.length:null,...(jobs[0]?.warning?{warning:jobs[0].warning}:{}),scope:'this_connector_session'};
  }
  if(['command_result','cancel_command'].includes(name)){const owner=p.jobOwners.get(args.job_id);if(!owner)fail('JOB_MISSING','当前连接找不到任务；不要猜测旧进程状态。');const task=p.getBound(owner,caller,session_hash,context.connectionPrincipal||null);if(name==='cancel_command')return queue.cancel(args.job_id);
   if(args.full===true){
    if(args.cursor!==undefined&&args.cursor!==0)fail('ARG_INVALID','full:true不能与非零旧整数cursor混用；用返回的full_cursor续取。');
    const scope={job:args.job_id,task:owner,project:store.root,caller:task.caller||caller,session:task.session_hash||null,principal:task.connection_principal||''};
    return queue.resultFull(args.job_id,{scope,full_cursor:args.full_cursor??null,wait_ms:args.wait_ms??0,envelopeSize:context.fullEnvelopeSize,compatibility_note:args.brief===true||args.cursor===0?'以 full 为准，忽略 brief/cursor:0。':undefined});
   }
   if(args.full_cursor!==undefined)fail('ARG_INVALID','full_cursor需要full:true。');
   const started=Date.now(),job=await queue.result(args.job_id,args.wait_ms??0,args.brief===true?undefined:args.cursor),note=this.resume.observeJob(owner,job,{wait_ms:args.wait_ms??0,elapsed_ms:Date.now()-started});
   return {...(args.brief===true?briefJob(job):digestJob(job,{full:args.full===true})),...(note?{chathand_note:note}:{})};}
  if(name==='input_status'){const a=queue.inputs.get(args.input_id);if(!a)fail('INPUT_MISSING','找不到输入。');p.get(p.jobOwners.get(a.job_id),caller);return {input_id:a.input_id,status:a.status,job_id:a.job_id};}
  if(name==='operation_status'){const a=p.approvals.get(args.approval_id);if(!a)fail('APPROVAL_MISSING','找不到操作。');p.get(a.task_id,caller);return {approval_id:a.id,status:a.status,result:a.result,error:a.error};}
  const t=p.require(args.task_id,caller);
  const file={write_text:()=>store.write(args.path,args.content,args.expected_sha256,args.operation_id),restore_file:()=>store.restore(args.receipt_id,args.operation_id),create_directory:()=>store.mkdir(args.path,args.operation_id),move_path:()=>store.move(args.from,args.to,args.expected_sha256,args.operation_id),trash_path:()=>store.trash(args.path,args.expected_sha256,args.operation_id),restore_trash:()=>store.restoreTrash(args.trash_id,args.operation_id)};
  if(file[name])return this.features.changes.capture(t.id,name,args,()=>p.fileAction(t,name,args,file[name]));
  if(name==='propose_command'){
   const {task_id,wait_ms=0,...spec}=args;let cwd=null;try{cwd=store.resolve(spec.cwd??'.',{directory:true});}catch{}const gate=gateCommand({spec,state,blocks:this.blocks,confirmations:this.confirmations,task:t,self:this.self,cwd:cwd||store.root});const j=queue.propose(gate.admin?{...spec,admin:gate.admin}:spec);const owner=p.jobOwners.get(j.job_id);if(owner&&owner!==t.id)fail('OP_CONFLICT','命令编号属于另一个任务。');p.jobOwners.set(j.job_id,t.id);if(!t.jobs.includes(j.job_id))t.jobs.push(j.job_id);
   if(j.status==='pending_approval')queue.bindFullOutput(j.job_id,{job:j.job_id,task:t.id,project:store.root,caller,session:session_hash,principal:t.connection_principal||''});
   if(j.status==='pending_approval')queue.approve(j.job_id);
   const job=await queue.result(j.job_id,wait_ms);if(wait_ms>0)this.resume.observeJob(t.id,job,{wait_ms,record_poll:false});return digestJob(job);
  }
  if(name==='command_input'){
   if(!p.jobOwners.has(args.job_id)||!queue.jobs?.has(args.job_id))fail('JOB_MISSING','找不到原命令；不能向未知命令输入。');const {task_id,...spec}=args;
   const {gateCommandInput}=await import('./v1/command-input.mjs');
   gateCommandInput({job:queue.jobs.get(args.job_id),text:spec.text,state,blocks:this.blocks,confirmations:this.confirmations,task:t,self:this.self,cwd:store.root});
   const replay=inputReplay(queue,spec);if(replay)return replay;const input=queue.proposeInput(spec);if(input.status==='pending_approval')queue.approveInput(input.input_id);return {input_id:input.input_id,status:queue.inputs.get(input.input_id).status,job_id:input.job_id};
  }
  fail('TOOL_UNKNOWN','工具未实现。');
  }catch(e){Tools.prototype.recordBlocked.call(this,e,name,artifactObserverArgs(args,name),context);throw e;}
 }
 // Reveals use current scope even for terminal receipts and never create tasks.
 revealPath(args){return desktopAction(this.store,args);}
 stopTask(task_id,caller,context={}){
  const t=this.policy.getBound(task_id,caller,sessionHashOf(context.setupPrincipal,context.session),context.connectionPrincipal||null);
  if(!['active','pending_approval'].includes(t.status))return {stopped:false,task_id:t.id,status:t.status,terminal:true,reason:'already_terminal',...(t.completion?.stop_context?{stop_context:structuredClone(t.completion.stop_context)}:{})};
  t.stop_context=this.taskContinuity.snapshot(t);
  const receipt=this.policy.revokeTask(t,'cancelled');
  this.h8Cards.invalidateCheckpoint(t.id);this.taskControlRelays?.delete(t.id);this.taskCardRelays?.delete(t.id);
  return {stopped:receipt.status==='cancelled',task_id:t.id,status:receipt.status,terminal:receipt.terminal,stop_context:structuredClone(receipt.stop_context),...(receipt.continuity?{continuity:receipt.continuity}:{})};
 }
 cardTaskContext(t,caller,context){
  return !!t&&t.caller===caller&&t.session_hash===sessionHashOf(context.setupPrincipal,context.session)&&
   t.project_id===this.state.data.active&&t.root===this.store.root&&
   (t.connection_principal==null||t.connection_principal===context.connectionPrincipal);
 }
 taskCardControl(args,caller,context){
  if(context.invocationClass!=='private_card')fail('CONFIRM_NONCE_INVALID','此卡片已失效，请查看原任务状态。');
  const hash=sessionHashOf(context.setupPrincipal,context.session),key=crypto.createHash('sha256').update(args.nonce).digest('hex');
  const issued=this.h8Cards.tokens.get(key),task=issued&&this.policy.tasks.get(issued.task_id);
  if(!this.cardTaskContext(task,caller,context))fail('CONFIRM_NONCE_INVALID','此卡片已失效，请查看原任务状态。');
  const target=this.h8Cards.consumeTaskControl(args.nonce,args.choice,caller,hash,context.cardDomain);
  if(args.choice==='stop')return this.stopTask(target.task_id,caller,context);
  const binding=this.taskControlRelays?.get(target.task_id);this.taskControlRelays?.delete(target.task_id);
  if(context.relayMode!=='mcp_app'||!this.relayKeeper||binding?.nonce_hash!==key||binding.checkpoint_seq!==target.checkpoint_seq)
   return {task_id:target.task_id,granted:false,reason:'relay_unavailable'};
  // No host message here. The existing app protocol must consume the permit,
  // send once only after send:true, then report accepted/rejected/unknown.
  try{
   const granted=this.relayKeeper.claim({task_id:target.task_id,card_token:binding.card_token,mode:'manual',request_id:crypto.randomUUID()},{caller,session_hash:hash,transport:'mcp_app'});
   const {permit_token,...safe}=granted;
   return {task_id:target.task_id,...safe,...(permit_token?{_card_meta:{'chathand/relay_permit_token':permit_token,'chathand/task_continue':{task_id:target.task_id,checkpoint_seq:target.checkpoint_seq,next:'begin_dispatch',tool:'relay_card_control',host_send_verified:false}}}:{})};
  }catch(e){this.h8Cards.unknownTasks.add(target.task_id);throw e;}
 }
 attachTaskCard(result,name,args,caller,context){
  const ordinary=['begin_task','task_checkpoint','task_status','finish_task','show_task','task_stop'];
  if(!ordinary.includes(name)&&!(context.invocationClass==='private_card'&&['card_answer','relay_card_control'].includes(name)))return result;
  const task_id=result?.task?.task_id||result?.task_id||result?.relay?.task_id||context.privateOptionTaskId||(['relay_card_control','task_status','show_task','finish_task','task_checkpoint'].includes(name)?args.task_id:null);
  if(!task_id)return result;
  try{
   const t=this.policy.getBound(task_id,caller,sessionHashOf(context.setupPrincipal,context.session),context.connectionPrincipal||null);
   const view=this.policy.view(t),progress=this.resume.view(view,{record:false});
   const full={...view,...progress,wait_state:this.taskWaitState(task_id),...this.h8Cards.optionState(task_id)};
   if(result.do_not_replay===true||this.automation?.ops?.uncertainTasks?.has(task_id))full.do_not_replay=true;
   let changes;try{changes=this.features.changes.read(task_id,caller).map(c=>c.tool==='trash_path'&&c.status==='recycled'?{...c,status:'applied'}:c);}catch{/* Missing metadata is not a failed operation. */}
   let meta={...result._card_meta};
   if(t.status==='active'&&this.cardTaskContext(t,caller,context)&&!full.do_not_replay){
    const hash=sessionHashOf(context.setupPrincipal,context.session),domain=context.cardDomain||'legacy';
    try{
     this.taskObservationTokens??=new Map();
     if(!meta['chathand/observation_nonce']){
      const old=this.taskObservationTokens.get(task_id);
      meta['chathand/observation_nonce']=old&&this.h8Cards.provePrivateNonce(old,caller,hash,domain,'observe:'+task_id)?old:this.h8Cards.observationToken(task_id,caller,hash,domain);
     }
     this.taskObservationTokens.set(task_id,meta['chathand/observation_nonce']);
     const token=meta['chathand/relay_card_token']||(name==='relay_card_control'?args.card_token:null);
     this.taskCardRelays??=new Map();
     if(token)this.taskCardRelays.set(task_id,{token,caller,hash,domain,principal:context.connectionPrincipal??null});
     const saved=this.taskCardRelays.get(task_id),actions=['stop'];let relay=null;
     if(context.relayMode==='mcp_app'&&saved&&saved.caller===caller&&saved.hash===hash&&saved.domain===domain&&saved.principal===(context.connectionPrincipal??null)&&this.relayKeeper){
      relay=this.relayKeeper.view({task_id,card_token:saved.token},{caller,session_hash:hash,transport:'mcp_app'});
      if(relay.state==='unknown'||relay.outcome==='unknown')full.do_not_replay=true;
      if(relay.manual_allowed===true&&relay.checkpoint_seq===progress.checkpoint_seq&&!full.do_not_replay)actions.push('continue');
     }
     if(!full.do_not_replay){
      const controls=this.h8Cards.taskControls(task_id,caller,hash,domain,{actions});meta={...meta,...controls};
      this.taskControlRelays??=new Map();
      if(actions.includes('continue'))this.taskControlRelays.set(task_id,{nonce_hash:crypto.createHash('sha256').update(controls['chathand/task_control_nonce']).digest('hex'),card_token:saved.token,checkpoint_seq:progress.checkpoint_seq});
      else this.taskControlRelays.delete(task_id);
     }
    }catch{/* Card service failure never changes the original task outcome. */}
   }
   const history=this.resume.tasks.get(task_id)?.checkpoints;
   return withTaskCard({...result,_card_meta:meta},full,{checkpoints:history?.length?history:view.stop_context?.checkpoints||view.continuation?.checkpoints,changes});
  }catch{return result;}
 }
 recordBlocked(e,name,args={},context={}){
  const blocked=e?.details?.blocked||blockedForError(e,{tool:name});if(!blocked)return;
  e.details={...e.details,blocked};
  const hash=sessionHashOf(context.setupPrincipal,context.session),t=this.policy?.tasks?.get(args.task_id)||[...(this.policy?.tasks?.values()||[])].find(t=>hash&&t.session_hash===hash&&t.status==='active');
  if(blocked.kind==='can_enable'&&!blocked.confirm&&!blocked.answer)this.confirmations?.create({blocked,task_id:t?.id||args.task_id,session_hash:hash||t?.session_hash,conversation_title:t?.conversation_title||t?.title,hash:name==='propose_command'?commandHash({program:args.program,args:args.args,cwd:args.cwd}):name});
  if(blocked.kind==='can_enable'&&this.confirmations?.offerSettingsCards===false)e.details.instructions_for_ai=[blocked.next,'继续不依赖这个开关的部分，不弹授权卡、不重试、不绕过。'];
  if(!e.blockRecorded){this.blocks?.record({kind:blocked.gate,id:blocked.item.id,name:blocked.item.name,command:name,reason:e.message,task_id:t?.id||args.task_id||null,conversation_id:t?.conversation_id||null,blocked});e.blockRecorded=true;}
 }
 rememberControlContext(name,args){if(typeof args.task_id==='string'&&(name.startsWith('browser_')||name.startsWith('computer_'))){this.cardControlContext||=new Map();this.cardControlContext.set(args.task_id,{scope:name.startsWith('browser_')?'browser':'desktop',at:Date.now(),epoch:this.policy.epoch});}}
 async controlResult(promise,name,args,context){let r;try{r=await promise;}catch(e){if(!['ARG_INVALID','TASK_OWNER','TASK_MISSING','TASK_REVOKED','ROOT_CHANGED'].includes(e.code))this.rememberControlContext(name,args);throw e;}this.rememberControlContext(name,args);if(r?.status==='failed'&&r.error)Tools.prototype.recordBlocked.call(this,r.error,name,args,context);return r;}
 // 1052 D1 / R04: the only route decision. `source` is the server-set
 // transportSource (or a direct caller's old transport label). An A call while
 // Site is selected, or an ordinary Site call while A is selected, gets a notice
 // only: nothing is read, no task is touched, no route is switched. A healthy A
 // or a reconnecting A is not a reason to switch; that stays in the Site store.
 routeRefusal(source,name){
  if(!this.bSiteLocalStore)return null;
  const selected=this.bSiteLocalStore.selection().selected;
  if(A_TRANSPORTS.includes(source)&&!['connection_check','setup_write_probe'].includes(name)&&selected!=='openai')
   return {executed:false,error_code:'ROUTE_NOT_SELECTED',selected:'site',
    result_line:displayText('route.refusal.site'),
    next_action:'select_current_conversation_connection',can_execute:false};
  if(source==='site_b'&&!['connection_check','setup_write_probe'].includes(name)&&selected!=='site')
   return {executed:false,error_code:'ROUTE_NOT_SELECTED',selected:'openai',
    result_line:displayText('route.refusal.openai'),
    next_action:'select_current_conversation_connection',can_execute:false};
  return null;
 }
 // 1052 D1 / R05: the one internal entry for an ordinary Site call. It goes
 // through rpc() exactly like an A call, so task ownership (caller + session +
 // project + principal), relay start/end, Resume.before/after, confirmations
 // and tracing all run BEFORE any business read or side effect. Only
 // BSiteDispatch calls this, after it verified the signed job and binding.
 // Returns the raw-shaped value the Site ledger stores, and whether it failed.
 async siteCall(name,args,{sessionTag=null,setupPrincipal,connectionPrincipal,requestId,identity=null}={}){
  if(typeof setupPrincipal!=='string'||!setupPrincipal.startsWith('site-b:authenticated:')||typeof connectionPrincipal!=='string'||!connectionPrincipal)
   fail('B_DEVICE_UNVERIFIED','设备工作项的身份或绑定未通过验证。');
  const body={jsonrpc:'2.0',id:'site-'+(typeof requestId==='string'?requestId:crypto.randomUUID()),method:'tools/call',
   params:{name,arguments:args,...(typeof sessionTag==='string'&&sessionTag?{_meta:{'openai/session':sessionTag}}:{})}};
  const response=await this.rpc(body,'chatgpt',{transport:'site_b',setupPrincipal,connectionPrincipal,[AUTO_TASK_IDENTITY]:identity});
  const r=response?.result;
  if(!r||typeof r!=='object')return {failed:true,value:{error:{code:'B_SITE_CALL_NO_RESULT'},executed:false}};
  const sc=r.structuredContent&&typeof r.structuredContent==='object'?r.structuredContent:{};
  if(r.isError===true){const {chathand_note,...error}=sc;return {failed:true,value:{error,executed:false,...(chathand_note?{chathand_note}:{})}};}
  let value=sc;
  const image=Array.isArray(r.content)?r.content.find(x=>x?.type==='image'&&typeof x.data==='string'):null;
  if(image)value=sc.observation&&typeof sc.observation==='object'?{...sc,observation:{...sc.observation,image_base64:image.data}}:{...sc,image_base64:image.data,...(image.mimeType?{mimeType:image.mimeType}:{})};
  if(r._meta&&typeof r._meta==='object')value={...value,_card_meta:r._meta};
  return {failed:false,value};
 }
 // Never exempt a tools/call based on its public tool name or from_card.
 // A successful preflight must prove the in-memory card capability before any
 // dispatch, without consuming it or trusting client source/role strings.
 relayObserverFailure(ctx){
  const now=Date.now();this.relayFailures=[...(this.relayFailures||[]).filter(at=>now-at<600000),now];
  this.events?.record('relay.disable',{code:'RELAY_OBSERVER_ERROR'});
  try{this.relayKeeper?.cancelContext(ctx,'disabled');}catch{}
  if(this.relayFailures.length>=3&&this.relayKeeper){this.relayKeeper.circuitOpen=true;this.relayKeeper.installationEligible=false;}
 }
 taskWaitState(id){
  const t=this.policy.tasks.get(id);if(!t)return null;
  return taskWaitState({task:this.policy.view(t),jobs:[...this.queue.jobs.values()].map(j=>({job_id:j.id,status:j.status,process_alive:!!j.child||j.process_alive===true,cleanup_pending:!!j.cleanupPending||j.cleanup_pending===true})),confirmations:this.confirmations?.forTask(id)||[],checkpoint:{waiting_user_active:this.resume.waitingForUser(id),last_checkpoint:this.resume.tasks.get(id)?.checkpoints.at(-1),blocker:this.resume.blocker(this.resume.tasks.get(id))},artifactBusy:!!this.artifacts?.busy(id),inputs:[...this.queue.inputs.values()]});
 }
 privateTaskView(t){
  const task=this.policy.view(t),progress=this.resume.view(task,{record:false});
  return cardTaskView({...task,...progress,wait_state:taskWaitState({task,jobs:this.queue.list(),confirmations:this.confirmations?.forTask(task.task_id)||[],checkpoint:progress,artifactBusy:!!this.artifacts?.busy(task.task_id),inputs:[...(this.queue.inputs?.values()||[])]})});
 }
 interruptionMetadata(task_id,caller,context,{snapshot,observerRevision,ignoreInflight=false}={}){
  const session_hash=sessionHashOf(context.setupPrincipal,context.session),relayMode=context.relayMode,cardDomain=context.cardDomain;
  if(relayMode!=='mcp_app'||!session_hash||!this.relayKeeper)return null;
  const t=this.policy.get(task_id,caller);if(t.status!=='active'||t.session_hash!==session_hash)return null;
  const observed=snapshot===undefined?this.resume.stallSnapshot(this.policy.view(t)):snapshot;
  if(!observed?.stalled||!this.relayKeeper.canInterrupt(task_id,{caller,session_hash,transport:relayMode},{ignoreInflight}))return null;
  try{const token=this.h8Cards.relayInterruptionToken(task_id,caller,session_hash,cardDomain,observed,observerRevision);
   return token?{'chathand/relay_interruption_token':token}:null;
  }catch{return null;}
 }
 verifiedPrivateCard(body,caller,context){
  if(!body||body.method!=='tools/call'||!body.params)return false;
  const name=body.params.name,args=body.params.arguments||{},cardContext=callContext(context,body);
  if(!privateCardTool(name))return false;
  // Even a valid token cannot exempt a malformed or source-spoofing payload.
  // This is the ordinary schema validator without any permission side effects.
  try{validatePrivateArgs(name,args);}catch{return false;}
  if(name==='chathand_host_flow_commit')return cardContext.transportSource==='site_b'&&context.hostReceipt?.prove?.(args.capability)===true;
  const hash=sessionHashOf(context.setupPrincipal,body.params?._meta?.['openai/session']);
  if(!hash)return false;
  const transport=cardContext.cardDomain;
  if(name==='card_answer'){
   if(this.h8Cards?.proveConsumedCard(args.nonce,caller,hash,transport)===true)return true;
   if(args.choice==='status'&&this.h8Cards?.provePermissionStatus(args.nonce,caller,hash,transport)===true)return true;
   const token=this.h8Cards?.tokens.get(crypto.createHash('sha256').update(args.nonce||'').digest('hex'));
   if(!this.cardTaskContext(token&&this.policy.tasks.get(token.task_id),caller,cardContext))return false;
   return (args.choice==='status'&&this.h8Cards?.provePermissionStatus(args.nonce,caller,hash,transport)===true)||this.h8Cards?.provePrivateNonce(args.nonce,caller,hash,transport)===true;
  }
  if(name!=='relay_card_control'||cardContext.relayMode!=='mcp_app'||!this.cardTaskContext(this.policy.tasks.get(args.task_id),caller,cardContext))return false;
  if(args.action==='interruption')
   return this.h8Cards?.provePrivateNonce(args.interruption_token,caller,hash,transport,'relay-interruption:'+args.task_id)===true||this.h8Cards?.proveConsumedRelayInterruption(args.interruption_token,args.task_id,caller,hash,transport)===true;
  return this.relayKeeper?.provePrivateCapability(args,{caller,session_hash:hash,transport:cardContext.relayMode})===true;
 }
 async rpc(body,caller='chatgpt',context={}){
  // Old widgets may arrive after upgrade: discard their private inputs before any observer.
  if(body&&body.jsonrpc==='2.0'&&!Array.isArray(body)&&body.method==='tools/call'&&RETIRED_CARD_TOOLS.has(body.params?.name))body={jsonrpc:'2.0',...(Object.hasOwn(body,'id')?{id:body.id}:{}),method:'tools/call',params:{name:body.params.name,arguments:{},...(body.params?._meta?.['io.modelcontextprotocol/protocolVersion']==='2026-07-28'?{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}}:{})}};
  // Model execution calls, including failures, revoke the candidate BEFORE
  // dispatch. Scoped file presentation does not advance execution activity.
  // Private widget actions are exclusively mediated by a capability and are not model calls.
  const isToolCall=body?.method==='tools/call';
  const presentsFile=isToolCall&&presentationReveal(body?.params?.name,body?.params?.arguments);
  const toolName=isToolCall?body?.params?.name:null;
  const privateCard=this.verifiedPrivateCard(body,caller,context);
  // First externally received tool call in this backend process, not proof of host delivery.
  let onboardingEnd=null;
  if(isToolCall&&!privateCard&&!this.onboardingFirstCallSeen){this.onboardingFirstCallSeen=true;onboardingEnd=new OnboardingTelemetry(this.events).begin('first_tool_call',{actor:'unknown',source:'mcp'});}
  // 1052 D1: an unselected route gets only the lightweight notice. Decide it
  // before any observer (relay candidate, resume, confirmations, task expiry).
  const refusal=isToolCall&&!privateCard?Tools.prototype.routeRefusal.call(this,callContext(context,body).transportSource,toolName):null;
  const observerRevision=isToolCall&&!privateCard&&!presentsFile&&!refusal?this.h8Cards?.noteOrdinary(caller,sessionHashOf(context.setupPrincipal,body.params?._meta?.['openai/session'])):null;
  let relayCallKey=null;
  if(isToolCall&&!privateCard&&!presentsFile&&!refusal&&this.relayKeeper){
   const session_hash=sessionHashOf(context.setupPrincipal,body.params?._meta?.['openai/session']);
   const claimed=typeof body.params?.arguments?.task_id==='string'?body.params.arguments.task_id:null;
   const task=claimed&&!(toolName==='relay_card_control'&&!privateCard)?this.policy.tasks.get(claimed):null;
   // A task from another project must not count as this caller's resumption.
   // The task itself remains available by ID across conversations.
   const task_id=task&&task.caller===caller&&task.session_hash===session_hash&&task.project_id===this.policy.state.data.active?claimed:null;
   try{relayCallKey=this.relayKeeper.noteToolStart({task_id,call_id:crypto.randomUUID()},{caller,session_hash,transport:callContext(context,body).relayMode}).call_key;}
   catch{this.relayObserverFailure({caller,session_hash,transport:callContext(context,body).relayMode});}
  }
  let traceId=null;
  try{
   const observer=artifactObserverBody(cardObserverBody(body));
   traceId=this.trace?.receiveRPC(observer,caller,{...context,traceMetadata:{task_id:body?.params?.arguments?.task_id,card:privateCard||toolName==='task_status'&&body?.params?.arguments?.from_card===true,wait_ms:toolName==='command_result'?body?.params?.arguments?.wait_ms:undefined,brief:toolName==='command_result'?body?.params?.arguments?.brief:undefined}});
   const result=await this.rpcInternal(body,caller,{...context,[VERIFIED_PRIVATE_CARD]:privateCard,[ROUTE_REFUSAL]:refusal,[OBSERVER_REVISION]:observerRevision});
   if(result?.error||result?.result?.isError){const failure=onboardingFailure(result?.error||result?.result?.structuredContent);onboardingEnd?.(failure.result,failure.error_code);}else onboardingEnd?.('ok','NONE');
   if(isToolCall&&!privateCard&&!presentsFile&&!refusal&&!result?.error&&result?.result&&result.result.isError!==true&&toolDefinition(toolName))try{this.onOrdinaryCallSuccess?.({name:toolName,caller,context,at:Date.now()});}catch{/* Observation never changes the original result. */}
   if(isToolCall&&!privateCard&&!refusal&&!result?.error&&result?.result&&result.result.isError!==true&&toolDefinition(toolName))try{await this.appendOrdinaryResultNotice?.({result,name:toolName,args:body.params?.arguments,caller,context});}catch{/* A notice never breaks the completed tool result. */}
   const sc=result?.result?.structuredContent;const code=sc?.code||result?.error?.code;if(['TASK_LIMIT','QUEUE_FULL','QUEUE_FULL_INPUTS','COMMAND_LIMIT','PENDING_30','JOB_BUSY','SEARCH_LIMIT'].includes(code))this.events?.record('cap',{code,n:code==='TASK_LIMIT'?[...this.policy.tasks.values()].filter(t=>['active','pending_approval'].includes(t.status)).length:code==='SEARCH_LIMIT'?[...(this.features?.search?.jobs?.values()||[])].filter(j=>j.status==='running').length:undefined});
   if(toolName==='relay_card_control'&&(body.params?.arguments?.action!=='view'||sc?.reason==='superseded'||sc?.code==='RELAY_CARD_SUPERSEDED'))this.events?.record('relay.ctl',{task:body.params?.arguments?.task_id,action:body.params?.arguments?.action,mode:body.params?.arguments?.mode,granted:sc?.granted,reason:sc?.code==='RELAY_CARD_SUPERSEDED'?'superseded':sc?.reason,outcome:sc?.outcome});
   if(traceId)this.trace.handled(traceId,result?.result?{...result,result:observableToolResult(result.result)}:result,measureResponseLength(result));
   return result;
  }catch(e){const failure=onboardingFailure(e);onboardingEnd?.(failure.result,failure.error_code);if(traceId)this.trace.handlerException(traceId,e);throw e;}
  finally{if(relayCallKey)try{this.relayKeeper?.noteToolEnd({call_key:relayCallKey});}catch{this.relayObserverFailure({caller,session_hash:sessionHashOf(context.setupPrincipal,body.params?._meta?.['openai/session']),transport:callContext(context,body).relayMode});}}
 }
 async rpcInternal(body,caller='chatgpt',context={}){
  if(!body||body.jsonrpc!=='2.0'||Array.isArray(body))return {jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}};
  if(!Object.hasOwn(body,'id'))return null;
  const id=body.id;if(!(typeof id==='string'||Number.isSafeInteger(id)))return {jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid id'}};
  const modern=body.params?._meta?.['io.modelcontextprotocol/protocolVersion']==='2026-07-28';
  const serverInfo=protocolVersion=>{const icons=protocolIcons(protocolVersion);return {name:'chathand',version:VERSION,...(icons.length?{icons}:{})};};
  // Advertise icons during negotiation/discovery, not on every tool result.
  // Site registers this same compact identity for its repeated envelopes.
  const envelopeInfo=serverInfo(body.method==='server/discover'?'2026-07-28':null);
  const ok=(raw,responseId=id)=>{const result=withCacheHints(body.method,raw);return {jsonrpc:'2.0',id:responseId,result:modern?{...result,resultType:'complete',_meta:{...(result._meta||{}),'io.modelcontextprotocol/serverInfo':envelopeInfo}}:result};};
  const instructions=CHATHAND_CONTEXT+' '+WORKFLOW_INSTRUCTIONS+' '+COMPUTER_INSTRUCTIONS;
  if(body.method==='initialize'){const protocolVersion=['2025-11-25','2025-06-18','2025-03-26','2024-11-05'].includes(body.params?.protocolVersion)?body.params.protocolVersion:'2025-11-25';return ok({protocolVersion,capabilities:{tools:toolListCapabilities(),resources:{subscribe:false,listChanged:false}},serverInfo:serverInfo(protocolVersion),instructions});}
  if(body.method==='server/discover')return ok({supportedVersions:['2026-07-28','2025-11-25','2025-06-18'],capabilities:{tools:toolListCapabilities(),resources:{}},instructions});
  if(body.method==='ping')return ok({});if(body.method==='tools/list'){
   const at=Date.now();this.toolsListSeen=[...(this.toolsListSeen||[]),at].slice(-20);
   // 1081：ChatGPT 经 OpenAI 通道来拿过工具清单，向导「加到 ChatGPT」那一页靠这个自己往下走。Site 来的不算。
   {const src=callContext(context,body).transportSource;if(src==='relay'||src==='local_http'&&caller==='chatgpt')this.openaiToolsListAt=at;}
   // Only the authenticated server route can issue a correlation event; body.params/_meta is never trusted for this.
   const verified=this.refreshListContext?.(caller,context);
   if(verified?.source==='trusted_server'&&verified.authenticated===true){
    try{this.onAuthenticatedToolsList?.({...verified,at,schema_sha256:manifest(TOOLS).schema_sha256});}catch{}
    this.toolsListEvents=[...(this.toolsListEvents||[]),{kind:'tools_list',at,...verified}].slice(-40);}
   return ok({tools:TOOLS});
  }
  if(body.method==='resources/list')return ok(this.features.resources());
  if(body.method==='resources/read'){try{return ok(this.features.resource(body.params?.uri));}catch(e){if(e.code!=='RESOURCE_MISSING')throw e;return {jsonrpc:'2.0',id,error:{code:-32002,message:e.message,data:{code:'RESOURCE_MISSING'}}};}}
  if(body.method==='tools/call'){
   const name=body.params?.name,desktop=typeof name==='string'&&(name.startsWith('computer_')||name==='desktop_action'&&body.params?.arguments?.action==='open_path');
   if(RETIRED_CARD_TOOLS.has(name))return ok({...toolResult({code:'TOOL_UNKNOWN',message:'探针工具已退出，请用 ChatHand 窗口或 Mac 通知授权。'}),isError:true});
   const fromCardEarly=context[VERIFIED_PRIVATE_CARD]===true;
   const ctx=callContext(context,body,{invocationClass:fromCardEarly?'private_card':'ordinary'});
   {const refused=Object.hasOwn(context,ROUTE_REFUSAL)?context[ROUTE_REFUSAL]:fromCardEarly?null:Tools.prototype.routeRefusal.call(this,ctx.transportSource,name);
    if(refused)return ok(toolResult(refused));}
   let response,note=null,forecast=null,confirmationNote=null,refreshNote=null,completionNote=null,completionHash=null;
   let observerAuthorized=true,stallWitness=null;
   const fromCard=context[VERIFIED_PRIVATE_CARD]===true,presentsFile=presentationReveal(name,body.params?.arguments);
   try{
    const args=body.params?.arguments??{},hash=sessionHashOf(context.setupPrincipal,body.params?._meta?.['openai/session']),observedArgs={...artifactObserverArgs(args,name)};
    if(name==='command_result'&&args.full===true&&typeof id==='string'&&id.length>256)
      fail('OUTPUT_SPOOL_ENVELOPE_BUDGET','这次请求编号超过全文分页支持范围（256字符）；按恢复指引读取，不要重新执行命令。');
    if(name==='command_result'&&this.policy.jobOwners.has(args.job_id)){const id=this.policy.jobOwners.get(args.job_id);try{this.policy.getBound(id,caller,hash,ctx.connectionPrincipal);observedArgs.task_id=id;}catch(e){observerAuthorized=false;throw e;}}
    completionHash=hash;
    // Option answers consume their capability and intentionally return no task
    // identifier. Retain the proven exact target for private card enrichment.
    // Legacy permission-status tokens remain confirmation-only observations.
    const privateToken=fromCard&&name==='card_answer'?this.h8Cards.tokens.get(crypto.createHash('sha256').update(args.nonce).digest('hex')):null;
    const privateOptionTaskId=privateToken?.request.startsWith('option:')?privateToken.task_id:null;
    // R2-1: a private relay call without a proven capability must stop here.
    // Never let it reach invoke(), whose pending-confirmation gate can match
    // another session by task_id and disclose its confirm id/item in details.
    // Schema validation is pure; retain the existing ARG_INVALID response for
    // malformed input. The outer rpc() has already revoked the model session's
    // candidate, and its finally still clears the active_call.
    if(['relay_card_control','chathand_host_flow_commit'].includes(name)&&!fromCard){
      observerAuthorized=false;
      validatePrivateArgs(name,args);
      fail(name==='chathand_host_flow_commit'?'B_HOST_CAP_UNVERIFIED':'RELAY_CARD_INVALID','私有卡片凭据无效或已失效。');
    }
    // This check must precede ResumeKeeper.before, feature reads and all
    // changes to checkpoint, activity, card nonces or task expiry.
    if(!toolDefinition(name)||(privateCardTool(name)&&!fromCard))
      observerAuthorized=false;
    const autoCandidate=this.autoTasks?.needsTask(name,args)&&!(name==='desktop_action'&&args.action==='reveal')&&!this.autoTasks.live(args.task_id);
    if(autoCandidate)observerAuthorized=false;
    if(observerAuthorized&&!fromCard&&!presentsFile&&typeof args?.task_id==='string'){
      try{this.policy.getBound(args.task_id,caller,hash,ctx.connectionPrincipal);}catch(e){observerAuthorized=false;throw e;}
    }else if(observerAuthorized&&!fromCard&&!presentsFile&&args&&Object.hasOwn(args,'task_id')){
      observerAuthorized=false; // Unusable task identifier cannot name an observer target.
    }
    if(observerAuthorized&&!fromCard&&!presentsFile&&name==='task_status'&&args.from_card===true){const snap=this.resume?.stallSnapshot(this.policy.view(this.policy.get(args.task_id,caller)));if(snap?.stalled)stallWitness={...snap,observed_at:this.h8Cards.now()};}
    if(observerAuthorized&&!fromCard&&!presentsFile)try{note=this.resume?.before(hash,name,observedArgs);}catch{note=null;}
    if(observerAuthorized&&!fromCard&&!presentsFile)confirmationNote=mergeNotes(this.confirmations?.takeNote(hash)||null,this.confirmations?.unpresentedNote(hash));
    if(observerAuthorized&&!fromCard&&!presentsFile)try{refreshNote=this.toolsRefreshNote(hash,name);}catch{refreshNote=null;}
    // Keep page planning independent of each request id. The approved 256
    // UTF-16-unit range reserves the worst JSON escape for every unit; actual
    // responses still echo the complete original id and are checked below.
    let result;try{result=await this.invoke(name,args,caller,{session:body.params?._meta?.['openai/session'],setupPrincipal:context.setupPrincipal,transport:ctx.legacyTransport,transportSource:ctx.transportSource,connectionPrincipal:ctx.connectionPrincipal,mcpProtocolVersion:ctx.mcpProtocolVersion,cardDomain:ctx.cardDomain,relayMode:ctx.relayMode,invocationClass:ctx.invocationClass,hostProbe:context.hostProbe,hostReceipt:context.hostReceipt,stallWitness,observerRevision:context[OBSERVER_REVISION],signal:context.signal,[AUTO_TASK_IDENTITY]:context[AUTO_TASK_IDENTITY],fullEnvelopeSize:page=>JSON.stringify(ok(toolResult({...page,notes_deferred:true}),'\x00'.repeat(256))).length});}catch(e){if(observerAuthorized&&!fromCard&&!presentsFile)try{this.resume?.after(hash,name,observedArgs,null,true);}catch{}if(note)this.resume?.carry(hash,note);throw e;}
    result=this.attachTaskCard(result,name,args,caller,{...context,...ctx,privateOptionTaskId});
    const card=splitCardResult(result);if(desktop&&card.meta!==undefined)fail('CARD_META_DESKTOP_UNSUPPORTED','程序错误：桌面工具不能返回卡片专用元数据。');result=card.value;
    if(result&&typeof result==='object'&&!Array.isArray(result)&&toolDefinition(name)?._meta?.ui?.resourceUri)result={...result,widget_shell:widgetShellPresentation(name,result,body.params?._meta?.['openai/locale'])};
    if(observerAuthorized&&!fromCard&&!presentsFile)try{completionNote=this.commandNotes?.collect(hash,caller,name,observedArgs,result)||null;}catch{}
    if(name==='browser_status'&&result?.task_id&&this.policy.tasks.get(result.task_id)?.internal_source==='read_task')observedArgs.task_id=result.task_id;
    if(observerAuthorized&&!fromCard&&!presentsFile)try{forecast=this.resume?.after(hash,name,observedArgs,result,false);}catch{forecast=null;}
    if(observerAuthorized&&!fromCard&&!presentsFile&&!note)note=this.resume?.takeCarried(hash)||null;
    note=mergeNotes(result?.chathand_note,note,confirmationNote,refreshNote,completionNote,presentsFile?null:this.resume?.takeBlockNote(hash));
    if(result&&typeof result==='object'&&!Array.isArray(result)&&(note||forecast))result={...result,...(note?{chathand_note:note}:{}),...(forecast?{chathand_forecast:forecast}:{})};
    if(!desktop&&card.meta===undefined){result=compactToolReturn(result,{store:this.store,tool:name,args});if(result?.output_summary)this.events?.record('return.paged',{tool:name,n:Object.values(result.output_summary.omitted_items||{}).reduce((a,b)=>a+b,0),chars:result.output_summary.original_chars,saved:result.output_summary.saved===true});}
    if(desktop&&result?.observation?.image_base64){const {image_base64,...observation}=result.observation,metadata={...result,observation};response=ok({content:[{type:'text',text:JSON.stringify(metadata)},{type:'image',mimeType:observation.mimeType||'image/jpeg',data:image_base64}],structuredContent:metadata,isError:false});}
    else response=ok(toolResult(card.meta===undefined?result:{...result,_card_meta:card.meta}));
    if(name==='command_result'&&args.full===true&&JSON.stringify(response).length>12000){
      // Defer incidental coaching, never trim a page or change its cursor.
      if(note)this.resume?.carry(hash,note);
      const {chathand_note,chathand_forecast,...page}=result;
      response=ok(toolResult({...page,notes_deferred:true}));
      if(JSON.stringify(response).length>12000)fail('OUTPUT_SPOOL_ENVELOPE_BUDGET','全文页面超出返回预算；页面仍保留，请勿重新执行命令。');
    }
   }catch(e){
    const recovery=errorRecovery(e.code);
    if(observerAuthorized&&!completionNote&&!fromCard&&!presentsFile)try{completionNote=this.commandNotes?.collect(completionHash,caller,name,artifactObserverArgs(body.params?.arguments??{},name),null,{failed:true})||null;}catch{}
    const finalNote=mergeNotes(note,confirmationNote,refreshNote,completionNote);const err={...cleanError(e),...(e.auto_task?{...e.auto_task}:{}),recovery,...(finalNote?{chathand_note:finalNote}:{})};
    try{this.store.audit({event:'tool_error',tool:name,code:err.code});}catch{}
    response=ok({content:[{type:'text',text:JSON.stringify(err)}],structuredContent:err,isError:true});
   }
   try{if(observerAuthorized)this.valueStats?.enqueue({name,args:artifactObserverBody(cardObserverBody(body)).params?.arguments??{},result:['relay_card_control','chathand_host_flow_commit'].includes(name)?{content:[],structuredContent:{private_card:true,isError:response.result?.isError===true}}:observableToolResult(response.result),session:privateCardTool(name)?sessionHashOf(context.setupPrincipal,body.params?._meta?.['openai/session']):body.params?._meta?.['openai/session'],caller,metaKeys:privateCardTool(name)?Object.keys(cardObserverBody(body).params?._meta||{}):Object.keys(body.params?._meta||{}),headerNames:context.headerNames||[]});}catch{/* Counting is deferred and cannot change either response path. */}
   return response;
  }
  return {jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}};
 }
}
