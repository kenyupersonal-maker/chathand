import {readChromeDistribution,requireLegacyInstaller,requireStoreConfiguration,storeMode} from './v1/chrome-distribution.mjs';
import {chromeStoreProfiles} from './v1/chrome-store-profiles.mjs';
import {NetworkChallengeNotice,networkSetupHandoff,prepareNetworkSetupHandoff} from './v1/network-challenge-notice.mjs';
import {canonicalChatGPTAppId,sameChatGPTAppId,sameChatGPTAppDetailURL} from './v1/chatgpt-app-identity.mjs';
import {ReadTaskTracker} from './v1/read-task-tracker.mjs';
import {SetupFacts} from './v1/setup-facts.mjs';
import {ChatGPTAppRoutes} from './v1/chatgpt-app-routes.mjs';
import {SetupActivity} from './v1/setup-activity.mjs';
import {resourceDiagnostic} from './v1/resource-diagnostics.mjs';
import {messageMetadata} from './v1/message-metadata.mjs';
import {readConnectionTimeline,readResourceTimeline,readNativeTimeline} from './diagnostic-events.mjs';
import {siteCreationHandoff,siteAssistedSentence,siteTemplateFileFollowup} from '../ui/h10/prompts.mjs';
import {installCatalogs as setPromptLocale} from '../ui/local-text.mjs';
import {rehearsalUpgradeHome} from './v1/rehearsal-upgrade-paths.mjs';
import {setupRouteSelection} from './v1/setup-route-selection.mjs';
import {createSiteNetworkCheck} from './v1/site-network-check.mjs';
import {DeadlineScheduler} from './v1/deadline-scheduler.mjs';
import {t as displayText} from './i18n.mjs';
import {localText,systemLocale} from './i18n.mjs';
import {cleanupCommandOutput} from '../engine/src/full-output-spool.mjs';
import {jobRunning} from './v1/command-brief.mjs';
import {siteLinkFailure} from './v1/site-link-health.mjs';
import {siteConnectionStages} from './v1/site-connection-stages.mjs';
import {assertDesktopDataCompatibility} from './v1/data-compatibility.mjs';
import {OwnedJobCleanupEvidence} from './v1/permission-cleanup-evidence.mjs';
import {PermissionRevocations} from './v1/permission-revocation.mjs';
import {PermissionHistory,bindPermissionHistory} from './v1/permission-history.mjs';
import {installQueuePermissionFence} from './v1/queue-permission-fence.mjs';
import {BSiteLocalStore} from './v1/b-site-store.mjs';
import {BSitePairing} from './v1/b-site-pairing.mjs';
import {BSiteDispatch} from './v1/b-site-dispatch.mjs';
import {BSiteWsTransport} from './v1/b-site-ws-transport.mjs';
import {AUTO_TASK_IDENTITY} from './v1/auto-task-execution.mjs';
import {currentSiteExecution,runSiteExecution,runManualSiteApproval} from './v1/site-execution-context.mjs';
import {LEGACY_TASK_URI} from './v06/features.mjs';
import {LEGACY_IMAGE_BATCH_URI} from './v1/image-batch.mjs';
import {SITE_WIDGET_ALIASES} from './v1/widget-resource-aliases.mjs';
import {BSiteHostProbes} from './v1/b-site-host-probes.mjs';
import {bundledSiteTarget,pairedSiteTarget} from './v1/b-site-trust.mjs';
import {readPinnedSiteTemplate} from './v1/site-template-pin.mjs';
import {NativeOwnerProofVerifier} from './v1/native-owner-proof.mjs';
import {readNativeBootstrap} from './v1/native-bootstrap-keys.mjs';
import {watchNativeOwnerPipe} from './v1/process-owner-lifetime.mjs';
import {publishHelper,helperFolder} from './v1/chrome-helper-source.mjs';
import {ChromeInstallProbe} from './v1/chrome-install-probe.mjs';
import {managementHTTPError} from './v1/management-errors.mjs';
import {createStateEvents,createCachedStateSource,memoryActivity} from './v1/events.mjs';
import {projectNativeState} from './v1/native-state.mjs';
import {createSkillWatch} from './v1/skill-watch.mjs';
import {initializeValueSettings,validateValueSettings,VALUE_SETTINGS} from './v1/value-stats.mjs';
import {PlanProbe,PROBE_INTERVAL_MS} from './v1/plan-probe.mjs';
import {Repair,ensureBrowserHost} from './v1/repair.mjs';
import {ToolListProof} from './v1/tool-list-proof.mjs';
import {setupHandoff} from './v1/setup-handoff.mjs';
import {aiBrief} from './v1/ai-brief.mjs';
import {lastOutputLine} from './v1/job-line.mjs';
import {refreshStartupIcon} from './v1/startup-icon.mjs';
import {connectionStartupCode,readOnboardingEvents,readChromeInstallEvents} from './diagnostic-events.mjs';
import {OnboardingTelemetry,onboardingFields} from './onboarding-telemetry.mjs';
import {Updater,currentApplicationPath} from './v1/update.mjs';import {ToolsRefresher,PLUGINS_URL,STEP_WORDS} from './v1/tools-refresh.mjs';import {MatterStore} from './v1/matters.mjs';
import {undoTask} from './v1/undo.mjs';
import {initializeClientSettings,clientSettings,validateClientSettings,skinFile,computerName,macModel,KeyWatchBroker,clientNeedsInterface,KEY_PATTERN,automaticUpdatesAllowed,updateWorkPending,assertTemporaryUpdatePaths} from './v1/client-features.mjs';
import {spawn,execFileSync} from 'node:child_process';
import {setupSkillStatus,removeSetupSkill} from './v1/setup-skill-status.mjs';
import {buildInfo,bundledTunnelVersion,exportDiagnostic,recentErrors,recentErrorCodes,shouldKeepAwake} from './v1/support.mjs';
import {CloudProbe} from './v1/cloud-probe.mjs';
import {connectionDisplay} from './v1/connection-display.mjs';
import {isDeepStrictEqual} from 'node:util';
import {ConnectionController,SiteConnectionTelemetry} from './connection.mjs';
import {ConnectionGrace} from './v1/connection-grace.mjs';
import {dataDirectory} from './v07/paths.mjs';
import {createDefaultAdminAccess} from './v1/admin-command.mjs';
import {UpgradeGuard} from './v08/upgrade-guard.mjs';
import {bindActivity,platformCapabilities,setupSummary} from './v09/product-model.mjs';
import {validateSetup,registerBrowserHost,browserHostBinary,installSkill,findTunnelBinary} from './v09/local-setup.mjs';
import {CredentialStore} from './credentials.mjs';
import {RelayClient} from './relay.mjs';
import {RelayKeeper} from './v1/relay-keeper.mjs';
import {InstallationPilot} from './v1/installation-pilot.mjs';
import {loadPublicInstallationId} from './v1/public-installation-id.mjs';
import {VERSION,RUNTIME_API,manifest,readiness} from './product.mjs';
import {TOOLS} from './tools.mjs';
import {CAPABILITIES,CAPABILITY_IDS,capabilityOn,HIGH_RISK,HIGH_RISK_IDS,normalizeSwitches,permissionsInfo,adminReadyFor,applyPermissionTier,setupOpenItems,markUISeen,withScopeNote,recordPermissionOrigin} from './v1/permissions.mjs';
import {warmFullEnvironment} from './v1/full-access.mjs';
import {currentSystemProxy} from '../engine/src/tunnel.mjs';
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';
import {ScopedStore as ProjectStore,AccessPolicy as TaskPolicy} from './v06/access.mjs';import {taskHistory} from './v06/changes.mjs';import {DesktopState} from './state.mjs';import {Tools} from './tools.mjs';
import {SandboxQueue as CommandQueue} from './v06/terminal.mjs';import {TunnelManager} from '../engine/src/tunnel.mjs';import {validateTransport,transportStatus} from '../engine/src/mcp.mjs';import {fail,cleanError,saveJSON,privateDir} from '../engine/src/core.mjs';
const pkg=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATIC_FILES=new Map([
 ['/', ['index.html','text/html; charset=utf-8']],
 ...['auth','app','wizard','skin','skin-switcher','tip-jar','stream','morph','local-text','local-text-catalogs'].map(name=>['/'+name+'.js',[name+'.js','text/javascript; charset=utf-8']]),
 ...['local-text','local-text-catalogs'].map(name=>['/'+name+'.mjs',[name+'.mjs','text/javascript; charset=utf-8']]),
 ...['style','wizard','skin-switcher','tip-jar'].map(name=>['/'+name+'.css',[name+'.css','text/css; charset=utf-8']]),
 ...['host','views','assets','prompts','manual-site'].map(name=>['/h10/'+name+'.mjs',['h10/'+name+'.mjs','text/javascript; charset=utf-8']]),
 ['/h10/h10.css',['h10/h10.css','text/css; charset=utf-8']],
 ['/h10/host.css',['h10/host.css','text/css; charset=utf-8']],
 ['/skins/registry.js',['skins/registry.js','text/javascript; charset=utf-8']],
 ['/backdrops.js',['backdrops.js','text/javascript; charset=utf-8']],
 ['/backdrops/registry.js',['backdrops/registry.js','text/javascript; charset=utf-8']]
]);
// 打赏弹窗的收款方式放在官网仓库（GitHub Pages），只多放这一个地址可读；只读数据，不加载那边的脚本和页面（Claude 10/31）。
const STATIC_CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://kenyupersonal-maker.github.io; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";
// All recognised settings are checked before any assignment or permission side effect.
function validateSettingsBody(d){
 if(!d||typeof d!=='object'||Array.isArray(d))fail('ARG_INVALID','设置内容错误。');
 if(Object.hasOwn(d,'browser_control_opt_in'))fail('ARG_INVALID','设置内容错误。');
 const clientPatch=validateClientSettings(d),valuePatch=validateValueSettings(d);
 for(const [key,message] of [['keep_awake','保持唤醒选项错误。'],['auto_connect','自动连接选项错误。'],['notifications','通知选项错误。']])if(d[key]!==undefined&&typeof d[key]!=='boolean')fail('ARG_INVALID',message);
 if(d.last_seen_version!==undefined&&d.last_seen_version!==VERSION)fail('VERSION_INVALID','版本标记无效。');
 if(d.auto_approve_tasks!==undefined)fail('PERMISSION_MODEL_CHANGED','自动执行由两档权限统一管理。');
 if(d.browser!==undefined&&!['chrome','safari','default'].includes(d.browser))fail('ARG_INVALID','浏览器选项错误。');
 if(d.relay_pilot_enable!==undefined&&typeof d.relay_pilot_enable!=='boolean')fail('PILOT_SETTING_INVALID','本机试用选项无效。');
 if(Object.hasOwn(d,'pilot_installation_uuid')||Object.hasOwn(d,'installation_uuid'))fail('PILOT_IDENTITY_PROTECTED','客户端不能指定安装标识。');
 for(const id of CAPABILITY_IDS){const key=CAPABILITIES[id].key;if(d[key]!==undefined&&typeof d[key]!=='boolean')fail('ARG_INVALID',`「${CAPABILITIES[id].name}」开关需要布尔值。`);}
 if(d.high_risk!==undefined){if(!d.high_risk||typeof d.high_risk!=='object'||Array.isArray(d.high_risk))fail('ARG_INVALID','高危命令设置错误。');for(const [id,value] of Object.entries(d.high_risk)){if(!HIGH_RISK_IDS.includes(id))fail('ARG_INVALID','没有这一项高危命令。');if(typeof value!=='boolean')fail('ARG_INVALID','高危命令开关需要布尔值。');}}
 return {clientPatch,valuePatch};
}
// Defaults and tier setup can set browser_enabled automatically. Only an
// explicit browser setting/installation is evidence for touching Chrome files.
export function browserControlOptedIn(data={}){
 const origin=data.permission_origins?.['capability:browser'];
 return data.browser_enabled===true&&(data.browser_control_opt_in===true||origin?.via==='settings'&&Number.isFinite(origin.since)&&origin.since>0);
}
export const defaultState=()=>{const override=process.env.CHATHAND_STATE_DIR||process.env.KEN_BRIDGE_STATE_DIR;if(!override&&(process.env.CHATHAND_REHEARSAL_ROOT||process.env.CHATHAND_REHEARSAL_HOME))throw Object.assign(Error('REHEARSAL_UPGRADE_PATH_INVALID'),{code:'REHEARSAL_UPGRADE_PATH_INVALID'});return override||dataDirectory();};
const eq=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
function send(res,code,data,type='application/json; charset=utf-8'){res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(typeof data==='string'||Buffer.isBuffer(data)?data:JSON.stringify(data));}
async function json(req){let n=0,c=[];for await(const b of req){n+=b.length;if(n>6*1024*1024)fail('BODY_TOO_LARGE','请求过大。');c.push(b);}try{return JSON.parse(Buffer.concat(c));}catch{fail('JSON_INVALID','JSON 格式不正确。');}}
function listen(s){return new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',()=>r(s.address().port));});}
// Changes that widen what the AI may do are accepted only from the ChatHand window itself ("界面凭据").
// The native app passes a fresh key to this process through stdin and into the page; it is never written to disk,
// so commands that can read runtime.json still cannot switch these on. Missing window credentials fail closed.
const UI_ONLY=new Set(['/api/browser/extension/store/cancel','/api/network-challenge/notification/ack','/api/onboarding/event','/api/artifacts/thumbnail','/api/artifacts/authorize-open','/api/browser/extension/install/evidence','/api/browser/extension/install/progress','/api/browser/extension/install/profiles','/api/browser/extension/install/start','/api/browser/extension/install/status','/api/browser/extension/install/verify','/api/browser/extension/install/finish','/api/browser/extension/install/cancel','/api/permissions/revoke','/api/permissions/undo-info','/api/permissions/undo','/api/checkpoint/action','/api/confirm/answer','/api/task/undo','/api/mode','/api/projects/add','/api/projects/select','/api/jobs/approve','/api/inputs/approve','/api/tasks/approve','/api/actions/approve','/api/update/install','/api/permissions/tier','/api/ui/seen','/api/value/reset','/api/setup/workspace','/api/setup/progress','/api/events','/api/browser/extension/stop','/api/browser/extension/reconnect','/api/refresh/return-existing-tab','/api/matters/write','/api/matters/selection','/api/matters/purge']);
const UI_ONLY_SETTINGS=['terminal_enabled','browser_enabled','desktop_enabled','high_risk','relay_pilot_enable'];
for(const route of ['/api/connection/use','/api/connection/remove'])UI_ONLY.add(route);
const SITE_UI_ONLY=new Set(['/api/site-b/paired-notice/dismiss']);
export function needsInterface(route,d){if(clientNeedsInterface(route,d))return true;if(UI_ONLY.has(route)||SITE_UI_ONLY.has(route))return true;if(route==='/api/access'&&d?.enabled===true)return true;if(route==='/api/browser/extension/prepare'&&d?.retry_after_permission===true)return true;if(route==='/api/settings'&&d&&typeof d==='object'&&[...UI_ONLY_SETTINGS,...VALUE_SETTINGS].some(k=>d[k]!==undefined))return true;return false;}
export function interfaceAuthorized(route,d,provided,expected){return !needsInterface(route,d)||typeof expected==='string'&&expected.length>0&&eq(provided,expected);}
export async function createDesktop({stateDir=defaultState(),defaultRoot,lock=true,uiKey=null,nativeOwnerKey=null,ownerLifetime=null,adminAccess=null,clientDeps={}}={}){
 // Only explicit, isolated legacy tests can replace installer source files.
 if(clientDeps.legacyChromeInstallRoot!==undefined){
  if(!process.env.NODE_TEST_CONTEXT||clientDeps.chromeDistribution?.distribution!=='legacy_unpacked')throw Error('LEGACY_CHROME_TEST_ROOT_REQUIRED');
  assertTemporaryUpdatePaths(clientDeps.legacyChromeInstallRoot);
 }
 assertDesktopDataCompatibility(stateDir);
 if(process.env.NODE_TEST_CONTEXT||Object.keys(clientDeps).length)assertTemporaryUpdatePaths(stateDir,...(defaultRoot?[defaultRoot]:[]));
 if(clientDeps.nativeAuditRoot!==undefined)assertTemporaryUpdatePaths(clientDeps.nativeAuditRoot);
 const appPath=clientDeps.currentAppPath??(process.env.NODE_TEST_CONTEXT?null:currentApplicationPath());
 const rehearsalHome=rehearsalUpgradeHome({stateDir,appPath});
 const interfaceKey=typeof uiKey==='string'&&/^[a-f0-9]{32,128}$/.test(uiKey)?uiKey:null;const startedAt=Date.now();
 privateDir(stateDir);stateDir=fs.realpathSync(stateDir);const lockFile=path.join(stateDir,'app.lock');let lockOwned=false;
 if(lock){if(fs.existsSync(lockFile)){const prev=JSON.parse(fs.readFileSync(lockFile));let alive=true;try{process.kill(prev.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}if(alive)fail('ALREADY_RUNNING','ChatHand 已运行，请打开已有应用。');fs.unlinkSync(lockFile);}fs.writeFileSync(lockFile,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});lockOwned=true;}
 let state,store;try{state=new DesktopState(stateDir,{defaultRoot});store=new ProjectStore(state.project().path,stateDir);}catch(e){if(lockOwned)fs.unlinkSync(lockFile);throw e;}
 const isolated=!!process.env.NODE_TEST_CONTEXT||!!clientDeps.tunnelFactory||!!clientDeps.updaterFactory||stateDir!==path.resolve(dataDirectory());
 if(clientDeps.tunnelFactory||clientDeps.updaterFactory||clientDeps.credentials)assertTemporaryUpdatePaths(stateDir,state.project().path,...(appPath?[appPath]:[]));
 initializeClientSettings(state);initializeValueSettings(state);const keyWatch=new KeyWatchBroker({now:clientDeps.now||Date.now});
 let executionResumeAllowed=state.data.access_enabled===true,accessPersistencePending=false;
 if(lockOwned)try{cleanupCommandOutput(path.join(stateDir,'command-output'));}catch{/* Output cleanup is isolated from startup and execution. */}
 const queue=new CommandQueue(store,{externalMaintenance:true});
 // Resolve admin effects before Tools/startup reconciliation can access the queue.
 // A supplied fake remains authoritative; otherwise isolated instances are inert.
 queue.adminAccess=adminAccess??createDefaultAdminAccess({stateDir,isolated});
 const policy=new TaskPolicy(state,store,queue),tools=new Tools(state,store,queue,policy);
 const onboarding=new OnboardingTelemetry(tools.events);
 const startupClock=()=>maintenanceClock.now?.()??Date.now();
 const startupStage=(stage,outcome,at,code)=>tools.events?.record('conn.startup',{stage,outcome,ms:Math.max(0,startupClock()-at),source:'server',...(code?{code:connectionStartupCode(code)}:{})});
 // Local records are independent of execution authority. No connector owner is taken from model input.
 let matterStore=clientDeps.matterStore||null,matterUnavailableCode=null;
 if(!matterStore)try{matterStore=new MatterStore({stateDir});}
 catch(e){
  // An unprovable purge ledger or finish intent must not be reset, imported,
  // or replaced by a fresh empty matter store. Other App features stay up.
  if(!['MATTER_LEDGER_CORRUPT','MATTER_PENDING_UNPROVEN'].includes(e?.code))throw e;
  matterUnavailableCode=e.code;
 }
 tools.matterStore=matterStore;tools.matterUnavailableCode=matterUnavailableCode;
 policy.matterStore=matterStore;
 if(matterStore){await matterStore.recoverFinished(id=>policy.receipts?.read(id));await matterStore.recoverOrphaned(id=>['active','pending_approval'].includes(policy.tasks.get(id)?.status));} // only genuinely terminal receipts; never restores task grants
 const pilot=new InstallationPilot(stateDir);try{pilot.applyDefaultOnce();}catch(e){if(/^PILOT_IDENTITY_/.test(e.code||''))throw e;pilot.defaultApplyFailed=true;tools.events?.record('relay.disable',{code:'PILOT_DEFAULT_SAVE_FAILED'});}
 const relayKeeper=new RelayKeeper({events:tools.events,jobState:(id,taskId)=>{if(policy.jobOwners.get(id)!==taskId)return null;const j=queue.jobs.get(id);return j?{status:jobRunning(j)?'running':j.status,finished_at:j.finished_at,timeout_at:j.started_at?j.started_at+j.timeout_ms:null}:null;},notify:notice=>{const title=policy.tasks.get(notice.task_id)?.title||localText('notification.task.default');policy.emit('task_continuation',{task_id:notice.task_id,title,body:notice.kind==='block_limit'?localText('notification.task.blockLimit',{title}):notice.auto_enabled?localText('notification.task.autoContinue',{title}):localText('notification.task.manualContinue',{title})});},taskState:id=>policy.tasks.get(id)?.status??policy.receipts?.cachedStatus(id)??null,file:path.join(stateDir,'relay-1049.sqlite'),installationEligible:pilot.eligible(),readTask:(taskId,ctx)=>{
  const task=policy.get(taskId,ctx.caller);
  if(task.session_hash!==ctx.session_hash)throw Object.assign(Error('task session mismatch'),{code:'RELAY_CARD_INVALID'});
  const progress=tools.resume.tasks.get(taskId);
  const stalled=tools.resume.stallSnapshot(policy.view(task));
  const waiting=tools.resume.waitingJob(taskId),lastWait=tools.resume.tasks.get(taskId)?.waited_job;
  return {status:task.status,enabled:policy.enabled===true&&!policy.connectionUnavailable,stopped:task.status!=='active',paused:store.paused===true,session_hash:task.session_hash||null,epoch:policy.epoch,revision:policy.permissionRevision||0,checkpoint_seq:progress?.checkpoint_seq||0,manual_resume_allowed:stalled?.stalled===true,external_wait:tools.taskWaitState(taskId)?.kind==='external',auto_allowed:stalled?.basis==='data'&&tools.taskWaitState(taskId)?.kind!=='external',waiting_job:waiting||lastWait&&!lastWait.seen?waiting||lastWait:null};
 }});
 tools.relayKeeper=relayKeeper;policy.relayKeeper=relayKeeper;
 if(clientDeps.automationFactory)tools.automation=clientDeps.automationFactory(state,store,policy);
 // 管理员（sudo）：升级前管理员确实开着时，验证阶段不能误删系统 helper；提交后再按真实开关状态对齐。
 if(adminAccess)queue.adminAccess=adminAccess;adminAccess=queue.adminAccess;tools.blocks.adminAccess=adminAccess;
 const upgradeGuard=new UpgradeGuard(stateDir,VERSION);let exitRequested=false,startupReconciliationPending=true,startupReconciliationCode=null;Object.defineProperty(tools,'upgradePending',{get:()=>startupReconciliationPending||startupReconciliationCode!==null||upgradeGuard.inspect().active});
 // 1026：管理员规则什么时候被撤、为什么没生效，记在本机（admin-events.json，最近 50 条；不记密码、规则内容和命令）。下次再失效能查到原因。
 const adminLogFile=path.join(stateDir,'admin-events.json');
 const adminLog=(event,data={})=>{try{let list=[];try{list=JSON.parse(fs.readFileSync(adminLogFile,'utf8'));if(!Array.isArray(list))list=[];}catch{}const g=upgradeGuard.inspect();list.push({at:Date.now(),event,...data,switch_on:normalizeSwitches(state.data.high_risk).admin,guard_phase:g.phase,guard_admin_enabled:g.admin_enabled===true,version:VERSION});fs.writeFileSync(adminLogFile,JSON.stringify(list.slice(-50)),{mode:0o600});}catch{}};
 if(adminAccess&&typeof adminAccess.uninstall==='function'&&!adminAccess.__logged){const raw=adminAccess.uninstall.bind(adminAccess);adminAccess.uninstall=(reason='unknown')=>{const r=raw();adminLog('uninstall',{reason,result:r?.status||null});return r;};adminAccess.onUnready=reason=>adminLog('became_unready',{reason});adminAccess.__logged=true;}
 const reconcileAdminAccess=(reason)=>{if(adminAccess.supported()&&!normalizeSwitches(state.data.high_risk).admin&&adminAccess.ready({fresh:true}))adminAccess.uninstall(reason);};
 const upgradeStatus=upgradeGuard.inspect();if(!upgradeStatus.active||upgradeStatus.admin_enabled!==true)reconcileAdminAccess(upgradeStatus.active?'upgrade_verify_reconcile':'startup_reconcile');
 if(adminAccess.supported()&&normalizeSwitches(state.data.high_risk).admin&&!adminAccess.ready({fresh:true}))adminLog('not_ready_at_start',{reason:adminAccess.lastReason||null});
 const credentials=clientDeps.credentials||new CredentialStore(stateDir,isolated?{adapter:null}:{});let pendingCredentials=null,relayDesired=false,relayReady=false,relayPhase=null,relay;relay=new RelayClient({rpc:(body,caller,authenticated)=>tools.rpc(body,caller,{transport:'relay',setupPrincipal:authenticated?.setupPrincipal}),onChange:()=>{const phase=relay?.snapshot().status;if(phase&&phase!==relayPhase){tools.events?.record('conn.state',{from:relayPhase,to:phase,source:'relay'});relayPhase=phase;}const saved=relay?.credentials();if(saved)try{credentials.set('relay',saved);}catch{};if(relayDesired){const ready=relay?.snapshot().online===true;if(ready)refreshOpenAIHealth();if(!selectedSite()){if(ready&&!relayReady)linkAccess('relay',true);else if(!ready&&relayReady)linkAccess('relay',false,{auth:relay?.snapshot().status==='login_required'});}relayReady=ready;}}});
 const admin=crypto.randomBytes(32).toString('hex'),chatToken=crypto.randomBytes(32).toString('hex'),localToken=crypto.randomBytes(32).toString('hex'),upgradeAuthority=crypto.randomBytes(32).toString('hex'),setupHelperToken=crypto.randomBytes(32).toString('hex');let apiPort=0,mcpPort=0,tunnel,controller,closed=false;
 let maintenance=null,routePending=true,queuePending=true;
 const runtimeFile=path.join(stateDir,'runtime.json');const extensionFile=path.join(stateDir,'browser-extension-runtime.json'),extensionToken=crypto.randomBytes(32).toString('hex');const productConfig=JSON.parse(fs.readFileSync(path.join(pkg,'connectors/product.json')));
 const chromeDistribution=clientDeps.chromeDistribution??readChromeDistribution(pkg);
 const chromeInstallRoot=clientDeps.legacyChromeInstallRoot??pkg;
 if(tools.automation.browser.extension)tools.automation.browser.extension.distribution=chromeDistribution;
 // 1081（Claude，Ken 10/27）：在后台打开 Chrome（open -g，不抢到前面）。AI 要用浏览器、插件装过但没连上时用它；「检查并修复」也用它。
 // 测试和隔离运行不真开 Chrome，要测就从 clientDeps.openChrome 注入。
 const openChromeInBackground=clientDeps.openChrome||(isolated?null:()=>new Promise((resolve,reject)=>{const child=spawn('/usr/bin/open',['-g','-a','Google Chrome'],{stdio:'ignore'});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('CHROME_OPEN_FAILED')));}));
 if(tools.automation.browser.extension)tools.automation.browser.extension.wakeChrome=openChromeInBackground;
 let storePreparation=0;
 const storeStatus=()=>({...tools.automation.browser.extension.status(),config_state:chromeDistribution.configuration_state,store_ready:chromeDistribution.configuration_state==='ready'});
 // Installation-scoped Site B authority: selected and op IDs are committed in its own SQLite store.
 if(pilot.data.installation_scope!==pilot.scope)fail('B_INSTALLATION_SCOPE','本机安装身份归属已变化，Site 配对不可沿用。');
 const bLocalStore=new BSiteLocalStore({stateDir,installationId:pilot.data.installation_uuid,
  existingA:!!state.data.tunnel||['tunnel','relay'].includes(state.data.connection_preference),
  onAuthorityChanged:()=>{reconcileSelectedSiteAccess();eventChanged();},
  resultKey:()=>{const saved=credentials.get('site_b');if(saved?.installation_id!==pilot.data.installation_uuid)
   fail('B_RESULT_KEY_REQUIRED','B 结果密钥未绑定本机安装。');return Buffer.from(saved.result_key||'','base64url');}});
 const publicInstallationId=loadPublicInstallationId({local:bLocalStore});
 // A pending cross-store decision is never executable. Recover before any
 // transport or dispatcher can start; unresolved material stays fail-closed.
 try{bLocalStore.recoverSiteCommit(credentials);bLocalStore.seedHighwater(credentials);}catch{}
 // Route health is independent from the user's persisted execution/pause switch.
 // A disconnection must not revoke B tasks or reopen an explicit user pause.
 const selectedSite=()=>bLocalStore.selection().selected==='site';
 const appRoutes=new ChatGPTAppRoutes({state,selected:()=>bLocalStore.selection().selected,current:()=>setupFacts.selectedRoute(state.data)});
 const setupFacts=new SetupFacts({local:bLocalStore,installationId:pilot.data.installation_uuid,appBinding:()=>({application_id:canonicalChatGPTAppId(appRoutes.entry('site').chatgpt_app_identity?.application_id),revision:appRoutes.entry('site').setup_retest_revision})});
 let setupIntentRevision=0;
 const chooseSetupRoute=route=>{
  const result=setupFacts.choose(route);setupIntentRevision++;
  if(route==='openai')abandonSitePairing();
  setupActivity.cancel(route==='site'?'openai':'site');
  return result;
 };
 // The selected route may change in SQLite without another DesktopState save
 // (for example while paused). Commit the one-time ownership map first.
 appRoutes.persistMigration();
 let sitePhase=null;
 const maintenanceClock=clientDeps.maintenanceClock||{setTimeout,clearTimeout};
 const siteNetworkCheck=createSiteNetworkCheck({fetchImpl:clientDeps.siteNetworkFetch??globalThis.fetch,now:()=>maintenanceClock.now?.()??Date.now()});
 function siteNetworkOrigin(){
  if(bLocalStore.route('site').configured!==1)return null;
  try{return bLocalStore.siteOrigin(credentials)||'';}catch{return '';}
 }
 async function requireSiteNetworkForNewSetup(){
  const generation=sitePairingGeneration,intentRevision=setupIntentRevision,selectionRevision=bLocalStore.selection().revision,configured=bLocalStore.route('site').configured;
  const assertCurrent=()=>{if(closed||generation!==sitePairingGeneration||intentRevision!==setupIntentRevision||selectionRevision!==bLocalStore.selection().revision||configured!==bLocalStore.route('site').configured)
   fail('B_LIFECYCLE_CHANGED','当前连接或权限已改变，操作未开始。');};
  const result=await siteNetworkCheck({origin:null});assertCurrent();
  if(result.result==='challenged')fail('SITE_NETWORK_CHALLENGED','这台 Mac 当前的网络会被 Site 的网络验证（Cloudflare）拦截，多半是在用代理或 VPN。请改用 OpenAI 通道，或关闭代理或 VPN 后重试。');
  if(result.result==='unreachable')fail('SITE_NETWORK_UNREACHABLE','无法连接 ChatGPT Site，请检查网络后重试，或改用 OpenAI 通道。');
  return assertCurrent;
 }

 const setupActivity=new SetupActivity({state,now:()=>maintenanceClock.now?.()??Date.now()});
 let setupHelperSeenAt=null,setupHelperLocale=systemLocale();
 const setupActivityView=()=>({...setupActivity.snapshot(),seen_at:setupHelperSeenAt});
 const networkChallengeNotice=new NetworkChallengeNotice({local:bLocalStore,notifications:()=>state.data.notifications!==false,changed:()=>eventChanged()});
 const markSetupActivity=(command,route)=>{
  const changed=setupActivity.touch(command,route);
  if(changed){if(route==='site')renewSiteWatch();maintenance?.changed('setup_activity','site_watch');eventChanged();}return changed;
 };
 tools.readTasks=new ReadTaskTracker({policy,searchJobs:tools.features.search.jobs,now:()=>maintenanceClock.now?.()??Date.now(),changed:()=>{maintenance?.changed('read_tasks');eventChanged();}});
 const connectionGrace=new ConnectionGrace({now:()=>maintenanceClock.now?.()??Date.now(),events:tools.events});
 function linkIdentity(route){
  if(route==='site'){const b=bLocalStore.route('site');return b?.configured&&b?.site_id&&b?.owner_subject&&b?.binding_id&&Number.isSafeInteger(b.generation)&&b.generation>0?JSON.stringify([b.site_id,b.owner_subject,b.binding_id,b.generation]):null;}
  if(route==='relay'){const b=relay.credentials(),c=b?.config;return c&&b.id?JSON.stringify([c.base,c.issuer,b.id]):null;}
  return tunnel?.tunnelId&&tunnel.key?crypto.createHash('sha256').update(JSON.stringify([tunnel.tunnelId,tunnel.key])).digest('hex'):null;
 }
 function linkAccess(route,healthy,{auth=false,fatal=false}={}){
  if(closed||selectedSite()!==(route==='site'))return;
  const before=connectionGrace.current,identity=linkIdentity(route),changed=before&&(before.route!==route||before.identity!==identity);
  const recovering=before?.since!==null&&before?.since!==undefined;
  const revokeReason=auth||fatal||changed||!identity||!before?.worked?'revoked':'connection_lost';
  const decision=connectionGrace.update(route,{identity,healthy,auth,fatal});
  policy.connectionUnavailable=decision==='retain';
  if(changed&&policy.enabled)setAccess(false,{persist:false,reason:'revoked',source:route,keepGrace:true});
  if(decision==='ready'){if(executionResumeAllowed&&!permissionChangePending&&!permissionRevocations.blocked&&!tools.upgradePending&&(!policy.enabled||!recovering&&state.data.access_enabled!==true))setAccess(true,{persist:!recovering,source:route,keepGrace:true});}
  else if(decision==='revoke'&&policy.enabled)setAccess(false,{persist:false,reason:revokeReason,source:'grace_end',keepGrace:true});
 }
 const siteMayExecute=()=>selectedSite()&&executionResumeAllowed&&bLocalStore.fresh(bLocalStore.route('site'));
 function reconcileSelectedSiteAccess(){
  if(closed||!selectedSite())return;
  const phase=bLocalStore.route('site')?.state;if(phase&&phase!==sitePhase){tools.events?.record('conn.state',{from:sitePhase,to:phase,source:'site'});sitePhase=phase;}
  const enabled=siteMayExecute();
  if(enabled&&(permissionChangePending||permissionRevocations.blocked||tools.upgradePending))return;
  const failure=siteLinkFailure(bLocalStore.route('site'),bSiteTransport?.linkState?.()||bSiteTransport?.status?.()||{});
  linkAccess('site',enabled&&!failure.immediate,{auth:phase==='auth_required',fatal:failure.immediate});
 }
 const legacyTrustResolver=clientDeps.bSiteDeploymentResolver||bundledSiteTarget;
 const bTemplatePin=isolated&&typeof clientDeps.bSiteTemplatePin==='function'?
  clientDeps.bSiteTemplatePin:readPinnedSiteTemplate;
 const bTrustResolver=clientDeps.bSiteDeploymentResolver||((id)=>
  bundledSiteTarget(id)||pairedSiteTarget(id,{credentials,localStore:bLocalStore,
   installationId:pilot.data.installation_uuid,templatePin:bTemplatePin}));
 // Production always constructs a signed-target HTTPS factory. Test injection
 // remains bounded to an explicitly supplied synthetic adapter.
 const bSiteTransport=clientDeps.bSiteTransport||new BSiteWsTransport({
  installationId:pilot.data.installation_uuid,credentials,localStore:bLocalStore,
  resolveDeployment:bTrustResolver,autoPoll:!isolated,templatePin:bTemplatePin,onBindingReplaced:()=>{bHostProbes.invalidate();eventChanged();},onNetworkChallenge:event=>{if(event.transport_epoch===bSiteTransport.epoch)networkChallengeNotice.challenge(event);},onNetworkChallengeCleared:event=>{if(event.transport_epoch===bSiteTransport.epoch)networkChallengeNotice.clear();}
 });
 if(clientDeps.bSiteTransport){bSiteTransport.onNetworkChallenge=event=>{if(event.transport_epoch===bSiteTransport.epoch)networkChallengeNotice.challenge(event);};bSiteTransport.onNetworkChallengeCleared=event=>{if(event.transport_epoch===bSiteTransport.epoch)networkChallengeNotice.clear();};}
 const siteTelemetry=new SiteConnectionTelemetry({events:tools.events,clock:startupClock});
 function observeSiteConnection(){
  if(closed)return;
  try{const route=bLocalStore.route('site');
   siteTelemetry.observe({route,transport:bSiteTransport.stageStatus?.()||bSiteTransport.status?.()||{},fresh:bLocalStore.fresh(route),epoch:bSiteTransport.epoch});
  }catch{} // Diagnostics never change route authority or transport success.
 }
 const bPairing=new BSitePairing({installationId:pilot.data.installation_uuid,credentials,localStore:bLocalStore,
  resolveDeployment:legacyTrustResolver,transport:bSiteTransport,templatePin:bTemplatePin,deviceName:()=>setupDeviceName});
 let resumeSitePair=false;
 try{resumeSitePair=bPairing.restoreV2Recovery();}
 catch(error){bPairing.failure={code:String(error?.code||'B_PAIR_RECOVERY_UNCONFIRMED').slice(0,80),at:Date.now()};}
 let sitePairingGeneration=0;
 let bSiteWatch=state.data.setup_site_watch||null,bSiteWatchStoppedId=state.data.setup_site_watch_stopped?.id||null,bSiteWatchStoppedReason=state.data.setup_site_watch_stopped?.reason||null;
 const watchEvent=(phase,reason,error_code)=>tools.events?.record('site.watch',{phase,reason,...(error_code?{code:error_code}:{})});
 const siteTerminalErrors=new Set(['B_BINDING_CONFLICT','B_REBIND_UNSUPPORTED','B_REBIND_OWNER_REQUIRED','B_BOOTSTRAP_DISABLED','B_BINDING_REPLACED','B_TEMPLATE_MISMATCH','B_TEMPLATE_UNVERIFIED','B_PAIRING_BINDING','B_GRANT_EXPIRED','B_PAIRING_INTENT_EXPIRED','B_REBIND_CONFLICT_REQUIRED']);
 function stopSiteWatch(reason){
  if(bSiteWatch){bSiteWatchStoppedId=bSiteWatch.id;bSiteWatchStoppedReason=reason;state.data.setup_site_watch_stopped={id:bSiteWatch.id,reason};watchEvent('stopped',({paired:'WATCH_PAIRED',expired:'WATCH_EXPIRED',no_pending:'NO_PENDING'})[reason]||'WATCH_STOPPED');}
  bSiteWatch=null;delete state.data.setup_site_watch;if(reason==='expired')state.data.setup_site_watch_expired=true;state.save();maintenance?.changed('site_watch');
 }
 function abandonSitePairing(reason='B_PAIRING_ABANDONED'){
  sitePairingGeneration++;resumeSitePair=false;
  const previous=bPairing.failure?.code,code=siteTerminalErrors.has(previous)&&!siteTerminalErrors.has(reason)?previous:reason;
  // Fence late work even if saving the stopped watch subsequently fails.
  if(['B_PAIRING_ABANDONED','B_PAIRING_CANCELLED','B_CONNECTION_REMOVED','B_WATCH_EXPIRED'].includes(reason))bPairing.close();
  delete state.data.setup_site_select_on_pair;
  stopSiteWatch(reason==='B_WATCH_EXPIRED'?'expired':'stopped');
  if(typeof bPairing.abandonSitePairing!=='function')fail('B_PAIRING_ABANDON_UNAVAILABLE','Site 配对认证未完成，原有 OpenAI 连接和任务保持不变。');
  bPairing.abandonSitePairing(code);
  setupActivity.cancel('site');
 }
 function renewSiteWatch(){
  const at=startupClock();state.data.setup_site_last_progress_at=at;
  if(bSiteWatch){bSiteWatch.last_progress_at=at;bSiteWatch.expires_at=Math.min(bSiteWatch.intent_expires_at??bSiteWatch.expires_at,at+15*60*1000);state.data.setup_site_watch={...bSiteWatch};}
  state.save();
 }
 function watchCurrent(){
  if(!bSiteWatch)return null;
  if(siteTerminalErrors.has(bPairing.failure?.code)){abandonSitePairing(bPairing.failure.code);return null;}
  const activity=setupActivity.snapshot(),last=bSiteWatch.last_progress_at??state.data.setup_site_last_progress_at??(activity.route==='site'?activity.last_at:null)??0;
  const expires=Math.min(bSiteWatch.intent_expires_at??bSiteWatch.expires_at,last+15*60*1000);
  if(bSiteWatch.expires_at!==expires){bSiteWatch.expires_at=expires;state.data.setup_site_watch={...bSiteWatch};state.save();}
  if(startupClock()>=expires){abandonSitePairing('B_WATCH_EXPIRED');return null;}
  return bSiteWatch;
 }
 function startSiteWatch({newAttempt=false}={}){
  if(bPairing.failure)fail('B_PAIRING_STOPPED','Site 资料等待已结束。');
  const intent=bLocalStore.activeIntent(credentials);if(!intent)fail('B_PAIRING_INTENT_MISSING','没有等待中的 Site 配对。');
  if(!bSiteWatch||bSiteWatch.intent_id!==intent.intent_id){
   const at=newAttempt?startupClock():state.data.setup_site_last_progress_at??startupClock();
   bSiteWatch={id:crypto.randomUUID(),intent_id:intent.intent_id,intent_expires_at:intent.expires_at,last_progress_at:at,expires_at:Math.min(intent.expires_at,at+15*60*1000)};
   bSiteWatchStoppedId=null;bSiteWatchStoppedReason=null;delete state.data.setup_site_watch_stopped;state.data.setup_site_watch={...bSiteWatch};state.save();watchEvent('started','WATCH_STARTED');maintenance?.changed('site_watch');
  }
  const current=watchCurrent();return current?{watching:true,watch_id:current.id,expires_at:current.expires_at}:{watching:false,stopped_id:bSiteWatchStoppedId,stopped_reason:bSiteWatchStoppedReason};
 }
 const enrollmentWatch=()=>{const current=watchCurrent();return current?{watching:true,expires_at:current.expires_at,watch_id:current.id}:{watching:false,...(bSiteWatchStoppedId?{stopped_id:bSiteWatchStoppedId,stopped_reason:bSiteWatchStoppedReason}:{})};};
 const siteSnapshot=()=>{
  const base=bLocalStore.snapshot(),pairing=bPairing.snapshot();
  base.routes.site.origin=bLocalStore.siteOrigin(credentials);
  return {...base,pairing,binding_replaced:bLocalStore.bindingReplaced?.()||null,connection_stages:siteStages(pairing),verified_template_source:pairing.verified_template_source||null,
   paired_notice:bLocalStore.pairedNotice(credentials),
   enrollment_watch:enrollmentWatch()};
 };
 function siteStages(pairing=null){
  const route=bLocalStore.route('site');
  // Native polling only reads current evidence. Full pairing.snapshot() also
  // reads pinned files/intent material and belongs to the full management view.
  pairing=pairing||{phase:bPairing.failure?'failed':bPairing.pending?'pairing':route.configured?'configured':'unconfigured',error_code:bPairing.failure?.code,updated_at:bPairing.failure?.at||bPairing.pending?.started_at||null};
  return siteConnectionStages({selected:bLocalStore.selection().selected,route,pairing,transport:{...(bSiteTransport.stageStatus?.()||bSiteTransport.status?.()||{}),network_challenge:networkChallengeNotice.activeChallenge()?{...networkChallengeNotice.activeChallenge(),transport_epoch:bSiteTransport.epoch}:null},
   app:{registered_locally:!!appRoutes.entry('site').chatgpt_app_identity?.application_id,retest_required:appRoutes.entry('site').chatgpt_app_retest_required===true,missing:!!appRoutes.entry('site').chatgpt_app_missing,missing_detected_at:appRoutes.entry('site').chatgpt_app_missing?.detected_at}});
 }
 // Claim the protected writer once, in this internal constructor chain only.
 const bHostProbes=new BSiteHostProbes({local:bLocalStore,installationId:pilot.data.installation_uuid,
  receiptWriter:bLocalStore.issueInternalHostReceiptWriter(),
  permissionEnabled:()=>policy.enabled===true&&store.paused!==true,
  transportEpoch:()=>bSiteTransport.epoch,onReadWrite:identity=>{
   const entry=appRoutes.entry('site'),previous=entry.chatgpt_app_retest_required;
   try{bLocalStore.tx(()=>{setupFacts.recordSite(identity);delete entry.chatgpt_app_retest_required;state.save();});}
   catch(error){if(previous!==undefined)entry.chatgpt_app_retest_required=previous;throw error;}
   finishVerifiedSetup('site');eventChanged();
  }});
 const bSiteDispatch=new BSiteDispatch({local:bLocalStore,credentials,tools,installationId:pilot.data.installation_uuid,
  hostProbes:bHostProbes,observeProbe:record=>bHostProbes.observe(record)});
 if(typeof bSiteTransport.setHostFlow==='function')
  bSiteTransport.setHostFlow({metadataForResult:(item,saved,epoch)=>bHostProbes.metadataForResult(item,saved,epoch),
   invalidate:()=>bHostProbes.invalidate()});
 if(typeof bSiteTransport.setRpcDelivery!=='function'&&typeof bSiteTransport.setDelivery==='function')
  bSiteTransport.setDelivery(bSiteDispatch.bindTransportAuthority(bSiteTransport));
 // A server-owned closure is the only WS RPC authority. Never exported through tools or HTTP.
 const siteRpc=async(rpc,authenticated,{signal,beforeStart,assert,delivery}={})=>{
  const route=bLocalStore.route('site'),setupProbe=rpc?.method==='tools/call'&&['connection_check','setup_write_probe'].includes(rpc.params?.name);
  const assertManual=()=>{
   if(closed||
    authenticated.installation_id!==pilot.data.installation_uuid||authenticated.site_id!==route.site_id||
    authenticated.owner_subject!==route.owner_subject||authenticated.binding_id!==route.binding_id||
    authenticated.generation!==bLocalStore.route('site').generation||authenticated.binding_id!==bLocalStore.route('site').binding_id)
    fail('B_LIFECYCLE_CHANGED','当前连接或权限已改变，操作未开始。');
   if(!selectedSite()&&!setupProbe)fail('ROUTE_NOT_SELECTED',displayText('route.refusal.openai'));
   if(!(setupProbe?executionResumeAllowed&&bLocalStore.fresh(bLocalStore.route('site')):siteMayExecute())||store.paused===true||policy.enabled!==true||permissionChangePending||permissionRevocations.blocked||tools.upgradePending)
    fail('B_LIFECYCLE_CHANGED','当前连接或权限已改变，操作未开始。');
  };
  const assertLocal=()=>{signal?.throwIfAborted();assert?.();assertManual();if(authenticated.transport_epoch!==bSiteTransport.epoch)fail('B_LIFECYCLE_CHANGED','连接已改变，操作未开始。');};
  assertLocal();const started=performance.now();
  const setupPrincipal='site-b:authenticated:'+authenticated.owner_subject+':'+authenticated.binding_id+':'+authenticated.generation;
  const connectionPrincipal='site:'+authenticated.owner_subject+':'+authenticated.binding_id+':'+authenticated.generation;
  const host=bHostProbes.rpcContext(rpc,authenticated);
  const siteIdentity=delivery&&typeof delivery.job_id==='string'&&typeof delivery.request_hash==='string'?Object.freeze({kind:'site',namespace:authenticated.installation_id+':'+authenticated.site_id+':'+authenticated.binding_id+':'+authenticated.generation,id:delivery.job_id,requestDigest:delivery.request_hash}):null;
  const response=await runSiteExecution(Object.freeze({signal,assert:assertLocal,assertManual,beforeStart:beforeStart||(()=>{})}),()=>tools.rpc(rpc,'chatgpt',{
   transport:'site_b',setupPrincipal,connectionPrincipal,signal,hostProbe:host?.probe,hostReceipt:host?.hostReceipt,[AUTO_TASK_IDENTITY]:siteIdentity}));
  signal?.throwIfAborted();const hostCapability=host?.observe?.(response);
  if(rpc?.method==='tools/call'&&!response?.error&&response?.result&&response.result.isError!==true){
   bSiteTransport.noteSuccessfulCall?.({epoch:authenticated.transport_epoch});
   observeSiteConnection();
   const current=bLocalStore.route('site');
   if(authenticated.transport_epoch===bSiteTransport.epoch&&authenticated.binding_id===current.binding_id&&authenticated.generation===current.generation)
    siteTelemetry.authenticatedCallSucceeded(authenticated.transport_epoch);
  }
  if(hostCapability&&response?.result&&!response.result.isError)
   response.result._meta={...(response.result._meta||{}),'chathand/host_flow_capability':hostCapability};
  return {response,elapsed_ms:performance.now()-started};
 };
 if(typeof bSiteTransport.setRpcDelivery==='function')bSiteTransport.setRpcDelivery(siteRpc);
 if(typeof bSiteTransport.setRuntimeFactory==='function')bSiteTransport.setRuntimeFactory(async()=>{
  const read=async(method,params)=>{const response=await tools.rpc({jsonrpc:'2.0',id:'site-runtime',method,...(params?{params}:{})},'chatgpt',{transport:'site_b'});if(response?.error)fail('B_RUNTIME_DIRECTORY_FAILED','本机工具目录无法读取。');return response.result;};
  const initialize=await read('initialize',{protocolVersion:'2025-11-25'}),serverDiscover=await read('server/discover'),toolList=await read('tools/list'),resources=await read('resources/list'),resourceContents={};
  for(const uri of new Set([...resources.resources.map(r=>r.uri),LEGACY_TASK_URI,LEGACY_IMAGE_BATCH_URI,...SITE_WIDGET_ALIASES]))resourceContents[uri]=await read('resources/read',{uri});
  const initializeByProtocol={};for(const protocolVersion of ['2026-07-28','2025-11-25','2025-06-18','2025-03-26','2024-11-05'])initializeByProtocol[protocolVersion]=await read('initialize',{protocolVersion});
  // The worker repeats initialize.serverInfo in every modern result. Keep its
  // envelope identity small; versioned initialize replies retain the icons.
  // This preserves the approved 4k text pages and 12k total JSON envelope.
  const {icons,...envelopeInfo}=initialize.serverInfo;
  return {initialize:{...initialize,serverInfo:envelopeInfo},initializeByProtocol,serverDiscover,tools:toolList,resources,resourceContents};
 });
 tools.bSiteLocalStore=bLocalStore;tools.bSitePairing=bPairing;tools.bSiteDispatch=bSiteDispatch;
 // No public Mac ingress: the authenticated Site WebSocket is outbound only.
 const mcp=http.createServer(async(req,res)=>{let traceId=null,resourceRequest=null;const observeResource=(response,status)=>{try{const safe=resourceDiagnostic(resourceRequest,response,status);if(safe)tools.events?.record('mcp.resource',safe);}catch{}};try{
  if(req.headers.host!==`127.0.0.1:${mcpPort}`||req.headers.origin)return send(res,403,{error:'HOST_OR_ORIGIN_REJECTED'});
  if(req.url!=='/mcp')return send(res,404,{error:'NOT_FOUND'});
  const token=req.headers['x-ken-bridge-token'];const caller=eq(token,chatToken)?'chatgpt':eq(token,localToken)?'local-mcp':null;
  traceId=tools.trace.receiveHTTP(caller||'unauthenticated');let responseFinished=false;res.once('finish',()=>{responseFinished=true;tools.trace.httpDone(traceId,res.statusCode);});res.once('close',()=>{if(!responseFinished)tools.trace.httpDone(traceId,res.statusCode,true);});
  if(!caller){tools.trace.rejectedHTTP(traceId,'LOCAL_AUTH_REQUIRED');return send(res,401,{error:'LOCAL_AUTH_REQUIRED'});}
  if(req.method!=='POST')return send(res,405,{error:'POST_REQUIRED'});
  if(!(req.headers['content-type']||'').startsWith('application/json'))return send(res,415,{error:'JSON_REQUIRED'});
  const accept=req.headers.accept||'';if(!accept.includes('application/json')||!accept.includes('text/event-stream'))return send(res,406,{error:'ACCEPT_JSON_AND_EVENT_STREAM_REQUIRED'});
  const body=await json(req);resourceRequest=body;const invalid=validateTransport(body,req.headers);if(invalid){observeResource(invalid,400);return send(res,400,invalid);}
  const connectionAttempt={generation:controller?.generation,child:tunnel?.child};
  const result=await tools.rpc(body,caller,{callId:traceId,transport:'local_http',setupPrincipal:caller==='chatgpt'?'tunnel:chatgpt':undefined,headerNames:Object.keys(req.headers)});if(caller==='chatgpt'&&body.method==='tools/call'&&result?.result&&!result.result.isError&&result.result.structuredContent?.error_code!=='ROUTE_NOT_SELECTED'&&connectionAttempt.generation===controller?.generation&&connectionAttempt.child===tunnel?.child){const at=startupClock();if(tunnel.authenticatedCallSucceeded?.(at)!==false){controller?.authenticatedCallSucceeded(at,connectionAttempt);refreshOpenAIHealth();}}if(result===null){res.writeHead(202);res.end();}else{const status=transportStatus(body,result);observeResource(result,status);send(res,status,result);}
 }catch(e){const status=e.code==='BODY_TOO_LARGE'?413:400;observeResource({error:{code:e.code}},status);send(res,status,{error:cleanError(e)});}});
 mcp.requestTimeout=45000;mcp.headersTimeout=10000;mcpPort=await listen(mcp);tunnel=clientDeps.tunnelFactory?clientDeps.tunnelFactory(stateDir,`http://127.0.0.1:${mcpPort}/mcp`,chatToken):new TunnelManager(stateDir,`http://127.0.0.1:${mcpPort}/mcp`,chatToken,{events:tools.events,clock:startupClock});
 controller=new ConnectionController({tunnel,state,clock:()=>maintenanceClock.now?.()??Date.now(),cloudRetryAllowed:()=>state.data.connection_preference!=='relay',events:tools.events,onReset:()=>{tools.lastCheck=null;},
  onConnecting:()=>{if(!selectedSite())linkAccess('tunnel',false);},
  onReady:()=>{const config={tunnel_id:tunnel.tunnelId,binary:tunnel.binary,api_key:tunnel.key};credentials.set('tunnel',config);pendingCredentials=null;if(!selectedSite())linkAccess('tunnel',true);
   try{bLocalStore.configureOpenAI({verified:true});bLocalStore.health('openai',{state:'healthy',verified:true,nonceEcho:true,generation:0});}catch{/* A must stay usable if optional B mirror is unavailable. */}
  },
  onUnavailable:({auth=false,userStop=false}={})=>{if(!selectedSite()){if(userStop)setAccess(false,{persist:false,reason:'revoked',source:'user'});else linkAccess('tunnel',false,{auth});}
   // ConnectionController invokes this before updating its terminal phase. Never
   // infer failed from a single timeout; inspect the completed controller state.
   const generation=controller?.generation;
   queueMicrotask(()=>{if(closed||generation!==controller?.generation)return;
    const phase=controller.snapshot().phase;
    const next=phase==='needs_retry'?'failed':phase==='needs_login'?'auth_required':'reconnecting';
    try{bLocalStore.health('openai',{state:next,verified:true,generation:0,reason:phase});}catch{}
   });
  },
  onCloudLost:cp=>{if(Date.now()-startedAt>180000)policy.emit('connection_lost',{proxy:cp?.proxy||'direct',down_since:cp?.down_since||null});},
  onCloudBack:()=>policy.emit('connection_back')});
 // Keep the proof private; public snapshots expose only the verified boolean.
 const savedSetupBindings=new Map();
 function credentialSetupBinding(transport,saved){
  let identity;
  if(transport==='relay'){if(!saved?.config||!saved.id)return null;const c=saved.config;identity=[transport,saved.id,c.base,c.issuer,c.audience,c.client,c.token,c.device,c.connector];}
  else {if(!saved?.tunnel_id||!saved.api_key)return null;identity=[transport,saved.tunnel_id,saved.api_key];}
  return {transport,binding:crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex'),...(transport==='tunnel'?{tunnel_id:saved.tunnel_id}:{relay_base:saved.config.base})};
 }
 function setupBinding(){
  const preference=state.data.connection_preference;
  const transport=preference==='relay'||preference==='none'&&state.data.setup_test_proof?.transport==='relay'?'relay':'tunnel';
  const live=transport==='relay'?relay.credentials():tunnel.key&&tunnel.tunnelId?{tunnel_id:tunnel.tunnelId,api_key:tunnel.key}:null;
  // The live identity is in memory. Read a saved identity once per credential
  // revision, so state streaming does not repeatedly decrypt the credential file.
  if(!live&&!savedSetupBindings.has(transport)){try{savedSetupBindings.set(transport,credentialSetupBinding(transport,credentials.get(transport)));}catch{return null;}}
  const identity=live?credentialSetupBinding(transport,live):savedSetupBindings.get(transport);
  if(identity?.transport==='tunnel'&&state.data.setup_tunnel_id&&state.data.setup_tunnel_id!==identity.tunnel_id)return null;
  return identity||null;
 }
 function finishVerifiedSetup(route){
  const activity=setupActivity.snapshot();
  if(setupFacts.selectedRoute(state.data)!==route||activity.active&&activity.route!==route)return;
  if(bLocalStore.selection().selected!==route)selectConnectionRoute(route,{setup:true});setupActivity.finish(route);
 }
 function selectConnectionRoute(route,{setup=false,chooseSetup=true}={}){
  const value=setup?bLocalStore.switchSetup(route,{authenticatedSetup:true}):bLocalStore.switchUser(route,{windowGesture:true});if(chooseSetup)chooseSetupRoute(route);
  if(!chooseSetup)setupActivity.cancel(route==='site'?'openai':'site');
  if(value.changed){policy.connectionUnavailable=false;connectionGrace.reset('route_changed');bHostProbes.invalidate();if(route==='site')reconcileSelectedSiteAccess();else linkAccess(state.data.connection_preference==='relay'?'relay':'tunnel',bLocalStore.fresh(bLocalStore.route('openai')));}
  return value;
 }
 async function waitForSetupRoute(route){
  const deadline=Date.now()+6000;
  do{
   if(route==='openai'){await inspectConnection();const c=memoryConnection();if((relay.snapshot().online===true||c.ready===true&&c.healthy===true&&c.process_running===true)&&bLocalStore.fresh(bLocalStore.route(route)))return;}
   else if(bLocalStore.fresh(bLocalStore.route(route)))return;
   if(Date.now()>=deadline)break;await new Promise(resolve=>setTimeout(resolve,200));
  }while(!closed);
  fail('B_ROUTE_NOT_HEALTHY','连接尚未通过健康检查。');
 }
 function connectionRouteInput(d){if(!d||Object.keys(d).join(',')!=='route'||!['site','openai'].includes(d.route))fail('ARG_INVALID','配置路线无效。');return d.route;}
 function routeReady(route){
  if(!bLocalStore.fresh(bLocalStore.route(route)))return false;
  if(route==='openai'){const c=memoryConnection();return relayDesired?relay.snapshot().online===true:c.ready===true&&c.healthy===true&&!!tunnel.child&&(c.control_plane?.state==='up'||controller.recentlyAuthenticated());}
  const status=bSiteTransport.stageStatus?.()||bSiteTransport.status?.()||{};
  return status.running===true&&status.ready===true&&status.authenticated===true;
 }
 async function bringUpConnection(route){
  let timer;
  const work=async()=>{
   if(route==='openai'){
    if(!routeReady(route)){
     if(state.data.connection_preference==='relay'||!credentials.get('tunnel')&&credentials.get('relay')){
      if(!relayDesired)await handle('/api/relay/restore',{}, {startup:true});
     }else if(!controller.desired||!tunnel.child&&!controller.busy)restoreTunnel();
    }
   }else if(!routeReady(route))await bPairing.verifyHealth({select:false});
   const deadline=Date.now()+6000;
   do{if(closed)fail('B_LIFECYCLE_CHANGED','当前连接或权限已改变，操作未开始。');if(route==='openai')await inspectConnection();else observeSiteConnection();if(routeReady(route))return;if(Date.now()>=deadline)break;await new Promise(resolve=>setTimeout(resolve,100));}while(!closed);
   fail('B_ROUTE_NOT_HEALTHY','连接尚未通过健康检查。');
  };
  try{await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('B_ROUTE_NOT_HEALTHY'),{code:'B_ROUTE_NOT_HEALTHY'})),6000);})]);}
  finally{clearTimeout(timer);}
 }
 let connectionMutation=false;
 async function useConnection(route,{setup=false}={}){
  if(connectionMutation)fail('B_LIFECYCLE_CHANGED','当前连接或权限已改变，操作未开始。');
  connectionMutation=true;
  try{
   if(route==='openai')abandonSitePairing('B_PAIRING_ABANDONED');
   const expectedRevision=bLocalStore.selection().revision,generation=sitePairingGeneration,intentRevision=setupIntentRevision;
   await bringUpConnection(route);
   if(expectedRevision!==bLocalStore.selection().revision||generation!==sitePairingGeneration||intentRevision!==setupIntentRevision)fail('B_LIFECYCLE_CHANGED','当前连接或权限已改变，操作未开始。');
   const result=selectConnectionRoute(route,{setup,chooseSetup:setup});
   return {ok:true,...result,selected:bLocalStore.selection().selected};
  }catch(error){return {ok:false,error_code:/^[A-Z][A-Z0-9_]{0,60}$/.test(error?.code||'')?error.code:'B_ROUTE_NOT_HEALTHY',selected:bLocalStore.selection().selected};}
  finally{connectionMutation=false;}
 }
 async function removeConnection(route){
  if(connectionMutation)fail('B_LIFECYCLE_CHANGED','当前连接或权限已改变，操作未开始。');
  connectionMutation=true;
  const active=bLocalStore.selection().selected===route,previous=bLocalStore.route(route);
  let revoke;
  try{
   if(typeof bLocalStore.forgetRoute!=='function'||route==='site'&&typeof bPairing.forget!=='function')fail('B_CONNECTION_FORGET_UNAVAILABLE','未提供该管理操作。');
   if(route==='site'){
    abandonSitePairing('B_CONNECTION_REMOVED');const generation=sitePairingGeneration;bHostProbes.invalidate();
    if(!previous.configured){revoke='SKIPPED';}
    else{
     let timer;
     try{const result=await Promise.race([Promise.resolve().then(()=>bSiteTransport.revokeCurrent()),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),10000);})]);revoke=result?.remote_revocation==='confirmed'?'CONFIRMED':'UNCONFIRMED';}
     catch(error){revoke=error?.code==='B_DEVICE_UNCONFIGURED'?'SKIPPED':'UNCONFIRMED';}
     finally{clearTimeout(timer);}
    }
    const current=bLocalStore.route('site');if(generation!==sitePairingGeneration||current.binding_id!==previous.binding_id||current.generation!==previous.generation)fail('B_LIFECYCLE_CHANGED','当前连接或权限已改变，操作未开始。');
    bSiteTransport.stop?.();bPairing.forget({binding_id:previous.binding_id,generation:previous.generation});
   }else{
    const savedIdentity=JSON.stringify(['tunnel','relay'].map(kind=>credentialSetupBinding(kind,credentials.get(kind))));
    pendingCredentials=null;relayDesired=false;relayReady=false;controller.stop({persist:false});
    try{await relay.stop({forget:!!relay.credentials()});}
    catch(error){if(error?.code!=='REVOCATION_UNCONFIRMED')throw error;
     // Explicit route removal forgets this Mac even if the legacy relay cannot
     // confirm remote revocation. Its stopped worker cannot retain local auth.
     relay.session=null;relay.config=null;relay.credentialGeneration++;
     try{store.audit({event:'connection_remove',route:'openai',code:'REVOCATION_UNCONFIRMED'});}catch{}
    }
    const deadline=Date.now()+3000;while((tunnel.child||tunnel.doctorChild)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
    if(tunnel.child||tunnel.doctorChild)fail('STOP_INCOMPLETE','仍有任务正在停止，请稍后查看。');
    if(savedIdentity!==JSON.stringify(['tunnel','relay'].map(kind=>credentialSetupBinding(kind,credentials.get(kind)))))fail('B_LIFECYCLE_CHANGED','当前连接或权限已改变，操作未开始。');
    credentials.remove('tunnel');credentials.remove('relay');tunnel.key='';tunnel.tunnelId=null;state.data.tunnel=null;state.data.connection_preference='none';state.data.auto_connect=false;
    delete state.data.setup_tunnel_id;delete state.data.setup_key_last4;savedSetupBindings.clear();clearSetupTest();state.save();
   }
   if(route==='openai')bLocalStore.forgetRoute(route,{authenticatedNative:true});
   if(active){
    setAccess(false,{persist:false,reason:'revoked'});
    const other=route==='site'?'openai':'site';
    if(bLocalStore.route(other).configured)try{
     await bringUpConnection(other);const selected=selectConnectionRoute(other,{chooseSetup:false});
     // Forgetting Site has already reset selection to OpenAI. A healthy live
     // standby still needs its access reconciled when no second switch occurs.
     if(!selected.changed){policy.connectionUnavailable=false;connectionGrace.reset('route_changed');bHostProbes.invalidate();if(other==='site')reconcileSelectedSiteAccess();else linkAccess(state.data.connection_preference==='relay'?'relay':'tunnel',bLocalStore.fresh(bLocalStore.route('openai')));}
    }catch{}
   }
   eventChanged();return {ok:true,selected:bLocalStore.selection().selected,...(route==='site'?{revoke}:{})};
  }finally{connectionMutation=false;}
 }
 function refreshOpenAIHealth(){
  try{if(!bLocalStore.route('openai').configured)bLocalStore.configureOpenAI({verified:true});bLocalStore.health('openai',{state:'healthy',verified:true,nonceEcho:true,generation:0});}catch{}
 }
 function setupVerified(){return appRoutes.currentRoute()==='site'?siteSetupVerified():openaiSetupVerified();}
 function siteSetupVerified(){return appRoutes.entry('site').chatgpt_app_retest_required!==true&&!!setupFacts.siteProof();}
 function openaiSetupVerified(){
  if(appRoutes.entry('openai').chatgpt_app_retest_required===true)return false;
  if(state.data.setup_test_passed!==true)return false;
  const current=setupBinding(),proof=state.data.setup_test_proof;if(!current)return false;
  if(proof!==undefined)return proof?.version===1&&proof.transport===current.transport&&proof.binding===current.binding;
  // Explicit legacy compatibility: preserve an existing passed flag only for
  // the current saved connection. Never create a flag from health or UI input.
  if(!savedSetupBindings.has(current.transport)){try{savedSetupBindings.set(current.transport,credentialSetupBinding(current.transport,credentials.get(current.transport)));}catch{return false;}}
  const saved=savedSetupBindings.get(current.transport);return saved?.binding===current.binding;
 }
 function setupTestSnapshot(){
  if(setupFacts.selectedRoute(state.data)!=='site')return tools.setupTest.snapshot();
  const proof=setupFacts.siteProof(),verified=!!proof&&appRoutes.entry('site').chatgpt_app_retest_required!==true;
  return {route:'site',site_id:bLocalStore.route('site').site_id||null,status:verified?'read_write':'not_received',verified,read:verified,write:verified,expired:false,...(verified?{verified_at:proof.verified_at}:{})};
 }
 function clearSetupTest(){if(state.data.setup_complete)state.data.setup_ever_complete=true;if(tools.setupTest.current)tools.setupTest.issued.set(tools.setupTest.current.nonce,tools.setupTest.current.expires);tools.setupTest.current=null;state.data.setup_test_passed=false;state.data.setup_complete=false;delete state.data.setup_test_proof;delete state.data.setup_test_expires_at;}
 function appName(value){return typeof value==='string'?value.replace(/[\p{Cc}\p{Cf}]/gu,'').replace(/[<>\[\]{}\\/]/g,'-').trim().slice(0,60):'';}
 const setupDeviceName=appName((clientDeps.computerName||computerName)())||'Mac';
 const setupDeviceModel=(clientDeps.macModel||((isolated)?()=> 'Mac':macModel))();
 const lastMissingDetectedAt=Object.fromEntries(['site','openai'].map(route=>[route,Number.isFinite(appRoutes.entry(route).chatgpt_app_missing?.detected_at)?appRoutes.entry(route).chatgpt_app_missing.detected_at:0]));
 function markChatGPTAppMissing({reason,identity}={},context){
  appRoutes.assertCurrent(context);const route=context?.route||appRoutes.currentRoute(),entry=appRoutes.entry(route);
  if(!['refresh_not_found','identity_required'].includes(reason))return;
  const registered=entry.chatgpt_app_identity,registeredId=registered?.application_id||(registered?.detail_url?new URL(registered.detail_url).pathname.split('/').pop():null);
  if(reason==='identity_required'&&registeredId||reason==='refresh_not_found'&&(!registeredId||!sameChatGPTAppId(identity?.app_id,registeredId)))return;
  const previous=entry.chatgpt_app_missing;entry.chatgpt_app_missing={detected_at:Math.max(Date.now(),lastMissingDetectedAt[route]+1,(previous?.detected_at||0)+1),reason};try{state.save();}catch(e){if(previous===undefined)delete entry.chatgpt_app_missing;else entry.chatgpt_app_missing=previous;throw e;}lastMissingDetectedAt[route]=entry.chatgpt_app_missing.detected_at;eventChanged();
 }
 function clearFoundChatGPTApp(identity,context){appRoutes.assertCurrent(context);const entry=appRoutes.entry(context?.route||appRoutes.currentRoute()),registered=entry.chatgpt_app_identity,id=registered?.application_id||(registered?.detail_url?new URL(registered.detail_url).pathname.split('/').pop():null);if(!sameChatGPTAppId(id,identity?.app_id)||!entry.chatgpt_app_missing)return;const previous=entry.chatgpt_app_missing;delete entry.chatgpt_app_missing;try{state.save();}catch(e){entry.chatgpt_app_missing=previous;throw e;}eventChanged();}
 function forgetMissingChatGPTAppAfterRetest(route){const entry=appRoutes.entry(route);if(entry.chatgpt_app_missing?.reason!=='refresh_not_found')return false;delete entry.chatgpt_app_missing;delete entry.chatgpt_app_identity;return true;}
 function advanceSetupRetestRevision(route){const entry=appRoutes.entry(route),previous=entry.setup_retest_revision;entry.setup_retest_revision=(Number.isSafeInteger(previous)&&previous>=0?previous:0)+1;if(route==='site')bHostProbes.invalidate();}
 function rememberChatGPTApp(d,{observed=false,route=appRoutes.currentRoute(),context}={}){appRoutes.assertCurrent(context);if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).some(k=>!['application_id','detail_url','app_name','name'].includes(k)))fail('CHATGPT_APP_IDENTITY_INVALID','ChatGPT 插件资料无效。');const entry=appRoutes.entry(route),previous=entry.chatgpt_app_identity||{},name=appName(d.app_name||d.name);let id=d.application_id,detail=d.detail_url;
  if(detail!==undefined){let u;try{u=new URL(detail);}catch{}if(!u||u.origin!=='https://chatgpt.com'||!/^\/settings\/plugins-settings\/[-A-Za-z0-9_]{1,200}$/.test(u.pathname)||u.username||u.password||u.search||u.hash)fail('CHATGPT_APP_IDENTITY_INVALID','ChatGPT 插件详情地址无效。');detail=u.href;}
  if(id!==undefined&&(typeof id!=='string'||!/^[-A-Za-z0-9_]{1,200}$/.test(id)))fail('CHATGPT_APP_IDENTITY_INVALID','ChatGPT 插件编号无效。');
  if(id&&detail&&!sameChatGPTAppId(new URL(detail).pathname.split('/').pop(),id))fail('CHATGPT_APP_IDENTITY_INVALID','ChatGPT 插件编号与详情地址不一致。');
  id=id||(detail?new URL(detail).pathname.split('/').pop():null);detail=detail||(id?PLUGINS_URL+'/'+id:null);
  if(observed&&(!previous.application_id&&!previous.detail_url||id&&!sameChatGPTAppId(previous.application_id||new URL(previous.detail_url).pathname.split('/').pop(),id)||detail&&previous.detail_url&&!sameChatGPTAppDetailURL(detail,previous.detail_url)))return;
  if(!id||!detail)fail('CHATGPT_APP_IDENTITY_REQUIRED','请登记这台 Mac 的 ChatGPT 插件编号或详情地址。');
  const before=appRoutes.snapshot(route);
  if(!observed&&(before.chatgpt_app_missing||!sameChatGPTAppId(previous.application_id||(previous.detail_url?new URL(previous.detail_url).pathname.split('/').pop():null),id))){entry.chatgpt_app_retest_required=true;advanceSetupRetestRevision(route);}entry.chatgpt_app_identity={application_id:id,detail_url:detail};if(observed&&previous.application_id)entry.chatgpt_app_identity.application_id=previous.application_id;if(observed&&previous.detail_url)entry.chatgpt_app_identity.detail_url=previous.detail_url;if(name)entry.chatgpt_app_name=name;delete entry.chatgpt_app_missing;
  try{state.save();}catch(error){appRoutes.restore(route,before);throw error;}return {saved:true,...entry.chatgpt_app_identity,...(name?{app_name:name}:{})};
 }
 function setupSettings(){const {chatgpt_app_routes,setup_test_proof,setup_site_watch,setup_retest_revision,...settings}=state.data;return {...settings,chatgpt_app_name_suggested:'ChatHand（'+setupDeviceName+'）'+(bLocalStore.route('site').configured&&bLocalStore.route('openai').configured?' · '+(setupFacts.selectedRoute(state.data)==='site'?'Site':'OpenAI'):'')};}
 function routeAppSummaries(){return Object.fromEntries(['site','openai'].map(route=>{const entry=appRoutes.entry(route);return [route,{name:appName(entry.chatgpt_app_name),registered:!!entry.chatgpt_app_identity?.application_id,missing:!!entry.chatgpt_app_missing,retest_required:entry.chatgpt_app_retest_required===true,verified:route==='site'?siteSetupVerified():openaiSetupVerified()}];}));}
 let completingSetup=null;
 async function completeSetup(){if(completingSetup)return completingSetup;completingSetup=(async()=>{const first=state.data.setup_ever_complete!==true&&state.data.setup_complete!==true;if(first&&!state.data.permission_tier_intent)await applyPermissionTier({state,store,policy,adminAccess,home:isolated?path.dirname(stateDir):localHome},{tier:'full',defaultSetup:true});state.data.setup_complete=true;state.data.setup_ever_complete=true;state.save();})().finally(()=>{completingSetup=null;});return completingSetup;}
 tools.setupTest.deviceName=()=>setupDeviceName;
 const openaiChallengeBinding=()=>{const binding=setupBinding()?.binding,entry=appRoutes.entry('openai');return binding?crypto.createHash('sha256').update(JSON.stringify([binding,canonicalChatGPTAppId(entry.chatgpt_app_identity?.application_id),entry.setup_retest_revision||0])).digest('hex'):null;};
 tools.setupTest.binding=openaiChallengeBinding;
 tools.setupTest.verified=openaiSetupVerified;
 tools.setupTest.onPassed=({binding,principal,expires_at})=>{
  const current=setupBinding();let relayPrincipal;try{relayPrincipal=JSON.parse(principal);}catch{}
  const authenticated=current?.transport==='tunnel'?principal==='tunnel:chatgpt':Array.isArray(relayPrincipal)&&relayPrincipal.length===2&&relayPrincipal[0]===current?.relay_base&&typeof relayPrincipal[1]==='string'&&relayPrincipal[1].startsWith('relay:');
  if(!current||binding!==openaiChallengeBinding()||!authenticated)fail('SETUP_TEST_REQUIRED','连接配置已改变，请重新测试。');
  const previous={passed:state.data.setup_test_passed,proof:state.data.setup_test_proof,expires:state.data.setup_test_expires_at},beforeApp=appRoutes.snapshot('openai'),entry=appRoutes.entry('openai');
  state.data.setup_test_passed=true;state.data.setup_test_proof={version:1,transport:current.transport,binding:current.binding};state.data.setup_test_expires_at=expires_at;forgetMissingChatGPTAppAfterRetest('openai');delete entry.chatgpt_app_retest_required;
  try{state.save();}catch(error){for(const [key,value] of [['setup_test_passed',previous.passed],['setup_test_proof',previous.proof],['setup_test_expires_at',previous.expires]]){if(value===undefined)delete state.data[key];else state.data[key]=value;}appRoutes.restore('openai',beforeApp);throw error;}
  refreshOpenAIHealth();finishVerifiedSetup('openai');eventChanged();
 };
 tools.selfPids=()=>[tunnel.child?.pid,tunnel.doctorChild?.pid].filter(Boolean);tools.selfCmdlines=()=>tunnel.child?.spawnargs?[tunnel.child.spawnargs.join(' ')]:[];
 let healthProbe=null,lastControlPlane=null,observedConnection=null;
 const probeContext=()=>({generation:controller.generation,child:tunnel.child,route:selectedSite()?'site':state.data.connection_preference==='relay'?'relay':'openai'});
 const cloudProbe=new CloudProbe({current:probeContext,onChange:eventChanged,...(clientDeps.cloudProbe?{run:clientDeps.cloudProbe}:isolated?{run:async()=>({reachable:null,code:'NOT_RUN',elapsed_ms:0,target:'api.openai.com'})}:{})});
 async function inspectConnection(){
  if(healthProbe)return healthProbe;
  const generation=controller.generation,child=tunnel.child;
  healthProbe=(async()=>{let c;try{c=await tunnel.snapshot();}catch(e){c={status:'checking',process_running:!!tunnel.child,healthy:false,ready:false,error:cleanError(e)};}
   if(!closed&&generation===controller.generation&&child===tunnel.child)cloudProbe.observe({...probeContext(),cp:c.control_plane});
   if(!closed&&generation===controller.generation&&child===tunnel.child)controller.observe(c);
   else c={...c,healthy:false,ready:false,process_running:!!tunnel.child};
   if(!closed&&generation===controller.generation&&child===tunnel.child)lastControlPlane=c.control_plane||null;
   if(!closed&&generation===controller.generation&&child===tunnel.child){observedConnection={generation,child,value:c};if(c.ready===true&&c.healthy===true&&c.process_running===true&&c.control_plane?.state!=='down')refreshOpenAIHealth();}
   eventChanged();return memoryConnection();
  })().finally(()=>{healthProbe=null;});return healthProbe;
 }
 function resumeConnection(action){const previous=executionResumeAllowed;if(!selectedSite())executionResumeAllowed=true;try{return action();}catch(e){executionResumeAllowed=previous;throw e;}}
 function restoreTunnel({restart=false}={}){
  if(relay.worker||relay.flow)fail('OTHER_CONNECTION_ACTIVE','请先断开另一条连接。');
  const readAt=startupClock();startupStage('credential_read','begin',readAt);let saved;try{saved=credentials.get('tunnel');startupStage('credential_read','ok',readAt);}catch(e){startupStage('credential_read','failed',readAt,e?.code);throw e;}if(!saved)fail('SAVED_CONNECTION_MISSING','填写一次连接信息，以后自动连接。');
  // Reconnect only the committed identity. A rejected edit remains in tunnel
  // memory, but restore must never promote that candidate over saved settings.
  const liveMatchesSaved=pendingCredentials===null&&tunnel.tunnelId===saved.tunnel_id&&tunnel.key===saved.api_key;
  if(restart&&controller.desired&&liveMatchesSaved){if(!controller.restart('user','正在重新连接 ChatGPT'))fail('CONNECTION_BUSY','连接检查正在进行，稍后再试。');return {ok:true,...controller.snapshot()};}
  if(restart&&controller.desired&&!liveMatchesSaved&&(controller.busy||tunnel.child||tunnel.doctorChild))fail('CONNECTION_BUSY','连接检查正在进行，稍后再试。');
  if(state.data.setup_test_proof?.transport==='relay'){clearSetupTest();state.save();}
  const configureAt=startupClock();startupStage('configure','begin',configureAt);let result;try{result=controller.configureAndConnect({...saved,binary:findTunnelBinary(state)||saved.binary});startupStage('configure','ok',configureAt);}catch(e){startupStage('configure','failed',configureAt,e?.code);throw e;}
  if(!result.replayed)pendingCredentials=null;
  return result;
 }
 async function stopTunnel(){
  executionResumeAllowed=false;pendingCredentials=null;let revokeError=null;try{controller.stop();}catch(e){revokeError=e;}try{setAccess(false,{reason:'revoked'});}catch(e){revokeError??=e;}
  const until=Date.now()+3000;
  while(Date.now()<until&&(tunnel.child||tunnel.doctorChild||queue.list().some(j=>j.process_alive||j.cleanup_pending)))await new Promise(r=>setTimeout(r,25));
  if(tunnel.child||tunnel.doctorChild||queue.list().some(j=>j.process_alive||j.cleanup_pending))fail('STOP_INCOMPLETE','仍有任务正在停止，请稍后查看。');
  if(revokeError)throw revokeError;
  return {ok:true,...controller.snapshot()};
 }
 async function stopRelay({forget=false}={}){
  executionResumeAllowed=false;relayDesired=false;relayReady=false;tools.lastCheck=null;
  let error=null;try{setAccess(false,{reason:'revoked'});}catch(e){error=e;}
  state.data.connection_preference='none';try{state.save();}catch(e){error??=e;}
  let result,stopped=false;try{result=await relay.stop({forget});stopped=true;}catch(e){error=e;}
  if(forget&&stopped)try{credentials.remove('relay');clearSetupTest();state.save();}catch(e){error??=e;}
  if(error)throw error;
  return result;
 }
 const deviceName=(clientDeps.computerName||computerName)();
 const localHome=isolated?path.join(stateDir,'integration-home'):os.homedir();if(isolated)fs.mkdirSync(localHome,{recursive:true,mode:0o700});
 let computerSetupStatus={},permissionChangePending=false;
 const permissionHistory=new PermissionHistory(stateDir);bindPermissionHistory(state,permissionHistory);
 const permissionName=(gate,id)=>gate==='scope'?'整台电脑':gate==='capability'?CAPABILITIES[id]?.name:HIGH_RISK.find(x=>x.id===id)?.name;
 const permissionConversation=taskId=>{const task=policy.tasks.get(taskId),id=task?.conversation_id||state.data.session_groups?.[task?.session_hash]?.conversation_id,chat=state.data.conversations.find(x=>x.id===id&&x.project_id===task?.project_id);return chat?{url:chat.url,title:chat.title}:null;};
 const permissionCleanupEvidence=clientDeps.permissionCleanupEvidence||new OwnedJobCleanupEvidence({isolated});
 const permissionRevocations=new PermissionRevocations({state,store,policy,queue,confirmations:tools.confirmations,adminAccess,automation:tools.automation,normalizeHighRisk:normalizeSwitches,transition:{get:()=>permissionChangePending,set:value=>{permissionChangePending=value;}},ownerProof:new NativeOwnerProofVerifier({key:nativeOwnerKey}),cleanupEvidence:permissionCleanupEvidence,onAuthorityChanged:()=>{try{tools.features.search.cancelAll();}catch{/* Revocation is independently enforced by SearchManager permissionRevision on each read. */}try{relayKeeper.cancelAll('authority_changed');}catch{/* Lowering authority must proceed even if the optional relay store is unavailable. */}}});
 installQueuePermissionFence({queue,state,policy,isTransitioning:()=>permissionChangePending||permissionRevocations.blocked,cleanupEvidence:permissionCleanupEvidence});
 let browserHostStatus={status:'pending'},browserHostPending=null,browserHostDenied=null;
 function rememberBrowserOptIn({defaultEnabled=false}={}){
  if(state.data.browser_enabled!==true&&!(defaultEnabled&&state.data.browser_enabled===undefined&&capabilityOn(state,'browser')))return false;
  if(state.data.browser_control_opt_in!==true||state.data.browser_enabled!==true){const previous={enabled:state.data.browser_enabled,optIn:state.data.browser_control_opt_in};state.data.browser_enabled=true;state.data.browser_control_opt_in=true;try{state.save();}catch(e){for(const [key,value]of [['browser_enabled',previous.enabled],['browser_control_opt_in',previous.optIn]]){if(value===undefined)delete state.data[key];else state.data[key]=value;}throw e;}}
  return true;
 }
 function explicitBrowserInstallation(action){
  // The HTTP route has already checked the current owner/window. Check raw
  // capabilities before recording this explicit installation choice; the
  // strict probe gate below reads only the persisted opt-in evidence.
  policy.check();
  if(permissionChangePending||permissionRevocations.blocked||tools.upgradePending||policy.transitioning||state.data.browser_enabled!==true||!capabilityOn(state,'browser')||!capabilityOn(state,'desktop'))fail('INSTALL_ACCESS_CHANGED','Chrome 插件的安装已停止；请查看当前状态，不要重复原来的点击。');
  rememberBrowserOptIn();chromeInstall.allowed();return action();
 }
 const chromeInstall=new ChromeInstallProbe({distribution:chromeDistribution,root:chromeInstallRoot,state,policy,registrationOnlyAfterOptIn:true,browserOptIn:()=>browserControlOptedIn(state.data),extension:tools.automation.browser.extension,audit:e=>store.audit(e),diagnostic:e=>tools.events?.record('chrome.install',e),ready:()=>!permissionChangePending&&!permissionRevocations.blocked&&!tools.upgradePending,origin:()=>`http://127.0.0.1:${apiPort}`});
 tools.automation.browser.extension.installProbe=chromeInstall;
 tools.automation.browser.extension.installFolder=helperFolder(localHome);
 const browserHost=clientDeps.browserHost||{manifestPath:['com.kenyu.chathand.browser'].map(name=>path.join(localHome,'Library/Application Support/Google/Chrome/NativeMessagingHosts',name+'.json')),expectedBinary:browserHostBinary({root:pkg}),register:(options={})=>registerBrowserHost({distribution:chromeDistribution,root:pkg,home:localHome,registrationOnlyAfterOptIn:true,browserEnabled:state.data.browser_enabled,browserOptIn:browserControlOptedIn(state.data),flow:options.flow||'install',diagnostic:fields=>chromeInstall.dataAccess(fields)})};
 if(clientDeps.browserHost)assertTemporaryUpdatePaths(localHome,browserHost.expectedBinary,...browserHost.manifestPath);
 async function registerCurrentBrowserHost(options={}){
  if(storeMode(chromeDistribution)&&chromeDistribution.configuration_state!=='ready')return {...chromeDistribution,registered:false,skipped:true,reason:'store_configuration_pending'};
  // Check before even stat-ing the helper folder. Missing is not consent.
  if(!browserControlOptedIn(state.data)){browserHostStatus={status:'skipped',reason:'browser_not_opted_in'};return {registered:false,skipped:true,reason:'browser_not_opted_in'};}
  if(tools.upgradePending)fail('UPGRADE_VERIFYING','应用正在完成升级自检，暂不执行 AI 操作。');
  if(browserHostPending)return browserHostPending;
  if(browserHostDenied&&options.retryAfterPermission!==true)
   throw Object.assign(Error(browserHostDenied.message),{code:'CHROME_DATA_ACCESS_DENIED'});
  browserHostPending=(async()=>{
   try{options.guard?.();if(!storeMode(chromeDistribution)&&fs.existsSync(helperFolder(localHome)))publishHelper({root:chromeInstallRoot,home:localHome,guard:options.guard,distribution:chromeDistribution});options.guard?.();const result=await browserHost.register(options);browserHostDenied=null;browserHostStatus={status:'registered'};return result;}
   catch(e){const error=cleanError(e);if(error.code==='CHROME_DATA_ACCESS_DENIED')browserHostDenied=error;browserHostStatus={status:'failed',code:error.code,message:error.message};throw e;}
   finally{eventChanged();}
  })();
  try{return await browserHostPending;}finally{browserHostPending=null;}
 }
 function withBrowserHostStatus(browser){
  const extension={...browser.extension,host_registration:{...browserHostStatus}};
  return {...browser,...(browser.backend==='extension'?{host_registration:{...browserHostStatus}}:{}),extension};
 }
 function updateBusy(exceptTask=null){return updateWorkPending({jobs:queue.list(),tasks:policy.summary().tasks,exceptTask});}
 // 1027：新版装好、工具变了，替用户去 ChatGPT 设置里点「刷新工具」（固定步骤，认不准就不点）。
 // 1050 refresh delta: server-owned, per-install evidence; never read host/page claims from RPC body or _meta.
 const refreshContract=manifest(TOOLS),refreshBuild=Number(JSON.parse(fs.readFileSync(path.join(pkg,'package.json'),'utf8'))?.kenBridge?.build_number)||null;
 const refreshIdentity={build:refreshBuild,instance_id:tools.trace?.instance_id||store.instance_id||null,connector_api:refreshContract.connector_api,tool_count:refreshContract.tool_count,schema_sha256:refreshContract.schema_sha256,connection_tag:crypto.randomBytes(16).toString('hex')};
 const toolListProof=new ToolListProof(stateDir);
 const toolListKey=route=>{let identity;if(route==='site_b'){const b=bLocalStore.route('site');if(b?.configured)identity=[b.site_id,b.owner_subject,b.binding_id,b.generation];}else if(route==='relay'){const r=relay.credentials?.();if(r?.id)identity=[r.config?.base,r.config?.issuer,r.id];}else if(tunnel.tunnelId)identity=[tunnel.tunnelId];return identity?tools.trace.hash(JSON.stringify([route,...identity])):null;};
 const toolListStatus=()=>{const route=selectedSite()?'site_b':state.data.connection_preference==='relay'?'relay':'local_http';return toolListProof.status({identity:toolListKey(route),currentSchema:refreshContract.schema_sha256,build:refreshBuild,site:route==='site_b'});};
 tools.onAuthenticatedToolsList=event=>{const identity=toolListKey(event.route);if(identity)toolListProof.record({identity,at:event.at,schema_sha256:event.schema_sha256,build:refreshBuild});eventChanged();};
 tools.onOrdinaryCallSuccess=({name,caller,context,at})=>{
  const excluded=new Set(['task_status','task_history','list_commands','list_conversations','show_task','operation_status','command_result','input_status','upgrade_status','setup_status','setup_claim','setup_done','card_answer','relay_card_control','chathand_host_flow_commit']);
  if(excluded.has(name))return;
  const verified=tools.refreshListContext?.(caller,context);if(!verified?.authenticated)return;
  if(verified.route==='site_b'){
   const stage=bSiteTransport.stageStatus?.()||{};
   if(stage.runtime_manifest?.state==='accepted'&&stage.runtime_manifest.transport_epoch===bSiteTransport.epoch){
    const identity=toolListKey('site_b');if(identity)toolListProof.record({identity,at,schema_sha256:refreshContract.schema_sha256,build:refreshBuild});
   }
  }
  eventChanged();
 };
 const refreshPrincipals={local_http:crypto.randomBytes(16).toString('hex'),relay:crypto.randomBytes(16).toString('hex')};
 const refreshRoute=()=>state.data.connection_preference==='relay'?'relay':'local_http';
 tools.refreshListContext=(caller,context={})=>{
  const route=context.transport;
  if(route==='site_b'){const b=bLocalStore.route('site'),capability=currentSiteExecution(),principal=b?.configured?'site-b:authenticated:'+b.owner_subject+':'+b.binding_id+':'+b.generation:null;try{if(!capability||caller!=='chatgpt'||context.setupPrincipal!==principal)return null;capability.assert();}catch{return null;}return {source:'trusted_server',authenticated:true,caller:'chatgpt',route,installation:{build:refreshIdentity.build,instance_id:refreshIdentity.instance_id},contract:{connector_api:refreshIdentity.connector_api,tool_count:refreshIdentity.tool_count,schema_sha256:refreshIdentity.schema_sha256},connection_tag:refreshIdentity.connection_tag,principal_tag:tools.trace.hash(principal),host_binding:null};}
  // The local_http caller has already passed the token check; relay caller was validated by RelayClient.
  const authenticated=caller==='chatgpt'&&(route==='local_http'&&context.setupPrincipal==='tunnel:chatgpt'||route==='relay'&&typeof context.setupPrincipal==='string'&&context.setupPrincipal.length>0);
  if(!authenticated||!Object.hasOwn(refreshPrincipals,route))return null;
  return {source:'trusted_server',authenticated:true,caller:'chatgpt',route,installation:{build:refreshIdentity.build,instance_id:refreshIdentity.instance_id},contract:{connector_api:refreshIdentity.connector_api,tool_count:refreshIdentity.tool_count,schema_sha256:refreshIdentity.schema_sha256},connection_tag:refreshIdentity.connection_tag,principal_tag:refreshPrincipals[route],host_binding:null};
 };
 let networkHandoffReceipt=null,networkHandoffFailureCode=null;
 tools.appendOrdinaryResultNotice=({result,name,args,caller,context})=>{
  if(networkChallengeNotice.row().pending!==1||!tools.refreshListContext?.(caller,context)?.authenticated)return false;
  return networkChallengeNotice.append(result,{preview:()=>networkSetupHandoff({appPath}),prepare:()=>{
   try{const handoff=prepareNetworkSetupHandoff({appPath,install:()=>networkHandoffReceipt||(networkHandoffReceipt=installSkill(isolated?{home:localHome,codexHome:path.join(localHome,'.codex')}:{}))});networkHandoffFailureCode=null;refreshSkillStatus();return handoff;}
   catch(error){networkHandoffReceipt=null;const code=/^[A-Z_]{1,64}$/.test(error?.code||'')?error.code:'SETUP_HANDOFF_UNAVAILABLE';if(code!==networkHandoffFailureCode)store.audit({event:'network_challenge_handoff_unavailable',code});networkHandoffFailureCode=code;throw error;}
  },maxEnvelopeChars:name==='command_result'&&args?.full===true?12000:Infinity});
 };
 let activeRefreshTask=null;
 const refreshTaskPresentation=()=>{const view=toolsRefresh.snapshot();return {state:view.state,clicked:view.clicked===true,...(view.tool_list_status?{tool_list_status:view.tool_list_status}:{}),message:String(view.message||'').slice(0,4000),...messageMetadata('message',view.message_key,view.message_params),stopped_at:view.stopped_at||null,steps:(view.steps||[]).filter(s=>Object.hasOwn(STEP_WORDS,s.step)).map(s=>({step:s.step,title:STEP_WORDS[s.step],...messageMetadata('title','refresh.step.'+s.step+'.title'),ok:s.ok===true,ms:s.ms}))};};
 const toolsRefresh=(clientDeps.toolsRefreshFactory||(deps=>new ToolsRefresher(deps)))({distribution:chromeDistribution,invoke:(name,args)=>tools.automation.browser.extension.withInternalControl(async()=>{
  // This closure is only held by the server-owned refresher, never RPC arguments.
  const {title_key,title_params,summary_key,summary_params,...publicArgs}=args;
  if(name==='finish_task'){const task=policy.get(publicArgs.task_id,'chatgpt');if(task.internal_source==='tools_refresh'){task.automatic_task=refreshTaskPresentation();Object.assign(task,messageMetadata('summary',summary_key,summary_params));}}
  const result=await tools.invoke(name,publicArgs,'chatgpt');
  if(name==='begin_task'&&result?.task_id){const task=policy.get(result.task_id,'chatgpt');task.internal_source='tools_refresh';Object.assign(task,messageMetadata('title',title_key,title_params));activeRefreshTask=result.task_id;return policy.view(task);}return result;
 })(),onAppMissing:markChatGPTAppMissing,onIdentityFound:clearFoundChatGPTApp,appName:()=>appRoutes.entry(toolsRefresh.targetContext?.route||appRoutes.currentRoute()).chatgpt_app_name||'ChatHand',targetIdentity:context=>{const entry=appRoutes.entry(context?.route||appRoutes.currentRoute());return entry.chatgpt_app_identity?{app_id:entry.chatgpt_app_identity.application_id,detail_url:entry.chatgpt_app_identity.detail_url,app_name:entry.chatgpt_app_name}:null;},onIdentityObserved:(d,context)=>rememberChatGPTApp({application_id:d.app_id,detail_url:d.detail_url,app_name:d.app_name},{observed:true,route:context?.route||appRoutes.currentRoute(),context}),seen:()=>tools.toolsListEvents||[],listStatus:toolListStatus,expected:()=>({...refreshIdentity,route:refreshRoute(),principal_tag:refreshPrincipals[refreshRoute()]}),audit:e=>store.audit(e),emit:(kind,data)=>policy.emit(kind,data),names:{load:()=>state.data.tools_refresh_names||{},save:t=>{state.data.tools_refresh_names=t;state.save?.();}},wakeChrome:()=>tools.automation.browser.extension.wakeAndWait()});Object.assign(toolsRefresh,{captureTarget:()=>appRoutes.capture(),assertTarget:context=>appRoutes.assertCurrent(context)});tools.toolsRefresh=toolsRefresh;policy.automaticTaskView=t=>t.id===activeRefreshTask?refreshTaskPresentation():t.automatic_task;
 const publishInstallTask=view=>{if(!view?.task_id)return;const task={...view,id:view.task_id,caller:'chatgpt',jobs:[],...(view.terminal?{completion:{...view},finish_success:view.success}:{})};policy.tasks.set(view.task_id,task);policy.emit(view.terminal?'task_finished':'task_started',{task_id:view.task_id,title:view.title,success:view.success});};
 // Completing upgrade verification restores only the still-authorized current route.
 // Reuse this after startup too; a trusted commit is not a new execution grant.
 function reconcileExecutionAccess(){
  if(closed||tools.upgradePending||permissionChangePending||permissionRevocations.blocked||policy.transitioning)return;
  if(selectedSite())reconcileSelectedSiteAccess();
  else if(state.data.connection_preference==='none')setAccess(executionResumeAllowed,{persist:false});
  else if(controller.desired)linkAccess('tunnel',controller.phase==='ready'&&!!tunnel.child,{auth:controller.phase==='needs_login'});
  else if(relayDesired)linkAccess('relay',relay.snapshot().online===true,{auth:relay.snapshot().status==='login_required'});
 }
 const finishUpgrade=proof=>{const result=proof?upgradeGuard.supersede(proof):upgradeGuard.commit();startupReconciliationCode=null;reconcileAdminAccess('upgrade_commit_reconcile');reconcileExecutionAccess();eventChanged();return result;};
 const updater=(clientDeps.updaterFactory||((deps)=>new Updater(deps)))({stateDir,state,guard:upgradeGuard,liveContract:manifest(TOOLS),finishUpgrade,onInstallTask:publishInstallTask,installTaskSource:id=>policy.tasks.get(id)||null,toolListStatus,lifecycleKey:upgradeAuthority,allowAutomaticInstall:automaticUpdatesAllowed({isolated,appPath}),currentAppPath:appPath,schemaSha:manifest(TOOLS).schema_sha256,version:VERSION,busy:updateBusy,emit:(kind,data)=>policy.emit(kind,data),onUpdated:ju=>{if(ju?.tool_schema_changed===true&&!isolated)void toolsRefresh.run({reason:'update'}).catch(()=>{});},currentSystemProxy,...(isolated?{upgradeHome:rehearsalHome||path.join(stateDir,'upgrades'),downloadsDir:path.join(localHome,'Downloads')}:{})});
 tools.updater=updater;if(updater.ai?.install_task)publishInstallTask(updater.ai.install_task.result||updater.ai.install_task.view);
 const repair=new Repair({distribution:chromeDistribution,snapshot,registrationOnlyAfterOptIn:true,browserOptIn:()=>browserControlOptedIn(state.data),mayReconnect:()=>executionResumeAllowed&&!permissionChangePending&&!permissionRevocations.blocked&&!tools.upgradePending&&!selectedSite(),restoreTunnel:()=>{if(!executionResumeAllowed||permissionChangePending||permissionRevocations.blocked||tools.upgradePending||selectedSite())return {ok:false};return restoreTunnel({restart:true});},systemProxy:currentSystemProxy,chromeDataDiagnostic:fields=>chromeInstall.dataAccess(fields),browserHost:{...browserHost,register:registerCurrentBrowserHost},openChromeInBackground:()=>openChromeInBackground?openChromeInBackground():Promise.resolve(),noteWakeFailed:o=>tools.automation.browser.extension?.noteWakeFailed?.(o),cleanupUpgrade:()=>updater.cleanupLeftovers()});
 let macOSVersion=os.release();if(process.platform==='darwin')try{macOSVersion=execFileSync('/usr/bin/sw_vers',['-productVersion'],{encoding:'utf8',timeout:2000}).trim();}catch{}
 function mattersView(){
  if(!matterStore)return {available:false,error_code:matterUnavailableCode||'MATTER_UNAVAILABLE',items:[],total:null,
   waiting_user_count:0,deleted_count:null,read_only:true};
  const rows=[...matterStore.items.values()].map(v=>matterStore.summary(v)).sort((a,b)=>(b.updated_at||0)-(a.updated_at||0));return {available:true,items:rows.slice(0,500),total:rows.length,waiting_user_count:rows.filter(v=>!v.deleted&&v.state==='waiting_user').length,deleted_count:rows.filter(v=>v.deleted).length,read_only:true};}
 async function snapshot(){const connection=await inspectConnection();const clientVersion=bundledTunnelVersion();if(clientVersion)connection.client_version=clientVersion;connection.device_name=deviceName;
  const {history,history_meta,activity:uiActivity}=projectUiReceipts(loadEventReceipts());
  const local=queue.list(),adminReady=adminReadyFor(state,adminAccess),computer=tools.automation.computer.status(),browser=withBrowserHostStatus(tools.automation.browser.status()),summary0=policy.summary(),summary={...summary0,tasks:summary0.tasks.map(t=>({...t,...tools.resume.view(t)}))};return {relay_pilot:pilot.status(),value:tools.valueStats?.snapshot(state.data),setup:{device_model:setupDeviceModel,key_watch:keyWatch.snapshot(),openai_seen_at:tools.openaiToolsListAt||null,open_items:setupOpenItems(state,{adminReady,computer:{...computer,permissions:{...computer.permissions,...computerSetupStatus}},browser:state.data.browser_backend==='personal'?browser:tools.automation.browser.extension.status(),desktopSupported:platformCapabilities().desktop_control})},ui:{seen:Array.isArray(state.data.ui_seen)?state.data.ui_seen:[]},high_risk:{items:HIGH_RISK.map(r=>({...r,enabled:normalizeSwitches(state.data.high_risk)[r.id]}))},setup_skill:setupSkillStatus(isolated?{codexHome:path.join(localHome,'.codex')}:{}),about:buildInfo(),update:updater.snapshot(),matters:mattersView(),site_b:{...siteSnapshot(),transport:bSiteTransport.status?.()||{factory:'unconfigured'},host_probe:bHostProbes.snapshot(),switch_events:bLocalStore.switchEvents()},h10:{connection_check:bLocalStore.currentHostReceipt()},tools_refresh:toolsRefresh.snapshot(),tools_list_status:toolListStatus(),tools_list_seen:(tools.toolsListSeen||[]).slice(-5),repair:repair.current(),support:{recent_errors:recentErrorCodes(stateDir)},keep_awake:keepAwakeNow(),setup_activity:setupActivityView(),setup_route:setupFacts.selectedRoute(state.data),chatgpt_apps:routeAppSummaries(),setup_test:setupTestSnapshot(),capabilities:platformCapabilities(),activity:uiActivity,onboarding:setupSummary(state,connection,tools.automation.browser.extension.status(),platformCapabilities(),productConfig),version:VERSION,runtime_api:RUNTIME_API,instance_id:tools.trace.instance_id,installation_id:publicInstallationId,call_trace:tools.trace.snapshot(),resume:tools.resume.diagnostics(),tunnel_binary_hint:state.data.tunnel?.binary||[path.join(os.homedir(),'.local/bin/tunnel-client'),'/opt/homebrew/bin/tunnel-client','/usr/local/bin/tunnel-client'].find(f=>fs.existsSync(f))||'tunnel-client',credentials:credentials.status(),settings:setupSettings(),project:state.project(),...summary,task_stalls:taskStalls(),history,history_meta,release:{channel:'local-beta',install_ready:false,terminal_acceptance:'LOCAL_V06_BASELINE_PASS'},upgrade_pending:!!tools.upgradePending,upgrade_guard:upgradeGuard.inspect(),lifecycle:{protocol:1,exit_requested:exitRequested},automation:{browser,computer},output_retention_status:queue.outputStatus(),jobs:local.map(j=>{const last_line=lastOutputLine(queue.jobs.get(j.job_id)?.events);return {...j,...(last_line?{last_line}:{})};}),inputs:[...queue.inputs.values()].filter(p=>p.status==='pending_approval'),connection,relay:relay.snapshot(),manifest:manifest(TOOLS),connection_check:tools.lastCheck,readiness:readiness({connection,lastCheck:tools.lastCheck,enabled:policy.enabled,relay:relay.snapshot()}),last_calls:tools.lastCalls,node:process.execPath,platform:process.platform,terminal:queue.status(),not_os_sandbox:false,permissions:permissionsInfo(state,{adminReady:adminReadyFor(state,adminAccess)}),high_risk_catalog:HIGH_RISK,blocks:tools.blocks.list(),confirmations:tools.confirmations.snapshot(),approvals:[...summary.approvals,...adminApprovals(local)],interface_protected:!!interfaceKey};}
 // SSE never calls snapshot()/inspectConnection() from its fallback sampler.
 const eventClock=clientDeps.eventClock;
 let stateEvents=null,eventWatchers=[];const eventFileVersions=new Map();
 const eventLoaders={
  metadata:()=>({about:buildInfo(),clientVersion:bundledTunnelVersion(),capabilities:platformCapabilities(),manifest:manifest(TOOLS),tunnelHint:state.data.tunnel?.binary||[path.join(os.homedir(),'.local/bin/tunnel-client'),'/opt/homebrew/bin/tunnel-client','/usr/local/bin/tunnel-client'].find(f=>fs.existsSync(f))||'tunnel-client'}),
  skill:()=>setupSkillStatus(isolated?{codexHome:path.join(localHome,'.codex')}:{}),
  history:loadEventReceipts,
  support:()=>({recent_errors:recentErrorCodes(stateDir)}),
  credentials:()=>credentials.status(),
  access:()=>({adminReady:adminReadyFor(state,adminAccess),terminal:queue.status()}),
  browser:()=>({personal:tools.automation.browser.personal.status(),managed:tools.automation.browser.managed.status()}),
  guard:()=>upgradeGuard.inspect(),
  ...clientDeps.eventLoaders,
 };
 let eventReceiptSnapshot=null;
 function loadEventReceipts(){
  let entries=null;try{entries=policy.receipts.entries();if(eventReceiptSnapshot?.entries===entries)return eventReceiptSnapshot.value;}catch{}
  let files=[],enumeration_ok=true,unreadable_count=0;try{files=(entries||policy.receipts.entries()).map(v=>v.file);}catch{enumeration_ok=false;}
  const history=files.slice(0,2000),activity=files.slice(0,3000),rows=new Map();
  for(const file of new Set([...history,...activity]))try{const receipt=policy.receipts.read(file.slice(0,-5));if(receipt)rows.set(file,{...receipt.result,archived:true});else unreadable_count++;}catch{unreadable_count++;}
  const value={history:history.flatMap(file=>rows.has(file)?[rows.get(file)]:[]),activity:activity.flatMap(file=>rows.has(file)?[rows.get(file)]:[]),
   source:{total_receipt_entries:enumeration_ok?files.length:null,at_least:files.length,unreadable_count,
     history_ingest_limit:2000,activity_ingest_limit:3000,
     history_truncated:!enumeration_ok||files.length>2000||unreadable_count>0,activity_truncated:!enumeration_ok||files.length>3000||unreadable_count>0,
     note:'本机UI只是有界预览，全量授权历史用task_history分页或records_export。'}};
  if(enumeration_ok&&entries)eventReceiptSnapshot={entries,value};return value;
 }
 // GET and SSE share the same bounded, honest projection. The SSE sampler
 // supplies its cached receipt rows; this pure merge never performs disk I/O.
 function projectUiReceipts(receipts){
  const live=[...policy.tasks.values()].map(t=>policy.view(t)),historyMap=new Map(live.map(t=>[t.task_id,t])),activityMap=new Map(historyMap);
  for(const t of receipts.history)if(!historyMap.has(t.task_id))historyMap.set(t.task_id,t);
  for(const t of receipts.activity)if(!activityMap.has(t.task_id))activityMap.set(t.task_id,t);
  const rows=[...historyMap.values()].filter(t=>t.project_id===state.data.active).sort((a,b)=>(b.finished_at||b.created_at||0)-(a.finished_at||a.created_at||0)||String(a.task_id).localeCompare(String(b.task_id)));
  const src=receipts.source,preview=memoryActivity([...activityMap.values()],state.data),complete=!src.history_truncated;
  return {history:rows.slice(0,100),history_meta:{offset:0,limit:100,total:complete?rows.length:null,at_least:rows.length,total_exact:complete,truncated:rows.length>100||!complete,next_offset:rows.length>100?100:null,incomplete:!complete,source_incomplete:!complete,unreadable_count:src.unreadable_count,preview_only:true,source_receipt_entries:src.total_receipt_entries,project_id:state.data.active,source:'authenticated_local_ui',read_only:true},
   activity:{...preview,total:src.activity_truncated?null:preview.total,at_least:preview.total,truncated:preview.truncated||src.activity_truncated,source_incomplete:src.activity_truncated,unreadable_count:src.unreadable_count,source_receipt_entries:src.total_receipt_entries}};
 }
 function eventChanged(){if(!closed&&maintenance){routePending=true;maintenance.changed('route','controller','connection','network','tasks','relay','display');}if(!closed&&stateEvents?.status().clients)void stateEvents.refresh().catch(()=>{});}
 function memoryBrowser(cached){
  const router=tools.automation.browser,extension={...router.extension.status(),host_registration:{...browserHostStatus}},p=router.personal;
  const stopped=p.phase==='connected'&&p.t?.isRunning?.()===false,phase=stopped?'disconnected':p.phase;
  const personalBase={...cached.personal};
  if(personalBase.details?.scope_note){const {scope_note,...details}=personalBase.details;if(Object.keys(details).length)personalBase.details=details;else delete personalBase.details;}
  const personal=withScopeNote(state,{...personalBase,phase,connected:phase==='connected',personal_browser_attached:phase==='connected',sessions:phase==='connected'?1:0,message:stopped?'连接进程已停止，请重新连接。':p.message});
  const managed={...cached.managed,sessions:router.managed.sessions.size};
  const backend=state.data.browser_backend==='personal'?personal:state.data.browser_backend==='isolated'?managed:extension;
  return {...backend,selected_backend:state.data.browser_backend||'extension',extension,personal,fallback_to_isolated:false};
 }
 function memoryConnection(metadata={}){
  const valid=observedConnection?.generation===controller.generation&&observedConnection.child===tunnel.child;
  const value={...(valid?observedConnection.value:{status:tunnel.status,process_running:!!tunnel.child,healthy:false,ready:false,control_plane:null,ui_url:tunnel.healthUrl?tunnel.healthUrl+'/ui':null,tunnel_id:tunnel.tunnelId??null,exit_code:tunnel.exitCode,log:tunnel.log}),automatic:controller.snapshot(),startup_reconciliation:{state:startupReconciliationPending?'checking':tools.upgradePending?'blocked':'ready',reason_code:startupReconciliationCode||(tools.upgradePending?'UPGRADE_VERIFYING':null)},device_name:deviceName,...(metadata.clientVersion?{client_version:metadata.clientVersion}:{})};
  const displayValue=selectedSite()?{process_running:true,healthy:bLocalStore.fresh(bLocalStore.route('site')),ready:bLocalStore.fresh(bLocalStore.route('site')),control_plane:{state:'up',last_success_at:bLocalStore.route('site').last_verified},automatic:{phase:bLocalStore.route('site').state==='reconnecting'?'reconnecting':'idle'}}:relay.snapshot().online?{process_running:true,ready:true,healthy:true,control_plane:{state:'up'}}:value;
  value.display=connectionDisplay(displayValue,{now:maintenanceClock.now?.()??Date.now(),proxyProbe:cloudProbe.snapshot()});return value;
 }
 function keepAwakeNow(){return shouldKeepAwake({settings:state.data,tasks:[...policy.tasks.values()],jobs:[...queue.jobs.values()],lastActivity:id=>tools.resume.lastActivity(id)});}
 let nativeSnapshotCache=null;
 function nativeSnapshot(){
  let chatgptAppDetailURL=null;for(const candidate of [state.data.chatgpt_app_identity?.detail_url,toolsRefresh.snapshot().detail_url])try{const u=new URL(candidate);if(u.origin==='https://chatgpt.com'&&!u.username&&!u.password&&!u.search&&!u.hash&&/^\/settings\/plugins-settings\/[-A-Za-z0-9_]{1,200}$/.test(u.pathname)){chatgptAppDetailURL=u.href;break;}}catch{}
  const tasks=[...policy.tasks.values()].filter(t=>['active','pending_approval'].includes(t.status)).map(t=>({task_id:t.id,title:t.title,status:t.status,created_at:t.created_at,jobs:t.jobs,conversation_id:t.conversation_id,project_id:t.project_id})),jobs=[...queue.jobs.values()].map(j=>({job_id:j.id,status:j.status,process_alive:!!j.child,cleanup_pending:!!j.cleanupPending}));
  const value=projectNativeState({network_challenge_notification:networkChallengeNotice.notificationPending(),setup_activity:setupActivity.snapshot(),settings:{...state.data,...(chatgptAppDetailURL?{chatgpt_app_detail_url:chatgptAppDetailURL}:{})},connection:memoryConnection(),relay:relay.snapshot(),project:state.project(),update:updater.snapshot(),enabled:policy.enabled,mode:state.data.mode,keep_awake:keepAwakeNow(),lifecycle:{exit_requested:exitRequested},instance_id:tools.trace.instance_id,installation_id:publicInstallationId,events:policy.events,confirmations:tools.confirmations.snapshot(),tasks,jobs,approvals:[...policy.approvals.values(),...[...queue.jobs.values()].filter(j=>j.admin&&j.status==='pending_approval').map(j=>({task_id:policy.jobOwners.get(j.id)||null,status:j.status}))],inputs:[...queue.inputs.values()].filter(p=>p.status==='pending_approval'),setup:{key_watch:keyWatch.snapshot(),openai_seen_at:tools.openaiToolsListAt||null},tools_refresh:{detail_url:toolsRefresh.snapshot().detail_url},site_b:{selected:selectedSite()?'site':'openai',binding_replaced:bLocalStore.bindingReplaced?.()||null,connection_stages:siteStages(),enrollment_watch:enrollmentWatch()},computer:{pending:tools.automation.computer.pending?.size||0}});
  if(!nativeSnapshotCache||!isDeepStrictEqual(value,nativeSnapshotCache.value))nativeSnapshotCache={value:structuredClone(value),json:JSON.stringify(value)};
  return nativeSnapshotCache.json;
 }
 function readEventState(slow){
  // publicJob/view/status here are memory-only. list/summary/upgradePending,
  // Router.status, credentials/admin/platform/skill/history getters stay out.
  const local=[...queue.jobs.values()].map(j=>queue.publicJob(j,{includeOutput:false}));
  const summary={enabled:policy.enabled,mode:state.data.mode,full_armed:policy.fullArmed,tasks:[...policy.tasks.values()].map(t=>{const v=policy.view(t);return {...v,...tools.resume.view(v)};}),approvals:[...policy.approvals.values()].map(({run,fp,...a})=>a),events:policy.events};
  const connection=memoryConnection(slow.metadata);
  const computer=tools.automation.computer.status(),browser=memoryBrowser(slow.browser),caps=slow.metadata.capabilities;
  const {history,history_meta,activity}=projectUiReceipts(slow.history);
  return {relay_pilot:pilot.status(),value:tools.valueStats?.snapshot(state.data),setup:{device_model:setupDeviceModel,key_watch:keyWatch.snapshot(),openai_seen_at:tools.openaiToolsListAt||null,open_items:setupOpenItems(state,{adminReady:slow.access.adminReady,computer:{...computer,permissions:{...computer.permissions,...computerSetupStatus}},browser:state.data.browser_backend==='personal'?browser:browser.extension,desktopSupported:caps.desktop_control})},ui:{seen:Array.isArray(state.data.ui_seen)?state.data.ui_seen:[]},high_risk:{items:HIGH_RISK.map(r=>({...r,enabled:normalizeSwitches(state.data.high_risk)[r.id]}))},setup_skill:slow.skill,about:slow.metadata.about,update:updater.snapshot(),matters:mattersView(),site_b:{...siteSnapshot(),transport:bSiteTransport.status?.()||{factory:'unconfigured'},host_probe:bHostProbes.snapshot(),switch_events:bLocalStore.switchEvents()},h10:{connection_check:bLocalStore.currentHostReceipt()},tools_refresh:toolsRefresh.snapshot(),tools_list_status:toolListStatus(),tools_list_seen:(tools.toolsListSeen||[]).slice(-5),repair:repair.current(),support:slow.support,keep_awake:keepAwakeNow(),setup_activity:setupActivityView(),setup_route:setupFacts.selectedRoute(state.data),chatgpt_apps:routeAppSummaries(),setup_test:setupTestSnapshot(),capabilities:caps,activity,onboarding:setupSummary(state,connection,browser.extension,caps,productConfig),version:VERSION,runtime_api:RUNTIME_API,instance_id:tools.trace.instance_id,installation_id:publicInstallationId,call_trace:tools.trace.snapshot(),resume:tools.resume.diagnostics(),tunnel_binary_hint:state.data.tunnel?.binary||slow.metadata.tunnelHint,credentials:slow.credentials,settings:setupSettings(),project:state.project(),...summary,task_stalls:taskStalls(),history,history_meta,release:{channel:'local-beta',install_ready:false,terminal_acceptance:'LOCAL_V06_BASELINE_PASS'},upgrade_pending:tools.upgradePending,upgrade_guard:slow.guard,lifecycle:{protocol:1,exit_requested:exitRequested},automation:{browser,computer},output_retention_status:queue.outputStatus(),jobs:local.map(j=>{const last_line=lastOutputLine(queue.jobs.get(j.job_id)?.events);return {...j,...(last_line?{last_line}:{})};}),inputs:[...queue.inputs.values()].filter(p=>p.status==='pending_approval'),connection,relay:relay.snapshot(),manifest:slow.metadata.manifest,connection_check:tools.lastCheck,readiness:readiness({connection,lastCheck:tools.lastCheck,enabled:policy.enabled,relay:relay.snapshot()}),last_calls:tools.lastCalls,node:process.execPath,platform:process.platform,terminal:{...slow.access.terminal,enabled:queue.enabled&&slow.access.terminal.available},not_os_sandbox:false,permissions:permissionsInfo(state,{adminReady:slow.access.adminReady}),high_risk_catalog:HIGH_RISK,blocks:tools.blocks.list(),confirmations:tools.confirmations.snapshot(),approvals:[...summary.approvals,...adminApprovals(local)],interface_protected:!!interfaceKey};
 }
 for(const [name,load] of Object.entries(eventLoaders))eventLoaders[name]=options=>{clientDeps.onEventLoad?.(name);return load(options);};
 const eventSource=createCachedStateSource({loaders:eventLoaders,readLive:readEventState,...(eventClock?{clock:eventClock}:{}),onChange:eventChanged});
 const eventCodexHome=isolated?path.join(localHome,'.codex'):process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
 const skillWatch=createSkillWatch({codexHome:eventCodexHome,...(eventClock?{clock:eventClock}:{}),onChange:file=>eventFileChanged(file,'skill',true)});
 function refreshSkillStatus(){eventSource.invalidate('skill');skillWatch.refresh();}
 function stopEventWatches(){skillWatch.stop();for(const watcher of eventWatchers)watcher.close();eventWatchers=[];}
 function eventFileChanged(file,block,fromNotification=false){
  let version='missing';try{const stat=fs.statSync(file);version=`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;}catch{}
  const previous=eventFileVersions.get(file);eventFileVersions.set(file,version);
  // Credential status may chmod its files: ctime/mode-only events are not
  // content changes and must not cause a read -> chmod -> read feedback loop.
  if(previous!==version&&(previous!==undefined||fromNotification)){if(block==='credentials')savedSetupBindings.clear();eventSource.invalidate(block);}
 }
 function startEventWatches(){
  function watch(dir,callback){try{const watcher=fs.watch(dir,callback);watcher.unref?.();eventWatchers.push(watcher);}catch{ /* Missing optional directory. */ }}
  const files={'upgrade-guard.json':'guard','credentials.json':'credentials','credentials.key':'credentials','credential-revision.json':'credentials','audit.jsonl':'support'};
  for(const [name,block] of Object.entries(files))eventFileChanged(path.join(stateDir,name),block);
  eventFileChanged(policy.receipts.dir,'history');
  watch(stateDir,(_kind,name)=>{name=String(name||'');if(files[name])eventFileChanged(path.join(stateDir,name),files[name],true);});
  watch(policy.receipts.dir,()=>{policy.receipts.invalidateDirectory();eventFileChanged(policy.receipts.dir,'history');eventSource.invalidate('history');});
  eventFileChanged(path.join(eventCodexHome,'skills/chathand-setup/SKILL.md'),'skill');skillWatch.start();
  if(!isolated&&adminAccess.supported())for(const [dir,name] of [['/Library/PrivilegedHelperTools','com.kenyu.chathand.admin'],['/private/etc/sudoers.d','chathand']]){const file=path.join(dir,name);eventFileChanged(file,'access');watch(dir,(_kind,changed)=>{if(String(changed)===name)eventFileChanged(file,'access',true);});}
 }
 stateEvents=createStateEvents({snapshot:eventSource.read,...(eventClock?{clock:eventClock}:{}),onActive:()=>{eventSource.activate();startEventWatches();},onIdle:()=>{stopEventWatches();eventSource.suspend();}});
 if(tools.valueStats)tools.valueStats.onChange=eventChanged;
 const planProbe=clientDeps.planProbe||(!isolated?new PlanProbe({lastAttempt:tools.valueStats?.data.probe.calibrated_at||0,initialProbe:tools.valueStats?.data.probe}):null);
 const probePlan=()=>{if(planProbe&&!closed)void planProbe.read().then(result=>{if(!closed)tools.valueStats?.setProbe(result);}).catch(()=>{});};
 const planTimer=planProbe?setInterval(probePlan,PROBE_INTERVAL_MS):null;planTimer?.unref?.();if(planProbe)setImmediate(probePlan);
 // Observe existing persistence methods locally, preserving their receivers,
 // return values and failures. Job output is sampled from memory, not reread.
 function afterSuccess(object,method,changed){const original=object[method];object[method]=function(...args){const value=original.apply(this,args);if(value&&typeof value.then==='function')return value.then(result=>{changed(args,result);return result;});changed(args,value);return value;};}
 let accessSignature=JSON.stringify([state.data.mode,state.data.active,state.data.terminal_enabled,state.data.high_risk?.admin]);
 let historyProject=state.data.active;
 afterSuccess(state,'save',()=>{const next=JSON.stringify([state.data.mode,state.data.active,state.data.terminal_enabled,state.data.high_risk?.admin]);if(next!==accessSignature){accessSignature=next;eventSource.invalidate('access');}if(historyProject!==state.data.active){historyProject=state.data.active;eventSource.invalidate('history');}eventChanged();});
 for(const method of ['set','remove'])afterSuccess(credentials,method,([section,value])=>{savedSetupBindings.set(section,method==='set'?credentialSetupBinding(section,value):null);eventSource.invalidate('credentials');});
 for(const method of ['save','saveRevocation'])afterSuccess(policy.receipts,method,()=>eventSource.invalidate('history'));
 afterSuccess(store,'audit',([entry])=>{if(entry?.event==='tool_error'||entry?.code)eventSource.invalidate('support');});
 afterSuccess(upgradeGuard,'commit',()=>eventSource.invalidate('guard'));
 afterSuccess(policy,'emit',eventChanged);
 afterSuccess(queue,'appendOutput',eventChanged);
 afterSuccess(queue,'record',eventChanged);
 afterSuccess(queue,'maintainOutputs',(_args,result)=>{if(result?.processed_now>0)eventChanged();});
 const eventSourceStatus=()=>({...eventSource.status(),watchers:eventWatchers.length+skillWatch.status().watchers,skill_watch:skillWatch.status()});
 function adminApprovals(jobs){return jobs.filter(j=>j.admin&&j.status==='pending_approval').map(j=>{const t=policy.tasks.get(policy.jobOwners.get(j.job_id));return {id:j.job_id,task_id:t?.id||null,kind:'admin',status:'pending_approval',command:[j.program,...j.args].join(' '),title:t?.title||null,created_at:j.created_at};});}
 // 1022：停住了的任务，ChatHand 窗口里也标出来（对话里的卡片是主，这里兜底）。
 function taskStalls(){const out={};for(const t of policy.tasks.values())if(t.status==='active')try{const v=tools.resume.stall(policy.view(t));if(v?.stalled)out[t.id]={since:v.last_at,last_tool:v.last_tool,basis:v.basis};}catch{}return out;}
 function setAccess(enabled,{persist=true,reason='paused',source,keepGrace=false}={}){
  if(typeof enabled!=='boolean')fail('ARG_INVALID','enabled 需要布尔值。');
  if(enabled&&tools.upgradePending)fail('UPGRADE_VERIFYING','应用正在完成升级自检，暂不执行 AI 操作。');
  tools.events?.record('access',{enabled,reason,source});
  if(!keepGrace){connectionGrace.reset(enabled?'user_resume':'user_stop');policy.connectionUnavailable=false;}
  if(!enabled)bHostProbes.invalidate();
  if(!enabled)try{relayKeeper.cancelAll(reason==='revoked'?'stopped':'paused');}catch{/* Permission revocation proceeds even if optional relay database is unavailable. */}
  const persistAccess=persist&&(accessPersistencePending||state.data.access_enabled!==enabled);
  if(persistAccess){state.data.access_enabled=enabled;accessPersistencePending=true;}
  // Grant only after saving; stop before saving so a disk error cannot retain authority.
  if(enabled&&persistAccess){state.save();accessPersistencePending=false;}
  const changed=policy.enabled!==enabled||store.paused!==!enabled||store.writesEnabled!==enabled;
  let revokeError=null;
  if(changed){
   policy.enabled=enabled;store.accessMode=state.data.mode;
   if(enabled)policy.fullArmed=state.data.mode==='full'&&state.data.full_access_confirmed===true;
   store.paused=!enabled;store.writesEnabled=enabled;
   if(!enabled){
    try{policy.revokeAll(reason,{source});}
    catch(e){revokeError=e;try{tools.events?.record('revoke_all',{reason,source:'persistence_failure',n:[...policy.tasks.values()].filter(t=>t.persistence_error).length});}catch{}}
    finally{policy.fullArmed=false;}
   }
  }
  // Keep a failed save pending even though the in-memory flag is already lowered.
  if(!enabled&&persistAccess){state.save();accessPersistencePending=false;}
  if(revokeError)throw revokeError;
  if(changed)policy.emit(enabled?'access_enabled':'access_disabled');
 }
 // One domain commit point for native and private-card answers. No separate grant store.
 async function commitConfirmation({id,scope,via,input:rawInput={},cardContext=null}={}){
  if(permissionChangePending||permissionRevocations.blocked)fail('PERMISSION_TRANSITION','权限正在切换，请查看原确认状态。');
  const c=tools.confirmations.validateAnswer(id,scope);
  if(via==='chat'){
   if(!cardContext||cardContext.request!=='permission:'+id||cardContext.task_id!==c.task_id||cardContext.caller!==c.caller||cardContext.session_hash!==c.session_hash||cardContext.epoch!==policy.epoch||cardContext.revision!==(policy.permissionRevision||0))fail('CONFIRM_NONCE_INVALID','此卡片已失效，请查看原任务状态或 ChatHand 窗口。');
  }else{
   if(!['window','notification'].includes(via))fail('ARG_INVALID','确认来源无效。');
   const input={human:rawInput.human===true};for(const k of ['window_age_s','hid_click_s','hid_key_s','source_pid'])if(rawInput[k]===null||Number.isFinite(rawInput[k]))input[k]=rawInput[k];
   if(scope!=='deny'&&input.human!==true){tools.confirmations.rejectInput(id,input);fail('CONFIRM_NOT_HUMAN','有一次点击没认出是你点的，没算数。请在 ChatHand 窗口亲自点确认。');}
   try{store.audit({event:'confirmation_input',id,task_id:c.task_id,via,scope,input});}catch{}
  }
  c.via=via;const ai_waiting=tools.confirmations.isWaiting(c.task_id),startEpoch=policy.epoch,startRevision=policy.permissionRevision||0;
  let r=tools.confirmations.answer(id,scope);
  if(r.apply){
   try{
    await handle(r.apply.route,r.apply.body,{confirmation:c});
    // Only this transaction's own revision/scope transition is expected.
    const expected={caller:c.caller,epoch:startEpoch+(c.gate==='scope'?1:0),revision:startRevision+1};
    tools.confirmations.validateCurrent(id,{applying:true,expected});
    recordPermissionOrigin(state,c.gate,c.item.id,via);state.save();
    r=tools.confirmations.completeApply(id,expected);
   }catch(e){
    const unknown=!['ADMIN_SETUP_CANCELLED','ARG_INVALID','PERMISSION_TRANSITION'].includes(e.code);tools.confirmations.failApply(id,{unknown});
    if(!unknown)throw e;
    return {ok:false,state:'unknown',result_line:displayText('card.confirmation.applyUnknown'),do_not_replay:true,ai_waiting};
   }
  }
  if(r.ok===true&&scope!=='deny')permissionHistory.append({action:'grant',gate:c.gate,id:c.item.id,name:permissionName(c.gate,c.item.id),scope,via,origin_since:state.data.permission_origins?.[c.gate+':'+c.item.id]?.since,conversation:permissionConversation(c.task_id)});
  return {...r,result_line:scope==='deny'?displayText('card.confirmation.deniedResult'):displayText('card.confirmation.allowedResult',{name:c.item.name}),ai_waiting};
 }
 tools.commitConfirmation=commitConfirmation;
 // Fixed, task-scoped adapters. A resume releases the stop, never replays old input.
 tools.registerCardAction('resume_browser',({task_id})=>{if(typeof tools.automation.browser.userResume!=='function')fail('CARD_ACTION_UNAVAILABLE','浏览器恢复入口暂不可用。');return tools.automation.browser.userResume(task_id,{scope:'browser'});});
 tools.registerCardAction('resume_desktop',({task_id})=>{if(typeof tools.automation.computer.userResume!=='function')fail('CARD_ACTION_UNAVAILABLE','桌面恢复入口暂不可用。');return tools.automation.computer.userResume(task_id,{scope:'desktop'});});
 tools.registerCardAction('stop_here',({task_id,scope})=>{if(!['browser','desktop'].includes(scope))fail('CARD_ACTION_UNAVAILABLE','这张卡片没有确定的控制目标。');const adapter=scope==='browser'?tools.automation.browser:tools.automation.computer;if(typeof adapter.userStop!=='function')fail('CARD_ACTION_UNAVAILABLE','停止入口暂不可用。');return adapter.userStop(task_id,{scope});});
 tools.registerCardAction('skip_step',()=>({ok:true})); // Choice is recorded; no underlying effect or permission change.

 for(const method of ['pair','pairV2']){
  const original=bPairing[method].bind(bPairing);
  bPairing[method]=(...args)=>{
   const generation=sitePairingGeneration;
   return onboarding.run('site_pair',async()=>{
    let result;try{result=await original(...args);}catch(error){watchEvent('rejected','PAIR_FAILED',error.code);if(generation===sitePairingGeneration&&siteTerminalErrors.has(error?.code))abandonSitePairing(error.code);throw error;}
    if(generation!==sitePairingGeneration)return {paired:false,error_code:'B_LIFECYCLE_CHANGED'};
    if(result?.paired===true){markSetupActivity('site-pair','site');stopSiteWatch('paired');if(state.data.setup_site_select_on_pair){selectConnectionRoute('site',{setup:true});delete state.data.setup_site_select_on_pair;state.save();}await completeSetup();}
    return result;
   },{classify:value=>value?.paired===true?{result:'ok',error_code:'NONE'}:{result:'pending',error_code:'PAIRING_PENDING'}});
  };
 }
 for(const method of ['run','clickByNumber']){const original=toolsRefresh[method].bind(toolsRefresh);toolsRefresh[method]=(...args)=>onboarding.run('tools_refresh',()=>original(...args),{source:'tools_refresh',classify:value=>value?.state==='refreshed'?{result:'ok',error_code:'NONE'}:{result:'unknown',error_code:'TOOLS_LIST_UNCONFIRMED'}});}
 const onboardingRoutes=new Map([['/api/setup/key','setup_connect'],['/api/setup/site','setup_site'],['/api/site-b/enrollment/import','setup_site'],['/api/site-b/enrollment/watch/import','setup_site']]);
 async function handle(route,d,options={}){
  const step=onboardingRoutes.get(route);
  if(!step)return handleObserved(route,d,options);
  if(step==='setup_site'){const end=onboarding.begin('site_deploy');end('unobservable','UNOBSERVABLE');}
  return onboarding.run(step,()=>handleObserved(route,d,options),{classify:value=>value?.phase==='pairing'?{result:'pending',error_code:'PAIRING_PENDING'}:{result:'ok',error_code:'NONE'}});
 }
 async function handleObserved(route,d,{startup=false,confirmation=null,windowAuthorized=false}={}){
  if(route.startsWith('/api/browser/extension/install/'))requireLegacyInstaller(chromeDistribution);
  if(route.startsWith('/api/matters/')&&!matterStore)
   fail(matterUnavailableCode||'MATTER_UNAVAILABLE','事项库记录无法核对，事项操作已暂停。');
  // The settings switch is the same revocation as the always-allowed list.
  // Enter before the outer settings lock so an explicit retry can finish a
  // previously uncertain removal even though the in-memory switch is now off.
  if(route==='/api/settings'&&Object.keys(d||{}).length===1&&d?.high_risk?.admin===false&&Object.keys(d.high_risk).length===1){
   validateSettingsBody(d);
   try{await permissionRevocations.revoke({gate:'common',id:'admin'});return {ok:true,permissions:permissionsInfo(state,{adminReady:adminReadyFor(state,adminAccess)})};}
   finally{eventChanged();}
  }
  const permissionWrite=route==='/api/permissions/tier'||route==='/api/mode'||route==='/api/projects/select'||route==='/api/settings'&&UI_ONLY_SETTINGS.some(k=>d?.[k]!==undefined);
  if(permissionWrite&&(permissionChangePending||permissionRevocations.blocked))fail('PERMISSION_TRANSITION','权限正在切换，请等当前操作完成。');
  if(permissionWrite){permissionChangePending=true;policy.permissionRevision=(policy.permissionRevision||0)+1;tools.confirmations.permissionsChanged(confirmation?.id);}
  try{switch(route){
  case'/api/permissions/tier':{const result=await applyPermissionTier({state,store,policy,adminAccess,revokeAdmin:()=>permissionRevocations.revoke({gate:'common',id:'admin'},{withinTransition:true}),home:isolated?path.dirname(stateDir):localHome},isolated&&d?.tier==='light'&&d.folder===undefined?{...d,folder:path.join(path.dirname(stateDir),path.basename(stateDir)+'-workspace')}:d);if(result.ok)permissionHistory.append({action:'tier',tier:d.tier,via:d.source==='home'?'home':'tier'});return {...result,permissions:permissionsInfo(state,{adminReady:adminReadyFor(state,adminAccess)})};}
  case'/api/onboarding/event':{
   const safe=onboardingFields(d);
   // Source and actor are evidence supplied only by the native owner, never a tool/body caller.
   if(!safe||safe.source!=='native'||!safe.observed_at||safe.actor!=='unknown'||!['setup_conversation','first_launch_guidance','permission_accessibility','permission_screen_recording'].includes(safe.step))fail('ARG_INVALID','Invalid onboarding metadata.');
   return {recorded:tools.events?.record('onboarding.step',safe)===true};
  }
  case'/api/ui/seen':return markUISeen(state,d.key);
  case'/api/matters/query':return matterStore.query(d,{project_id:state.data.active});
  case'/api/matters/selection':return matterStore.selection(d.ids);
  case'/api/matters/write':{
   if(!d||typeof d!=='object'||!Array.isArray(d.entries)||d.entries.some(e=>e?.task_id!==undefined))fail('MATTER_UI_SCOPE','事项窗口不能自行绑定或批准执行任务');
   return matterStore.write({request_id:d.request_id,entries:d.entries},{project_id:state.data.active,recorded_in:{kind:'native_window',project_id:state.data.active}});
  }
  case'/api/matters/purge':return matterStore.purge({confirmed:d.confirmed===true});
  case'/api/value/reset':return tools.valueStats?.reset()||{ok:true};
  case'/api/support/export':return exportDiagnostic(await snapshot(),recentErrors(stateDir),{...(isolated?{downloads:path.join(localHome,'Downloads')}:{}),onboarding:readOnboardingEvents(stateDir),chromeInstallTimeline:readChromeInstallEvents(stateDir),connectionTimeline:readConnectionTimeline(stateDir),resourceTimeline:readResourceTimeline(stateDir),nativeTimeline:readNativeTimeline(stateDir,{...(clientDeps.nativeAuditRoot!==undefined?{auditRoot:clientDeps.nativeAuditRoot}:{})})});
  case'/api/support/update':return updater.check();
  // 1050 refresh UI: native-window gesture only. Resolve the original tab exclusively from the server-owned refresh state.
  case'/api/refresh/return-existing-tab':{
   if(state.data.chatgpt_app_missing?.reason==='refresh_not_found')fail('CHATGPT_APP_MISSING','ChatGPT 里找不到这台 Mac 的 ChatHand 插件。');
   if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).length)fail('ARG_INVALID','返回已有页面不接受客户端提供的页面编号或地址。');
   if(permissionChangePending||permissionRevocations.blocked)fail('PERMISSION_TRANSITION','权限正在切换，不能带回浏览器页面。');
   const activePage=()=>{
    const tr=toolsRefresh.snapshot(),bring=tr?.bring_existing_tab;
    if(tr?.state!=='needs_user'||tr.confirmation!=='pending'||tr.clicked!==true||bring?.action!=='select'||bring.show!==true||bring.requires_user_request!==true
      ||typeof bring.page_id!=='string'||!/^[a-f0-9-]{36}:\d+$/.test(bring.page_id)
      ||typeof tr.url!=='string'||!tr.url.startsWith(PLUGINS_URL+'/')||tr.detail_url!==tr.url)
     fail('REFRESH_TAB_UNAVAILABLE','原来的 ChatGPT 刷新页面已不可确认；没有打开新页面，也没有重新刷新。');
    return bring.page_id;
   };
   const page=activePage();
   // The new task is strictly for selecting an existing managed Chrome tab; no navigation or refresh is allowed.
   const t=await tools.invoke('begin_task',{request_id:'refresh-return-'+crypto.randomUUID(),title:'回到已有 ChatGPT 页面',new_task:true},'chatgpt');
   if(!t?.task_id)fail('TASK_NOT_STARTED','没有创建出页面选择任务，不做任何浏览器操作。');
   let shown=false;
   try{
    if(permissionChangePending||permissionRevocations.blocked||activePage()!==page)fail('REFRESH_TAB_STALE','刷新确认页面已变化，没有带回任何页面。');
    const receipt=await tools.automation.browser.extension.withInternalControl(()=>tools.automation.browser.extension.tabs({
     task_id:t.task_id,request_id:'refresh-return-select-'+crypto.randomUUID(),action:'select',page_id:page,show:true
    },'chatgpt'))();
    shown=receipt?.selected===true&&receipt?.shown===true&&receipt?.page_id===page;
    if(!shown)fail('REFRESH_TAB_UNCONFIRMED','未能切换到原 ChatGPT 标签页，请手动切换。');
    return {selected:true,shown:true};
   }finally{
    try{await tools.invoke('finish_task',{task_id:t.task_id,success:shown,summary:shown?'已回到原 ChatGPT 标签页':'未能切换到原 ChatGPT 标签页'},'chatgpt');}catch{}
   }
  }
  case'/api/support/repair':return repair.start(d);
  case'/api/support/ai-brief':return aiBrief({snapshot:await snapshot(),errors:recentErrorCodes(stateDir),repair:repair.current(),appPath:appPath||pkg,osVersion:macOSVersion});
  case'/api/update/install':return updater.install(d.version);
  case'/api/update/dismiss':return updater.dismiss(d.version);
  case'/api/update/cancel':return updater.cancel();
  case'/api/update/ack':return updater.ack();
  case'/api/activity/bind':return bindActivity(policy,state,d);
  case'/api/setup/test/complete':if(!setupVerified())fail('SETUP_TEST_REQUIRED','请先完成这条连接的读写测试。');await completeSetup();return {...setupTestSnapshot(),setup_complete:true};
  case'/api/setup/test/start':{
   if(!d||typeof d!=='object'||Array.isArray(d)||!(Object.keys(d).length===0||Object.keys(d).join(',')==='restart'&&d.restart===true))fail('ARG_INVALID','配置活动参数无效。');
   const route=appRoutes.currentRoute(),entry=appRoutes.entry(route),before=appRoutes.snapshot(route);
   // Site probes own their challenge and durable fact. Starting a Site retest
   // must preserve the standby OpenAI proof and any in-flight OpenAI nonce.
   if(route==='openai')clearSetupTest();else{if(state.data.setup_complete)state.data.setup_ever_complete=true;state.data.setup_complete=false;}
   entry.chatgpt_app_retest_required=true;advanceSetupRetestRevision(route);
   try{state.save();}catch(error){appRoutes.restore(route,before);throw error;}
   const result=route==='site'?{route:'site',nonce:crypto.randomBytes(6).toString('hex'),expires_at:Date.now()+10*60*1000,expired:false,read:false,write:false,status:'not_received',verified:false}:tools.setupTest.start();
   markSetupActivity('test-start',route);return result;
  }
  case'/api/setup/chatgpt-app':{const before=JSON.stringify([state.data.chatgpt_app_identity,state.data.chatgpt_app_name]),result=rememberChatGPTApp(d);if(before!==JSON.stringify([state.data.chatgpt_app_identity,state.data.chatgpt_app_name]))markSetupActivity('bind-app',setupFacts.selectedRoute(state.data));return result;}
  case'/api/setup/activity':{if(!d||Object.keys(d).some(key=>!['command','route'].includes(key))||typeof d.command!=='string'||d.route!==undefined&&!['site','openai'].includes(d.route))fail('ARG_INVALID','配置活动参数无效。');return setupActivity.snapshot();}
  case'/api/network-challenge/notification/ack':{if(!d||Object.keys(d).join(',')!=='episode'||!Number.isSafeInteger(d.episode)||d.episode<1)fail('ARG_INVALID','配置活动参数无效。');return {acknowledged:networkChallengeNotice.acknowledgeNotification(d.episode)};}
  case'/api/site-b/replacement':{if(!d||Object.keys(d).join(',')!=='replacement_grant'||typeof d.replacement_grant!=='string'||d.replacement_grant.length<32||d.replacement_grant.length>4096||!/^[-_A-Za-z0-9]+$/.test(d.replacement_grant))fail('ARG_INVALID','配置活动参数无效。');const result=await bPairing.authorizeReplacement(d,{nativeUI:true});if(result?.paired===true)markSetupActivity('site-replace','site');return {paired:result?.paired===true,replacement_accepted:result?.paired===true,...(['site','openai'].includes(result?.selected)?{selected_route:result.selected}:{})};}
  case'/api/site-b/replacement-upgrade-failure':return bPairing.recordReplacementUpgradeFailure(d);
  case'/api/setup/switch':{const route=connectionRouteInput(d),result=await useConnection(route,{setup:true});if(!result.ok)fail(result.error_code,'连接尚未通过健康检查。');return result;}
  case'/api/connection/use':return useConnection(connectionRouteInput(d));
  case'/api/connection/remove':return removeConnection(connectionRouteInput(d));
  case'/api/setup/route':{if(!d||Object.keys(d).join(',')!=='route'||!['site','openai'].includes(d.route))fail('ARG_INVALID','配置路线无效。');const result=chooseSetupRoute(d.route);eventChanged();return result;}
  case'/api/site-b/enrollment/observe-prompt':{
   if(!d||Object.keys(d).join(',')!=='prompt_sha256'||typeof d.prompt_sha256!=='string'||!/^[a-f0-9]{64}$/.test(d.prompt_sha256))fail('ARG_INVALID','Site 建站提示词摘要无效。');
   const descriptor=bPairing.snapshot().verified_template_source,previousLocale=globalThis.ChatHandText?.locale||'zh';let matched=false;
   try{for(const locale of ['zh','en']){setPromptLocale({locale});for(const prompt of [siteCreationHandoff(descriptor).prompt,siteAssistedSentence(descriptor),siteTemplateFileFollowup(descriptor)])if(typeof prompt==='string'&&crypto.createHash('sha256').update(prompt).digest('hex')===d.prompt_sha256)matched=true;}}finally{setPromptLocale({locale:previousLocale});}
   if(!matched)return {armed:false};delete state.data.setup_site_watch_expired;return {armed:true,...startSiteWatch()};
  }
  case'/api/setup/site/network-check':{
   if(d===undefined)d={};
   if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).some(key=>key!=='force')||Object.hasOwn(d,'force')&&d.force!==true)fail('ARG_INVALID','网络检查参数无效。');
   return siteNetworkCheck({origin:siteNetworkOrigin(),force:d.force===true});
  }
  case'/api/setup/site/start':{
   if(bLocalStore.route('site').configured!==1)(await requireSiteNetworkForNewSetup())();
   if(typeof bPairing.startSitePairing!=='function')fail('B_PAIRING_START_UNAVAILABLE','Site 配对认证未完成，原有 OpenAI 连接和任务保持不变。');const descriptor=bPairing.startSitePairing();sitePairingGeneration++;chooseSetupRoute('site');
   delete state.data.setup_site_watch_expired;state.data.setup_site_select_on_pair=true;state.save();const handoff=siteCreationHandoff(descriptor);if(!handoff.configured)fail('B_TEMPLATE_UNVERIFIED','尚无可信 Site 模板。');const watch=startSiteWatch({newAttempt:true});markSetupActivity('site-start','site');return {route:'site',...enrollmentWatch(),watch_id:watch.watch_id,prompt:handoff.prompt,template_path:path.join(pkg,'site-template',descriptor.template_file),template_sha256:descriptor.template_sha256};}
  case'/api/setup/progress':{
   const step=Number(d.step);if(!Number.isInteger(step)||step<0||step>6)fail('ARG_INVALID','设置步骤无效。');
   if(d.tunnel_id!==undefined){if(!/^tunnel_[a-zA-Z0-9_-]{8,100}$/.test(d.tunnel_id))fail('TUNNEL_ID_INVALID','通道 ID 格式不正确。');if(state.data.setup_tunnel_id!==d.tunnel_id){clearSetupTest();delete state.data.setup_key_last4;}state.data.setup_tunnel_id=d.tunnel_id;}
   if(d.restart===true)clearSetupTest();
   const valid=setupVerified();
   if(step>=4&&!valid){state.save();fail('SETUP_TEST_REQUIRED','请先完成这条连接的读写测试。');}
   if(!state.data.setup_complete&&state.data.setup_ever_complete!==true&&step>=3&&d.app_name!==undefined){const name=appName(d.app_name);if(name)appRoutes.entry(appRoutes.currentRoute()).chatgpt_app_name=name;}
   state.data.setup_step=step;if(step===6)await completeSetup();state.save();return {step};}
  case'/api/setup/await-key':return keyWatch.start(d.tunnel_id);
  case'/api/setup/await-key/status':return keyWatch.request();
  case'/api/setup/await-key/cancel':return keyWatch.cancel(d.id);
  case'/api/setup/key':{
   if(typeof d.api_key!=='string'||d.api_key.length>8192||!KEY_PATTERN.test(d.api_key))fail('KEY_INVALID','请复制完整的运行密钥。');
   const config=validateSetup({tunnel_id:d.tunnel_id,runtime_key:d.api_key},state);chooseSetupRoute('openai');
   credentials.set('tunnel',config);const stored=credentials.get('tunnel');
   if(!stored||stored.tunnel_id!==config.tunnel_id||!eq(stored.api_key,config.api_key)||credentials.isCurrent?.(stored)===false)fail('CREDENTIAL_WRITE_VERIFY_FAILED','本地连接信息写入校验未通过。');
   markSetupActivity('connect','openai');keyWatch.received(config.tunnel_id,null,{allowUnwatched:true});
   let phase='connecting',connectionError=null;
   try{clearSetupTest();delete state.data.setup_key_last4;state.data.setup_tunnel_id=config.tunnel_id;state.save();const result=await handle('/api/connect',config);if(['idle','starting','connecting','reconnecting','running','ready','needs_login','needs_retry','offline','stopped'].includes(result?.phase))phase=result.phase;}
   catch(error){connectionError=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)?error.code:'CONNECTION_START_FAILED';}
   let configured=false,connected=false;try{const current=memoryConnection();configured=tunnel.tunnelId===config.tunnel_id&&eq(tunnel.key,config.api_key)&&current.ready===true&&current.healthy===true;connected=configured&&current.control_plane?.state!=='down';}catch{}
   return {saved:true,received:true,storage_verified:true,configured,connected,phase,status:connected?'CONNECTED':'CONNECTION_PENDING',reason_code:connected?'KEY_SAVED':'KEY_SAVED_CONNECTION_PENDING',...(connectionError?{connection_error_code:connectionError}:{})};
  }
  // First-time Site enrollment accepts the loopback owner's Bearer credential.
  // These routes remain outside ChatGPT MCP and require this installation's intent.
  case'/api/site-b/enrollment/watch':{
   if(!d||Object.keys(d).length)fail('ARG_INVALID','等待 Site 资料不接收参数。');
   if(!bPairing.snapshot().verified_template_source)fail('B_TEMPLATE_UNVERIFIED','尚无可信 Site 模板。');
   return startSiteWatch();}
  case'/api/site-b/enrollment/watch/stop':{
   if(!d||Object.keys(d).length)fail('ARG_INVALID','停止等待不接收参数。');
   abandonSitePairing('B_PAIRING_CANCELLED');return enrollmentWatch();}
  case'/api/site-b/enrollment/watch/event':{const allowed={started:['WATCH_STARTED'],stopped:['WATCH_STOPPED','WATCH_PAIRED','WATCH_EXPIRED','NO_PENDING'],accepted:['CODE_ACCEPTED'],rejected:['INVALID_FORMAT','INVALID_ORIGIN','NO_PENDING','WATCH_EXPIRED','PAIR_FAILED']};if(!allowed[d?.phase]?.includes(d.reason)||Object.keys(d).some(k=>!['phase','reason','error_code'].includes(k)))fail('ARG_INVALID','Site 诊断类别无效。');return {recorded:watchEvent(d.phase,d.reason,/^B_[A-Z0-9_]{1,60}$/.test(d.error_code||'')?d.error_code:undefined)===true};}
  case'/api/site-b/enrollment/watch/import':{
   if(!d||Object.keys(d).sort().join(',')!=='payload,watch_id'||typeof d.watch_id!=='string'){watchEvent('rejected','INVALID_FORMAT');fail('B_WATCH_EXPIRED','Site 资料等待已结束。');}
   if(!watchCurrent()||d.watch_id!==bSiteWatch.id){watchEvent('rejected',bSiteWatchStoppedReason==='expired'?'WATCH_EXPIRED':'NO_PENDING');fail('B_WATCH_EXPIRED','Site 资料等待已结束。');}
   const watchId=bSiteWatch.id;let result;try{result=await bPairing.importGrant(d.payload,{nativeUI:true});}catch(e){watchEvent('rejected',e.code==='B_ORIGIN_INVALID'?'INVALID_ORIGIN':e.code==='B_PAIRING_INPUT'?'INVALID_FORMAT':'PAIR_FAILED',e.code);throw e;}
   if(!watchCurrent()||bSiteWatch.id!==watchId)fail('B_WATCH_EXPIRED','Site 资料等待已结束。');
   if(['pairing','credential_updated'].includes(result.phase))markSetupActivity('site','site');
   bHostProbes.invalidate();if(result.phase==='pairing')void bPairing.pairV2().catch(()=>{});
   return result;}
  case'/api/site-b/paired-notice/dismiss':{
   if(!d||Object.keys(d).length!==1||typeof d.notice_id!=='string')fail('B_NOTICE_INVALID','连接提示编号无效。');
   return bLocalStore.dismissPairedNotice(d.notice_id,credentials);}
  case'/api/site-b/enrollment/import':{
   const result=await bPairing.importGrant(d,{nativeUI:true});
   if(['pairing','credential_updated'].includes(result.phase))markSetupActivity('site','site');
   bHostProbes.invalidate();if(result.phase==='pairing')void bPairing.pairV2().catch(()=>{});
   return result;}
  case'/api/setup/site':{
   if(!d||!['chathand-site-v2','chathand-site-v3'].includes(d.format))fail('B_SETUP_SITE_FORMAT','设置 Site 只接受新版资料。');
   bPairing.validateV2Input(d,{nativeUI:true});chooseSetupRoute('site');
   state.data.setup_site_select_on_pair=true;state.save();const result=await bPairing.importGrant(d,{nativeUI:true});if(['pairing','credential_updated'].includes(result.phase))markSetupActivity('site','site');
   if(result.phase==='credential_updated'){selectConnectionRoute('site',{setup:true});delete state.data.setup_site_select_on_pair;state.save();}
   if(result.phase==='pairing')void bPairing.pairV2().catch(()=>{});
   return {phase:result.phase,origin:result.origin};}
  case'/api/site-b/pair':if(!d||Object.keys(d).length)fail('ARG_INVALID','B 配对动作不接收客户端身份字段。');bHostProbes.invalidate();return ['2','3'].includes(bPairing.pending?.protocol_version)?bPairing.pairV2():bPairing.pair();
  case'/api/site-b/verify':if(!d||Object.keys(d).length)fail('ARG_INVALID','B 健康验证不接收客户端自报状态。');return bPairing.verifyHealth();
  case'/api/site-b/select':{const route=connectionRouteInput(d);if(route==='openai')abandonSitePairing('B_PAIRING_ABANDONED');return selectConnectionRoute(route);}
  case'/api/site-b/revoke':if(!d||Object.keys(d).length)fail('ARG_INVALID','撤销设备不接收客户端身份或凭据。');if(typeof bSiteTransport.revokeCurrent!=='function')fail('B_REVOKE_UNAVAILABLE','尚无可信设备撤销通道。');bPairing.cancelV2Recovery();bHostProbes.invalidate();return bSiteTransport.revokeCurrent();
  case'/api/setup/connect':{const result=await handle('/api/connect',validateSetup(d,state));if(!result.replayed)markSetupActivity('connect','openai');return result;}
  case'/api/setup/workspace':fs.accessSync(state.project().path,fs.constants.R_OK|fs.constants.W_OK);state.data.setup_workspace_confirmed=true;state.save();return {confirmed:true};
  case'/api/setup/skill':{
   if(d===undefined)d={};
   if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).some(key=>!['route','intent','locale'].includes(key))||d.intent!==undefined&&!['setup','repair','add'].includes(d.intent)||d.locale!==undefined&&!['zh','en'].includes(d.locale)||d.route!==undefined&&!['site','openai'].includes(d.route))fail('ARG_INVALID','配置活动参数无效。');
   const intent=d.intent||'setup';
   const route=setupRouteSelection({explicit:d.route??(setupFacts.selectedRoute(state.data)==='none'?undefined:setupFacts.selectedRoute(state.data)),selection:bLocalStore.selection(),openai:bLocalStore.route('openai'),site:bLocalStore.route('site'),state:state.data});
   if(route==='site'&&intent!=='repair'&&bLocalStore.route('site').configured!==1)(await requireSiteNetworkForNewSetup())();
   return onboarding.run('setup_skill',()=>{
    if(d.route!==undefined&&intent!=='repair')chooseSetupRoute(d.route);
    const handoff=setupHandoff({appPath,route,intent,locale:d.locale,siteOrigin:route==='site'?bLocalStore.siteOrigin(credentials):null}),installed=installSkill(isolated?{home:localHome,codexHome:path.join(localHome,'.codex')}:{});
    const setup_skill=setupSkillStatus(isolated?{codexHome:path.join(localHome,'.codex')}:{});refreshSkillStatus();return {...installed,...handoff,setup_skill};
   },{classify:value=>value?.phase==='pairing'?{result:'pending',error_code:'PAIRING_PENDING'}:{result:'ok',error_code:'NONE'}});
  }
  case'/api/setup/skill/remove':return removeSetupSkill();
  case'/api/browser/extension/install/profiles':{if(state.data.browser_enabled!==true)fail('INSTALL_ACCESS_CHANGED','Chrome 插件的安装已停止；请查看当前状态，不要重复原来的点击。');return explicitBrowserInstallation(()=>d.discovery_only===true?{observe_allowed:true}:chromeInstall.observeProfiles(d.observed_profile_ids));}
  case'/api/browser/extension/install/start':{
   if(state.data.browser_enabled!==true)fail('INSTALL_ACCESS_CHANGED','Chrome 插件的安装已停止；请查看当前状态，不要重复原来的点击。');
   const profileID=explicitBrowserInstallation(()=>chromeInstall.chooseObservedProfile(d.profile_id));
   const lease=chromeInstall.begin(profileID,{attempt_id:d.attempt_id});try{await registerCurrentBrowserHost();const guard=()=>{if(!chromeInstall.publicStatus(lease.lease_id).active)fail('INSTALL_STOPPED','Chrome installation stopped.');};guard();const copy=publishHelper({root:chromeInstallRoot,home:localHome,guard,distribution:chromeDistribution});const metadata=chromeInstall.setFolder(lease.lease_id,copy.folder);state.data.chrome_install_profile=profileID;state.save();return {...metadata,profile_id:profileID};}catch(e){chromeInstall.cancel(lease.lease_id,e.code);throw e;}
  }
  case'/api/browser/extension/install/evidence':return chromeInstall.evidence(d,stateDir);
  case'/api/browser/extension/install/progress':return chromeInstall.progress(d.lease_id,d.stage,d);
  case'/api/browser/extension/install/status':return chromeInstall.publicStatus(d.lease_id,d.attempt_id);
  case'/api/browser/extension/install/verify':return chromeInstall.verify(d.lease_id);
  case'/api/browser/extension/install/finish':return chromeInstall.finish(d);
  case'/api/browser/extension/install/cancel':return chromeInstall.cancel(d.lease_id,d.code,d.attempt_id);
  case'/api/browser/extension/store/status':return storeStatus();
  case'/api/browser/extension/store/cancel':{
   if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).length)fail('ARG_INVALID','Store cancel does not accept arguments.');
   storePreparation++;return {cancelled:true,...storeStatus()};
  }
  case'/api/browser/extension/prepare':{
   if(storeMode(chromeDistribution)){
    if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).some(k=>k!=='profile_id'))fail('ARG_INVALID','Store preparation accepts only profile_id.');
    const fields={...chromeDistribution,config_state:chromeDistribution.configuration_state,store_ready:chromeDistribution.configuration_state==='ready',profiles:[],selected_profile:null};
    if(!fields.store_ready)return {...fields,registered:false,error:{code:'CHROME_STORE_CONFIGURATION_PENDING'}};
    const generation=++storePreparation,epoch=policy.epoch,revision=policy.permissionRevision||0;
    const guard=()=>{
     policy.check();
     if(generation!==storePreparation||tools.upgradePending||permissionChangePending||permissionRevocations.blocked||policy.transitioning||!capabilityOn(state,'browser')||(state.data.browser_enabled!==true&&!(windowAuthorized&&state.data.browser_enabled===undefined))||epoch!==policy.epoch||revision!==(policy.permissionRevision||0))fail('INSTALL_ACCESS_CHANGED','Chrome store preparation was cancelled or changed.');
    };
    guard();rememberBrowserOptIn({defaultEnabled:windowAuthorized});
    const profiles=chromeStoreProfiles({home:localHome,profile_id:d.profile_id});
    // An explicit owner preparation can recheck access; only successful registration clears the denial.
    guard();const registration=await registerCurrentBrowserHost({guard,retryAfterPermission:true});guard();
    if(registration.registered!==true)return {...fields,...profiles,registered:false,error:{code:registration.code||'CHROME_STORE_HOST_UNAVAILABLE'}};
    return {...fields,...profiles,registered:true};
   }
   // Explicit legacy test interface only; shipped store configuration never enters it.
if(windowAuthorized&&state.data.browser_enabled===true&&!tools.upgradePending)rememberBrowserOptIn();const result=await registerCurrentBrowserHost({retryAfterPermission:d?.retry_after_permission===true});if(result.skipped)return result;const guard=()=>{if(!browserControlOptedIn(state.data)||tools.upgradePending)fail('INSTALL_ACCESS_CHANGED','Chrome 插件的安装已停止；请查看当前状态，不要重复原来的点击。');};guard();const copy=publishHelper({root:chromeInstallRoot,home:localHome,guard,distribution:chromeDistribution});return {...result,extension_folder:copy.folder};
  }
  case'/api/browser/extension/reconnect':{
   if(storeMode(chromeDistribution))requireStoreConfiguration(chromeDistribution);
   const extension=tools.automation.browser.extension;
   // Checking is not first consent. Do not even stat Chrome/helper files here.
   if(!browserControlOptedIn(state.data))return extension.reconnect({recheckOnly:true});
   const epoch=policy.epoch,revision=policy.permissionRevision||0;
   const guard=()=>{
    if(tools.upgradePending)fail('UPGRADE_VERIFYING','应用正在完成升级自检，暂不执行 AI 操作。');
    policy.check();
    if(!executionResumeAllowed||permissionChangePending||permissionRevocations.blocked||policy.transitioning||!browserControlOptedIn(state.data)||epoch!==policy.epoch||revision!==(policy.permissionRevision||0))fail('INSTALL_ACCESS_CHANGED','Chrome 插件的安装已停止；请查看当前状态，不要重复原来的点击。');
   };
   guard();
   // Only the permission-settings recovery route can clear a denied latch.
   await registerCurrentBrowserHost({flow:'reconnect',guard});
   guard();
   // 1081（Claude，Ken 10/27 10:07）：应用店装的插件连不上时点「再试一次」：先照旧让插件重连，再跟 AI 要用浏览器时一样，在后台打开 Chrome、等插件连上（刚失败过也再试）。
   const wasConnected=extension.status().connected===true,result=extension.reconnect();
   if(storeMode(chromeDistribution)&&!wasConnected&&typeof extension.wakeChrome==='function'){await extension.wakeAndWait({force:true});guard();return {...result,woken:true,...extension.status()};}
   return result;
  }
  case'/api/browser/extension/stop':return tools.automation.browser.extension.close();
  case'/api/computer/heartbeat':{
   const before=JSON.stringify([tools.automation.computer.status(),computerSetupStatus]);
   computerSetupStatus={accessibility:d.accessibility===true,screen_recording:d.screen_recording===true,needs_restart:d.needs_restart===true,step:['idle','accessibility','screen_recording','complete'].includes(d.step)?d.step:'idle'};
   const result=tools.automation.computer.heartbeat(d);
   if(before!==JSON.stringify([tools.automation.computer.status(),computerSetupStatus]))eventChanged();
   return result;}
  case'/api/computer/next':{
   const before=tools.automation.computer.status().native_online,result=tools.automation.computer.next();
   if(before!==tools.automation.computer.status().native_online)eventChanged();
   return result;}
  case'/api/computer/authorize':tools.automation.computer.authorize(d.id);return {authorized:true};
  case'/api/computer/result':return tools.automation.computer.complete(d.id,d.result);
  case'/api/automation/stop':{tools.artifacts.cancelAll();executionResumeAllowed=false;let revokeError=null;try{setAccess(false);}catch(e){revokeError=e;}await tools.automation.close();if(revokeError)throw revokeError;return {stopped:true};}
  case'/api/automation/browser':{if(state.data.browser_backend!=='isolated')return tools.automation.browser.personal.startConnect();const t=await tools.invoke('begin_task',{request_id:'local-browser-'+crypto.randomUUID(),title:'打开工作浏览器'},'chatgpt');const tabs=await tools.invoke('browser_tabs',{task_id:t.task_id,request_id:'local-browser-tabs-'+crypto.randomUUID(),action:'list'},'chatgpt');await tools.invoke('finish_task',{task_id:t.task_id,success:true},'chatgpt');return tabs;}
  case'/api/upgrade/commit':return finishUpgrade();
  case'/api/lifecycle/quit':try{relayKeeper.cancelAll('stopped');}catch{}exitRequested=true;return {accepted:true};
  case'/api/browser/select':return tools.automation.browser.setBackend(d.backend);
  case'/api/browser/personal/connect':if(tools.upgradePending)fail('UPGRADE_VERIFYING','升级验证期间不连接浏览器。');return tools.automation.browser.personal.startConnect();
  case'/api/browser/personal/disconnect':return tools.automation.browser.personal.close();
  case'/api/connect':{if(relay.worker||relay.flow)fail('OTHER_CONNECTION_ACTIVE','请先断开另一条连接。');const {resume_access,...config}=d;
   if(!config.api_key)return resumeConnection(()=>restoreTunnel({restart:true}));
   clearSetupTest();state.save();const result=resumeConnection(()=>controller.configureAndConnect(config));if(!result.replayed)pendingCredentials={tunnel_id:tunnel.tunnelId,binary:tunnel.binary,api_key:config.api_key};return result;}
  case'/api/connect/restore':return resumeConnection(()=>restoreTunnel({restart:true}));
  case'/api/files/list':policy.check();return store.list(d.path||'.');
  case'/api/files/read':policy.check();return tools.features.reader.read({path:d.path,offset:d.offset||0,fingerprint:d.fingerprint,max_bytes:32768,limit:50});
  // 1025：撤销一个任务的文件改动，只有窗口里点才行（UI_ONLY）。dry_run 只看会退几处。
  case'/api/task/undo':{const r=undoTask({taskId:d.id,policy,store,changes:tools.features.changes,dryRun:d.dry_run===true});if(!d.dry_run)policy.emit('task_undone',{task_id:d.id,done:r.done.length,skipped:r.skipped.length});return r;}
  case'/api/artifacts/authorize-open':return tools.artifacts.authorizeOpen(d);
  case'/api/artifacts/thumbnail':return tools.artifacts.thumbnail(d);
  case'/api/task-changes':return d.operation_id?tools.features.changes.preview(d.id,d.operation_id):{changes:tools.features.changes.read(d.id)};
  case'/api/diagnostics/start':return tools.trace.startObservation();
  case'/api/diagnostics/end':return tools.trace.endObservation(d.id);
  case'/api/diagnostics/export':return {trace:tools.trace.snapshot(),events:tools.trace.entries,onboarding:readOnboardingEvents(stateDir),chrome_install:readChromeInstallEvents(stateDir),connection_timeline:readConnectionTimeline(stateDir),resource_timeline:readResourceTimeline(stateDir),native_timeline:readNativeTimeline(stateDir,{...(clientDeps.nativeAuditRoot!==undefined?{auditRoot:clientDeps.nativeAuditRoot}:{})}),privacy:'No payloads, headers or tokens. Local observations only.'};
  case'/api/relay/pair':if(controller.desired||tunnel.child||tunnel.doctorChild)fail('OTHER_CONNECTION_ACTIVE','请先断开私人通道。');clearSetupTest();executionResumeAllowed=true;tools.lastCheck=null;state.data.connection_preference='relay';state.data.auto_connect=true;state.save();relayDesired=true;relayReady=false;setAccess(false,{persist:false});try{return await relay.pair(d.base_url);}catch(e){relayDesired=false;throw e;}
  case'/api/relay/stop':return stopRelay();
  case'/api/relay/forget':return stopRelay({forget:true});
  case'/api/relay/restore':if(controller.desired||tunnel.child||tunnel.doctorChild)fail('OTHER_CONNECTION_ACTIVE','请先断开私人通道。');if(!startup&&!selectedSite())executionResumeAllowed=true;tools.lastCheck=null;{const saved=Object.keys(d||{}).length?d:credentials.get('relay');if(!saved)fail('SAVED_CONNECTION_MISSING','首次连接，请登录一次。');if(Object.keys(d||{}).length||state.data.connection_preference!=='relay'&&state.data.setup_test_proof?.transport!=='relay')clearSetupTest();state.data.connection_preference='relay';state.data.auto_connect=true;state.save();relayDesired=true;relayReady=false;if(!selectedSite())setAccess(false,{persist:false});try{return await relay.restore(saved);}catch(e){relayDesired=false;throw e;}}
  case'/api/relay/credentials':return {credentials:relay.credentials()};
  case'/api/access':if(typeof d.enabled!=='boolean')fail('ARG_INVALID','enabled 需要布尔值。');executionResumeAllowed=d.enabled;await setAccess(d.enabled,{source:'user'});if(d.enabled){if(selectedSite()){reconcileSelectedSiteAccess();if(bSiteTransport.status?.().phase==='unconfigured_or_stopped'&&credentials.get('site_b'))await bPairing.verifyHealth();}else if(relayDesired&&(relay.worker||relay.flow||relay.snapshot().online))linkAccess('relay',relay.snapshot().online===true,{auth:relay.snapshot().status==='login_required'});else if(controller.desired&&tunnel.child)linkAccess('tunnel',controller.phase==='ready'&&!!tunnel.child,{auth:controller.phase==='needs_login'});else if(state.data.connection_preference==='relay'&&credentials.get('relay'))await handle('/api/relay/restore',{});else if(state.data.tunnel||credentials.get('tunnel'))await resumeConnection(()=>restoreTunnel({restart:true}));}return {ok:true};
  case'/api/mode':if(confirmation?.gate==='scope'){await policy.modeFromConfirmation(d.mode,policy.get(confirmation.task_id),()=>tools.confirmations.validateCurrent(confirmation.id,{applying:true,expected:{caller:confirmation.caller,epoch:confirmation.epoch+1,revision:confirmation.revision+1}}));}else if(d.mode!==state.data.mode)await policy.setMode(d.mode,d.confirm);state.data.permission_tier_intent='custom';state.save();if(d.mode==='full'){recordPermissionOrigin(state,'scope','full',confirmation?.via||'settings');state.save();}if(d.mode==='full')void warmFullEnvironment();return {ok:true};
  case'/api/projects/add':if(d.scope==='computer'&&d.confirm!==true)fail('FULL_DISK_CONFIRM_REQUIRED','选择整台电脑需要明确确认。');return state.addProject(d);
  case'/api/projects/select':{const p=state.data.projects.find(p=>p.id===d.id);if(!p)fail('PROJECT_MISSING','找不到项目。');if(queue.list().some(j=>j.process_alive||j.cleanup_pending))fail('JOBS_RUNNING','请先停止运行中的任务，再切换项目。');policy.revokeAll('workspace_changed');store.setRoot(p.path);store.writesEnabled=policy.enabled;state.data.active=p.id;state.data.permission_tier_intent='custom';state.save();return {project:p};}
  case'/api/projects/remove':if(d.id===state.data.active)fail('PROJECT_ACTIVE','先切换到其他项目。');if(!state.data.projects.some(p=>p.id===d.id))fail('PROJECT_MISSING','找不到项目。');state.data.projects=state.data.projects.filter(p=>p.id!==d.id);state.data.conversations=state.data.conversations.filter(c=>c.project_id!==d.id);state.save();return {ok:true,files_untouched:true};
  case'/api/conversations/add':return state.addConversation(d);
  case'/api/conversations/remove':state.removeConversation(d.id);return {ok:true};
  case'/api/tasks/approve':return policy.approve(d.id,{minutes:d.minutes??30});
  case'/api/tasks/reject':policy.revokeTask(policy.get(d.id),'rejected');return {ok:true};
  case'/api/tasks/stop':policy.revokeTask(policy.get(d.id),'cancelled');return {ok:true};
  case'/api/actions/approve':return policy.approveAction(d.id);
  case'/api/actions/reject':{const a=policy.approvals.get(d.id);if(!a||a.status!=='pending_approval')fail('APPROVAL_STATE','操作已经处理。');a.status='rejected';return {ok:true};}
  case'/api/jobs/approve':policy.require(policy.jobOwners.get(d.id));return runManualSiteApproval(()=>queue.approve(d.id));
  case'/api/jobs/reject':return queue.deny(d.id);
  case'/api/jobs/cancel':return queue.cancel(d.id);
  case'/api/jobs/result':return queue.result(d.id,0,d.cursor);
  case'/api/inputs/approve':{const p=queue.inputs.get(d.id);if(!p)fail('INPUT_MISSING','找不到输入。');policy.require(policy.jobOwners.get(p.job_id));return runManualSiteApproval(()=>queue.approveInput(d.id));}
  case'/api/inputs/reject':return queue.denyInput(d.id);
  case'/api/settings':{const {clientPatch,valuePatch}=validateSettingsBody(d),previousSkin={skin:state.data.skin,skin_revision:state.data.skin_revision},previousZoom=state.data.ui_zoom;if(d.relay_pilot_enable!==undefined){if(d.relay_pilot_enable===false)try{relayKeeper.cancelAll('disabled');}catch{}pilot.setPilotEnabled(d.relay_pilot_enable);relayKeeper.installationEligible=pilot.eligible()&&!relayKeeper.circuitOpen;}
   if(d.keep_awake!==undefined){if(typeof d.keep_awake!=='boolean')fail('ARG_INVALID','保持唤醒选项错误。');state.data.keep_awake=d.keep_awake;}if(d.last_seen_version!==undefined){if(d.last_seen_version!==VERSION)fail('VERSION_INVALID','版本标记无效。');state.data.last_seen_version=VERSION;}if(d.auto_approve_tasks!==undefined)fail('PERMISSION_MODEL_CHANGED','自动执行由两档权限统一管理。');if(d.auto_connect!==undefined){if(typeof d.auto_connect!=='boolean')fail('ARG_INVALID','自动连接选项错误。');state.data.auto_connect=d.auto_connect;}if(d.auto_approve_tasks!==undefined){if(typeof d.auto_approve_tasks!=='boolean')fail('ARG_INVALID','自动执行选项错误。');policy.revokeAll('permission_changed');state.data.auto_approve_tasks=d.auto_approve_tasks;}if(d.notifications!==undefined){if(typeof d.notifications!=='boolean')fail('ARG_INVALID','通知选项错误。');state.data.notifications=d.notifications;}if(d.browser!==undefined){if(!['chrome','safari','default'].includes(d.browser))fail('ARG_INVALID','浏览器选项错误。');state.data.browser=d.browser;}if(d.onboarding!==undefined)state.data.onboarding=d.onboarding===true;
   const off=[],capabilityChanges={};for(const id of CAPABILITY_IDS){const k=CAPABILITIES[id].key;if(d[k]===undefined)continue;if(typeof d[k]!=='boolean')fail('ARG_INVALID',`「${CAPABILITIES[id].name}」开关需要布尔值。`);if(state.data[k]!==false&&d[k]===false)off.push(id);capabilityChanges[k]=d[k];}
   if(d.high_risk!==undefined){if(!d.high_risk||typeof d.high_risk!=='object'||Array.isArray(d.high_risk))fail('ARG_INVALID','高危命令设置错误。');for(const [id,v] of Object.entries(d.high_risk)){if(!HIGH_RISK_IDS.includes(id))fail('ARG_INVALID','没有这一项高危命令。');if(typeof v!=='boolean')fail('ARG_INVALID','高危命令开关需要布尔值。');}if(d.high_risk.admin===false)await permissionRevocations.revoke({gate:'common',id:'admin'},{withinTransition:true});const before=normalizeSwitches(state.data.high_risk);if(d.high_risk.admin===true&&adminAccess.supported()&&(!before.admin||!adminAccess.ready({fresh:true}))){const wasReady=adminAccess.ready({fresh:true});
    const cleanupNewRule=async()=>{if(wasReady!==false)return;try{if(adminAccess.ready({fresh:true})!==true)return;await adminAccess.uninstall('confirmation_install_incomplete');if(adminAccess.ready({fresh:true})!==false)store.audit({event:'confirmation_cleanup_unknown',code:'ADMIN_CLEANUP_UNKNOWN'});}catch{try{store.audit({event:'confirmation_cleanup_unknown',code:'ADMIN_CLEANUP_UNKNOWN'});}catch{}}};
    state.data.setup_open_status={...state.data.setup_open_status,admin:'waiting'};let r;try{r=await adminAccess.install();}catch(e){await cleanupNewRule();state.data.setup_open_status.admin='todo';state.save();throw e;}
    if(confirmation){try{tools.confirmations.validateCurrent(confirmation.id,{applying:true,expected:{caller:confirmation.caller,epoch:confirmation.epoch,revision:confirmation.revision+1}});}catch(e){
     // A late external install is not a late permission grant. Remove only this adapter's newly installed rule where absence before installation was established.
     await cleanupNewRule();
     state.data.setup_open_status.admin='todo';state.save();throw e;
    }}
    if(r.status!=='installed'){await cleanupNewRule();state.data.setup_open_status.admin=r.status==='cancelled'?'cancelled':'todo';state.save();const e=Error(r.message||'管理员权限没有打开。');e.code=r.status==='cancelled'?'ADMIN_SETUP_CANCELLED':'ADMIN_SETUP_FAILED';throw e;}delete state.data.setup_open_status.admin;}if(confirmation)tools.confirmations.validateCurrent(confirmation.id,{applying:true,expected:{caller:confirmation.caller,epoch:confirmation.epoch,revision:confirmation.revision+1}});state.data.high_risk={...before,...d.high_risk};if(d.high_risk.admin!==undefined){state.data.admin_requested=d.high_risk.admin;if(d.high_risk.admin===false&&state.data.setup_open_status)delete state.data.setup_open_status.admin;}for(const [id,v] of Object.entries(d.high_risk))if(before[id]!==v)try{store.audit({event:'high_risk_switch',id,enabled:v});}catch{}}
   for(const [id,v] of Object.entries(d.high_risk||{}))if(v===true)recordPermissionOrigin(state,['admin','autostart'].includes(id)?'common':'high_risk',id,confirmation?.via||'settings');
   for(const id of CAPABILITY_IDS)if(capabilityChanges[CAPABILITIES[id].key]===true)recordPermissionOrigin(state,'capability',id,confirmation?.via||'settings');
   if(Object.keys(capabilityChanges).length||d.high_risk!==undefined)try{relayKeeper.cancelAll('authority_changed');}catch{}
   Object.assign(state.data,capabilityChanges,clientPatch,valuePatch);if(Object.keys(capabilityChanges).length||d.high_risk!==undefined)state.data.permission_tier_intent='custom';if(d.skin!==undefined)state.data.skin_revision++;
   for(const id of CAPABILITY_IDS)if(d[CAPABILITIES[id].key]===false)tools.confirmations.revoke('capability',id);
   for(const [id,v] of Object.entries(d.high_risk||{}))if(v===false)tools.confirmations.revoke(id==='autostart'?'common':'high_risk',id);
   // Switching a capability off stops what is running in that category right away.
   for(const id of off){try{if(id==='terminal')queue.cancelAll();else if(id==='browser')void tools.automation.browser.closeAll({reason:'browser_disabled'}).catch(()=>{});else if(id==='desktop')tools.automation.computer.cancelAll();}catch{}}
   // Revocation and in-flight cancellation must survive a failed settings save.
   try{state.save();}catch(e){if(d.skin!==undefined)Object.assign(state.data,previousSkin);if(d.ui_zoom!==undefined)state.data.ui_zoom=previousZoom;throw e;}if(d.browser_enabled===true)rememberBrowserOptIn();updater.settingsChanged();
   if(Object.keys(capabilityChanges).length||d.high_risk!==undefined)policy.emit('permissions_changed');
   return {ok:true,permissions:permissionsInfo(state,{adminReady:adminReadyFor(state,adminAccess)}),...(d.ui_zoom!==undefined?{ui_zoom:state.data.ui_zoom}:{}),...(d.skin!==undefined?{skin:state.data.skin,skin_revision:state.data.skin_revision}:{})};}
  case'/api/tunnel/configure':tunnel.configure(d);clearSetupTest();state.data.tunnel={tunnel_id:d.tunnel_id,binary:tunnel.binary};state.save();return {ok:true};
  case'/api/permissions/revoke':{const result=await permissionRevocations.revoke(d);if(result.ok&&result.changed)permissionHistory.append({action:'revoke',gate:d.gate,id:d.id,name:permissionName(d.gate,d.id),via:'window'});return result;}
  case'/api/permissions/undo-info':return permissionRevocations.describe(d?.receipt_id);
  case'/api/permissions/undo':{const result=await permissionRevocations.undo(d);if(result.ok&&result.restored)permissionHistory.append({action:'restore',via:'window'});return result;}
  case'/api/checkpoint/action':return tools.commitCheckpoint(d);
  case'/api/confirm/answer':{
   if(typeof d?.id!=='string'||!/^cf_[a-f0-9]{16}$/.test(d.id)||!['window','notification'].includes(d.via))fail('ARG_INVALID','确认需要有效编号和原生输入来源。');
   return commitConfirmation(d);
  }
  case'/api/blocks/dismiss':return tools.blocks.dismiss(d.id);
  case'/api/tunnel/doctor':{if(tunnel.child){const c=await inspectConnection(),cp=c.control_plane||null;return {ok:c.display?.connected===true,display:c.display,status:'running',live:true,healthy:!!c.healthy,ready:!!c.ready,control_plane:cp,checked_at:Date.now(),log:tunnel.log.slice(-20)};}return tunnel.doctor();}
  case'/api/tunnel/start':if(relay.worker||relay.flow)fail('OTHER_CONNECTION_ACTIVE','请先断开账号连接。');return resumeConnection(()=>controller.configureAndConnect());
  case'/api/tunnel/stop':return stopTunnel();
  case'/api/tunnel/forget':if(tunnel.child||tunnel.doctorChild)fail('TUNNEL_RUNNING','请先断开。');await stopTunnel();tunnel.key='';credentials.remove('tunnel');clearSetupTest();state.data.tunnel=null;state.save();return {ok:true};
  case'/api/shutdown':setTimeout(()=>{void close().catch(e=>console.error(JSON.stringify(cleanError(e))));},50);return {ok:true};
  default:fail('API_UNKNOWN','未提供该管理操作。');}}catch(error){if(['/api/setup/site','/api/site-b/enrollment/import','/api/site-b/enrollment/watch/import','/api/site-b/replacement'].includes(route)&&siteTerminalErrors.has(error?.code))abandonSitePairing(error.code);throw error;}finally{if(permissionWrite)permissionChangePending=false;if(route!=='/api/computer/heartbeat'&&route!=='/api/computer/next')eventChanged();}}
 const api=http.createServer(async(req,res)=>{try{
  if(req.headers.host!==`127.0.0.1:${apiPort}`||(req.headers.origin&&req.headers.origin!==`http://127.0.0.1:${apiPort}`))return send(res,403,{error:'ORIGIN_REJECTED'});
  const assetRoute=(req.url||'').split('?')[0];
  if(req.method==='GET'&&req.url?.startsWith('/api/browser/extension/install/probe/')){
   if(req.headers.origin)return send(res,403,{error:'ORIGIN_REJECTED'});
   const page=chromeInstall.page(req.url);if(!page)return send(res,404,{error:'NOT_FOUND'});
   res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
   res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');return send(res,200,page,'text/html; charset=utf-8');
  }
  if(req.method==='GET'&&/^\/assets\/(tutorial|app)\/[a-zA-Z0-9_.-]+$/.test(assetRoute)){const file=path.join(pkg,'ui',assetRoute);if(fs.existsSync(file)&&fs.statSync(file).isFile()){const ext=path.extname(file);const type={'.json':'application/json','.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml'}[ext];if(type)return send(res,200,fs.readFileSync(file),type);}}
  if(req.method==='GET'&&assetRoute.startsWith('/h10/assets/')){
   const segments=assetRoute.slice(1).split('/'),types={'.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg'};
   if(segments.length>=3&&segments.every(part=>/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))){
    const root=path.join(pkg,'ui','h10','assets'),file=path.join(pkg,'ui',...segments),type=types[path.extname(file)];
    if(type&&fs.existsSync(file)&&fs.lstatSync(file).isFile()&&fs.realpathSync(file).startsWith(fs.realpathSync(root)+path.sep))
     return send(res,200,fs.readFileSync(file),type);
   }
   return send(res,404,{error:'NOT_FOUND'});
  }
  if(req.method==='GET'&&STATIC_FILES.has(assetRoute)){res.setHeader('Content-Security-Policy',STATIC_CSP);const [f,type]=STATIC_FILES.get(assetRoute);let body=fs.readFileSync(path.join(pkg,'ui',f),'utf8');if(assetRoute==='/')body=body.replace(/<html(?=[\s>])/,'<html data-skin-saved="'+clientSettings(state.data).skin+'"');return send(res,200,body,type);}
  if(req.method==='GET'){const id=/^\/skins\/([a-z0-9][a-z0-9-]{0,31})\.css$/.exec(assetRoute)?.[1],file=skinFile(id);if(file){res.setHeader('Content-Security-Policy',STATIC_CSP);return send(res,200,fs.readFileSync(file,'utf8'),'text/css; charset=utf-8');}}
  if(req.method==='GET'){const id=/^\/backdrops\/([a-z0-9][a-z0-9-]{0,31})\.js$/.exec(assetRoute)?.[1];if(id){const file=path.join(pkg,'ui','backdrops',id+'.js');let regular=false;try{regular=fs.lstatSync(file).isFile();}catch{}if(regular){res.setHeader('Content-Security-Policy',STATIC_CSP);return send(res,200,fs.readFileSync(file,'utf8'),'text/javascript; charset=utf-8');}}}
  if(req.method==='GET'&&!assetRoute.startsWith('/api/'))return send(res,404,{error:'NOT_FOUND'});
  if(req.url?.startsWith('/api/extension/')){if(req.method!=='POST'||!eq(req.headers['x-ken-extension'],extensionToken))return send(res,401,{error:'EXTENSION_AUTH_REQUIRED'});if(req.url==='/api/extension/install-authorize'||req.url==='/api/extension/install-result')requireLegacyInstaller(chromeDistribution);const d=await json(req),ext=tools.automation.browser.extension;if(req.url==='/api/extension/next')return send(res,200,ext.next(d.session,d.helper,d.host_source));if(req.url==='/api/extension/install-authorize')return send(res,200,chromeInstall.authorize(d.session,d.id));if(req.url==='/api/extension/install-result')return send(res,200,chromeInstall.complete(d.session,d.id,d.result,d.error));if(req.url==='/api/extension/authorize')return send(res,200,ext.authorize(d.session,d.id));if(req.url==='/api/extension/result')return send(res,200,ext.complete(d.session,d.id,d.result,d.error));return send(res,404,{error:'NOT_FOUND'});}
  if(!eq(req.headers.authorization,`Bearer ${admin}`))return send(res,401,{error:'OWNER_AUTH_REQUIRED'});
  if(req.method==='GET'&&req.url==='/api/events'){if(!interfaceKey||!eq(req.headers['x-chathand-ui'],interfaceKey))return send(res,403,{error:{code:'UI_CONFIRM_REQUIRED',message:'这一步只在 ChatHand 窗口里进行，AI 不能代做。'}});return await stateEvents.accept(req,res);}
  if(req.method==='GET'&&req.url==='/api/native/state'){if(!interfaceKey||!eq(req.headers['x-chathand-ui'],interfaceKey))return send(res,403,{error:{code:'UI_CONFIRM_REQUIRED',message:'这一步只在 ChatHand 窗口里进行。'}});if(['zh','en'].includes(req.headers['x-chathand-ui-locale']))setupHelperLocale=req.headers['x-chathand-ui-locale'];tools.automation.computer.touchNativeLease?.();return send(res,200,nativeSnapshot());}
  if(req.method==='GET'&&req.url==='/api/state')return send(res,200,await snapshot());
  if(req.method==='GET'&&req.url==='/api/product-config'){const {release,...bundled}=JSON.parse(fs.readFileSync(path.join(pkg,'connectors','product.json'),'utf8'));return send(res,200,bundled);}
  if(req.method==='GET'&&req.url==='/api/catalog')return send(res,200,JSON.parse(fs.readFileSync(path.join(pkg,'connectors','catalog.json'))));
  if(req.method!=='POST')return send(res,405,{error:'POST_REQUIRED'});
  if(!(req.headers['content-type']||'').startsWith('application/json'))return send(res,415,{error:'JSON_REQUIRED'});
  const d=await json(req);
  if(req.url==='/api/setup/assistant-seen'){
   if(!eq(req.headers['x-chathand-setup-helper'],setupHelperToken))return send(res,403,{error:{code:'SETUP_HELPER_AUTH_REQUIRED'}});
   if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).length)return send(res,400,{error:{code:'ARG_INVALID'}});
   const now=startupClock();if(!Number.isSafeInteger(now)||now<0)return send(res,500,{error:{code:'SETUP_HELPER_TIME_INVALID'}});
   const next=Math.max(now,setupHelperSeenAt===null?0:setupHelperSeenAt+1);if(!Number.isSafeInteger(next))return send(res,500,{error:{code:'SETUP_HELPER_TIME_INVALID'}});
   setupHelperSeenAt=next;eventChanged();return send(res,200,{ok:true,seen_at:next,locale:setupHelperLocale});
  }
  if(req.url==='/api/setup/test/start'&&state.data.setup_complete===true&&!(d&&Object.keys(d).join(',')==='restart'&&d.restart===true)&&setupVerified()&&state.data.chatgpt_app_retest_required!==true&&state.data.chatgpt_app_missing?.reason!=='refresh_not_found'&&!interfaceAuthorized('/api/setup/progress',{},req.headers['x-chathand-ui'],interfaceKey))return send(res,403,{error:{code:'UI_CONFIRM_REQUIRED',message:'这条连接已配好并通过测试；需要重测时请在 ChatHand 窗口开始。'}});
  const authorizedUpgrade=req.url==='/api/lifecycle/quit'&&eq(req.headers['x-chathand-upgrade'],upgradeAuthority)&&['installing','restarting'].includes(updater.snapshot().install?.state);
  const authorizedOwnerQuit=req.url==='/api/lifecycle/quit'&&!Object.hasOwn(req.headers,'x-chathand-upgrade');
  if(!authorizedUpgrade&&!authorizedOwnerQuit&&!interfaceAuthorized(req.url,d,req.headers['x-chathand-ui'],interfaceKey))return send(res,403,{error:{code:'UI_CONFIRM_REQUIRED',message:'这一步需要 ChatHand 窗口的连接认证。'}});
  return send(res,200,await handle(req.url,d,{windowAuthorized:!!interfaceKey&&eq(req.headers['x-chathand-ui'],interfaceKey)}));
 }catch(e){const publicError=managementHTTPError(req.url,e,cleanError);if(e?.code==='B_PAIRING_BINDING'&&['claim', 'protocol_version', 'site_id', 'site_origin', 'owner_subject', 'installation_id', 'device_public_key_id', 'public_key_id', 'client_nonce', 'server_nonce', 'template_version', 'manifest_sha256', 'pairing_intent', 'device_name', 'generation', 'binding_id', 'pairing_id', 'pairing_hash'].includes(e.mismatch)&&publicError.body?.error)publicError.body.error.mismatch=e.mismatch;send(res,publicError.status,publicError.body);}});
 api.requestTimeout=45000;api.headersTimeout=10000;apiPort=await listen(api);
 if(chromeDistribution.configuration_state==='ready')saveJSON(extensionFile,{origin:`http://127.0.0.1:${apiPort}`,token:extensionToken,extension_id:chromeDistribution.extension_id});
 saveJSON(runtimeFile,{pid:process.pid,product:'ken-bridge',runtime_api:RUNTIME_API,version:VERSION,started_at:Date.now(),ui_origin:`http://127.0.0.1:${apiPort}`,admin_token:admin,setup_helper_token:setupHelperToken,mcp_url:`http://127.0.0.1:${mcpPort}/mcp`,mcp_token:chatToken,local_mcp_token:localToken,root:store.root});
 if(bLocalStore.selection().selected==='openai'&&bSiteWatch)abandonSitePairing('B_PAIRING_ABANDONED');
 // Recover/verify in parallel with transport startup. Only verified completion
 // may release execution; a hanging, failed or active upgrade stays closed.
 const startupReconciliation=Promise.resolve().then(async()=>{
  try{const result=await updater.reconcileStartup?.();startupReconciliationCode=result?.pending?'UPGRADE_VERIFYING':result?.code?'UPGRADE_CURRENT_INVALID':null;}
  catch{startupReconciliationCode='UPGRADE_CURRENT_INVALID';}
  finally{startupReconciliationPending=false;eventChanged();}
 });
 if(!isolated)void refreshStartupIcon({appPath,build:buildInfo().build,previousBuild:state.data.last_icon_registered_build,remember:build=>{state.data.last_icon_registered_build=build;state.save();},record:code=>store.audit({event:'upgrade_icon_refresh',code})}).catch(()=>{});
 setAccess(false,{persist:false});
 const startupScheduled=startupClock();startupStage('startup_delay','begin',startupScheduled);
 const startup=setTimeout(async()=>{startupStage('startup_delay','ok',startupScheduled);startupStage('app_start','ok',startedAt);if(closed||state.data.auto_connect!==true||controller.desired||relayDesired)return;
  // Right after the Mac starts, the proxy app may not be up yet: wait up to 45 s for it instead of connecting directly.
  if(state.data.connection_preference==='tunnel'&&process.platform==='darwin'&&os.uptime()<300&&!['HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy'].some(k=>process.env[k])){const proxyAt=startupClock();startupStage('proxy_wait','begin',proxyAt);controller.phase='connecting';controller.message='正在等网络就绪';for(let i=0;i<15&&!closed&&!currentSystemProxy();i++)await new Promise(r=>setTimeout(r,3000));if(closed||controller.desired||relayDesired){startupStage('proxy_wait','cancelled',proxyAt);return;}startupStage('proxy_wait','ok',proxyAt);}
  try{
  if(state.data.connection_preference==='tunnel')restoreTunnel();
  else if(state.data.connection_preference==='relay')void handle('/api/relay/restore',{}, {startup:true}).catch(()=>{});
 }catch(e){controller.phase='needs_login';controller.errorCode=e.code||'CONNECTION_UNAVAILABLE';controller.message=e.code==='SAVED_CONNECTION_MISSING'?'填写连接信息后即可使用。':'连接信息读取失败，请检查本机存储。';}},50);startup.unref();
 const bStartup=setTimeout(()=>{
  if(closed||isolated&&!clientDeps.bSiteTransport||bLocalStore.siteCommit())return;
  try{
   const paired=credentials.get('site_b'),machine=credentials.get('site_b_machine'),route=bLocalStore.route('site');
   if(paired&&machine&&paired.installation_id===pilot.data.installation_uuid&&route.configured===1&&route.site_id===paired.site_id&&route.owner_subject===paired.owner_subject&&route.binding_id===paired.binding_id&&
    route.generation===paired.generation)bSiteTransport.start?.();
  }catch{} // No credential value or error details in ordinary status/logs.
 },50);bStartup.unref?.();
 // Chrome registration is independent work and must not serialize connection.
 const browserStartup=setTimeout(()=>{void startupReconciliation.then(()=>{
  if(closed||tools.upgradePending)return;
  if(!browserControlOptedIn(state.data))browserHostStatus={status:'skipped',reason:'browser_not_opted_in'};
  else if(process.platform==='darwin'&&!isolated||clientDeps.browserHost)void registerCurrentBrowserHost().catch(()=>{});
  else browserHostStatus={status:'skipped'};
 });},50);browserStartup.unref?.();
 // There is no whole-server polling tick. External health has no push API,
 // so only its source retains bounded 1s (busy/degraded) or 5s (idle) probes.
 function netCheck(){try{
  if(!controller.desired||relayDesired)return;
  const busy=[...policy.tasks.values()].some(t=>['active','pending_approval'].includes(t.status))||[...queue.jobs.values()].some(jobRunning),cp=lastControlPlane;
  if(tunnel.child&&tunnel.proxyWatchable&&(currentSystemProxy()||null)!==(tunnel.runningProxy||null)&&(!busy||cp?.state==='down')&&!controller.recentlyAuthenticated()){controller.restart('proxy_changed','代理有变化，正在重新连接');return;}
  if(controller.blocked)controller.retryOnce('periodic');
 }catch{}}
 maintenance=new DeadlineScheduler({clock:maintenanceClock});
 const wallNow=maintenance.wallNow,monoNow=maintenance.now;
 let lastNetCheck=monoNow(),lastConnectionObservation=monoNow();
 const liveWork=()=>[...queue.jobs.values()].some(j=>j.child||j.cleanupPending||j.status==='running'||j.status==='pending_approval');
 const maintain=fn=>{try{return fn();}catch{}};
 const ownerPid=Number(process.env.KEN_BRIDGE_OWNER_PID||0);
 // Legacy launchers have no parent-exit pipe. Keep their PID-only 1s fallback.
 let ownerNext=monoNow()+1000;
 if(!ownerLifetime)maintenance.add('owner',{next:()=>Number.isSafeInteger(ownerPid)&&ownerPid>1?ownerNext:Infinity,run:()=>{ownerNext=monoNow()+1000;try{process.kill(ownerPid,0);}catch(e){if(e.code==='ESRCH')void close();}}});
 maintenance.add('setup_activity',{next:()=>{const activity=setupActivity.snapshot();return activity.active?maintenance.wallAt(activity.last_at+15*60*1000):Infinity;},run:()=>eventChanged()});
 maintenance.add('site_watch',{next:()=>bSiteWatch?maintenance.wallAt(bSiteWatch.expires_at):Infinity,run:()=>{watchCurrent();eventChanged();}});
 maintenance.add('read_tasks',{next:()=>maintenance.wallAt(tools.readTasks.nextDeadline()),run:()=>tools.readTasks.maintain()});
 maintenance.add('controller',{next:()=>maintenance.wallAt(controller.nextDeadline()),run:()=>{controller.monitor();eventChanged();}});
 maintenance.add('route',{next:()=>{
  if(routePending)return monoNow();if(!selectedSite()&&!relayDesired&&!controller.desired)return Infinity;let at=Infinity;const g=connectionGrace.current;
  if(g?.since!==null&&g?.since!==undefined&&!g.expired)at=g.since+600000;
  if(selectedSite()){const r=bLocalStore.route('site');if(r?.state==='healthy'&&r.last_verified+30000>wallNow())at=Math.min(at,r.last_verified+30000);}
  return maintenance.wallAt(at);
 },run:()=>{routePending=false;if(selectedSite())reconcileSelectedSiteAccess();else if(state.data.connection_preference==='relay'&&relayDesired)linkAccess('relay',relay.snapshot().online===true,{auth:relay.snapshot().status==='login_required'});else if(controller.desired)linkAccess('tunnel',controller.phase==='ready'&&!!tunnel.child,{auth:controller.phase==='needs_login'});}});
 // Fast cloud observation belongs to a real transport attempt, including a
 // delayed first connection or reconnect, rather than the server process age.
 const observingStartupCloud=()=>{const age=wallNow()-controller.startedAt;return lastControlPlane?.state!=='up'&&Number.isFinite(controller.attemptStartedAt)&&controller.startedAt>=controller.attemptStartedAt&&age>=0&&age<45000;};
 maintenance.add('connection',{next:()=>controller.desired?lastConnectionObservation+(controller.phase!=='ready'||controller.unhealthy||!tunnel.child||observingStartupCloud()||liveWork()?1000:5000):Infinity,run:()=>{lastConnectionObservation=monoNow();return inspectConnection();}});
 maintenance.add('network',{next:()=>controller.desired&&!relayDesired?lastNetCheck+30000:Infinity,run:()=>{lastNetCheck=monoNow();netCheck();}});
 maintenance.add('display',{next:()=>{
  if(!controller.desired)return Infinity;const cp=lastControlPlane||{},episode=controller.cloudEpisode?.since,now=wallNow();let at=Infinity;
  if(cp.state==='checking'){const since=Math.min(cp.down_since??now,Number.isFinite(episode)?episode:now);for(const offset of [15000,120000])if(since+offset>now)at=Math.min(at,since+offset);}
  if(Number.isFinite(cp.last_call_success_at)&&cp.last_call_success_at+15000>now)at=Math.min(at,cp.last_call_success_at+15000);
  return maintenance.wallAt(at);
 },run:()=>eventChanged()});
 function notifyFinished(j){if(!j?.finished_at||j.desktopNotified)return;j.desktopNotified=true;const t=policy.tasks.get(policy.jobOwners.get(j.id));policy.emit('command_finished',{task_id:t?.id,conversation_id:t?.conversation_id,job_id:j.id,success:j.exit_code===0});}
 maintenance.add('queue',{next:()=>queuePending?monoNow():maintenance.wallAt(queue.nextMaintenanceAt(wallNow())),run:()=>{queuePending=false;queue.maintain();for(const j of queue.jobs.values())notifyFinished(j);}});
 maintenance.add('tasks',{next:()=>{
  let at=Infinity;for(const t of policy.tasks.values())if(t.status==='active'){
   if(t.expires_at!==null)at=Math.min(at,t.expires_at+1);
   if(!policy.hasLiveWork(t))at=Math.min(at,Math.max(t.created_at||0,tools.resume.lastActivity(t.id))+3*3600000+1);
   at=Math.min(at,tools.resume.nextStallAt(policy.view(t)));
  }return maintenance.wallAt(at);
 },run:()=>{const now=wallNow();for(const t of policy.tasks.values())if(t.status==='active'){if(t.expires_at!==null&&now>t.expires_at)maintain(()=>policy.get(t.id));maintain(()=>tools.resume.stall(policy.view(t)));}policy.expireIdle(t=>tools.resume.lastActivity(t.id),3*3600000,now);}});
 maintenance.add('relay',{next:()=>maintenance.wallAt(relayKeeper.nextMaintenanceAt()),run:()=>relayKeeper.maintain()});
 const queueChanged=([job])=>{if(closed)return;queuePending=true;maintenance.changed('queue','tasks','connection','relay');notifyFinished(job);};
 afterSuccess(queue,'record',queueChanged);
 afterSuccess(queue,'appendOutput',args=>{if(args[0]?.finished_at)queueChanged(args);});
 for(const method of ['before','after','checkpoint','observeJob'])afterSuccess(tools.resume,method,()=>maintenance.changed('tasks','relay'));
 for(const method of ['configureAndConnect','startAttempt','failed','healthy','observe','authenticatedCallSucceeded','watchCloud','restart','stop'])afterSuccess(controller,method,eventChanged);
 afterSuccess(bHostProbes,'consume',()=>{const before=appRoutes.snapshot('site'),entry=appRoutes.entry('site');const changed=forgetMissingChatGPTAppAfterRetest('site')||before.chatgpt_app_retest_required===true;if(changed){delete entry.chatgpt_app_retest_required;try{state.save();eventChanged();}catch(e){appRoutes.restore('site',before);throw e;}}});
 controller.onDeadlineChange=eventChanged;relayKeeper.onMaintenanceChange=()=>maintenance.changed('relay');
 let watchedChild=null;
 const childClosed=()=>{if(closed)return;lastConnectionObservation=Math.min(lastConnectionObservation,monoNow()-1000);eventChanged();};
 function watchChild(){if(watchedChild===tunnel.child)return;watchedChild?.removeListener?.('close',childClosed);watchedChild=tunnel.child;watchedChild?.once?.('close',childClosed);}
 for(const method of ['start','stop'])if(typeof tunnel[method]==='function')afterSuccess(tunnel,method,()=>{watchChild();eventChanged();});
 watchChild();
 // Existing route writes are the authoritative Site change notifications.
 for(const method of ['health','switchUser','switchSetup','switchConfiguredSiteIfFailed','configureSite','configureOpenAI'])if(typeof bLocalStore[method]==='function')afterSuccess(bLocalStore,method,()=>{observeSiteConnection();eventChanged();});
 for(const method of ['start','stop'])if(typeof bSiteTransport[method]==='function')afterSuccess(bSiteTransport,method,()=>{observeSiteConnection();eventChanged();});
 maintenance.changed();
 let closePromise=null,closedComplete;
 // Embedders can await teardown without affecting their own process lifetime.
 const whenClosed=new Promise(resolve=>{closedComplete=resolve;});
 function close(){return closePromise||(closePromise=closeDesktop().then(()=>{closedComplete({ok:true});},error=>{closedComplete({ok:false,error:cleanError(error)});throw error;}));}
 async function closeDesktop(){if(closed)return;closed=true;tools.readTasks?.close();ownerLifetime?.close();bPairing.close();clearTimeout(bStartup);clearTimeout(browserStartup);bSiteTransport.close?.();bHostProbes.invalidate();bSiteDispatch.invalidateTransportAuthority();chromeInstall.close();tools.artifacts.close();if(planTimer)clearInterval(planTimer);planProbe?.close?.();clearTimeout(startup);maintenance?.close();watchedChild?.removeListener?.('close',childClosed);watchedChild=null;controller.onDeadlineChange=null;relayKeeper.onMaintenanceChange=null;stateEvents.close();eventSource.close();keyWatch.close();try{await tools.automation.close();}catch(e){console.error(JSON.stringify(cleanError(e)));}tools.features.cancel();tools.confirmations.close();tools.h8Cards.close();updater.close();try{tools.resume.close();}catch{}pendingCredentials=null;relayDesired=false;try{setAccess(false,{persist:false,reason:'revoked'});}catch(e){console.error(JSON.stringify(cleanError(e)));}try{controller.stop({persist:false});}catch(e){console.error(JSON.stringify(cleanError(e)));}try{await relay.stop();}catch(e){console.error(JSON.stringify(cleanError(e)));}await Promise.allSettled([...(policy.matterSettlements||[])]);try{await queue.close();}catch(e){console.error(JSON.stringify(cleanError(e)));}tools.valueStats?.close();try{relayKeeper.cancelAll('stopped');}catch{}relayKeeper.close();bLocalStore.close();await new Promise(r=>setTimeout(r,1000));for(const s of[api,mcp]){s.closeAllConnections();await new Promise(r=>s.close(r));}try{fs.unlinkSync(extensionFile);}catch{}try{fs.unlinkSync(runtimeFile);}catch{}if(lockOwned)try{fs.unlinkSync(lockFile);}catch{}}
 await startupReconciliation;
 if(!closed){
  updater.start();
  if(!tools.upgradePending){
   reconcileExecutionAccess();
   if(resumeSitePair)void bPairing.pairV2().catch(()=>{});
  }
  eventChanged();
 }
 return {state,store,queue,policy,tools,tunnel,controller,relay,apiPort,mcpPort,adminToken:admin,mcpToken:chatToken,localToken,uiKey:interfaceKey,ui:`http://127.0.0.1:${apiPort}/#${admin}${interfaceKey?'.'+interfaceKey:''}`,snapshot,handle,close,whenClosed,maintenance,keyWatch,updater,stateEvents,eventSourceStatus,refreshSkillStatus};
}
/** Native keys arrive once on the inherited pipe; owner authority never enters the renderer. */
export async function startDesktopFromNative({input=process.stdin,env=process.env,create=createDesktop,onError=e=>console.error(JSON.stringify(cleanError(e)))}={}){
 // Install before bootstrap: an owner can disappear while its key frame is read.
 const ownerLifetime=env.CHATHAND_UI_KEY_STDIN==='1'?watchNativeOwnerPipe(input,env.CHATHAND_OWNER_PIPE):null;
 try{
  const {uiKey,nativeOwnerKey}=env.CHATHAND_UI_KEY_STDIN==='1'?await readNativeBootstrap(input):{uiKey:null,nativeOwnerKey:null};
  if(ownerLifetime?.lost)fail('NATIVE_OWNER_EXITED','ChatHand 窗口已退出，停止启动本机服务。');
  if(env.CHATHAND_UI_KEY_STDIN==='1'&&!uiKey)console.error(JSON.stringify({code:'UI_KEY_MISSING',message:'没有收到窗口的界面凭据：权限变更和批准已锁定。'}));
  const b=await create({uiKey,nativeOwnerKey,ownerLifetime});
  ownerLifetime?.bind(()=>{void b.close().catch(onError);});
  return b;
 }catch(e){ownerLifetime?.close();throw e;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(Number(process.versions.node.split('.')[0])<22)fail('NODE_VERSION','需要 Node 22 或更高版本。');const b=await startDesktopFromNative();console.log(`ChatHand ${VERSION} 本机执行服务已启动。`);b.whenClosed.then(result=>{if(!result.ok){console.error(JSON.stringify(result.error));process.exitCode=process.exitCode||1;}setImmediate(()=>{process.stdout.write('',()=>process.stderr.write('',()=>process.exit(process.exitCode||0)));});});let stopping=false;for(const sig of['SIGINT','SIGTERM'])process.on(sig,()=>{if(stopping)return;stopping=true;void b.close().catch(()=>{});});}catch(e){console.error(JSON.stringify(cleanError(e)));process.exitCode=1;}
}
