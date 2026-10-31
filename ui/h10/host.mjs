import {uiText,subscribe} from '../local-text.mjs';
/** ONE1052 H10 production adapter.
 * All status comes from the live desktop snapshot, never the static review fixture.
 * This adapter is a view, not a principal, health oracle, or pairing credential reader.
 */
import {mountH10,renderH10,STEP_TITLES} from './views.mjs';
import {assets} from './assets.mjs';
import {installationHandoff,siteCreationHandoff,siteAssistedSentence,siteTemplateFileFollowup,siteUpdateHandoff,siteRouteCopy,sitePairingErrorCopy} from './prompts.mjs';

// Images in approved assets.mjs use paths relative to its original standalone
// HTML. In the App their HTML image URLs must resolve under /h10/assets/.
const productionSrc=src=>typeof src==='string'&&src.startsWith('./assets/')?'/h10/'+src.slice(2):src;
const productionAssets=Object.freeze(Object.fromEntries(Object.entries(assets).map(([name,asset])=>[
 name,{...asset,get alt(){return asset.alt;},src:productionSrc(asset.src),
  ...(asset.presentation?.kind==='source-html-layers'?{
   presentation:{...asset.presentation,
    base:{...asset.presentation.base,src:productionSrc(asset.presentation.base.src)},
    callout:{...asset.presentation.callout,src:productionSrc(asset.presentation.callout.src)}}}: {})}
])));

const overlay=document.createElement('section');
overlay.id='h10Host'; overlay.hidden=true; overlay.tabIndex=-1;
overlay.setAttribute('aria-label',uiText("ui.h10.host.accessibleTitle"));
const notice=document.createElement('p');
notice.id='h10HostNotice'; notice.setAttribute('role','status');
const stage=document.createElement('div');
stage.id='h10HostStage';
const actions=document.createElement('div');
actions.id='h10HostExtra';
overlay.append(notice,stage,actions); // 0012（Claude）：顶上的选择条去掉了，「换一种连接方式」改成弹框（见下面 routeDialog）
document.body.append(overlay);

const bridge=()=>window.ChatHandH10Bridge||null;
let opened=false,dispose=null,screen='f6',setupMode='manual',actor='user',manualPicked=false;
let completionMarkup=null;
let route='openai',guideStep=1,guideMedia=null,noticeText='',busy=false,routeChosen=false;
// 1083（Claude，Ken 10/28 21:38）：没选过连接方式时默认 OpenAI 通道（原来是 ChatGPT Site），Site 放到后面。
let prefill='unconfirmed',launchState='idle',proofExpiryTimer=null,launched=false;
// 1069（Claude）：firstRun 管标题写「首次设置」还是「连接设置」；fresh* 是「重新配」那一次的起点，
// 起点之前就测通过的不算这一次配完；activityOpened／seenFinishedAt 让「AI 在配」「配完了」各只自动开一次窗口。
let firstRun=true,freshFrom=0,freshVerified=null,activityOpened=false,seenFinishedAt=0,doneShownAt=0;
let pressing=false,renderPending=false;
let siteCheck=null,completeRequested=false; // 1068（Claude）：F12 卡片里那一句检查结果；完成页只替你记一次「配完了」
 // 0010：鼠标按着时先不重画（见选择条点击那段）
// 1052 C4/C6（Claude）：F11 自己收、凭据过期页、模板文件退路、一句话。
// watch 只是界面这边记的「有没有请 server 开始等」；真正看剪贴板的是原生。
// 1070 四（Claude）：后台从最后一次真进展起最多等 15 分钟，ChatGPT 往前走一步就续上；expires_at 照实报，界面照它显示，续了跟着续。
let receivePurpose='pair',receiveEnteredAt=0,receiveBaseline=null,receiveLocal=null;
const IDLE_WATCH=Object.freeze({state:'idle',expiresAt:0,id:''});
let watch=IDLE_WATCH,watchTimer=null,templateFileMode=false,assistedCopied=false,assistedWeb=false;
const WATCH_MAX_MS=15*60*1000;
function clearProofExpiryTimer(){if(proofExpiryTimer!==null)clearTimeout(proofExpiryTimer);proofExpiryTimer=null;}
let userSelectedDMG=null; // only a native NSOpenPanel-confirmed source, never browser/UI text
const APPROVED_F5_COMMAND='xattr -dr com.apple.quarantine /Applications/ChatHand.app';
let f5Command=null;
async function loadF5Command(){
 // The native App alone verifies its exact installed bundle path.
 let r;try{r=await bridge()?.native?.('approvedF5TerminalCommand');}catch{}
 f5Command=r?.target==='/Applications/ChatHand.app'&&r?.command===APPROVED_F5_COMMAND&&
  r?.executed===false&&r?.user_must_run===true?APPROVED_F5_COMMAND:null;
 if(opened&&screen==='f5')render();
}
// 1081 N203（Claude）：旧的私有发布桥（Site 上 /release/bridge）退役：不再读发布配置、不再生成或打开那个地址。
// 安装只认原生文件选择的本地 DMG 和挂载 DMG 旁的 App；更新照旧走 GitHub。
// 1081（Claude）：ChatGPT 里这台 Mac 的插件名（settings.chatgpt_app_name）；没有就是 ChatHand。试用的话和完成页都用它。
const appName=()=>{const v=current()?.settings?.chatgpt_app_name;return (typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,60):'')||'ChatHand';};
const approvedSample=scope=>scope==='folder'
 ? uiText("ui.h10.host.folderSample",{app:appName()})
 : uiText("ui.h10.host.computerSample",{app:appName()});
const safeCode=e=>{
 const raw=e?.error_code||e?.code||e?.error?.code;
 return typeof raw==='string'&&/^[A-Z0-9_]{1,80}$/.test(raw)?raw:'OPERATION_UNAVAILABLE';
};
const current=()=>bridge()?.state?.()||null;
const bState=()=>current()?.site_b||{};
const isHealthy=(b,r)=>b?.routes?.[r]?.configured===true&&b.routes[r].state==='healthy'&&b.routes[r].health_fresh===true;
const descriptor=()=>{
 // User-picked local source is a candidate only; normal packaged setup verifies
 // the real App signature. No UI flag becomes verified_by_release_pipeline.
 if(userSelectedDMG?.user_selected===true&&userSelectedDMG?.payload_type==='dmg'&&
    userSelectedDMG?.signature_verified===false&&
    typeof userSelectedDMG.path==='string'&&userSelectedDMG.path.startsWith('/')&&
    userSelectedDMG.path.endsWith('.dmg'))return {localPath:userSelectedDMG.path};
 const d=bridge()?.installationDescriptor?.();return d&&typeof d==='object'?d:{};
};
const handoff=()=>installationHandoff(descriptor());
const siteHandoff=()=>siteCreationHandoff(bridge()?.siteTemplateDescriptor?.()||{});
// 1052（Claude）：Site 现在能不能在这里建或继续：有核验过的建站模板，或者这台 Mac 已经配过 Site。
// 1081（Claude，Ken 10/26）：「核验过的建站模板」那份描述要先开过一次 Site 配对（24 小时内）才有。新装、或者隔一天再来，
// Site 就被当成建不了：连接页写「ChatGPT Site 现在还不能在这里建」，帮我配被悄悄换成 OpenAI 通道。
// 改成：这版带了模板（本机服务说 template_ready 不是 false）就能建；真到了建站那一页（F10）还没有描述，先开一次 Site 配对拿到它。
const siteCreatable=()=>siteHandoff().configured===true||bState().routes?.site?.configured===true||bState().pairing?.template_ready!==false;
let sitePriming=false,siteRetrying=false,sitePrimeError=null,siteRetryFailure=null;
// 1082（Claude，Ken 10/28 16:22）：进建站页时本机服务可能刚启动、还没应答。第一次没拿到建站那句话，隔 0.8 秒静默再开一次，
// 这段时间页面照旧是「正在准备」的样子（按钮灰着）；两次都没拿到，才出「暂时无法创建 ChatGPT Site」。
// 等的时候离开了这一页就不再开。点「再试一次」是用户自己点的，只开一次（silentRetry:false）。
const SITE_PRIME_RETRY_MS=800;
async function primeSiteTemplate({silentRetry=true}={}){
 if(sitePriming||siteHandoff().configured===true||bState().pairing?.template_ready===false)return;
 sitePriming=true;sitePrimeError=null;render();
 try{
  // 1083（Claude）：建 Site 前先查网络（进这一页时 render 已经开始查）。等它查完；被拦就不开 Site 配对，这一页换成被拦的样子。
  if(siteNet.state==='checking')await siteNet.pending;
  if(siteNetBlocked()&&siteNetFresh())return;
  for(let attempt=1;;attempt++){
   try{await api('/api/setup/site/start',{});sitePrimeError=null;await bridge()?.refresh?.();}catch(err){sitePrimeError=safeCode(err);}
   // 本机服务开 Site 配对以前自己也查一次，被拦回 SITE_NETWORK_CHALLENGED / SITE_NETWORK_UNREACHABLE：记成查过的结果，
   // 不再静默重试，也不算「拿不到建站那句话」。
   const net=siteNetResult(sitePrimeError);if(net){noteSiteNet(net);sitePrimeError=null;break;}
   if(!silentRetry||attempt>=2||screen!=='f10'||siteHandoff().configured===true||bState().pairing?.template_ready===false)break;
   await new Promise(resolve=>setTimeout(resolve,SITE_PRIME_RETRY_MS));
   if(screen!=='f10')break;
  }
 }finally{sitePriming=false;render();}
}
// 1081（Claude，Ken 10/26）：「暂时无法创建 ChatGPT Site」那一页的「再试一次」：原地再开一次 Site 配对。
// 1082（Claude，Ken 10/28 15:50）：还是拿不到时不再往按钮底下加一行橙字（也不进顶上的提示条），只记下「重试失败过」和错误码；
// 页面据此换成第二种样子：副标题变成橙色的「本机配置仍未就绪（错误码）…」（Ken 16:22 的字），主次按钮对调。拿到了就清掉。
async function retrySiteTemplate(){
 if(siteRetrying)return;
 siteRetrying=true;noticeText='';render();
 try{await primeSiteTemplate({silentRetry:false});}
 finally{siteRetrying=false;}
 if(siteHandoff().configured===true)siteRetryFailure=null;
 else if(screen==='f10'&&!siteNetBlocked())siteRetryFailure={code:sitePrimeError||null};
 render();
}
// 1083（Claude，Ken 10/28 21:38）：建 Site 以前先查这台 Mac 的网络会不会被 Site 的网络验证（Cloudflare）拦住。
// 本机服务 /api/setup/site/network-check 回 clear / challenged / unreachable，后台自己留 60 秒；这里也记 60 秒，
// 60 秒内再要就用那次的。接口报错、或者回的不认识（老版本本机服务、测试的假后台），都当没被拦：真开始建 Site 时本机服务还会再查，被拦回错误码。
// 查的是 Site 还没连好、选的是 Site 时的「选怎么配」（F6）和「建 Site」（F10）两页；被拦以后点「重新检查」，
// 查的时候还是被拦那一页（prev），只把按钮换成「正在检查…」。
let siteNet={state:'idle',at:0,prev:null,pending:null},siteNetSeq=0,siteNetCtx='';
const SITE_NET_TTL=60*1000;
const siteNetFresh=()=>['clear','challenged','unreachable'].includes(siteNet.state)&&Date.now()-siteNet.at<SITE_NET_TTL;
const siteNetBlocked=()=>siteNet.state==='challenged'||siteNet.state==='unreachable';
const siteNetClear=()=>siteNet.state==='clear'&&siteNetFresh();
const siteNetResult=code=>code==='SITE_NETWORK_CHALLENGED'?'challenged':code==='SITE_NETWORK_UNREACHABLE'?'unreachable':null;
function noteSiteNet(result){siteNetSeq++;siteNet={state:result,at:Date.now(),prev:null,pending:null};}
// 只发请求、改状态，不在这里重画（render 里也会调它）；查完自己重画一次。查的时候又开了一次新的，旧的那次回来就不算。
function startSiteNetCheck(force=false){
 const seq=++siteNetSeq,prev=siteNetBlocked()?siteNet.state:siteNet.state==='checking'?siteNet.prev:null;
 const pending=(async()=>{
  let r=null;try{r=await api('/api/setup/site/network-check',force?{force:true}:{});}catch{r=null;}
  const result=['clear','challenged','unreachable'].includes(r?.result)?r.result:'clear';
  if(seq===siteNetSeq){siteNet={state:result,at:Date.now(),prev:null,pending:null};render();}
  return result;
 })();
 siteNet={state:'checking',at:0,prev,pending};
 return pending;
}
const siteNetNeeded=()=>route==='site'&&!isHealthy(bState(),'site');
async function ensureSiteNetwork(){if(siteNetFresh())return siteNet.state;if(siteNet.state==='checking')return siteNet.pending;const p=startSiteNetCheck();render();return p;}
async function siteNetworkBlocks(){if(!siteNetNeeded())return false;const r=await ensureSiteNetwork();return r==='challenged'||r==='unreachable';}
// 被拦那一页的「重新检查」：不用 60 秒内那次，重查。在「建 Site」那页查通了，接着去拿建站那句话。
async function recheckSiteNetwork(){
 if(siteNet.state==='checking')return;
 const pending=startSiteNetCheck(true);render();
 const r=await pending;
 if(opened&&screen==='f10'&&route==='site'&&r==='clear')void primeSiteTemplate();
}
const routeName=r=>r==='site'?'ChatGPT Site':uiText("ui.h10.host.openaiRoute");
// 1066 第 77 条（Claude）：OpenAI 通道帮我配也在 F7 里走，下面三个只读 snapshot，跟 app.js 的 tunnelId()/connected() 同一个判断。
const openaiTunnel=s=>!!(s?.settings?.tunnel?.tunnel_id||s?.connection?.tunnel_id||s?.settings?.setup_tunnel_id);
const openaiLinked=s=>{const c=s?.connection||{};return !!(c.display?c.display.connected:c.ready&&c.healthy&&c.control_plane?.state!=='down');};
// 完成页两个开关：Chrome 助手连上了没有（跟 app.js 的 browserOn 一样），桌面控制两项授权开了没有。
// 1081（Claude，Ken 10/27）：插件装好了、只是 Chrome 没开，也算接好了（AI 要用时 ChatHand 自己打开 Chrome）；ChatHand 打开过 Chrome 插件还是没连上，才不算。
const browserLinked=s=>{const x=s?.automation?.browser||{},e=x.extension||{};return e.connection_state==='connected'||e.connected===true||x.personal?.connected===true||(e.installed===true||!!e.last_seen)&&e.wake?.connected!==false;};
const desktopGranted=s=>{const p=s?.automation?.computer?.permissions||{};return !!(p.accessibility&&p.screen_recording);};
// 1068 第 100 条：Site 的测试记录也写进 setup_test（route:'site'），这里只认不是 Site 的那一份。
const openaiTested=s=>s?.setup_test?.verified===true&&s.setup_test.route!=='site';
// 1068 第 99 条：ChatGPT 正在帮你配（后端给 setup_activity；15 分钟没动静就不算）。
const aiConfiguring=s=>{const a=s?.setup_activity;return a?.active===true&&Number.isSafeInteger(a.last_at)&&Date.now()-a.last_at<15*60*1000;};
// Completion ends activity in the backend; a later attempt is immediately live.
const finishedAt=s=>{const f=s?.setup_activity?.finished_at;return Number.isSafeInteger(f)&&f>0?f:0;};
const finishedRecently=s=>{const f=finishedAt(s),now=Date.now();return f>0&&f<=now+5000&&now-f<10*60*1000;};
const aiBusy=s=>aiConfiguring(s);
const PLUGINS_URL='https://chatgpt.com/settings/plugins-settings';
const pluginDetailURL=u=>{try{const x=new URL(u);return x.origin==='https://chatgpt.com'&&!x.username&&!x.password&&!x.search&&!x.hash&&/^\/settings\/plugins-settings\/[-A-Za-z0-9_]{1,200}$/.test(x.pathname)?x.href:null;}catch{return null;}};
// 1068 第 101 条（Claude）：认出了这台的应用就开它自己那一页；应用被删了（chatgpt_app_missing）就开插件列表。
function pluginSettingsURL(s){const st=s?.settings||{};if(st.chatgpt_app_missing)return PLUGINS_URL;
 return pluginDetailURL(st.chatgpt_app_identity?.detail_url)||pluginDetailURL(st.chatgpt_app_detail_url)||pluginDetailURL(s?.tools_refresh?.detail_url)||PLUGINS_URL;}
