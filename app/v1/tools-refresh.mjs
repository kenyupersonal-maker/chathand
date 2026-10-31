import {chromeDistribution,storeMode} from './chrome-distribution.mjs';
import {chromeStoreUsable} from './chrome-store-contract.mjs';
import {sameChatGPTAppId,sameChatGPTAppDetailURL} from './chatgpt-app-identity.mjs';
import {messageMetadata,displayParam} from './message-metadata.mjs';
// 1029：刷新器 v2。只打开本应用的详情并点核对过的刷新按钮；确认框留给用户。
// 助手故障立即停；未知语言只交出详情页新按钮，不猜按钮、不改权限。
// tools/list 是成功证据；一次点击没有拿到新清单时不再点第二次。
import {dedupeRefreshEntries} from './refresh-entry.mjs';
import crypto from 'node:crypto';
import {fail} from '../../engine/src/core.mjs';

export const REFRESH_NAMES=['刷新工具','Refresh tools','Refresh']; // 保留旧导出，匹配改用下面的核对表。
export const REFRESH_NAMES_BUILTIN={zh:['刷新工具']};
export const PLUGINS_URL='https://chatgpt.com/settings/plugins-settings';
export const APPS_URLS=[PLUGINS_URL,'https://chatgpt.com/#settings/Connectors'];
const ENTRY_ROLES=new Set(['button','link','menuitem','tab','row','listitem','gridcell','cell','option','treeitem']);
export const DANGER=/删除|移除|断开|停用|禁用|卸载|撤销|权限|改名|重命名|编辑|delete|remove|disconnect|disable|uninstall|revoke|permission|rename|edit/i;
const CONSENT=/^(?:允许|同意|确认|接受|授权|继续|(?:allow|approve|accept|confirm|authorize|continue)\b)/i;
export const STEP_WORDS={helper:'检查助手',task:'创建 ChatHand 任务',open:'打开 ChatGPT 插件页',page:'等待插件页加载',entry:'在插件页中查找 ChatHand',open_entry:'打开 ChatHand',detail:'等待 ChatHand 页面加载',button:'查找「刷新工具」按钮',click:'点击「刷新工具」',tools_list:'等待 ChatGPT 获取新工具',ai:'等待 ChatGPT 识别按钮'};
const clean=v=>String(v??'').replace(/\s+/g,' ').trim();
const FATAL=/^(?:EXTENSION_|BROWSER_IN_USE|BROWSER_BUSY|BROWSER_TIMEOUT|BROWSER_BACKEND|TASK_|CAPABILITY_OFF|LOCAL_DISABLED|UPGRADE_)/;
const HELPER_BROKEN=new Set(['SNAPSHOT_STALE','PAGE_HELPER_FAILED','ELEMENT_REF_COLLISION']);
const rid=()=>'chathand-refresh-'+crypto.randomUUID().replace(/-/g,'').slice(0,24);
const pageUrl=r=>{const u=r?.changes?.url||r?.snapshot?.url||r?.url;return typeof u==='string'&&/^https?:\/\//.test(u)?u.slice(0,2000):null;};
const brief=x=>({role:x.role,name:x.name});
const elementKey=x=>JSON.stringify([x.role,x.name]);
// 元素 ref 会随着快照更新；按角色和原样名称的数量作差，不按 ref 或模糊子串猜。
function addedButtons(before,after){const counts=new Map();for(const x of before){const k=elementKey(x);counts.set(k,(counts.get(k)||0)+1);}return after.filter(x=>{const k=elementKey(x),n=counts.get(k)||0;if(n){counts.set(k,n-1);return false;}return true;});}

const errorParams=(at,e)=>({step:{key:STEP_WORDS[at]?'refresh.step.'+at+'.title':'refresh.stepFallback.title'},reason:/^[A-Z][A-Z0-9_]{1,79}$/.test(e?.code||'')?e.code:{key:'refresh.reason.unknown'}});
function finishMetadata(value,summary,key,params){const useMessage=[...(value.message||'')].length<=80;if(value.summary_key)return {summary:useMessage?(value.message||summary):summary.slice(0,80),...messageMetadata('summary',value.summary_key,value.summary_params)};return {summary:useMessage?(value.message||summary):summary.slice(0,80),...messageMetadata('summary',useMessage&&value.message?value.message_key:key,useMessage&&value.message?value.message_params:params)};}

export const REFRESH_RULES={
 zh:'要找的是「刷新/更新这个应用的工具（动作）」的那一个按钮，什么语言都行；意思是删除、卸载、移除、断开、停用、改名、编辑、权限的不选。只在 buttons 里选（就是 ChatHand 那一页的按钮）；认准一个就调 tools_refresh_click，number 填编号、meaning 写你认为它是什么意思；拿不准就别调，把候选和理由告诉用户，请他自己去点。',
 en:'Choose only the button meaning refresh/update this app’s tools (actions), in any language. Never choose delete, uninstall, remove, disconnect, disable, rename, edit or permissions. Choose only from buttons on ChatHand’s detail page. If exactly one is clear, call tools_refresh_click with its number and your interpretation in meaning. Otherwise do not call it: explain the candidates and uncertainty and ask the user to click.'
};

export class ToolsRefresher{
 constructor({distribution=chromeDistribution(),invoke,listStatus=()=>null,seen=()=>[],expected=()=>null,audit=()=>{},now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),emit=()=>{},urls,pluginsUrl=PLUGINS_URL,appName=()=>'ChatHand',targetIdentity=()=>null,onIdentityObserved=()=>{},onAppMissing=()=>{},onIdentityFound=()=>{},names={load:()=>({}),save:()=>{}},wakeChrome=null,helperWaitMs=120000,helperManualWaitMs=300000,pageWaitMs=30000,detailWaitMs=15000,toolsListWaitMs=20000,observeMs=180000}={}){
  Object.assign(this,{distribution,invoke,listStatus,seen,expected,audit,now,sleep,emit,pluginsUrl,targetIdentity,onIdentityObserved,onAppMissing,onIdentityFound,names,wakeChrome,helperWaitMs,helperManualWaitMs,pageWaitMs,detailWaitMs,toolsListWaitMs,observeMs});
  this.appName=typeof appName==='function'?appName:()=>String(appName);
  this.urls=urls||(pluginsUrl===PLUGINS_URL?APPS_URLS:[pluginsUrl]);
  this.value={state:'idle'};this.running=null;this.pending=null;this.targetContext=null;
 }
 snapshot(){const proof=this.listStatus?.();if(proof?.state==='current'&&proof.observed===true&&this.value.state!=='running'&&!['identity_required','not_found','ambiguous'].includes(this.value.state)&&this.value.code!=='TOOLS_REFRESH_IDENTITY_MISMATCH'&&this.value.target_attested!==true)this.value={...this.value,state:'refreshed',waiting:null,stopped_at:null,...messageMetadata('message','refresh.message.refreshed.alreadyCurrent'),message:'已核验这条连接已取得当前工具清单。',proof_current:true};return structuredClone({...this.value,...(proof?{tool_list_status:proof}:{})});}
 // Authority comes only from a server-owned installation-bound callback, never names.load().
 target(){try{this.assertTarget?.(this.targetContext);return this.normalizeIdentity(this.targetIdentity(this.targetContext));}catch{return null;}}
 normalizeIdentity(value){
  if(!value||typeof value!=='object')return null;
  const detail_url=value.detail_url?this.canonicalDetail(value.detail_url):null;
  if(value.detail_url&&!detail_url)return null;
  const app_id=value.app_id|| (detail_url?decodeURIComponent(new URL(detail_url).pathname.split('/').pop()):null);
  if(typeof app_id!=='string'||!/^[-A-Za-z0-9_]{1,200}$/.test(app_id))return null;
  if(detail_url&&!sameChatGPTAppId(decodeURIComponent(new URL(detail_url).pathname.split('/').pop()),app_id))return null;
  return {app_id,...(detail_url?{detail_url}:{}),...(typeof value.app_name==='string'?{app_name:value.app_name}:{})};
 }
 canonicalDetail(value){try{const u=new URL(value),base=new URL(this.pluginsUrl);return u.origin===base.origin&&!u.username&&!u.password&&u.pathname.startsWith(base.pathname+'/')&&u.pathname.slice(base.pathname.length+1).match(/^[-A-Za-z0-9_]{1,200}$/)&&!u.search&&!u.hash?u.href:null;}catch{return null;}}
 sameIdentity(a,b){return !!a&&!!b&&sameChatGPTAppId(a.app_id,b.app_id)&&(!a.detail_url||!b.detail_url||sameChatGPTAppDetailURL(a.detail_url,b.detail_url));}
 isTargetDetail(url,identity){const u=this.canonicalDetail(url);return !!u&&!!identity&&sameChatGPTAppId(decodeURIComponent(new URL(u).pathname.split('/').pop()),identity.app_id)&&(!identity.detail_url||sameChatGPTAppDetailURL(u,identity.detail_url));}
 assertIdentity(identity,url=null){if(!this.sameIdentity(identity,this.target())||url&&!this.isTargetDetail(url,identity))throw Object.assign(Error('尚未确认这台电脑对应的 ChatGPT 插件，已停止刷新，没有点击其他应用。'),{code:'TOOLS_REFRESH_IDENTITY_MISMATCH'});}
 async rememberIdentity(url,identity,app_name){this.assertTarget?.(this.targetContext);if(!this.isTargetDetail(url,identity))return;try{await this.onIdentityObserved({app_id:identity.app_id,detail_url:this.canonicalDetail(url),...(app_name?{app_name}: {})},this.targetContext);}catch{this.safeAudit('tools_refresh_identity_observation_failed');}}
 set(value){value={...value,...messageMetadata('message',value.message_key,value.message_params)};this.value=value;try{this.emit('tools_refresh',{state:value.state,...(value.waiting?{waiting:value.waiting}:{}),...(value.message?{message:value.message,...messageMetadata('message',value.message_key,value.message_params)}:{})});}catch{}return value;}
 async call(name,args){if(name!=='finish_task')this.assertTarget?.(this.targetContext);const r=await this.invoke(name,args);if(name!=='finish_task')this.assertTarget?.(this.targetContext);if(name.startsWith('browser_')&&r?.status==='failed')throw Object.assign(Error(r.error?.message||r.error?.code||'浏览器操作没做成'),{code:r.error?.code||'BROWSER_FAILED',result:r});return r;}
 run({reason='manual'}={}){if(this.running)return this.running;this.targetContext=this.captureTarget?.()||null;this.running=this.runTargets(reason).finally(()=>{this.running=null;this.targetContext=null;});return this.running;}
 async runTargets(reason){
  return this._run(reason);
 }
 clickByNumber({number,meaning}={}){
  if(this.running)fail('TOOLS_REFRESH_BUSY','自动刷新还在跑，先等它结束。');
  if(this.value?.state!=='needs_ai'||!this.pending)fail('TOOLS_REFRESH_NOT_PENDING','现在没有要认的按钮：先调 upgrade_status 看 tools_refresh。');
  // 不能将任意 tools/list 时间戳冒充当前页面刷新；仅有可信目标绑定才能判成功。
  const chosen=this.pending.buttons.find(x=>x.number===number);if(!chosen)fail('TOOLS_REFRESH_NUMBER_INVALID','这个编号不在待选按钮里。');
  if(DANGER.test(chosen.name))fail('TOOLS_REFRESH_DANGEROUS','这个按钮像删除、卸载、断开、改名、编辑或权限，不能点。');
  this.targetContext=this.pending.targetContext||null;this.running=this._clickByNumber(chosen,clean(meaning).slice(0,200)).finally(()=>{this.running=null;this.targetContext=null;});return this.running;
 }
 async _clickByNumber(chosen,meaning){
  const origin={...this.value},pending=this.pending,steps=[...(origin.steps||[])];let task=null,page=pending.page,success=false,summary='',summaryKey=null,summaryParams={},keepTab=false,at='ai',t0=this.now();
  const note=(ok,extra={})=>{steps.push({step:at,ok,ms:Math.max(0,this.now()-t0),...extra});if(steps.length>24)steps.shift();};
  const done=value=>{this.pending=null;return this.set({...origin,...value,steps:steps.slice(),...(value.state==='refreshed'?{}:{stopped_at:at}),finished_at:this.now()});};
  const pageGone=e=>/^(?:BROWSER_PAGE_MISSING|BROWSER_TAB_MISSING|TAB_INVALID|TAB_CLOSED|PAGE_MISSING)$/.test(e?.code||'');
  this.set({...origin,state:'running',waiting:'ai',...messageMetadata('message','refresh.message.running.aiFound'),message:'ChatGPT 已认出刷新按钮，ChatHand 正在核对后点击。',steps:steps.slice()});
  try{
   this.assertIdentity(pending.identity,pending.url);
   task=(await this.call('begin_task',{request_id:rid(),title:'刷新 ChatGPT 里的 ChatHand 工具',title_key:'refresh.task.title',title_params:{}}))?.task_id;if(!task)throw Object.assign(Error('没开成任务'),{code:'TASK_NOT_STARTED'});
   const check=async()=>{const here=await this.call('browser_find',{task_id:task,page_id:page,limit:5});this.assertIdentity(pending.identity,pageUrl(here));if(!this.isTargetDetail(pageUrl(here),pending.identity))throw Object.assign(Error('不在 ChatHand 的详情页'),{code:'NOT_CHATHAND_PAGE'});const found=await this.call('browser_find',{task_id:task,page_id:page,role:'button',text:chosen.name,exact:true,limit:100,boxes:true});const elements=(Array.isArray(found?.elements)?found.elements:[]).filter(x=>x.role==='button'&&x.name===chosen.name&&!x.disabled);return {found,elements};};
   let checkResult;try{checkResult=await check();}catch(e){if(!pageGone(e))throw e;const opened=await this.call('browser_open',{task_id:task,request_id:rid(),url:pending.url});page=opened?.page_id;if(!page)throw e;const waited=await this.waitTargetDetail(task,page,pending.identity,this.pageWaitMs);if(!waited.ok)throw Object.assign(Error('重新打开详情页后没看到 '+this.appName()),{code:waited.code||'WAIT_TIMEOUT'});checkResult=await check();}
   const {found,elements}=checkResult;if(elements.length!==1){note(false,{number:chosen.number,meaning,count:elements.length});summary='无法确认 ChatGPT 选择的按钮';summaryKey='refresh.summary.aiButtonUnclear';summaryParams={};return done({state:elements.length?'ambiguous':'not_found',url:pageUrl(found)||pending.url,lang:found?.lang||pending.lang,...messageMetadata('message',elements.length?'refresh.message.ambiguous.sameName':'refresh.message.not_found.buttonGone',{count:elements.length,button:displayParam(chosen.name,'refresh.step.click.title')}),message:elements.length?'找到 '+elements.length+' 个同名按钮「'+chosen.name+'」，未点击。':'页面中已找不到按钮「'+chosen.name+'」，未点击。'});}
   const button={...elements[0],name:String(elements[0].name??'')},lang=String(found?.lang||pending.lang||'').toLowerCase(),clickedAt=this.now(),request_id=rid(),expected={...this.expected(),plugin_url:pending.url};
   // A complete, current host-attested list can arrive while the AI identifies
   // this exact button. Reuse the same verifier before any second click.
   const already=this.listCorrelation(pending.at,page,expected);
   if(already.match){success=true;summary='已核验目标页面已有新工具清单';summaryKey='refresh.summary.alreadyFetched';summaryParams={};note(true,{number:chosen.number,already_fetched:true});this.safeAudit('tools_refresh_correlated',{page_id:page,already_fetched:true});return done({state:'refreshed',target_attested:true,url:pending.url,lang,clicked:false,correlation:{observed:already.observed,same_connection:already.same_connection,missing:already.missing},...messageMetadata('message','refresh.message.refreshed.noClickNeeded'),message:'ChatGPT 已经拿到新工具清单，不再点击刷新。'});}
   this.assertIdentity(pending.identity,pageUrl(found));
   let clicked=null,deliveryUnconfirmed=false;keepTab=true;at='click';t0=this.now();
   try{clicked=await this.call('browser_action',{task_id:task,request_id,page_id:page,action:'click',ref:button.ref});}
   catch(e){
    deliveryUnconfirmed=true;
    this.safeAudit('tools_refresh_click_uncertain',{clicked_at:clickedAt,page_id:page,ref:clean(button.ref).slice(0,160),request_id,code:clean(e?.code||'ACTION_UNCONFIRMED').slice(0,48)});
    note(false,{number:chosen.number,code:e?.code||'ACTION_UNCONFIRMED'});
   }
   if(clicked){
    const receipt=this.clickEvidence(clicked,{page,ref:button.ref,request_id,clicked_at:clickedAt});
    deliveryUnconfirmed=receipt.delivery_unconfirmed;this.safeAudit('tools_refresh_click',{...receipt,button:brief(button)});
    note(true,{number:chosen.number,meaning,...this.clickReceipt(clicked,button),delivery_unconfirmed:deliveryUnconfirmed});
   }
   const post=await this.readPostClick(task,page);
   this.safeAudit('tools_refresh_post_click',{page_id:page,clicked_at:clickedAt,checked:post.checked,confirmation:post.confirmation,host_error:post.host_error,code:post.code||null});
   if(post.confirmation){note(false,{code:'CONSENT_DIALOG'});summary='ChatGPT 在等用户确认新工具';summaryKey='refresh.summary.needsUser';summaryParams={};return done({state:'needs_user',url:pending.url,lang,target:brief(button),clicked:true,confirmation:'pending',bring_existing_tab:{action:'select',page_id:page,show:true,requires_user_request:true},...messageMetadata('message','refresh.message.needs_user.confirm'),message:'ChatGPT 在等你确认新工具。请返回原来的 ChatGPT 标签页确认，不要再点刷新。'});}
   if(post.host_error){note(false,{code:'HOST_UI_ERROR'});summary='页面明确报告刷新错误';summaryKey='refresh.summary.hostError';summaryParams={};return done({state:'host_error',url:pending.url,lang,target:brief(button),clicked:true,code:'HOST_UI_ERROR',...messageMetadata('message','refresh.message.host_error.reported'),message:'ChatGPT 页面报告刷新出错，自动刷新未完成。请用户前往已打开的 ChatGPT 标签页，手动点击「刷新工具」。'});}
   at='tools_list';t0=this.now();
   return await this.awaitCorrelatedList({since:clickedAt,page,expected,origin:pending.url,target:brief(button),lang,steps,note,done,deliveryUnconfirmed,onSuccess:async()=>{
    success=true;summary='已核验目标 ChatGPT 页面新工具清单';const key=lang||'_',saved0=this.names?.load?.(),saved=saved0&&typeof saved0==='object'&&!Array.isArray(saved0)?structuredClone(saved0):{},list=Array.isArray(saved[key])?saved[key].filter(x=>typeof x==='string'&&!DANGER.test(x)).slice(-5):[];if(!list.includes(button.name)){list.push(button.name);saved[key]=list.slice(-5);try{await this.names?.save?.(saved);}catch{this.safeAudit('tools_refresh_name_save_failed',{language:key});}}return done({state:'refreshed',target_attested:true,url:pending.url,lang,target:brief(button),clicked:true,learned:{lang:key,name:button.name},...messageMetadata('message','refresh.message.refreshed.bound'),message:'目标 ChatGPT 页面已返回绑定的新工具清单。'});
   }});
  }catch(e){
   note(false,{number:chosen.number,code:e?.code||null,error:clean(e?.message).slice(0,120)});
   if(e?.code==='TOOLS_REFRESH_IDENTITY_MISMATCH'){keepTab=true;return done({state:'identity_required',code:e.code,message:e.message,...messageMetadata('message','refresh.message.not_found.identityMismatch'),...messageMetadata('summary','refresh.summary.identityMismatch')});}
   if(keepTab){success=false;summary='点击后核验出错，自动刷新未完成';summaryKey='refresh.summary.verifyException';summaryParams={};return done({state:'unverified',clicked:true,url:pending.url,code:e?.code||'VERIFY_EXCEPTION',bring_existing_tab:{action:'select',page_id:page,show:true,requires_user_request:true},...messageMetadata('message','refresh.message.unverified.verifyError'),message:'点击后核验出错，自动刷新未完成。请用户前往已打开的 ChatGPT 标签页，手动点击「刷新工具」。'});}
   summary='刷新失败';summaryKey='refresh.summary.failed';summaryParams={};return done({state:HELPER_BROKEN.has(e?.code)?'helper_broken':'failed',code:e?.code||null,...messageMetadata('message',e?.code==='TOOLS_REFRESH_IDENTITY_MISMATCH'?'refresh.message.not_found.identityMismatch':'refresh.message.failed.stepError',e?.code==='TOOLS_REFRESH_IDENTITY_MISMATCH'?{}:errorParams(at,e)),...(e?.code==='TOOLS_REFRESH_IDENTITY_MISMATCH'?messageMetadata('summary','refresh.summary.identityMismatch'):{}),message:(STEP_WORDS[at]||'刷新')+'时出错：'+clean(e?.message||e?.code||'未知原因').slice(0,160)});
  }
  finally{if(task){if(page&&!keepTab)try{await this.call('browser_tabs',{task_id:task,request_id:rid(),action:'close',page_id:page});}catch{}try{await this.call('finish_task',{task_id:task,success,...finishMetadata(this.value,summary,summaryKey,summaryParams)});}catch{}}}
 }
 async _run(reason){
  const base={reason,started_at:this.now()},steps=[];
  let at='helper',t0=this.now(),task=null,page=null,success=false,summary='',summaryKey=null,summaryParams={},keepTab=false,detail=null,clickAttempted=false,refreshClickAttempted=false;
  const step=name=>{at=name;t0=this.now();};
  const note=(ok,extra={})=>{steps.push({step:at,ok,ms:Math.max(0,this.now()-t0),...extra});if(steps.length>24)steps.shift();this.value={...this.value,steps:steps.slice()};};
  const done=value=>this.set({...base,...value,steps:steps.slice(),...(value.state==='refreshed'?{}:{stopped_at:at}),...(detail?{detail_url:detail}:{}),finished_at:this.now()});
  this.pending=null;this.set({...base,state:'running',steps:[]});
  try{
   const identity=this.target();if(!identity){this.assertTarget?.(this.targetContext);this.onAppMissing({reason:'identity_required'},this.targetContext);return done({state:'identity_required',code:'TOOLS_REFRESH_IDENTITY_REQUIRED',message:'尚未确认这台电脑对应的 ChatGPT 插件，已停止刷新，没有点击其他应用。',...messageMetadata('message','refresh.message.identity_required.unbound'),...messageMetadata('summary','refresh.summary.identityRequired')});}
   const helper=await this.waitHelper(reason);note(helper.ok,{code:helper.code||null});
   if(!helper.ok){const storeOld=helper.code==='CHROME_STORE_INCOMPATIBLE';summary=storeOld?'Chrome 插件需要更新':helper.state==='helper_outdated'?'Chrome 插件未更新':'Chrome 插件未连接';summaryKey=storeOld?'refresh.summary.helperStoreOld':helper.state==='helper_outdated'?'refresh.summary.helperOutdated':'refresh.summary.helperUnavailable';return done(helper);}
   this.set({...base,state:'running',steps:steps.slice()});step('task');task=(await this.call('begin_task',{request_id:rid(),title:'刷新 ChatGPT 里的 ChatHand 工具',title_key:'refresh.task.title',title_params:{}}))?.task_id;
   if(!task)throw Object.assign(Error('没开成任务'),{code:'TASK_NOT_STARTED'});
   let url=null,entry=null,completeListAbsent=false;
   for(const candidate of this.urls){
    step('open');const opened=await this.call('browser_open',{task_id:task,request_id:rid(),url:candidate,...(page?{page_id:page}:{})});page=opened?.page_id||page;note(!!page,{url:candidate});if(!page)break;
    step('page');entry=await this.findEntry(task,page,identity);const waited={ok:entry.total>0||!entry.complete,attempts:1};if(entry.complete&&entry.list_ready&&entry.total===0)completeListAbsent=true;note(waited.ok,{url:candidate,attempts:waited.attempts,...(waited.code?{code:waited.code}:{}),...(waited.ok?{}:{headings:await this.headings(task,page)})});
    if(waited.ok){url=candidate;break;}
   }
   if(!url){if(completeListAbsent){this.assertTarget?.(this.targetContext);this.onAppMissing({reason:'refresh_not_found',identity},this.targetContext);}summary='插件页里没看到 '+this.appName();summaryKey='refresh.summary.pageNoApp';summaryParams={appName:(/\p{Script=Han}/u.test(this.appName())?'ChatHand':this.appName())};return done({state:'not_found',code:'TOOLS_REFRESH_IDENTITY_NOT_FOUND',...(completeListAbsent?{missing_reason:'refresh_not_found'}:{}),...messageMetadata('message','refresh.message.not_found.pageNoApp',{seconds:Math.round(this.pageWaitMs/1000),appName:(/\p{Script=Han}/u.test(this.appName())?'ChatHand':this.appName())}),message:`ChatGPT 插件页 ${Math.round(this.pageWaitMs/1000)} 秒里没出现 ${this.appName()}（可能 Chrome 里没登录 ChatGPT，或者页面换了样子）。没有点任何东西。`});}
   step('entry');note(entry.total===1,{count:entry.total});
   if(entry.complete===false){summary='插件列表未完整加载';summaryKey='refresh.summary.identityAmbiguous';summaryParams={};return done({state:'ambiguous',url,...messageMetadata('message','refresh.message.ambiguous.identity'),...messageMetadata('summary','refresh.summary.identityAmbiguous'),message:'插件列表的候选太多或仍在变化，没有读完整，没有点任何东西。',candidates:entry.candidates});}
   if(entry.total!==1){summary='逐项刷新 '+this.appName()+' 候选';summaryKey='refresh.summary.identityAmbiguous';summaryParams={};return done({state:entry.total?'ambiguous':'not_found',code:entry.total?'TOOLS_REFRESH_IDENTITY_AMBIGUOUS':'TOOLS_REFRESH_IDENTITY_NOT_FOUND',url,message:entry.total?'这台电脑对应的 ChatGPT 插件出现多个匹配，已停止刷新，没有点击任何应用。':`插件页里找不到 ${this.appName()} 那一项，没有点任何东西。`,message_key:entry.total?'refresh.message.ambiguous.identity':'refresh.message.not_found.noEntry',message_params:entry.total?{}:{appName:(/\p{Script=Han}/u.test(this.appName())?'ChatHand':this.appName())},...(entry.total?messageMetadata('summary','refresh.summary.identityAmbiguous'):{}),candidates:entry.candidates});}
   this.assertIdentity(identity);await this.onIdentityFound(identity,this.targetContext);const before=await this.allButtons(task,page);
   step('open_entry');this.assertIdentity(identity);clickAttempted=true;const opened=await this.call('browser_action',{task_id:task,request_id:rid(),page_id:page,action:'click',ref:entry.element.ref});
   const landed=pageUrl(opened);if(this.isTargetDetail(landed,identity))detail=landed;note(true,this.clickReceipt(opened,entry.element));
   step('detail');const until=this.now()+this.detailWaitMs;let button=null,after=null,added=[],previous=null,stable=0,attempts=0;
   while(this.now()<until){
    attempts++;after=await this.allButtons(task,page);if(this.isTargetDetail(after.url,identity))detail=after.url;
    // 必须读到当前详情地址，不能用插件列表上同名的刷新按钮。
    if(this.isTargetDetail(after.url,identity)){
     const match=this.matchRefresh(after.elements,after.lang);
     if(match.total>1){note(false,{attempts,count:match.total,url:detail});summary='无法确定「刷新工具」按钮';summaryKey='refresh.summary.buttonAmbiguous';summaryParams={};return done({state:'ambiguous',url:detail,lang:after.lang,candidates:match.candidates,...messageMetadata('message','refresh.message.ambiguous.buttons',{total:match.total}),message:`找到 ${match.total} 个「刷新工具」，认不准是哪个，没有点。`});}
     if(match.total===1){button=match.element;break;}
     added=addedButtons(before.elements,after.elements);const signature=JSON.stringify(added.map(elementKey).sort());stable=signature===previous?stable+1:1;previous=signature;
     if(stable>=2)break;
    }
    await this.sleep(Math.min(1000,Math.max(1,until-this.now())));
   }
   note(!!detail,{attempts,...(detail?{url:detail}:{code:'DETAIL_NOT_READY'})});
   if(!detail||!this.isTargetDetail(after?.url,identity)){summary='未能进入 '+this.appName()+' 页面';summaryKey='refresh.summary.identityMismatch';summaryParams={};return done({state:'not_found',code:'TOOLS_REFRESH_IDENTITY_MISMATCH',url,...messageMetadata('message','refresh.message.not_found.identityMismatch'),...messageMetadata('summary','refresh.summary.identityMismatch'),message:`点击 ${this.appName()} 后 ${Math.round(this.detailWaitMs/1000)} 秒内未能进入 ${this.appName()} 页面，未点击。`});}
   step('button');
   if(!button){
    // 到时间但页面尚未稳定，不把半页按钮交给模型。
    if(stable<2){note(false,{code:'DETAIL_NOT_STABLE'});summary='详情页还没有稳定';summaryKey='refresh.summary.detailNotStable';summaryParams={};return done({state:'not_found',url:detail,...messageMetadata('message','refresh.message.not_found.detailNotStable',{appName:(/\p{Script=Han}/u.test(this.appName())?'ChatHand':this.appName())}),message:this.appName()+' 那一页还在变化，没有点。'});}
    const candidates=added.filter(x=>!x.disabled&&!DANGER.test(x.name)).slice(0,30);
    if(!candidates.length){note(false,{count:0});summary='未找到「刷新工具」';summaryKey='refresh.summary.buttonNotFound';summaryParams={};return done({state:'not_found',url:detail,...messageMetadata('message','refresh.message.not_found.noButton',{appName:(/\p{Script=Han}/u.test(this.appName())?'ChatHand':this.appName())}),message:this.appName()+' 那一页上没有像「刷新工具」的按钮，没有点。'});}
    const buttons=candidates.map((x,i)=>({number:i+1,ref:x.ref,role:x.role,name:x.name,...(x.box?{box:x.box}:{})}));
    this.pending={page,url:detail,identity,lang:after.lang,buttons,at:this.now(),targetContext:this.targetContext};keepTab=true;summary='等待 ChatGPT 识别刷新按钮';summaryKey='refresh.summary.needsAi';summaryParams={};note(false,{count:buttons.length});
    step('ai');return done({state:'needs_ai',url:detail,lang:after.lang,buttons:buttons.map(({ref,...b})=>b),rules:REFRESH_RULES,...messageMetadata('message','refresh.message.needs_ai.unknownButton',{}),message:`ChatHand 认不出页面上的「刷新工具」按钮（页面语言 ${after.lang||'未知'}）。照 rules 从 buttons 里认出那一个，调 tools_refresh_click；拿不准就请用户自己去点。`});
   }
   note(true,{count:1});
   const here=await this.call('browser_find',{task_id:task,page_id:page,limit:5});
   if(!this.isTargetDetail(pageUrl(here),identity)){note(false,{code:'NOT_CHATHAND_PAGE'});summary='页面上没有 '+this.appName();summaryKey='refresh.summary.notAppPage';summaryParams={appName:(/\p{Script=Han}/u.test(this.appName())?'ChatHand':this.appName())};return done({state:'not_found',url,...messageMetadata('message','refresh.message.not_found.notAppPage',{appName:(/\p{Script=Han}/u.test(this.appName())?'ChatHand':this.appName())}),message:'找到的「刷新工具」不在 '+this.appName()+' 的页面里，没有点。'});}
   this.assertIdentity(identity,detail);await this.rememberIdentity(detail,identity,entry.element.name);this.assertIdentity(identity,detail);
   const target=brief(button);step('click');const clickedAt=this.now(),request_id=rid(),expected={...this.expected(),plugin_url:detail};let clicked=null,deliveryUnconfirmed=false;
   clickAttempted=true;refreshClickAttempted=true;keepTab=true;
   try{clicked=await this.call('browser_action',{task_id:task,request_id,page_id:page,action:'click',ref:button.ref});}
   catch(e){
    deliveryUnconfirmed=true;
    this.safeAudit('tools_refresh_click_uncertain',{clicked_at:clickedAt,page_id:page,ref:clean(button.ref).slice(0,160),request_id,code:clean(e?.code||'ACTION_UNCONFIRMED').slice(0,48)});
    note(false,{code:e?.code||'ACTION_UNCONFIRMED'});
   }
   if(clicked){
    const receipt=this.clickEvidence(clicked,{page,ref:button.ref,request_id,clicked_at:clickedAt});
    deliveryUnconfirmed=receipt.delivery_unconfirmed;
    this.safeAudit('tools_refresh_click',{...receipt,button:target});
    note(true,{...this.clickReceipt(clicked,button),delivery_unconfirmed:deliveryUnconfirmed});
   }
   const post=await this.readPostClick(task,page);
   this.safeAudit('tools_refresh_post_click',{page_id:page,clicked_at:clickedAt,checked:post.checked,confirmation:post.confirmation,host_error:post.host_error,code:post.code||null});
   if(post.confirmation){note(false,{code:'CONSENT_DIALOG'});summary='ChatGPT 在等用户确认新工具';summaryKey='refresh.summary.needsUser';summaryParams={};return done({state:'needs_user',url:detail,target,clicked:true,confirmation:'pending',bring_existing_tab:{action:'select',page_id:page,show:true,requires_user_request:true},...messageMetadata('message','refresh.message.needs_user.confirm'),message:'ChatGPT 在等你确认新工具。请回到原来的 ChatGPT 标签页确认，不要再点刷新。'});}
   if(post.host_error){note(false,{code:'HOST_UI_ERROR'});summary='页面明确报告刷新错误';summaryKey='refresh.summary.hostError';summaryParams={};return done({state:'host_error',url:detail,target,clicked:true,code:'HOST_UI_ERROR',...messageMetadata('message','refresh.message.host_error.reported'),message:'ChatGPT 页面报告刷新出错，自动刷新未完成。请用户前往已打开的 ChatGPT 标签页，手动点击「刷新工具」。'});}
   step('tools_list');
   return await this.awaitCorrelatedList({since:clickedAt,page,expected,origin:detail,target,lang:after.lang,steps,note,done,deliveryUnconfirmed,onSuccess:async()=>{
    success=true;await this.rememberIdentity(detail,identity,entry.element.name);summary='已核验目标 ChatGPT 页面新工具清单';return done({state:'refreshed',target_attested:true,url:detail,lang:after.lang,target,clicked:true,...messageMetadata('message','refresh.message.refreshed.bound'),message:'目标 ChatGPT 页面已返回绑定的新工具清单。'});
   }});
  }catch(e){
   note(false,{code:e?.code||null,error:clean(e?.message).slice(0,120),...(e?.attempts?{attempts:e.attempts}:{})});summary='刷新失败';summaryKey='refresh.summary.failed';summaryParams={};
   if(refreshClickAttempted){success=false;summary='点击后核验出错，自动刷新未完成';summaryKey='refresh.summary.verifyException';summaryParams={};return done({state:'unverified',clicked:true,url:detail,code:e?.code||'VERIFY_EXCEPTION',bring_existing_tab:{action:'select',page_id:page,show:true,requires_user_request:true},...messageMetadata('message','refresh.message.unverified.verifyError'),message:'点击后核验出错，自动刷新未完成。请用户前往已打开的 ChatGPT 标签页，手动点击「刷新工具」。'});}
   if(HELPER_BROKEN.has(e?.code))return done({state:'helper_broken',code:e.code,...messageMetadata('message',clickAttempted?'refresh.message.helper_broken.afterClick':'refresh.message.helper_broken.noClick',{code:displayParam(e.code)}),message:`Chrome 插件出现异常（${e.code}），请在 chrome://extensions 重新加载「ChatHand Chrome 插件」后重试。`+(clickAttempted?'':'未执行任何点击。')});
   return done({state:'failed',...messageMetadata('message',e?.code==='TOOLS_REFRESH_IDENTITY_MISMATCH'?'refresh.message.not_found.identityMismatch':'refresh.message.failed.stepError',e?.code==='TOOLS_REFRESH_IDENTITY_MISMATCH'?{}:errorParams(at,e)),...(e?.code==='TOOLS_REFRESH_IDENTITY_MISMATCH'?messageMetadata('summary','refresh.summary.identityMismatch'):{}),message:`${STEP_WORDS[at]||'刷新'}时出错：`+clean(e?.message||e?.code||'未知原因').slice(0,160),code:e?.code||null});
  }finally{
   if(task){if(page&&!keepTab)try{await this.call('browser_tabs',{task_id:task,request_id:rid(),action:'close',page_id:page});}catch{}try{await this.call('finish_task',{task_id:task,success,...finishMetadata(this.value,summary,summaryKey,summaryParams)});}catch{}}
  }
 }
 isDetail(url){return typeof url==='string'&&url.startsWith(this.pluginsUrl+'/');}
 async waitHelper(reason){
  // 1081（Claude，Ken 10/27）：插件装过、只是没连上（Chrome 没开），先叫醒 Chrome 一次（ExtensionBrowser.wakeAndWait，会等它连上），再接着看。
  let woke=false;const wake=async ext=>{if(woke||typeof this.wakeChrome!=='function'||!(ext?.installed===true||ext?.last_seen))return false;woke=true;try{await this.wakeChrome();}catch{}return true;};
  if(storeMode(this.distribution)){
   const offlineUntil=this.now()+(reason==='update'?45000:0);
   for(;;){
    if(this.distribution.configuration_state!=='ready')return {ok:false,state:'unavailable',code:'CHROME_STORE_CONFIGURATION_PENDING'};
    const status=await this.call('browser_status',{}),ext=status?.extension;
    if((status?.selected_backend||'extension')!=='extension')return {ok:false,state:'unavailable',code:'EXTENSION_DISCONNECTED'};
    // 1081（Claude，Ken 10/27）：只缺后来加的动作的插件照常能用来刷新。
    if(ext?.connected===true)return chromeStoreUsable(ext.compatibility)?{ok:true}:{ok:false,state:'helper_outdated',code:'CHROME_STORE_INCOMPATIBLE'};
    if(await wake(ext))continue;
    if(this.now()>=offlineUntil)return {ok:false,state:'unavailable',code:'EXTENSION_DISCONNECTED'};
    await this.sleep(Math.min(1500,Math.max(1,offlineUntil-this.now())));
   }
  }
  const offlineUntil=this.now()+(reason==='update'?45000:0);let status=null,manualUntil=null,updateUntil=null,lastHelper=null;
  for(;;){
   try{status=await this.call('browser_status',{});}catch(e){if(HELPER_BROKEN.has(e?.code))throw e;status=null;}
   const connected=(status?.selected_backend||'extension')==='extension'&&status?.extension?.connected===true,h=status?.extension?.helper;
   if(!connected&&(status?.selected_backend||'extension')==='extension'&&await wake(status?.extension))continue;
   if(connected){
    if(!h||['current','unknown'].includes(h.state))return {ok:true};lastHelper=h;
    if(['outdated','wrong_folder','reload_failed'].includes(h.state)||h.state==='stale'&&h.self_reload_supported===false){
     manualUntil??=this.now()+this.helperManualWaitMs;
     this.set({...this.value,state:'running',waiting:'helper_manual',...messageMetadata('message','refresh.message.running.helperManual',{helperMessage:h.message_key?{key:h.message_key,params:h.message_params}:{key:'refresh.helperReload.text'}}),message:(h.message||'Chrome 插件需要重新加载。')+'换好以后，ChatHand 会接着替你刷新工具。'});
    }else{updateUntil??=this.now()+this.helperWaitMs;this.set({...this.value,state:'running',waiting:'helper_update',...messageMetadata('message','refresh.message.running.helperUpdating'),message:'Chrome 插件正在换成新版，等它好了接着刷新。'});}
   }
   const until=manualUntil??updateUntil??offlineUntil;
   if(this.now()>=until)return lastHelper?{ok:false,state:'helper_outdated',...messageMetadata('message',lastHelper.message_key||'refresh.message.helper_outdated.fallback',lastHelper.message_params),message:lastHelper.message||'Chrome 插件未更新，请在 chrome://extensions 重新加载「ChatHand Chrome 插件」。'}:{ok:false,state:'unavailable',code:status?.extension?.code||null,...messageMetadata('message','refresh.message.unavailable.notConnected'),message:'Chrome 插件未连接，无法自动点击。'};
   await this.sleep(Math.min(1500,Math.max(1,until-this.now())));
  }
 }
 async waitTargetDetail(task,page,identity,ms){
  const until=this.now()+ms;let attempts=0;
  while(this.now()<until){this.assertIdentity(identity);attempts++;const here=await this.call('browser_find',{task_id:task,page_id:page,limit:1});if(this.isTargetDetail(pageUrl(here),identity))return {ok:true,attempts};await this.sleep(Math.min(500,Math.max(1,until-this.now())));}
  return {ok:false,attempts,code:'TOOLS_REFRESH_IDENTITY_NOT_FOUND'};
 }
 async waitText(task,page,text,ms){
  const until=this.now()+ms;let code=null,attempts=0;
  while(this.now()<until){const started=this.now(),left=Math.max(1000,Math.min(15000,until-started));attempts++;
   try{await this.call('browser_wait_for',{task_id:task,request_id:rid(),page_id:page,condition:{kind:'text',text,timeout_ms:left}});return {ok:true,attempts,code};}
   catch(e){code=e?.code||'WAIT_FAILED';if(FATAL.test(code)||HELPER_BROKEN.has(code)){e.attempts=attempts;throw e;}if(code!=='WAIT_TIMEOUT'||this.now()<=started)await this.sleep(Math.min(1000,Math.max(1,until-this.now())));}
  }
  return {ok:false,code:code||'WAIT_TIMEOUT',attempts};
 }
 async headings(task,page){try{return (await this.find(task,page,{role:'heading'})).slice(0,3).map(x=>x.name.slice(0,40));}catch(e){if(HELPER_BROKEN.has(e?.code)||FATAL.test(e?.code||''))throw e;return [];}}
 async find(task,page,args){const r=await this.call('browser_find',{task_id:task,page_id:page,limit:20,...args});return (Array.isArray(r?.elements)?r.elements:[]).map(x=>({...x,name:String(x.name??'')}));}
 async allButtons(task,page){
  const elements=[];let offset=0,url=null,lang=null;const visited=new Set();
  while(elements.length<300&&!visited.has(offset)){visited.add(offset);const r=await this.call('browser_find',{task_id:task,page_id:page,role:'button',limit:100,boxes:true,...(offset?{offset}:{})});
   const currentUrl=pageUrl(r);if(url&&currentUrl&&url!==currentUrl)throw Object.assign(Error('取按钮时页面发生变化'),{code:'SNAPSHOT_STALE'});url=currentUrl||url;lang=typeof r?.lang==='string'?r.lang.toLowerCase():lang;
   const chunk=(Array.isArray(r?.elements)?r.elements:[]).map(x=>({...x,name:String(x.name??'')}));for(const x of chunk)if(x.role==='button'&&!elements.some(y=>y.ref===x.ref))elements.push(x);
   if(!Number.isInteger(r?.next_offset)||r.next_offset<=offset||!chunk.length)break;offset=r.next_offset;
  }
  return {elements:elements.slice(0,300),url,lang};
 }
 knownNames(lang){
  let saved={};try{const v=this.names?.load?.();if(v&&typeof v==='object'&&!Array.isArray(v))saved=v;}catch{}
  const full=String(lang||'').toLowerCase(),main=full.split('-')[0],groups=[saved[full],saved[main],REFRESH_NAMES_BUILTIN[main],...Object.values(saved),...Object.values(REFRESH_NAMES_BUILTIN)],names=[];
  for(const values of groups)if(Array.isArray(values))for(const n of values)if(typeof n==='string'&&n.length<=200&&!DANGER.test(n)&&!names.includes(n))names.push(n);
  return names;
 }
 matchRefresh(elements,lang){const names=this.knownNames(lang),all=elements.filter(x=>x.role==='button'&&!x.disabled&&!DANGER.test(x.name)&&names.includes(x.name));return {total:all.length,element:all[0]||null,candidates:all.slice(0,5).map(brief)};}
 async findRefresh(task,page){const all=await this.allButtons(task,page);return this.matchRefresh(all.elements,all.lang);}
 async findEntry(task,page,identity=this.target()){
  let complete=true,listReady=false,listURL=null,totalKnown=null;
  const read=async()=>{let raw=[],offset=0;listReady=false;listURL=null;totalKnown=null;const visited=new Set();complete=true;for(;;){
   if(visited.has(offset)||raw.length>=300){complete=false;break;}visited.add(offset);
   const r=await this.call('browser_find',{task_id:task,page_id:page,boxes:true,limit:100,...(offset?{offset}:{})});
   const chunk=Array.isArray(r?.elements)?r.elements:[];raw.push(...chunk);const observed=pageUrl(r);if(listURL&&observed!==listURL){complete=false;break;}listURL=observed;if(r.truncated===true||r.partial===true||r.frames_truncated===true||r.ax_nodes_truncated===true||r.loading===true||chunk.some(x=>x.role==='progressbar')||Array.isArray(r.unsupported_frames)&&r.unsupported_frames.length>0||r.has_more===true&&!Number.isInteger(r.next_offset)||r.next_offset!==undefined&&r.next_offset!==null&&!Number.isInteger(r.next_offset)){complete=false;break;}if(Number.isInteger(r.total_elements)&&r.total_elements>=0){if(totalKnown!==null&&totalKnown!==r.total_elements){complete=false;break;}totalKnown=r.total_elements;}else totalKnown=-1;const onList=typeof observed==='string'&&this.urls.includes(observed);if(onList&&(chunk.some(x=>this.canonicalDetail(x.href||x.url)||x.role==='heading'&&/^(?:Apps|Your apps|Connected apps|Connectors|应用|你的应用|已连接的应用|插件)$/i.test(clean(x.name)))))listReady=true;
   if(!Number.isInteger(r?.next_offset)){if(totalKnown>=0&&raw.length!==totalKnown)complete=false;break;}if(r.next_offset<=offset||!chunk.length){complete=false;break;}offset=r.next_offset;
  }
  return dedupeRefreshEntries(raw.map(x=>({...x,name:String(x.name??'')})).filter(x=>ENTRY_ROLES.has(x.role)&&!x.disabled&&(x.role==='link'&&this.isTargetDetail(x.href||x.url,identity)||!DANGER.test(x.name)))).filter(x=>{
   if(!identity)return false;const url=x.href||x.url,id=x.app_id||x.application_id||x.applicationID;
   if(url)return this.isTargetDetail(url,identity)&&(!id||sameChatGPTAppId(id,identity.app_id));
   return !identity.detail_url&&sameChatGPTAppId(id,identity.app_id);
  });};
  const until=this.now()+this.pageWaitMs;let all=[];
  for(;;){
   try{all=await read();}
   catch(error){if(error?.code!=='PAGE_NOT_ALLOWED')throw error;complete=true;listReady=false;listURL=null;totalKnown=null;all=[];}
   if(all.length||!identity||!complete||this.now()>=until)break;
   await this.sleep(Math.min(500,Math.max(1,until-this.now())));
  }
  if(!all.length&&complete&&listReady){const proof=await this.call('browser_snapshot',{task_id:task,page_id:page,limit:1});listReady=pageUrl(proof)===listURL&&proof.frames_truncated===false&&proof.ax_nodes_truncated===false&&Array.isArray(proof.unsupported_frames)&&proof.unsupported_frames.length===0&&totalKnown>=0&&!proof.loading&&!proof.partial&&!proof.truncated&&!/progressbar|(?:status).*loading/i.test(proof.aria_yaml||'');}
  return {total:all.length,complete,list_ready:listReady,element:complete&&all.length===1?all[0]:null,candidates:all.slice(0,300).map(x=>({role:x.role,name:x.name.slice(0,60)}))};
 }

 clickReceipt(r,element){const c=r?.click||{},changes=r?.changes||{};return {target:brief(element),box:c.box||element.box||null,point:c.point||null,url:pageUrl(r),url_changed:changes.url_changed===true};} // 不保存未核实页面变更内容。
 // 1050 delta: only a service-authenticated, installation-bound, host-attested list may prove this page refreshed.
 listCorrelation(since,page,expected){
  const events=(this.seen()||[]).filter(e=>e&&typeof e==='object'&&e.kind==='tools_list'&&Number.isFinite(e.at)&&e.at>=since&&e.at<=this.now());
  const contract=e=>Number.isInteger(expected?.connector_api)&&expected.connector_api>0&&Number.isInteger(expected?.tool_count)&&expected.tool_count>0&&/^[a-f0-9]{64}$/.test(expected?.schema_sha256||'')&&e.contract?.connector_api===expected.connector_api&&e.contract?.tool_count===expected.tool_count&&e.contract?.schema_sha256===expected.schema_sha256;
  const installation=e=>!!expected?.build&&!!expected?.instance_id&&!!expected?.connection_tag&&!!expected?.principal_tag&&e.installation?.build===expected.build&&e.installation?.instance_id===expected.instance_id&&e.connection_tag===expected.connection_tag&&e.principal_tag===expected.principal_tag;
  const authenticated=e=>e.source==='trusted_server'&&e.authenticated===true&&e.caller==='chatgpt'&&e.route===expected?.route&&['local_http','relay'].includes(e.route);
  const same=events.filter(e=>contract(e)&&installation(e)&&authenticated(e));
  const match=same.find(e=>e.host_binding?.attested_by==='trusted_host'&&e.host_binding?.page_id===page&&e.host_binding?.plugin_url===expected?.plugin_url)||null;
  const missing=[];
  if(!expected?.build||!expected?.instance_id)missing.push('installation_identity');
  if(!expected?.connection_tag||!expected?.principal_tag)missing.push('authenticated_principal');
  if(!events.length)missing.push('tools_list_not_observed');
  else if(!same.length)missing.push('contract_or_connection_not_matched');
  else if(!match)missing.push('target_chatgpt_page_not_attested');
  return {match,observed:events.length,same_connection:same.length,missing};
 }
 safeAudit(event,fields={}){try{this.audit({event,at:this.now(),...fields});}catch{}}
 async readPostClick(task,page){
  try{
   const r=await this.call('browser_snapshot',{task_id:task,page_id:page,limit:120});
   const nodes=[...(Array.isArray(r?.elements)?r.elements:[]),...(Array.isArray(r?.snapshot?.elements)?r.snapshot.elements:[])];
   const aria=[r?.aria_yaml,r?.aria,r?.snapshot?.aria_yaml,r?.snapshot?.aria].find(x=>typeof x==='string')||'';
   const blocks=[...aria.matchAll(/(?:^|\n)[ \t]*- (?:alertdialog|dialog)\b[^\n]*(?:\n[ \t]{2,}[^\n]*){0,30}/gi)].map(x=>x[0]);
   const dialogs=nodes.filter(x=>['dialog','alertdialog'].includes(x?.role));
   const confirmation=blocks.some(s=>/(?:- button[^\n]*(?:允许|同意|确认|接受|授权|继续|Allow|Approve|Accept|Confirm|Authorize|Continue))/i.test(s))||dialogs.some(d=>Array.isArray(d.buttons)&&d.buttons.some(b=>CONSENT.test(clean(b?.name||b))));
   const hostError=nodes.some(x=>x?.role==='alert'&&/(?:失败|错误|Error|Failed)/i.test(clean(x.name)))||/(?:^|\n)[ \t]*- alert[^\n]*(?:失败|错误|Error|Failed)/i.test(aria);
   return {checked:true,confirmation,host_error:hostError};
  }catch(e){return {checked:false,confirmation:false,host_error:false,code:clean(e?.code||'SNAPSHOT_UNAVAILABLE').slice(0,48)};}
 }
 clickEvidence(r,{page,ref,request_id,clicked_at}){
  const status=['completed','ok','failed'].includes(r?.status)?r.status:'unknown',raw=clean(r?.delivery?.state||r?.click?.delivery||r?.dispatch?.state||'').toLowerCase(),delivery=['dispatched','delivered','acknowledged','unconfirmed','failed','received'].includes(raw)?raw:null;
  return {clicked_at,page_id:page,ref:clean(ref).slice(0,160),request_id,status,delivery:delivery||null,delivery_unconfirmed:r?.delivery_unconfirmed===true||r?.click?.delivery_unconfirmed===true||status==='unknown'};
 }
 async awaitCorrelatedList({since,page,expected,origin,target,lang,steps,note,done,deliveryUnconfirmed=false,onSuccess}){
  const end=since+this.observeMs,first=Math.min(end,since+this.toolsListWaitMs);
  let intermediate=false;
  while(true){
   this.assertTarget?.(this.targetContext);
   const proof=this.listCorrelation(since,page,expected);
   if(proof.match){
    note(true,{list_correlation:'host_attested',observed:proof.observed});this.safeAudit('tools_refresh_correlated',{page_id:page,clicked_at:since,correlation:'host_attested',contract_api:expected?.connector_api||null,contract_count:expected?.tool_count||null});
    return await onSuccess();
   }
   if(!intermediate&&this.now()>=first){
    intermediate=true;
    this.set({...this.value,state:'running',waiting:'tools_list',...messageMetadata('message','refresh.message.running.verifying'),message:'已尝试点击刷新，正在后台核对新工具清单；不重复点击。',steps:steps.slice(),correlation:{observed:proof.observed,same_connection:proof.same_connection,missing:proof.missing}});
   }
   if(this.now()>=end){
    const reason=deliveryUnconfirmed?'dispatch_unconfirmed':proof.same_connection?'host_unbound':proof.observed?'other_list':'no_list';
    note(false,{code:'LIST_NOT_CORRELATED',reason});this.safeAudit('tools_refresh_unverified',{page_id:page,clicked_at:since,reason,missing:proof.missing});
    return done({state:deliveryUnconfirmed?'dispatch_unconfirmed':'unverified',url:origin,lang,target,clicked:true,waiting:null,bring_existing_tab:{action:'select',page_id:page,show:true,requires_user_request:true},correlation:{observed:proof.observed,same_connection:proof.same_connection,missing:proof.missing},...messageMetadata('message',deliveryUnconfirmed?'refresh.message.dispatch_unconfirmed.notConfirmed':reason==='host_unbound'?'refresh.message.unverified.hostUnbound':'refresh.message.unverified.noBoundList'),message:deliveryUnconfirmed?'点击没有确认送达，自动刷新未完成。请用户前往已打开的 ChatGPT 标签页，手动点击「刷新工具」。':reason==='host_unbound'?'这条连接取过工具清单，但不能证明是这个标签页取的，自动刷新未完成。请用户前往已打开的 ChatGPT 标签页，手动点击「刷新工具」。':'没有取得这个标签页的新工具清单，自动刷新未完成。请用户前往已打开的 ChatGPT 标签页，手动点击「刷新工具」。'});
   }
   await this.sleep(Math.min(500,Math.max(1,Math.min(end,intermediate?end:first)-this.now())));
  }
 }
 async consentDialog(task,page,clickedName){
  try{for(const role of ['alertdialog','dialog'])for(const box of await this.find(task,page,{role})){const hit=(await this.find(task,page,{role:'button',scope_ref:box.ref})).find(x=>CONSENT.test(x.name)&&x.name!==clickedName&&!DANGER.test(x.name));if(hit)return hit.name.slice(0,40);}return null;}
  catch(e){if(HELPER_BROKEN.has(e?.code)||FATAL.test(e?.code||''))throw e;return null;}
 }
}