let assistHandoff=null; // 1070 十四：最近一次「让 ChatGPT 帮我…」拿到的那句话（哪条路线、要做什么）
// 帮我配时 ChatGPT 实际在走哪条路，照它做出来的东西判断，不看 selected：新装默认 selected 是 openai，Site 配上才切过去，
// 配置助手没选过时走哪条也可能跟窗口不一样（1083 起两边都默认 OpenAI 通道）。Site 配上了、或者正在等配对 → Site；有通道 → OpenAI 通道；
// AI 跑过 site-start（setup_site_select_on_pair）→ Site；都还没有 → null，保持原来的。
function assistedRoute(s){
 const b=s?.site_b||{},p=b.pairing||{},chosen=['site','openai'].includes(s?.setup_route)?s.setup_route:null;
 // Current verified success survives activity left behind by another route.
 // An explicit new setup still follows its chosen route and freshness gate.
 if(!freshFrom&&(!chosen||chosen===b.selected)&&rawVerified(s,b.selected))return b.selected;
 // 1070 四（Claude）：后台只在真往前走时记 setup_activity，带上是哪条路线：ChatGPT 刚在哪条路上做了事，就画哪条。
 // 这一次点「帮我配」以前的那些不算。Mac mini 10/22：Site 撞了绑定、改走 OpenAI 通道，通道都测过了，窗口还停在 Build Site。
 const a=s?.setup_activity,live=aiConfiguring(s)&&(!freshFrom||a.last_at>=freshFrom)?a.route:null;
 if(live==='site'||live==='openai')return live;
 // 1069（Claude）：一条已经配好、正在配第二条时，照这次选的那条画（帮我配会把这次的路线记进 setup_route）。
 if(chosen&&b.routes?.[chosen==='site'?'openai':'site']?.configured===true)return chosen;
 if(b.routes?.site?.configured===true||b.enrollment_watch?.watching===true||p.phase==='pairing'||p.phase==='awaiting_pairing')return 'site';
 if(openaiTunnel(s)||s?.credentials?.tunnel===true)return 'openai';
 if(s?.settings?.setup_site_select_on_pair===true)return 'site';
 if(['site','openai'].includes(s?.setup_route))return s.setup_route;
 return null;
}
function receiptProof(s){
 // B host-flow source now contains a protected receipt producer and app-only
 // consumer. F15 still requires the current local reader's verified receipt;
 // untested Site/widget delivery, UI booleans, health and A setup cannot pass.
 const b=s?.site_b,r=s?.h10?.connection_check,at=Date.now();
 // A formerly trusted snapshot must not keep F15 after its local receipt expires.
 // The server still owns installation, owner/binding, selection and session checks.
 return Number.isSafeInteger(r?.issued_at)&&r.issued_at<=at&&
  Number.isSafeInteger(r?.expires_at)&&r.expires_at>at&&
  r.expires_at-r.issued_at>0&&r.expires_at-r.issued_at<=120000&&
  b?.host_attestation==='verified_current_installation'&&
  b?.selected==='site'&&b?.routes?.site?.health_fresh===true&&
  r?.source==='trusted_host'&&r?.verified===true&&
  r?.route==='site'&&r?.site_id===b.routes.site.site_id&&
  r?.generation===b.routes.site.generation&&
  r?.installation_bound===true&&r?.binding_verified===true&&r?.current_session===true;
}
// 1068 第 100 条（Claude）：ChatGPT 在当前这个 Site 上真调通过一次（connection_check + setup_write_probe），后端记下来、不过期。
// 认 site_id 不认 generation：同一个 Site 重新配对，ChatGPT 那边的应用不用重连。
function siteTestProof(s){
 const b=s?.site_b,t=s?.setup_test,r=b?.routes?.site;
 return t?.route==='site'&&t?.verified===true&&b?.selected==='site'&&isHealthy(b,'site')&&
  typeof t.site_id==='string'&&t.site_id.length>0&&t.site_id===r.site_id;
}
function completionProof(s){return receiptProof(s)||siteTestProof(s);}
// setup_test 只跟着当前选中的那条路，所以只有选中的那条能算「测通过」。
const rawVerified=(s,r)=>r==='site'?completionProof(s):r==='openai'&&openaiTested(s);
const routeVerified=s=>rawVerified(s,route);
// 1069 第 8 条（Claude）：从设置「重新配」，之前测通过的不能让这一次直接跳到完成页；要等这一次的测试（或回执）落地。
function beginFresh(s){freshFrom=Date.now();freshVerified={site:completionProof(s),openai:openaiTested(s)};}
function freshProof(s){
 if(!freshFrom||!freshVerified?.[route])return true;
 const t=s?.setup_test,r=s?.h10?.connection_check;
 return s?.setup_activity?.active===false&&s.setup_activity.route===route&&finishedAt(s)>=freshFrom||
  route==='site'&&t?.route==='site'&&Number.isSafeInteger(t?.verified_at)&&t.verified_at>=freshFrom||
  route==='site'&&Number.isSafeInteger(r?.issued_at)&&r.issued_at>=freshFrom;
}
// 1052 C4（Claude）：F11 那一页的状态，只看本次进这一页以后的事。
// 后端字段（Codex 照这些给）：site_b.pairing.phase 'pairing'|'failed'|…，pairing.origin，pairing.error_code，pairing.updated_at。
function receiveView(s){
 if(screen!=='f11'&&screen!=='f10')return {receiveStatus:null,receiveStatusCopy:null}; // 1081：建 Site 那页（F10）也显示收到配对代码以后的进展
 const p=s?.site_b?.pairing||{},fresh=Number.isSafeInteger(p.updated_at)&&p.updated_at>=receiveEnteredAt;
 if(receiveLocal?.status==='error')return {receiveStatus:'error',receiveStatusCopy:receiveLocal.copy};
 if(p.phase==='pairing'&&(fresh||receiveLocal?.status==='received'))
  return {receiveStatus:'received',receiveStatusCopy:uiText("ui.h10.host.pairingInProgress", {origin: safeOrigin(p.origin)||safeOrigin(receiveLocal?.origin)||'Site'})};
 if(p.phase==='failed'&&fresh&&!userStoppedPairing(p))return {receiveStatus:'error',receiveStatusCopy:sitePairingErrorCopy(p.error_code)};
 if(receiveLocal?.status==='received')return {receiveStatus:'received',receiveStatusCopy:receiveLocal.copy};
 if(watch.state==='expired')return {receiveStatus:'expired',receiveStatusCopy:null};
 return {receiveStatus:'waiting',receiveStatusCopy:null};
}
function safeOrigin(o){
 try{const u=new URL(o);return u.protocol==='https:'&&u.origin===o&&u.hostname.endsWith('.chatgpt.site')?u.origin:'';}catch{return '';}
}
// 1052 C3-7（Claude）：按 Site 那一行的状态给一句话和按钮。过期去 F11 重新收；模板不对复制更新话。
// 1069 A4/A5（Claude）：这个 Site 被别的电脑改连走了，给「新建一个 Site」「改用 OpenAI 通道」；
// Mac 到 Site 被网络验证（Cloudflare）拦住，给「改用 OpenAI 通道」。
// 后台没有设备名时填的是「另一台电脑」（app/v1/b-site-store.mjs），当没名字处理：中文不套引号，英文界面也不冒中文。
const deviceLabel=v=>{const s=typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,60):'';return s==='\u53e6\u4e00\u53f0\u7535\u8111'?'':s;};
// 被别的电脑改连走了，后台也把 Site 记成 auth_required，可重新收凭据没用：走 F12 的问题卡，不去 F11。
const bindingReplaced=b=>!!b?.binding_replaced&&typeof b.binding_replaced==='object';
function siteIssue(b){
 const replaced=b?.binding_replaced;
 if(replaced&&typeof replaced==='object'){const device=deviceLabel(replaced.device_name);
  return {copy:device?uiText("ui.h10.host.bindingReplaced",{device}):uiText("ui.h10.host.bindingReplacedUnnamed"),
   action:'new-site',label:uiText("ui.h10.host.newSite"),action2:'use-openai',label2:uiText("ui.h10.host.useOpenAI")};}
 if(stages(b).network_challenge)return {copy:uiText("ui.h10.host.networkChallenge"),action:'use-openai',label:uiText("ui.h10.host.useOpenAI")};
 const r=b?.routes?.site||{},copy=siteRouteCopy(r);
 if(!copy)return null;
 if(r.state==='auth_required')return {copy,action:'renew',label:uiText("ui.h10.host.renewCredentials")};
 return {copy,action:'copy-site-update',label:uiText("ui.h10.host.copySiteUpdate")};
}
function routeKey(s){const r=s?.site_b?.routes?.site||{};return [r.site_id||'',r.generation||0,r.state||''].join(':');}
// 只在 F11（含凭据过期那一页）开着时请 server 开始等，离开就停。开始等的入口在 UI_ONLY 里。
const watchAtOk=(at,now=Date.now())=>Number.isSafeInteger(at)&&at>now&&at-now<=WATCH_MAX_MS+5000;
async function startWatch(){
 if(watch.state==='starting'||watch.state==='watching')return;
 watch={state:'starting',expiresAt:0,id:''};
 let r;try{r=await api('/api/site-b/enrollment/watch',{});}catch{r=null;}
 if(screen!=='f11'||!opened){if(r?.watching===true)void stopWatch(true);watch=IDLE_WATCH;return;}
 if(r?.watching===true&&watchAtOk(r.expires_at)){watch={state:'watching',expiresAt:r.expires_at,id:typeof r.watch_id==='string'?r.watch_id:''};armWatch();}
 else watch={state:'unavailable',expiresAt:0,id:''}; // 后端还没有自己收：照旧 ⌘V
 render();
}
// 后台的等待现在怎么样：续上了（到点时间往后挪）就跟着续；这一次的等待被后台停了（到点、换了路线、配对停下），不再说「正在等」。
// 停下是因为配上了的不算，那时页面照配对的进展走。
function followWatch(){
 if(watch.state!=='watching')return;
 const w=current()?.site_b?.enrollment_watch;
 if(w?.watching===true&&watchAtOk(w.expires_at)&&w.expires_at>watch.expiresAt){watch={...watch,expiresAt:w.expires_at,id:typeof w.watch_id==='string'?w.watch_id:watch.id};armWatch();}
 else if(w?.watching===false&&watch.id&&w.stopped_id===watch.id&&w.stopped_reason!=='paired'){clearTimeout(watchTimer);watchTimer=null;watch={state:'expired',expiresAt:0,id:''};}
}
// 到点先看后台续没续，续了接着等；没续才停，显示「等完了」（可以再等一次，或者 ⌘V）。
function armWatch(){
 clearTimeout(watchTimer);
 watchTimer=setTimeout(()=>{watchTimer=null;if(watch.state!=='watching')return;
  const at=watch.expiresAt;followWatch();if(watch.state!=='watching'){render();return;}if(watch.expiresAt>at)return;
  void stopWatch(true).finally(()=>{if(opened&&screen==='f11'){watch={state:'expired',expiresAt:0,id:''};render();}});
 },Math.max(1,watch.expiresAt-Date.now()));
}
async function stopWatch(force=false){
 clearTimeout(watchTimer);watchTimer=null;
 const was=watch.state;watch=IDLE_WATCH;
 if(force||was==='watching'||was==='starting'){try{await api('/api/site-b/enrollment/watch/stop',{});}catch{}}
}
function syncWatch(){
 if(opened&&screen==='f11'){if(watch.state==='idle')void startWatch();else followWatch();}
 else if(watch.state!=='idle')void stopWatch();
}
function enterReceive(purpose='pair'){
 receivePurpose=purpose==='renew'?'renew':'pair';receiveEnteredAt=Date.now();
 receiveBaseline=routeKey(current());receiveLocal=null;
 if(watch.state==='expired'||watch.state==='unavailable')watch=IDLE_WATCH;
}
const stages=b=>b?.connection_stages&&typeof b.connection_stages==='object'?b.connection_stages:{};
const stageCode=x=>typeof x?.reason_code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(x.reason_code)?x.reason_code:'UNKNOWN';
// 正在做的那一步下面那行小字：ChatGPT 在做什么。
function activeStepCopy(i){
 if(route==='openai')return [null,null,uiText("ui.h10.host.tunnelCreating"),uiText("ui.h10.host.keyHandoffWaiting"),uiText("ui.h10.host.assistedConnectionStep")][i]||'';
 return [null,null,uiText("ui.h10.host.siteCreating"),uiText("ui.h10.host.sitePairing"),uiText("ui.h10.host.assistedConnectionStep")][i]||'';
}
function siteCheckCopy(){
 if(!siteCheck||screen!=='f12'||route!=='site')return null;
 return {checking:uiText("ui.h10.host.siteChecking"),healthy:uiText("ui.h10.host.deviceHealthyHostPending"),unhealthy:uiText("ui.h10.host.siteRecheckUnhealthy"),failed:uiText("ui.h10.host.siteRecheckFailed",{code:siteCheck.code||'OPERATION_UNAVAILABLE'})}[siteCheck.state]||null;
}
// 帮我配时配对停下了：ChatGPT 会在对话里说下一步（撞了绑定就问你改连这台、新建 Site 还是改用 OpenAI 通道），这里只指回去。
// 1082（Claude，1081 验收截图 28）：自己放弃、取消、删掉连接这几种停下不是出错（重新开始配也会把上一次放弃掉），
// 当作还没开始配对：不标橙，也不写「Site 已建好」。
const userStoppedPairing=p=>['B_PAIRING_ABANDONED','B_PAIRING_CANCELLED','B_CONNECTION_REMOVED'].includes(p?.error_code);
const pairingStopped=p=>p?.phase==='failed'&&!userStoppedPairing(p)&&(!freshFrom||!Number.isSafeInteger(p.updated_at)||p.updated_at>=freshFrom);
function pairingStopCopy(code){
 if(code==='B_BINDING_CONFLICT')return uiText("ui.h10.host.pairingConflictAssisted");
 const ok=typeof code==='string'&&/^[A-Z0-9_]{1,80}$/.test(code);
 return uiText("ui.h10.host.pairingStoppedAssisted",{codeSuffix:ok?(window.ChatHandText?.locale==='en'?' ('+code+')':'（'+code+'）'):''});
}
function model(proof=routeVerified(current())){
 const s=current()||{},b=s.site_b||{},p=b.pairing||{};
 const paired=b.routes?.site?.configured===true,health=isHealthy(b,'site');
 const stopped=route==='site'&&!paired&&pairingStopped(p); // 1070 四：帮我配时配对停下了
 // 1069（Claude）：Site 被别的电脑改连走、被网络验证拦住：顶上那句和第 4 步照这个说，不写「连上了」；帮我配的进度页也放那张问题卡。
 const block=bindingReplaced(b)||stages(b).network_challenge?siteIssue(b):null;
 const status=route==='openai'?(openaiTested(s)?uiText("ui.h10.host.openaiTested"):openaiLinked(s)?uiText("ui.setup.localTunnelConnected"):uiText("ui.h10.views.active"))
  :paired?(health&&!block?uiText("ui.h10.host.siteConnected"):uiText("ui.h10.host.siteVerificationRequired"))
  :p.phase==='pairing'?uiText("ui.h10.host.sitePairing"):p.phase==='awaiting_pairing'?uiText("ui.h10.host.pairingVerificationPending"):uiText("ui.h10.host.siteNotCreated");
 const steps=STEP_TITLES.map(()=>({state:'pending'}));
 // 1066 第 77 条（Claude）：前两步原来一直是空圈。这一页是装好的 ChatHand 自己画的，能看到就说明安装包核过、装上了。
 steps[0]={state:'done'};steps[1]={state:'done'};
 if(route==='openai'){
  // OpenAI 通道：建通道 → AI 把运行密钥交给 ChatHand（不用人粘）→ 在 ChatGPT 里连上、试一次。
  if(openaiTunnel(s))steps[2]={state:'done',detail:uiText("ui.setup.tunnelRecorded")};
  if(s.credentials?.tunnel===true)steps[3]={state:'done',detail:uiText("ui.h10.host.keyReceived")};
  else if(openaiTunnel(s))steps[3]={state:'pending',detail:uiText("ui.h10.host.keyHandoffWaiting")};
  if(proof)steps[4]={state:'done',detail:uiText("ui.setup.readWriteProbeReceived")};
  else steps[4]={state:'pending',detail:openaiLinked(s)?uiText("ui.h10.host.openaiLinkedAwaitTest"):uiText("ui.h10.host.assistedConnectionStep")};
 }else{
 // A persisted authenticated Site binding proves that a Site exists; it does
 // not prove template provenance, a successful Work handoff, or installation.
 if(paired)steps[2]={state:'done',detail:uiText("ui.h10.host.siteCreated")};
 // 1070 四（Claude）：配对停下了（撞了绑定这类，后台存盘，重启还在）：Site 已经建好，卡在交给这台 Mac 这一步，标橙说清楚，
 // 不再把 Build Site 一直亮着说「ChatGPT 在建」。这一次重新开始以前停下的那次不算（重新配 Site 时后台也会清掉）。
 else if(stopped){steps[2]={state:'done',detail:uiText("ui.h10.host.siteCreated")};steps[3]={state:'attention',detail:pairingStopCopy(p.error_code)};}
 else if(p.phase==='pairing'||p.phase==='awaiting_pairing'){steps[2]={state:'done',detail:uiText("ui.h10.host.siteCreated")};steps[3]={state:'active',detail:p.phase==='pairing'?uiText("ui.h10.host.sitePairing"):uiText("ui.h10.host.pairingVerificationPending")};}
 if(paired&&health&&!block)steps[3]={state:'done',detail:uiText("ui.h10.host.macConnected")};
 // 配上了但 Site 那一行不健康（凭据过期、模板不对、连不上……）：这一步标橙，说明用 Site 那一行的原因。
 else if(paired)steps[3]={state:'attention',detail:block?.copy||siteRouteCopy(b.routes?.site||{})||uiText("ui.h10.host.siteVerificationRequired")};
 if(proof)steps[4]={state:'done',detail:uiText("ui.h10.host.chatGPTConnected")};
 else steps[4]={state:screen==='f12'?'attention':'pending',detail:setupMode==='assisted'?uiText("ui.h10.host.assistedConnectionStep"):uiText("ui.h10.host.connectionStepInstruction")};
 // 1066 第 81 条：server 给的分段状态（site_b.connection_stages）。Site 健康检查是好的，工具清单却被 Site 退回（1065 的 MANIFEST_TOO_LARGE），
 // ChatGPT 那边就是用不了；这时第 4 步不能还是绿的。只拿它标卡住，不拿它替哪一步打勾。
 if(paired&&stages(b).manifest?.state==='rejected')steps[3]={state:'attention',detail:uiText("ui.h10.host.manifestRejected",{code:stageCode(stages(b).manifest)})};
 }
 // 两条路都一样：ChatGPT 里的应用被删了，或者换成了一个新应用，第 5 步说清楚。
 const chatApp=stages(b).chatgpt_app||{};
 if(steps[4].state!=='done'&&chatApp.state==='missing')steps[4]={state:'attention',detail:uiText("ui.h10.host.appMissing")};
 else if(steps[4].state!=='done'&&chatApp.state==='retest_required')steps[4]={...steps[4],detail:uiText("ui.h10.host.appRetest")};
 // 帮我配：第一个还没做完、也没卡住的那一步就是 ChatGPT 正在做的，点亮它。只亮，不替它打勾。
 // 第 81 条剩下的：OpenAI 通道那边还没有分段状态（只有 Site 有），卡片显示不出（第 89 条）也还没有字段，等 Codex 给了再接。
 // 1081（Claude，ChatGPT 复查）：Site 帮我配，点完以后、在 ChatGPT 里发出去以前，后台还没有一点动静（拿那句话的 /api/setup/skill 不算动静）。
 // 这时不说「ChatGPT 正在帮你配」「ChatGPT 在建」，说先在 ChatGPT 里发出去。后台记下这一次的第一下动静（或者这一次已经配完）就不算在等了。
 // 1083（Claude）：后台把 ChatGPT 这次跑的第一条配置命令（setup doctor 也算）记在 seen_at。它只说明 ChatGPT 开始了，不算配置往前走。
 const setupAct=s.setup_activity||{},since=t=>Number.isSafeInteger(t)&&t>=freshFrom;
 const sent=since(setupAct.last_at)||finishedAt(s)>=freshFrom||since(setupAct.seen_at);
 // 1083（Claude）：默认改成 OpenAI 通道以后，点完「帮我配」多数人走的是通道。通道要等建好、交了密钥才有第一下进展，前面几分钟只能看 seen_at。
 // 后台给了 seen_at 这个字段，通道这条路也跟 Site 一样先说「发送后开始」；没给就照旧，不会一直停在「等待开始」。
 const waitTracked=route==='site'||'seen_at' in setupAct;
 const waitingStart=screen==='f7'&&waitTracked&&setupMode==='assisted'&&launched&&freshFrom>0&&!sent&&steps[2].state==='pending'&&!steps.some(x=>x.state==='attention');
 // 1081（Claude）：打不开 ChatGPT 桌面版、退到了网页版（assistedWeb）。还没有动静以前，标题和顶上那句说到桌面版里发出去。两条路都这样。
 const webOnly=screen==='f7'&&setupMode==='assisted'&&launched&&assistedWeb&&freshFrom>0&&!sent&&!steps.some(x=>x.state==='attention');
 const handoffFailed=screen==='f7'&&setupMode==='assisted'&&assistHandoff?.openFailed===true&&assistHandoff.route===route&&!sent;
 if(screen==='f7'){
  const i=steps.findIndex(x=>x.state!=='done');
  if(i>=0&&steps[i].state==='pending')steps[i]={...steps[i],state:handoffFailed?'attention':'active',detail:handoffFailed?uiText("ui.h10.views.assistedOpenFailedTitle"):waitingStart?uiText("ui.h10.views.assistedWaitingStep"):steps[i].detail||activeStepCopy(i)};
 }
 const stuck=steps.some(x=>x.state==='attention'),allDone=steps.every(x=>x.state==='done');
 const statusTone=screen!=='f7'?'':handoffFailed||stuck?'attention':allDone?'done':'active';
 // F7 顶上那枚状态：没做完就只说「进行中」，有一步标橙就说「卡住了」；具体是哪一步、为什么，看下面那一行的小字（原型 F7）。
 const statusLabel=statusTone==='active'?(waitingStart?uiText("ui.h10.views.assistedWaitingStatus"):uiText("ui.h10.views.active")):statusTone==='attention'?uiText("ui.h10.host.stuckLabel"):status;
 const installedScope=['computer','folder'].includes(s.permissions?.file_scope)?s.permissions.file_scope:s.permissions?.tier==='light'?'folder':'computer';
 const otherRoute=b.selected==='site'?'openai':'site';
 const manualSwitchTo=isHealthy(b,otherRoute)?otherRoute:null;
 const site=siteHandoff();
 // Only the trusted release descriptor permits a Site prompt. A real template
 // failure cannot silently turn into an unapproved local-file handoff.
 const sitePromptReady=site.configured===true; // 拉不到模板时换成文件那一页（templateFileMode），不再挡住
 const templateStatusCopy=null;
 const vm={provenance:'host',screen,setupMode,connectionActor:actor,connectionRoute:route,
  guideStep,guideMedia,steps,contextLabel:'',
  statusLabel,statusTone,
  assistedTop:screen==='f12'&&(setupMode==='assisted'||aiConfiguring(s)&&!manualPicked),
  canRecheckSite:route==='site'&&(p.configured===true||b.routes?.site?.configured===true),
  siteCheckState:siteCheck?.state||null,siteCheckCopy:siteCheckCopy(),
  openaiTestAvailable:route==='openai'&&openaiLinked(s)&&!openaiTested(s),
  templateFallbackReason:site.fallbackReason||null,
  templateConfigured:site.configured===true,sitePromptEnabled:sitePromptReady,templateSourceKind:site.sourceKind,
  templatePreparing:sitePriming&&site.configured!==true,
  // 1083（Claude）：建 Site 前查网络的结果，只在选了 Site、Site 还没连好的 F6／F10 给：checking／clear／challenged／unreachable。
  // 被拦以后点「重新检查」，查的时候照旧给被拦的结果，另外 siteNetworkRechecking 是 true（按钮换成「正在检查…」）。
  siteNetwork:['f6','f10'].includes(screen)&&siteNetNeeded()?(siteNet.state==='checking'?(siteNet.prev||'checking'):siteNet.state==='idle'?'checking':siteNet.state):null,
  siteNetworkRechecking:siteNet.state==='checking'&&!!siteNet.prev,
  siteRetryAvailable:b.pairing?.template_ready!==false,siteRetrying,
  siteRetryFailed:!!siteRetryFailure&&site.configured!==true,siteRetryErrorCode:siteRetryFailure?.code||null,
  workPrompt:sitePromptReady?site.prompt:null,templateStatusCopy,
  templateFileStatusCopy:site.fallbackReason?uiText("ui.h10.host.templateFileUnapproved"):null,
  templateFileActionLabel:uiText("ui.h10.host.provideTemplateFile"),templateFileActionEnabled:false,
  waitingForCredential:p.phase==='awaiting_pairing',
  prefill,prefillFallbackCopy:prefill==='confirmed'||!launched?null:uiText("ui.h10.host.prefillWarning"),
  receiveMode:watch.state==='watching'?'automatic-capable':'manual',
  siteWatching:s?.site_b?.enrollment_watch?.watching===true,appName:appName(),
  receiveInstructionCopy:uiText("ui.h10.host.pasteCredentialInstruction"),
  receivePurpose,...receiveView(s),
  templateFileMode:templateFileMode||!!site.fallbackReason,
  assistedCopiesSentence:route==='site'&&!!siteAssistedSentence(bridge()?.siteTemplateDescriptor?.()||{}),
  // 1070 四（Claude）：配对停下了，顶上那句不再说「按提示点允许」，改成照 ChatGPT 说的做（它会问你、或者自己接着换做法）。
  // 1081（Claude，Ken 10/26）：别的步骤卡住了（Site 连不上、要更新、ChatGPT 里的插件不见了），顶上也不再说「按提示点允许」，指到下面那行小字。
  assistedIntro:screen!=='f7'||handoffFailed?null:stopped?uiText("ui.h10.host.pairingStoppedIntro"):stuck?uiText("ui.h10.host.stuckIntro"):null,
  // 1081（Claude）：还没在 ChatGPT 里发出去（waitingStart）：标题、顶上那句照这个说。发出去以后（assistedStarted）不再说「粘贴、发送」。
  // 退到了网页版（assistedWeb）：先说到桌面版里发出去，这句排最前面。
  assistedWaiting:waitingStart,
  assistedOpenFailed:handoffFailed,
  assistedWeb:webOnly,
  assistedWebAlt:webOnly?uiText("ui.h10.views.assistedWebNoApp"):null,
  assistedWaitingIntro:handoffFailed?assistHandoff.openWarning:webOnly?uiText("ui.h10.views.assistedWebIntro"):waitingStart?(prefill==='confirmed'?uiText("ui.h10.views.assistedWaitingPrefilled"):assistedCopied?null:uiText("ui.h10.views.assistedWaitingCopyFirst")):null,
  assistedStarted:screen==='f7'&&waitTracked&&launched&&!waitingStart&&!handoffFailed,
  assistedSentenceCopied:assistedCopied,siteIssue:route==='site'?siteIssue(b):null,siteBlocked:route==='site'&&!!block,
  connectAssetKey:route==='site'?'siteConnect':'openaiConnect',
  // 0012：欢迎页两张卡的标题后面标出现在走哪种；默认的那条没换过就不标（1083 起默认是 OpenAI 通道）。1069：配过一次以后再进来总是标上。
  routeTag:routeChosen||route!=='openai'||!firstRun?routeName(route):'',
  brandSubtitle:firstRun?'':uiText("ui.h10.views.connectionSetup"),
  permissionAssetKey:route==='site'?'sitePermissions':'openaiPermissions',
  desktopApp:null,
  scope:installedScope,completionView:proof?'current-installation-verified':null,
  doneMarkElapsed:screen==='f15'&&doneShownAt?Date.now()-doneShownAt:null,
  manualSwitchTo,manualSwitchLabel:manualSwitchTo?uiText("ui.h10.host.switchRoute", {route: manualSwitchTo==='site'?' ChatGPT Site':uiText("ui.h10.host.openaiRouteSpaced")}):null,
  // 1068（Claude）：完成页那两行是开关，开没开照实际状态。1069：开关本身也要开着（设置里关掉的算关）。
  browserReady:browserLinked(s)&&s.settings?.browser_enabled!==false,
  desktopReady:desktopGranted(s)&&s.settings?.desktop_enabled!==false&&s.capabilities?.desktop_control!==false,
  browserEnabled:s.permissions?.capabilities?.browser?.enabled??(s.settings?.browser_enabled!==false),
  desktopEnabled:s.permissions?.capabilities?.desktop?.enabled??(s.settings?.desktop_enabled!==false),
  adminReady:s.permissions?.high_risk?.find(item=>item.id==='admin')?.usable_now===true,
  adminEnabled:s.permissions?.high_risk?.find(item=>item.id==='admin')?.enabled===true,
  adminCapabilityDisabled:busy,
  canVerifyPairing:screen==='f11'&&p.phase==='awaiting_pairing',
  browserCapabilityCopy:browserLinked(s)?uiText("ui.h10.host.browserExtensionReady"):uiText("ui.h10.host.browserExtensionRequired"),
  desktopCapabilityCopy:desktopGranted(s)?uiText("ui.h10.host.desktopPermissionsReady"):uiText("ui.h10.host.desktopPermissionsRequired"),
  installLocation:descriptor(),
  // 1081 N203（Claude）：没有发布桥了，F1/F5 上「下载」「验证」「GitHub」三个链接照旧灰着；安装只认本地 DMG。
  sourceURLConfigured:false,downloadConfigured:false,verificationConfigured:false,
  chatgptDownloadConfigured:false,launchState,
  noticeCopy:noticeText||(['f1','f5'].includes(screen)?uiText("ui.h10.host.downloadUnconfigured"):''),
  terminalCommand:screen==='f5'?f5Command:null};
 return vm;
}
function render(){
 if(!opened)return;
 if(pressing){renderPending=true;return;} // 0010：按下到松开之间不重画，见下面 pressing 那段
 clearProofExpiryTimer();
 const s=current(),b=s?.site_b||{},p=b.pairing||{};
 if(screen==='f15'&&['site','openai'].includes(b.selected))route=b.selected;
 // Current Site route and unexpired protected local proof are both required.
 // An old asynchronous result or route choice cannot keep F15 alive.
 // 1066 第 77 条（Claude）：帮我配的进度页跟着 ChatGPT 实际走的那条路画步骤；人在「换一种连接方式」里自己选过的就不动。
 if(screen==='f7'&&setupMode==='assisted'&&!routeChosen){const r=assistedRoute(s);if(r)route=r;}
 // 1068（Claude）：OpenAI 通道测过也到完成页。1069 第 8 条：重新配的这一次还没测过，之前测通过的不算。
 let verified=rawVerified(s,route);if(verified&&!freshProof(s))verified=false;
 if(screen==='f15'&&!verified)screen='f12';
 else if((screen==='f12'||screen==='f7')&&verified)screen='f15'; // 1066 第 77 条（Claude）：帮我配做完了（这台的读写回执到了）也直接到完成页
 if(screen==='f15'){freshFrom=0;freshVerified=null;if(!doneShownAt)doneShownAt=Date.now();}else doneShownAt=0; // 大对勾只在刚到完成页时动一下
 // 1052 C4（Claude）：server 收到就自己配对；这里照 snapshot 走。配上（或换好凭据）而且健康了，进「在 ChatGPT 里连上」。
 if((screen==='f11'||screen==='f10')&&route==='site'&&isHealthy(b,'site')&&routeKey(s)!==receiveBaseline){screen='f12';noticeText=receivePurpose==='renew'?uiText("ui.h10.host.credentialsRenewed"):'';receiveLocal=null;}
 // 1081（Claude，Ken 10/27）：帮我配的时候不停在自己配的「在 ChatGPT 里连上」那页（原来那页几乎是空的），照旧看帮我配的进度（F7）。
 if(screen==='f12'&&(setupMode==='assisted'||aiConfiguring(s)&&!manualPicked))screen='f7';
 syncWatch();
 // The UI may stay open without a state push; expire the success view locally.
 // This is display-only and never renews or writes a proof.
 // 1068：只有靠两分钟回执进的完成页才要到点退回；Site 测试记录和 OpenAI 通道的测试不过期。
 if(screen==='f15'&&route==='site'&&!siteTestProof(s)&&Number.isSafeInteger(s?.h10?.connection_check?.expires_at)){
  const remaining=s.h10.connection_check.expires_at-Date.now()+1;
  proofExpiryTimer=setTimeout(()=>{proofExpiryTimer=null;render();},Math.max(1,remaining));
 }
 // 1068 第 101 条（Claude）：到了完成页（权限在这一页），替你把「配完了」记一次；ChatGPT 的 test-status 也会记，记过就不再记。
 if(screen==='f15'&&!completeRequested&&s?.settings?.setup_complete!==true){completeRequested=true;void api('/api/setup/test/complete',{}).then(()=>bridge()?.refresh?.()).catch(()=>{});}
 if(screen!=='f12')siteCheck=null;
 // 1083（Claude）：选的是 Site、Site 还没连好时，到了「选怎么配」（F6）或「建 Site」（F10）就先查网络。
 // 换了页或者换了连接方式才重新看；60 秒内查过的照旧用那次的，正在查的不重复查。
 const netCtx=['f6','f10'].includes(screen)&&siteNetNeeded()?screen+':'+route:'';
 if(netCtx!==siteNetCtx){siteNetCtx=netCtx;if(netCtx&&!siteNetFresh()&&siteNet.state!=='checking')void startSiteNetCheck();}
 const vm=model(verified),markup=screen==='f15'?renderH10(vm,{assets:productionAssets,review:false}):null;
 // 相同的完成页保留现有节点，状态流刷新时不打断悬停提示或键盘焦点。
 if(!dispose||markup===null||markup!==completionMarkup){
  dispose?.();dispose=mountH10(stage,vm,{assets:productionAssets,review:false,onAction:({action,value})=>void act(action,value)});completionMarkup=markup;
 }
 // 1082：建站页和接收页会把同一句话画在按钮下面（.h10-host-message），顶上的提示条再显示一遍就重复了。页面里已经画了，顶上就不显示。
 notice.textContent=noticeText;notice.hidden=!noticeText||!!stage.querySelector?.('.h10-host-message');
 actions.replaceChildren();
 if(['f1','f5'].includes(screen)){
  const picker=document.createElement('button');picker.type='button';picker.dataset.extra='select-dmg';
  picker.textContent=uiText("ui.h10.host.selectDmg");actions.append(picker);
 }
 // 1068 第 101 条（Claude）：F12 的「重新检查 Site 连接」「换一种连接」挪进页面里那行灰色小链接；
 // F11 的「重新验证本次配对」「换一种连接方式」也挪进页面（Ken 10/20）；F10 页面里本来就有「没有 Work？换一种连接方式」，底下那个重复的去掉。
}
function setScreen(value,purpose){if(value==='f11')enterReceive(purpose);else if(value==='f10')enterReceive('pair');screen=value;noticeText='';render();if(value==='f10')void primeSiteTemplate();}
async function refresh(){
 try{await bridge()?.refresh?.();}catch{}
 render();
}
async function api(route,body){
 const b=bridge();if(!b?.api)throw Object.assign(new Error('UI_UNAVAILABLE'),{code:'UI_UNAVAILABLE'});
 return b.api(route,body);
}
// 1066 第 77 条（Claude）：OpenAI 通道的帮我配，接的是原来设置助手那两步（装配置助手、打开 ChatGPT 填好那句话），页面换成 F7。
// 复制、打开都交给 app.js；打开失败留在这里重试同一份提示词。
// 1070 十四（Claude）：连接页的「让 ChatGPT 帮我添加」「让 ChatGPT 修」也走这里：带上路线、要做什么（setup 配 / add 再加一条 / repair 修）和界面语言。
async function startAssisted(r='openai',intent='setup'){
 launched=true;
 // 1069（Claude）：带上 route，后端顺手把这次的路线记下来（配第二条时 ChatGPT 和进度页都照这条走）。
 const handoff=await api('/api/setup/skill',{route:r,intent,locale:window.ChatHandText?.locale==='en'?'en':'zh'});
 assistHandoff={...handoff,route:r,prompt:typeof handoff?.prompt==='string'?handoff.prompt:''};
 await launchAssistedHandoff();
 try{await bridge()?.refresh?.();}catch{}
}
async function launchAssistedHandoff(){
 let res=null;try{res=await window.openLocalSetupHandoff?.(assistHandoff,{quiet:true});}catch{}
 assistedCopied=res?.copied===true;assistedWeb=res?.opened==='web';prefill=res?.prefill_requested===true?'confirmed':'unconfirmed';
 assistHandoff={...assistHandoff,openFailed:res?.opened!==true,openWarning:res?.warning||uiText("ui.h10.host.assistedHandoffFailed"),openErrorCode:res?.error_code||null};
 noticeText='';
}
function startOpenAIAssisted(){return startAssisted('openai','setup');}
// 回到正在使用的桌面客户端；没有运行时打开客户端，不新建对话。
async function backToChatGPT(b){
 let r=null;
 try{r=await b.native?.('openSetupDesktop',{});}catch{return false;}
 return r?.opened===true;
}
// 1068 第 101 条（Claude）：打开插件设置，认出这台的应用就开它那一页；开不了退到插件列表，再不行才打开 ChatGPT。
async function openPluginSettings(b){
 const url=pluginSettingsURL(current());
 let r=null;try{r=await b.native?.('openExternal',{url});}catch{}
 if(r?.ok===true)return url===PLUGINS_URL?'list':'detail';
 if(url!==PLUGINS_URL){try{r=await b.native?.('openExternal',{url:PLUGINS_URL});}catch{r=null;}if(r?.ok===true)return 'list';}
 await b.openChatGPT?.('',{work:false});return 'chatgpt';
}
async function pair(){
 const s=await api('/api/site-b/pair',{});
 if(s?.paired===true&&s.health==='healthy'){noticeText=uiText("ui.h10.host.pairingHealthVerified");screen='f12';}
 else noticeText=uiText("ui.h10.host.pairingUnverified");
 await refresh();
}
async function act(action,value){
 if(busy)return;
 const b=bridge();if(!b){noticeText=uiText("ui.h10.host.hostNotReady");render();return;}
 try{
  switch(action){
   case'dismiss':close();return;
   case'choose-assisted':
    // 1083（Claude）：选的是 Site 时先等网络查完（60 秒内查过就用那次的）；被拦就留在这一页，显示被拦的样子。
    if(route==='site'&&siteCreatable()){busy=true;if(await siteNetworkBlocks())break;}
    setupMode='assisted';actor='ai';beginFresh(current()); // 1069：这一次配完才算完，之前测通过的不算
    // Site 还建不了时走 OpenAI 通道的帮配；已经在这里选过「帮我配」，帮配不再让人选一次。
    // 1066 第 77 条（Claude）：OpenAI 通道（或者 Site 还建不了）也留在这里：装配置助手、复制那句话、打开 ChatGPT 填好，然后到 F7。
    if(route==='openai'||!siteCreatable()){route='openai';routeChosen=true;busy=true;await startOpenAIAssisted();screen='f7';break;}
    // 1070 二（Claude）：Site 也走本机交接，跟 OpenAI 通道一样：/api/setup/skill {route:'site'} 拿那句话（顺手记下这次配的是 Site），
    // 复制，再请原生打开桌面 ChatGPT 的本机会话填好；打不开才开网页版。不会自动发送。
    // 原来打开的是网页版的 Work（云端），够不到这台 Mac，最后只能让人拖模板 ZIP（Mac mini 10/22）。
    busy=true;await startAssisted('site','setup');screen='f7';break;
   case'choose-manual':setupMode='manual';actor='user';manualPicked=true;
    if(route==='openai'||!siteCreatable()){close({showConnection:false});await window.startWizard?.();return;}
    // 1081（Claude，ChatGPT 复查）：从进度页改成自己配：Site 已经交给这台 Mac 了，到「在 ChatGPT 里连上」（要重新授权就先到更新那一页）；
    // 正在交给这台 Mac，到收配对数据那一页。都不是才从建 Site 开始。
    // 自己点了「改成我自己配」就记下（manualPicked）：那一页按自己配的样子显示，后台还记着 ChatGPT 在配也不再套「ChatGPT 正在帮你配」。
    if(screen==='f7'){const b=bState(),p=b.pairing||{},site=b.routes?.site;
     if(site?.configured===true){const renew=site.state==='auth_required'&&!bindingReplaced(b);setScreen(renew?'f11':'f12',renew?'renew':undefined);return;}
     if(['pairing','awaiting_pairing'].includes(p.phase)){setScreen('f11','pair');return;}}
    setScreen('f10');return;
   // 1069 A4/A5（Claude）：Site 被网络验证拦住、或者被别的电脑改连走了，「改用 OpenAI 通道」直接走 OpenAI 通道的帮我配：
   // 记下路线、装配置助手、打开桌面版的工作对话填好那句话，这里到进度页。
   case'use-openai':
    route='openai';routeChosen=true;setupMode='assisted';actor='ai';beginFresh(current());screen='f7';noticeText='';render();
    busy=true;await startOpenAIAssisted();break;
   // 1070 十四（Claude）：连接页的「让 ChatGPT 帮我添加」「让 ChatGPT 修」：到进度页，交接那句话照这条路线、这件事拿。
   case'assist':{
    const to=value?.route==='site'?'site':'openai',intent=['add','repair'].includes(value?.intent)?value.intent:'add';
    route=to;routeChosen=true;
    // 1083（Claude）：「让 ChatGPT 添加」Site 以前先查网络。还没查过（或者过了 60 秒）就先停在选怎么配那一页，按钮写「正在检查网络…」；
    // 被拦就留在那一页显示被拦的样子，不去进度页、也不拿交给 ChatGPT 的那句话。修已有的 Site 不查。
    if(to==='site'&&intent==='add'&&siteNetNeeded()&&!siteNetClear()){
     setupMode='manual';actor='user';screen='f6';noticeText='';busy=true;render();
     if(await siteNetworkBlocks())break;
    }
    setupMode='assisted';actor='ai';beginFresh(current());screen='f7';noticeText='';render();
    busy=true;await startAssisted(route,intent);break;
   }
   case'recheck-site-network':void recheckSiteNetwork();return;
   case'new-site':route='site';routeChosen=true;setupMode='manual';actor='user';setScreen('f6');return;
   case'change-route':openRouteDialog();return;
   // 1081（Claude，Ken 10/26）：「暂时建不了 ChatGPT Site」那一页的两个出口。改用 OpenAI 通道跟换连接弹框里选 OpenAI 通道走同一条路（自己配就去自己配的向导）。
   case'retry-site':void retrySiteTemplate();return;
   case'switch-openai':void switchRoute('openai');return;
   case'work-guide-step':guideStep=Number(value)===1?2:1;guideMedia=null;render();return;
   case'system-guide-step':guideMedia=['gatekeeperDone','gatekeeperOpen','gatekeeperConfirm'][Number(value)]||'gatekeeperDone';render();return;
   case'install-assisted':{
    const h=handoff();
    // 1081 N203（Claude）：还没选本地 DMG 时按钮本来就是灰的；万一点到了，只提示去选 DMG，不再去开私有 Site。
    if(!h.configured){noticeText=uiText("ui.h10.host.downloadUnconfigured");break;}
    busy=true;launched=true;const r=await b.openChatGPT?.(h.prompt,{work:true});
    prefill=r?.prefilled===true?'confirmed':'unconfirmed';
    noticeText=uiText("ui.h10.host.chatGPTPrefillRequested");break;
   }
   case'open-work':{
    const h=siteHandoff();
    if(h.configured!==true){noticeText=uiText("ui.h10.host.templateUnavailable");break;}
    busy=true;launched=true;const r=await b.openChatGPT?.(h.prompt,{work:true});
    prefill=r?.prefilled===true?'confirmed':'unconfirmed';
    noticeText=prefill==='confirmed'
     ?uiText("ui.h10.host.workPrefillConfirmed")
     :uiText("ui.h10.host.workPrefillFallback");break;
   }
   // 完成页的「打开 ChatGPT」（Ken 10/20）：等于原来的「复制」加「打开 ChatGPT」。先把试用的话复制好，再打开 ChatGPT 填进输入框，
   // 万一没填上，用户直接粘贴就行；发送还是用户自己按。打开没打开，openChatGPT 自己会提示一句，顶上不再重复。
   // 1069（Claude）：点了就是去 ChatGPT 用了，跟「完成」一样替你记一次「配完了」，再把这个窗口关掉。
   case'open-chatgpt':{
    busy=true;launched=true;const text=approvedSample(model().scope);
    await b.native?.('copyText',{text});await b.openChatGPT?.(text,{work:false});noticeText='';
    if(current()?.settings?.setup_complete!==true){try{await api('/api/setup/test/complete',{});}catch{}}
    close({showConnection:false});return;
   }
   case'reopen-chatgpt':{
    busy=true;launched=true;const r=await b.openChatGPT?.('',{work:false});
    prefill=r?.prefilled===true?'confirmed':'unconfirmed';
    noticeText=r?.opened?uiText("ui.h10.host.chatGPTOpened"):uiText("ui.h10.host.chatGPTOpenUnconfirmed");break;
   }
   case'open-plugin-settings':{
    busy=true;launched=true;const r=await openPluginSettings(b);
    noticeText=r==='detail'?uiText("ui.h10.host.pluginDetailOpened"):uiText("ui.h10.host.pluginSettingsInstructions");break;
   }
   case'back-to-chatgpt':{
    busy=true;const ok=await backToChatGPT(b);noticeText=ok?'':uiText("ui.h10.host.chatGPTOpenUnconfirmed");break;
   }
   case'retry-assisted':{
    busy=true;
    // Retry only the failed draft. Once setup has started, return to its existing conversation.
    if(model().assistedOpenFailed===true&&assistHandoff?.prompt)await launchAssistedHandoff();
    else {const ok=await backToChatGPT(b);noticeText=ok?'':uiText("ui.h10.host.chatGPTOpenUnconfirmed");}
    break;
   }
   case'recheck-site':{
    busy=true;siteCheck={state:'checking'};noticeText='';render();
    try{const result=await api('/api/site-b/verify',{});siteCheck={state:result?.health==='healthy'?'healthy':'unhealthy'};}
    catch(err){siteCheck={state:'failed',code:safeCode(err)};}
    try{await bridge()?.refresh?.();}catch{}
    break;
   }
   case'finish':{
    // 1068 第 101 条（Claude）：完成页（权限）看完，回首页。
    busy=true;if(current()?.settings?.setup_complete!==true){try{await api('/api/setup/test/complete',{});}catch{}}
    close({showConnection:false});return;
   }
   case'copy-work-prompt':{
    const sitePrompt=['f7','f10','f11'].includes(screen);
    const h=sitePrompt?siteHandoff():handoff();
    if(!h.configured){noticeText=sitePrompt?uiText("ui.h10.host.siteTemplateUnverified"):uiText("ui.h10.host.installSourceMissing");break;}
    const r=await b.native?.('copyText',{text:h.prompt});
    noticeText=sitePrompt
     ?r?.copied===true?uiText("ui.h10.host.sitePromptCopied"):uiText("ui.h10.host.copyRetry")
     :r?.copied===true?uiText("ui.h10.host.installationCopied"):uiText("ui.h10.host.copyFailed");break;
   }
   case'manual-switch':{
    const state=bState(),to=state.selected==='site'?'openai':'site';
    if(value!==to||!isHealthy(state,to))throw Object.assign(Error('B_ROUTE_NOT_HEALTHY'),{code:'B_ROUTE_NOT_HEALTHY'});
    // A switch intent leaves F15 immediately, even if the async reply/refresh is late.
    // route is the local setup view, NOT the server's authoritative selection.
    busy=true;route=to;screen='f12';render();
    await api('/api/site-b/select',{route:to});await b.refresh?.();
    noticeText=bState().selected===to?uiText("ui.h10.host.switchResultChecked"):
     uiText("ui.h10.host.switchResultPending");break;
   }
   case'scope-request':
    busy=true;noticeText='';await b.applyTier?.(value==='folder'?'light':'full');break;
   // 「安全与隐私」去设置（权限与能力在最上面）。
   case'privacy':close({showConnection:false});b.showPage?.('settings');return;
   case'admin-capability':{
    if(model().scope==='folder'){completionMarkup=null;return;}
    if(typeof b.setRisk!=='function'){close({showConnection:false});b.showPage?.('settings');return;}
    const on=model().adminEnabled;busy=true;render();await b.setRisk('admin',!on);break;
   }
   // 1069 第 4 条（Claude）：完成页的开关不问、不跳页，点了就做：浏览器控制直接装 Chrome 助手，桌面控制直接弹系统设置的授权；
   // 开着的点一下就关。装和授权的进度在 App 自己的弹框里（在这个窗口上面），这里不等它。
   case'browser-capability':case'desktop-capability':{
    const browser=action==='browser-capability',vm=model(),on=browser?vm.browserReady:vm.desktopReady;
    if(vm.scope==='folder'){completionMarkup=null;return;}
    if(typeof b.setCapability!=='function'){close({showConnection:false});b.showPage?.(browser?'browser':'desktop');return;}
    Promise.resolve(b.setCapability(browser?'browser':'desktop',!on)).catch(()=>{});return;
   }
   case'verify-pairing':
    busy=true;try{await pair();}catch(err){noticeText=uiText("ui.h10.host.verificationFailed", {code: safeCode(err)});}
    break;
   case'gatekeeper-help':
    noticeText=uiText("ui.h10.host.privacySettingsInstructions");break;
   case'open-privacy-settings':{
    const r=await b.native?.('openPrivacySettings');
    noticeText=r?.opened===true?uiText("ui.h10.host.privacySettingsOpened"):
     uiText("ui.h10.host.privacySettingsOpenFailed");break;
   }
   case'copy-terminal-command':{
    if(!f5Command){noticeText=uiText("ui.h10.host.installTargetUnverified");break;}
    const r=await b.native?.('copyText',{text:f5Command});
    noticeText=r?.copied===true?uiText("ui.h10.host.terminalCopied"):uiText("ui.h10.host.terminalCopyUnconfirmed");break;
   }
   // 1081 N203（Claude）：「手动下载」「验证安装包」两个链接没有发布桥以后一直是灰的；万一点到了，只提示去选本地 DMG。
   case'download-package':case'verify-package':
    noticeText=uiText("ui.h10.host.downloadUnconfigured");break;
   case'template-file':{
    // 1052 C3-6（Claude）：原生把随 App 带的模板 zip 复制到「下载」并在 Finder 里选中（同名不同内容就加编号，不覆盖）。
    busy=true;const r=await b.native?.('revealSiteTemplate',{});
    const expected=siteHandoff();
    if(r?.revealed===true&&(expected.sourceKind!=='bundled_local'||
       r.source_kind==='bundled_local'&&r.template_sha256===expected.sha256)){templateFileMode=true;noticeText='';}
    else noticeText=uiText("ui.h10.host.templateFileFailed", {code: safeCode(r)});break;
   }
   case'template-file-back':templateFileMode=false;noticeText='';break;
   case'copy-template-followup':{
    const text=siteTemplateFileFollowup(bridge()?.siteTemplateDescriptor?.()||{});
    if(!text){noticeText=uiText("ui.h10.host.templateMissing");break;}
    const r=await b.native?.('copyText',{text});noticeText=r?.copied===true?uiText("ui.h10.host.templateFollowupCopied"):uiText("ui.h10.host.copyRetry");break;
   }
   case'copy-assisted':{
    // 1070 二、十四（Claude）：两条路线复制的都是 /api/setup/skill 给的那句话；从连接页来的「帮我添加」「修」，复制那一次拿到的。
    // 这个窗口里还没拿过（比如 ChatGPT 在配、自己开的进度页），照这条路线拿一次。
    if(assistHandoff?.route!==route||!assistHandoff.prompt){const h=await api('/api/setup/skill',{route,locale:window.ChatHandText?.locale==='en'?'en':'zh'});
     assistHandoff={route,prompt:typeof h?.prompt==='string'?h.prompt:''};}
    const r=assistHandoff.prompt?await b.native?.('copyText',{text:assistHandoff.prompt}):null;assistedCopied=assistedCopied||r?.copied===true;
    noticeText=r?.copied===true?uiText("ui.h10.host.sentenceCopied"):uiText("ui.h10.host.copyRetry");break;
   }
   case'copy-site-update':{
    const text=siteUpdateHandoff(bridge()?.siteTemplateDescriptor?.()||{},bState().routes?.site?.origin);
    if(!text){noticeText=uiText("ui.h10.host.newTemplateMissing");break;}
    const r=await b.native?.('copyText',{text});noticeText=r?.copied===true?uiText("ui.h10.host.siteUpdateCopied"):uiText("ui.h10.host.copyRetry");break;
   }
   // ChatGPT 没自己试，用户点这个：生成一句带暗号的测试话，打开 ChatGPT 填好（原来设置助手那一页的两个按钮合成一个）。
   case'openai-test':{
    busy=true;const t=await api('/api/setup/test/start',{});
    const app=typeof current()?.settings?.chatgpt_app_name==='string'?current().settings.chatgpt_app_name.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,60):'';
    const prompt=t?.nonce?(app?uiText("ui.setup.connectionTestPromptNamed",{app,nonce:t.nonce}):uiText("ui.setup.connectionTestPrompt",{nonce:t.nonce})):'';
    if(!prompt){noticeText=uiText("ui.h10.host.operationUnavailable");break;}
    launched=true;const r=await b.openChatGPT?.(prompt,{work:false});
    noticeText=r?.prefilled===true?uiText("ui.h10.host.openaiTestPrefilled"):r?.copied===true?uiText("ui.h10.host.sentenceCopied"):uiText("ui.h10.host.chatGPTOpenUnconfirmed");break;
   }
   case'to-receive':setScreen('f11','pair');return;
   case'renew':setScreen('f11','renew');return;
   case'back-to-work':setScreen('f10');return;
   case'rewatch':watch=IDLE_WATCH;receiveEnteredAt=Date.now();receiveLocal=null;render();return;
   case'release-source':case'download-chatgpt':
    noticeText=uiText("ui.h10.host.sourceUnavailable");break;
   default:noticeText=uiText("ui.h10.host.operationUnavailable");
  }
 }catch(e){
  const code=safeCode(e),net=siteNetResult(code);
  // 1083（Claude）：本机服务开始建 Site 以前自己也查网络，被拦回 SITE_NETWORK_CHALLENGED / SITE_NETWORK_UNREACHABLE
  //（比如窗口这边没查成）：不出「操作失败」，回到选怎么配那一页（建 Site 那页就留在那页），显示被拦的样子。
  if(net){noteSiteNet(net);route='site';setupMode='manual';actor='user';launched=false;if(screen!=='f10')screen='f6';noticeText='';}
  else noticeText=uiText("ui.h10.host.operationFailed", {code});
 }
 finally{busy=false;render();}
}
async function nativePaste(e){
 if(!opened||screen!=='f11'||busy||!e.metaKey||e.key.toLowerCase()!=='v'||!overlay.contains(document.activeElement))return;
 e.preventDefault();busy=true;receiveLocal=null;noticeText='';render();
 try{
  const result=await bridge()?.native?.('pasteSiteGrant',{trigger:'command_v'});
  if(result?.accepted!==true){receiveLocal={status:'error',copy:sitePairingErrorCopy(safeCode(result))};return;}
  // 1052 C4（Claude）：新格式 server 自己配对，回 phase:'pairing'；同一个 Site 换凭据回 'credential_updated'。
  if(result.phase==='pairing'){receiveLocal={status:'received',origin:result.origin,copy:uiText("ui.h10.host.pairingInProgress", {origin: safeOrigin(result.origin)||'Site'})};return;}
  if(result.phase==='credential_updated'){receiveLocal={status:'received',origin:result.origin,copy:uiText("ui.h10.host.credentialsUpdating")};return;}
  // 老格式（三个字段，只认签名元数据里的目标）照旧要再点配对。
  noticeText=uiText("ui.h10.host.receivedPairingData");
  try{await pair();}catch(err){noticeText=uiText("ui.h10.host.pairingFailed", {code: safeCode(err)});}
 }catch(err){receiveLocal={status:'error',copy:sitePairingErrorCopy(safeCode(err))};}
 finally{busy=false;render();}
}
function close({showConnection=true}={}){
 clearProofExpiryTimer();if(watch.state!=='idle')void stopWatch();
 if(routeDialog.open)routeDialog.close();
 userSelectedDMG=null;opened=false;dispose?.();dispose=null;overlay.hidden=true;document.querySelector('#app').inert=false;
 // 交给别的设置页时不开连接抽屉，免得抽屉盖在那一页上面。
 if(showConnection)bridge()?.showPage?.('conn');
}
function start(options={}){
 if(opened)return;
 const s=current(),b=s?.site_b||{};
 // 1083（Claude，Ken 10/28 21:38）：没选过连接方式（setup_route 是 none）默认 OpenAI 通道，原来是 Site。
 const setupRoute=s?.setup_route==='none'?'openai':s?.setup_route;
 route=['site','openai'].includes(options.route)?options.route:['site','openai'].includes(setupRoute)?setupRoute:['site','openai'].includes(b.selected)?b.selected:'openai';
 // 1052（Claude）：没指定页面时，Site 已配对就到「在 ChatGPT 里连上」（有「重新核验」），不再落到欢迎页。
 // 1052 C4-7（Claude）：凭据过期时直接到重新收凭据那一页。
 const expired=route==='site'&&b.routes?.site?.configured===true&&b.routes.site.state==='auth_required'&&!bindingReplaced(b);
 firstRun=options.fromManualWizard===true||s?.settings?.setup_complete!==true&&s?.settings?.setup_ever_complete!==true;
 freshFrom=0;freshVerified=null;doneShownAt=0;
 let entryScreen=['f1','f5','f6','f7','f10','f11','f12'].includes(options.screen)?options.screen:null,assisted=options.assisted===true;
 seenFinishedAt=Math.max(seenFinishedAt,finishedAt(s)); // 打开窗口以前那次配完已经过去了，不再为它自动跳完成页
 // 1069 第 8 条（Claude）：从设置进来（「设置 ChatGPT Site / OpenAI 通道」「重新配」「开始设置」）：AI 正在配就看进度；
 // 这条路配了但还没连通，停在卡住的那一页；其余（没配过、已经配好）都从选方式开始，不直接跳到完成页。
 if(options.entry==='settings'&&!entryScreen){
  if(aiBusy(s)){entryScreen='f7';assisted=true;}
  else if(b.routes?.[route]?.configured===true&&!rawVerified(s,route))entryScreen=expired?'f11':'f12';
  else entryScreen='f6';
 }
 screen=entryScreen||(expired?'f11':route==='site'&&b.routes?.site?.configured===true?'f12':'f6');
 setupMode='manual';actor='user';manualPicked=false;guideStep=1;guideMedia=null;noticeText='';routeChosen=false;prefill='unconfirmed';userSelectedDMG=null;launched=false;
 // 1066 第 77 条（Claude）：AI 装好 ChatHand、配置助手也装好了，打开窗口直接是帮我配的进度（F7），两条路都一样。
 if(assisted&&screen==='f7'){setupMode='assisted';actor='ai';}
 if(options.fresh===true||options.entry==='settings'&&screen==='f7')beginFresh(s);
 templateFileMode=false;assistedCopied=false;assistedWeb=false;assistHandoff=null;watch=IDLE_WATCH;siteCheck=null;completeRequested=false;
 siteNetCtx=''; // 1083：每次打开都重新看要不要查网络（60 秒内查过的照旧用那次的）
 if(screen==='f11')enterReceive(options.purpose==='renew'||expired&&!options.screen?'renew':'pair');
 if(screen==='f10')enterReceive('pair');
 document.querySelector('#app').inert=true;opened=true;overlay.hidden=false;overlay.focus();render();
 if(screen==='f10')void primeSiteTemplate();
 void loadF5Command(); // Safe native target check only; never executes or approves the command.
}
// 1061 R03（Claude）：「换一种连接方式」选了哪条，页面就跟着到那条。原来只改了 route、页面不动，
// 在 Site 教学页选 OpenAI 通道还停在 Site 教学（Mac mini 1059 实测）。已经连好的那条才改生效的连接，
// 没连好的只去它的设置，不动生效的连接。
// 0010（Claude）：render() 每次都把整页和选择条的按钮换成新的，后台推一次状态就重画一次。
// 鼠标按下以后、松开以前要是重画了，按下的那个按钮已经不在页面上，松开时就不算一次点击（本机 Codex 在 1062 上复现过）。
// 所以按着的时候先不重画，记下来，松开、这次点击处理完以后再补画一次。
const releasePress=()=>{if(!pressing)return;pressing=false;if(renderPending){renderPending=false;setTimeout(render,0);}};
overlay.addEventListener('pointerdown',e=>{if(e.button===0)pressing=true;},true);
window.addEventListener?.('pointerup',releasePress,true);
window.addEventListener?.('pointercancel',releasePress,true);
window.addEventListener?.('blur',releasePress);
// 0012（Claude，Ken 10/19）：「换一种连接方式」改成弹框：选一种，每种下面一句说清特点（Site 好配、通道快一点），
// 按「确定」关掉弹框，出 toast「已切换到…」，欢迎页两张卡的标题后面标上现在走哪种。原来顶上那条选择条去掉：样式怪，
// 在 App 里还被顶上 48 点的拖动区吃掉点击，点了没反应。选了以后去哪页，跟原来那条一样（1061 R03）：已经连好的那条才改
// 生效的连接；没连好的只去它的设置，不动生效的连接。
const routeDialog=document.createElement('dialog');
routeDialog.id='h10RouteDialog'; routeDialog.setAttribute('aria-labelledby','h10RouteTitle');
overlay.append(routeDialog);
const toastText=message=>{try{bridge()?.toast?.(message);}catch{}};
function openRouteDialog(){
 if(busy||routeDialog.open)return;
 const b=bState();
 const title=document.createElement('h2');title.id='h10RouteTitle';title.textContent=uiText("ui.h10.host.routeDialogTitle");
 const lead=document.createElement('p');lead.className='h10-route-lead';lead.textContent=uiText("ui.h10.host.routeDialogLead");
 const group=document.createElement('div');group.className='h10-route-options';group.setAttribute('role','radiogroup');group.setAttribute('aria-labelledby','h10RouteTitle');
 // 1083（Claude，Ken 10/28 21:38）：OpenAI 通道排第一，Site 放到后面。
 for(const [id,note] of [['openai',uiText("ui.h10.host.routeOpenAINote")],['site',uiText("ui.h10.host.routeSiteNote")]]){
  const option=document.createElement('label');option.className='h10-route-option';
  const radio=document.createElement('input');radio.type='radio';radio.name='h10-route';radio.value=id;radio.checked=id===route;
  const text=document.createElement('span');text.className='h10-route-text';
  const name=document.createElement('span');name.className='h10-route-name';name.append(routeName(id));
  // 1069（Claude）：只标实际的：真在用的那条标「使用中」，连通的标「已连上」；页面上正在看哪条由选中的圆点表示。
  // 1081（Claude，Ken 10/27 10:37）：「使用中」跟设置里的连接卡片一样，是选项右上角的角标；「已连上」还跟在名字后面。
  if(isHealthy(b,id)){const chip=document.createElement('span');chip.className='h10-route-chip';chip.textContent=uiText("ui.h10.host.routeDialogConnected");name.append(chip);}
  if(id===b.selected&&b.routes?.[id]?.configured===true){const cur=document.createElement('span');cur.className='h10-route-cur';cur.textContent=uiText("ui.h10.host.routeDialogCurrent");option.classList.add('cur');option.append(cur);}
  const line=document.createElement('span');line.className='h10-route-note';line.textContent=note;
  text.append(name,line);option.append(radio,text);group.append(option);
 }
 const row=document.createElement('div');row.className='h10-route-actions';
 const cancel=document.createElement('button');cancel.type='button';cancel.className='btn';cancel.dataset.routeDialog='cancel';cancel.textContent=uiText("ui.h10.host.routeDialogCancel");
 const confirm=document.createElement('button');confirm.type='button';confirm.className='btn primary';confirm.dataset.routeDialog='confirm';confirm.textContent=uiText("ui.h10.host.routeDialogConfirm");
 row.append(cancel,confirm);
 routeDialog.replaceChildren(title,lead,group,row);
 routeDialog.showModal();
 routeDialog.querySelector('input[name="h10-route"]:checked')?.focus();
}
routeDialog.addEventListener('click',e=>{
 if(e.target===routeDialog){const r=routeDialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)routeDialog.close();return;}
 const which=e.target.closest?.('[data-route-dialog]')?.dataset.routeDialog;if(!which)return;
 const desired=routeDialog.querySelector('input[name="h10-route"]:checked')?.value;
 routeDialog.close();
 if(which==='confirm'&&['site','openai'].includes(desired))void switchRoute(desired);
});
routeDialog.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target?.name==='h10-route'){e.preventDefault();routeDialog.querySelector('[data-route-dialog="confirm"]')?.click();}});
async function switchRoute(desired){
 if(busy)return;
 const b=bState(),from=screen,switched=uiText("ui.h10.host.routeSwitched", {route: routeName(desired)});
 if(desired==='site'&&!siteCreatable()){noticeText=uiText("ui.h10.host.siteUnavailable");render();return;}
 // Persist setup intent even when this is the bootstrap/default route. This
 // never changes the execution route before the new connection is healthy.
 let selectionError=null;busy=true;
 try{await api('/api/setup/route',{route:desired});}
 catch(err){selectionError=err;}
 finally{busy=false;}
 if(selectionError){noticeText=uiText("ui.h10.host.routeSwitchFailed",{code:safeCode(selectionError)});render();return;}
 routeChosen=true;
 if(desired===route&&(desired===b.selected||!isHealthy(b,desired))){render();return;}
 if(isHealthy(b,desired)){
  route=desired;routeChosen=true;
  if(desired!==b.selected){
   busy=true;
   try{await api('/api/site-b/select',{route:desired});await bridge()?.refresh?.();
    if(bState().selected===desired){freshFrom=0;freshVerified=null;noticeText='';toastText(switched);}else noticeText=uiText("ui.h10.host.switchNotConfirmed");
    screen='f12';}
   catch(err){noticeText=uiText("ui.h10.host.routeSwitchFailed", {code: safeCode(err)});}
   finally{busy=false;}
  }else{freshFrom=0;freshVerified=null;noticeText='';screen='f12';toastText(switched);}
  render();return;
 }
 // 另一条已经连着、选的这条还没连好：先说清楚原来的连接在新的配好以前照旧能用。
 const message=b.selected&&b.selected!==desired&&isHealthy(b,b.selected)?uiText("ui.h10.host.routeSetupPending", {route: routeName(desired)}):switched;
 // 没连好的 OpenAI 通道：在帮配那页就去帮配，在自己配的 Site 教学页就去自己配的向导，跟「我自己配」「帮我配」走同一条路。
 // 1066 第 77 条（Claude）：在帮配那页换成 OpenAI 通道，还在 F7 里帮配，不再交给旧的设置助手。
 if(desired==='openai'&&from==='f7'){
  setupMode='assisted';actor='ai';route=desired;routeChosen=true;toastText(message);busy=true;
  try{await startOpenAIAssisted();}catch(err){noticeText=uiText("ui.h10.host.operationFailed",{code:safeCode(err)});}
  finally{busy=false;}
  screen='f7';render();return;
 }
 if(desired==='openai'&&from==='f10'){setupMode='manual';actor='user';close({showConnection:false});toastText(message);await window.startWizard?.();return;}
 route=desired;routeChosen=true;
 const site=desired==='site'?b.routes?.site:null;
 if(site?.configured===true&&site.state==='auth_required'&&!bindingReplaced(b)){toastText(message);setScreen('f11','renew');return;}
 screen=site?.configured===true?'f12':'f6';
 noticeText='';toastText(message);
 render();
}
actions.addEventListener('click',async e=>{
 const button=e.target.closest('button[data-extra]');if(!button||busy)return;
 switch(button.dataset.extra){
  case'select-dmg':{
   busy=true;
   try{
    const picked=await bridge()?.native?.('chooseReleaseDMG',{});
    if(picked?.cancelled===true){noticeText=uiText("ui.h10.host.dmgSelectionCancelled");}
    else if(picked?.user_selected===true&&picked?.payload_type==='dmg'&&
     picked?.signature_verified===false&&picked?.installed===false&&
     typeof picked?.path==='string'&&picked.path.startsWith('/')&&picked.path.endsWith('.dmg')){
     userSelectedDMG=Object.freeze({path:picked.path,payload_type:'dmg',user_selected:true,
      signature_verified:false,installed:false});
     noticeText=uiText("ui.h10.host.dmgSelected");
    }else{
     noticeText=uiText("ui.h10.host.dmgUntrusted");
    }
   }catch{noticeText=uiText("ui.h10.host.filePickerFailed");}
   finally{busy=false;render();}
   return;
  }
  case'credential':setScreen('f11');return;
  case'route':openRouteDialog();return;
  case'pair':
   busy=true;try{
    await pair();
   }catch(err){noticeText=uiText("ui.h10.host.verificationFailed", {code: safeCode(err)});}finally{busy=false;render();}
   return;
 }
});
overlay.addEventListener('keydown',e=>{void nativePaste(e)});
window.startH10=start;
// 1069 A2（Claude）：AI 在配就开进度页，配完（finished_at 新出现）开到完成页，各只自动开一次；你关了不再追着开。
// 只看 setup_activity：AI 跑个 doctor 之类，在已经连通的那条路上不算在配，不开窗口。
function maybeAutoOpen(){
 const s=current();if(!s)return false;
 // 1081（Claude，ChatGPT 复查 D02）：自己配 OpenAI 通道的向导开着时，后台记下的动静是你自己在配，不弹「ChatGPT 正在帮你配」盖在向导上面。
 const manual=document.getElementById?.('setupWizard')?.hidden===false;
 const f=finishedAt(s);
 if(f>seenFinishedAt&&finishedRecently(s)){
  seenFinishedAt=f;
  if(manual){activityOpened=true;return false;}
  const selected=s.site_b?.selected;
  if(!aiBusy(s)&&s.setup_activity?.route===selected&&rawVerified(s,selected)){
   activityOpened=true;
   if(!opened){start({screen:'f7',assisted:true});return true;}
   if(screen!=='f15'&&!busy&&!routeDialog.open){setupMode='assisted';actor='ai';screen='f7';noticeText='';}
   return false;
  }
 }
 if(!aiBusy(s)){activityOpened=false;return false;}
 if(activityOpened)return false;
 activityOpened=true;
 if(opened||manual)return false;
 const b=s.site_b||{},r=assistedRoute(s)||(['site','openai'].includes(s.setup_route)?s.setup_route:['site','openai'].includes(b.selected)?b.selected:'openai');
 if(rawVerified(s,r))return false;
 start({screen:'f7',assisted:true});return true;
}
// 1069 第 2 条（Claude）：去掉了「本机连接选择已更新；宿主通知与实际结果另需核对。」那句。
window.h10Refresh=()=>{initialEntryOnce();const started=maybeAutoOpen();if(opened&&!started)render();};
// 「改用 OpenAI 通道」（首页卡片、通知、chathand://setup/openai）：直接开始 OpenAI 通道的帮我配。
window.h10UseOpenAI=()=>{if(!opened)start({screen:'f7',route:'openai',assisted:true});void act('use-openai');};
// 1070 十四（Claude）：连接页用。setup 是两条都没加时的「让 ChatGPT 帮我配」（跟选方式那页一样）；add、repair 直接到进度页。
window.h10Assist=(r,intent)=>{const to=r==='site'?'site':'openai';if(intent==='setup'){if(!opened)start({route:to,screen:'f6'});route=to;void act('choose-assisted');return;}if(!opened)start({screen:'f7',route:to,assisted:true});void act('assist',{route:to,intent});};
window.h10SiteCreatable=()=>siteCreatable();
window.h10Ready=true;
// No fixture-based auto-open: older healthy A users remain on their existing setup.
// 1052（Claude）：和 wizard.js 用同一个判断（window.h10Entry），不看 selected。
let initialEntryChecked=false;
function initialEntryOnce(){const state=current();if(initialEntryChecked||!state)return;initialEntryChecked=true;if(opened)return;const entry=window.h10Entry?.(state);if(entry?.route)start(entry);}
initialEntryOnce();
window.h10SiteRouteCopy=siteRouteCopy; // 1052 C3-7（Claude）：设置里 Site 那一行用同一句话

subscribe(()=>{overlay.setAttribute('aria-label',uiText("ui.h10.host.accessibleTitle"));if(opened)render();});
