'use strict';
// Translation helpers preserve each original template parameter's escaping boundary.
const T=(key,params={})=>window.ChatHandText.t(key,params);
const TH=(key,params={})=>window.ChatHandText.html(key,Object.fromEntries(Object.entries(params).map(([name,value])=>[name,window.ChatHandText.trusted(value)])));
/* ChatHand 主窗口 · 单页工作台（1011，照 Ken 10/2 的 Figma「ChatHand 单页工作台」）
   左栏：进行中 / 已完成。右栏：ChatGPT 连接、权限与能力、设置、帮助与反馈。设置、帮助、任务过程都在右侧抽屉里。
   wizard.js 共用这里的全局：E、S、api、native、toast、connected、refresh、action。改名前先查它们。
   后端还没做的接口（检查并修复、复制给 AI、更新安装）照 docs/plans/v1/ChatHand-1011-开发任务书-20261002.md 的「前后端接口」调用；
   接口还不在时服务端回 API_UNKNOWN，这里只提示一句，不报错。 */
const $=s=>document.querySelector(s),E=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),htmlText=h=>String(h??'').replace(/<[^>]*>/g,'').replace(/&(amp|lt|gt|quot|#39);/g,(m,k)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[k]));
let nativeStatus=null,nativeStatusAt=0;
let S=null,P=null,tab='run',focusTask=null,doneFilter='all',doneQuery='',doneSearchFocus=false,matterQuery='',matterSearchFocus=false,matterFilter='all',matterSelected=new Set(),matterShowDeleted=false,matterHelpOpen=false,matterOpKeys=new Map(),matterLastDeleted=[],matterUndoTimer=0,drawer=null,flash='',scopeOpen=false,askResolve=null,observation=null,refreshing=false,refreshQueued=false,refreshPromise=null,announced=false,lastKey='';
const bubbleHidden=new Set();
let permissionHintReady=false,appearanceApplied=false,browserRepairNotice=false,reconnectConfirm=false,browserRetrying=false,browserFixPending=false,askDangerous=false,askReturnFocus=null,drawerReturnFocus=null;
const regionHTML=new Map(),regionKeys=new Map(),ringClockNodes=new WeakSet();let renderFrame=0,durationTimer=0,agoTimer=0;
const confirmReady=new Set(),confirmArmed=new Set(),confirmFeedback=new Map(),confirmErrors=new Map(),confirmKnownWaiting=new Set(),confirmDismissed=new Set();
let valueResetConfirm=false,valueResetError='',valueResetBusy=false,valueNumberFrame=0;
const ISSUES_URL='https://github.com/kenyupersonal-maker/chathand/issues/new/choose',RELEASES_URL='https://github.com/kenyupersonal-maker/chathand/releases',CHATGPT_URL='https://chatgpt.com/';
/* 试用的话：开头带上「@ChatHand 」。ChatGPT 不会自己去用连上的应用，要点名。Ken 10/5 实测：手打「@ChatHand 查一下这台 Mac 的系统版本和剩余空间」，ChatGPT 直接调了 ChatHand。
   以前填进去的话没带名字，只在提示里让人 @，发出去 ChatGPT 就用自己的办法、不走 ChatHand。界面上显示的是 PROMPT_LABELS（不带 @），填进去、复制的是 samplePrompts()。
   1081（Claude）：@ 后面用这台 Mac 在 ChatGPT 里的插件名（settings.chatgpt_app_name），账号里有好几个 ChatHand 时才不会用错；不知道就写 ChatHand。 */
function samplePrompts(){const v=S?.settings?.chatgpt_app_name,n=(typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,60):'')||'ChatHand';return ["ui.window.prompts.app1","ui.window.prompts.app2","ui.window.prompts.app3"].map(k=>T(k,{app:n}));}
let PROMPT_LABELS=[T("ui.window.promptLabels.text"),T("ui.window.promptLabels.text2"),T("ui.window.promptLabels.text3")];
let PROMPT_COPY_HINT=T("ui.window.promptCopyHint.text");
/* 原生外壳（菜单栏、通知）用这四个名字打开窗口里对应的地方：window.showPage(名字) */
let NAV=[['home',T("ui.window.nav.text")],['tasks',T("ui.window.nav.text2")],['conn',T("ui.window.nav.text3")],['settings',T("ui.window.nav.text4")]];
/* ---------- 基础 ---------- */
const icon=(id,cls='')=>`<svg class="i ${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
const btn=(title,action,id='',style='')=>`<button class="btn ${style}" type="button" data-action="${action}" data-id="${E(id)}">${E(title)}</button>`;
const ibtn=(ic,title,action,id='',style='')=>`<button class="btn ${style}" type="button" data-action="${action}" data-id="${E(id)}">${icon(ic,'sm')}<span>${E(title)}</span></button>`;
const tbtn=(title,action,id='')=>`<button class="tbtn" type="button" data-action="${action}" data-id="${E(id)}">${E(title)}</button>`;   // 卡片里的文字按钮
const notReady=e=>e?.code==='API_UNKNOWN';   // 后端还没有这个接口（联调前）
async function api(route,body){const r=await window.ChatHandAuth.fetch(route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});let j;try{j=await r.json();}catch{throw Error(T("ui.window.api.text"));}if(!r.ok||j.error){const code=j.error?.code||j.error;
 // 0012（Claude）：窗口丢了钥匙，后台回 UI_CONFIRM_REQUIRED / OWNER_AUTH_REQUIRED。原来弹一句「这一步只在 ChatHand 窗口里进行，AI 不能代做」的 toast，
 // 人明明就在窗口里点，看了不知道怎么办。改成弹「要重新打开」；ChatGPT 里找不到这台的应用（CHATGPT_APP_MISSING）弹加回去的框。都不再另弹 toast。
 if(IN_APP&&KEY_LOST_CODES.has(code)){windowKeyLost();throw Object.assign(Error(T("ui.window.keyLost.short")),{code,quiet:true});}
 if(code==='CHATGPT_APP_MISSING'){appMissingDialog({detected:true});throw Object.assign(Error(appUnbound()?T("ui.window.appMissing.unbound.cardSub"):T("ui.window.appMissing.cardSub")),{code,quiet:true});}
 throw Object.assign(Error(j.error?.message||j.message||j.error||T("ui.window.api.text2")),{code});}return j;}
const nativePending=new Map();window.nativeReply=message=>{const nativeCode=message?.result?.error?.code||message?.result?.error_code||message?.result?.error;if(IN_APP&&nativeCode==='NATIVE_OWNER_AUTH_REQUIRED')windowKeyLost();const p=nativePending.get(message.id);if(p){clearTimeout(p.timer);nativePending.delete(message.id);p.resolve(message.result);}};
/* 1061 V02（Claude）：系统的选文件夹、选安装盘和要人点的系统框，原生要等人选完才回话。原来一律 30 秒没回就当失败，
   选得慢的人选好了也存不上、什么都不说（Mac mini 1059）。这几样不设时限，别的照旧 30 秒。 */
const NATIVE_WAITS_FOR_USER=new Set(['chooseFolder','chooseReleaseDMG','restartAfterPermissions','repairPermissions']);
async function native(action,data={}){return new Promise(resolve=>{const id=crypto.randomUUID(),timer=NATIVE_WAITS_FOR_USER.has(action)?null:setTimeout(()=>{nativePending.delete(id);resolve({error:'NATIVE_TIMEOUT'});},action==='openChromeDataAccessSettings'?125000:30000);nativePending.set(id,{resolve,timer});const m={id,action,data};if(window.webkit?.messageHandlers?.native)window.webkit.messageHandlers.native.postMessage(m);else if(window.chrome?.webview)window.chrome.webview.postMessage(m);else{clearTimeout(timer);nativePending.delete(id);resolve({error:'NATIVE_APP_REQUIRED'});}});}
if(window.chrome?.webview)window.chrome.webview.addEventListener('message',event=>window.nativeReply(event.data));
// Appearance transaction state.
let appearanceSelection=0,appearanceIntent=null;
function applyAppearanceTheme(mode){const root=document.documentElement;if(mode==='system')root.removeAttribute('data-theme');else root.setAttribute('data-theme',mode);}
function synchronizeAppearance(){
 if(appearanceIntent&&Date.now()<appearanceIntent.expiresAt)return;
 applyAppearanceTheme(S?.settings?.appearance||'system');
}
async function chooseAppearance(mode){
 if(!['light','dark','system'].includes(mode))return;
 const selection=++appearanceSelection,expiresAt=Date.now()+30000;
 appearanceIntent={selection,expiresAt};applyAppearanceTheme(mode);
 try{
  const result=await native('setAppearance',{mode,expires_at:expiresAt});
  if(selection!==appearanceSelection)return;
  appearanceIntent=null;
  if(result?.cancelled||result?.superseded){synchronizeAppearance();return;}
  if(result?.error||result?.error_code||Date.now()>=expiresAt)throw Error(T("ui.window.action.appearance.text"));
  S={...S,settings:{...S.settings,appearance:mode}};scheduleRender();
 }catch{
  if(selection!==appearanceSelection)return;
  appearanceIntent=null;synchronizeAppearance();toast(T("ui.window.action.appearance.text"));
 }
}
// End appearance transaction.
// Mac 窗口外框：没有标题栏。三个窗口按钮在左上角（原生那边放，关闭按钮中心 22,22），品牌行在它下面；全屏时按钮没了，顶上留白收窄。
// 原生从 [data-drag] 区域拖窗口，里面能点的东西除外，所以版面一变就把这些矩形报过去；抽屉、弹窗开着时不报拖动区。
const IN_APP=!!window.webkit?.messageHandlers?.native;
const KEY_LOST_CODES=new Set(['UI_CONFIRM_REQUIRED','OWNER_AUTH_REQUIRED']);
if(IN_APP)document.documentElement.classList.add('in-app');
// 抽屉右边两个角跟窗口的圆角同心（style.css 的 --drawer-radius = 窗口圆角 --win-radius 减去抽屉离边的缝），左边两个角跟窗口的角一样大（--drawer-radius-left = --win-radius）；--win-radius = 窗口圆角的点数 ÷ 界面大小。界面大小在 App 里跟着设置走（adoptState 读 ui_zoom，⌘+ ⌘− 时 showZoom 也会改）；
// 窗口圆角原生可以在 setWindowChrome 里传 corner（点），不传就按 macOS 26 量出来的 16 点。
const setRootNumber=(name,value)=>{const n=Number(value);if(Number.isFinite(n)&&n>0)document.documentElement.style.setProperty(name,String(n));};
window.setWindowChrome=s=>{document.documentElement.classList.toggle('fs',!!s?.fullscreen);setRootNumber('--win-corner',s?.corner);reportChrome();};
const CLICKABLE='button,a[href],input,select,textarea,summary,label,[role="button"],[role="switch"],[role="tab"],[role="link"],[data-action],[data-page],[contenteditable="true"]';
let chromeKey='',chromeFrame=0;
function reportChrome(){if(!IN_APP||chromeFrame)return;chromeFrame=requestAnimationFrame(()=>{chromeFrame=0;const box=e=>{const b=e.getBoundingClientRect();return [Math.round(b.left),Math.round(b.top),Math.round(b.width),Math.round(b.height)];},meets=(a,z)=>a[0]<z[0]+z[2]&&z[0]<a[0]+a[2]&&a[1]<z[1]+z[3]&&z[1]<a[1]+a[3];const covered=!!document.querySelector('dialog[open]:not(.closing)'),zones=covered?[]:[...document.querySelectorAll('[data-drag]')].map(box).filter(z=>z[2]>0&&z[3]>0),sb=Math.round(document.querySelector('.drag-strip')?.getBoundingClientRect().bottom||0),holes=[...document.querySelectorAll(CLICKABLE)].map(box).map(b=>b[1]<sb?[b[0],sb,b[2],b[3]-(sb-b[1])]:b).filter(b=>b[2]>0&&b[3]>0&&zones.some(z=>meets(b,z))),key=JSON.stringify([zones,holes]);if(key===chromeKey)return;chromeKey=key;try{window.webkit.messageHandlers.native.postMessage({id:'',action:'windowChrome',data:{zones,holes}});}catch{}});}
addEventListener('resize',reportChrome);document.addEventListener('scroll',reportChrome,true);
/* 1015 微动效：只绑定以下明确的交互目标。 */
const microReduce=matchMedia('(prefers-reduced-motion: reduce)'),microAnimations=new Set(),segSeen=new WeakSet();
function microAnimate(el,frames,options){if(!el||microReduce.matches)return null;const a=el.animate(frames,options);microAnimations.add(a);a.finished.catch(()=>{}).finally(()=>microAnimations.delete(a));return a;}
microReduce.addEventListener('change',()=>{if(microReduce.matches)for(const a of microAnimations)a.cancel();});
function segSlide(){for(const seg of document.querySelectorAll('.seg,.tier-seg')){const b=seg.querySelector('button[aria-pressed="true"]');seg.style.setProperty('--seg-x',(b?.offsetLeft||0)+'px');seg.style.setProperty('--seg-w',(b?.offsetWidth||0)+'px');if(segSeen.has(seg))seg.classList.add('seg-ready');else{segSeen.add(seg);requestAnimationFrame(()=>{if(seg.isConnected)seg.classList.add('seg-ready');});}}}
addEventListener('resize',segSlide);
function filterIn(){const rows=[...document.querySelectorAll('#main .rl > *,#main > .empty')].slice(0,8);rows.forEach((el,i)=>microAnimate(el,[{opacity:0,transform:'translateY(6px)'},{opacity:1,transform:'none'}],{duration:240,delay:i*25,easing:'cubic-bezier(.2,.8,.2,1)',fill:'backwards'}));}
let toastTimer=null,toastAnimation=null,toastGeneration=0;
function permissionUndoStyle(){const t=$('#toast'),style=getComputedStyle(t),probe=document.createElement('button');probe.className='tbtn toast-undo';probe.textContent=T("ui.window.permissionUndoStyle.text");t.append(probe);const buttonStyle=getComputedStyle(probe),rgba=value=>{const srgb=/^color\(srgb\s/.test(value);if(!srgb&&!/^rgba?\(/.test(value))return null;const values=value.match(/[\d.]+/g)?.map(Number)||[];return values.length>=3?[...values.slice(0,3).map(x=>srgb?x:x/255),values[3]??1]:null;},result={dark:getComputedStyle(document.documentElement).colorScheme.includes('dark'),background:rgba(style.backgroundColor),foreground:rgba(style.color),border:rgba(style.borderTopColor),accent:rgba(buttonStyle.color),font_size:parseFloat(style.fontSize),radius:parseFloat(style.borderTopLeftRadius),bottom:parseFloat(style.bottom)};probe.remove();return result;}
function permissionFallbackToast(message){const t=$('#toast');if($('#drawer').open&&t.parentElement!==$('#drawer'))$('#drawer').append(t);toast(message);}
async function permissionRevokedToast(message,undo){const t=$('#toast');clearTimeout(toastTimer);toastGeneration++;toastAnimation?.cancel();t.hidden=true;if(undo&&IN_APP){const result=await native('permissionUndoPresent',{receipt_id:undo.receipt_id,style:permissionUndoStyle()});if(result?.ok===true&&result?.presented===true)return;permissionFallbackToast(T("ui.window.permissionRevokedToast.text",{"message":message}));return;}permissionFallbackToast(message);}
// 1082（Claude，Ken 10/28）：浮动提示一律底部居中；抽屉开着时放进抽屉、在抽屉里居中，不被抽屉盖住。
// 出错的句子传 'warn'，前面带一个橙色小圆圈；字多的多留一会儿（5～10 秒，中文按两个字算）。
// 1082（Ken 10/28 15:03）：提示末尾不带句号。中文「。」、英文「.」在这里统一去掉，省略号不动；句子中间的句号照留。
const toastTrim=message=>String(message??'').replace(/(?<![.。…])[。.]\s*$/,'');
function toastWait(message){const s=String(message??''),wide=(s.match(/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/g)||[]).length;return Math.min(10000,Math.max(5000,1500+(s.length+wide)*70));}
function toast(message,tone=''){if(quietModalOpen())return;message=toastTrim(message);const t=$('#toast'),drawerHost=$('#drawer'),host=drawerHost?.open?drawerHost:document.body;if(host&&t.parentElement!==host)host.append?.(t);const fresh=t.hidden,g=++toastGeneration,base='translateX(-50%) ',warn=tone==='warn';clearTimeout(toastTimer);toastAnimation?.cancel();t.classList.toggle('toast-warn',warn);let text=t.querySelector('[data-toast-text]');if(!text){text=document.createElement('span');text.dataset.toastText='';t.replaceChildren(text);}const mark=t.querySelector('.toast-icon');if(warn&&!mark)text.insertAdjacentHTML('beforebegin',icon('i-bang-circle','toast-icon'));else if(!warn)mark?.remove();text.textContent=message;t.hidden=false;
 toastAnimation=fresh?microAnimate(t,[{opacity:0,transform:base+'translateY(8px)'},{opacity:1,transform:base+'translateY(0)'}],{duration:200,easing:'cubic-bezier(.32,.72,0,1)'}):microAnimate(text,[{opacity:0},{opacity:1}],{duration:120,easing:'cubic-bezier(.32,.72,0,1)'});
 toastTimer=setTimeout(async()=>{toastAnimation=microAnimate(t,[{opacity:1,transform:base+'translateY(0)'},{opacity:0,transform:base+'translateY(4px)'}],{duration:160,easing:'cubic-bezier(.32,.72,0,1)',fill:'forwards'});await toastAnimation?.finished.catch(()=>{});if(g===toastGeneration){t.hidden=true;toastAnimation?.cancel();}},toastWait(message));}
let modalClosing=null,modalCloseTimer=0,modalCloseResolve=null;
function cancelModalClose(){clearTimeout(modalCloseTimer);modalCloseTimer=0;$('#modal').classList.remove('closing');const resolve=modalCloseResolve;modalClosing=null;modalCloseResolve=null;resolve?.();}
function closeModal(cancelChrome=true){const d=$('#modal');if(!d.open)return Promise.resolve();stopChromeInstallView(cancelChrome);if(modalClosing)return modalClosing;if(microReduce.matches){d.close();return Promise.resolve();}d.classList.add('closing');modalClosing=new Promise(resolve=>{modalCloseResolve=resolve;modalCloseTimer=setTimeout(()=>{d.close();cancelModalClose();},160);});return modalClosing;}
$('#modal').addEventListener('cancel',e=>{e.preventDefault();void closeModal();});
async function closeScope(){const menu=$('.scope .menu');const a=microAnimate(menu,[{opacity:1},{opacity:0}],{duration:120,easing:'cubic-bezier(.32,.72,0,1)',fill:'forwards'});await a?.finished.catch(()=>{});scopeOpen=false;render();a?.cancel();}
const copyFeedback=new Map();
function copyPulse(button){const use=button.querySelector('svg use'),previous=copyFeedback.get(button);if(previous)clearTimeout(previous.timer);const original=previous?.original||use?.getAttribute('href');button.classList.add('copyok');if(use){use.setAttribute('href','#i-check');microAnimate(use.closest('svg'),[{opacity:0,transform:'scale(.6)'},{opacity:1,transform:'scale(1)'}],{duration:180,easing:'cubic-bezier(.32,.72,0,1)'});}const timer=setTimeout(()=>{copyFeedback.delete(button);button.classList.remove('copyok');const current=button.querySelector('svg use');if(current&&original){current.setAttribute('href',original);microAnimate(current.closest('svg'),[{opacity:0},{opacity:1}],{duration:180,easing:'cubic-bezier(.32,.72,0,1)'});}},1500);copyFeedback.set(button,{original,timer});}
function restoreCopyFeedback(){for(const [button,state] of copyFeedback){if(!button.isConnected){clearTimeout(state.timer);copyFeedback.delete(button);continue;}button.classList.add('copyok');const use=button.querySelector('svg use');if(use)use.setAttribute('href','#i-check');}}
function timelineComplete(root,running){if(microReduce.matches)return;for(const nd of root.querySelectorAll('.nd.ok'))if(running.has(nd)){microAnimate(nd,[{backgroundColor:'transparent'},{backgroundColor:getComputedStyle(nd).backgroundColor}],{duration:200,easing:'cubic-bezier(.32,.72,0,1)'});microAnimate(nd.querySelector('svg'),[{strokeDashoffset:'40'},{strokeDashoffset:'0'}],{duration:300,easing:'ease-out'});}}

function modal(html,kind=''){cancelModalClose();askReturnFocus=document.activeElement;$('#modal').classList.remove('ask-modal');if(kind)$('#modal').dataset.kind=kind;else delete $('#modal').dataset.kind;$('#modal').removeAttribute('aria-labelledby');$('#closeModal').hidden=false;ChatHandMorph.align($('#modalContent'),html);if(!$('#modal').open)$('#modal').showModal();}
$('#closeModal').onclick=()=>closeModal();
/* 点弹窗外面的遮罩就关（按下和松开都在外面才算，免得拖选文字时误关） */
function closeOnBackdrop(d,close){let down=false;const out=e=>{if(e.target!==d)return false;const r=d.getBoundingClientRect();return e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom;};d.addEventListener('pointerdown',e=>{down=out(e);});d.addEventListener('click',e=>{if(down&&out(e))close();down=false;});}
closeOnBackdrop($('#modal'),()=>closeModal());$('#modal').addEventListener('close',()=>{$('#modalContent').replaceChildren();delete $('#modal').dataset.kind;setTimeout(maybeShowAppMissing,400);if(askResolve){const r=askResolve;askResolve=null;r(false);}const returnFocus=askReturnFocus;askReturnFocus=null;setTimeout(()=>{if(returnFocus?.isConnected)returnFocus.focus();},0);askDangerous=false;syncClocks();});
async function openURL(url){const r=await native('openExternal',{url});if(r?.error)window.open(url,'_blank','noopener');}
async function copyText(text,button){try{await navigator.clipboard.writeText(text);}catch{const r=await native('copyText',{text});if(r?.error)throw Error(T("ui.window.copyText.text"));}if(button)copyPulse(button);toast(T("ui.window.copyText.text2"));}

/* ---------- 时间 ---------- */
const pad=n=>String(n).padStart(2,'0');
const clock=ms=>{const d=new Date(ms);return pad(d.getHours())+':'+pad(d.getMinutes());};
function sameLocalDay(a,b){const x=new Date(a),y=new Date(b);return x.getFullYear()===y.getFullYear()&&x.getMonth()===y.getMonth()&&x.getDate()===y.getDate();}
function dayLabel(ms){const d=new Date(ms),now=new Date(Date.now()),a=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime(),b=new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime(),diff=Math.round((a-b)/864e5);return diff===0?T("ui.window.dayLabel.text"):diff===1?T("ui.window.dayLabel.text2"):T("ui.window.dayLabel.text3",{"value":d.getMonth()+1,"value2":d.getDate()});}
const when=ms=>ms?dayLabel(ms)+' '+clock(ms):'';
function ago(ms){if(!ms)return '';const s=Math.max(0,(Date.now()-ms)/1000);if(s<60)return T("ui.window.ago.text");if(s<3600)return T("ui.window.ago.text2",{"value":Math.floor(s/60)});if(s<86400&&sameLocalDay(ms,Date.now()))return T("ui.window.ago.text3",{"value":Math.floor(s/3600)});return when(ms);}
function dur(ms){const s=Math.max(0,Math.round(ms/1000)),m=Math.floor(s/60);return m>=60?T("ui.window.dur.text",{"value":Math.floor(m/60),"value2":m%60}):m>=10?T("ui.window.dur.text2",{"m":m}):`${m}:${pad(s%60)}`;}

/* ---------- 状态整理：页面只读这里算出来的值 ---------- */
function selectedConnection(){
 const b=S?.site_b||{},configured=b.routes?.site?.configured===true||b.routes?.openai?.configured===true||S?.settings?.tunnel||S?.credentials?.tunnel===true;
 // 1083（Claude，Ken 10/28 21:38）：两条都还没配、也没选过（none）时默认 OpenAI 通道，原来是 Site。
 if(!configured&&['none','site','openai'].includes(S?.setup_route))return S.setup_route==='site'?'site':'openai';
 return b.selected==='site'?'site':'openai';
}
function siteConfigured(){return S?.site_b?.routes?.site?.configured===true;}
// 1068（Claude）：Site 线上做过一次连接测试（setup_test 记着这一个 Site），首页就写「已连接」。
function siteTested(){const t=S?.setup_test,r=S?.site_b?.routes?.site;return t?.route==='site'&&t?.verified===true&&typeof t?.site_id==='string'&&t.site_id!==''&&t.site_id===r?.site_id;}
function siteHealthy(){const r=S?.site_b?.routes?.site;return r?.configured===true&&r?.state==='healthy'&&r?.health_fresh===true;}
// 1069 A4/A5（Claude）：选的是 Site，但这个 Site 被别的电脑改连走了（site_b.binding_replaced），或者 Mac 到 Site 被网络验证拦住
// （site_b.connection_stages.network_challenge，下一次成功后台就清掉）。首页卡片和设置的连接页都照这个说、给出口。
// 后台没有设备名时填「另一台电脑」，当没名字处理（中文不套引号，英文界面不冒中文）。
// 1070 十四（Claude）：any=true 时不管选的是哪条都看（连接页里备用的 Site 也要说清楚）。
function siteBlock(any=false){if(!any&&selectedConnection()!=='site')return null;const b=S?.site_b||{},r=b.binding_replaced;
 if(r&&typeof r==='object'){const name=typeof r.device_name==='string'?r.device_name.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,60):'';return {kind:'replaced',device:name==='\u53e6\u4e00\u53f0\u7535\u8111'?'':name};}
 if(b.connection_stages?.network_challenge)return {kind:'challenge'};
 return null;}
/* 1052 C4-4（Claude）：Site 的地址只认 https 的 *.chatgpt.site。
   1069 第 5 条（Claude）：配上以后顶上那条「已连上 Site … 断开」去掉了；断开在设置的连接页 Site 那一行。 */
function siteOrigin(o){try{const u=new URL(o);return u.protocol==='https:'&&u.origin===o&&u.hostname.endsWith('.chatgpt.site')?u.origin:'';}catch{return '';}}
/* 断开走 /api/site-b/revoke：Site 那头撤成了回 remote_revocation:'confirmed'；连不上回 'unconfirmed'，本机照样断开。 */
async function siteDisconnect(){
 const o=siteOrigin(S?.site_b?.routes?.site?.origin);
 if(!await ask({title:T("ui.window.siteDisconnect.title.text"),body:[o?T("ui.window.siteDisconnect.body.text",{"o":o}):T("ui.window.siteDisconnect.body.text2"),T("ui.window.siteDisconnect.body.text3")],ok:T("ui.window.siteNoticeHTML.text2"),icon:'i-power'}))return;
 try{const r=await api('/api/site-b/revoke',{});toast(r?.remote_revocation==='confirmed'?T("ui.window.siteDisconnect.text"):T("ui.window.siteDisconnect.text2"));}
 catch{toast(T("ui.window.siteDisconnect.text3"));}
 await refresh();}
/* 1070 十四（Claude，Ken 10/22 选 B）：设置里的连接页，顶上 ChatGPT Site、OpenAI 通道两个标签，在用的那个带绿点。
   每条路线四种样子：在用；备用（「改用」）；没加（「让 ChatGPT 帮我添加」「我自己添加」）；坏了（「让 ChatGPT 修」「我自己修」）。每条都能删，删前确认。
   另两种排法留在代码里不用（Ken：留着，不用删）：A 两张卡、C 当前一块加「更换」下拉。改 CONN_LAYOUT 就换。 */
const CONN_LAYOUT='tabs'; // 'tabs'：B，在用 | 'cards'：A | 'menu'：C
const CONN_ORDER=['openai','site']; // 1083（Claude，Ken 10/28 21:38）：OpenAI 通道排第一，Site 放到后面
let connTab='',connBusy='',connMenu=false;
// OpenAI 通道加没加：本机存着通道密钥或通道号，或者快捷连接配过对。不看 site_b.routes.openai.configured，删了通道它还留着。
function openaiAdded(){return S?.credentials?.tunnel===true||!!S?.settings?.tunnel||S?.credentials?.relay===true||S?.relay?.paired===true||S?.relay?.online===true;}
function routeAdded(r){return r==='site'?siteConfigured():openaiAdded();}
function otherRoute(r){return r==='site'?'openai':'site';}
function connRouteName(r){return r==='site'?'ChatGPT Site':connectionMethod()==='relay'?T("ui.window.connectionName.text"):T("ui.window.connectionName.text2");}
function connRouteIcon(r){return r==='site'||connectionMethod()==='relay'?'i-site':'i-tunnel';}
function routeInUse(r){return routeAdded(r)&&selectedConnection()===r;}
function openaiLive(){const c=S?.connection||{};return !!((c.display?c.display.connected:c.ready&&c.healthy&&c.control_plane?.state!=='down')||S?.relay?.online);}
function openaiReason(){const d=S?.connection?.display;if(!d||S?.relay?.online)return offlineReason();if(d.state==='down')return d.detail||offlineReason();return d.detail&&d.detail!==d.title?T("ui.window.conn.reasonJoin",{title:d.title,detail:d.detail}):d.title;}
// 每条路线自己现在怎么样，不管在不在用：online 连着 / connecting 正在连 / idle 没连着、也没出错 / broken 连不上、要修（why 是哪里不对）
function routeStatus(r){
 if(r==='site'){const x=S?.site_b?.routes?.site||{},blocked=siteBlock(true);
  if(blocked)return {st:'broken',why:siteBlockText(blocked)};
  if(siteHealthy())return {st:'online'};
  if(x.state==='auth_required'||x.state==='failed')return {st:'broken',why:siteWhy(x)};
  if(x.state==='pairing'||x.state==='reconnecting')return {st:'connecting'};
  return {st:'idle'};}
 if(openaiLive())return {st:'online'};
 const c=S?.connection||{},a=c.automatic||{},d=c.display;
 if(d&&!S?.relay?.online){if(['connecting','checking','unknown'].includes(d.state))return {st:'connecting'};
  if(d.state==='local_error'||d.state==='down'||d.state==='offline'&&a.phase==='offline')return {st:'broken',why:openaiReason()};
  return {st:'idle'};}
 if(['starting','connecting','reconnecting','restoring'].includes(a.phase)||c.process_running&&!c.ready)return {st:'connecting'};
 if(a.phase==='needs_login'||a.phase==='needs_retry'||a.error_code==='CREDENTIAL_SAVE_FAILED'||a.error_code==='CONNECTION_AUTH_FAILED')return {st:'broken',why:offlineReason()};
 return {st:'idle'};}
// 1081（Claude，Ken 10/27 10:18）：任务上面那条，在用的那条连接要修（不会自己好）时说哪里不对、给去连接页的按钮，不写「正在重连」。
function stripBroken(){if(!connected()&&['site','openai'].includes(selectedConnection())){const r=routeStatus(selectedConnection());if(r.st==='broken')return r.why||'';}return '';}
// Site 连不上时说哪里不对：只说是什么，怎么修交给下面「让 ChatGPT 修」「我自己修」。
function siteWhy(x){if(x?.state==='auth_required')return T("ui.window.conn.siteExpired");if(x?.reason==='B_TEMPLATE_MISMATCH')return T("ui.window.conn.siteOutdated");return T("ui.window.conn.siteDown");}
// 句子末尾没标点的补一个（首页横条那几句本来不带句号）。
const fullStop=s=>{s=String(s||'').trim();return !s||/[。！？.!?]$/.test(s)?s:s+(window.ChatHandText?.locale==='en'?'.':'。');};
// 名字放进句子里时不在中间断行（「ChatGPT / Site」）。
const nbName=r=>connRouteName(r).replace(/ /g,'\u00a0');
// 两句话接起来：中文直接接，英文中间空一格。
const sentenceJoin=(...a)=>a.filter(Boolean).join(window.ChatHandText?.locale==='en'?' ':'');
function connected(){if(selectedConnection()==='site')return siteHealthy();const c=S?.connection||{};return !!((c.display?c.display.connected:c.ready&&c.healthy&&c.control_plane?.state!=='down')||S?.relay?.online);}
function configured(){if(selectedConnection()==='site')return siteConfigured();return !!(S.settings.tunnel||S.relay?.paired||['tunnel','relay'].includes(S.settings.connection_preference));}
function userMessage(error,fallback=T("ui.window.userMessage.text")){const text=error?.message||error;return typeof text==='string'&&/[\u3400-\u9fff]/.test(text)?text:fallback;}
function connectionText(){if(selectedConnection()==='site')return siteHealthy()?T("ui.window.connectionText.text"):siteConfigured()?T("ui.window.connectionText.text2"):T("ui.window.connectionText.text3");const c=S?.connection||{},a=c.automatic||{};if(c.display&&!S?.relay?.online)return c.display.title;if(connected())return T("ui.window.connectionText.text4");if(a.error_code==='CREDENTIAL_SAVE_FAILED')return T("ui.window.connectionText.text5");return ({starting:T("ui.window.connectionText.starting.text"),connecting:T("ui.window.connectionText.connecting.text"),running:T("ui.window.connectionText.running.text"),reconnecting:T("ui.window.connectionText.reconnecting.text"),needs_login:T("ui.window.connectionText.needs_login.text"),needs_retry:T("ui.window.connectionText.needs_retry.text"),offline:T("ui.window.connectionText.offline.text"),idle:T("ui.window.connectionText.idle.text")})[a.phase]||T("ui.window.connectionText.text6");}
// 1081（Claude，ChatGPT 复查 D01）：只说 OpenAI 通道本身。已经在用 Site 时「自己添加 OpenAI 通道」的向导看这个，不拿 Site 的状态替新通道说话。
function tunnelText(){const c=S?.connection||{},a=c.automatic||{};if(c.display&&!S?.relay?.online)return c.display.title;if(openaiLive())return T("ui.window.connectionText.text4");if(a.error_code==='CREDENTIAL_SAVE_FAILED')return T("ui.window.connectionText.text5");return ({starting:T("ui.window.connectionText.starting.text"),connecting:T("ui.window.connectionText.connecting.text"),running:T("ui.window.connectionText.running.text"),reconnecting:T("ui.window.connectionText.reconnecting.text"),needs_login:T("ui.window.connectionText.needs_login.text"),needs_retry:T("ui.window.connectionText.needs_retry.text"),offline:T("ui.window.connectionText.offline.text"),idle:T("ui.window.connectionText.idle.text")})[a.phase]||T("ui.window.connectionText.text6");}
function connState(){if(connected())return 'online';if(selectedConnection()==='site')return siteConfigured()?'offline':'unset';const c=S.connection||{},a=c.automatic||{},cp=c.control_plane;if(c.display&&!S.relay?.online)return c.display.state==='connecting'||c.display.state==='checking'||c.display.state==='unknown'?'connecting':configured()?'offline':'unset';if(['starting','connecting','reconnecting','restoring'].includes(a.phase)||(c.process_running&&!c.ready))return 'connecting';return configured()?'offline':'unset';}
function lastCall(){let best=null;for(const v of Object.values(S.last_calls||{}))if(v?.time&&(!best||v.time>best.time))best=v;return best;}
// 1069 第 6 条（Claude）：最近调用按路线分。每条调用带 route（1069 起）；没带的是老记录，只算 OpenAI 通道。
// Site 再看 Site 自己记的最近一次成功调用（site_b.connection_stages.last_call.succeeded_at），取晚的那个。
function routeLastCall(route){let best=null;for(const v of Object.values(S.last_calls||{}))if(v?.time&&(route==='site'?v.route==='site':v.route!=='site')&&(!best||v.time>best.time))best=v;
 if(route==='site'){const t=Number(S?.site_b?.connection_stages?.last_call?.succeeded_at);if(Number.isSafeInteger(t)&&t>0&&(!best||t>best.time))best={time:t};}
 return best;}
function tunnelId(){return S.settings.tunnel?.tunnel_id||S.connection?.tunnel_id||S.settings.setup_tunnel_id||'';}
const shortId=(id,head=11,tail=4)=>id&&id.length>head+tail+1?id.slice(0,head)+'…'+id.slice(-tail):id||'';
// 1082（Claude，1081 验收）：自带的那个工作区，后端存的名字是中文「默认工作区」，英文界面也照写；文件范围的说明又写目录名，两处对不上。统一按界面语言显示同一个名字。
function workspaceName(){const p=S.project?.path||'',n=S.project?.name;if(n==='默认工作区')return T("ui.window.workspaceName.default");return n||p.split('/').filter(Boolean).pop()||T("ui.window.workspaceName.text");}
function perms(){return S.automation?.computer?.permissions||{};}
function browserOn(){return S.automation?.browser?.extension?.connected===true||S.automation?.browser?.personal?.connected===true;}
function desktopState(){if(S.capabilities?.desktop_control===false)return 'unsupported';const p=perms();return p.accessibility&&p.screen_recording?'on':p.accessibility||p.screen_recording?'partial':'off';}
function allTasks(){const out=new Map();for(const g of S.activity?.items||[])for(const t of g.tasks||[])out.set(t.task_id,{...t,group:g});for(const t of S.tasks||[]){const prev=out.get(t.task_id);out.set(t.task_id,{...(prev||{}),...t,group:prev?.group||null});}return [...out.values()].sort((a,b)=>(b.finished_at||b.created_at||0)-(a.finished_at||a.created_at||0));}
const active=t=>t.status==='active'||t.status==='pending_approval'||t.status==='installing';
const waitingOn=t=>(S.approvals||[]).find(a=>a.task_id===t.task_id&&a.status==='pending_approval');
function kind(t){if(t.status==='installing')return 'run';if(t.status==='active')return waitingOn(t)?'wait':'run';if(t.status==='pending_approval')return 'wait';if(t.status==='completed')return 'ok';if(t.status==='failed')return 'fail';return 'stop';}
function isRefreshTask(t){return t.source==='chathand_auto'&&t.source_kind==='tools_refresh';}
function chatTitle(t){if(isRefreshTask(t))return T("ui.window.chatTitle.text");const g=t.group;return g&&(!g.id?.startsWith('task:')||g.conversation_url)&&g.title?g.title:'';}
function taskGroups(list){const groups=new Map();for(const t of list){const key=t.group?.id||'task:'+t.task_id;if(!groups.has(key))groups.set(key,{title:chatTitle(t),tasks:[]});groups.get(key).tasks.push(t);}return [...groups.values()];}
let TOOL_WORDS={save_files:T("ui.window.toolWords.save_files.text"),write_file:T("ui.window.toolWords.write_file.text"),write_text:T("ui.window.toolWords.write_file.text"),edit_file:T("ui.window.toolWords.edit_file.text"),create_directory:T("ui.window.toolWords.create_directory.text"),move_file:T("ui.window.toolWords.move_file.text"),move_path:T("ui.window.toolWords.move_file.text"),rename_file:T("ui.window.toolWords.rename_file.text"),delete_file:T("ui.window.toolWords.delete_file.text"),trash_path:T("ui.window.toolWords.trash_path.text"),restore_file:T("ui.window.toolWords.restore_file.text"),restore_trash:T("ui.window.toolWords.restore_trash.text"),copy_file:T("ui.window.toolWords.copy_file.text")};
/* 1021：时间线里的路径写短。工作区里的写相对路径；家目录写 ~；还太长就从中间省略，保住文件名。全路径放悬停提示。 */
function shortPath(p){p=String(p||'');if(!p)return '';const root=String(S.project?.path||'').replace(/\/+$/,'');let s=root&&(p===root||p.startsWith(root+'/'))?p.slice(root.length+1)||'.':p.replace(/^\/Users\/[^/]+(?=\/|$)/,'~');if(s.length<=46)return s;const i=s.lastIndexOf('/'),name=i>=0?s.slice(i+1):s;if(name.length>=40)return '…'+name.slice(-39);const keep=46-name.length-2;return s.slice(0,Math.max(4,keep))+'…/'+name;}
const changeCache=new Map();
async function loadChanges(id,force=false){const c=changeCache.get(id);if(c&&!force&&Date.now()-c.at<5000)return c.changes;try{const r=await api('/api/task-changes',{id});const changes=r.changes||[];changeCache.set(id,{at:Date.now(),changes});if(JSON.stringify(changes)!==JSON.stringify(c?.changes||[]))scheduleRender();}catch{changeCache.set(id,{at:Date.now(),changes:c?.changes||[]});}return changeCache.get(id).changes;}
function jobsOf(t){const ids=new Set(t.jobs||[]);return (S.jobs||[]).filter(j=>ids.has(j.job_id));}
function commandText(j){return [j.program,...(j.args||[])].filter(Boolean).join(' ');}
function shortCommand(j){
 const program=String(j.program||''),args=(j.args||[]).map(x=>String(x));let text='';
 const shell=['sh','bash','zsh'].includes(program.split('/').pop())&&['-c','-lc','-ic'].includes(args[0]);
 text=shell?(args[1]||''):commandText(j);
 /* shell 前面常有「环境变量 + cd 工作区 &&」；这些对人没用，先剥掉，再把剩下的路径缩短。 */
 for(let i=0;i<3;i++){const before=text;text=text.replace(/^\s*(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;]+)\s+)+/,'');text=text.replace(/^\s*cd\s+(?:"[^"]+"|'[^']+'|[^\s;&]+)\s*(?:&&|;)\s*/,'');if(text===before)break;}
 text=text.replace(/\/Users\/[^\s"';&|()]+/g,p=>shortPath(p)).replace(/\s+/g,' ').trim();
 const chars=[...text];return chars.length>46?chars.slice(0,45).join('')+'…':text;
}
function durWords(ms){const s=Math.max(0,Math.round(ms/1000));if(s<60)return T("ui.window.durWords.text",{"s":s});const m=Math.round(s/60);return m<60?T("ui.window.dur.text2",{"m":m}):T("ui.window.dur.text",{"value":Math.floor(m/60),"value2":m%60});}
/* 任务的每一步，从早到晚：开始任务 → 命令和文件改动。title 一行、detail 一行、time 是右边那一格。
   jobs 里的 last_line（这条命令最后一行输出）由后端给，没有就只写退出码和用时。 */
/* 1026：命令结束时报的「退出码」换成人话（Ken 10/7）。字下面有虚线，鼠标移上去说明这个数是什么意思；原来的数字留在说明里，交接给 AI 时还用得上。 */
let EXIT_WORDS={0:[T("ui.window.exitWords.text"),T("ui.window.exitWords.text2")],1:[T("ui.window.exitWords.text3"),T("ui.window.exitWords.text4")],2:[T("ui.window.exitWords.text5"),T("ui.window.exitWords.text6")],126:[T("ui.window.exitWords.text7"),T("ui.window.exitWords.text8")],127:[T("ui.window.exitWords.text9"),T("ui.window.exitWords.text10")],130:[T("ui.window.exitWords.text11"),T("ui.window.exitWords.text12")],137:[T("ui.window.exitWords.text13"),T("ui.window.exitWords.text14")],143:[T("ui.window.exitWords.text15"),T("ui.window.exitWords.text16")]};
const SIGNAL_CODE={SIGINT:130,SIGKILL:137,SIGTERM:143};
function exitWords(code){const n=Number(code),w=EXIT_WORDS[n];return w?{text:w[0],tip:T("ui.window.exitWords.tip.text",{"value":w[1],"n":n})}:{text:T("ui.window.exitWords.text3"),tip:T("ui.window.exitWords.tip.text2",{"code":code})};}
function timelineResult(j,running){
 const raw=String(j.last_line||'').trim();if(!raw)return running?T("ui.window.timelineResult.text"):'';
 if(/^[{[]/.test(raw)){try{const value=JSON.parse(raw),text=[value?.message,value?.summary,value?.result?.message,value?.result?.summary].find(x=>typeof x==='string'&&x.trim()&&!/^[{[]/.test(x.trim()));return text?midText(text.replace(/\s+/g,' ').trim(),100):running?T("ui.window.timelineResult.text"):T("ui.window.timelineResult.text2");}catch{return running?T("ui.window.timelineResult.text"):T("ui.window.timelineResult.text2");}}
 return midText(raw.replace(/\s+/g,' '),100);
}
function stepsOf(t,{human=false}={}){
 if(isRefreshTask(t)){const a=t.automatic_task||{},rows=(a.steps||[]).map((s,i)=>({key:'refresh:'+i,at:t.created_at,state:s.ok?'ok':'fail',title:s.title,detail:a.stopped_at===s.step?T("ui.window.stepsOf.detail.text"):'',time:''}));if(a.stopped_at&&!rows.some(s=>s.detail))rows.push({key:'refresh:stop',state:'wait',title:T("ui.window.stepsOf.title.text"),detail:T("ui.window.stepsOf.detail.text"),time:''});return rows;}
 const steps=[];
 for(const j of jobsOf(t)){const running=j.status==='running'||(!j.finished_at&&j.process_alive),code=commandText(j);
  const exitCode=j.exit_code??SIGNAL_CODE[j.signal],ex=running||exitCode===null||exitCode===undefined?null:exitWords(exitCode),took=j.finished_at&&j.started_at?T("ui.window.stepsOf.text",{"durWords":durWords(j.finished_at-j.started_at)}):'';
  const last=human?timelineResult(j,running):j.last_line||'',detail=running?(last||T("ui.window.timelineResult.text")):dotJoin([last,ex?ex.text:'',took]);
  const detailHtml=ex?[last?E(last):'',`<span class="term" tabindex="0" data-tip="${E(ex.tip)}">${E(ex.text)}</span>`,took?E(took):''].filter(Boolean).join(' · '):'';
  steps.push({key:'job:'+j.job_id,at:j.started_at||j.created_at,state:running?'run':j.exit_code===0?'ok':j.status==='pending_approval'?'wait':'fail',title:T("ui.window.stepsOf.title.text2",{"shortCommand":shortCommand(j)}),tip:T("ui.window.stepsOf.tip.text",{"code":code}),detail,detailHtml,time:running?dur(Date.now()-(j.started_at||j.created_at)):clock(j.finished_at||j.started_at||j.created_at)});}
 for(const c of changeCache.get(t.task_id)?.changes||[]){const verb=TOOL_WORDS[c.tool]||c.tool,full=verb+' '+(c.destination?`${c.path} → ${c.destination}`:c.path||'');steps.push({key:'change:'+(c.operation_id||c.time+':'+c.path),at:c.time,state:c.status==='applied'?'ok':'fail',title:verb+' '+(c.destination?`${shortPath(c.path)} → ${shortPath(c.destination)}`:shortPath(c.path)),tip:full,merge:c.destination?'':c.tool+'|'+c.path,detail:c.status==='applied'?(human?(c.tool==='create_directory'?T("ui.window.stepsOf.detail.text2"):c.destination?T("ui.window.stepsOf.detail.text3"):T("ui.window.stepsOf.detail.text4")):''):T("ui.window.stepsOf.detail.text5"),time:c.time?clock(c.time):''});}
 steps.sort((a,b)=>(a.at||0)-(b.at||0));
 /* 同一个文件连着改几次，合成一行「修改 app/tools.mjs · 3 次」 */
 for(let i=steps.length-1;i>0;i--){const a=steps[i-1],b=steps[i];if(a.merge&&a.merge===b.merge&&a.state==='ok'&&b.state==='ok'){b.times=(b.times||1)+(a.times||1);b.at0=a.at0||a.at;steps.splice(i-1,1);}}
 for(const x of steps)if(x.times>1)x.title+=T("ui.window.stepsOf.text2",{"times":x.times});
 if(t.last_checkpoint?.choice)steps.push({key:'choice:'+t.last_checkpoint.at,at:t.last_checkpoint.at,state:'ok',title:T("ui.window.stepsOf.title.text3",{"choice":t.last_checkpoint.choice}),detail:'',time:clock(t.last_checkpoint.at)});
 if(t.created_at)steps.unshift({key:'start:'+t.task_id,at:t.created_at,state:'ok',title:T("ui.window.stepsOf.title.text4"),detail:T("ui.window.stepsOf.detail.text8",{"value":t.mode==='full'?T("ui.window.stepsOf.detail.text6"):T("ui.window.stepsOf.detail.text7")}),time:clock(t.created_at)});
 return steps;
}

/* ---------- 共用片段 ---------- */
/* 界面大小：和别的 Mac 软件一样用 ⌘+ ⌘− ⌘0（菜单「显示」），原生把 WKWebView 的 pageZoom 设成 100% / 112.5% / 125%（默认）/ 137.5% / 150%。
   都是 1/8 的倍数：网点间距 8–24 点在 Retina 上都落在整像素上，网点、卡片边、鼠标亮点才对得齐（110%、120% 会落在半像素上，越往右越错开）。
   原生改完调 window.showZoom(倍数)，这里提示一句，抽屉的圆角也跟着换算（--ui-zoom）。 */
window.showZoom=factor=>{const n=Number(factor);if(Number.isFinite(n)&&n>0){setRootNumber('--ui-zoom',n);toast(T("ui.window.common.text",{"value":Math.round(n*1000)/10}));}};
const dotJoin=parts=>parts.filter(Boolean).reduce((a,p)=>a?a+(a.endsWith('」')?'· ':' · ')+p:p,'');
const sw=(id,on,label)=>`<button data-k="sw-${id}" class="switch" role="switch" type="button" data-toggle="${id}" aria-checked="${!!on}" aria-label="${E(label)}"></button>`;
const tag=s=>s?`<span class="tag">${E(s)}</span>`:'';
function diffCount(before,after){const a=new Map();for(const l of before.split('\n'))a.set(l,(a.get(l)||0)+1);let add=0,del=0;for(const l of after.split('\n')){const n=a.get(l)||0;if(n)a.set(l,n-1);else add++;}for(const n of a.values())del+=n;return {add,del};}
const plain=html=>{const template=document.createElement('template');template.innerHTML=html;return template.content.textContent||'';};
const kvRow=(k,v,act='')=>`<div class="kvr" data-k="kv-${E(k)}"><span class="k">${E(k)}</span><span class="v" title="${E(plain(v))}">${v}</span>${act}</div>`;   // v 是已经转义过的 HTML
/* 10/5 Ken：「回到对话」「改关联」和「检查更新」一个样子（带描边、带底色的小按钮），不再用无边的 ghost */
function conversationLink(t,style='sm'){const url=t?.group?.conversation_url;return url?ibtn('i-external',T("ui.window.conversationLink.text"),'openChatURL',url,style):`<span class="hint">${E(chatTitle(t||{})||T("ui.window.conversationLink.text2"))}</span>`;}
// 1081（Claude，Ken 10/27 11:39、12:18）：只出按钮，放在任务详情「来自」那行、对话名下面；对话名和「自动关联」由那行自己写，不在按钮前面再写一遍。
function conversationActions(t){if(isRefreshTask(t))return '';return t.group?.conversation_url?`${conversationLink(t)}${btn(T("ui.window.conversationActions.text2"),'bindTask',t.task_id,'sm')}`:btn(T("ui.window.conversationActions.text3"),'bindTask',t.task_id,'sm');}
function statusWords(t){return {run:T("ui.window.timelineResult.text"),wait:T("ui.window.statusWords.wait.text"),ok:T("ui.window.statusWords.ok.text"),fail:T("ui.window.statusWords.fail.text"),stop:(t.status==='superseded'||t.end_reason==='superseded')?T("ui.window.statusWords.stop.text"):t.end_reason==='idle'?T("ui.window.statusWords.stop.text2"):t.status==='expired'?T("ui.window.statusWords.stop.text3"):t.status==='revoked'?T("ui.window.statusWords.stop.text4"):t.status==='paused'?T("ui.window.statusWords.stop.text5"):t.status==='connection_lost'?T("ui.window.statusWords.stop.text6"):t.status==='permission_changed'?T("ui.window.statusWords.stop.text7"):t.status==='workspace_changed'?T("ui.window.statusWords.stop.text8"):T("ui.window.statusWords.stop.text9")}[kind(t)];}
/* 1021：成果（待办二十）。这个任务新建或改过、还在的文件排成一行；悬停出「打开」「在访达中显示」，双击打开；
   都在一个文件夹里时给「打开文件夹」。只给 ChatHand 记录过的路径，原生那边会再核对一遍。 */
/* 「去刷新工具」打开的页：网页版 ChatGPT 的插件页（1028 起直接开这个地址；原来的 #settings/Connectors 要先进首页再跳过来）。
   ChatHand 自己刷新时点进过 ChatHand 那一页的，直接开那一页（tools_refresh.detail_url）。 */
const REFRESH_TOOLS_URL='https://chatgpt.com/settings/plugins-settings';
function refreshToolsURL(){const u=S.tools_refresh?.detail_url;return typeof u==='string'&&u.startsWith(REFRESH_TOOLS_URL+'/')?u:REFRESH_TOOLS_URL;}
/* 1023：「刷新工具」在哪的示意图（照 ChatGPT 插件页 → ChatHand 那一页最下面的「管理应用」重绘，去掉中间的空白，压紧）。
   16:9，viewBox 320×180，跟着气泡宽度等比缩放；颜色全用 token，深浅色都对。要点的那一格用橙圈标出来。 */
function refreshToolsFigure(){
 const rows=[[T("ui.window.refreshToolsFigure.text"),T("ui.window.refreshToolsFigure.text2")],[T("ui.window.refreshToolsFigure.text3"),T("ui.window.refreshToolsFigure.text2")],[T("ui.window.refreshToolsFigure.text4"),T("ui.window.refreshToolsFigure.text4")],[T("ui.window.refreshToolsFigure.text5"),T("ui.window.refreshToolsFigure.text5")]],top=50,h=31;
 const row=([l,r],i)=>{const y=top+i*h,mid=y+h/2+4,hit=i===2,sep=i?`<line class="rt-sep" x1="22" x2="298" y1="${y}" y2="${y}"/>`:'';
  const right=i===3?`<rect class="rt-pill" x="238" y="${y+7}" width="60" height="17" rx="8.5"/><text class="rt-mute" x="268" y="${mid}" text-anchor="middle">${r}</text>`:hit?`<rect class="rt-hit" x="236" y="${y+4}" width="66" height="23" rx="11.5"/><text class="rt-hit-t" x="269" y="${mid}" text-anchor="middle">${r}</text>`:`<text class="rt-mute" x="298" y="${mid}" text-anchor="end">${r}</text>`;
  return `${sep}<text class="rt-label" x="22" y="${mid}">${l}</text>${right}`;};
 return ("<svg class=\"rt-fig\" viewBox=\"0 0 320 180\" role=\"img\" aria-label=\""+(TH("ui.window.refreshToolsFigure.label"))+"\"><rect class=\"rt-bg\" x=\"0\" y=\"0\" width=\"320\" height=\"180\" rx=\"10\"/><text class=\"rt-path\" x=\"12\" y=\"20\">"+(TH("ui.window.refreshToolsFigure.text6"))+"</text><text class=\"rt-title\" x=\"12\" y=\"41\">"+(TH("ui.window.refreshToolsFigure.text7"))+"</text><rect class=\"rt-card\" x=\"10.5\" y=\""+(top-0.5)+"\" width=\"299\" height=\""+(h*4+1)+"\" rx=\"10\"/>"+(rows.map(row).join(''))+"<path class=\"rt-cursor\" d=\"M290 128 l0 15 l4 -4 l3 6 l2.5 -1.2 l-3 -5.8 l5.5 0 z\"/></svg>");}
const OUT_TOOLS=new Set(['write_file','write_text','edit_file','create_directory','move_file','move_path','rename_file','copy_file','restore_file','restore_trash']);
function outputsOf(t){const seen=new Map(),list=(changeCache.get(t.task_id)?.changes||[]).slice().sort((a,b)=>(a.time||0)-(b.time||0));for(const c of list){if(c.status==='applied'&&c.tool==='save_files'&&Array.isArray(c.files)){for(const f of c.files){seen.delete(f.path);seen.set(f.path,{...f,dir:false,tool:c.tool,directory:c.directory,task_folder:c.task_folder});}continue;}if(c.status!=='applied'||!OUT_TOOLS.has(c.tool))continue;const p=c.destination||c.path;if(!p)continue;seen.delete(p);seen.set(p,{path:p,dir:c.tool==='create_directory',tool:c.tool});}
 for(const c of list)if(c.status==='applied'&&['delete_file','trash_path','move_file','move_path'].includes(c.tool)&&c.path&&c.path!==(c.destination||''))seen.delete(c.path);
 return [...seen.values()].reverse();}
function outDir(p){const i=String(p).lastIndexOf('/');return i>0?String(p).slice(0,i):'';}
function outIcon(o){return o.dir?'i-folder':'i-file';}
const artifactThumbCache=new Map();let artifactThumbRevision=0;
function artifactThumb(t,o){
 if(!o.image||!o.sha256||!S.enabled)return icon(outIcon(o),'sm lead');
 const key=[S.project?.id,S.project?.path,S.mode,S.enabled,t.task_id,o.path,o.sha256].join('\0');let cached=artifactThumbCache.get(key);
 if(!cached){cached={status:'loading'};artifactThumbCache.set(key,cached);while(artifactThumbCache.size>80)artifactThumbCache.delete(artifactThumbCache.keys().next().value);
  void api('/api/artifacts/thumbnail',{task_id:t.task_id,path:o.path}).then(r=>{if(r.available&&r.mime_type==='image/png'&&typeof r.data_base64==='string'&&r.data_base64.length<=512*1024&&/^[A-Za-z0-9+/]+={0,2}$/.test(r.data_base64)){cached.url='data:image/png;base64,'+r.data_base64;cached.status='ready';}else cached.status='icon';}).catch(()=>{cached.status='icon';}).finally(()=>{artifactThumbRevision++;scheduleRender();});
 }
 return cached.status==='ready'?`<img class="out-thumb" src="${cached.url}" alt="" width="24" height="24" loading="lazy" decoding="async">`:icon(outIcon(o),'sm lead');
}

function outputNameHTML(path){const name=String(path).split('/').filter(Boolean).pop()||String(path),parts=Array.from(name);if(parts.length<=24)return `<span class="output-name">${E(name)}</span>`;const split=Math.max(1,parts.length-12);return `<span class="output-name split"><span>${E(parts.slice(0,split).join(''))}</span><span>${E(parts.slice(split).join(''))}</span></span>`;}
function outputsPanel(t){const all=outputsOf(t);if(!all.length)return '';const shown=all.slice(0,5),more=all.length-shown.length;
 return ("<section class=\"task-outputs\" data-k=\"task-outputs-"+(E(t.task_id))+"\" aria-label=\""+(TH("ui.window.outputsPanel.label4"))+"\"><h4>"+(TH("ui.window.outputsPanel.text2",{"length":all.length}))+"</h4><div class=\"task-output-list\">"+(shown.map(o=>{const name=String(o.path).split('/').filter(Boolean).pop()||o.path;return ("<div class=\"task-output\" data-k=\"task-output-"+(E(t.task_id))+"-"+(E(o.path))+"\" title=\""+(E(homePath(o.path)))+"\" role=\"button\" tabindex=\"0\" data-action=\"openTaskFile\" data-id=\""+(E(t.task_id))+"\" data-path=\""+(E(o.path))+"\" aria-label=\""+(TH("ui.window.outputsPanel.label",{"name":E(name),"homePath":E(homePath(o.path))}))+"\">"+(icon(outIcon(o),'sm'))+(outputNameHTML(o.path))+"<button class=\"output-reveal\" type=\"button\" data-action=\"revealTaskFile\" data-id=\""+(E(t.task_id))+"\" data-path=\""+(E(o.path))+"\" aria-label=\""+(TH("ui.window.outputsPanel.label2",{"name":E(name)}))+"\" title=\""+(TH("ui.window.outputsPanel.label3"))+"\">"+(icon('i-folder','sm'))+"</button></div>");}).join(''))+"</div>"+(more?("<button class=\"tbtn output-more\" type=\"button\" data-action=\"openTask\" data-id=\""+(E(t.task_id))+"\">"+(TH("ui.window.outputsPanel.text",{"more":more}))+"</button>"):'')+"</section>");
}
function taskContent(t){const outputs=outputsPanel(t);return `<div class="task-content${outputs?' has-outputs':''}">${tl(t,{limit:6})}${outputs}</div>`;}
/* 两栏只在真实溢出时渐隐。渲染后有限校准；尺寸变化观察内容本身，
   也覆盖容器 clientHeight 不变但内容 scrollHeight 改变的字体/换行。 */
const clipSelector='.task-content>.tl-link,.task-output-list';
const clipNodes=new Map(),clipPending=new Set(),clipBound=new WeakSet();
let clipFrame=0,clipSettled=0;
function measureClip(el){if(el.isConnected)el.classList.toggle('fade',el.scrollHeight>el.clientHeight+1);}
function queueClip(el){if(!el?.isConnected)return;clipPending.add(el);if(!clipFrame)clipFrame=requestAnimationFrame(()=>{clipFrame=0;for(const node of clipPending)measureClip(node);clipPending.clear();});}
let clipObserver=null,clipFontsBound=false;
function ensureClipObserver(){
 if(!clipObserver)clipObserver=new ResizeObserver(entries=>{for(const entry of entries)queueClip(clipNodes.get(entry.target));});
 if(!clipFontsBound){clipFontsBound=true;document.fonts?.ready.then(()=>{for(const el of document.querySelectorAll(clipSelector))queueClip(el);});}
}
function clipFade(root=document){
 ensureClipObserver();
 for(const [node,owner] of clipNodes)if(!node.isConnected||!owner.isConnected||node!==owner&&node.parentElement!==owner){clipObserver.unobserve(node);clipNodes.delete(node);}
 for(const el of root.querySelectorAll(clipSelector)){
  for(const node of [el,...el.children])if(!clipNodes.has(node)){clipNodes.set(node,el);clipObserver.observe(node);}
  if(!clipBound.has(el)){clipBound.add(el);el.addEventListener('animationend',()=>queueClip(el));}
  queueClip(el);
 }
 // onceAnimation has a 400ms cleanup fallback; this single delayed check also
 // covers transient visual overflow when the layout boxes themselves did not resize.
 clearTimeout(clipSettled);clipSettled=setTimeout(()=>{clipSettled=0;for(const el of document.querySelectorAll(clipSelector))queueClip(el);},450);
}
function outputsRow(t,{limit=6}={}){const all=outputsOf(t);if(!all.length)return '';const files=all.filter(o=>!o.dir),dirs=new Set(files.map(o=>outDir(o.path))),common=files.length>1&&dirs.size===1?[...dirs][0]:files.length>1&&files.every(o=>o.directory)&&new Set(files.map(o=>o.task_folder||outDir(o.directory))).size===1?(files[0].task_folder||outDir(files[0].directory)):'';const shown=all.slice(0,limit),more=all.length-shown.length;
 return ("<div class=\"outs\" data-k=\"outs-"+(E(t.task_id))+"\">"+(TH("ui.window.outputsRow.text2",{"openSpan":("<span class=\"outs-h\">"),"closeSpan":("</span>")}))+"<div class=\"outs-l\">"+(shown.map((o,i)=>{const name=String(o.path).split('/').filter(Boolean).pop()||o.path;return ("<div class=\"out"+(o.dir?' dir':'')+"\" data-k=\"out-"+(E(t.task_id))+"-"+(i)+"\" data-tip=\""+(E(homePath(o.path)))+"\" role=\"button\" tabindex=\"0\" data-action=\"openTaskFile\" data-id=\""+(E(t.task_id))+"\" data-path=\""+(E(o.path))+"\" aria-label=\""+(TH("ui.window.outputsRow.label",{"name":E(name)}))+"\">"+(artifactThumb(t,o))+(("<span>"))+(E(name))+(("</span>"))+(("<span class=\"out-acts\">"))+"<button type=\"button\" data-action=\"revealTaskFile\" data-id=\""+(E(t.task_id))+"\" data-path=\""+(E(o.path))+"\" aria-label=\""+(TH("ui.window.outputsPanel.label2",{"name":E(name)}))+"\" data-tip=\""+(TH("ui.window.outputsPanel.label3"))+"\">"+(icon('i-folder','xs'))+"</button>"+(("</span>"))+"</div>");}).join(''))+(more?`<button class="out more" type="button" data-action="openTask" data-id="${E(t.task_id)}">+${more}</button>`:'')+"</div>"+(common?("<button class=\"tbtn outs-dir\" type=\"button\" data-action=\"revealTaskFile\" data-id=\""+(E(t.task_id))+"\" data-path=\""+(E(common))+"\">"+(TH("ui.window.outputsRow.text"))+"</button>"):'')+"</div>");}
/* 时间线：1021 起最新的在上面（Ken 10/6 定），最多 limit 步（0 = 全部），更早的折成最底下一行 */
function tl(t,{limit=4}={}){const held=paused()&&t.status!=='installing';let s=stepsOf(t,{human:!!limit});const more=limit&&s.length>limit?s.length-limit:0;if(more)s=s.slice(-limit);s=s.slice().reverse();
 const thinking=active(t)&&taskState(t).key==='run'&&!s.some(x=>x.state==='run')?nowRow(t):null;
 const node=x=>held&&x.state==='run'?((TH("ui.window.tl.text",{"openSpan":("<span class=\"nd-label\">"),"closeSpan":("</span>")}))):x.state==='ok'?`<span class="nd ok">${icon('i-check','xs')}</span>`:x.state==='run'?'<span class="nd run" aria-hidden="true"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="9.5"/></svg></span>':x.state==='fail'?`<span class="nd fail">${icon('i-x','xs')}</span>`:x.state==='idle'?'<span class="nd idle" aria-hidden="true"><i class="h"></i><i class="m"></i></span>':'<span class="nd"></span>';
 const li=x=>`<li data-k="${E(x.key||x.state+':'+t.task_id)}" class="${x.state}"><span class="tl-n">${node(x)}</span><div class="tl-b"><b title="${E(x.tip||x.title)}">${E(x.title)}</b>${x.detailHtml?`<small title="${E(htmlText(x.detailHtml))}">${x.detailHtml}</small>`:x.detail?`<small title="${E(x.detail)}">${E(x.detail)}</small>`:''}</div><span class="tl-tm${x.state==='run'?' run':''}">${x.state==='run'&&!held?timed(x.at,'dur',x.time):E(x.time||'')}</span></li>`;
 const list=`<ol class="tl">${thinking?li(thinking):''}${s.map(li).join('')}${more?("<li class=\"tl-more\">"+(("<span class=\"tl-n\">"))+(("<span class=\"nd ok\">"))+(icon('i-check','xs'))+(("</span>"))+(("</span>"))+"<div class=\"tl-b\">"+(TH("ui.window.tl.text2",{"openSpan":("<span class=\"tl-more-t\">"),"more":more,"closeSpan":("</span>")}))+"</div>"+(("<span>"))+(("</span>"))+"</li>"):''}</ol>`;
 /* 1026：首页这块时间线整块都能点，点了打开任务的全部过程（Ken 10/7：别只让「更早的 N 步」能点）；抽屉里（limit=0）就是全部，不用再点。 */
 return limit?("<div class=\"tl-link\" role=\"button\" tabindex=\"0\" data-action=\"openTask\" data-id=\""+(E(t.task_id))+"\" aria-label=\""+(TH("ui.window.tl.label"))+"\">"+(list)+"</div>"):list;}

/* ---------- 状态：开关 = 许不许 AI 用；结果 = 现在能不能用；tag = 首页那一行名字后面的小标 ---------- */
function upgrading(){return S?.upgrade_pending===true&&S?.update?.install?.state==='verifying';}
function paused(){return S.enabled===false||S.settings?.access_enabled===false||S.connection?.status==='paused';}
// 0010（Claude）：「已暂停」分两种。用户自己点的暂停，存在 settings.access_enabled=false 里，要用户点「恢复」。
// 连接断了、等过了宽限时间，后台只把执行关掉（不存盘），连回来它自己会打开；这时点「恢复」没用（总待办第 57 条，Ken 主力机）。
// 后一种不再写「已暂停」+「恢复」，写「连接断了」+「重新连接」。
function userPaused(){return S.settings?.access_enabled===false||S.connection?.status==='paused';}
function linkHeld(){return !userPaused()&&S.enabled===false&&connState()!=='online';}
function cloud(){return S.connection?.control_plane||{};}
function secAgo(ms){if(!ms)return '';const s=Math.max(0,Math.round((Date.now()-ms)/1000));if(s<60)return T("ui.window.secAgo.text",{"s":s});const m=Math.round(s/60);return m<60?T("ui.window.secAgo.text2",{"m":m}):ago(ms);}
const scopeFull=()=>S.mode==='full';
const capOn=k=>S.settings?.[k]!==false;                       // terminal_enabled / browser_enabled / desktop_enabled，默认开
function homePath(p){return String(p||'').replace(/^\/Users\/[^/]+/,'~');}
function midText(t,n=30){t=String(t||'');if(t.length<=n)return t;const k=Math.floor((n-1)/2);return t.slice(0,k)+'…'+t.slice(t.length-(n-1-k));}
function browserState(){const ext=S.automation?.browser?.extension||{};if(ext.connection_state==='connected'||browserOn())return 'connected';if(ext.distribution==='chrome_web_store')return ext.installed===true||ext.last_seen?'down':'none';return ext.connection_state==='disconnected'||ext.last_seen?'down':'none';}
// 九条高危命令的名称、作用、危害只有一份，在服务端（app/v1/high-risk.mjs），聊天、命令设置页、确认框、等你处理都用它。
function riskList(){return S?.high_risk?.items||S?.high_risk_catalog||[];}
const risksOn=()=>riskList().filter(r=>r.group==='danger'&&S.settings?.high_risk?.[r.id]===true);
function adminNeedsSetup(){return [...(S.high_risk?.items||[]),...(S.permissions?.high_risk||[])].some(r=>r.id==='admin'&&r.needs_setup);}
function runningCount(){return allTasks().filter(active).length;}
function stopNote(){const n=runningCount();return n?T("ui.window.stopNote.text",{"n":n}):'';}
/* 首页「完整 | 轻量」只显示这两档（Ken 10/16）：开到完整及以上（另开高危项也算）显示完整，其余都显示轻量，不再显示自定义。
   切换仍走原来的确认和 /api/permissions/tier。 */
function shownTier(){const hr=S.settings?.high_risk||{};if(S.permissions?.tier==='full')return 'full';return scopeFull()&&capOn('terminal_enabled')&&capOn('browser_enabled')&&capOn('desktop_enabled')&&hr.autostart&&hr.admin?'full':'light';}
/* 1057（Claude，10/17。Ken：命令、桌面这两行跟别的一样，开关一直在，不在行里写「用不了」「不支持」）：
   状态里没带 capabilities 时不当成开不了，只有明确是 false 才算；真开不了时开关关着，点开关弹框说为什么、怎么办（explainUnsupported）。 */
function capTerminal(){const sup=S.capabilities?.terminal!==false,on=capOn('terminal_enabled'),full=scopeFull(),n=risksOn().length;
 if(!sup)return {sup,on:false,ok:false,tag:'',res:T("ui.window.capTerminal.res.text"),sub:T("ui.window.capTerminal.sub.text")};
 if(!on)return {sup,on,ok:false,tag:'',res:T("ui.window.capTerminal.res.text2"),sub:T("ui.window.capTerminal.sub.text2")};
 /* 1025：管理员权限失效（多半是更新或系统更新清掉的）时，主页这一行也要标出来，不能只藏在二级页里（Ken 10/7）。 */
 if(adminNeedsSetup())return {sup,on,ok:false,tag:T("ui.window.capTerminal.tag.text"),res:T("ui.window.capTerminal.res.text3"),sub:T("ui.window.capTerminal.sub.text3")};
 return {sup,on,ok:true,tag:full&&n?T("ui.window.capTerminal.tag.text2",{"n":n}):'',res:T("ui.window.capTerminal.res.text4"),sub:T("ui.window.capTerminal.sub.text4")};}
function capBrowser(){const on=capOn('browser_enabled'),bs=browserState(),ext=S.automation?.browser?.extension||{},h=ext.helper||{},v=S.automation?.browser?.personal?.chrome?.version;
 if(!on)return {on,ok:false,tag:'',res:T("ui.window.capBrowser.res.text"),sub:T("ui.window.capTerminal.sub.text2")};
 if(ext.host_registration?.status==='failed')return {on,ok:false,tag:T("ui.window.capBrowser.tag.text"),res:T("ui.window.capBrowser.res.text2"),note:T("ui.window.capBrowser.res.hostHint"),sub:T("ui.window.capBrowser.res.text2"),act:[T("ui.window.capBrowser.act.text"),'browserReconnect']};
 if(ext.distribution==='chrome_web_store'&&ext.configuration_state==='pending')return {on,ok:false,tag:T("ui.chrome.store.tagPending"),res:T("ui.chrome.store.resPending"),sub:T("ui.chrome.store.resPending")};
 // 1081（Claude，Ken 10/27 10:03）：插件旧到用不了（应用店第一版就有的动作或必需能力都缺）才停下，像强更一样说要更新；
 // 只缺后来加的动作（partial）照常用，首页不提示，「浏览器控制」页的插件版本那行写一句有新版（app/v1/chrome-store-contract.mjs）。
 if(ext.distribution==='chrome_web_store'&&bs==='connected'&&ext.compatibility?.state==='incompatible')return {on,ok:false,tag:T("ui.chrome.store.tagMismatch"),res:T("ui.chrome.store.resOld"),note:T("ui.chrome.store.oldText"),sub:T("ui.chrome.store.resOld"),act:[T("ui.chrome.store.openPage"),'chromeStoreOpen']};
 if(helperNeedsHand(h)){const old=h.state==='wrong_folder';return {on,ok:false,tag:old?T("ui.window.capBrowser.tag.oldCopy"):T("ui.window.capBrowser.tag.text2"),res:old?T("ui.window.capBrowser.res.text3"):T("ui.window.capBrowser.res.text4"),note:h.message||'',sub:old?T("ui.window.capBrowser.sub.oldCopy"):T("ui.window.capBrowser.sub.text"),...(extRepairUnsupported?{}:{act:[T("ui.window.extGuide.autoReplace"),'extensionRepair']})};}
 if(bs==='connected')return {on,ok:true,tag:'',res:T("ui.window.capBrowser.res.text5"),note:['reloading','stale'].includes(h.state)?T("ui.window.capBrowser.note.text"):T(h.build?(v?"ui.window.capBrowser.connectedBuildChrome":"ui.window.capBrowser.connectedBuild"):(v?"ui.window.capBrowser.connectedChrome":"ui.window.capBrowser.connected"),{build:h.build,chrome:v}),sub:T("ui.window.capBrowser.res.text5")};
 // 1081（Claude，Ken 10/27、ChatGPT 复查 D06）：应用店装的插件没连上，Chrome 只是没开的话这里什么都不说，照常显示；
 // AI 要用浏览器时 ChatHand 自己把 Chrome 打开（app/v09/extension-browser.mjs）。只有真出了问题才报，按原因只给一个按钮：
 // 打开了 Chrome 插件还是没连上（插件被关掉或删了），点「打开插件页面」；这台 Mac 上打不开 Chrome，点「下载 Chrome」。
 if(bs==='down'&&ext.distribution==='chrome_web_store'){const trouble=storeTrouble(ext);
  if(trouble==='noChrome')return {on,ok:false,tag:T("ui.window.capBrowser.noChrome.tag"),res:T("ui.window.capBrowser.noChrome.res"),sub:T("ui.window.capBrowser.noChrome.res"),act:[T("ui.window.showChromeInstall.text8"),'chromeUpdate']};
  // 1081（Claude，Ken 10/27 10:07）：正在连和连不上是二选一。点了「再试一次」只显示「正在连接…」，不写做法；
  // 连不上才写原因和做法，「插件被关掉了」「插件被删了」各占一行，按钮「打开插件页面」「再试一次」。
  if(browserRetrying)return {on,ok:false,spin:true,tag:'',res:T("ui.window.capBrowser.connecting"),sub:T("ui.window.capBrowser.connecting")};
  if(trouble==='wakeFailed')return {on,ok:false,tag:T("ui.window.capBrowser.wakeFailed.tag"),res:T("ui.window.capBrowser.wakeFailed.res"),notes:[T("ui.window.capBrowser.wakeFailed.off"),T("ui.window.capBrowser.wakeFailed.gone")],sub:T("ui.window.capBrowser.wakeFailed.res"),acts:[[T("ui.chrome.store.openPage"),'chromeStoreReconnect'],[T("ui.wizard.retry"),'browserRetry']]};
  return {on,ok:true,tag:'',res:T("ui.window.capBrowser.res.text5"),sub:T("ui.window.capBrowser.res.text5")};}
 if(bs==='down')return {on,ok:false,tag:T("ui.window.capBrowser.tag.text3"),res:T("ui.window.capBrowser.res.text6"),sub:T("ui.window.capBrowser.sub.text2"),act:[T("ui.window.capBrowser.act.text"),'browserReconnect']};
 return {on,ok:false,tag:T("ui.window.capBrowser.tag.text4"),res:T("ui.window.capBrowser.res.text7"),sub:T("ui.window.capBrowser.sub.text3"),act:[T("ui.window.capBrowser.act.text2"),'extensionSetup']};}
// 1081（Claude，Ken 10/27）：应用店装的插件没连上时，哪种算真出了问题（插件那边记的 wake，见 app/v09/extension-browser.mjs）。
// 'noChrome' 这台 Mac 上打不开 Chrome（或者没装，跟装插件那个框一样只在 Mac 上看）；'wakeFailed' ChatHand 打开了 Chrome，插件还是没连上；'' 只是 Chrome 没开，不算。
function storeTrouble(ext){const w=ext?.wake||{},c=(S?.platform||'darwin')==='darwin'?S?.automation?.browser?.personal?.chrome||{}:{};return w.chrome_open_failed===true||c.installed===false?'noChrome':w.connected===false?'wakeFailed':'';}
function capDesktop(){const d=desktopState(),on=capOn('desktop_enabled'),p=perms(),missing=[!p.accessibility&&T("ui.window.capDesktop.text"),!p.screen_recording&&T("ui.window.capDesktop.text2")].filter(Boolean).join('、');
 if(d==='unsupported'||p.supported===false)return {sup:false,on:false,ok:false,tag:'',res:T("ui.window.capDesktop.res.text"),sub:T("ui.window.capTerminal.sub.text")};
 if(!on)return {sup:true,on,ok:false,tag:'',res:T("ui.window.capDesktop.res.text2"),sub:T("ui.window.capTerminal.sub.text2")};
 if(p.needs_restart)return {sup:true,on,ok:false,tag:T("ui.window.capDesktop.tag.text"),res:T("ui.window.capDesktop.res.text3"),sub:T("ui.window.capDesktop.sub.text"),act:[T("ui.window.capDesktop.act.text"),'restartAfterPermissions']};
 if(d==='on')return {sup:true,on,ok:true,tag:'',res:T("ui.window.capDesktop.res.text4"),note:T("ui.window.capDesktop.note.text"),sub:T("ui.window.capDesktop.res.text4")};
 return {sup:true,on,ok:false,tag:T("ui.window.capDesktop.tag.text2"),res:T("ui.window.capDesktop.res.text5",{"missing":missing}),sub:T("ui.window.capDesktop.res.text5",{"missing":missing}),act:[T("ui.window.capDesktop.act.text2"),'computerPermissions']};}
/* ChatGPT 连接卡：只说人话。云端几秒前、走不走代理这些技术信息在「帮助与反馈 › 技术信息」 */
function offlineReason(){const cp=cloud(),a=S.connection?.automatic||{},r=S.repair;
 const left=r?.status==='done'&&(r.items||[]).find(i=>i.status==='action'||i.status==='failed');if(left?.message)return left.message;
 if(a.phase==='needs_login'||a.error_code==='CONNECTION_AUTH_FAILED')return T("ui.window.offlineReason.text");
 if(cp.proxy==='direct')return T("ui.window.offlineReason.text2");
 if(cp.state==='down')return T("ui.window.offlineReason.text3");
 if(!cp.state&&(a.phase==='idle'||a.phase==='stopped'))return T("ui.window.offlineReason.text4");
 return T("ui.window.offlineReason.text5");}
// 1069（Claude）：Site 被拦住、被改连走时那一句，首页卡片、连接页、任务列表顶上那条都用这一句。
function siteBlockText(blocked){return blocked?.kind==='replaced'?(blocked.device?T("ui.window.siteBlock.replaced",{"device":blocked.device}):T("ui.window.siteBlock.replacedUnnamed")):T("ui.window.siteBlock.challenge");}
function connModel(){const st=connState(),site=selectedConnection()==='site',lc=routeLastCall(site?'site':'openai'),called=lc?T("ui.window.connModel.text",{"timed":timed(lc.time,'ago',ago(lc.time))}):'',blocked=siteBlock();
 // 1081（Claude，Ken 10/27 10:18）：正在装新版只写这一句，不再补「装好以后会自己连上」。
 if(upgrading())return {st:'connecting',dot:'spin',label:T("ui.window.connModel.label.text"),sub:'',left:'',right:''};
 if(linkHeld())return connState()==='connecting'?{st:'connecting',dot:'spin',label:T("ui.window.connModel.held.connecting"),sub:T("ui.window.connModel.held.connectingSub"),left:called,right:''}:{st:'paused',dot:'cloud-down',label:T("ui.window.connModel.held.label"),sub:T("ui.window.connModel.held.sub"),left:called,right:btn(T("ui.window.capBrowser.act.text"),'restoreSaved','','sm primary')};
 if(paused())return {st:'paused',dot:'',label:T("ui.window.connModel.label.text2"),sub:T("ui.window.connModel.sub.text2"),left:called,right:btn(T("ui.window.action.resumeAI.button"),'resumeAI','','sm primary')};
 // 1069 A4/A5（Claude）：被别的电脑改连走了：「新建一个 Site」「改用 OpenAI 通道」；被网络验证拦住：「改用 OpenAI 通道」。
 // 网络验证那条只在上次成功以后的请求全被拦时才有（下一次成功就清掉），健康检查可能还没过期，照样写「连不上」，不写「已连接」。
 if(blocked?.kind==='replaced')return {st:'offline',dot:'warn',label:T("ui.window.connModel.label.text6"),sub:siteBlockText(blocked),left:tbtn(T("ui.window.siteBlock.newSite"),'newSite'),right:btn(T("ui.window.siteBlock.useOpenAI"),'useOpenAI','','sm primary')};
 if(blocked?.kind==='challenge')return {st:'offline',dot:'warn',label:T("ui.window.connModel.label.text6"),sub:siteBlockText(blocked),left:called,right:btn(T("ui.window.siteBlock.useOpenAI"),'useOpenAI','','sm primary')};
 // 0012（Claude）：连接是好的，但 ChatGPT 里没有这台的应用了。不再写「已连接」，标出来，按钮直接去加回去。
 if(st==='online'&&appMissing())return {st,dot:'warn',label:appUnbound()?T("ui.window.appMissing.unbound.cardLabel"):T("ui.window.appMissing.cardLabel"),sub:appUnbound()?T("ui.window.appMissing.unbound.cardSub"):T("ui.window.appMissing.cardSub"),left:'',right:btn(appUnbound()?T("ui.window.appMissing.unbound.fix"):T("ui.window.appMissing.fix"),'appMissing','','sm primary')};
 if(!site&&!S.relay?.online&&S.connection?.display){const d=S.connection.display;return {st,dot:({green:'ok',yellow:'cloud-wait',red:'cloud-down'})[d.tone]||'',label:d.title,sub:d.detail||d.title,left:d.last_confirmed_at?timed(d.last_confirmed_at,'ago',confirmedAgo(d.last_confirmed_at),'','confirmation'):'',right:tbtn(T("ui.window.capBrowser.act.text"),'restoreSaved')};}
 if(st==='online')return {st,dot:'ok',label:site&&!siteTested()?T("ui.window.connModel.label.text3"):T("ui.window.connModel.label.text4"),sub:site?(siteTested()?T("ui.window.connModel.sub.text5"):T("ui.window.connModel.sub.text3")):S.relay?.online?T("ui.window.connModel.sub.text4"):T("ui.window.connModel.sub.text5"),left:called||T("ui.window.connModel.left.text2"),right:site?(siteTested()?'':btn(T("ui.window.conn.untestedAct"),'testConnection','','sm primary')):tbtn(T("ui.window.capBrowser.act.text"),'restoreSaved')}; // 1069 第 6 条：Site 也写「最近调用 X 分钟前」。1081（Claude）：「查看 Site 连接」去掉（整张卡能点，点了开设置里的连接页）；Site 还没在 ChatGPT 里试过，放「去试一句」
 if(st==='connecting')return {st,dot:'spin',label:T("ui.window.connModel.label.text5"),sub:T("ui.window.connModel.sub.text6"),left:'',right:''};
 if(st==='offline')return {st,dot:'warn',label:T("ui.window.connModel.label.text6"),sub:site?T("ui.window.connModel.sub.text7"):offlineReason(),left:site?'':tbtn(T("ui.window.connModel.left.text3"),'aiBrief'),right:btn(site?T("ui.window.connModel.right.text"):T("ui.window.connModel.right.text2"),site?'openH10':'repair','','sm primary')};
 return {st,dot:'',label:T("ui.window.connModel.label.text7"),sub:site?T("ui.window.connModel.sub.text8"):T("ui.window.connModel.sub.text9"),left:'',right:btn(T("ui.window.connModel.right.text3"),'manual','','sm primary')};}
const statDot=m=>m.dot==='spin'?'<i class="sdot spin" aria-hidden="true"></i>':`<i class="sdot ${m.dot}${m.dot==='ok'?' live':''}" aria-hidden="true"></i>`;

/* ---------- 左栏：任务 ---------- */
function waitingConfirmations(){return (S.confirmations||[]).filter(c=>c.state==='waiting'&&!confirmDismissed.has(c.id));}
function confirmationForTask(t){return waitingConfirmations().find(c=>c.task_id===t.task_id);}
function confirmSettingsSection(c){return c?.gate==='scope'?'scope':c?.gate==='capability'?(c.item?.id==='browser'?'browser':c.item?.id==='desktop'?'desktop':'terminal'):c?.gate==='system_permission'?'desktop':c?.gate==='browser_helper'?'browser':'terminal';}
function armConfirmation(id){if(confirmReady.has(id)||confirmArmed.has(id))return;confirmArmed.add(id);setTimeout(()=>{confirmArmed.delete(id);confirmReady.add(id);scheduleRender();},1000);}
function setConfirmFeedback(id,text,tone='ok'){confirmErrors.delete(id);confirmFeedback.set(id,{text,tone});setTimeout(()=>{confirmFeedback.delete(id);confirmDismissed.add(id);scheduleRender();},4000);scheduleRender();}
function confirmationCard(c){
 const fb=confirmFeedback.get(c.id);if(fb)return `<div class="confirm-card compact ${fb.tone==='ok'?'ok':''}" data-confirm-id="${E(c.id)}"><span class="confirm-mark">${fb.tone==='ok'?'✓':'·'}</span><span>${E(fb.text)}</span></div>`;
 armConfirmation(c.id);const ready=confirmReady.has(c.id),mins=Math.max(1,Math.ceil((Number(c.expires_at||Date.now())-Date.now())/60000)),name=c.item?.name||T("ui.window.confirmationCard.text"),effect=c.effect||{},error=confirmErrors.get(c.id);
 const exp=((TH("ui.window.confirmationCard.text2",{"openSpan":("<span class=\"confirm-exp\">"),"mins":mins,"closeSpan":("</span>")}))),go=("<button class=\"tbtn confirm-settings\" type=\"button\" data-action=\"confirmSettings\" data-id=\""+(E(c.id))+"\">"+(TH("ui.window.confirmationCard.text3"))+"</button>");
 let acts='';
 if(!IN_APP)acts=`<div class="confirm-acts">${go}</div>`;
 else {const scopes=Array.isArray(c.scopes)?c.scopes:[],buttons=[...(scopes.includes('always')?['always']:[])].map(scope=>("<button class=\"btn sm "+(scope==='always'?'primary':'')+"\" type=\"button\" data-action=\"confirmAnswer\" data-id=\""+(E(c.id))+"\" data-scope=\""+(scope)+"\" "+(ready?'':'disabled')+">"+(TH("ui.window.confirmationCard.text4"))+"</button>")).join('');acts=("<div class=\"confirm-acts\">"+(buttons)+(("<span class=\"grow\">"))+(("</span>"))+"<button class=\"tbtn\" type=\"button\" data-action=\"confirmAnswer\" data-id=\""+(E(c.id))+"\" data-scope=\"deny\" "+(ready?'':'disabled')+">"+(TH("ui.window.confirmationCard.text5"))+"</button></div>");}
 const err=error?`<div class="confirm-error">${E(error.text)}${error.human?' · '+go:''}</div>`:'';
 return ("<div class=\"confirm-card\" data-confirm-id=\""+(E(c.id))+"\">"+(TH("ui.window.confirmationCard.text7",{"exp":exp,"openB":("<b>"),"name":E(name),"closeB":("</b>")}))+"<p>"+(TH("ui.window.confirmationCard.text8",{"value":E(c.cause||''),"value2":c.conversation_title?(" "+(TH("ui.window.confirmationCard.text6",{"openSpan":("<span class=\"confirm-from\">"),"conversation_title":E(c.conversation_title),"closeSpan":("</span>")}))):''}))+"</p><p>"+(TH("ui.window.confirmationCard.text9",{"value":E(effect.can_do||'')}))+"</p><p class=\"confirm-risk\">"+(TH("ui.window.confirmationCard.text10",{"value":E(effect.risk||'')}))+"</p>"+(err)+(acts)+"</div>");
}
function confirmationsTop(){
 const all=S.confirmations||[];for(const c of all){if(c.state==='waiting')confirmKnownWaiting.add(c.id);else if(confirmKnownWaiting.has(c.id)&&!confirmFeedback.has(c.id)&&!confirmDismissed.has(c.id)&&['expired','withdrawn'].includes(c.state)){setConfirmFeedback(c.id,c.state==='expired'?T("ui.window.confirmationsTop.text"):T("ui.window.confirmationsTop.text2"),'muted');}}
 const waiting=waitingConfirmations(),ids=new Set(waiting.map(c=>c.id)),extra=all.filter(c=>confirmFeedback.has(c.id)&&!ids.has(c.id)),items=[...waiting,...extra].slice(0,3),more=waiting.length-3;
 return items.length?`<div class="confirm-stack">${items.map(confirmationCard).join('')}${more>0?("<p class=\"confirm-more\">"+(TH("ui.window.confirmationsTop.text3",{"more":more}))+"</p>"):''}</div>`:'';
}
function blocksOf(t){return (S.blocks||[]).filter(b=>b.task_id===t.task_id&&['high_risk','admin_setup','scope','capability','never'].includes(b.kind));}
function isWaiting(t){return t.status==='pending_approval'||!!waitingOn(t)||!!confirmationForTask(t)||blocksOf(t).some(b=>b.blocked?.kind!=='can_enable');}
const waitFirst=(a,b)=>(isWaiting(b)?1:0)-(isWaiting(a)?1:0)||(b.created_at||0)-(a.created_at||0);
/* 1053 后（Claude，10/17）：「待办事项」后面等你回的条数改成小气泡（Ken 10/17：最大显示 99，再多显示三个点）；没有就不出。读屏念「待办事项，N 条等你回」。 */
function tabBadge(n){return n>0?`<span class="tab-badge${n>99?' more':''}" aria-hidden="true">${n>99?'<i></i><i></i><i></i>':n}</span>`:'';}
/* 1056 后（Claude，10/17 12:59。Ken：气泡数字和真实条数对不上）：原来只数「等你」，改成数「全部」里看得到的条数（没删、没了结），和列表对得上。 */
function matterOpenCount(){return matterRows().filter(m=>!m.deleted&&m.state!=='resolved').length;}
function colHead(){const open=matterOpenCount();return ("<div class=\"col-h\" role=\"tablist\" aria-label=\""+(TH("ui.window.colHead.label"))+"\">"+([['run',T("ui.window.colHead.text")],['done',T("ui.window.colHead.text2")],['matters',T("ui.window.colHead.text3"),open]].map(([id,l,n=0])=>`<button type="button" role="tab" data-tab="${id}" aria-selected="${tab===id}"${n>0?` class="has-badge" aria-label="${TH("ui.window.colHead.countLabel",{name:l,count:n})}"`:''}>${l}${tabBadge(n)}</button>`).join(''))+"</div>");}
function matterRows(){return Array.isArray(S.matters?.items)?S.matters.items:[];}
function matterLabel(m){return m.state==='waiting_user'?T("ui.window.matterLabel.text"):m.state==='waiting_ai'?T("ui.window.matterLabel.text2"):m.state==='resolved'?T("ui.window.matterLabel.text3"):T("ui.window.matterLabel.text4");}
function matterMatch(m,q){const words=q.toLowerCase().split(/\s+/).filter(Boolean);const searchable=[m.id,m.title,m.source?.label,m.waiting_for,m.answer].filter(Boolean).join(' ').toLowerCase();return words.every(w=>searchable.includes(w));}
/* 1052 补丁 2（Claude，10/16）：待办事项页照已完成的样子做，用同一套组件：上面一行分段 + 可收起的搜索；
   勾了至少一条才在列表上方出现批量条；行用 .rr 网格。（1053 后：状态点去掉了，勾选框一直显示，见 matterRow 上面。）
   批量写（每批 10 条、固定操作号、撤销、最近删除）不动。matterShowDeleted 跟着「最近删除」这一段走。 */
let MATTER_FILTERS=[['all',T("ui.window.matterFilters.text")],['waiting_user',T("ui.window.matterLabel.text")],['parked',T("ui.window.matterLabel.text4")],['resolved',T("ui.window.matterLabel.text3")],['deleted',T("ui.window.matterFilters.text2")]];
function matterInFilter(m,f){if(f==='deleted')return !!m.deleted;if(m.deleted)return false;return f==='all'?m.state!=='resolved':f==='parked'?!['waiting_user','waiting_ai','resolved'].includes(m.state):m.state===f;}
function matterVisible(){return matterRows().filter(m=>matterInFilter(m,matterFilter)).filter(m=>matterMatch(m,matterQuery));}
function matterTone(m){return m.state==='waiting_user'?'fail':m.state==='waiting_ai'?'ok':'stop';}
/* 1053 后 待办列表（Claude，10/17。Ken：信息效率不高，前面一大块给了状态点和编号；不知道怎么直接去处理一条；勾一堆发到对话里怎么做）：
   一、去掉状态点（后面已经写了状态）和标题前的编号（编号在悬停提示、详情标题和发给 ChatGPT 的那句话里照样有）。
   二、一行分两层：上面标题，下面「在等什么 · 来源」；状态在右边单独一列（1056 后改，见下）。
   三、勾选框一直在最前面，一看就知道能多选；勾了以后上面出批量条，「开新对话处理」放第一个。
   四、鼠标移到一行（或键盘移到「处理」）时，右边时间换成「处理」，点了直接开新对话处理这一条，不动已经勾的；最近删除里换成「恢复」。点行的其余地方照旧看详情。 */
/* 1056 后（Claude，10/17 12:59。Ken：状态单放一列，放在标题和操作中间）：状态挪到标题和时间之间单独一列（定宽、左对齐，一列竖着对齐）；
   第二行只剩「在等什么 · 来源」，在等什么和状态一字不差时不写。 */
function matterMeta(m){const why=String(m.waiting_for||'').trim();return [why&&why!==({waiting_user:'等你',waiting_ai:'AI 在做',resolved:'已了结'}[m.state]||'先放着')?why:'',m.source?.label||''].filter(Boolean).join(' · ');}
function matterRow(m){const selected=matterSelected.has(m.id),name=m.id+' '+m.title,tip=[name,m.waiting_for,m.source?.label].filter(Boolean).join(' · '),go=m.deleted?[T("ui.window.toolWords.restore_file.text"),'matterRestoreOne',T("ui.window.matterRow.text",{name})]:[T("ui.window.matterRow.text2"),'matterGo',T("ui.window.matterRow.text3",{name})],meta=matterMeta(m);
 return ("<div class=\"rr matter-row\" data-k=\"matter-"+(E(m.id))+"\"><label class=\"matter-pick\"><input type=\"checkbox\" aria-label=\""+(TH("ui.window.matterRow.label",{"name":E(name)}))+"\" data-matter-check=\""+(E(m.id))+"\""+(selected?' checked':'')+"></label><button type=\"button\" class=\"matter-open\" data-action=\"matterOpen\" data-id=\""+(E(m.id))+"\" title=\""+(E(tip))+"\">"+(("<b>"))+(E(m.title))+(("</b>"))+(meta?`<span class="mt-meta">${E(meta)}</span>`:'')+(("<span class=\"mt-st "+(matterTone(m))+"\">"))+(E(matterLabel(m)))+(("</span>"))+(("<span class=\"rr-tm\">"))+(E(when(m.updated_at)))+(("</span>"))+"</button><button type=\"button\" class=\"mt-go\" data-action=\""+(go[1])+"\" data-id=\""+(E(m.id))+"\" aria-label=\""+(E(go[2]))+"\">"+(go[0])+(m.deleted?'':icon('i-arrow-ur','xs'))+"</button></div>");}
function matterBar(rows,marked){const n=marked.length,undo=matterLastDeleted.length,trash=matterFilter==='deleted';if(!n&&!undo&&!(trash&&rows.length))return '';
 const lead=n?((TH("ui.window.matterBar.text2",{"openSpan":("<span class=\"matter-count\">"),"n":n,"closeSpan":("</span>"),"value":n<rows.length?("<button class=\"tbtn\" type=\"button\" data-action=\"matterSelectAll\">"+(TH("ui.window.matterBar.text"))+"</button>"):''}))):undo?((TH("ui.window.matterBar.text3",{"openSpan":("<span class=\"matter-count\">"),"undo":undo,"closeSpan":("</span>")}))):'',acts=(n?trash?btn(T("ui.window.toolWords.restore_file.text"),'matterBatchDelete','','sm'):btn(T("ui.window.matterBar.text4"),'matterOpenNew','','sm primary')+(matterFilter==='resolved'?'':btn(T("ui.window.matterBar.text5"),'matterResolve','','sm'))+btn(T("ui.window.toolWords.delete_file.text"),'matterBatchDelete','','sm warn'):'')+(undo?btn(T("ui.window.matterBar.text7"),'matterUndoLast','','sm'):'')+(trash&&rows.length?btn(T("ui.window.matterBar.text8"),'matterPurge','','sm warn'):'');
 // 按钮包在 .matter-acts 里：宽的时候它不占位（display:contents），整条一行；窄到放不下时按钮整组挪到第二行，「已选 N 条 · 全选 …… 取消选择」留在第一行。
 return ("<div class=\"matter-bar\" data-k=\"matter-bar\" role=\"group\" aria-label=\""+(TH("ui.window.matterBar.label"))+"\">"+(lead)+(("<span class=\"matter-acts\">"))+(acts)+(("</span>"))+(n?("<button class=\"tbtn matter-none\" type=\"button\" data-action=\"matterSelectNone\">"+(TH("ui.window.matterBar.text9"))+"</button>"):'')+"</div>");}
/* 1053 后 待办空状态（Claude，10/17）：
   一、一条都没有时，放一张和「进行中」空状态同一套的卡片（缺省图 + 一句话 + 去 ChatGPT 记一条）；连「最近删除」都空时筛选那一行也不出。
   二、有事项时，筛选行、搜索左边一个 ⓘ，点开一张小说明卡：说「记一下」→ 在这里看 → 开新对话接着做。默认不展开（Ken 10/17：空状态已经说清楚了，上面不再常驻一条横幅）。
      点外面、按 Esc、再点 ⓘ 都会收起；切标签时也收起。
   筛选、搜索为空时仍是一行小字，按筛选换成具体说法。这里的字不依赖标签名，以后改名不用动。 */
let MATTER_TRY_PROMPT=T("ui.window.matterTryPrompt.text");
function matterHelp(){const open=matterHelpOpen;
 return ((("<span class=\"mt-help\">"))+"<button class=\"done-help mt-help-btn\" type=\"button\" data-action=\"matterHelp\" aria-label=\""+(TH("ui.window.matterHelp.label"))+"\" aria-expanded=\""+(open)+"\" aria-controls=\"matterHelpPop\""+(open?'':` data-tip="${TH("ui.window.matterHelp.howToTooltip")}"`)+">"+(icon('i-info','sm'))+"</button>"+(open?("<div class=\"mt-pop\" id=\"matterHelpPop\" role=\"dialog\" tabindex=\"-1\" aria-labelledby=\"matterHelpTitle\"><h3 class=\"mt-pop-t\" id=\"matterHelpTitle\">"+(TH("ui.window.matterHelp.text2"))+"</h3><ol class=\"mt-flow\"><li>"+(TH("ui.window.matterHelp.text3",{"openB":("<b>"),"closeB":("</b>"),"openSpan":("<span>"),"closeSpan":("</span>")}))+"</li><li>"+(TH("ui.window.matterHelp.text4",{"openB":("<b>"),"closeB":("</b>"),"openSpan":("<span>"),"closeSpan":("</span>")}))+"</li><li>"+(TH("ui.window.matterHelp.text5",{"openB":("<b>"),"closeB":("</b>"),"openSpan":("<span>"),"closeSpan":("</span>")}))+"</li></ol><p class=\"mt-pop-foot\">"+(TH("ui.window.matterHelp.text6"))+"</p></div>"):'')+(("</span>")));}
function matterEmptyCard(){return ("<section data-k=\"matter-empty\" class=\"list-empty matter-empty\" aria-label=\""+(TH("ui.window.colHead.text3"))+"\"><div class=\"le-in\">"+(emptyIllustration('i-note'))+"<h3>"+(TH("ui.window.matterEmptyCard.text"))+"</h3><p>"+(TH("ui.window.matterEmptyCard.text2"))+"</p><div class=\"prompt-list\"><button class=\"prompt-pill\" data-k=\"matter-try\" type=\"button\" data-action=\"openPrompt\" data-id=\""+(E(MATTER_TRY_PROMPT))+"\" title=\""+(E(MATTER_TRY_PROMPT))+"\">"+(TH("ui.window.matterEmptyCard.text3",{"icon":icon('i-note','sm'),"openSpan":("<span>"),"closeSpan":("</span>"),"icon2":icon('i-arrow-ur','sm prompt-arrow')}))+"</button></div></div></section>");}
function matterNone(){const live=matterRows().filter(m=>!m.deleted);
 if(matterFilter==='all')return live.length?T("ui.window.matterNone.text"):T("ui.window.matterNone.text2");
 return {waiting_user:T("ui.window.matterNone.waiting_user.text"),parked:T("ui.window.matterNone.parked.text"),resolved:T("ui.window.matterNone.resolved.text"),deleted:T("ui.window.matterNone.deleted.text")}[matterFilter]||T("ui.window.matterNone.text3");}
function matterList(){if(S.matters?.available===false)return ("<p class=\"empty\">"+(TH("ui.window.matterList.text",{"value":E(S.matters.error_code||'MATTER_UNAVAILABLE')}))+"</p>");const q=matterQuery.trim(),rows=matterVisible(),marked=rows.filter(m=>matterSelected.has(m.id)),blank=!q&&matterFilter==='all'&&!matterRows().some(m=>!m.deleted),empty=q?("<p class=\"empty\">"+(TH("ui.window.matterList.text2",{"q":E(q)}))+"<button class=\"tbtn\" type=\"button\" data-action=\"clearMatterSearch\">"+(TH("ui.window.matterList.text3"))+"</button></p>"):blank?matterEmptyCard():`<p class="empty">${E(matterNone())}</p>`;
 if(blank&&!matterRows().length)return empty;
 return ("<div class=\"done-bar\"><div class=\"seg\" data-k=\"matter-seg\" role=\"group\" aria-label=\""+(TH("ui.window.matterList.label3"))+"\">"+(MATTER_FILTERS.map(([id,label])=>`<button type="button" data-matter-filter="${id}" aria-pressed="${matterFilter===id}">${label}</button>`).join(''))+"</div>"+(matterHelp())+"<label class=\"done-search"+(matterQuery||matterSearchFocus?' open':'')+"\" data-k=\"matter-search\" title=\""+(TH("ui.window.matterList.label4"))+"\">"+(icon('i-search','sm'))+"<input id=\"matterSearch\" type=\"search\" placeholder=\""+(TH("ui.window.matterList.label5"))+"\" aria-label=\""+(TH("ui.window.matterList.label5"))+"\" autocomplete=\"off\" spellcheck=\"false\" value=\""+(E(matterQuery))+"\">"+(matterQuery?("<button class=\"done-clear\" type=\"button\" data-action=\"cancelMatterSearch\" aria-label=\""+(TH("ui.window.matterList.label"))+"\" data-tip=\""+(TH("ui.window.matterList.label2"))+"\">"+(icon('i-x','xs'))+"</button>"):'')+"</label></div>"+(matterBar(rows,marked))+(rows.length?`<div class="rl all${marked.length?' picking':''}">${rows.map(matterRow).join('')}</div>`:empty));}
// 删除后「撤销删除」在批量条里留 10 秒；到点时说明框还开着、或鼠标正停在这一行上，就再等一会儿。
function armMatterUndo(){clearTimeout(matterUndoTimer);matterUndoTimer=0;if(!matterLastDeleted.length)return;const expire=()=>{if($('#modal').open||$('.matter-bar:hover')){matterUndoTimer=setTimeout(expire,4000);return;}matterUndoTimer=0;matterLastDeleted=[];render();};matterUndoTimer=setTimeout(expire,10000);}
function matterIdsToAct(){return [...matterSelected].filter(id=>matterRows().some(m=>m.id===id&&!m.deleted===!matterShowDeleted));}
function matterOpId(action,m){const key=action+':'+m.id+':'+m.revision;if(!matterOpKeys.has(key))matterOpKeys.set(key,'matter-ui-'+crypto.randomUUID());return matterOpKeys.get(key);}
// 1052 R13（Claude）：事项批量操作每批最多 10 条，按顺序发，逐条看回执。
// 撤销只含真正删掉的；没成的留着选中；某一批结果不明就停下，不换操作号重做（操作号按 动作+编号+版本 固定，重试会被认出是同一次）。
let MATTER_BATCH=10,MATTER_DONE={delete:T("ui.window.matterDone.delete.text"),restore:T("ui.window.matterDone.restore.text"),append:T("ui.window.matterDone.append.text")};
let MATTER_FAIL_WORDS={MATTER_REVISION_CONFLICT:T("ui.window.matterFailWords.matterRevisionConflict.text"),MATTER_DELETED:T("ui.window.matterFailWords.matterDeleted.text"),MATTER_NOT_DELETED:T("ui.window.matterFailWords.matterNotDeleted.text"),MATTER_MISSING:T("ui.window.matterFailWords.matterMissing.text"),OP_CONFLICT:T("ui.window.matterFailWords.opConflict.text"),MATTER_PROJECT_OWNER:T("ui.window.matterFailWords.matterProjectOwner.text"),MATTER_INVALID:T("ui.window.matterFailWords.matterInvalid.text")};
async function matterWriteBatched(action,items,prefix='matter-ui-'){const saved=[],failed=[];let unknown=[];
 for(let i=0;i<items.length;i+=MATTER_BATCH){const part=items.slice(i,i+MATTER_BATCH),entries=part.map(m=>({operation_id:matterOpId(action,m),action,id:m.id,base_revision:m.revision,...(action==='append'?{state:'resolved',waiting_for:T("ui.window.matterWriteBatched.waiting_for.text"),answer:T("ui.window.matterWriteBatched.answer.text")}:{})}));let result;
  try{result=await api('/api/matters/write',{request_id:prefix+crypto.randomUUID(),entries});}
  // 后台先整批检查再写：报 MATTER_ 开头的错就是这一批一条都没写；别的错（断网等）不知道写没写，停下不再往后发。
  catch(error){if(/^MATTER_/.test(String(error?.code||''))){for(const m of part)failed.push({id:m.id,code:error.code});continue;}unknown=[...unknown,...items.slice(i)];break;}
  part.forEach((m,k)=>{const r=result?.items?.[k];if(r&&r.id===m.id&&r.saved===true)saved.push(m.id);else if(r&&r.id===m.id)failed.push({id:m.id,code:r.error_code||'MATTER_ERROR'});else unknown.push(m);});}
 return {saved,failed,unknown};}
function matterReport(action,saved,failed,unknown,hint=T("ui.window.matterReport.text")){const done=MATTER_DONE[action]||T("ui.window.matterReport.text2");
 // 1082：删除全部成功时，列表顶上那条「已删除 N 条 · 撤销删除」已经说了结果，再弹一个提示就重复了，删除就不弹。
 if(!failed.length&&!unknown.length){if(action!=='delete')toast(T("ui.window.matterReport.text4",{"done":done,"length":saved.length,"value":''}));return;}
 const lines=failed.map(x=>x.id+'：'+(MATTER_FAIL_WORDS[x.code]||T("ui.window.matterReport.text5",{"code":x.code})));
 if(unknown.length)lines.push(T("ui.window.matterReport.text7",{"length":unknown.length,"value":unknown.slice(0,5).map(m=>m.id).join('、'),"value2":unknown.length>5?T("ui.window.matterReport.text6"):''}));
 modal(`<h2>${E(saved.length?T("ui.window.matterReport.partialTitle",{"done":done,"savedCount":saved.length,"notDoneCount":failed.length+unknown.length}):T("ui.window.matterReport.text9"))}</h2>${lines.map(t=>`<p>${E(t)}</p>`).join('')}<p>${E(hint)}</p><div class="actions">${btn(T("ui.window.matterReport.text10"),'closeModal','','sm primary')}</div>`);}
async function matterWriteSelected(action){const ids=matterIdsToAct(),items=matterRows().filter(m=>ids.includes(m.id));if(!items.length){toast(T("ui.window.matterWriteSelected.text"));return;}
 const {saved,failed,unknown}=await matterWriteBatched(action,items);
 if(action==='delete'&&saved.length)matterLastDeleted=saved.slice();else if(action==='restore')matterLastDeleted=matterLastDeleted.filter(id=>!saved.includes(id));
 matterSelected.clear();for(const x of failed)matterSelected.add(x.id);for(const m of unknown)matterSelected.add(m.id);
 await refresh();matterReport(action,saved,failed,unknown);}
// 1052 R13（Claude）：详情每段 6000 字，接着取完（最多 40 段）；取的过程中事项被改了就从头再取一次。
// 取全以后按经过一条条显示：原话（谁说的）、上下文、理解、答复、在等什么、依据、来源；解析不了就原样显示。
let MATTER_DETAIL_PAGES=40,MATTER_LONG=280,MATTER_ACTION_WORDS={create:T("ui.window.matterActionWords.create.text"),append:T("ui.window.matterActionWords.append.text"),delete:T("ui.window.toolWords.delete_file.text"),restore:T("ui.window.toolWords.restore_file.text")};
let MATTER_EVIDENCE_WORDS={user_report:T("ui.window.matterEvidenceWords.user_report.text"),source_report:T("ui.window.matterEvidenceWords.source_report.text"),screenshot:T("ui.window.matterEvidenceWords.screenshot.text"),tool_receipt:T("ui.window.matterEvidenceWords.tool_receipt.text"),independent_check:T("ui.window.matterEvidenceWords.independent_check.text"),user_close:T("ui.window.matterEvidenceWords.user_close.text")};
async function matterDetail(id,item={}){
 for(let attempt=0;attempt<2;attempt++){let text='',cursor=null,revision=null,pages=0,total=0,changed=false;
  do{const r=await api('/api/matters/query',{ids:[id],view:'detail',limit:1,...(cursor?{cursor}:{})}),it=r.items?.[0];if(!it)return ("<p>"+(TH("ui.window.matterDetail.text"))+"</p>");
   if(revision===null)revision=it.revision;else if(it.revision!==revision){changed=true;break;}
   text+=it.chunk||'';total=it.chunk_total||text.length;cursor=it.chunk_cursor||null;pages++;}while(cursor&&pages<MATTER_DETAIL_PAGES);
  if(changed)continue;
  if(cursor)return `<pre class="matter-detail">${E(text)}</pre><p>${E(T("ui.window.matterDetail.text2",{"length":text.length,"total":total}))}</p>`;
  let data=null;try{data=JSON.parse(text);}catch{}
  return matterHistoryHtml(data,text,item);}
 return ("<p>"+(TH("ui.window.matterDetail.text3"))+"</p>");}
/* 1056 后（Claude，10/17 12:59。Ken：字段看着乱，理一下规则）：每一段经过用同一套规则——
   头一行小字「时间 · 记下/追加 · 改成的状态」；下面左列是字段名（原话、上下文、理解、答复、在等、依据、来源，顺序固定），右列是内容；
   谁说的、依据是哪一类，放在内容前面的小灰字里，不再和字段名混在一起；来源和整条一样时不重复写。 */
function matterHistoryHtml(data,text,item={}){const history=Array.isArray(data)?data[1]?.history:null;if(!Array.isArray(history)||!history.length)return `<pre class="matter-detail">${E(text||T("ui.window.matterHistoryHtml.text"))}</pre>`;
 const field=(label,value,who='')=>{if(!value)return '';const t=String(value),w=who?`<span class="mt-who">${E(who)}</span>`:'';
  return `<dt>${E(label)}</dt><dd>${t.length<=MATTER_LONG?w+E(t):`<details class="matter-long"><summary>${w}<span>${E(t.slice(0,120))}…</span></summary><p>${E(t)}</p></details>`}</dd>`;};
 const own=item.source?.label||'';
 return `<ol class="matter-detail matter-history">${history.map(h=>`<li><div class="mh-h">${E(when(h.at))} · ${E(MATTER_ACTION_WORDS[h.action]||h.action||'')}${h.state?` · <span class="mt-st ${matterTone({state:h.state})}">${E(matterLabel({state:h.state}))}</span>`:''}</div><dl class="mt-dl">${field(T("ui.window.matterHistoryHtml.text2"),h.raw?.text||h.raw?.ref,h.raw?.speaker)}${(Array.isArray(h.context)?h.context:[]).map(c=>field(T("ui.window.matterHistoryHtml.text3"),c?.text,c?.speaker)).join('')}${field(T("ui.window.matterHistoryHtml.text4"),h.understanding)}${field(T("ui.window.matterHistoryHtml.text5"),h.answer)}${field(T("ui.window.matterHistoryHtml.text6"),h.waiting_for)}${(Array.isArray(h.evidence)?h.evidence:[]).map(x=>field(T("ui.window.matterHistoryHtml.text7"),x?.note,MATTER_EVIDENCE_WORDS[x?.kind]||'')).join('')}${h.source?.label&&h.source.label!==own?field(T("ui.window.matterHistoryHtml.text8"),h.source.label):''}</dl></li>`).join('')}</ol>`;}
function left(){if(tab==='matters')return `<div class="col grow-col">${colHead()}${matterList()}</div>`;if(tab==='done')return `<div class="col grow-col">${colHead()}${doneList()}</div>`;const confirms=confirmationsTop();
 /* 1021（待办十九，甲）：按开始时间排、位置固定，新任务加在最下面；同一时刻最多展开一张。
    focusTask：null = 还没定，按默认挑一次（有「等你处理」的展开它，没有就展开最新的）并记下；'' = 点了收起，全都收着；任务 id = 展开那一张。 */
 const run=allTasks().filter(active).sort((a,b)=>(a.created_at||0)-(b.created_at||0));
 const loose=(S.blocks||[]).filter(b=>['high_risk','admin_setup','scope','capability','never'].includes(b.kind)&&!run.some(x=>x.task_id===b.task_id));
 if(!run.length)return `<div class="col">${colHead()}${confirms}${panel(null,loose)}</div>${recentBlock()}`;
 const open=focusTask===''?null:run.find(x=>x.task_id===focusTask)||run.find(isWaiting)||run.find(x=>x.blocker)||run.at(-1);armQuietTimer(run);
 // 1052（Claude，待办十九）：默认展开的那张记下来，之后新任务进来、别的任务变成「等你处理」都不再自动换；展开的那张结束了才重新按默认挑。
 if(open&&focusTask!==open.task_id)focusTask=open.task_id;
 return `<div class="col">${colHead()}${confirms}${open?'':loose.map(blockCard).join('')}<div class="tasks">${run.map(t=>t===open?panel(t,loose,run.length>1):others([t])).join('')}</div></div>${recentBlock()}`;}
const ring=on=>on?'<i class="tp-glow" aria-hidden="true"></i><i class="tp-ring" aria-hidden="true"></i>':'';
/* 缺省图：图标外面三圈静止的圆角矩形（离图标 16 / 32 / 48，间距一样），再加最多 5 道向外扩的波纹（节奏见 waveSync）。圈和波都画在图标后面 */
/* 1053 后（Claude，10/17）：空状态的图标都用线性的、按功能画（Ken 10/17：面性的 logo 放在这里和别的线性图标不配）。
   进行中没有任务 = i-desk-run（窗口 + 指针：ChatGPT 在这台电脑上做事）；待办事项一条都没有 = i-note（便签）；连接中 / 没连上 = i-link。默认值也从 ch-mark 改成 i-desk-run。 */
function emptyIllustration(ic='i-desk-run',tone=''){return `<div class="empty-art ${tone}" aria-hidden="true"><i class="ew-ring" style="--ro:16px;--ra:1"></i><i class="ew-ring" style="--ro:32px;--ra:.62"></i><i class="ew-ring" style="--ro:48px;--ra:.32"></i>${[1,2,3,4,5].map(i=>`<i class="ew-wave" data-w="${i}"></i>`).join('')}<svg viewBox="0 0 24 24"><use href="#${ic}"/></svg></div>`;}
/* 波纹（10/5 晚 Ken：默认不动，只有静止的圈；皮肤里 --wave-motion 写 1 才动）。
   节奏：一轮 N 下（「当当当」），第一下和第二下隔 --wave-gap 毫秒，之后每个间隔乘 --wave-trend（>1 越来越大，<1 越来越小，=1 一样）；
   一轮最后一下到下一轮第一下停 --wave-rest 秒。每道波 --wave-dur 秒从图标边扩到 --wave-size 点外、淡掉。
   所有波用 Web Animations、同一个起点 WAVE_T0、同一个周期，各自只差延迟：改参数、加减几下、页面重画都不会错开
   （以前用 CSS 动画，加一下时新出来的那道从那一刻起算，和前面几道对不上）。减少动态时不画。 */
const WAVE_T0=document.timeline?.currentTime||0,waveReduce=matchMedia('(prefers-reduced-motion: reduce)');let waveKey='';
function waveParams(){const cs=getComputedStyle(document.documentElement),n=(k,d,lo,hi)=>{const v=parseFloat(cs.getPropertyValue(k));return Math.min(hi,Math.max(lo,Number.isFinite(v)?v:d));};
 const on=n('--wave-motion',0,0,1)>=.5&&!waveReduce.matches,count=Math.round(n('--wave-count',3,1,5)),gap=n('--wave-gap',150,20,1000),trend=n('--wave-trend',1,.3,3),rest=n('--wave-rest',2.8,.3,10)*1000,dur=n('--wave-dur',1.6,.3,4)*1000,size=n('--wave-size',48,8,96),alpha=n('--wave-a',.45,0,1);
 const starts=[0];for(let j=1;j<count;j++)starts.push(starts[j-1]+gap*trend**(j-1));
 const last=starts[count-1],cycle=Math.round(Math.max(last+rest,last+dur,dur+50));return {on,count,starts:starts.map(Math.round),cycle,stop:Math.min(1,dur/cycle),size,alpha};}
/* 参数只在皮肤变了（chathand:skin、chathand:fx 事件）或减少动态变化时读（不在每次重画时读样式）；重画后只给新出来的波补上动画 */
let waveP=null;
function waveSync(){waveP=waveParams();const key=JSON.stringify(waveP),fresh=key!==waveKey;waveKey=key;waveApply(fresh);}
function waveApply(fresh=false){const P=waveP;if(!P)return;
 for(const el of document.querySelectorAll('.empty-art>.ew-wave')){const w=+el.dataset.w,want=P.on&&w<=P.count;
  if(!want){if(el.__wave){el.__wave.cancel();el.__wave=null;}continue;}
  if(el.__wave&&!fresh)continue;el.__wave?.cancel();
  const far={inset:-P.size+'px',borderRadius:19+P.size+'px',opacity:0},a=el.animate([{inset:'0px',borderRadius:'19px',opacity:P.alpha,easing:'cubic-bezier(.22,.6,.36,1)'},{...far,offset:P.stop},{...far,offset:1}],{duration:P.cycle,delay:P.starts[w-1],iterations:Infinity});
  a.startTime=WAVE_T0;el.__wave=a;}}
waveSync();for(const name of ['chathand:fx','chathand:skin'])addEventListener(name,waveSync);waveReduce.addEventListener?.('change',waveSync);
function connectionPage(){if(upgrading())return ((emptyIllustration('i-link'))+"<h3>"+(TH("ui.window.connModel.label.text"))+"</h3>"+(("<span class=\"spinner\" aria-label=\""+(TH("ui.window.connectionPage.label"))+"\">"))+(("</span>")));const m=connModel(),st=m.st,site=selectedConnection()==='site',a=site?{}:S.connection?.automatic||{};
 // 0010（Claude，#57）：连接断了（不是用户自己暂停）时，首页这块不再画暂停图标、不再给「恢复」——连上以后 AI 自己接着干，这里只给「重新连接」。
 const held=st==='paused'&&linkHeld();const title=held?m.label:!site&&S.connection?.display?m.label:site?{connecting:T("ui.window.connectionPage.connecting.text"),offline:T("ui.window.connectionPage.offline.text"),unset:T("ui.window.connectionPage.unset.text"),paused:T("ui.window.connectionPage.paused.text")}[st]:{connecting:T("ui.window.connectionPage.connecting.text2"),offline:T("ui.window.connectionPage.offline.text2"),unset:T("ui.window.connModel.sub.text9"),paused:T("ui.window.connectionPage.paused.text")}[st];const siteRs=site&&st==='offline'?routeStatus('site'):null,sub=site?{connecting:T("ui.window.connectionPage.connecting.text3"),offline:siteRs?.st==='broken'?siteRs.why:T("ui.window.connectionPage.offline.text3"),unset:T("ui.window.connectionPage.unset.text2"),paused:T("ui.window.connectionPage.paused.text2")}[st]:{connecting:T("ui.window.connectionPage.connecting.text4"),offline:m.sub||T("ui.window.connectionPage.offline.text4"),unset:T("ui.window.connectionPage.unset.text3"),paused:T("ui.window.connectionPage.paused.text2")}[st];const sub2=held?m.sub:sub;const retry=!site&&(a.phase==='reconnecting'||a.phase==='needs_retry');return `${emptyIllustration(held?'i-cloud-off':st==='paused'?'i-pause':st==='offline'?'i-cloud-off':'i-link',held||st==='offline'?'warn':'')}<h3>${E(title)}</h3><p>${E(sub2)}</p>${retry?("<p class=\"dp-note\">"+(TH("ui.window.connectionPage.text2",{"value":Number(a.attempts||1)}))+"</p>"):''}${st==='connecting'?((("<span class=\"spinner\" aria-label=\""+(TH("ui.window.connModel.label.text5"))+"\">"))+(("</span>"))):st==='offline'?(site?`<div class="dp-acts">${btn(T("ui.window.connModel.right.text"),'openH10','','primary')}</div>${tbtn(T("ui.window.connectionPage.text3"),'technicalInfo')}`:`<div class="dp-acts">${btn(T("ui.window.connectionPage.text4"),'repair','','primary')}${btn(T("ui.window.connModel.left.text3"),'aiBrief')}</div>${tbtn(T("ui.window.connectionPage.text3"),'technicalInfo')}`):held?btn(T("ui.window.capBrowser.act.text"),'restoreSaved','','primary'):st==='paused'?btn(T("ui.window.action.resumeAI.button"),'resumeAI','','primary'):btn(site?T("ui.window.connModel.right.text"):T("ui.window.connModel.right.text3"),site?'openH10':'manual','','primary')}`;}
function panel(t,loose=[],collapsible=false){
 if(!t){const abnormal=connState()!=='online'||paused();return ("<section data-k=\"idle-panel\" class=\"tp idle\" aria-label=\""+(TH("ui.window.colHead.text"))+"\"><div class=\"tp-in\">"+(loose.map(blockCard).join(''))+"<div class=\"tp-empty\">"+(abnormal?connectionPage():((emptyIllustration('i-desk-run'))+"<h3>"+(TH("ui.window.panel.text"))+"</h3><p>"+(TH("ui.window.panel.text2"))+"</p><div class=\"prompt-list\">"+(samplePrompts().map((prompt,i)=>`<button class="prompt-pill" data-k="prompt-${i}" type="button" data-action="openPrompt" data-id="${E(prompt)}" title="${E(prompt)}">${icon(['i-laptop','i-file','i-folder'][i],'sm')}<span>${E(PROMPT_LABELS[i])}</span>${icon('i-arrow-ur','sm prompt-arrow')}</button>`).join(''))+"</div>"))+"</div></div></section>");}
 const P=taskParts(t);
 return ((P.banner)+"<section data-k=\"task-panel-"+(E(t.task_id))+"\" class=\"tp "+(P.cls)+"\" aria-label=\""+(TH("ui.window.colHead.text"))+"\">"+(ring(P.cls==='run'))+"<div class=\"tp-in\"><div class=\"tp-h"+(collapsible?' tp-hit':'')+"\""+(collapsible?` role="button" tabindex="0" aria-expanded="true" data-action="collapseTask" data-id="${E(t.task_id)}" title="${TH("ui.window.panel.collapse")}"`:'')+"><div class=\"tp-t\"><h3>"+(E(t.title||T("ui.window.panel.text4")))+"</h3><p>"+(P.src)+"</p></div>"+(("<span class=\"stat "+(P.st[0]?P.st[0].split(' ')[0]:'')+"\">"))+(("<i class=\"sdot "+(P.st[0])+"\" aria-hidden=\"true\">"))+(("</i>"))+(E(P.st[1]))+(P.cls==='run'&&t.created_at?' · '+timed(t.created_at,'dur',dur(Date.now()-t.created_at)):'')+(("</span>"))+(collapsible?`<span class="tp-fold" aria-hidden="true">${icon('i-chev','xs')}</span>`:'')+"</div>"+(P.body)+"</div></section>");}
/* 进行中这张卡的状态和主体（单个任务的大卡、多个任务的折叠卡共用） */
let CHECKPOINT_ACTIONS={resume_browser:T("ui.window.checkpointActions.resume_browser.text"),resume_desktop:T("ui.window.checkpointActions.resume_browser.text"),stop_here:T("ui.window.checkpointActions.stop_here.text")};
function taskBlocker(b,taskId,checkpointSeq){if(!b)return '';return ("<div class=\"task-blocker\">"+(TH("ui.window.taskBlocker.text",{"openB":("<b>"),"value":E(b.step||''),"closeB":("</b>")}))+"<pre>"+(E(b.error||''))+"</pre>"+(b.why?`<p>${E(b.why)}</p>`:'')+"<div class=\"task-blocker-options\">"+((b.options||[]).map((o,index)=>{const action=Object.prototype.hasOwnProperty.call(CHECKPOINT_ACTIONS,o?.action)?o.action:null;return `<div>${action?`<button class="tbtn checkpoint-action" type="button" data-action="checkpointAction" data-id="${E(taskId)}" data-checkpoint-action="${action}" data-checkpoint-seq="${Number(checkpointSeq)||0}" data-choice="${index+1}">${CHECKPOINT_ACTIONS[action]}</button>`:`<strong>${E(o?.label||'')}</strong>`}<small>${E(o?.cost||'')}</small></div>`;}).join(''))+"</div></div>");}
/* 1052（Claude）：任务现在是什么状态。大卡顶上的小标、折叠行前面的点和那行字、默认展开哪张，都用这一个判断（待办 41.1、41.2、E20）。
   先后：暂停 → 等你处理（命令、确认、被拦下）→ 卡住了（AI 报了卡点、给了选项）→ 停住了 → 等你回话（AI 记了进度、在等你）
   → 长时间无活动（后端没给这张卡停没停的判断，且超过 10 分钟没有任何动作；同一段对话里较早的任务就是这样）→ 运行中。
   除了运行中（绿）和已暂停（灰），全是橙色：要你留意。 */
const QUIET_MS=600000;
function jobRunning(t){return jobsOf(t).some(j=>j.status==='running'||(!j.finished_at&&j.process_alive));}
function lastActiveAt(t){return Math.max(t.stall?.last_at||0,t.recent_steps?.at(-1)?.at||0,t.last_checkpoint?.at||0,...jobsOf(t).map(j=>j.finished_at||j.started_at||j.created_at||0),t.created_at||0);}
/* 1052（Claude，待办二十八 10/13）：AI 停下来等别人时，task_checkpoint 的 next 写「等：…」（比如「等 Claude 复核」）。有就照它写，不一律写「等你回话」。 */
function waitingFor(t){const next=String(t.last_checkpoint?.waiting_user?t.last_checkpoint.next||'':'').trim();return /^等/.test(next)?next.replace(/^等[:：]\s*/,'等'):'';}
function taskState(t){
 if(t.status==='installing')return {key:'run',cls:'run',dot:'ok live',label:T("ui.window.taskState.label.text"),line:T("ui.window.taskState.line.text")};
 if(paused()){const w=linkHeld()?T("ui.window.connModel.held.label"):T("ui.window.connModel.label.text2");return {key:'hold',cls:'paused',dot:'',label:w,line:w};}
 if(isWaiting(t))return {key:'wait',cls:'wait',dot:'warn',label:T("ui.window.statusWords.wait.text"),line:T("ui.window.statusWords.wait.text")};
 if(t.blocker)return {key:'blocked',cls:'wait',dot:'warn',label:T("ui.window.taskState.label.text2"),line:T("ui.window.taskState.line.text2")};
 const st=t.stall;
 if(S.task_stalls?.[t.task_id]||st?.stalled)return {key:'stalled',cls:'wait',dot:'warn',label:T("ui.window.taskState.label.text3"),line:T("ui.window.taskState.label.text3")};
 if(st?.waiting_user){const w=waitingFor(t);return w?{key:'reply',cls:'wait',dot:'warn',label:/^等你/.test(w)?T("ui.window.taskState.label.text4"):T("ui.window.matterHistoryHtml.text6"),line:midText(w,28)}:{key:'reply',cls:'wait',dot:'warn',label:T("ui.window.taskState.label.text4"),line:T("ui.window.taskState.label.text4")};}
 // 1052（Claude，待办 41.2）：服务器的停住阈值会越涨越长（一次长间隔就把阈值抬到几十分钟），所以没在执行调用、10 分钟没动静的，一律显示「长时间无活动」，不再一直是绿的「运行中」。
 if((!st||!st.running)&&!jobRunning(t)&&Date.now()-lastActiveAt(t)>QUIET_MS)return {key:'quiet',cls:'wait',dot:'warn',label:T("ui.window.taskState.label.text5"),line:T("ui.window.taskState.label.text5")};
 return {key:'run',cls:'run',dot:'ok live',label:T("ui.window.timelineResult.text"),line:T("ui.window.timelineResult.text")};
}
/* 「长时间无活动」是按时间算的：没有新数据进来也要到点重画一次。 */
let quietTimer=0;
function armQuietTimer(run){clearTimeout(quietTimer);quietTimer=0;if(paused())return;const now=Date.now(),waits=run.filter(t=>(!t.stall||!t.stall.running&&!t.stall.stalled&&!t.stall.waiting_user)&&!jobRunning(t)).map(t=>lastActiveAt(t)+QUIET_MS-now).filter(ms=>ms>0);if(waits.length)quietTimer=setTimeout(scheduleRender,Math.min(...waits)+1000);}
/* 上一步的对象写短：网址只留域名和路径，命令剥掉 shell 外壳，路径按时间线的写法缩短。 */
function stepTarget(x){const v=String(x?.target||'').trim();if(!v)return '';
 if(/^https?:\/\//i.test(v)){try{const u=new URL(v);return midText(u.host+(u.pathname.length>1?u.pathname:''),46);}catch{return midText(v,46);}}
 if(x.tool==='propose_command')return shortCommand({program:v.replace(/^(?:\S*\/)?(?:ba|z)?sh\s+-[a-z]*c\s+/,'')});
 if(v.startsWith('/')||v.startsWith('~'))return shortPath(v);
 return midText(v,46);}
/* 时间线最上面那一行：ChatHand 正在执行一次调用时写「正在读文件…」并计时；在等 ChatGPT 时写上一步是什么、隔了多久。
   改文件、跑命令这两类下面已经各有一行，不重复写。 */
function nowRow(t){const st=t.stall,last=(t.recent_steps||[]).at(-1);
 if(st?.running&&st.last_at)return {key:'now:'+t.task_id,state:'run',at:st.last_at,title:T("ui.window.nowRow.title.text",{"stallTool":stallTool(st.last_tool)}),detail:T("ui.window.nowRow.detail.text"),time:dur(Date.now()-st.last_at)};
 const at=Math.max(st?.last_at||0,last?.at||0,t.last_checkpoint?.at||0),shown=last&&!Object.prototype.hasOwnProperty.call(TOOL_WORDS,last.tool)&&last.tool!=='propose_command';
 const what=shown?[stallTool(last.tool),stepTarget(last)].filter(Boolean).join(' '):'',when0=shown?last.at:at;
 return {key:'idle:'+t.task_id,state:'idle',title:T("ui.window.nowRow.title.text2"),detailHtml:when0?T("ui.window.nowRow.detailHtml.text",{"timed":timed(when0,'sec',secAgo(when0)),"value":what?'：'+E(what):''}):'',time:'—'};}
/* 停住了 / 等你回话 / 长时间无活动：各给一段说明，写清现在该怎么办。做完了却没收尾的任务也会停在这里，所以也告诉怎么收起。 */
function taskNote(t,state){const k=state.key;if(!['stalled','reply','quiet'].includes(k))return '';
 const at=lastActiveAt(t),since=at?((TH("ui.window.taskNote.text",{"openSmall":("<small>"),"timed":timed(at,'sec',secAgo(at)),"closeSmall":("</small>")}))):'',cp=t.last_checkpoint,next=String(cp?.next||'').replace(/^接着做[:：]\s*/,'');
 const progress=cp?.done?("<p class=\"task-progress\">"+(TH("ui.window.taskNote.text4",{"value":cp.block&&cp.total?T("ui.window.taskNote.text2",{"value":Number(cp.block),"value2":Number(cp.total)}):'',"done":E(cp.done),"value2":next?((TH("ui.window.taskNote.text3",{"openBr":("<br>"),"next":E(next)}))):''}))+"</p>"):'';
 const done=T("ui.window.taskNote.text6",{"value":jobRunning(t)?T("ui.window.taskNote.text5"):''});
 const acts=t.group?.conversation_url?`<div class="wb-acts">${conversationLink(t,'sm')}</div>`:'';
 const box=(title,body)=>`<div class="wb task-note" data-k="note-${E(t.task_id)}"><b>${title}${since}</b>${progress}${body}<p>${done}</p>${acts}</div>`;
 if(k==='reply'){const w=waitingFor(t);if(w&&!/^等你/.test(w))return box(T("ui.window.taskNote.text7",{"w":E(w)}),("<p>"+(TH("ui.window.taskNote.text8"))+"</p>"));return box(w?T("ui.window.taskNote.text7",{"w":E(w)}):T("ui.window.taskNote.text9"),("<p>"+(TH("ui.window.taskNote.text10"))+"</p>"));}
 if(k==='stalled')return box(T("ui.window.taskNote.text11"),("<p>"+(TH("ui.window.taskNote.text12"))+"</p>"));
 return box(T("ui.window.taskNote.text13"),("<p>"+(TH("ui.window.taskNote.text14"))+"</p>"));}
function taskParts(t){
 void loadChanges(t.task_id);
 const wait=isWaiting(t),hold=paused(),from=chatTitle(t),srcFrom=isRefreshTask(t)?T("ui.window.chatTitle.text"):from?T("ui.window.taskParts.text",{"from":from}):T("ui.window.taskParts.text2"),srcTime=t.created_at?T("ui.window.taskParts.text3",{"dayLabel":dayLabel(t.created_at),"clock":clock(t.created_at)}):'',src=`${E(srcFrom)}${srcTime?`${srcFrom.endsWith('」')?'· ':' · '}<span class="nw">${E(srcTime)}</span>`:''}${valueTaskMeta(t,srcTime||srcFrom)}`;
 const state=taskState(t),stalled=state.key==='stalled';
 const cls=state.cls,st=[state.dot,state.label];
 const banner=upgrading()?("<div class=\"connection-strip\">"+(TH("ui.window.connModel.label.text"))+"</div>"):hold?("<div class=\"connection-strip\">"+(linkHeld()?TH("ui.window.taskParts.held",{"tbtn":tbtn(T("ui.window.capBrowser.act.text"),'restoreSaved')}):TH("ui.window.taskParts.text4",{"tbtn":tbtn(T("ui.window.action.resumeAI.button"),'resumeAI')}))+"</div>"):connState()!=='online'||siteBlock()?("<div class=\"connection-strip\">"+(siteBlock()?E(siteBlockText(siteBlock())):stripBroken()?E(fullStop(stripBroken()))+' '+tbtn(T("ui.window.taskParts.openConn"),'drawer','conn'):TH("ui.window.taskParts.text5"))+"</div>"):'';
 const body=((wait?waitBlock(t):'')+(taskNote(t,state))+(taskBlocker(t.blocker,t.task_id,t.checkpoint_seq))+(taskContent(t))+"<div class=\"tp-f\">"+(t.group?.conversation_url?conversationLink(t,'tlink'):'')+"<button class=\"btn tlink\" type=\"button\" data-action=\"openTask\" data-id=\""+(E(t.task_id))+"\">"+(TH("ui.window.taskParts.text7"))+"</button>"+(("<span class=\"grow\">"))+(("</span>"))+(upgrading()?'':hold?btn(T("ui.window.action.resumeAI.button"),'resumeAI','','stop primary'):("<button class=\"btn stop\" type=\"button\" data-action=\"stopTask\" data-id=\""+(E(t.task_id))+"\" title=\""+(TH("ui.window.taskParts.label"))+"\">"+(TH("ui.window.taskParts.text6",{"icon":icon('i-stop','sm'),"openSpan":("<span>"),"closeSpan":("</span>")}))+"</button>"))+"</div>");
 return {wait,hold,stalled,state,cls,st,src,from,banner,body};
}
function waitBlock(t){const ap=waitingOn(t);let h='';
 if(ap)h+=("<div class=\"wb\">"+(("<b>"))+(ap.kind==='admin'?T("ui.window.waitBlock.text"):T("ui.window.waitBlock.text2"))+(("</b>"))+(ap.command?`<pre class="cmd">${E(ap.command)}</pre>`:'')+"<p>"+(TH("ui.window.waitBlock.text5"))+"</p><div class=\"wb-acts\">"+(btn(T("ui.window.waitBlock.text3"),'rejectJob',ap.id,'sm'))+(btn(T("ui.window.waitBlock.text4"),'approveJob',ap.id,'sm primary'))+"</div></div>");
 else if(t.status==='pending_approval')h+=("<div class=\"wb\">"+(TH("ui.window.waitBlock.text7",{"openB":("<b>"),"closeB":("</b>")}))+"<div class=\"wb-acts\">"+(btn(T("ui.window.waitBlock.text6"),'openTask',t.task_id,'sm'))+"</div></div>");
 const permission=blocksOf(t).find(block=>['high_risk','admin_setup'].includes(block.kind));if(permission)h+=("<div class=\"command-needed\">"+(TH("ui.window.waitBlock.text9",{"openSpan":("<span>"),"closeSpan":("</span>"),"btn":btn(T("ui.window.waitBlock.text8"),'blockEnable',permission.id,'sm')}))+"</div>");return h+blocksOf(t).map(blockCard).join('');}
/* 已拦下：ChatGPT 想做的事被闸门挡住时，这里用同一段作用和危害再说一遍，给去打开的按钮 */
const CAP_KEYS={terminal:'terminal_enabled',browser:'browser_enabled',desktop:'desktop_enabled'};
function blockCard(b){const t=b.task_id?allTasks().find(x=>x.task_id===b.task_id):null,times=b.times>1?T("ui.window.blockCard.text",{"times":b.times}):'',cmd=midText(b.command,48),blocked=b.blocked;
 if(blocked?.kind==='can_enable')return '';
 const back=t?.group?.conversation_url?conversationLink(t):'',close=("<button class=\"wb-x\" type=\"button\" data-action=\"blockDismiss\" data-id=\""+(E(b.block_id))+"\" aria-label=\""+(TH("ui.window.blockCard.label"))+"\">"+(icon('i-x','xs'))+"</button>");
 const card=(tone,title,body,acts)=>("<div class=\"wb"+(tone==='done'?' done':'')+"\" role=\"group\" aria-label=\""+(TH("ui.window.blockCard.label2"))+"\">"+(close)+(("<b>"))+(E(title))+(("</b>"))+(body?`<p>${E(body)}</p>`:'')+(acts?`<div class="wb-acts">${acts}</div>`:'')+"</div>");
 if(blocked?.kind==='needs_user'){const say=Array.isArray(blocked.say_to_user)?blocked.say_to_user.slice(0,3):[],section=blocked.gate==='system_permission'?'desktop':blocked.gate==='browser_helper'?'browser':'terminal',open=blocked.gate==='browser_helper'&&blocked.item?.id==='install'?btn(T("ui.window.blockCard.text2"),'extensionSetup','','sm primary'):blocked.gate==='admin_setup'||b.kind==='admin_setup'?btn(T("ui.window.blockCard.text3"),'blockEnable',b.id||'admin','sm primary'):btn(T("ui.window.blockCard.text3"),'jumpSettings',section,'sm primary');return card('warn',say[0]||blocked.cause||b.name,say.slice(1).join(' '),open);}
 if(b.kind==='high_risk'||b.kind==='admin_setup'){const r=riskList().find(x=>x.id===b.id)||{name:b.name,what:'',harm:''};
  if(['admin','autostart'].includes(b.id))return card('warn',b.id==='admin'?T("ui.window.blockCard.text4"):T("ui.window.blockCard.text5"),'',btn(T("ui.window.blockCard.text3"),'blockEnable',b.id,'sm primary')+back);
  if(S.settings?.high_risk?.[b.id]===true)return card('done',T("ui.window.blockCard.text6",{"name":r.name}),scopeFull()?T("ui.window.blockCard.text7"):T("ui.window.blockCard.text8"),scopeFull()?back:btn(T("ui.window.blockCard.text9"),'scopeFull','','sm primary')+back);
  return card('warn',T("ui.window.blockCard.text10",{"cmd":cmd,"name":r.name,"times":times}),T("ui.window.blockCard.text11",{"what":r.what,"harm":r.harm}),`${btn(T("ui.window.blockCard.text3"),'blockEnable',b.id,'sm primary')}${btn(T("ui.window.blockCard.text12"),'blockDismiss',b.block_id,'sm')}${back}`);}
 if(b.kind==='scope'){if(scopeFull())return card('done',T("ui.window.blockCard.text13"),T("ui.window.blockCard.text14"),back);
  return card('warn',T("ui.window.blockCard.text15"),'',`${btn(T("ui.window.blockCard.text16"),'drawer','scope','sm primary')}${back}`);}
 if(b.kind==='capability'){const key=CAP_KEYS[b.id];if(key&&capOn(key))return card('done',T("ui.window.blockCard.text17",{"name":b.name}),T("ui.window.blockCard.text7"),back);
  return card('warn',T("ui.window.blockCard.text18",{"name":b.name,"times":times}),T("ui.window.blockCard.text19"),`${btn(T("ui.window.blockCard.text20"),'capEnable',b.id,'sm primary')}${back}`);}
 return card('warn',T("ui.window.blockCard.text24",{"value":b.name==='关闭或改动 ChatHand 本身'?T("ui.window.blockCard.text21"):b.name==='切换成别的账户（su、doas）'?T("ui.window.blockCard.text22"):T("ui.window.blockCard.text23")}),T("ui.window.blockCard.text25"),'');}
/* 同时在做的其它任务：两行的小卡片（标题 / 状态 · 用时 · 来自哪个对话），点一下在原地展开、原来展开的那张在原地收起（swapFocus 管过渡，不换位置） */
/* 1052（Claude）：折叠行的点和那行字跟大卡一样，用 taskState（待办 41.1：停住了收起后也是橙点）。停住、等你回话、长时间无活动的，写上一步隔了多久。 */
function others(list){if(!list.length)return '';return list.map(t=>{const from=chatTitle(t),s=taskState(t),at=lastActiveAt(t),line=s.key==='run'?T("ui.window.others.text",{"value":t.created_at?' · '+timed(t.created_at,'dur',dur(Date.now()-t.created_at)):''}):s.line+(['stalled','reply','quiet'].includes(s.key)&&at?T("ui.window.others.text2",{"timed":timed(at,'sec',secAgo(at))}):'');return `<div class="others" data-k="others-${E(t.task_id)}"><button class="orow" type="button" aria-expanded="false" data-k="orow-${E(t.task_id)}" data-action="focusTask" data-id="${E(t.task_id)}"><i class="sdot ${s.dot}" aria-hidden="true"></i><span class="orow-t"><b title="${E(t.title||T("ui.window.panel.text4"))}">${E(t.title||T("ui.window.panel.text4"))}</b><small>${line}${from?T("ui.window.others.text3",{"from":E(from)}):''}</small></span>${icon('i-chev','xs')}</button></div>`;}).join('');}
function resultOf(t){const k=kind(t);return k==='ok'?['ok',T("ui.window.statusWords.ok.text")]:k==='fail'?['fail',T("ui.window.statusWords.fail.text")]:['stop',statusWords(t)];}
function rrow(t){const from=chatTitle(t),[k,txt]=resultOf(t),tip=t.summary?txt+' · '+t.summary:txt;return `<button class="rr" type="button" data-action="openTask" data-id="${E(t.task_id)}"><span class="rr-ic ${k}">${icon(k==='ok'?'i-check':k==='fail'?'i-bang':'i-stop','xs')}</span><b title="${E(t.title||T("ui.window.panel.text4"))}">${E(t.title||T("ui.window.panel.text4"))}</b><span class="rr-src" title="${E(from)}">${E(from)}</span><span class="rr-res ${k}" title="${E(tip)}">${E(txt)}</span><span class="rr-tm">${E(when(t.finished_at||t.created_at))}</span><span class="rr-go" aria-hidden="true">${icon('i-chev','xs')}</span></button>`;}
// 1067：「最近」= 已结束（完成/停止/没做完，即 !active）里按结束时间倒序的前 5 条，没有时间窗口。
// 数据源：allTasks()（实时任务 + activity 分组）再并上后端给的 S.history（最近 100 条回执），按 task_id 去重。
function recentFinished(){const m=new Map();for(const t of [...(S.history||[]),...allTasks()])m.set(t.task_id,{...(m.get(t.task_id)||{}),...t});return [...m.values()].filter(t=>!active(t)).sort((a,b)=>(b.finished_at||b.created_at||0)-(a.finished_at||a.created_at||0));}
function recentBlock(){const all=recentFinished(),done=all.slice(0,5),today=all.filter(t=>sameLocalDay(t.finished_at||t.created_at||0,Date.now())).length;
 return ("<section class=\"recent\" aria-label=\""+(TH("ui.window.recentBlock.label"))+"\"><div class=\"recent-h\"><h4>"+(TH("ui.window.recentBlock.text3",{"value":today?T("ui.window.recentBlock.text",{"today":today}):''}))+"</h4><button class=\"more\" type=\"button\" data-tab=\"done\">"+(TH("ui.window.recentBlock.text4"))+"</button></div>"+(done.length?`<div class="rl">${done.map(rrow).join('')}</div>`:("<p class=\"empty recent-empty\">"+(TH("ui.window.recentBlock.text2"))+"</p>"))+"</section>");}
/* 1021：已完成加搜索（待办二十三）。搜标题、来自哪个对话、ChatGPT 收尾那句话；和上面的筛选一起生效；只在这一页有效。 */
function doneMatch(t,q){if(!q)return true;const hay=[t.title,chatTitle(t),t.summary].filter(Boolean).join('\n').toLowerCase();return q.toLowerCase().split(/\s+/).filter(Boolean).every(w=>hay.includes(w));}
/* 1052 补丁 2（Claude）：已了结的待办事项挪回待办事项页，已完成只放任务（分段去掉「事项」，搜索也不再搜它们）。 */
function doneList(){const all=allTasks().filter(t=>!active(t)),q=doneQuery.trim(),list=all.filter(t=>(doneFilter==='all'||kind(t)===doneFilter)&&doneMatch(t,q));return ("<div class=\"done-bar\"><div class=\"seg\" role=\"group\" aria-label=\""+(TH("ui.window.doneList.label"))+"\">"+([['all',T("ui.window.matterFilters.text")],['ok',T("ui.window.doneList.text")],['stop',T("ui.window.doneList.stoppedFilter")],['fail',T("ui.window.statusWords.fail.text")]].map(([id,label])=>`<button type="button" data-filter="${id}" aria-pressed="${doneFilter===id}">${label}</button>`).join(''))+"</div><label class=\"done-search"+(doneQuery||doneSearchFocus?' open':'')+"\" data-k=\"done-search\" title=\""+(TH("ui.window.doneList.label2"))+"\">"+(icon('i-search','sm'))+"<input id=\"doneSearch\" type=\"search\" placeholder=\""+(TH("ui.window.doneList.label3"))+"\" aria-label=\""+(TH("ui.window.doneList.label4"))+"\" autocomplete=\"off\" spellcheck=\"false\" value=\""+(E(doneQuery))+"\">"+(doneQuery?("<button class=\"done-clear\" type=\"button\" data-action=\"cancelDoneSearch\" aria-label=\""+(TH("ui.window.matterList.label"))+"\" data-tip=\""+(TH("ui.window.matterList.label2"))+"\">"+(icon('i-x','xs'))+"</button>"):'')+"</label></div>"+(list.length?`<div class="rl all">${list.slice(0,100).map(rrow).join('')}</div>`:q?("<p class=\"empty\">"+(TH("ui.window.doneList.text3",{"q":E(q)}))+"<button class=\"tbtn\" type=\"button\" data-action=\"clearDoneSearch\">"+(TH("ui.window.matterList.text3"))+"</button></p>"):doneEmpty()));}
function doneEmpty(){return "<section class=\"list-empty done-empty\" data-k=\"done-empty\"><div class=\"le-in\">"+emptyIllustration('i-note')+"<h3>"+TH("ui.window.doneEmpty.title")+"</h3><p>"+(doneFilter==='all'?TH("ui.window.recentBlock.text2"):TH("ui.window.doneEmpty.hint"))+"</p></div></section>";}

/* ---------- 右栏：设置 ---------- */
/* 右栏：标题跟着页面滚走（和左边「进行中 / 已完成」一样），下面的卡片包在 .rail-stick 里，从第一张起停在顶上（10/6 Ken 选「乙」） */
function rail(){return ("<div class=\"col-h\"><h2>"+(TH("ui.window.nav.text4"))+"</h2></div><div class=\"rail-stick\">"+(connCard())+(toolListNotice())+(permCard())+(rowCard('nav-set',T("ui.window.nav.text4"),'drawer','settings'))+(rowCard('i-help',T("ui.window.rail.text"),'drawer','help'))+"</div>");}
function connectionMethod(){return S.settings?.connection_preference==='relay'?'relay':S.settings?.connection_preference==='tunnel'?'tunnel':S.relay?.online?'relay':'tunnel';}
function connectionIcon(){return selectedConnection()==='site'||connectionMethod()==='relay'?'i-site':'i-tunnel';}
function connectionName(){return selectedConnection()==='site'?'ChatGPT Site':connectionMethod()==='relay'?T("ui.window.connectionName.text"):T("ui.window.connectionName.text2");}
function connCard(){const base=connModel(),warning=selectedConnection()!=='site'&&!S.relay?.online?S.connection?.display?.settings_warning:null,m=warning&&base.st==='online'?{...base,dot:'cloud-wait',label:warning.title,sub:warning.detail,left:''}:base;
 return ("<section class=\"card cc\" aria-label=\""+(TH("ui.window.connCard.label"))+"\"><button class=\"cc-main\" type=\"button\" data-action=\"drawer\" data-id=\"conn\">"+(TH("ui.window.connCard.text",{"openSpan":("<span class=\"cc-h\">"),"openSpan2":("<span>"),"closeSpan":("</span>"),"openSpan3":("<span class=\"stat "+(m.dot==='ok'?'ok':m.dot==='warn'?'warn':['cloud-wait','cloud-down'].includes(m.dot)?m.dot:'')+"\">"),"statDot":statDot(m),"label":E(m.label),"closeSpan2":("</span>"),"closeSpan3":("</span>"),"openSpan4":("<span class=\"cc-a\">"),"openSpan5":("<span class=\"tile dark\">"),"icon":icon(connectionIcon()),"closeSpan4":("</span>"),"openSpan6":("<span class=\"cc-n\">"),"openB":("<b>"),"connectionName":connectionName(),"closeB":("</b>"),"openSmall":("<small title=\""+(E(m.sub))+"\">"),"sub":E(m.sub),"closeSmall":("</small>"),"closeSpan5":("</span>"),"closeSpan6":("</span>")}))+"</button>"+(m.left||m.right?`<div class="cc-f"><span class="cc-l" title="${E(m.left.replace(/<[^>]*>/g,''))}">${m.left}</span>${m.right}</div>`:'<div class="cc-f empty"></div>')+"</section>");}
function permCard(){const tm=capTerminal(),bm=capBrowser(),dm=capDesktop();
 const row=(view,ic,label,m,key)=>`<div data-k="permission-${view}" class="pr" role="button" tabindex="0" data-action="drawer" data-id="${view}" aria-label="${E(label)}：${E(m.sub)}"><span class="tile">${icon(ic)}</span><span class="pr-l">${E(label)}</span>${m.tag?`<span class="pr-state">${E(m.tag)}</span>`:''}${sw(key,m.on,label)}${icon('i-chev','xs pr-chev')}</div>`;
 const tier=shownTier();
 return ("<section class=\"card pc\" aria-label=\""+(TH("ui.window.permCard.label"))+"\"><div class=\"pc-head\"><h3>"+(TH("ui.window.permCard.label"))+"</h3><div class=\"tier-seg\" role=\"group\" aria-label=\""+(TH("ui.window.permCard.label2"))+"\">"+([['full',T("ui.window.permCard.text")],['light',T("ui.window.permCard.text2")]].map(([id,label])=>`<button type="button" data-k="tier-${id}" data-action="tier" data-id="${id}" aria-pressed="${tier===id}">${label}</button>`).join(''))+"</div></div><div data-k=\"permission-scope\" class=\"pr\" role=\"button\" tabindex=\"0\" data-action=\"drawer\" data-id=\"scope\" aria-label=\""+(TH("ui.window.permCard.label3"))+"\">"+(TH("ui.window.permCard.text6",{"openSpan":("<span class=\"tile\">"),"icon":icon('i-folder'),"closeSpan":("</span>"),"openSpan2":("<span class=\"pr-l\">"),"closeSpan2":("</span>"),"openSpan3":("<span class=\"pr-v\" title=\""+E(scopeFull()?T("ui.window.stepsOf.detail.text6"):S.project?.path||'')+"\">"),"value":E(scopeFull()?T("ui.window.stepsOf.detail.text6"):midText(workspaceName(),14)),"closeSpan3":("</span>"),"icon2":icon('i-chev','xs pr-chev')}))+"</div>"+(row('terminal','i-terminal',T("ui.window.permCard.text3"),tm,'terminal_enabled'))+(row('browser','i-globe',T("ui.window.permCard.text4"),bm,'browser_enabled'))+(row('desktop','i-monitor',T("ui.window.permCard.text5"),dm,'desktop_enabled'))+permissionHint()+"</section>");}
/* 1082：权限小气泡原来画在设置抽屉里，那一节没有定位，气泡掉到窗口底下看不见。它说的「完整 | 轻量」和逐项开关都在首页的权限卡上，
   样式（.pc:has(.permission-hint)、重画字段里的 permissionHintReady）也是照首页权限卡写的，所以挂回首页权限卡下面。设置里只留「还有几项没开」那一行。 */
function permissionHint(){return permissionHintReady&&!isSeen('perm-hint-1012')&&!bubbleHTML()?("<div data-k=\"permission-hint\" class=\"permission-hint\" role=\"status\"><p>"+(TH("ui.window.permissionNotices.text2",{"openSpan":("<span class=\"nw\">"),"closeSpan":("</span>")}))+"</p>"+(btn(T("ui.window.matterReport.text10"),'permHint','','sm'))+"</div>"):'';}
function permissionNotices(){const pending=setupItems().filter(item=>item.blocking);return pending.length&&permissionHintReady?("<button class=\"setup-pending\" type=\"button\" data-action=\"setupItem\" data-id=\""+(E(pending[0].id))+"\">"+(TH("ui.window.permissionNotices.text",{"length":pending.length}))+"</button>"):'';}
function pgPermissionPreset(){const tier=shownTier();return ("<p class=\"dp-desc\">"+(TH("ui.window.pgPermissionPreset.text6"))+"</p><div class=\"permission-presets\">"+([['full',T("ui.window.permCard.text"),'i-monitor',T("ui.window.pgPermissionPreset.text")],['light',T("ui.window.permCard.text2"),'i-folder',T("ui.window.pgPermissionPreset.text2")]].map(([id,label,ic,desc])=>`<section class="permission-preset${tier===id?' current':''}" aria-label="${label}${tier===id?T("ui.window.pgPermissionPreset.text3"):''}"><span class="tile">${icon(ic)}</span><h3>${label}</h3><p>${desc}</p>${tier===id?((TH("ui.window.pgPermissionPreset.text4",{"openSpan":("<span class=\"preset-current\">"),"icon":icon('i-check','sm'),"closeSpan":("</span>")}))):btn(T("ui.window.pgPermissionPreset.text5"),'tier',id,'sm')}</section>`).join(''))+"</div>");}
function permissionTierChanges(tier){const full=tier==='full',changes=[],hr=S.settings?.high_risk||{};if(full!==scopeFull())changes.push(T("ui.window.permissionTierChanges.text2",{"value":full?T("ui.window.stepsOf.detail.text6"):`「${scopeFull()?T("ui.window.permissionTierChanges.text"):workspaceName()}」`}));for(const [key,label] of [['terminal_enabled',T("ui.window.permCard.text3")],['browser_enabled',T("ui.window.permCard.text4")],['desktop_enabled',T("ui.window.permCard.text5")]]){const on=key==='desktop_enabled'?full:true;if(capOn(key)!==on)changes.push(on?T("ui.window.permissionTierChanges.enableCapability",{"name":label}):T("ui.window.permissionTierChanges.disableCapability",{"name":label}));}if(full&&!hr.admin)changes.push(T("ui.window.permissionTierChanges.text5"));if(!full&&hr.admin)changes.push(T("ui.window.permissionTierChanges.text6"));if(!!hr.autostart!==full)changes.push(full?T("ui.window.permissionTierChanges.enableAutostart"):T("ui.window.permissionTierChanges.disableAutostart"));for(const item of risksOn())changes.push(T("ui.window.permissionTierChanges.text8",{"name":item.name}));return changes.length?changes:[T("ui.window.permissionTierChanges.text9")];}

const rowCard=(ic,label,action,id)=>`<button class="card rc" type="button" data-action="${action}" data-id="${id}">${icon(ic,'sm')}<span>${E(label)}</span>${icon('i-chev','xs')}</button>`;
/* ---------- 工作量：所有额度、价格和读数来自状态 ---------- */
const valueNumber=n=>Number.isFinite(Number(n))?Math.max(0,Number(n)):0;
/* 1081（Claude，Ken 10/27 22:18：从逻辑上讲可以超过 100%）：额度条不再封顶。满格取 100% 的整数倍，108% 画在 0–200% 的条上，
   超过 100% 时条下标 0、100%、200%…（10/12 以前就是这么画的）。超过 500% 时每格放大，刻度最多 6 个，窄抽屉也排得下。 */
function valueQuotaScale(share){const units=Math.max(1,Math.ceil(valueNumber(share)/100)),step=units<=5?100:100*Math.ceil(units/5),max=step*Math.ceil(units*100/step);return {max,ticks:Array.from({length:max/step+1},(_,i)=>i*step)};}
function formatTokens(n){n=valueNumber(n);
 if(typeof window!=='undefined'&&window.ChatHandText?.locale==='en'){
  if(n<999.5)return Math.round(n).toLocaleString('en-US');
  let scale=n<1e6?1e3:n<1e9?1e6:1e9;
  let value=Number((n/scale).toFixed(1));
  if(value>=1000&&scale<1e9){scale*=1000;value=Number((n/scale).toFixed(1));}
  return scale===1e3?T("ui.window.formatTokens.text",{value}):scale===1e6?T("ui.window.formatTokens.text2",{value}):T("ui.window.formatTokens.billions",{value});
 }
 return n<1e4?Math.round(n).toLocaleString('en-US'):n<1e6?T("ui.window.formatTokens.text",{"value":Number((n/1e4).toFixed(1))}):n<1e8?T("ui.window.formatTokens.text",{"value":Math.round(n/1e4)}):T("ui.window.formatTokens.text2",{"value":Number((n/1e8).toFixed(1))});}
function formatValueUSD(n){n=valueNumber(n);return n<1?'':n<10?'$'+(Math.floor(n*10)/10).toFixed(1):'$'+Math.floor(n);}
function formatApiUnitPrice(n){n=valueNumber(n);return n.toLocaleString('en-US',{minimumFractionDigits:n>0&&n<1?2:0,maximumFractionDigits:6,useGrouping:false});}
function formatShare(n){n=valueNumber(n);return n<.1?T("ui.window.formatShare.text"):n<10?n.toFixed(1)+'%':Math.round(n)+'%';}
function quotaShort(n){const share=formatShare(n);return T("ui.window.quotaShort.text",{"value":valueNumber(n)<.1?'':' ',"share":share});}
function valueShareSentence(n){const share=formatShare(n);return T("ui.window.valueShareSentence.text",{"value":valueNumber(n)<.1?'':' ',"share":share});}
const valueHasData=v=>!!v&&(valueNumber(v.last7?.work)>0||valueNumber(v.lifetime?.work)>0);
function valueHeaderHTML(){const v=S.value;if(!v||v.show===false||!valueHasData(v))return '';const recent=valueNumber(v.last7?.work)>=1000,n=recent?v.last7.work:v.lifetime.work,sub=recent?T("ui.window.valueHeaderHTML.text",{"quotaShort":quotaShort(v.last7.share)}):T("ui.window.valueHeaderHTML.text2"),label=T("ui.window.valueHeaderHTML.text3",{"formatTokens":formatTokens(n),"sub":sub});
 return ("<button data-k=\"value-header\" class=\"value-header\" type=\"button\" data-action=\"drawer\" data-id=\"usage\" title=\""+(E(label))+"\" aria-label=\""+(E(label))+"\">"+(TH("ui.window.valueHeaderHTML.text4",{"openSpan":("<span class=\"value-head-number\">"),"openSmall":("<small>"),"closeSmall":("</small>"),"openB":("<b>"),"formatTokens":E(formatTokens(n)),"closeB":("</b>"),"closeSpan":("</span>"),"openSpan2":("<span class=\"value-head-bottom\">"),"openSpan3":("<span class=\"value-head-sub\" data-value-copy>"),"sub":E(sub),"closeSpan2":("</span>"),"icon":icon('i-chev','xs'),"closeSpan3":("</span>")}))+"<!-- <small class=\"value-head-quota\" data-value-copy>"+(E(valueQuotaNote(v)))+(("</small>"))+" --></button>");}
function valueSettingsSubtitle(){const v=S.value;return !valueHasData(v)?T("ui.window.valueSettingsSubtitle.text"):valueNumber(v.last7?.work)>0?T("ui.window.valueSettingsSubtitle.text2",{"formatTokens":formatTokens(v.last7.work),"quotaShort":quotaShort(v.last7.share)}):T("ui.window.valueSettingsSubtitle.text3",{"formatTokens":formatTokens(v.lifetime.work)});}
function taskValue(t){return t.value||(S.history||[]).find(h=>h.task_id===t.task_id)?.value||S.value?.active?.[t.task_id];}
/* 1052（Claude，Ken 10/14 嫌底栏一堆字段）：底栏只放按钮——有对话链接才放「回到对话」，再是「看全部过程」和右边的「停止」。
   这个任务的 token 数挪到卡片顶上那行小字的末尾，跟「来自对话「…」· 几点开始」在一起；数法不变。
   没有对话链接时底栏不再露出对话名（顶上那行已经写了），拦截卡的按钮行也一样。 */
function valueTaskMeta(t,prev=''){const n=S.value?.active?.[t.task_id]?.work;return valueNumber(n)>0?((TH("ui.window.valueTaskMeta.text",{"value":String(prev).endsWith('」')?'· ':' · ',"openSpan":("<span data-k=\"value-active-"+(E(t.task_id))+"\" class=\"value-task nw\">"),"formatTokens":E(formatTokens(n)),"closeSpan":("</span>")}))):'';}
function valueTaskDetail(t){if(!S.value)return '';const v=taskValue(t);if(valueNumber(v?.work)<=0)return '';const peers=t.group?.id?allTasks().filter(x=>x.group?.id===t.group.id&&valueNumber(taskValue(x)?.work)>0):[],sum=peers.reduce((n,x)=>n+valueNumber(taskValue(x).work),0);
 // 1081（Claude，Ken 10/27 11:39）：任务详情「用量」那行的内容：这个任务一行，同一个对话里不止一个任务时下面灰字写整个对话。
 return `${E(T("ui.window.taskInfo.usageValue",{"tokens":formatTokens(v.work),"calls":Math.round(valueNumber(v.calls)).toLocaleString('en-US')}))}${peers.length>1?`<small>${E(T("ui.window.taskInfo.usageChat",{"tokens":formatTokens(sum)}))}</small>`:''}`;}
function valueQuotaNote(v){const lead=v.plan?.source==='default'?T("ui.window.valueQuotaNote.text",{"value":v.plan.name||'Plus'}):T("ui.window.valueQuotaNote.text2",{"value":v.plan?.name||'Plus'});return lead+'，100% ≈ '+formatTokens(v.quota?.week_tokens)+' token';}
function valuePlanHint(v){return v?.plan?.source==='default'?T("ui.window.valuePlanHint.text",{"value":v.plan.name||'Plus'}):v?.plan?.source==='auto'?T("ui.window.valuePlanHint.text2",{"name":v.plan.name}):v?.plan?.source==='setting'?T("ui.window.valuePlanHint.text3",{"name":v.plan.name}):T("ui.window.valuePlanHint.text4");}
function valueSince(ms){const d=new Date(ms),now=new Date(Date.now());if(!Number.isFinite(d.getTime()))return '';if(d.toDateString()===now.toDateString())return T("ui.window.valueSince.text");return T(d.getFullYear()===now.getFullYear()?"ui.window.valueSince.sameYear":"ui.window.valueSince.withYear",{year:d.getFullYear(),month:d.getMonth()+1,day:d.getDate()});}
function valueDate(date){const a=String(date).split('-').map(Number);return new Date(a[0],a[1]-1,a[2]);}
function valueDateKey(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());}
/* 1052 补丁 2（Claude，10/16）：热力图按卡片可用宽度排。格子 11px、间距 3px 不变，列数取放得下的整列数，最少 13、最多 53；
   宽度由下面的 ResizeObserver 量好放进 valueHeatWidth（没量到时先按 13 列）。有数据之前的那些周画成空格子。 */
let valueHeatWidth=0;
function valueHeatCols(width){return Math.max(13,Math.min(53,Math.floor((width+3)/14)||0));}
function valueHeatHTML(v){const entries=(v.daily||[]).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x.date)),end=entries.length?valueDate(entries.at(-1).date):new Date(Date.now()),monday=new Date(end);monday.setHours(0,0,0,0);monday.setDate(monday.getDate()-(monday.getDay()+6)%7);const cols=valueHeatCols(valueHeatWidth),start=new Date(monday);start.setDate(start.getDate()-(cols-1)*7);const days=new Map(entries.map(x=>[x.date,valueNumber(x.work)])),visible=[];
 for(let i=0;i<cols*7;i++){const date=new Date(start);date.setDate(start.getDate()+i);const key=valueDateKey(date);visible.push({date,key,n:days.get(key)||0,future:date>end});}
 const values=visible.filter(x=>!x.future&&x.n>0).map(x=>x.n).sort((a,b)=>a-b),limits=[.25,.5,.75].map(q=>values[Math.max(0,Math.ceil(values.length*q)-1)]||0),level=n=>!n?0:n<=limits[0]?1:n<=limits[1]?2:n<=limits[2]?3:4,last=visible.findLastIndex(x=>!x.future),months=[];let month='';
 for(let i=0;i<visible.length;i++){const x=visible[i],d=x.date,col=Math.floor(i/7),key=d.getFullYear()+'-'+pad(d.getMonth()+1);if(!x.future&&key!==month){month=key;if(months.length&&col-months.at(-1).col<3)months.pop();months.push({key,col,label:d.getMonth()+1});}}
 // 最后一个月份要是离右边不到 3 列，就靠右对齐到最后一列，不伸出热力图；挨得太近的前一个去掉，不重叠。
 const tail=months.at(-1);if(tail&&tail.col>cols-3){tail.end=true;if(months.length>1&&months.at(-2).col>cols-5)months.splice(-2,1);}
 const summary=T("ui.window.valueHeatHTML.text",{"cols":cols,"formatTokens":formatTokens(v.last7?.work)});
 return ("<section data-k=\"value-daily\" class=\"value-daily\"><div class=\"value-section-head\"><h3 data-value-copy>"+(TH("ui.window.valueHeatHTML.text5"))+"</h3>"+(TH("ui.window.valueHeatHTML.text6",{"openSpan":("<span class=\"value-legend\" aria-hidden=\"true\">"),"openSpan2":("<span>"),"closeSpan":("</span>"),"value":[0,1,2,3,4].map(i=>`<i class="heat-${i}"></i>`).join(''),"openSpan3":("<span>"),"closeSpan2":("</span>"),"closeSpan3":("</span>")}))+"</div><div class=\"value-heat\" role=\"img\" aria-label=\""+(E(summary))+"\" style=\"--value-cols:"+(cols)+"\"><div class=\"value-days\">"+(visible.map((x,i)=>{const label=T("ui.window.valueHeatHTML.text2",{"month":x.date.getMonth()+1,"day":x.date.getDate()}),text=T("ui.window.valueHeatHTML.text3",{"formatTokens":formatTokens(x.n)});return `<button data-k="value-day-${x.key}" class="value-day heat-${level(x.n)}${Math.floor(i/7)>=cols-7?' flip':''}${x.future?' future':''}" type="button" tabindex="${i===last?'0':'-1'}" data-value-day="${i}" aria-label="${E(label+'，'+text)}"${x.future?' disabled':''}><span class="value-tip" aria-hidden="true"><b>${E(label)}</b><span>${E(text)}</span></span></button>`;}).join(''))+"</div><div class=\"value-months\" aria-hidden=\"true\">"+(months.map(m=>((TH("ui.window.valueHeatHTML.text4",{"openSpan":("<span style=\"grid-column:"+(m.end?(cols-2)+' / span 3;justify-self:end':m.col+1)+"\" data-k=\"value-month-"+(m.key)+"\">"),"label":m.label,"closeSpan":("</span>")})))).join(''))+"</div></div></section>");}

function valueExplanation(v){const io=valueNumber(v.last7?.io?.in)+valueNumber(v.last7?.io?.out),table=v.quota?.week_tokens_by_plan||{},names={plus:'Plus',pro_5x:'Pro 5x',pro_20x:'Pro 20x'},plans=Object.entries(names).filter(([id])=>valueNumber(table[id])>0).map(([id,name])=>T("ui.window.valueExplanation.text",{"name":name,"formatTokens":formatTokens(table[id])})),week=plans.length?plans.join('，'):T("ui.window.valueExplanation.text2",{"value":v.plan?.name||'Plus',"formatTokens":formatTokens(v.quota?.week_tokens)}),p=v.price||{},price=['input_per_m','cached_per_m','output_per_m'].every(k=>Number.isFinite(Number(p[k])));
 return ("<details data-k=\"value-explanation\" class=\"value-explanation\"><summary data-value-copy>"+(TH("ui.window.valueExplanation.text4",{"icon":icon('i-chev','xs')}))+"</summary><p data-value-copy>"+(TH("ui.window.valueExplanation.text5",{"formatTokens":E(formatTokens(io))}))+"</p><p data-value-copy>"+(TH("ui.window.valueExplanation.text6",{"formatTokens":E(formatTokens(v.last7?.work))}))+"</p><p data-value-copy>"+(TH("ui.window.valueExplanation.text7",{"week":E(week),"valueQuotaNote":E(valueQuotaNote(v))}))+"</p>"+(price?("<p data-value-copy>"+(TH("ui.window.valueExplanation.text3",{"model":E(p.model),"formatApiUnitPrice":E(formatApiUnitPrice(p.input_per_m)),"formatApiUnitPrice2":E(formatApiUnitPrice(p.cached_per_m)),"formatApiUnitPrice3":E(formatApiUnitPrice(p.output_per_m))}))+"</p>"):'')+"<p data-value-copy>"+(TH("ui.window.valueExplanation.text8"))+"</p></details>");}
function valueSettings(v){return ("<section data-k=\"value-settings\" class=\"sg value-settings\"><h3 data-value-copy>"+(TH("ui.window.nav.text4"))+"</h3>"+(setItem({ic:'i-home',label:T("ui.window.valueSettings.label.text"),right:sw('show_value',v?.show!==false,T("ui.window.valueSettings.label.text"))}))+(setItem({ic:'i-key',label:T("ui.window.valueSettings.label.text2"),sub:E(valuePlanHint(v)),right:("<select id=\"valuePlan\" aria-label=\""+(TH("ui.window.valueSettings.label.text2"))+"\">"+([['auto',T("ui.window.valueSettings.right.text")],['plus','Plus'],['pro_5x','Pro 5x'],['pro_20x','Pro 20x']].map(([id,name])=>`<option value="${id}"${(S.settings.value_plan||'auto')===id?' selected':''}>${name}</option>`).join(''))+"</select>")}))+(setItem({ic:'i-refresh',label:T("ui.window.valueSettings.label.text3"),sub:T("ui.window.valueSettings.sub.text"),right:`<div class="value-reset" aria-busy="${valueResetBusy}">${valueResetConfirm?`${btn(T("ui.window.valueSettings.right.text2"),'valueResetYes','','sm').replace('<button',valueResetBusy?'<button disabled':'<button')}${btn(T("ui.window.valueSettings.right.text3"),'valueResetNo','','sm').replace('<button',valueResetBusy?'<button disabled':'<button')}`:btn(T("ui.window.valueSettings.label.text3"),'valueReset','','sm')}</div>`}))+(valueResetError?`<p data-k="value-reset-error" class="value-reset-error" role="status">${E(valueResetError)}</p>`:'')+"</section>");}
function pgUsage(){const v=S.value;if(!valueHasData(v))return ("<p data-k=\"value-empty\" class=\"value-empty\" data-value-copy>"+(TH("ui.window.pgUsage.text"))+"</p>"+(valueSettings(v)));const share=valueNumber(v.last7?.share),scale=valueQuotaScale(share),usd=formatValueUSD(v.last7?.usd),c=v.last7?.calls||{},stats=[[T("ui.window.pgUsage.text2"),v.last7?.tasks],[T("ui.window.pgUsage.text3"),c.all],[T("ui.window.pgUsage.text4"),valueNumber(c.read)+valueNumber(c.write)],[T("ui.window.pgUsage.text5"),c.command],[T("ui.window.pgUsage.text6"),c.browser],[T("ui.window.pgUsage.text7"),c.desktop]];
 return ("<section data-k=\"value-summary\" class=\"value-summary\"><p class=\"value-kicker\" data-value-copy>"+(TH("ui.window.pgUsage.text10"))+"</p><p class=\"value-total\">"+(TH("ui.window.pgUsage.text11",{"openSpan":("<span>"),"closeSpan":("</span>"),"openB":("<b data-value-number>"),"formatTokens":E(formatTokens(v.last7?.work)),"closeB":("</b>"),"openStrong":("<strong>"),"closeStrong":("</strong>")}))+"</p><div class=\"value-quota\" role=\"img\" aria-label=\""+(E(valueShareSentence(share)))+"\" data-max=\""+scale.max+"\"><div class=\"value-quota-track\">"+(("<i style=\"width:"+(Math.min(100,share/scale.max*100))+"%;min-width:"+(share>0?2:0)+"px\">"))+(("</i>"))+"</div>"+(scale.max>100?"<div class=\"value-quota-ticks\" aria-hidden=\"true\">"+scale.ticks.map(n=>`<span style="left:${n/scale.max*100}%">${n?n+'%':'0'}</span>`).join('')+"</div>":'')+"</div><p class=\"value-meta\" data-value-copy>"+(TH(share<.1?"ui.window.pgUsage.text12Small":"ui.window.pgUsage.text12",{"openSpan":("<span>"),"formatShare":E(formatShare(share)),"value":v.plan?.source==='default'?T("ui.window.pgUsage.text8"):'',"closeSpan":("</span>"),"value2":usd?((TH("ui.window.pgUsage.text9",{"openSpan":("<span class=\"value-meta-api\">"),"openSpan2":("<span aria-hidden=\"true\">"),"closeSpan":("</span>"),"usd":usd,"closeSpan2":("</span>")}))):''}))+"</p></section>"+(valueHeatHTML(v))+"<section data-k=\"value-stats\" class=\"value-stats\"><h3 data-value-copy>"+(TH("ui.window.pgUsage.text13"))+"</h3><div class=\"value-stat-grid\">"+(stats.map(([name,n],i)=>`<div class="value-stat" data-k="value-stat-${i}"><b>${Math.round(valueNumber(n)).toLocaleString('en-US')}</b><small data-value-copy>${E(name)}</small></div>`).join(''))+"</div></section><section data-k=\"value-lifetime\" class=\"value-lifetime\"><h3 data-value-copy>"+(TH("ui.window.valueHeaderHTML.text2"))+"</h3><div>"+(icon('i-bars'))+"<p>"+(TH("ui.window.pgUsage.text14",{"openB":("<b>"),"formatTokens":E(formatTokens(v.lifetime.work)),"closeB":("</b>"),"openSmall":("<small>"),"valueSince":E(valueSince(v.since)),"value":Math.round(valueNumber(v.lifetime.tasks)).toLocaleString('en-US'),"closeSmall":("</small>")}))+"</p></div></section>"+(valueExplanation(v))+(valueSettings(v)));}
/* 1030：数字动画中途被打断（数据刷新、重画）时，直接落到最终值。原来会停在半路（Ken 10/7：6.2 亿有时显示成 4 亿）。 */
function stopValueNumber(){if(valueNumberFrame){cancelAnimationFrame(valueNumberFrame);const node=$('[data-value-number]');if(node?.isConnected)node.textContent=formatTokens(valueNumber(S.value?.last7?.work));}valueNumberFrame=0;}
function animateValueNumber(){stopValueNumber();if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;const node=$('[data-value-number]'),target=valueNumber(S.value?.last7?.work);if(!node||!target)return;const start=performance.now(),tick=now=>{if(drawer?.view!=='usage'||!node.isConnected){valueNumberFrame=0;return;}const progress=Math.min(1,(now-start)/600),text=formatTokens(target*(1-(1-progress)**3));if(node.textContent!==text){node.textContent=text;window.__renderStats.nodeWrites++;}valueNumberFrame=progress<1?requestAnimationFrame(tick):0;};node.textContent='0';window.__renderStats.nodeWrites++;valueNumberFrame=requestAnimationFrame(tick);}
const valueNoteCanvas=document.createElement('canvas');let valueNoteKey='',valueNoteWrap=false;
function fitValueNote(){const note=$('.value-share small');if(drawer?.view!=='usage'||!note)return;const width=note.parentElement.clientWidth,style=getComputedStyle(note),font=style.fontStyle+' '+style.fontWeight+' '+style.fontSize+' '+style.fontFamily,key=note.textContent+'|'+width+'|'+font;if(key!==valueNoteKey){const context=valueNoteCanvas.getContext('2d');context.font=font;valueNoteWrap=context.measureText(note.textContent).width>width;valueNoteKey=key;}if(note.classList.contains('value-note-wrap')!==valueNoteWrap){note.classList.toggle('value-note-wrap',valueNoteWrap);window.__renderStats.nodeWrites++;}}
new MutationObserver(fitValueNote).observe($('#drawerBody'),{childList:true,subtree:true,characterData:true});
/* 1052 补丁 2（Claude）：抽屉内容区宽度一变就重算热力图列数；列数真变了才重画，而且只重画热力图这一块（原来是窗口一变整页重画）。
   回调在排版之后、上屏之前跑，抽屉刚打开那一帧就是对的列数。宽度为 0（抽屉关着）不记。 */
new ResizeObserver(entries=>{const width=entries.at(-1).contentRect.width;if(!(width>0))return;const before=valueHeatCols(valueHeatWidth);valueHeatWidth=width;if(drawer?.view!=='usage'||!S?.value||valueHeatCols(width)===before)return;const section=$('#drawerBody [data-k="value-daily"]');if(!section)return;const t=document.createElement('template');t.innerHTML=valueHeatHTML(S.value);const fresh=t.content.firstElementChild;if(!fresh)return;ChatHandMorph.align(section,fresh.innerHTML);regionHTML.delete('drawerBody');}).observe($('#drawerBody'));
/* 文件范围：1025 起主页这一行和其它几项一样「值 + 右箭头」，点进二级页面改（Ken 10/7：不要下拉）。下面的下拉留着备用，主页不再用。 */
function scopeCap(){const full=scopeFull(),path=S.project?.path||'';return `<div class="scope"><button class="scope-btn" type="button" data-action="scopeMenu" aria-haspopup="menu" aria-expanded="${scopeOpen}"${full?'':` title="${E(path)}"`}>${full?'':icon('i-folder','xs')}<span class="scope-lbl" title="${E(full?T("ui.window.stepsOf.detail.text6"):workspaceName())}">${E(full?T("ui.window.stepsOf.detail.text6"):midText(workspaceName(),14))}</span>${icon('i-chev','xs scope-chev')}</button>${scopeOpen?scopeMenu():''}</div>`;}
function scopeMenu(){const full=scopeFull(),path=S.project?.path||'',ck=on=>`<span class="ck">${on?icon('i-check','xs'):''}</span>`;return ("<div class=\"menu\" role=\"menu\"><button class=\"mi\" type=\"button\" role=\"menuitemradio\" aria-checked=\""+(full)+"\" data-action=\"scopeFull\">"+(TH("ui.window.scopeMenu.text",{"ck":ck(full),"openSpan":("<span class=\"lbl\">"),"closeSpan":("</span>")}))+"</button>"+(path?`<button class="mi" type="button" role="menuitemradio" aria-checked="${!full}" data-action="scopeFolder" title="${E(path)}">${ck(!full)}${icon('i-folder','xs')}<span class="lbl">${E(midText(homePath(path),32))}</span></button>`:'')+"<div class=\"msep\" role=\"separator\"></div><button class=\"mi\" type=\"button\" role=\"menuitem\" data-action=\"scopePick\">"+(TH("ui.window.scopeMenu.text2",{"ck":ck(false),"openSpan":("<span class=\"lbl\">"),"closeSpan":("</span>")}))+"</button></div>");}

/* ---------- 抽屉：设置首页 → 详情页；帮助与反馈；任务过程 ---------- */
let DRAWER_TITLES={settings:T("ui.window.nav.text4"),conn:T("ui.window.connCard.label"),scope:T("ui.window.permCard.label3"),terminal:T("ui.window.permCard.text3"),browser:T("ui.window.permCard.text4"),desktop:T("ui.window.permCard.text5"),help:T("ui.window.rail.text"),task:T("ui.window.drawerTitles.task.text"),usage:T("ui.window.drawerTitles.usage.text"),alwaysAllowed:T("ui.window.drawerTitles.alwaysAllowed.text"),permissionPreset:T("ui.window.drawerTitles.permissionPreset.text"),language:T("ui.window.pgSettings.language")};
function drawerHTML(){const v=drawer?.view;if(v==='task'){const t=allTasks().find(x=>x.task_id===drawer.id);return t?pgTask(t):("<p class=\"empty\">"+(TH("ui.window.drawerHTML.text"))+"</p>");}
 return ({settings:pgSettings,conn:pgConn,scope:pgScope,terminal:pgTerminal,browser:pgBrowser,desktop:pgDesktop,help:pgHelp,usage:pgUsage,alwaysAllowed:pgAlwaysAllowed,permissionPreset:pgPermissionPreset,language:pgLanguage}[v]||pgSettings)();}
function setItem({ic,dark=false,label,sub='',right='',view=null}){const inner=`<span class="tile${dark?' dark':''}">${icon(ic)}</span><span class="si-t"><b>${E(label)}</b>${sub?`<small>${sub}</small>`:''}</span>${right}${view?icon('i-chev','xs si-chev'):''}`;return view?`<div class="si" role="button" tabindex="0" data-action="drawer" data-id="${view}">${inner}</div>`:`<div class="si">${inner}</div>`;}
function pgAlwaysAllowed(){const rows=Array.isArray(S.permissions?.history)?S.permissions.history:[],unknown=S.permissions?.history_status?.available===false,notice=unknown?("<p class=\"notice\">"+(TH("ui.window.pgAlwaysAllowed.text"))+"</p>"):'';if(!rows.length)return notice||("<p class=\"always-allowed-empty\">"+(TH("ui.window.pgAlwaysAllowed.text2"))+"</p>");const groups=new Map(),viaNames={chat:T("ui.window.pgAlwaysAllowed.chat.text"),window:T("ui.window.pgAlwaysAllowed.window.text"),notification:T("ui.window.pgAlwaysAllowed.notification.text"),home:T("ui.window.pgAlwaysAllowed.home.text"),tier:T("ui.window.pgAlwaysAllowed.tier.text")};
 for(const row of rows){const date=new Date(row.at),day=date.toLocaleDateString(window.ChatHandText.locale==='en'?'en-US':'zh-CN',{year:'numeric',month:'long',day:'numeric'});if(!groups.has(day))groups.set(day,[]);groups.get(day).push(row);}
 const render=row=>{const label=row.action==='tier'?T("ui.window.pgAlwaysAllowed.text3",{"value":row.tier==='full'?T("ui.window.permCard.text"):T("ui.window.permCard.text2")}):row.action==='restore'?T("ui.window.pgAlwaysAllowed.text4"):(row.action==='revoke'?T("ui.window.pgAlwaysAllowed.text5"):T("ui.window.pgAlwaysAllowed.text6"))+'「'+row.name+'」'+(row.scope==='once'?T("ui.window.pgAlwaysAllowed.text7"):''),revoked=row.action==='revoke'||row.action==='grant'&&row.scope!=='once'&&!row.active,time=new Date(row.at).toLocaleString(window.ChatHandText.locale==='en'?'en-US':'zh-CN',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}),source=row.conversation?`<button class="tbtn" type="button" data-action="openChatURL" data-id="${E(row.conversation.url)}">${E(row.conversation.title)}</button>`:E(viaNames[row.via]||'');return `<div class="permission-history-row${revoked?' revoked':''}" data-k="permission-history-${E(row.event_id)}"><div><b>${E(label)}</b><small>${E(time)} · ${source}${revoked?T("ui.window.pgAlwaysAllowed.text8"):''}</small></div>${row.active?ibtn('i-chev',T("ui.window.pgAlwaysAllowed.text9"),'permissionHistorySettings',row.event_id,'sm'):''}</div>`;};
 return notice+[...groups].map(([day,items])=>`<section class="sg permission-history"><h4>${E(day)}</h4>${items.map(render).join('')}</section>`).join('');}

/* 1052（Claude，Ken 10/14）：「接力试用」改成「任务」下面一个开关「自动接着做」，1052 起默认开（方案 §7-5、A4-4）；开关走现有的 relay_pilot_enable，关了就一直关着。
   设置页的重画字段里加了 relay_pilot（REGION_FIELDS.settings），不然拨了开关下面那行说明不跟着变。 */
/* 0008/0009（Claude，10/18）：语言在 设置 → 通用 → 多语言，点进去三项：跟随系统、English、中文（顺序是 Ken 定的）。原生回了 preference 才显示这一行；选了以后整个窗口马上换，菜单栏、通知由原生跟着换。「English」「中文」在哪种语言下都写它自己的字。 */
let languagePreference=null,languageBusy=false;const LANGUAGE_CHOICES=['zh','en','system'];
function languageOptions(){return [['system',T("ui.window.pgSettings.languageSystem"),''],['en',T("ui.window.pgSettings.languageEn"),'en'],['zh',T("ui.window.pgSettings.languageZh"),'zh-CN']];}
function languageItem(){const current=languageOptions().find(([id])=>id===languagePreference);if(!current)return '';return setItem({ic:'i-lang',label:T("ui.window.pgSettings.language"),right:`<span class="si-v"${current[2]?` lang="${current[2]}"`:''}>${E(current[1])}</span>`,view:'language'});}
function pgLanguage(){if(!LANGUAGE_CHOICES.includes(languagePreference))return '';return "<p class=\"dp-desc\">"+(TH("ui.window.pgLanguage.text"))+"</p><div class=\"language-opts\" role=\"group\" aria-label=\""+(TH("ui.window.pgSettings.language"))+"\">"+languageOptions().map(([id,text,lang])=>{const on=languagePreference===id;return `<button class="opt${on?' on':''}" type="button" data-action="language" data-id="${id}"${lang?` lang="${lang}"`:''} aria-pressed="${on}"><span class="opt-ck">${on?icon('i-check','xs'):''}</span><span class="opt-t"><b>${E(text)}</b></span></button>`;}).join('')+"</div>";}
/* 10/30（Ken：颜色模式做成三个图标）：「外观」的浅色、深色、跟随系统是太阳、月亮、半边涂黑的圆，名字在鼠标提示（data-tip）和读屏（aria-label）里。 */
function pgSettings(){const m=connModel(),tm=capTerminal(),bm=capBrowser(),dm=capDesktop(),li=nativeStatus?.login_item,a=S.about||{},pilotEnabled=S.relay_pilot?.pilot_enabled===true;
 return ("<section class=\"sg sg-inline\"><h4>"+(TH("ui.window.pgSettings.text4"))+"</h4><div class=\"appearance-seg seg\" role=\"group\" aria-label=\""+(TH("ui.window.pgSettings.text4"))+"\">"+([['light','i-sun',T("ui.window.pgSettings.text")],['dark','i-moon',T("ui.window.pgSettings.text2")],['system','i-contrast',T("ui.window.pgSettings.text3")]].map(([mode,ic,label])=>`<button type="button" data-action="appearance" data-id="${mode}" aria-pressed="${(S.settings.appearance||'system')===mode}" aria-label="${E(label)}" data-tip="${E(label)}">${icon(ic,'sm')}</button>`).join(''))+"</div></section>"+"<section class=\"sg\"><h4>"+(TH("ui.window.nav.text3"))+"</h4>"+(setItem({ic:connectionIcon(),dark:true,label:T("ui.window.connCard.label"),sub:`${statDot(m)}${E(m.label)}`,view:'conn'}))+"</section>\n <section class=\"sg\"><h4>"+(TH("ui.window.permCard.label"))+"</h4>"+(setItem({ic:'i-sliders',label:T("ui.window.drawerTitles.permissionPreset.text"),right:`<span class="si-v">${shownTier()==='full'?T("ui.window.permCard.text"):T("ui.window.permCard.text2")}</span>`,view:'permissionPreset'}))+(setItem({ic:'i-folder',label:T("ui.window.permCard.label3"),sub:E(scopeFull()?T("ui.window.pgSettings.sub.text"):T("ui.window.pgSettings.sub.text2",{"workspaceName":workspaceName()})),right:`<span class="si-v">${E(scopeFull()?T("ui.window.stepsOf.detail.text6"):midText(workspaceName(),14))}</span>`,view:'scope'}))+(setItem({ic:'i-terminal',label:T("ui.window.permCard.text3"),sub:E(tm.sub)+(tm.tag?' '+tag(tm.tag):''),right:sw('terminal_enabled',tm.on,T("ui.window.permCard.text3")),view:'terminal'}))+(setItem({ic:'i-globe',label:T("ui.window.permCard.text4"),sub:E(bm.sub),right:sw('browser_enabled',bm.on,T("ui.window.permCard.text4")),view:'browser'}))+(setItem({ic:'i-monitor',label:T("ui.window.permCard.text5"),sub:E(dm.sub),right:sw('desktop_enabled',dm.on,T("ui.window.permCard.text5")),view:'desktop'}))+(setItem({ic:'i-shield',label:T("ui.window.drawerTitles.alwaysAllowed.text"),view:'alwaysAllowed'}))+(permissionNotices())+"</section><section class=\"sg\"><h4>"+(TH("ui.window.nav.text2"))+"</h4>"+(setItem({ic:'i-refresh',label:T("ui.window.pgSettings.label.text"),sub:pilotEnabled?T("ui.window.pgSettings.sub.text3"):T("ui.window.pgSettings.sub.text4"),right:sw('relay_pilot_enable',pilotEnabled,T("ui.window.pgSettings.label.text"))}))+"</section>\n <section class=\"sg\"><h4>"+(TH("ui.window.pgSettings.text5"))+"</h4>"+(languageItem())+(li?.supported?setItem({ic:'i-power',label:T("ui.window.pgSettings.label.text2"),sub:E(li.requires_approval?T("ui.window.pgSettings.sub.text5"):T("ui.window.pgSettings.sub.text6")),right:sw('launch_at_login',li.enabled,T("ui.window.pgSettings.label.text2"))}):'')+(setItem({ic:'i-link',label:T("ui.window.pgSettings.label.text3"),sub:T("ui.window.pgSettings.sub.text7"),right:sw('auto_connect',S.settings.auto_connect,T("ui.window.pgSettings.right.text"))}))+(setItem({ic:'i-cup',label:T("ui.window.pgSettings.label.text4"),sub:T("ui.window.pgSettings.sub.text8"),right:sw('keep_awake',S.settings.keep_awake!==false,T("ui.window.pgSettings.right.text2"))}))+(setItem({ic:'i-bell',label:T("ui.window.pgSettings.label.text5"),sub:T("ui.window.pgSettings.sub.text9"),right:sw('notifications',S.settings.notifications!==false,T("ui.window.pgSettings.label.text5"))}))+(setItem({ic:'i-bars',label:T("ui.window.drawerTitles.usage.text"),sub:E(valueSettingsSubtitle()),view:'usage'}))+"</section>\n <section class=\"sg\"><h4>"+(TH("ui.window.pgSettings.text6"))+"</h4>"+(setItem({ic:'i-info',label:`ChatHand ${a.version||S.version||''}`,sub:E(updateLine()),right:updateBtn()}))+(setItem({ic:'i-refresh',label:T("ui.window.pgSettings.label.text6"),sub:T("ui.window.pgSettings.sub.text10"),right:sw('auto_update',S.settings.auto_update!==false,T("ui.window.pgSettings.label.text6"))}))+(setItem({ic:'i-help',label:T("ui.window.rail.text"),view:'help'}))+"</section>");}
function dpHead(ic,label,key,m){return `<div class="dp-h"><span class="tile lg">${icon(ic)}</span><b>${E(label)}</b>${key?sw(key,m.on,label):''}</div>`;}
// notes：几种情况各占一行；acts：几个按钮排一行；spin：正在做（转圈，不写做法）。
function dpRes(m,id){const tone=m.spin?'':m.ok?'ok':m.on===false||m.sup===false?'':'warn',notes=m.notes||(m.note?[m.note]:[]),acts=m.acts||[];const ic=m.spin?'<i class="sdot spin" aria-hidden="true"></i>':icon(m.ok?'i-check-circle':tone==='warn'?'i-bang-circle':'i-info','sm');return `<div class="dp-res ${tone}${notes.length&&(m.act||acts.length)?' stack':''}${flash===id?' flash':''}"${m.spin?' role="status"':''}>${ic}<div><b>${m.html?m.res:E(m.res)}</b>${notes.map(n=>`<small>${E(n)}</small>`).join('')}</div>${m.act?btn(m.act[0],m.act[1],'','sm'):''}${acts.length?`<span class="dp-res-acts">${acts.map(a=>btn(a[0],a[1],'','sm')).join('')}</span>`:''}</div>`;}
function pgTerminal(){const m=capTerminal(),full=scopeFull(),hr=S.settings?.high_risk||{},danger=riskList().filter(item=>item.group==='danger'),on=risksOn(),admin=adminNeedsSetup();
 const desc=T("ui.window.pgTerminal.text3",{"value":full?T("ui.window.pgTerminal.text"):T("ui.window.pgTerminal.text2",{"workspaceName":workspaceName()})});
 const common=(id,ic,title,sub)=>`<div class="common-row" id="risk-${id}"><span class="tile">${icon(ic)}</span><div><b>${title}</b><p>${sub}</p>${id==='admin'&&!hr.admin?((TH("ui.window.pgTerminal.text4",{"openSmall":("<small>"),"closeSmall":("</small>")}))):''}${id==='admin'&&admin?("<p class=\"warn-text\">"+(TH("ui.window.pgTerminal.text5"))+"</p>"):''}</div>${sw('risk:'+id,hr[id]===true,title)}</div>`;
 return ((dpHead('i-terminal',T("ui.window.permCard.text3"),'terminal_enabled',m))+"<p class=\"dp-desc\">"+(E(desc))+"</p>"+(dpRes(m,'terminal'))+"<section class=\"common\" aria-label=\""+(TH("ui.window.pgTerminal.label"))+"\"><h4>"+(TH("ui.window.pgTerminal.label"))+"</h4>"+(common('admin','i-shield',T("ui.window.pgTerminal.text6"),T("ui.window.pgTerminal.text7")))+(common('autostart','i-power',T("ui.window.pgTerminal.text8"),T("ui.window.pgTerminal.text9")))+"</section>\n <div class=\"ybar\">"+(TH("ui.window.pgTerminal.text15",{"icon":icon('i-alert','sm'),"openSpan":("<span>"),"closeSpan":("</span>")}))+"</div>\n <section class=\"risk"+(m.on?'':' off')+"\" aria-label=\""+(TH("ui.window.pgTerminal.label2"))+"\"><div class=\"risk-h\"><h4>"+(TH("ui.window.pgTerminal.label2"))+"</h4>"+(("<span class=\""+(on.length?'warn-text':'muted')+"\">"))+(on.length?T("ui.window.pgTerminal.text10",{"length":on.length}):T("ui.window.pgTerminal.text11"))+(("</span>"))+"</div>"+(!full&&S.permissions?.high_risk_note?`<p class="dp-note">${E(S.permissions.high_risk_note)}</p>`:'')+(m.on?'':("<p class=\"dp-note\">"+(TH("ui.window.pgTerminal.text12"))+"</p>"))+"\n "+(danger.map(item=>{const permission=(S.permissions?.high_risk||[]).find(r=>r.id===item.id);return ("<div class=\"risk-row\" id=\"risk-"+(E(item.id))+"\">"+(("<span class=\"risk-icon\">"))+(icon(item.id==='power'?'i-power':item.id==='keychain'?'i-key':item.id==='bulk_delete'?'i-file':'i-shield'))+(("</span>"))+"<div class=\"txt\">"+(TH("ui.window.pgTerminal.text14",{"openB":("<b>"),"name":E(item.name),"closeB":("</b>"),"openSpan":("<span class=\"risk-level "+(item.level==='极高'?'extreme':item.level==='高'?'high':'medium')+"\">"),"level":E(item.level_text||item.level),"closeSpan":("</span>"),"value":hr[item.id]&&permission?.usable_now===false?((TH("ui.window.pgTerminal.text13",{"openSpan":("<span class=\"unusable-tag\">"),"closeSpan":("</span>")}))):'',"openSpan2":("<span class=\"cmds\">"),"value2":String(item.cmd||'').split(' · ').map(code=>`<code>${E(code)}</code>`).join(''),"closeSpan2":("</span>"),"openSpan3":("<span>"),"openEm":("<em>"),"closeEm":("</em>"),"what":E(item.what),"closeSpan3":("</span>"),"openSpan4":("<span>"),"openEm2":("<em>"),"closeEm2":("</em>"),"harm":E(item.harm),"closeSpan4":("</span>")}))+"</div>"+(sw('risk:'+item.id,hr[item.id]===true,item.name))+"</div>");}).join(''))+"</section>\n <p class=\"dp-foot\">"+(TH("ui.window.pgTerminal.text16",{"value":E((S.permissions?.never||[]).join('、'))}))+"</p>");}
function folderScopeNote(){return scopeFull()?'':("<p class=\"dp-note\">"+(TH("ui.window.folderScopeNote.text",{"value":E(workspaceName())}))+"</p>");}
/* 0010（Claude，#56）：ChatHand 正在自己刷新工具、或者正在等助手自己换新版的时候，首页不再同时摆「去刷新工具」「助手需要更新」，跟更新气泡说的一致。 */
function refreshInProgress(){const tr=S.tools_refresh||{};return tr.state==='pending'||tr.state==='running'&&tr.waiting!=='helper_manual';}
// 1082（Claude，Ken 10/28）：工具表「还没确认」（unknown）只是 ChatGPT 还没来取过工具表——刚连上、重连、开机时都会这样，连接本身是好的。
// 原来首页卡片下面会出一行灰字，看着像出错；现在首页不显示，连接抽屉里连接在线时给一句中性的说明（所有连接方式都一样）。确认过期（stale）的橙色条照旧。
function toolListNotice(){const t=S.tools_list_status;if(!t||t.state==='current'||t.state==='unknown'||refreshInProgress()||!(S.settings?.tunnel||S.relay?.paired||siteConfigured()))return '';const key=toolsStaleKey(t);if(isSeen(key))return '';return `<div class="connection-strip stale" role="status"><span class="connection-strip-t">${E(t.message)}</span><span class="connection-strip-acts">${btn(T("ui.window.toolListNotice.text"),'openRefreshTools','','sm')}${tbtn(T("ui.window.toolListNotice.reconnect"),'appMissingAI')}</span><button class="ibt" type="button" data-action="toolsStaleDismiss" data-id="${E(key)}" aria-label="${E(T("ui.window.toolListNotice.dismiss"))}">${icon('i-x','sm')}</button></div>`;}
// 1068（Claude）：工具列表过期的条，按 schema 记「看过了」；schema 再变才会再出来。
function toolsStaleKey(t){const src=String(t?.current_schema_sha256??t?.message??'');let h=0x811c9dc5;for(let i=0;i<src.length;i++){h^=src.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}return 'tools-stale:'+h.toString(16).padStart(8,'0');}
/* 1070（Claude，Ken 10/22）：Chrome 插件要你动手更新时，不再在首页常挂一条橙色提示；在右下角浮一次（跟 App 更新同一个气泡），点「知道了」或「查看更新步骤」就收起，这一版插件不再出。浏览器控制那行照旧标「要更新」。插件自己会换新的那几种（stale 且支持 self_reload、reloading）不浮。 */
function helperNeedsHand(h){return ['outdated','wrong_folder','reload_failed'].includes(h?.state)||(h?.state==='stale'&&h.self_reload_supported===false);}
function helperHomeNotice(){const h=S.automation?.browser?.extension?.helper;if(!helperNeedsHand(h)||refreshInProgress())return '';const key='helperUpdate:'+String(h.expected_build||h.expected_version||'old').replace(/[^A-Za-z0-9_.-]/g,'').slice(0,64);if(isSeen(key))return '';return `<b>${E(T("ui.window.helperHomeNotice.title"))}</b><p>${E(T("ui.window.helperHomeNotice.text"))}</p><div class="bb-acts">${btn(T("ui.window.helperHomeNotice.dismiss"),'helperNoticeDismiss',key,'sm')}${btn(T("ui.window.helperHomeNotice.text2"),'helperNoticeSteps',key,'sm primary')}</div>`;}
/* 1052 补丁 2（Claude，10/16）：底部原来的两个按钮去掉了：叫停 AI 浏览器动作的那个（不想让 AI 用浏览器，关上面的总开关就行），
   和打开弹窗的灰字按钮（它和前一个并排时像标签）。改成信息表第一行「连接方式」，整行能点，右边小箭头，点开连接方式弹窗；版本在表里已经有。
   助手没连上时，「重新连接」在上面的状态框里。 */
function pgBrowser(){const m=capBrowser(),x=S.automation?.browser?.extension||{},v=S.automation?.browser?.personal?.chrome?.version,bs=browserState(),registration=x.host_registration||{},labels={registered:T("ui.window.pgBrowser.registered.text"),pending:T("ui.window.pgBrowser.pending.text"),failed:T("ui.window.capBrowser.tag.text")},backend=S.settings?.browser_backend||'extension',method=(browserBackends().find(([id])=>id===backend)||browserBackends()[0])[1];
 return ((browserRepairNotice?("<div class=\"browser-repair connection-strip\">"+(x.distribution==='chrome_web_store'?(storeTrouble(x)?TH("ui.window.pgBrowser.text",{"openSpan":("<span>"),"closeSpan":("</span>"),"btn":''}):TH("ui.window.pgBrowser.lostStore",{"openSpan":("<span>"),"closeSpan":("</span>")})):TH("ui.window.pgBrowser.text",{"openSpan":("<span>"),"closeSpan":("</span>"),"btn":(x.connection_state==='not_installed'?btn(T("ui.window.capBrowser.act.text2"),'extensionSetup','','sm'):btn(T("ui.window.capBrowser.act.text"),'browserReconnect','','sm'))}))+"</div>"):'')+(dpHead('i-globe',T("ui.window.permCard.text4"),'browser_enabled',m))+"<p class=\"dp-desc\">"+(TH("ui.window.pgBrowser.text12"))+"</p>"+(dpRes(m,'browser'))+"\n <div class=\"kv\"><div class=\"kvr kv-go\" data-k=\"kv-连接方式\" role=\"button\" tabindex=\"0\" data-action=\"browserSheet\" aria-haspopup=\"dialog\" aria-label=\""+(TH("ui.window.pgBrowser.label",{"method":E(method)}))+"\">"+(TH("ui.window.pgBrowser.text13",{"openSpan":("<span class=\"k\">"),"closeSpan":("</span>"),"openSpan2":("<span class=\"v\" title=\""+(E(method))+"\">"),"method":E(method),"closeSpan2":("</span>"),"icon":icon('i-chev','xs kv-chev')}))+"</div>"+(kvRow(T("ui.window.pgBrowser.text2"),E(bs==='connected'?T("ui.window.connModel.label.text4"):bs==='down'&&x.distribution==='chrome_web_store'?(storeTrouble(x)==='noChrome'?T("ui.window.capBrowser.noChrome.tag"):storeTrouble(x)==='wakeFailed'?T("ui.window.capBrowser.wakeFailed.tag"):T("ui.window.pgBrowser.installed")):bs==='down'?T("ui.window.capBrowser.tag.text3"):x.distribution==='chrome_web_store'?T("ui.chrome.store.neverSeen"):T("ui.window.pgBrowser.text3"))))+(x.helper?(x.helper.build?kvRow(T("ui.window.pgBrowser.text4"),((TH("ui.window.pgBrowser.text6",{"openSpan":("<span>"),"build":E(x.helper.build),"closeSpan":("</span>"),"value":x.distribution==='chrome_web_store'&&x.compatibility?.state==='incompatible'?TH("ui.chrome.store.versionOld",{"openSmall":"<small class=\"warn-text\">","closeSmall":"</small>"}):x.distribution==='chrome_web_store'&&x.compatibility?.state==='partial'?TH("ui.chrome.store.versionNewer",{"openSmall":"<small class=\"note-text\">","closeSmall":"</small>"}):x.helper.stale?((TH("ui.window.pgBrowser.text5",{"openSmall":("<small class=\"warn-text\">"),"closeSmall":("</small>")}))):''})))):x.helper.state==='outdated'?kvRow(T("ui.window.pgBrowser.text4"),T("ui.window.pgBrowser.text7")):''):'')+(v?kvRow(T("ui.window.pgBrowser.text8"),E(v)):'')+(x.last_seen?kvRow(T("ui.window.pgBrowser.text9"),timed(x.last_seen,'ago',ago(x.last_seen),'','browser')):'')+(labels[registration.status]?kvRow(T("ui.window.pgBrowser.text10"),`<span>${E(labels[registration.status])}</span>`):'')+"</div>"+(reconnectConfirm&&x.distribution!=='chrome_web_store'?("<p class=\"dp-note\">"+(TH("ui.window.pgBrowser.text11"))+"</p>"):'')+"\n "+(helperFolderGuide(x.helper))+(folderScopeNote()));}
function pgDesktop(){const m=capDesktop(),p=perms();return ((dpHead('i-monitor',T("ui.window.permCard.text5"),'desktop_enabled',m))+"<p class=\"dp-desc\">"+(TH("ui.window.pgDesktop.text5"))+"</p>"+(dpRes(m,'desktop'))+(m.sup===false?'':("<div class=\"kv\">"+(kvRow(T("ui.window.capDesktop.text"),E(p.accessibility?T("ui.window.pgDesktop.text"):T("ui.window.pgDesktop.text2")),p.accessibility?'':btn(T("ui.window.blockCard.text3"),'computerPermissions','','sm')))+(kvRow(T("ui.window.capDesktop.text2"),E(p.screen_recording?T("ui.window.pgDesktop.text"):T("ui.window.pgDesktop.text2")),p.screen_recording?'':btn(T("ui.window.blockCard.text3"),'computerPermissions','','sm')))+"</div><p class=\"dp-note\">"+(TH("ui.window.pgDesktop.text4",{"tbtn":tbtn(T("ui.window.pgDesktop.text3"),'repairPermissions')}))+"</p>"))+(folderScopeNote()));}
function pgScope(){const full=scopeFull(),path=S.project?.path||'';
 const opt=(on,action,title,sub)=>`<button class="opt${on?' on':''}" type="button" data-action="${action}" aria-pressed="${on}"><span class="opt-ck">${on?icon('i-check','xs'):''}</span><span class="opt-t"><b>${E(title)}</b><small>${E(sub)}</small></span></button>`;
 return ("<p class=\"dp-desc\">"+(TH("ui.window.pgScope.text7"))+"</p>"+(opt(full,'scopeFull',T("ui.window.stepsOf.detail.text6"),T("ui.window.pgScope.text")))+(opt(!full,'scopeFolder',T("ui.window.pgScope.text2"),T("ui.window.pgScope.text3")))+"\n <div class=\"kv\">"+(kvRow(T("ui.window.pgScope.text4"),`<span class="mono" title="${E(path)}">${E(homePath(path)||T("ui.window.pgScope.text5"))}</span>`))+"</div><div class=\"dp-acts\">"+(btn(T("ui.window.pgScope.text6"),'scopePick','','sm'))+(path?btn(T("ui.window.outputsPanel.label3"),'revealWorkspace','','sm ghost'):'')+"</div>");}
/* 1070 十四（Claude）：设置 → ChatGPT 连接。顶上选看哪条（CONN_LAYOUT），下面是这条的详情。
   原来那一页（一条结果 + 「方式」「重新配」+ Site 那一行「断开」）换成这个；Site 的断开就是「删除」。 */
// 结果条：tone 是 ok（绿）/ warn（橙）/ spin（正在连）/ ''（灰）。title 是纯文字；sub 是已经转义过的 HTML。
// 1081（Claude，Ken 10/26）：cur 是「使用中」的标签。原来写成「正在用，连接正常」一句话，把「选了哪条」和「连得怎么样」混在一起。
// 1081（Claude，Ken 10/27 10:37）：「使用中」放在卡片右上角，做成贴着角的角标，不跟在标题后面；连得好不好、在不在连，都一样放。
// 1082（Claude，Ken 10/28 11:11）：side 是按钮放在卡片右边、竖着居中（备用那条的「使用」），有说明也不挪到下一行。
function connRes(tone,title,sub='',act='',cur=false,side=false){const ic=tone==='spin'?'<i class="sdot spin" aria-hidden="true"></i>':icon(tone==='ok'?'i-check-circle':tone==='warn'?'i-bang-circle':'i-info','sm');
 return `<div class="dp-res conn-res${tone&&tone!=='spin'?' '+tone:''}${cur?' cur':''}${side?' side':sub&&act?' stack':''}${flash==='conn'?' flash':''}">${cur?`<span class="conn-corner">${E(T("ui.window.conn.inUseTag"))}</span>`:''}${ic}<div><b>${E(title)}</b>${sub?`<small>${sub}</small>`:''}</div>${act}</div>`;}
// 好着的那条下面一句：云端多久前确认过。OpenAI 通道用 OpenAI 那边最近一次确认的时间（跟首页卡片一样会走）；Site 30 秒内查过才算好，就是刚确认。
// 1081（Claude，Ken 10/26）：前面不再写「云端」（Site 不是云端，OpenAI 通道那条也只是想说多久前确认过），只写「刚确认」「3 分钟前确认」。
function connConfirmed(r){if(r==='site')return siteHealthy()?E(T("ui.window.confirmedAgo.text")):'';
 const at=S.connection?.display?.last_confirmed_at;return at?timed(at,'ago',confirmedAgo(at),'','confirmation'):'';}
// 在用的那条的点，跟首页卡片一样（绿 / 橙 / 转圈 / 云端待确认）。
function connInUseDot(){const m=connModel(),w=selectedConnection()!=='site'&&!S.relay?.online?S.connection?.display?.settings_warning:null;return statDot(w&&m.st==='online'?{...m,dot:'cloud-wait'}:m);}
function routeDot(r){if(routeInUse(r))return connInUseDot();const st=routeStatus(r).st;return st==='connecting'?'<i class="sdot spin" aria-hidden="true"></i>':`<i class="sdot${st==='online'?' ok':st==='broken'?' warn':''}" aria-hidden="true"></i>`;}
// 一句话说这条现在怎么样（标签的提示、A 的卡片、C 的列表都用）。
function connStatusText(r){if(!routeAdded(r))return T("ui.window.conn.stNone");const st=routeStatus(r).st;
 if(selectedConnection()===r){if(paused())return T("ui.window.conn.stInUseOf",{state:T("ui.window.connModel.label.text2")});
  if(st==='idle')return T("ui.window.conn.idle");
  return T("ui.window.conn.stInUseOf",{state:T(st==='online'?"ui.window.connModel.label.text4":st==='connecting'?"ui.window.connModel.label.text5":"ui.window.connModel.label.text6")});}
 return T({online:"ui.window.conn.stOn",connecting:"ui.window.conn.stConnecting",idle:"ui.window.conn.stIdle",broken:"ui.window.conn.stBroken"}[st]);}
// B（在用）：两个标签，在用的那个带点。
function connTabs(cur){return `<div class="seg conn-tabs" role="group" aria-label="${E(T("ui.window.conn.tabs"))}">${CONN_ORDER.map(r=>`<button type="button" data-action="connTab" data-id="${r}" aria-pressed="${cur===r}" title="${E(connStatusText(r))}">${routeInUse(r)?connInUseDot():''}<span>${E(connRouteName(r))}</span></button>`).join('')}</div>`;}
// A（不用）：两张卡，各写一句现在怎么样。
function connCards(cur){return `<div class="conn-cards" role="group" aria-label="${E(T("ui.window.conn.tabs"))}">${CONN_ORDER.map(r=>`<button class="conn-card${cur===r?' on':''}" type="button" data-action="connTab" data-id="${r}" aria-pressed="${cur===r}"><span class="tile lg">${icon(connRouteIcon(r))}</span><span class="conn-card-t"><b>${E(connRouteName(r))}</b><small>${routeAdded(r)?routeDot(r):icon('i-plus','xs')}${E(connStatusText(r))}</small></span></button>`).join('')}</div>`;}
// C（不用）：只放当前这条，右边「更换」点开一个小列表，最下面「添加连接方式」。
function connMenuBlock(cur){const missing=CONN_ORDER.find(r=>!routeAdded(r));
 const items=CONN_ORDER.filter(routeAdded).map(r=>`<button type="button" role="menuitemradio" aria-checked="${cur===r}" data-action="connTab" data-id="${r}"><span class="ck">${cur===r?icon('i-check','xs'):''}</span><b>${E(connRouteName(r))}</b><small>${E(connStatusText(r))}</small></button>`).join('')+(missing?`<button type="button" role="menuitem" data-action="connTab" data-id="${missing}"><span class="ck">${icon('i-plus','xs')}</span><b>${E(T("ui.window.conn.addRoute"))}</b></button>`:'');
 return `<div class="conn-cur"><span class="tile lg">${icon(connRouteIcon(cur))}</span><span class="conn-card-t"><b>${E(connRouteName(cur))}</b><small>${routeAdded(cur)?routeDot(cur):icon('i-plus','xs')}${E(connStatusText(cur))}</small></span><button class="btn sm" type="button" data-action="connMenu" aria-haspopup="menu" aria-expanded="${connMenu}">${E(T("ui.window.conn.change"))}${icon('i-chev','xs conn-chev')}</button>${connMenu?`<div class="conn-menu" role="menu">${items}</div>`:''}</div>`;}
// 默认看在用的那条；在用的那条没加（刚删掉、还没配），看加了的那条；都没加，看要配的那条。
function connCurrentTab(){if(CONN_ORDER.includes(connTab))return connTab;const sel=selectedConnection();return routeAdded(sel)?sel:CONN_ORDER.find(routeAdded)||sel;}
// 在用的这条好着、在连、暂停了时的结果条；连不上（要修）回 null。每一种都带「使用中」的标签。
// 1081（Claude，Ken 10/26）：好着的时候下面写「云端 N 分钟前确认」，不再写「ChatGPT 还没用过它」（测通过了还这么说，没道理）。
// 1081（Claude，Ken 10/27 11:43）：在用的这条停着（已暂停、没连上、被挡住、ChatGPT 里找不到插件），卡片上那个按钮是让它接着能用的唯一一步，用黑色主按钮；连得好、只是还没测的「测一下」留灰的。
function connUseRes(r){const m=connModel(),site=r==='site';
 const ok=()=>connRes('ok',T("ui.window.conn.useOk"),connConfirmed(r),'',true);
 const idle=()=>connRes('',T("ui.window.conn.idleRes"),E(T("ui.window.conn.idleNote")),btn(T("ui.window.capBrowser.act.text"),'restoreSaved','','sm primary'),true);
 if(m.st==='connecting')return connRes('spin',m.label,m.sub&&m.sub!==m.label?E(m.sub):'','',true);
 if(linkHeld())return connRes('warn',m.label,E(m.sub),btn(T("ui.window.capBrowser.act.text"),'restoreSaved','','sm primary'),true);
 if(paused())return connRes('',m.label,E(m.sub),btn(T("ui.window.action.resumeAI.button"),'resumeAI','','sm primary'),true);
 if(siteBlock())return null;
 if(m.st==='online'&&appMissing())return connRes('warn',m.label,E(m.sub),btn(appUnbound()?T("ui.window.appMissing.unbound.fix"):T("ui.window.appMissing.fix"),'appMissing','','sm primary'),true);
 if(!site&&!S.relay?.online&&S.connection?.display){const d=S.connection.display,w=d.settings_warning;
  if(d.connected)return w?connRes('',w.title,E(w.detail||''),'',true):ok();
  return routeStatus(r).st==='idle'?idle():null;}
 if(site&&!siteHealthy()&&routeStatus(r).st==='connecting')return connRes('spin',T("ui.window.connModel.label.text5"),E(T("ui.window.connModel.sub.text6")),'',true);
 if(m.st==='online'&&site&&!siteTested())return connRes('ok',T("ui.window.conn.untested"),E(T("ui.window.conn.untestedNote")),btn(T("ui.window.conn.untestedAct"),'testConnection','','sm'),true);
 if(m.st==='online')return ok();
 return !site&&routeStatus(r).st==='idle'?idle():null;}
function connUseWhy(r){const b=siteBlock();if(b)return siteBlockText(b);if(r==='site')return routeStatus('site').why||T("ui.window.conn.siteDown");return routeStatus('openai').why||openaiReason();}
// 坏了：橙条说哪里不对，下面「让 ChatGPT 修」「我自己修」。在用的这条坏了、另一条好着，说一句可以先改用那条。
function connBroken(r,why,inUse){const o=otherRoute(r),on=nbName(o);let note='';
 if(inUse&&routeAdded(o)&&routeStatus(o).st==='online')note=TH(o==='site'?"ui.window.conn.fallbackSite":"ui.window.conn.fallbackTunnel",{name:E(on),use:connBusy===o?`<b>${E(T("ui.window.conn.switching"))}</b>`:tbtn(T("ui.window.conn.use",{name:on}),'connUse',o)});
 else if(inUse&&r==='site'&&siteBlock()&&!openaiAdded())note=TH("ui.window.conn.tryTunnel",{add:tbtn(T("ui.window.conn.addTunnel"),'connTab','openai')});
 return connRes('warn',T("ui.window.conn.broken",{name:connRouteName(r)}),E(fullStop(why)),'',inUse)+`<div class="dp-acts conn-fix">${btn(T("ui.window.conn.fixAI"),'connRepairAI',r,'primary')}${tbtn(T("ui.window.conn.fixSelf"),'connFixSelf',r)}</div>`+(note?`<p class="dp-note">${note}</p>`:'');}
// 备用：灰条说它现在怎么样，下面一个「改用」。
function connStandby(r){const s=routeStatus(r),sel=selectedConnection(),cur=routeAdded(sel)&&sel!==r?nbName(sel):'';
 if(s.st==='broken')return connBroken(r,s.why||'',false);
 const now=cur?E(T("ui.window.conn.standbyNow",{current:cur})):'';
 // 1082（Claude，Ken 10/28 11:11）：原来卡片下面一个大按钮「改用 ChatGPT Site」，改成卡片右边一个「使用」；读屏还是读全名。
 const go=connBusy===r?`<button class="btn sm primary" type="button" disabled>${E(T("ui.window.conn.switching"))}</button>`:`<button class="btn sm primary" type="button" data-action="connUse" data-id="${E(r)}" aria-label="${E(T("ui.window.conn.use",{name:connRouteName(r)}))}">${E(T("ui.window.conn.useShort"))}</button>`;
 const res=s.st==='online'?connRes('',T("ui.window.conn.standbyOn"),now,go,false,true):s.st==='connecting'?connRes('spin',T("ui.window.connModel.label.text5"),now,go,false,true):connRes('',T("ui.window.conn.standbyIdle"),E(T("ui.window.conn.standbyIdleNote")),go,false,true);
 const keep=cur?T(sel==='site'?"ui.window.conn.keepSite":"ui.window.conn.keepTunnel",{name:cur}):'';
 return `${res}<p class="dp-note">${E(sentenceJoin(T(r==='site'?"ui.window.conn.useNoteSite":"ui.window.conn.useNoteTunnel"),keep))}</p>`;}
// 没加：空状态（不放白卡片），一句「特点」，再给两个出口。两条都没加时就是原来「帮我配 / 我自己配」那两个。
// 1081（Claude，Ken 10/26）：原来「好在 / 要做」两行，写的是「不用去 OpenAI 后台」这种用户没概念的话；改成一行特点：好配还是快、对网络挑不挑。
function connNone(r){const site=r==='site',o=otherRoute(r),other=routeAdded(o);
 const head=`<div class="conn-empty">${emptyIllustration(site?'i-site':'i-tunnel')}<h3>${E(T("ui.window.conn.noneTitle",{name:connRouteName(r)}))}</h3><p>${E(T(site?"ui.window.conn.noneSite":"ui.window.conn.noneTunnel"))}</p></div>`;
 const pros=`<dl class="conn-pros"><dt>${E(T("ui.window.conn.pros"))}</dt><dd>${E(T(site?"ui.window.conn.prosSite":"ui.window.conn.prosTunnel"))}</dd></dl>`;
 if(site&&window.h10SiteCreatable?.()===false)return head+pros+`<p class="dp-note conn-center">${E(T("ui.h10.host.siteUnavailable"))}</p>`;
 const cta=`<div class="conn-cta">${btn(T(other?"ui.window.conn.addAI":"ui.setup.assisted"),'connAssist',`${r}:${other?'add':'setup'}`,'primary')}${tbtn(T(other?"ui.window.conn.addSelf":"ui.setup.manual"),'connAddSelf',r)}</div>`;
 const note=other?sentenceJoin(E(T("ui.window.conn.addNote")),TH(o==='site'?"ui.window.conn.keepSite":"ui.window.conn.keepTunnel",{name:'<span class="conn-name">'+E(connRouteName(o))+'</span>'})):'';
 return head+pros+cta+(other?'<p class="dp-note conn-center">'+note+'</p>':'');}
function connKV(r,inUse){const site=r==='site',m=connModel(),rows=[],lc=routeLastCall(r);
 if(inUse&&S.connection?.device_name)rows.push(kvRow(T("ui.window.pgConn.text2"),E(S.connection.device_name)));
 if(site){const o=siteOrigin(S.site_b?.routes?.site?.origin);rows.push(kvRow(T("ui.window.conn.siteAddr"),E(o?new URL(o).hostname:T("ui.window.siteRow.text"))));}
 if(inUse&&(m.st==='online'||appMissing()))rows.push(kvRow(T("ui.window.appMissing.row"),E(appMissing()?(appUnbound()?T("ui.window.appMissing.unbound.rowMissing"):T("ui.window.appMissing.rowMissing")):shownAppName()),appMissing()?'':tbtn(T("ui.window.appMissing.ask"),'appMissing')));
 // 1081（Claude）：重开 ChatHand 以后这一次的测试记录没了，但配的时候测通过过，就写「通过」，不写「还没测过」。
 if(inUse&&!site){const c=S.connection_check,passed=!c?.time&&S.setup_test?.verified===true&&S.setup_test?.route!=='site';rows.push(kvRow(T("ui.window.pgConn.text7"),E(c?.time?`${when(c.time)} ${c.ok===false?T("ui.window.pgConn.text8"):T("ui.window.pgConn.text9")}`:passed?T("ui.window.pgConn.text9"):T("ui.window.pgConn.text10")),tbtn(c?.time||passed?T("ui.window.pgConn.text11"):T("ui.window.conn.untestedAct"),'testConnection')));}
 // 最近一次用：真用过才写，没用过不写「还没用过」。
 if(lc)rows.push(kvRow(T("ui.window.conn.lastUse"),timed(lc.time,'ago',ago(lc.time))));
 if(!site)rows.push(kvRow(T("ui.window.pgConn.text12"),'',sw('auto_connect',S.settings?.auto_connect,T("ui.window.pgSettings.right.text"))));
 return `<div class="kv">${rows.join('')}</div>`;}
function connFoot(r){return `<div class="conn-foot">${tbtn(T("ui.window.conn.reconfigure"),'connReconfigure',r)}<button class="tbtn danger" type="button" data-action="connRemove" data-id="${r}">${E(T("ui.window.conn.remove"))}</button></div>`;}
function connRouteView(r){if(!routeAdded(r))return `<div class="conn-block conn-none">${connNone(r)}</div>`;
 const inUse=routeInUse(r);let top='';
 if(inUse){top=connUseRes(r)||connBroken(r,connUseWhy(r),true);
  if(connModel().st==='online'&&S.tools_list_status?.state==='unknown')top+=`<p class="dp-note">${E(T(r==='site'?"ui.window.pgConn.toolsUnknownSite":"ui.window.pgConn.toolsUnknown"))}</p>`;}
 else top=connStandby(r);
 return `<div class="conn-block"><div class="conn-top">${top}</div>${connKV(r,inUse)}${connFoot(r)}</div>`;}
function pgConn(){const cur=connCurrentTab();return (CONN_LAYOUT==='cards'?connCards(cur):CONN_LAYOUT==='menu'?connMenuBlock(cur):connTabs(cur))+connRouteView(cur);}
let FAQ=[[T("ui.window.faq.text"),T("ui.window.faq.text2")],[T("ui.window.faq.text3"),T("ui.window.faq.text4")],[T("ui.window.faq.text5"),T("ui.window.faq.text6")],[T("ui.window.faq.text7"),T("ui.window.faq.text8")],[T("ui.window.faq.text9"),T("ui.window.faq.text10")],[T("ui.window.faq.text11"),T("ui.window.faq.text12")]];
/* 技术信息：平时收起来；[名字, 文字, 右边的按钮] */
function techRows(){const c=S.connection||{},cp=cloud(),a=S.about||{},id=tunnelId(),errs=S.support?.recent_errors||[],tools=S.connection_check?.tool_count||S.manifest?.tool_count||'';
 // Do not present standby OpenAI tunnel diagnostics as the selected Site's health.
 if(selectedConnection()==='site'){
  const b=S.site_b||{},r=b.routes?.site||{};
  return [[T("ui.window.techRows.text"),dotJoin([a.version||S.version,a.build?T("ui.window.techRows.text2",{"build":a.build}):''])],
   [T("ui.window.techRows.text3"),T("ui.window.techRows.text4")],
   [T("ui.window.techRows.text5"),r.configured===true?T("ui.window.techRows.text6"):T("ui.window.techRows.text7")],
   // 1081（Claude，Ken 10/26）：「设备健康」改叫「Site 连接」，值写「正常／没连上」；「宿主连接 · 还需取得真实回执」那一行永远是同一句、看不懂，去掉。
   [T("ui.window.techRows.siteLink"),siteHealthy()?T("ui.window.techRows.text22"):T("ui.window.techRows.text23")],
   [T("ui.window.techRows.text12"),Number.isSafeInteger(b.revision)?String(b.revision):T("ui.window.techRows.text13")]];
 }
 const px=cp.proxy==='direct'?T("ui.window.techRows.text14"):cp.proxy?T("ui.window.techRows.text15",{"value":String(cp.proxy).replace(/^[a-z0-9]+:\/\//i,'')}):T("ui.window.techRows.text16");
 return [[T("ui.window.techRows.text"),dotJoin([a.version||S.version,a.build?T("ui.window.techRows.text2",{"build":a.build}):'',a.commit&&a.commit!=='development'?a.commit.slice(0,7):''])],...(id?[[T("ui.window.techRows.text17"),id,("<button class=\"tbtn\" type=\"button\" data-action=\"copy\" data-id=\""+(E(id))+"\" aria-label=\""+(TH("ui.window.techRows.label"))+"\">"+(icon('i-copy','xs'))+"</button>"),'channel_id']]:[]),[T("ui.window.techRows.text18"),cp.last_success_at?secAgo(cp.last_success_at):T("ui.window.techRows.text19"),'','cloud_confirmed'],[T("ui.window.techRows.text20"),px],[T("ui.window.techRows.text21"),connState()==='unset'?T("ui.window.connModel.label.text7"):c.ready&&c.healthy?T("ui.window.techRows.text22"):T("ui.window.techRows.text23")],[T("ui.window.techRows.text24"),'tunnel-client'+(c.client_version?' · '+c.client_version:'')],...(tools?[[T("ui.window.techRows.text25"),T("ui.window.techRows.text26",{"tools":tools})]]:[]),[T("ui.window.techRows.text27"),errs.length?errs.slice(-5).map(e=>e.code).join('、'):T("ui.window.techRows.text28")]];}
const REPAIR_ACTIONS={resume:['resumeAI',''],open_wizard:['manual',''],open_chatgpt:['external',CHATGPT_URL],install_helper:['extensionSetup',''],open_extension_page:['chromeStoreReconnect',''],open_store_page:['chromeStoreOpen',''],download_chrome:['chromeUpdate',''],reconnect_browser:['browserReconnect',''],grant_permission:['computerPermissions',''],open_login_items:['openLoginItems',''],chrome_data_access:['chromeDataAccessSettings','']};
function repairList(r){const items=r.items||[],iconOf=status=>status==='ok'||status==='fixed'?`<span class="ri ok">${icon('i-check','xs')}</span>`:status==='running'?'<span class="ri"><span class="spinner"></span></span>':status==='pending'||status==='skipped'?'<span class="ri pend"></span>':`<span class="ri warn">${icon('i-bang','xs')}</span>`;
 const row=item=>`<div data-k="repair-${E(item.id)}" class="rp-i ${E(item.status)}">${iconOf(item.status)}<div><b>${E(item.title)}</b>${item.message?`<small>${E(item.message)}</small>`:''}</div>${item.status==='action'&&REPAIR_ACTIONS[item.action?.kind]?btn(item.action.label,'repairAct',JSON.stringify({kind:item.action.kind}),'sm'):item.status==='fixed'?((TH("ui.window.repairList.text",{"openSpan":("<span class=\"rp-tag\">"),"closeSpan":("</span>")}))):''}</div>`;
 if(r.status==='running'){const completed=items.filter(item=>!['pending','running'].includes(item.status)).length;return ("<div class=\"repair-progress"+(completed?'':' indeterminate')+"\" role=\"progressbar\" aria-label=\""+(TH("ui.window.repairList.label"))+"\" aria-valuemin=\"0\" aria-valuemax=\""+(items.length)+"\""+(completed?` aria-valuenow="${completed}"`:'')+">"+(("<i style=\"width:"+(completed&&items.length?Math.round(completed/items.length*100):30)+"%\">"))+(("</i>"))+"</div><div class=\"rp\">"+(items.map(row).join(''))+"</div>");}
 const fixed=items.filter(item=>item.status==='fixed'),action=items.filter(item=>['action','failed'].includes(item.status)),normal=items.filter(item=>['ok','skipped'].includes(item.status)),good=r.summary?.failed===0&&r.summary?.action_needed===0;
 return `<div class="repair-summary ${good?'ok-text':'warn-text'}">${icon(good?'i-check-circle':'i-bang-circle')}<b>${E(r.summary?.text||'')}</b></div><div class="rp">${fixed.length?("<section data-k=\"repair-fixed\"><h4>"+(TH("ui.window.repairList.text2"))+"</h4>"+(fixed.map(row).join(''))+"</section>"):''}${action.length?("<section data-k=\"repair-action\"><h4>"+(TH("ui.window.repairList.text3"))+"</h4>"+(action.map(row).join(''))+"</section>"):''}${normal.length?("<details data-k=\"repair-normal\" class=\"repair-normal\"><summary>"+(TH("ui.window.repairList.text4",{"length":normal.length}))+"</summary><h4>"+(TH("ui.window.repairList.text5"))+"</h4>"+(normal.map(row).join(''))+"</details>"):''}</div>`;}
function pgHelp(){const r=S.repair;
 /* 1067：顶部「排查」两个动作并排等宽（主：检查并修复，次：让 AI 检查），各带一句说明；各节同一个小标题样式，节与节之间 24px（.drawer-b 的 gap）。 */
 return ("<section class=\"hp hp-ts\"><h4>"+(TH("ui.window.pgHelp.troubleshoot"))+"</h4><div class=\"hp-pair\"><div class=\"hp-act-col\">"+(ibtn('i-wrench',r?.status==='running'?T("ui.window.pgHelp.text"):T("ui.window.connectionPage.text4"),'repair','','primary block'))+"<p>"+(TH("ui.window.pgHelp.text11"))+"</p></div><div class=\"hp-act-col\">"+(ibtn('i-external',T("ui.window.connModel.left.text3"),'aiBrief','','outline block'))+"<p>"+(TH("ui.window.pgHelp.text12"))+"</p></div></div>"+(r?repairList(r):'')+"</section>\n <section class=\"hp\"><h4>"+(TH("ui.window.pgHelp.text13"))+"</h4><div>"+(FAQ.map(([q,a])=>`<details class="faq"><summary><span>${E(q)}</span>${icon('i-chev','xs')}</summary><p>${E(a)}</p></details>`).join(''))+"</div></section>\n <section class=\"hp\"><h4>"+(TH("ui.window.pgHelp.text14"))+"</h4><div class=\"hp-pair\">"+(btn(T("ui.window.pgHelp.text2"),'external',ISSUES_URL,'outline block'))+(btn(T("ui.window.pgHelp.text3"),'exportDiagnostic','','outline block'))+"</div></section>\n "+(S.setup_skill?.installed?("<section class=\"hp\"><h4>"+(TH("ui.window.pgHelp.text7"))+"</h4><div class=\"hp-setup\" data-k=\"kv-chathand-setup\"><div class=\"hs-n\"><b>chathand-setup</b><span>"+E(T("ui.window.pgHelp.text4"))+"</span></div><div class=\"hs-a\">"+tbtn(T("ui.window.pgHelp.text5"),'codexTest')+tbtn(T("ui.window.pgHelp.text6"),'removeSkill')+"</div></div></section>"):'')+"\n <details class=\"tech\"><summary>"+(TH("ui.window.pgHelp.text15",{"openSpan":("<span>"),"closeSpan":("</span>"),"icon":icon('i-chev','xs')}))+"</summary><div class=\"kv\">"+(techRows().map(([k,v,act,rowKind])=>kvRow(k,rowKind==='channel_id'?`<span class="mono">${E(v)}</span>`:rowKind==='cloud_confirmed'&&cloud().last_success_at?timed(cloud().last_success_at,'sec',v,'','cloud'):E(v),act||'')).join(''))+"</div><div class=\"dp-acts\">"+(btn(T("ui.window.pgHelp.text8"),'copyTech','','sm'))+(observation?btn(T("ui.window.pgHelp.text9"),'endDiagnostic','','sm ghost'):btn(T("ui.window.pgHelp.text10"),'startDiagnostic','','sm ghost'))+"</div></details>");}
// 1052 E6（Claude）：「看下面的说明」是旧的默认话，在窗口里下面什么都没有；没做成又没写「你要做」的，也给一句能照做的。
function refreshTaskNeedsManual(t){return isRefreshTask(t)&&t.status==='failed'&&t.automatic_task?.clicked!==true&&!['refreshed','needs_user'].includes(t.automatic_task?.state);}
function taskUserAction(t){if(isRefreshTask(t)&&t.status==='completed')return '';if(isRefreshTask(t)&&t.automatic_task?.state==='needs_user')return T("ui.window.taskUserAction.text");if(isRefreshTask(t)&&t.automatic_task?.clicked===true)return T("ui.window.taskUserAction.text2");if(isRefreshTask(t))return T("ui.window.taskUserAction.text3");const a=String(t.user_action||'').trim();if(/^看下面的说明。?$/.test(a)||!a&&t.status==='failed')return T("ui.window.taskUserAction.text4");return a;}
// 1081（Claude，Ken 10/27 12:18）：任务详情分三层。最上面一张结果卡是这一页的视觉中心，跟连接页、浏览器控制页的结果卡同一个样子：
// 成功完成是绿的，没完成、要你处理是橙的，进行中和停了是灰的；卡里写状态、结果、「你要做」，进行中的右边是「停止这个任务」。
// 下面「来自」「开始」「用量」几行跟浏览器控制页的信息行一个样子（细线隔开、左边灰字），「回到对话」「改关联」「关联原对话」一律在对话名下面。
// 产出在结果卡和这几行之间，再往下是过程、改动的文件。
// 后台默认的「你要做」是中文的「无需操作。」；工具说明让 ChatGPT 没事要做时写「不用做什么」，所以它交回的也可能是「不用做什么。」。这两种界面一律换成 noAction，英文界面就是英文。1053 的测试把这几个函数单拿出来跑，那里没有 icon()，所以结果卡的图标在这里自己拼。
function taskResIcon(id){return `<svg class="i" aria-hidden="true"><use href="#${id}"/></svg>`;}
function taskResult(t){const live=active(t)?taskState(t):null,k=kind(t),ua=taskUserAction(t),msg=t.automatic_task?.message||t.summary,list=t.automatic_task?.tool_list_status,reported=t.status==='completed'||t.status==='failed';
 // 1081 N053（Claude）：命令的进程没确认清干净（cleanup_warning），任务照样结束，结果里照实写一句「清理没确认」。
 // 后台把这几条命令也算进了 intermediate_errors；有这句时次数照旧，但不说「都已处理」，改说「记录到」。
 // 不减次数：一条命令可能既失败又没确认清理，只算一次，减了会少算。错误码和各条命令的细节不写在这里，留在回执里。
 const cleanup=t.cleanup_warning?.code==='CLEANUP_UNCONFIRMED',errs=Number(t.intermediate_errors)||0;
 const tone=live?(live.dot==='warn'?'warn':''):k==='ok'?'ok':k==='fail'||k==='wait'?'warn':'';
 const ic=live&&/live/.test(live.dot)?`<span class="td-dot"><i class="sdot ${live.dot}" aria-hidden="true"></i></span>`:taskResIcon(tone==='ok'?'i-check-circle':tone==='warn'?'i-bang-circle':live?.key==='hold'?'i-pause':'i-info');
 const body=reported?(msg?`<p class="td-sum">${E(msg)}</p>`:'')+(list&&list.state!=='current'?`<p class="td-note">${E(list.message)}</p>`:'')+(ua?("<p class=\"td-ua"+(/^(不用做什么|无需操作)/.test(ua)?' none':'')+"\">"+(TH("ui.window.pgTask.text",{"openSpan":("<span>"),"closeSpan":("</span>"),"ua":E(ua==='无需操作。'||ua==='不用做什么。'?T("ui.window.taskInfo.noAction"):ua)}))+"</p>"):'')+(errs>0?`<p class="td-note">${E(t.status==='completed'&&!cleanup?T("ui.window.pgTask.text2",{"intermediate_errors":t.intermediate_errors}):T("ui.window.pgTask.text3",{"intermediate_errors":t.intermediate_errors}))}</p>`:'')+(cleanup?`<p class="td-note">${E(T("ui.window.pgTask.cleanupUnconfirmed"))}</p>`:'')+(refreshTaskNeedsManual(t)?`<div class="td-fix">${refreshToolsFigure()}${btn(T("ui.window.pgTask.text4"),'openRefreshTools','','sm')}</div>`:''):'';
 return `<div class="dp-res td-res${tone?' '+tone:''}" data-k="task-result">${ic}<div><b>${E(live?live.label:statusWords(t))}</b>${live&&live.line&&live.line!==live.label?`<small>${E(live.line)}</small>`:''}${body}</div>${live?btn(T("ui.window.pgTask.text8"),'stopTask',t.task_id,'sm'):''}</div>`;}
function taskFacts(t){const from=chatTitle(t),src=isRefreshTask(t)?E(from):from?E(T("ui.window.taskInfo.fromChat",{"from":from})):'ChatGPT',auto=!isRefreshTask(t)&&t.group?.conversation_url&&t.group.link_source==='auto_detected'?TH("ui.window.conversationActions.text",{"openSpan":("<small>"),"closeSpan":("</small>")}):'',acts=conversationActions(t),usage=valueTaskDetail(t);
 const row=(key,k,v,a)=>`<div class="kvr" data-k="${key}"><span class="k">${E(k)}</span><span class="v"><span class="td-v">${v}</span>${a?`<span class="td-acts">${a}</span>`:''}</span></div>`;
 return `<div class="kv td-facts">${row('task-from',T("ui.window.taskInfo.from"),src+auto,acts)}${t.created_at?row('task-started',T("ui.window.taskInfo.started"),E(when(t.created_at)),''):''}${usage?row('value-task-detail',T("ui.window.taskInfo.usage"),usage,''):''}</div>`;}
function pgTask(t){void loadChanges(t.task_id);const files=(changeCache.get(t.task_id)?.changes||[]).filter(c=>c.path&&['applied','recycled'].includes(c.status)&&!String(c.operation_id||'').startsWith('undo_'));
 return taskResult(t)+(outputsOf(t).length?("<section class=\"hp hp-outs\"><h4>"+(TH("ui.window.outputsPanel.label4"))+"</h4>"+(outputsRow(t,{limit:40}))+"</section>"):'')+taskFacts(t)+"<section class=\"hp\"><h4>"+(TH("ui.window.pgTask.text10"))+"</h4>"+(tl(t,{limit:0}))+"</section>\n "+(files.length?("<section class=\"hp\"><div class=\"hp-h\"><h4>"+(TH("ui.window.pgTask.text9",{"length":fileGroups(files).length}))+"</h4>"+(undoButton(t))+"</div><div class=\"files\">"+(fileRows(t,files))+"</div></section>"):'')+(stallRecords(t));}

/* 1027：停住记录（Ken 10/7：要查得到为什么停）。每次停住记：停之前最后几次调用花了多久、回了多少字、成没成；
   这段对话平时两次调用隔多久；预报命中了哪些词。攒几次就能看出是内容、篇幅还是时长的问题。 */
let STALL_TOOL_WORDS={read_text:T("ui.window.stallToolWords.read_text.text"),read_file:T("ui.window.stallToolWords.read_text.text"),get_file_info:T("ui.window.stallToolWords.get_file_info.text"),search_text:T("ui.window.stallToolWords.search_text.text"),start_search:T("ui.window.stallToolWords.search_text.text"),list_directory:T("ui.window.stallToolWords.list_directory.text"),propose_command:T("ui.window.pgUsage.text5"),command_result:T("ui.window.stallToolWords.command_result.text"),command_input:T("ui.window.stallToolWords.command_input.text"),write_text:T("ui.window.stallToolWords.write_text.text"),edit_file:T("ui.window.stallToolWords.edit_file.text"),create_directory:T("ui.window.toolWords.create_directory.text"),move_path:T("ui.window.toolWords.move_file.text"),trash_path:T("ui.window.toolWords.trash_path.text"),begin_task:T("ui.window.stepsOf.title.text4"),task_checkpoint:T("ui.window.stallToolWords.task_checkpoint.text"),task_status:T("ui.window.stallToolWords.task_status.text"),finish_task:T("ui.window.stallToolWords.finish_task.text"),bridge_info:T("ui.window.stallToolWords.bridge_info.text"),show_task:T("ui.window.stallToolWords.show_task.text"),search_results:T("ui.window.stallToolWords.search_results.text"),stop_search:T("ui.window.stallToolWords.stop_search.text"),cancel_command:T("ui.window.stallToolWords.cancel_command.text"),list_commands:T("ui.window.stallToolWords.list_commands.text"),input_status:T("ui.window.stallToolWords.input_status.text"),restore_file:T("ui.window.stallToolWords.restore_file.text"),restore_trash:T("ui.window.toolWords.restore_trash.text"),operation_status:T("ui.window.stallToolWords.operation_status.text"),system_inspect:T("ui.window.stallToolWords.system_inspect.text"),git_inspect:T("ui.window.stallToolWords.git_inspect.text"),desktop_action:T("ui.window.stallToolWords.desktop_action.text"),browser_status:T("ui.window.stallToolWords.browser_status.text"),browser_open:T("ui.window.stallToolWords.browser_open.text"),browser_tabs:T("ui.window.stallToolWords.browser_tabs.text"),browser_snapshot:T("ui.window.stallToolWords.browser_snapshot.text"),browser_read:T("ui.window.stallToolWords.browser_snapshot.text"),browser_find:T("ui.window.stallToolWords.browser_find.text"),browser_action:T("ui.window.pgUsage.text6"),browser_batch:T("ui.window.pgUsage.text6"),browser_wait_for:T("ui.window.stallToolWords.browser_wait_for.text"),browser_screenshot:T("ui.window.stallToolWords.browser_screenshot.text"),browser_upload:T("ui.window.stallToolWords.browser_upload.text"),browser_download:T("ui.window.stallToolWords.browser_download.text"),browser_close:T("ui.window.stallToolWords.browser_close.text"),computer_status:T("ui.window.stallToolWords.computer_status.text"),computer_observe:T("ui.window.stallToolWords.computer_observe.text"),computer_screenshot:T("ui.window.stallToolWords.computer_screenshot.text"),computer_action:T("ui.window.pgUsage.text7"),computer_batch:T("ui.window.pgUsage.text7"),computer_applications:T("ui.window.stallToolWords.computer_applications.text"),computer_focus:T("ui.window.stallToolWords.computer_focus.text"),automation_stop:T("ui.window.stallToolWords.automation_stop.text"),save_files:T("ui.window.toolWords.save_files.text"),expect_download:T("ui.window.stallToolWords.expect_download.text"),artifact_status:T("ui.window.stallToolWords.artifact_status.text"),image_batch_start:T("ui.window.stallToolWords.image_batch_start.text"),image_batch_save:T("ui.window.stallToolWords.image_batch_save.text"),image_batch_status:T("ui.window.stallToolWords.image_batch_status.text"),matter_write:T("ui.window.colHead.text3"),matter_query:T("ui.window.stallToolWords.matter_query.text"),task_history:T("ui.window.stallToolWords.task_history.text"),task_changes:T("ui.window.stallToolWords.task_changes.text"),log_note:T("ui.window.stallToolWords.log_note.text"),task_stop:T("ui.window.stallToolWords.task_stop.text"),request_permission:T("ui.window.stallToolWords.request_permission.text"),connection_check:T("ui.window.stallToolWords.connection_check.text"),list_conversations:T("ui.window.stallToolWords.list_conversations.text"),records_export:T("ui.window.stallToolWords.records_export.text"),install_update:T("ui.window.stallToolWords.install_update.text"),request_update:T("ui.window.stallToolWords.request_update.text"),upgrade_status:T("ui.window.stallToolWords.upgrade_status.text")};
function stallTool(name){return STALL_TOOL_WORDS[name]||(String(name).startsWith('browser_')?T("ui.window.stallTool.text"):String(name).startsWith('computer_')?T("ui.window.stallTool.text2"):name);}
function stallMs(ms){if(!Number.isFinite(ms))return '';const v=ms/1000;return v<1?T("ui.window.stallMs.text"):v<60?T("ui.window.stallMs.text2",{"value":Math.round(v)}):T("ui.window.stallMs.text3",{"value":Math.round(v/60)});}
function stallSize(n){if(!Number.isFinite(n))return '';return n<1000?T("ui.window.stallSize.text",{"n":n}):T("ui.window.stallSize.text2",{"value":(n/1000).toFixed(n<10000?1:0)});}
function stallRecords(t){const list=(S.resume?.recent_stalls||[]).filter(x=>x.task_id===t.task_id);if(!list.length)return '';
 const rows=list.slice(-5).reverse().map(x=>{const calls=(x.last_calls||[]).map(c=>`${E(stallTool(c.tool))}${c.ok===false?T("ui.window.stallRecords.text"):''}${Number.isFinite(c.ms)?T("ui.window.stallRecords.text2",{"value":c.ms<1000?'':' ',"stallMs":stallMs(c.ms)}):''}${Number.isFinite(c.bytes)?T("ui.window.stallRecords.text3",{"stallSize":stallSize(c.bytes)}):''}`).join('；');
  const usual=x.gap_median_ms?T("ui.window.stallRecords.text4",{"stallMs":stallMs(x.gap_median_ms),"stallMs2":stallMs(x.gap_longest_ms)}):'';
  const fc=x.forecast&&x.forecast!=='none'?T("ui.window.stallRecords.text7",{"value":x.forecast==='likely'?T("ui.window.stallRecords.text5"):T("ui.window.stallRecords.text6"),"value2":x.forecast_hits?.length?`（${E(x.forecast_hits.slice(0,5).join('、'))}）`:''}):'';
  return ("<li>"+(TH("ui.window.stallRecords.text12",{"openB":("<b>"),"when":E(when(x.at)),"value":x.quiet_ms?T("ui.window.stallRecords.text8",{"stallMs":stallMs(x.quiet_ms)}):'',"closeB":("</b>"),"value2":x.resumed_at?T("ui.window.stallRecords.text9",{"when":E(when(x.resumed_at))}):T("ui.window.stallRecords.text10"),"value3":calls?("<p>"+(TH("ui.window.stallRecords.text11",{"calls":calls}))+"</p>"):'',"value4":usual||fc?`<p class="hp-note">${[usual,fc].filter(Boolean).join(' · ')}</p>`:''}))+"</li>");}).join('');
 return ("<section class=\"hp\"><h4>"+(TH("ui.window.stallRecords.text13",{"length":list.length}))+"</h4><ul class=\"stall-log\">"+(rows)+"</ul></section>");}
/* 1026：「改动的文件」同一个文件只列一行（改了几次写「· N 次」）；名字在前，所在文件夹缩短写在下面，鼠标移上去看全路径；
   右边：看改动、快速查看（空格键那种预览）、在访达中显示（Ken 10/7）。 */
function fileGroups(files){const m=new Map();for(const c of files){const p=c.destination||c.path;const g=m.get(p)||{path:p,from:c.destination?c.path:'',n:0,last:null};g.n++;if(c.receipt_id&&c.operation_id)g.last=c;if(c.destination)g.from=c.path;m.delete(p);m.set(p,g);}return [...m.values()].reverse();}
function fileRows(t,files){return fileGroups(files).map(g=>{const name=String(g.path).split('/').filter(Boolean).pop()||g.path,dir=shortPath(String(g.path).split('/').slice(0,-1).join('/')||'.');
 return ("<div class=\"file\">"+(("<span class=\"file-ic\">"))+(icon('i-file','sm lead'))+(("</span>"))+"<div class=\"file-n\">"+(("<b data-tip=\""+(E(homePath(g.path)))+"\">"))+(E(name))+(g.n>1?((TH("ui.window.fileRows.text",{"openSpan":("<span class=\"file-k\">"),"n":g.n,"closeSpan":("</span>")}))):'')+(("</b>"))+(("<small>"))+(g.from?T("ui.window.fileRows.text2",{"shortPath":E(shortPath(g.from))}):'')+(E(dir==='.'?T("ui.window.workspaceName.text"):dir))+(("</small>"))+"</div><div class=\"file-a\">"+(g.last?tbtn(T("ui.window.stallToolWords.task_changes.text"),'viewDiff',t.task_id+'|'+g.last.operation_id):'')+"<button class=\"ibtn\" type=\"button\" data-action=\"quickLookTaskFile\" data-id=\""+(E(t.task_id))+"\" data-path=\""+(E(g.path))+"\" data-tip=\""+(TH("ui.window.fileRows.label"))+"\" aria-label=\""+(TH("ui.window.fileRows.label2",{"name":E(name)}))+"\">"+(icon('i-eye','xs'))+"</button><button class=\"ibtn\" type=\"button\" data-action=\"revealTaskFile\" data-id=\""+(E(t.task_id))+"\" data-path=\""+(E(g.path))+"\" data-tip=\""+(TH("ui.window.outputsPanel.label3"))+"\" aria-label=\""+(TH("ui.window.outputsPanel.label2",{"name":E(name)}))+"\">"+(icon('i-folder','xs'))+"</button></div></div>");}).join('');}

/* 1025：撤销这个任务用 ChatHand 改的文件（体验三.3）。任务做完才能撤；撤过一次就只显示「已撤销」。命令改的文件没有记录，撤不了。 */
function undoButton(t){if(active(t))return '';const list=changeCache.get(t.task_id)?.changes||[];if(list.some(c=>String(c.operation_id||'').startsWith('undo_')))return ((TH("ui.window.undoButton.text",{"openSpan":("<span class=\"hp-tag\">"),"closeSpan":("</span>")})));return tbtn(T("ui.window.undoButton.text2"),'undoTask',t.task_id);}
async function undoTask(id){
 let plan;try{plan=(await api('/api/task/undo',{id,dry_run:true})).summary;}catch(e){toast(e.message||T("ui.window.undoTask.text"),'warn');return;}
 const lines=[plan.revert?T("ui.window.undoTask.text2",{"revert":plan.revert}):'',plan.remove?T("ui.window.undoTask.text3",{"remove":plan.remove}):'',plan.move_back?T("ui.window.undoTask.text4",{"move_back":plan.move_back}):'',plan.untrash?T("ui.window.undoTask.text5",{"untrash":plan.untrash}):''].filter(Boolean);
 if(!plan.total){toast(T("ui.window.undoTask.text6"));return;}
 if(!await ask({title:T("ui.window.undoTask.title.text"),body:[lines.join('；')+'。',T("ui.window.undoTask.body.text")],ok:T("ui.window.permissionUndoStyle.text"),icon:'i-undo'}))return;
 try{const r=await api('/api/task/undo',{id});changeCache.delete(id);void loadChanges(id);toast(r.skipped.length?T("ui.window.undoTask.text7",{"length":r.done.length,"length2":r.skipped.length,"value":r.skipped.slice(0,2).map(x=>`${shortPath(x.path)}（${x.reason}）`).join('；')}):T("ui.window.undoTask.text8",{"length":r.done.length}),r.skipped.length?'warn':'');}
 catch(e){toast(e.message||T("ui.window.undoTask.text9"),'warn');}
}

/* ---------- 版本与更新：设置里那一行 + 右下角气泡（后端字段见开发任务书「前后端接口」） ---------- */
function upd(){return S.update||{};}
/* 1082：更新失败的标题按失败在哪一步来写。下载、校验、检查没过、没开始装这些都发生在替换之前，原版本没动过，
   以前一律写「也没能换回原来的版本」，和下面那行「没有安装」对不上。只有服务端明确说回滚失败、或要求重新拖入时才这样写。 */
const UPDATE_BROKEN_KEYS=new Set(['update.rollbackFailed.message','update.dragAgain.message']);
function updateFailedTitle(ins){return ins.rolled_back===true?T("ui.window.installText.failed.text2"):UPDATE_BROKEN_KEYS.has(ins.message_key)?T("ui.window.installText.failed.text3"):T("ui.window.installText.failed.text4");}
function installText(ins){if(upgrading())return T("ui.window.connModel.label.text");return {waiting_tasks:T("ui.window.installText.waiting_tasks.text"),waiting_download:T("ui.window.installText.waiting_download.text"),downloading:T("ui.window.installText.downloading.text",{"value":Math.round((ins.progress||0)*100)}),verifying:T("ui.window.installText.verifying.text"),installing:T("ui.window.installText.installing.text"),failed:S.upgrade_pending?T("ui.window.installText.failed.text"):updateFailedTitle(ins),done:T("ui.window.installText.done.text")}[ins.state]||'';}
function updateLine(){const u=upd(),a=S.about||{};return dotJoin([a.build?T("ui.window.techRows.text2",{"build":a.build}):'',u.status==='available'?(u.source==='local'?T("ui.window.updateLine.text",{"value":u.build||''}):T("ui.window.updateLine.text2",{"value":u.version||''})):u.status==='up_to_date'?T("ui.window.updateLine.text3"):u.status==='checking'?T("ui.window.pgHelp.text"):u.status==='updated'?T("ui.window.updateLine.text4",{"value":u.just_updated?.to||S.version||''}):installText(u.install||{})]);}
function updateBtn(){return btn(T("ui.window.updateBtn.text"),'checkUpdate','','sm');}
/* 1027：新版装好、工具变了，ChatHand 自己去 ChatGPT 设置里点「刷新工具」。认不准就一下不点，这时照旧请你自己点。
   1028：没点成要先说清楚（Ken 10/7：没刷新成功也应该告诉我一下）：橙色一行「自动刷新没成功」和原因，再请你自己点，带示意图。 */
/* 0010（Claude，#56）：更新完右下角那个气泡只说一件事。ChatHand 还在自己弄（running／pending）就一行进度，别的都不摆；
   自动没成才说要你做什么；「开新对话」只在最后说一次（刷新好了，或者请你自己点的那句里）；
   手动换 Chrome 助手那三步收进「怎么换」按钮，点开是单独一页（helperSheet）。
   这里的字都从窗口自己的词条取，不再把后台给的 message、tool_list_status.message、new_conversation_note 直接摆进来
   （第 55 条：后台只给状态，窗口按状态取词条），英文界面也就不会混进中文。 */
const REFRESH_HELPER_STATES=['helper_outdated','helper_broken','unavailable'];
function refreshNeedsHelper(tr){return REFRESH_HELPER_STATES.includes(tr?.state)||tr?.state==='running'&&tr?.waiting==='helper_manual';}
function toolsRefreshNote(tr){return toolsRefreshNoteBody(tr||{});}
function toolsRefreshNoteBody(tr){
 const spin=key=>"<div class=\"bb-status\"><span class=\"spinner\"></span><b>"+E(T(key))+"</b></div>",warn=key=>"<p class=\"bb-warn\">"+TH(key,{"openStrong":"<strong>","closeStrong":"</strong>"})+"</p>";
 if(tr.state==='running'&&tr.waiting==='helper_manual')return warn("ui.window.toolsRefreshNoteBody.helperManual");
 if(tr.state==='running'&&tr.waiting==='helper_update')return spin("ui.window.toolsRefreshNoteBody.waitHelper");
 if(tr.state==='running'||tr.state==='pending')return spin("ui.window.toolsRefreshNoteBody.running");
 if(tr.state==='refreshed')return "<p>"+TH("ui.window.toolsRefreshNoteBody.refreshed")+"</p>";
 if(tr.state==='needs_user')return warn("ui.window.toolsRefreshNoteBody.text8");
 if(tr.state==='needs_ai')return warn("ui.window.toolsRefreshNoteBody.text9")+refreshToolsFigure();
 if(['unverified','dispatch_unconfirmed','host_error'].includes(tr.state)||tr.clicked===true)return warn(tr.state==='host_error'?"ui.window.toolsRefreshNoteBody.hostError":"ui.window.toolsRefreshNoteBody.unverified");
 if(!tr.state||['idle','unknown'].includes(tr.state))return "<p>"+TH("ui.window.toolsRefreshNoteBody.text13")+"</p>";
 if(REFRESH_HELPER_STATES.includes(tr.state)){const store=typeof S==='object'&&S?.automation?.browser?.extension?.distribution==='chrome_web_store';return warn(store?(tr.state==='helper_outdated'?"ui.window.toolsRefreshNoteBody.helperFailedStoreOld":"ui.window.toolsRefreshNoteBody.helperFailedStoreDown"):"ui.window.toolsRefreshNoteBody.helperFailed")+refreshToolsFigure();}
 return warn("ui.window.toolsRefreshNoteBody.failed")+refreshToolsFigure();}
/* 0010（Claude，#56）：换助手的说明改成白话，开发者口气的两句（「Chrome 不向 ChatHand 报告真实加载目录…」「这三步由你自己操作…」）去掉；
   助手的状态说明也不再用后台的 message。设置里「浏览器」页照旧整段摆出来；更新气泡里只放一个「怎么换」，点开是 helperSheet 这一页。 */
/* 0010（Claude）：路径只在斜杠后面断行，一段一段不拆开，chrome-helper、Application Support 都整段换到下一行。 */
function pathWrapHTML(p){const parts=String(p||'').split('/');return parts.map((x,i)=>"<span class=\"path-seg\">"+E(x+(i<parts.length-1?'/':''))+"</span>").join('<wbr>');}
/* 1070：手动装、换 Chrome 插件的图示步骤（Ken 10/22：chrome://extensions 要一点就开；要有图、⌘⇧G、复制图标）。
   装（install）：打开扩展程序页 → 开发者模式 → 加载已解压的扩展程序 → 选文件夹。
   重新加载（reload，旧插件不会自己换新时）：打开扩展程序页 → 点 ChatHand 的重新加载（↻）；点了还是旧的，再换（replace）。
   换（replace，Chrome 用的是另一份旧插件时）：打开扩展程序页 → 移除旧的 → 加载已解压的扩展程序 → 选文件夹。
   图照 Chrome 扩展程序页重画成示意，viewBox 160×90，颜色全用 token，深浅色都对；要点的那一处标橙色。 */
function xfW(s,fs){return [...String(s)].reduce((w,c)=>w+(/[⺀-鿿豈-﫿＀-￯]/.test(c)?fs:fs*.56),0);}
function xfHit(x,y,label,small){const fs=small?7.5:8.5,h=small?11:14,w=Math.round(xfW(label,fs)+(small?10:12));return `<rect class="rt-hit" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h/2}"/><text class="${small?'xf-hit-s':'xf-hit-t'}" x="${x+w/2}" y="${y+h/2+(small?2.6:3)}" text-anchor="middle">${E(label)}</text>`;}
function xfHead(ring){return `<path class="xf-ink3" d="M17 19.5h9M17 23h9M17 26.5h9"/><text class="xf-mute" x="112" y="25.5" text-anchor="end">${E(T("ui.window.extFig.devMode"))}</text><rect class="xf-on" x="117" y="18" width="18" height="10" rx="5"/><circle class="xf-knob" cx="130" cy="23" r="3.4"/>${ring?'<rect class="xf-ring" x="113.5" y="14.5" width="25" height="17" rx="8.5"/>':''}<line class="rt-sep" x1="8.5" x2="151.5" y1="34.5" y2="34.5"/>`;}
function xfCard(hl){const rm=T("ui.window.extFig.remove");return `<rect class="rt-card" x="12.5" y="40.5" width="135" height="36" rx="5"/><rect class="xf-on" x="18" y="45.5" width="11" height="11" rx="3"/><text class="xf-name" x="34" y="53.5">ChatHand</text><rect class="xf-ph" x="34" y="57" width="44" height="4" rx="2"/><text class="xf-mute-s" x="18" y="72">${E(T("ui.window.extFig.details"))}</text>${hl==='remove'?xfHit(52,63.5,rm,true):`<text class="xf-mute-s" x="54" y="72">${E(rm)}</text>`}${hl==='reload'?'<circle class="rt-hit" cx="114" cy="69" r="7"/>':''}<path class="${hl==='reload'?'xf-o':'xf-ink3'}" d="M117.1 67.2A3.6 3.6 0 1 0 117.5 70M117.3 64.4v3h-3"/><rect class="xf-on" x="125" y="65" width="15" height="8" rx="4"/><circle class="xf-knob" cx="136" cy="69" r="2.7"/>`;}
function xfFold(x,y,c){return `<path class="${c}" d="M${x} ${y+1.2}a1.2 1.2 0 0 1 1.2-1.2h2.8l1.2 1.4h4.6a1.2 1.2 0 0 1 1.2 1.2v4.6a1.2 1.2 0 0 1-1.2 1.2h-8.6a1.2 1.2 0 0 1-1.2-1.2z"/>`;}
function extFig(kind,folder){
 const win='<rect class="rt-bg" width="160" height="90" rx="9"/><rect class="rt-card" x="8.5" y="8.5" width="143" height="73" rx="6"/>';let body='';
 if(kind==='open')body='<circle class="xf-dot" cx="17" cy="17" r="2.2"/><circle class="xf-dot" cx="24" cy="17" r="2.2"/><circle class="xf-dot" cx="31" cy="17" r="2.2"/><rect class="rt-hit" x="39" y="11" width="106" height="13" rx="6.5"/><text class="xf-addr" x="45.5" y="20.2">chrome://extensions</text><line class="rt-sep" x1="8.5" x2="151.5" y1="30.5" y2="30.5"/><rect class="xf-ph" x="17" y="40" width="46" height="6" rx="3"/><rect class="xf-ph" x="17" y="52" width="60" height="22" rx="4"/><rect class="xf-ph" x="83" y="52" width="60" height="22" rx="4"/>';
 else if(kind==='dev')body=xfHead(true)+'<rect class="xf-ph" x="17" y="43" width="60" height="31" rx="4"/><rect class="xf-ph" x="83" y="43" width="60" height="31" rx="4"/>';
 else if(kind==='load')body=xfHead(false)+xfHit(15,40,T("ui.window.extFig.loadUnpacked"))+'<rect class="xf-ph" x="17" y="61" width="60" height="13" rx="4"/><rect class="xf-ph" x="83" y="61" width="60" height="13" rx="4"/>';
 else if(kind==='remove'||kind==='reload')body=xfHead(false)+xfCard(kind);
 else if(kind==='pick'){const name=String(folder||'').split('/').filter(Boolean).pop()||'chrome-helper',sel=T("ui.window.extFig.select"),sw=Math.round(xfW(sel,7.5)+14);
  body=`<path class="xf-side" d="M14.5 9h27.5v72h-27.5a5.5 5.5 0 0 1-5.5-5.5v-61a5.5 5.5 0 0 1 5.5-5.5z"/><rect class="xf-ph2" x="14" y="17" width="22" height="4" rx="2"/><rect class="xf-ph2" x="14" y="26" width="17" height="4" rx="2"/><rect class="xf-ph2" x="14" y="35" width="20" height="4" rx="2"/>${xfFold(50,15.5,'xf-ink3f')}<rect class="xf-ph" x="65" y="16.5" width="40" height="5" rx="2.5"/><rect class="rt-hit" x="46.5" y="27.5" width="99" height="15" rx="4"/>${xfFold(50,31.3,'xf-of')}<text class="xf-hit-t" x="65" y="38.3">${E(name)}</text>${xfFold(50,47,'xf-ink3f')}<rect class="xf-ph" x="65" y="48" width="34" height="5" rx="2.5"/><rect class="xf-ph" x="${145-sw-34}" y="63" width="28" height="12" rx="6"/><rect class="xf-btn" x="${145-sw}" y="63" width="${sw}" height="12" rx="6"/><text class="xf-btn-t" x="${145-sw/2}" y="71.6" text-anchor="middle">${E(sel)}</text>`;}
 return `<svg class="xg-fig" viewBox="0 0 160 90" aria-hidden="true" focusable="false">${win}${body}</svg>`;}
function xgCopy(text,label){return `<button class="tbtn xg-copy" type="button" data-action="copy" data-id="${E(text)}" aria-label="${E(label)}" title="${E(label)}">${icon('i-copy','xs')}</button>`;}
function xgPath(folder){return `<div class="path xg-pathbox"><span class="xg-pathtext">${pathWrapHTML(homePath(folder))}</span>${xgCopy(folder,T("ui.window.helperFolderGuide.text3"))}</div>`;}
function extSteps(mode,folder){
 const step=(fig,text,extra='')=>`<li class="xg-step">${extFig(fig,folder)}<div class="xg-body"><div class="xg-t">${text}</div>${extra}</div></li>`;
 const open=`<div class="xg-acts">${btn(T("ui.window.extGuide.openBtn"),'extensionSettings','','sm primary')}<span class="xg-addr"><code>chrome://extensions</code>${xgCopy('chrome://extensions',T("ui.window.extGuide.copyAddress"))}</span></div>`;
 const pick=folder?`${xgPath(folder)}<div class="xg-acts">${btn(T("ui.window.outputsPanel.label3"),'revealHelperFolder','','sm')}</div><div class="xg-tip xg-pick-tip">${TH("ui.window.extGuide.pickTip")}</div>`:'';
 if(mode==='reload')return `<ol class="xg">${step('open',TH("ui.window.extGuide.open"),open)}${step('reload',TH("ui.window.extGuide.reload"))}</ol>`;
 return `<ol class="xg">${step('open',TH("ui.window.extGuide.open"),open)}${mode==='replace'?step('remove',TH("ui.window.extGuide.remove"))+step('load',TH("ui.window.extGuide.devLoad")):step('dev',TH("ui.window.extGuide.dev"))+step('load',TH("ui.window.extGuide.load"))}${step('pick',TH("ui.window.extGuide.pick"),pick)}</ol>`;}
function helperGuideMode(h){return h?.state==='wrong_folder'||!helperNeedsHand(h)?'replace':'reload';}
function helperFolderGuide(h,{page=false}={}){if(!h?.folder)return '';if(!helperNeedsHand(h))return "<section class=\"hp helper-folder-guide\"><h4>"+TH("ui.window.helperFolderGuide.text4")+"</h4><p>"+TH("ui.window.helperFolderGuide.text2")+"</p>"+xgPath(h.folder)+"<div class=\"dp-acts\">"+btn(T("ui.window.outputsPanel.label3"),'revealHelperFolder','','sm')+btn(T("ui.window.helperSheet.open"),'helperSheet','','sm')+"</div></section>";const mode=helperGuideMode(h);return "<section class=\"hp helper-folder-guide\">"+(page?'':"<h4>"+TH("ui.window.helperSheet.title")+"</h4>")+extSteps(mode,h.folder)+"<div class=\"dp-acts\">"+(mode==='reload'?btn(T("ui.window.extGuide.stillOld"),'extGuideReplace','','sm'):'')+btn(T("ui.window.extGuide.check"),'browserReconnect','','sm')+"</div></section>";}
/* 弹框版：装（install，从「查看手动安装步骤」进来）或换（reload / replace，从更新气泡、插件页进来）。
   开着的时候插件连上了、版本对了，就自己换成「装好了 / 换好了」，用户不用再点。 */
let extGuide=null,extRepairUnsupported=false;/* 原生还没有 extensionRepair（回 NATIVE_ACTION_UNKNOWN）时，这次运行里不再显示「一键换成新版」 */
function extGuideOK(){const x=S.automation?.browser?.extension||{};return x.connection_state==='connected'&&!helperNeedsHand(x.helper);}
function extGuideCause(h,mode){if(!helperNeedsHand(h))return T("ui.window.extGuide.causeCheck");const b=h.build,x=h.expected_build;if(h.state==='wrong_folder')return b&&x?T("ui.window.extGuide.causeWrongFolder",{build:b,expectedBuild:x}):T("ui.window.extGuide.causeWrongFolderNoBuild");if(mode==='replace')return T("ui.window.extGuide.causeReplace");return b&&x?T("ui.window.extGuide.causeOld",{build:b,expectedBuild:x}):T("ui.window.extGuide.causeOldNoBuild");}
function extGuideModal(mode,folder,note=''){const h=S.automation?.browser?.extension?.helper,install=mode==='install',auto=!install&&!extRepairUnsupported;extGuide={mode,folder,okAtOpen:extGuideOK(),copied:false};modal("<h2>"+E(T(install?"ui.window.extGuide.title":"ui.window.helperSheet.title"))+"</h2><p>"+(install?TH("ui.window.extGuide.intro"):E(extGuideCause(h,mode)))+"</p>"+(note?"<p class=\"notice\" role=\"status\">"+E(note)+"</p>":'')+(auto?"<div class=\"xg-auto\">"+btn(T("ui.window.extGuide.autoReplace"),'extensionRepair','','sm primary')+"</div>"+(folder?"<p class=\"xg-or\">"+TH("ui.window.extGuide.orManual")+"</p>":''):'')+(folder?extSteps(mode,folder):"<p>"+TH("ui.window.helperSheet.noFolder")+"</p>")+"<div class=\"actions ask\">"+(mode==='reload'?btn(T("ui.window.extGuide.stillOld"),'extGuideReplace','','sm ghost'):'')+btn(T("ui.window.extGuide.check"),'browserReconnect','','sm')+btn(T("ui.window.static.close"),'closeModal','','sm')+"</div>");$('#modal').dataset.kind='ext-guide';if(folder&&mode!=='reload')void extGuideAutoCopy(folder);}
/* 1070（Ken 第 15 条）：手动步骤一打开就把文件夹路径放进剪贴板，用户到选文件夹那一步直接 ⌘⇧G 粘贴。
   浏览器的剪贴板接口要用户刚点过才给写，写不进就走原生 copyText；都不行就照旧，路径旁边有复制按钮。
   之后剪贴板换成了别的（复制扩展页地址），提示就换回不带「已复制」的那句。 */
async function extGuideAutoCopy(folder){let ok=false;try{await navigator.clipboard.writeText(folder);ok=true;}catch{const r=await native('copyText',{text:folder}).catch(()=>null);ok=!!r&&!r.error;}if(ok&&extGuide?.folder===folder)extGuideMarkCopied(true,true);}
function extGuideMarkCopied(on,pulse=false){const d=$('#modal');if(!extGuide||!d.open||d.dataset.kind!=='ext-guide')return;extGuide.copied=on;const tip=d.querySelector('.xg-pick-tip'),box=d.querySelector('.xg-pathbox');if(tip)tip.innerHTML=TH(on?"ui.window.extGuide.pickTipCopied":"ui.window.extGuide.pickTip");if(box){box.classList.toggle('copied',on);const b=box.querySelector('.xg-copy');if(on&&pulse&&b)copyPulse(b);}}
// 1082（Claude，1081 验收截图 25）：应用店那条（chrome-store）是插件那边先查到连上的，先等界面自己的状态也是连上（最多 6 秒）再关框提示，
// 免得提示说「已连接」，旁边「浏览器控制」那条还写着没连上。
async function browserShownConnected(limit=6000){const until=Date.now()+limit;for(;;){await refresh().catch(()=>{});if(browserState()==='connected'||Date.now()>=until)return;await new Promise(r=>setTimeout(r,500));}}
async function extensionSuccessToast(message,kind){if(kind==='chrome-store')await browserShownConnected();const d=$('#modal');if(d.open&&d.dataset.kind===kind)await closeModal(false);if(quietModalOpen())return;const t=$('#toast'),host=$('#drawer').open?$('#drawer'):document.body;if(t.parentElement!==host)host.append(t);toast(message);}
function extGuideTick(){const d=$('#modal');if(!extGuide||!d.open||d.dataset.kind!=='ext-guide')return;if(!extGuideOK()){extGuide.okAtOpen=false;return;}if(extGuide.okAtOpen)return;const install=extGuide.mode==='install',b=S.automation?.browser?.extension?.helper?.build;extGuide=null;void extensionSuccessToast(install?T("ui.window.extGuide.doneInstall"):b?T("ui.window.extGuide.doneReplace",{build:b}):T("ui.window.extGuide.doneReplaceNoBuild"),'ext-guide');}
function helperSheet(){const h=S.automation?.browser?.extension?.helper;extGuideModal(helperGuideMode(h),h?.folder||'');}
function bubbleHTML(){const u=upd(),ins=u.install||{},status=u.status,j=u.just_updated,hiddenKey=status+':'+(u.version||j?.to||'');if(bubbleHidden.has(hiddenKey))return '';const local=u.source==='local',version=local&&u.build?T("ui.window.bubbleHTML.text",{"value":E(String(u.build))}):E(u.version||'');
 if(status==='updated'){const b=j?.build_to||u.current_build,refresh=u.refresh_tools||j?.tool_schema_changed,tr=S.tools_refresh||{},bring=tr.bring_existing_tab,canReturn=refresh&&IN_APP&&tr.state==='needs_user'&&tr.confirmation==='pending'&&tr.clicked===true&&bring?.action==='select'&&bring?.requires_user_request===true&&bring?.show===true&&typeof bring.page_id==='string'&&!!bring.page_id,manual=refresh&&tr.clicked!==true&&['needs_ai','not_found','ambiguous','helper_outdated','helper_broken','unavailable','failed'].includes(tr.state),helper=refresh&&refreshNeedsHelper(tr)&&!!S.automation?.browser?.extension?.helper?.folder;return ((TH("ui.window.bubbleHTML.text6",{"openB":("<b>"),"value":E(j?.to||S.version||''),"value2":b?T("ui.window.bubbleHTML.text2",{"value":E(String(b))}):'',"closeB":("</b>"),"value3":refresh?toolsRefreshNote(tr):'',"value4":adminNeedsSetup()?("<p class=\"bb-warn\">"+(TH("ui.window.bubbleHTML.text3"))+"</p>"):''}))+"<div class=\"bb-acts\">"+(adminNeedsSetup()?btn(T("ui.window.bubbleHTML.text4"),'drawer','terminal','sm'):'')+(canReturn?btn(T("ui.window.bubbleHTML.text5"),'returnExistingRefreshTab','','sm primary'):'')+(helper?btn(T("ui.window.helperSheet.open"),'helperSheet','','sm'):'')+(manual?btn(T("ui.window.toolListNotice.text"),'openRefreshTools','','sm'):'')+(btn(T("ui.window.matterReport.text10"),'updateAck','',canReturn?'sm':'sm primary'))+"</div>");}
 if(status==='failed'&&S.upgrade_pending)return ((TH("ui.window.bubbleHTML.text8",{"openB":("<b>"),"closeB":("</b>")}))+"<p>"+(E(ins.message||T("ui.window.bubbleHTML.text7")))+"</p><div class=\"bb-acts\">"+(btn(T("ui.window.permissionTierChanges.text4"),'updateClose',hiddenKey,'sm'))+"</div>");
 if(status==='failed')return `<b>${updateFailedTitle(ins)}</b>${ins.message?`<p>${E(ins.message)}</p>`:''}<div class="bb-acts">${ins.rolled_back===true?btn(T("ui.window.pgTask.text4"),'updateInstall',local?u.request_id||'':u.version||'','sm primary'):btn(T("ui.window.connModel.left.text3"),'aiBrief','','sm primary')}${btn(T("ui.window.permissionTierChanges.text4"),'updateClose',hiddenKey,'sm')}</div>`;
 if(status==='waiting_tasks')return ((TH("ui.window.bubbleHTML.text9",{"openB":("<b>"),"version":version,"closeB":("</b>")}))+"<div class=\"bb-acts\">"+(btn(T("ui.window.valueSettings.right.text3"),'updateCancel','','sm'))+"</div>");
 if(status==='waiting_download')return ((TH("ui.window.bubbleHTML.text10",{"openB":("<b>"),"closeB":("</b>")}))+"<div class=\"bb-acts\">"+(btn(T("ui.window.valueSettings.right.text3"),'updateCancel','','sm'))+"</div>");
 if(status==='downloading'){const progress=Math.min(100,Math.max(0,Math.round((u.progress??ins.progress??0)*100))),downloaded=u.downloaded_bytes??ins.downloaded_bytes??0,total=u.total_bytes??ins.total_bytes;return ((TH("ui.window.bubbleHTML.text12",{"openB":("<b>"),"closeB":("</b>")}))+"<div class=\"bb-bar\" role=\"progressbar\" aria-label=\""+(TH("ui.window.bubbleHTML.label"))+"\" aria-valuemin=\"0\" aria-valuemax=\"100\" aria-valuenow=\""+(progress)+"\">"+(("<i style=\"width:"+(progress)+"%\">"))+(("</i>"))+"</div><p>"+(total?T("ui.window.bubbleHTML.text11",{"value":(downloaded/1e6).toFixed(1),"value2":(total/1e6).toFixed(1)}):progress+'%')+"</p><div class=\"bb-acts\">"+(btn(T("ui.window.valueSettings.right.text3"),'updateCancel','','sm'))+"</div>");}
 if(upgrading())return ("<div class=\"bb-status\">"+(TH("ui.window.bubbleHTML.text13",{"openSpan":("<span class=\"spinner\">"),"closeSpan":("</span>"),"openB":("<b>"),"closeB":("</b>")}))+"</div>");
 if(status==='verifying'||status==='installing')return `<div class="bb-status"><span class="spinner"></span><b>${status==='verifying'?T("ui.window.installText.verifying.text"):T("ui.window.installText.installing.text")}</b></div>`;
 /* ChatGPT 做好的本机新版（request_update）：不管自动更新开没开都要人点「安装」，只认这个窗口里的点击 */
 if(status==='available'&&local&&u.request_id&&!bubbleHidden.has(u.request_id)){/* 1025：不再显示「来自对话…· 提交…」这类开发用的信息（Ken 10/6：用户看不懂，也用不上）。 */return ((TH("ui.window.bubbleHTML.text16",{"openB":("<b>"),"version":version,"closeB":("</b>"),"value":u.notes?`<p>${E(String(u.notes).split('\n')[0])}</p>`:''}))+"<p class=\"bb-meta\">"+(TH("ui.window.bubbleHTML.text17"))+"</p><div class=\"bb-acts\">"+(btn(T("ui.window.bubbleHTML.text14"),'updateLater',u.request_id,'sm'))+(btn(T("ui.window.bubbleHTML.text15"),'updateInstall',u.request_id,'sm primary'))+"</div>");}
 if(status==='available'&&!local&&S.settings?.auto_update===false&&u.version&&u.dismissed_version!==u.version&&!bubbleHidden.has(u.version))return ((TH("ui.window.bubbleHTML.text20",{"openB":("<b>"),"version":version,"closeB":("</b>"),"value":u.notes?`<p>${E(String(u.notes).split('\n')[0])}</p>`:''}))+"<div class=\"bb-acts\">"+(btn(T("ui.window.bubbleHTML.text18"),'updateLater',u.version,'sm'))+(btn(T("ui.window.bubbleHTML.text19"),'updateInstall',u.version,'sm primary'))+"</div>");
 return '';}
/* 0010（Claude，#56）：气泡最高不超过窗口（style.css .bubble 的 max-height），内容放不下就在 .bb-body 里滚，按钮那排一直在底下。 */
function bubbleFrame(html){if(!html)return '';const i=html.lastIndexOf('<div class="bb-acts">');return i<0?'<div class="bb-body">'+html+'</div>':'<div class="bb-body">'+html.slice(0,i)+'</div>'+html.slice(i);}
function paintBubble(){const element=$('#bubble'),html=bubbleFrame(bubbleHTML()||helperHomeNotice());paintRegion('bubble',html);if(element.hidden!==!html)element.hidden=!html;}

/* ---------- 抽屉的开、关、局部更新 ---------- */
function onceAnimation(node,name,timeout=400){if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;node.classList.add(name);const clear=e=>{if(e&&e.target!==node)return;node.classList.remove(name);node.removeEventListener('animationend',clear);};node.addEventListener('animationend',clear);setTimeout(clear,timeout);}
function flashRisk(id){const row=document.getElementById('risk-'+id);if(!row)return;row.scrollIntoView({block:'center'});row.classList.remove('flash');void row.offsetWidth;row.classList.add('flash');clearTimeout(row.__flashT);row.__flashT=setTimeout(()=>document.getElementById('risk-'+id)?.classList.remove('flash'),2000);}
let drawerClosing=0;
function openDrawer(view,id=null){if($('#modal').open&&$('#modal').dataset.kind==='key-lost')return;/* 0012：窗口钥匙丢了时别的都不生效，不在弹框上面再盖抽屉 */const d=$('#drawer');if(drawerClosing){clearTimeout(drawerClosing);drawerClosing=0;d.classList.remove('closing');if(d.open)d.close();}const back=d.open&&view==='settings'&&!!drawer&&drawer.view!=='settings';const fresh=!$('#drawer').open||drawer?.view!==view||drawer?.id!==id;if(fresh){stopValueNumber();if(view==='usage'){valueResetConfirm=false;valueResetError='';}if(view==='conn'){connTab='';connMenu=false;}}if(!$('#drawer').open)drawerReturnFocus=document.activeElement;drawer={view,id,focus:view==='terminal'?id:null};scopeOpen=false;paintDrawer(fresh,back);if(!$('#drawer').open)$('#drawer').showModal();if(fresh)$('#drawerBody').focus();if(id&&view==='terminal')requestAnimationFrame(()=>flashRisk(id));segSlide();reportChrome();syncClocks();}
/* 关抽屉：马上退出模态（页面立刻能点、焦点立刻回去），抽屉本身以非模态的样子再往右滑出、淡出 0.26 秒（背后那层暗色用阴影接着淡出）；「减少动态效果」时直接关 */
function drawerDone(){stopValueNumber();drawer=null;const f=drawerReturnFocus;drawerReturnFocus=null;if(f?.isConnected&&(!document.activeElement||document.activeElement===document.body||document.activeElement.closest?.('#drawer')))f.focus();reportChrome();syncClocks();}
function closeDrawer(){const d=$('#drawer');if(!d.open||drawerClosing){if(!drawerClosing){drawer=null;reportChrome();syncClocks();}return;}d.close();if(!matchMedia('(prefers-reduced-motion: reduce)').matches){d.classList.add('closing');d.show();drawerClosing=setTimeout(()=>{drawerClosing=0;d.classList.remove('closing');if(d.open)d.close();},260);}drawerDone();}
function paintRegion(id,html){const root=document.getElementById(id);if(regionHTML.get(id)===html)return false;const oldSteps=new Set([...root.querySelectorAll('.tl li[data-k]')]),running=new Set(root.querySelectorAll('.nd.run'));ChatHandMorph.align(root,html);timelineComplete(root,running);regionHTML.set(id,html);const duringSwap=performance.now()-swapAt<500;for(const row of root.querySelectorAll('.tl li[data-k]'))if(!oldSteps.has(row)&&!duringSwap)onceAnimation(row,'step-in');clipFade(root);return true;}
function paintDrawer(fresh=false,back=false){if(!drawer)return;const v=drawer.view,body=$('#drawerBody'),title=v==='task'?(allTasks().find(t=>t.task_id===drawer.id)?.title||T("ui.window.drawerTitles.task.text")):DRAWER_TITLES[v]||T("ui.window.nav.text4");
 if($('#drawerTitle').textContent!==title){$('#drawerTitle').textContent=title;window.__renderStats.nodeWrites++;}if($('#drawerTitle').title!==title){$('#drawerTitle').title=title;window.__renderStats.nodeWrites++;}
 $('#drawerBack').hidden=v==='settings'||v==='task';$('#drawerIcon').toggleAttribute('hidden',v!=='settings');if(v==='usage')stopValueNumber();paintRegion('drawerBody',drawerHTML());if(v==='usage')fitValueNote();if(fresh){body.scrollTop=0;body.classList.remove('enter','enter-back');onceAnimation(body,back?'enter-back':'enter',440);if(v==='usage')animateValueNumber();}}
/* 原有参数保留；新增 icon、warning、dangerous。 */
function ask({title,body=[],ok=T("ui.window.ask.ok.text"),okStyle='primary',cancel=T("ui.window.valueSettings.right.text3"),icon:ic='i-alert',warning='',dangerous=false}){return new Promise(resolve=>{if(askResolve)settleAsk(false);modal(`<div class="ask-icon">${icon(ic)}</div><h2 id="askTitle">${E(title)}</h2>${(Array.isArray(body)?body:[body]).filter(Boolean).map(t=>`<p>${E(t)}</p>`).join('')}${warning?`<div class="ask-warning">${E(warning)}</div>`:''}<div class="actions ask">${btn(cancel,'askNo')}${btn(ok,'askYes','',okStyle)}</div>`);$('#modal').classList.add('ask-modal');$('#modal').setAttribute('aria-labelledby','askTitle');$('#closeModal').hidden=true;askDangerous=dangerous;askResolve=resolve;setTimeout(()=>$('#modal [data-action="askNo"]')?.focus(),0);});}
/* 0012（Claude）：两种弹框，代替原来那句看不懂的 toast。
   一、窗口丢了钥匙：原生打开时发现已经有一个同版本的后台在跑，就接上去用，可钥匙在另一个进程手里。这个窗口看得到状态，
      凡是只能在窗口里点的都被后台拒（UI_CONFIRM_REQUIRED），原生那边回 NATIVE_OWNER_AUTH_REQUIRED，状态流回 401/403。
      弹「要重新打开」，点了调原生 relaunchChatHand；原生 5 秒没回或者回了错，就改成说怎么自己退出再打开。
   二、ChatGPT 里找不到这台 Mac 的应用：后台在 settings.chatgpt_app_missing 里给 {detected_at, reason}，或者刷新工具回 CHATGPT_APP_MISSING。
      连接本身是好的，所以不让人从建通道重来：一个按钮让 ChatGPT 在 Work 里帮着加回去，一个直接到「添加到 ChatGPT」那一段。
      同一次发现只自动弹一次；连接卡和连接页一直标着，点「加回去」再弹。连接页还有一行「ChatGPT 里的应用 · 找不到？」，后台没发现时也能自己点开。 */
function quietModalOpen(){const d=$('#modal');return !!d?.open&&['key-lost','app-missing'].includes(d.dataset.kind);}
let keyLostTimer=0;
function windowKeyLost(){if(!IN_APP)return;clearTimeout(keyLostTimer);keyLostTimer=0;const d=$('#modal');if(d.open&&d.dataset.kind==='key-lost')return;keyLostPaint('ask');}
// 状态流 401/403：原生在重启后台时会自己重载页面，等一会儿还在才弹，免得重启那一下闪一个框。
function keyLostSoon(){if(!IN_APP||keyLostTimer)return;keyLostTimer=setTimeout(()=>{keyLostTimer=0;windowKeyLost();},4000);}
function keyLostPaint(stage){
 const manual=stage==='manual',acts=manual?btn(T("ui.window.matterReport.text10"),'closeModal','','primary'):btn(T("ui.window.keyLost.later"),'closeModal')+(stage==='reopening'?`<button class="btn primary" type="button" data-k="keyLostBusy" data-key-lost-busy>${E(T("ui.window.keyLost.reopening"))}</button>`:btn(T("ui.window.keyLost.reopen"),'keyLostReopen','','primary'));
 modal(`<div class="ask-icon">${icon('i-refresh')}</div><h2 id="keyLostTitle">${E(T("ui.window.keyLost.title"))}</h2><p>${E(T(manual?"ui.window.keyLost.manual":"ui.window.keyLost.body"))}</p><div class="actions ask">${acts}</div>`);
 const d=$('#modal');d.classList.add('ask-modal');d.setAttribute('aria-labelledby','keyLostTitle');d.dataset.kind='key-lost';$('#closeModal').hidden=true;
 const busy=$('#modal [data-key-lost-busy]');if(busy){busy.disabled=true;busy.setAttribute('aria-busy','true');}
 if(stage==='ask')setTimeout(()=>$('#modal [data-action="keyLostReopen"]')?.focus(),0);
}
async function keyLostReopen(){
 keyLostPaint('reopening');
 const r=await Promise.race([native('relaunchChatHand'),new Promise(resolve=>setTimeout(()=>resolve({error:'NATIVE_TIMEOUT'}),5000))]);
 // 原生先回 {relaunching:true} 再退。20 秒后这个窗口还在，就是没重开成。
 if(r?.relaunching===true){setTimeout(()=>{if($('#modal').dataset.kind==='key-lost')keyLostPaint('manual');},20000);return;}
 keyLostPaint('manual');
}
const appMissing=()=>{const m=S?.settings?.chatgpt_app_missing;return !!m&&typeof m==='object';};
const appUnbound=()=>appMissing()&&S.settings.chatgpt_app_missing.reason==='identity_required';
// 1082（Claude，Ken 10/28 11:11）：Site 那条的「测试」原来打开设置引导（那页的按钮又跳到插件页），改成跟 OpenAI 通道一样：
// 在 ChatGPT 里填好一句带测试码的话，用户发出去就测了。Site 的两个探测只认同一次对话里前后一样的测试码，不用先跟 ChatHand 要。
// @ 后面用这条 Site 自己的插件名（chatgpt_apps.site.name，1082 后端给）。后端还没分开记时（没有 chatgpt_apps），
// 只加了 Site、没加 OpenAI 通道，登记的那个插件就是 Site 的，用 settings.chatgpt_app_name；两条都加了就不点名，免得点成另一条连接的插件。
function siteTestPrompt(){const apps=S?.chatgpt_apps,raw=apps&&typeof apps==='object'?apps.site?.name:!routeAdded('openai')?S?.settings?.chatgpt_app_name:'',app=typeof raw==='string'?raw.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,60):'';
 const nonce=Array.from(crypto.getRandomValues(new Uint8Array(12)),b=>b.toString(16).padStart(2,'0')).join('');
 return app?T("ui.setup.connectionTestPromptNamed",{app,nonce}):T("ui.setup.connectionTestPrompt",{nonce});}
const shownAppName=()=>(typeof S?.settings?.chatgpt_app_name==='string'?S.settings.chatgpt_app_name.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,60):'')||'ChatHand';
let appMissingSeen=null;
function appMissingDialog({detected=appMissing()}={}){
 // 0012：reason 是 identity_required 时不是「被删了」，是 ChatHand 还不知道 ChatGPT 里哪个应用是这台 Mac 的；只给「让 ChatGPT 帮我认」一个按钮。
 if(appUnbound())modal(`<div class="ask-icon">${icon('i-chat')}</div><h2 id="appMissingTitle">${E(T("ui.window.appMissing.unbound.title"))}</h2><p>${E(T("ui.window.appMissing.unbound.body"))}</p><div class="actions ask">${btn(T("ui.window.appMissing.unbound.ai"),'appMissingAI','','primary')}</div><p class="ask-note">${E(T("ui.window.appMissing.unbound.aiNote"))}</p>`);
 else modal(`<div class="ask-icon">${icon('i-chat')}</div><h2 id="appMissingTitle">${E(T("ui.window.appMissing.title"))}</h2><p>${E(T(detected?"ui.window.appMissing.bodyDetected":"ui.window.appMissing.bodyAsk",{name:shownAppName()}))}</p><div class="actions ask">${btn(T("ui.window.appMissing.manual"),'appMissingManual')}${btn(T("ui.window.appMissing.ai"),'appMissingAI','','primary')}</div><p class="ask-note">${E(T("ui.window.appMissing.aiNote"))}</p>`);
 const d=$('#modal');d.classList.add('ask-modal');d.setAttribute('aria-labelledby','appMissingTitle');d.dataset.kind='app-missing';setTimeout(()=>$('#modal [data-action="appMissingAI"]')?.focus(),0);
}
// 后台发现找不到时自动弹一次（同一个 detected_at 只弹一次）；别的弹框、设置向导、Site 那几页开着时先不弹，等它们关了再弹。
function maybeShowAppMissing(){
 if(!IN_APP||!appMissing()||S.settings.setup_complete!==true||connState()!=='online')return;
 const key=String(S.settings.chatgpt_app_missing.detected_at??'');if(appMissingSeen===key)return;
 if($('#modal').open||$('#drawer').open||$('#app').inert||document.querySelector('#setupWizard:not([hidden])'))return;
 appMissingSeen=key;appMissingDialog({detected:true});
}
async function appMissingManual(){
 await closeModal();closeDrawer();
 if(selectedConnection()==='site'){window.startH10?.({route:'site',screen:'f12'});return;}
 await window.startWizard?.({initialStep:2});
}
async function settleAsk(value){const resolve=askResolve;askResolve=null;if($('#modal').open)await closeModal();resolve?.(value);}
// 选文件夹没拿到路径：用户取消就不说话；别的原因说一声，不再静默。
function pickedFolder(r){if(typeof r?.path==='string'&&r.path)return r.path;const code=r?.cancelled?null:r?.error?.code||r?.error_code||(typeof r?.error==='string'?r.error:null);if(code)toast(T("ui.window.chooseFolder.failed",{code}),'warn');return null;}
async function chooseFolderAndApply(){const r=await native('chooseFolder');if(!pickedFolder(r))return false;const n=runningCount();if(n&&!await ask({title:T("ui.window.chooseFolderAndApply.title.text"),body:[homePath(r.path)],warning:stopNote(),ok:T("ui.window.chooseFolderAndApply.ok.text"),icon:'i-folder'}))return false;if(n)await stopAllTasks();const p=await api('/api/projects/add',{name:r.path.split(/[\\/]/).pop()||T("ui.window.workspaceName.text"),folder:r.path,scope:'folder'});await api('/api/projects/select',{id:p.id});await api('/api/setup/workspace',{});if(S.mode==='full')await api('/api/mode',{mode:'auto'});toast(T("ui.window.chooseFolderAndApply.text"));return true;}
async function stopAllTasks(){for(const t of allTasks().filter(active))await api('/api/tasks/stop',{id:t.task_id}).catch(()=>{});}

/* ---------- 时间文字与共用函数（UI-2 稳定合同） ---------- */
function timed(ms,fmt,text,cls='',source=''){return ms?`<span class="${cls}" data-ts="${Number(ms)}" data-fmt="${fmt}"${source?` data-clock-source="${source}"`:''}>${E(text)}</span>`:E(text);}
function confirmedAgo(stamp){const minutes=Math.max(0,Math.floor((Date.now()-stamp)/60000));return minutes<1?T("ui.window.confirmedAgo.text"):T("ui.window.confirmedAgo.text2",{"minutes":minutes});}
function clockStamp(el){return (el.dataset.clockSource==='confirmation'?S.connection?.display?.last_confirmed_at:el.dataset.clockSource==='cloud'?cloud().last_success_at:el.dataset.clockSource==='browser'?S.automation?.browser?.extension?.last_seen:0)||Number(el.dataset.ts);}
function clockText(el){const stamp=clockStamp(el),fmt=el.dataset.fmt;return el.dataset.clockSource==='confirmation'?confirmedAgo(stamp):fmt==='dur'?dur(Date.now()-stamp):fmt==='sec'?secAgo(stamp):ago(stamp);}
function clockNodes(selector){return [...document.querySelectorAll(selector)].filter(el=>el.getClientRects().length&&!el.closest('[hidden]')&&!el.closest('dialog.closing'));}
function tickClocks(selector){if(document.hidden||$('#app').inert)return;for(const el of clockNodes(selector)){const stamp=clockStamp(el);if(Number(el.dataset.ts)!==stamp){el.dataset.ts=String(stamp);window.__renderStats.nodeWrites++;}const text=clockText(el);if(el.textContent!==text){el.textContent=text;window.__renderStats.nodeWrites++;}}}
function syncClocks(){const stopped=document.hidden||$('#app').inert;const running=!stopped&&S&&(!paused()||allTasks().some(t=>t.status==='installing'))&&runningCount()>0&&clockNodes('[data-fmt="dur"]').length;const relative=!stopped&&clockNodes('[data-fmt="ago"],[data-fmt="sec"]').length;if(running&&!durationTimer)durationTimer=setInterval(()=>tickClocks('[data-fmt="dur"]'),1000);else if(!running&&durationTimer){clearInterval(durationTimer);durationTimer=0;}if(relative&&!agoTimer)agoTimer=setInterval(()=>tickClocks('[data-fmt="ago"],[data-fmt="sec"]'),30000);else if(!relative&&agoTimer){clearInterval(agoTimer);agoTimer=0;}}
document.addEventListener('visibilitychange',syncClocks);document.addEventListener('toggle',syncClocks,true);new MutationObserver(syncClocks).observe($('#app'),{attributes:true,attributeFilter:['inert']});
/** Local setup copies a fallback draft and opens Codex; it never sends or falls back to web Work. */
// quiet lets the progress page show the result instead of a duplicate toast.
async function openLocalSetupHandoff(handoff,{quiet=false}={}){
 const value=handoff?.prompt?handoff:await api('/api/setup/skill',{});if(!value?.prompt)throw Error(T("ui.window.openLocalSetupHandoff.text"));
 let copied=false;try{await copyText(value.prompt);copied=true;}catch{}
 let opened;try{opened=await native('openSetupConversation',{prompt:value.prompt});}catch(error){opened={error_code:error?.code||'CHATGPT_OPEN_FAILED'};}
 if(opened?.opened===true){const result={...opened,copied,prefill_requested:true,auto_sent:false};if(!quiet)toast(T("ui.window.openLocalSetupHandoff.text2"));return result;}
 const warning=T(copied?"ui.window.openLocalSetupHandoff.failedCopied":"ui.window.openChatGPT.text2");
 const result={...opened,opened:false,copied,prefill_requested:false,auto_sent:false,error_code:opened?.error_code||opened?.error?.code||'CHATGPT_OPEN_FAILED',warning};
 if(!quiet)toast(warning,'warn');return result;
}
window.openLocalSetupHandoff=openLocalSetupHandoff;
async function openChatGPT(prompt,{work=false}={}){let result;try{result=await native('openChatGPT',{prompt,mode:work?'work':'chat'});}catch{}if(!result||result.error){if(!String(prompt||'').trim()){toast(T("ui.window.openChatGPT.text"),'warn');return {error_code:'CHATGPT_OPEN_FAILED',prefilled:false,copied:false};}try{await copyText(prompt);toast(PROMPT_COPY_HINT);return {opened:null,prefilled:false,copied:true};}catch{toast(T("ui.window.openChatGPT.text2"),'warn');return {error_code:'CHATGPT_OPEN_FAILED',prefilled:false,copied:false};}}
 const hint=result.error_code==='CHATGPT_PROMPT_INVALID'?T("ui.window.openChatGPT.text3"):result.error_code==='CHATGPT_OPEN_FAILED'?result.copied?T("ui.window.openChatGPT.text4"):T("ui.window.openChatGPT.text2"):result.opened==='web'&&result.prefill_requested?T("ui.window.openChatGPT.text5"):result.opened==='web'?T("ui.window.openChatGPT.text6"):PROMPT_COPY_HINT;toast(hint);return result;}
async function applyTier(tier,folder){try{const result=await api('/api/permissions/tier',{tier,source:drawer?.view==='permissionPreset'?'tier':'home',...(folder?{folder}:{})});if(result.permissions){S={...S,permissions:result.permissions};window.wizardRefresh?.(S);scheduleRender();}toast(T("ui.window.applyTier.text",{"value":tier==='full'?T("ui.window.permCard.text"):T("ui.window.permCard.text2")}));await refresh();return true;}catch(error){toast(userMessage(error),'warn');return false;}}
function setupItems(){return (S?.setup?.open_items||[]).map(item=>({...item,title:{admin:T("ui.window.pgTerminal.text6"),desktop:T("ui.window.permCard.text5"),browser:T("ui.window.permCard.text4"),folder:T("ui.window.setupItems.title.folder.text")}[item.id]||item.id,done:item.status==='done',blocking:!['done','cancelled'].includes(item.status)}));}
async function setRisk(id,on){const item=riskList().find(x=>x.id===id);if(!item)return false;if(on&&item.group==='danger'&&!await ask({title:T("ui.window.setRisk.title.text",{"name":item.name}),body:[item.what],warning:item.harm,ok:T("ui.window.setRisk.ok.text"),icon:'i-shield',dangerous:true}))return false;try{if(on&&id==='admin')toast(T("ui.window.setRisk.text"));await api('/api/settings',{high_risk:{[id]:on}});await refresh();return true;}catch(error){toast(userMessage(error),'warn');return false;}}
function isSeen(key){return (S?.ui?.seen||[]).includes(key);}
async function markSeen(key){if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(key))return;if(!isSeen(key)){S={...S,ui:{...S?.ui,seen:[...(S?.ui?.seen||[]),key].slice(-256)}};scheduleRender();}try{await api('/api/ui/seen',{key});}catch{console.warn(T("ui.window.markSeen.text"));}}
function afterWizard(){for(const id of ['setupWizard']){const el=document.getElementById(id);if(el){if(el.tagName==='DIALOG'&&el.open)el.close();el.hidden=true;}}$('#app').inert=false;permissionHintReady=true;closeDrawer();tab='run';scheduleRender();}
function showPage(page,section){
 // 1069（Claude）：chathand://setup/openai 和「被网络验证拦住」那条通知：直接开始 OpenAI 通道的帮我配（记下路线、装配置助手、开 Work 新对话填好）；
 // 其余 setup：打开连接设置，从选方式开始。
 if(page==='setup'){closeDrawer();if(section==='openai')window.h10UseOpenAI?.();else window.startH10?.({entry:'settings'});return;}
 const sections={commands:'terminal',browser:'browser',desktop:'desktop',scope:'scope',connection:'conn',help:'help'};if(page==='settings'&&section){openDrawer(sections[section]||'settings');return;}const v={overview:'home',history:'tasks',conversations:'tasks',files:'tasks',connections:'conn',connection:'conn',automation:'settings',projects:'settings'}[page]||page;if(['conn','settings','help','terminal','browser','desktop','scope','usage'].includes(v)){openDrawer(v);return;}closeDrawer();tab=v==='tasks'&&!allTasks().some(active)?'done':'run';if(S)render();}
window.showPage=showPage;
addEventListener('permissionItemRequested',event=>{showPage(event.detail?.page||'settings',event.detail?.section||'commands');requestAnimationFrame(()=>flashRisk(event.detail?.item));});
addEventListener('browserRepairRequested',()=>{browserRepairNotice=true;showPage('settings','browser');render();});
addEventListener('confirmationRequested',event=>{const id=event.detail?.confirm_id||event.detail?.id;if(!id)return;tab='run';focusTask=null;render();requestAnimationFrame(()=>{const card=document.querySelector(`[data-confirm-id="${CSS.escape(id)}"]`);if(!card)return;card.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});card.classList.remove('flash');void card.offsetWidth;card.classList.add('flash');setTimeout(()=>card.classList.remove('flash'),1800);});});

/* ---------- 渲染：同帧合并，HTML 相同零写入 ---------- */
function stableKey(value){return JSON.stringify(value,(key,v)=>['checked_at','last_success_at','consecutive_failures','last_heartbeat','extension_last_seen','last_seen'].includes(key)?undefined:v);}
// 1052 R13（Claude）：事项页的搜索、最近删除、勾选、撤销删除也算界面状态，变了就重画。
function viewKey(){return stableKey([tab,focusTask,doneFilter,doneQuery,matterQuery,matterFilter,matterShowDeleted,matterHelpOpen,[...matterSelected],[...matterLastDeleted],drawer,scopeOpen,observation?.id,S,nativeStatus,[...changeCache].map(([key,value])=>[key,value.changes]),artifactThumbRevision,permissionHintReady,browserRepairNotice,reconnectConfirm,browserRetrying,flash,connTab,connBusy,connMenu,[...bubbleHidden],valueResetConfirm,valueResetError,valueResetBusy,[...confirmReady],[...confirmFeedback],[...confirmErrors]]);}
/* 1082：确认卡片画在左栏，原来左栏的重画字段里没有 confirmations，也没有「1 秒后才能点」「✓ 已允许」这几样本地状态，
   新来的确认可能不出来、允许按钮可能一直灰着、结果行可能不出来，要等别的任务数据变了才跟着重画。都补进来。 */
const REGION_FIELDS={main:['value','activity','tasks','matters','task_stalls','jobs','approvals','blocks','confirmations','settings','connection','relay','enabled','mode','high_risk','high_risk_catalog','repair'],rail:['tools_list_status','site_b','setup_test','connection','relay','last_calls','enabled','settings','permissions','setup','ui','update','project','mode','automation','capabilities','high_risk','high_risk_catalog','repair'],settings:['value','settings','connection','relay','relay_pilot','last_calls','about','version','update','capabilities','mode','project','automation','high_risk','high_risk_catalog','permissions','repair','enabled'],terminal:['settings','capabilities','mode','high_risk','high_risk_catalog','permissions'],browser:['settings','automation','mode','project'],desktop:['settings','automation','mode','project','capabilities'],scope:['mode','project'],conn:['connection','relay','last_calls','connection_check','settings','enabled','repair','tools_list_status','site_b','setup_test','credentials','setup_route','upgrade_pending','update'],help:['repair','setup_skill','support','about','version','connection','relay','connection_check','manifest','settings'],usage:['value','settings'],task:['value','history','tasks','activity','jobs','approvals','blocks','confirmations','enabled','settings','connection']};
function changedRegion(id,fields,local,paint){const key=stableKey([local,...fields.map(field=>{if(field==='connection'&&(id==='main'||id==='rail')){const {device_name,...visible}=S.connection||{};return visible;}return S[field];})]);if(regionKeys.get(id)===key)return;regionKeys.set(id,key);paint();}
function scheduleRender(){if(renderFrame)return;renderFrame=requestAnimationFrame(()=>{renderFrame=0;render();});}
function render(){if(!S)return;window.__renderStats.renders++;const stamp=viewKey();if(stamp!==lastKey){lastKey=stamp;const changes=[...changeCache].map(([key,value])=>[key,value.changes]);changedRegion('valueHeader',['value'],[],()=>paintRegion('valueHeader',valueHeaderHTML()));changedRegion('main',REGION_FIELDS.main,[tab,focusTask,doneFilter,doneQuery,matterQuery,matterFilter,matterShowDeleted,matterHelpOpen,[...matterSelected],[...matterLastDeleted],changes,artifactThumbRevision,[...confirmReady],[...confirmFeedback],[...confirmErrors],[...confirmDismissed]],()=>{paintRegion('main',left());$('#main').classList.toggle('scroll',tab==='done');});changedRegion('rail',REGION_FIELDS.rail,[scopeOpen,permissionHintReady,[...bubbleHidden]],()=>paintRegion('rail',rail()));if(drawer&&$('#drawer').open)changedRegion('drawerBody',REGION_FIELDS[drawer.view]||REGION_FIELDS.settings,[drawer,flash,observation?.id,nativeStatus,browserRepairNotice,reconnectConfirm,drawer.view==='task'?[changes,artifactThumbRevision]:null,drawer.view==='usage'?[valueResetConfirm,valueResetError,valueResetBusy]:null,drawer.view==='conn'?[connTab,connBusy,connMenu]:null],()=>paintDrawer());changedRegion('bubble',['update','settings'],[...bubbleHidden,helperHomeNotice()],paintBubble);extGuideTick();snapGrid();fitRecent();sizeRing();reportChrome();fxState();}segSlide();restoreCopyFeedback();syncClocks();waveApply();}
function fxState(){const ts=allTasks().filter(active),st=connState()!=='online'||paused()?'off':ts.some(isWaiting)?'wait':ts.length?'run':'idle';window.fxStatus?.(st);}
/* 「最近完成」排几行：整页滚动以后（10/5），只排到「第一屏的底边（避开左下角的皮肤按钮）」和「右栏的底边」两者里靠下的那个——它自己不会把页面撑长；更多的在「已完成」里 */
/* 右栏按内容算的高度（右栏本身被拉到和左栏一样高，好让卡片能停住，所以不能直接用它的高度）：标题 + 间距 + 卡片 + 底部 32 */
function railNatural(){const rail=$('#rail'),ch=rail.querySelector(':scope>.col-h'),st=rail.querySelector('.rail-stick');return ch&&st?ch.offsetHeight+(parseFloat(getComputedStyle(rail).rowGap)||16)+st.offsetHeight+(parseFloat(getComputedStyle(rail).paddingBottom)||56):rail.offsetHeight;}

function toListTop(){try{const m=$('#main');if(m)m.scrollTop=0;scrollTo(0,0);}catch{}}
function fitRecent(){const main=$('#main'),rows=[...main.querySelectorAll('.recent .rr')];if(!rows.length)return;const sy=scrollY,bounds=main.getBoundingClientRect(),corner=document.querySelector('[data-skin-action="toggle"]')?.getBoundingClientRect(),fold=Math.min(innerHeight-56,corner?.width&&corner.right>bounds.left&&corner.left<bounds.right?corner.top:Infinity),railEnd=bounds.top+sy+railNatural()-(parseFloat(getComputedStyle(main).paddingBottom)||56),limit=Math.max(fold,railEnd),start=main.querySelector('.recent .rl').getBoundingClientRect().top+sy,height=rows.find(row=>!row.hidden)?.offsetHeight||parseFloat(getComputedStyle(rows[0]).height);if(!(height>0))return;const hidden=rows.map((row,index)=>start+(index+1)*height>limit+.5);for(const [index,row] of rows.entries()){row.__morphHold||=new Set(['hidden']);if(row.hidden!==hidden[index]){row.hidden=hidden[index];window.__renderStats.nodeWrites++;}}}

/* 流光：转动的锥形渐变要盖住外圈光晕（每边最多多出 60），所以 --d 按「面板 + 120」的对角线算；
   关键帧按面板周长排（spinFrames），--glow-delay 让重画面板时光不跳回起点。
   速度（GlowCurve）：卡片四个角、四条边的中点各定一个相对速度 --glow-v1…v8（从左上角起顺时针：左上角、上边、右上角、右边、右下角、下边、左下角、左边），
   中间用周期的保形三次插值连起来，绕一圈速度处处连续，没有顿挫、没有接缝，也不会冲过头；--glow-accel 是起伏的大小（0 = 匀速，100% = 照设定，最多 150%）。
   时间按 ∫ds/v 算，一圈总时长仍是「一圈几秒」。匀速时关键帧和以前一样（49 帧，按周长均分）。window.ChatHandGlowCurve 把这份算法露给测试用。 */
const GlowCurve=(()=>{
 const R=16,ORDER=[1,2,3,4,5,6,7,0]; // 样条节点从上边中点起（at 的起点）；v 的下标从左上角起
 function geo(w,h){const r=R,hw=w/2,hh=h/2,q=Math.PI*r/2,sw=w-2*r,sh=h-2*r,L=2*sw+2*sh+4*q,e=hw-r;
  const at=s=>{let d=((s%L)+L)%L;if(d<=e)return [d,-hh];d-=e;if(d<=q){const a=d/r;return [hw-r+r*Math.sin(a),-hh+r-r*Math.cos(a)];}d-=q;if(d<=sh)return [hw,-hh+r+d];d-=sh;
   if(d<=q){const a=d/r;return [hw-r+r*Math.cos(a),hh-r+r*Math.sin(a)];}d-=q;if(d<=sw)return [hw-r-d,hh];d-=sw;if(d<=q){const a=d/r;return [-hw+r-r*Math.sin(a),hh-r+r*Math.cos(a)];}d-=q;
   if(d<=sh)return [-hw,hh-r-d];d-=sh;if(d<=q){const a=d/r;return [-hw+r-r*Math.cos(a),-hh+r-r*Math.sin(a)];}d-=q;return [-hw+r+d,-hh];};
  const knots=[0,e+q/2,e+q+sh/2,e+q+sh+q/2,e+2*q+sh+sw/2,e+2*q+sh+sw+q/2,e+3*q+sh+sw+sh/2,e+3*q+2*sh+sw+q/2]; // 上边、右上角、右边、右下角、下边、左下角、左边、左上角
  return {w,h,L,at,knots,start:knots[7]};}
 function spline(xs,ys,P){ // 周期的保形三次插值（PCHIP）：速度处处连续，最快、最慢就在拖的那个点上，平的一段保持平，不会冲过头
  const n=xs.length,h=xs.map((x,i)=>(i<n-1?xs[i+1]:xs[0]+P)-x),dl=ys.map((y,i)=>(ys[(i+1)%n]-y)/h[i]);
  const d=ys.map((_,i)=>{const m=(i+n-1)%n,a=dl[m],b=dl[i];if(a*b<=0)return 0;const w1=2*h[i]+h[m],w2=h[i]+2*h[m];return (w1+w2)/(w1/a+w2/b);});
  return s=>{let i=n-1;for(let k=0;k<n-1;k++)if(s<xs[k+1]){i=k;break;}const hh=h[i],t=(s-xs[i])/hh,t2=t*t,t3=t2*t,j=(i+1)%n;
   return (2*t3-3*t2+1)*ys[i]+(t3-2*t2+t)*hh*d[i]+(-2*t3+3*t2)*ys[j]+(t3-t2)*hh*d[j];};}
 function read(cs){const v=[];for(let i=1;i<=8;i++){const x=parseFloat(cs.getPropertyValue('--glow-v'+i));v.push(Number.isFinite(x)?Math.min(3,Math.max(.1,x)):1);}
  const a=parseFloat(cs.getPropertyValue('--glow-accel'));return {v,a:Number.isFinite(a)?Math.min(1.5,Math.max(0,a/100)):1};}
 const isFlat=(v,a)=>a<.001||v.every(x=>Math.abs(x-v[0])<1e-6);
 function build(w,h,v,a){const g=geo(w,h),mean=v.reduce((x,y)=>x+y,0)/v.length,ev=v.map(x=>mean+a*(x-mean)),flat=isFlat(v,a);
  const f=flat?()=>mean:spline(g.knots,ORDER.map(i=>ev[i]),g.L),speed=s=>Math.max(mean*.08,f(((s%g.L)+g.L)%g.L));
  const N=240,ss=[0],ts=[0];let t=0;for(let k=1;k<=N;k++){const s0=(k-1)/N*g.L,s1=k/N*g.L;t+=(s1-s0)*(1/speed(s0)+4/speed((s0+s1)/2)+1/speed(s1))/6;ss.push(s1);ts.push(t);}
  for(let k=0;k<=N;k++)ts[k]/=t;
  const sAt=p=>{p=((p%1)+1)%1;let lo=0,hi=N;while(hi-lo>1){const m=(lo+hi)>>1;if(ts[m]<=p)lo=m;else hi=m;}return ss[lo]+(ss[hi]-ss[lo])*(p-ts[lo])/((ts[hi]-ts[lo])||1);};
  return {...g,flat,mean,ev,speed,ss,ts,sAt};}
 return {geo,read,build,isFlat};})();
window.ChatHandGlowCurve=GlowCurve;
const spinStyle=document.createElement('style');spinStyle.id='tp-spin';document.head.append(spinStyle);let spinKey='';
function spinFrames(w,h){const {v,a}=GlowCurve.read(getComputedStyle(document.documentElement)),flat=GlowCurve.isFlat(v,a),key=Math.round(w/4)+'x'+Math.round(h/4)+(flat?'':':'+v.join(',')+':'+a);if(key===spinKey)return;spinKey=key;
 const g=GlowCurve.geo(w,h),angle=s=>{const [x,y]=g.at(s);let d=Math.atan2(x,-y)*180/Math.PI;if(d<0)d+=360;return d;},frames=[];
 if(flat){let prev=0;const N=48;for(let k=0;k<=N;k++){let deg=angle(k/N*g.L);while(deg<prev-1)deg+=360;if(k===N)deg=360;frames.push(`${(k/N*100).toFixed(3)}%{rotate:${deg.toFixed(2)}deg}`);prev=deg;}}
 else{const c=GlowCurve.build(w,h,v,a),N=c.ss.length-1;let prev=0,last=-1;for(let k=0;k<=N;k++){let deg=k===N?360:angle(c.ss[k]);while(deg<prev-1)deg+=360;let pct=k===N?100:Math.round(c.ts[k]*1e5)/1e3;if(pct<=last)pct=last+.001;last=pct;frames.push(`${pct.toFixed(3)}%{rotate:${deg.toFixed(2)}deg}`);prev=deg;}}
 spinStyle.textContent=`@keyframes tpspin-u{${frames.join('')}}`;document.documentElement.style.setProperty('--spin','tpspin-u');}
/* 对齐网点：主面板、小卡片、右栏卡片的高度补到网点间距的整数倍（先清掉再量，一次读一次写），这样它们的下边也落在网点上 */
/* 「进行中 / 已完成」切换：标签不动，下面的内容从切换的方向滑进来 10px、淡入，几块之间错开 40ms；只用 transform，不影响量尺寸；减少动态时不做 */
function tabIn(dir){if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;const main=$('#main');[...main.querySelectorAll(':scope>.col>:not(.col-h),:scope>:not(.col)')].slice(0,4).forEach((el,i)=>el.animate([{opacity:0,transform:`translateX(${dir*10}px)`},{opacity:1,transform:'none'}],{duration:320,delay:i*40,easing:'cubic-bezier(.2,.8,.2,1)',fill:'backwards'}));}
function snapGrid(){const r=document.documentElement,els=[...document.querySelectorAll('#main .tp-in,#main .orow,#rail .card')];for(const el of els)if(el.style.minHeight)el.style.removeProperty('min-height');if(!r.classList.contains('snap-grid'))return;const g=parseFloat(getComputedStyle(r).getPropertyValue('--dots-gap'))||12;const hs=els.map(el=>el.offsetHeight);els.forEach((el,i)=>{const t=Math.ceil(hs[i]/g-.01)*g;if(t>hs[i])el.style.minHeight=t+'px';});}
addEventListener('resize',()=>{if(document.documentElement.classList.contains('snap-grid')){snapGrid();sizeRing();}});
/* 调了速度曲线、换了皮肤：重排流光关键帧（同一个动画对象，进度不跳） */
for(const name of ['chathand:fx','chathand:skin'])addEventListener(name,()=>sizeRing()); // spinFrames 的 key 带着曲线参数，没变就不重写
function sizeRing(){for(const panel of document.querySelectorAll('.tp.run')){const box=panel.getBoundingClientRect(),size=Math.ceil(Math.hypot(box.width+120,box.height+120))+'px';if(panel.style.getPropertyValue('--d')!==size)panel.style.setProperty('--d',size);if(box.width>64&&box.height>64)spinFrames(box.width,box.height);const ring=panel.querySelector('.tp-ring');if(ring&&!ringClockNodes.has(ring)){ringClockNodes.add(ring);const lap=(parseFloat(getComputedStyle(panel).getPropertyValue('--glow-speed'))||7)*1000;panel.style.setProperty('--glow-delay',-(performance.now()%lap)+'ms');}}}
/* 点小卡片换到大面板：小卡片展开成大面板、大面板收成小卡片（页面过渡）；系统不支持或开了「减少动态效果」就直接换 */
let swapping=null,swapAt=-1e9,swapPendingState=null,swapRefresh=false;
function nameTasks(){for(const el of document.querySelectorAll('#main .tp[data-k^="task-panel-"],#main .orow[data-id],#main .recent')){const id=el.classList.contains('recent')?'recent':el.dataset.id||el.dataset.k.slice(11);el.style.viewTransitionName='vt-'+String(id).replace(/[^A-Za-z0-9_-]/g,'_');}}
function clearNames(){for(const el of document.querySelectorAll('#main [style*="view-transition-name"]'))el.style.removeProperty('view-transition-name');}
const vtStyle=document.createElement('style');document.head.append(vtStyle);
/* 1026：展开收起的动效（Ken 10/7：样式保持原样——展开是大卡、大标题，收起是小条、小标题；只要更顺、热区更大）。
   不再用整张截图互相变形（字被拉伸、一顿一顿）。改成：卡片高度从旧高度平滑过渡到新高度（下面的卡跟着平滑移动）；
   标题从旧位置、旧字号平移缩放到新位置（只动 transform，不重排）；其余内容稍后淡入。点的那张尽量留在鼠标下面。 */
function taskBoxes(){const m=new Map();for(const el of document.querySelectorAll('#main .tp[data-k^="task-panel-"],#main .orow[data-id]')){const panel=el.classList.contains('tp'),id=panel?el.dataset.k.slice(11):el.dataset.id,t=el.querySelector(panel?'.tp-t h3':'.orow-t b'),r=el.getBoundingClientRect(),bt=parseFloat(getComputedStyle(el).borderTopWidth)||0;
 /* 先把所有位置一次量完，再开始动：一张卡开始变高以后，下面的卡位置就变了，再量就不准 */
 m.set(id,{el,panel,r,t:t?{r:t.getBoundingClientRect(),fs:parseFloat(getComputedStyle(t).fontSize)||15}:null,kids:panel?[]:[...el.children].map(c=>[c,c.getBoundingClientRect().top-r.top-bt])});}return m;}
function finishSwap(){
 const pending=swapPendingState,again=swapRefresh;swapPendingState=null;swapRefresh=false;
 if(swapping?.timer)clearTimeout(swapping.timer);swapping=null;
 for(const el of document.querySelectorAll('#main .tp.swapping'))el.classList.remove('swapping');
 if(pending)adoptState(pending);else scheduleRender();
 if(again)void refresh();
}
function swapFocus(id,anchor){
 if(swapping)return;
 const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches,before=reduce?null:taskBoxes(),aid=anchor?.dataset?.id,card=anchor?.closest?.('.tp,.orow'),top0=card?.getBoundingClientRect().top;
 swapAt=performance.now();if(!reduce){swapping={timer:0};for(const b of before?.values()||[])if(b.panel)b.el.classList.add('swapping');}
 focusTask=id;tab='run';render();
 if(reduce||!before){swapping=null;return;}
 const after=taskBoxes(),D=420,EASE='cubic-bezier(.22,1,.36,1)';
 for(const [tid,a] of after){const b=before.get(tid);if(!b||b.panel===a.panel)continue;const el=a.el;if(a.panel)el.classList.add('swapping');
  // 收起成小条时，小条是上下居中排的；高度变化期间先把每个子元素钉在它最终的位置，免得内容跟着高度上下漂
  const pinned=a.panel?[]:a.kids;if(pinned.length){el.style.alignItems='flex-start';el.style.paddingTop='0px';el.style.paddingBottom='0px';for(const [c,ct] of pinned)c.style.marginTop=ct+'px';}
  // 大卡的 glow 会伸到卡外，不能裁 .tp；只裁里面的 .tp-in。小条没有 glow，可以直接裁自身。
  const clip=a.panel?el.querySelector('.tp-in'):el;if(clip){clip.style.overflow='hidden';if(a.panel)clip.style.height='100%';}
  const hAnim=el.animate([{height:b.r.height+'px'},{height:a.r.height+'px'}],{duration:D,easing:EASE});
  const done=()=>{if(clip){clip.style.overflow='';clip.style.height='';}if(pinned.length){el.style.alignItems='';el.style.paddingTop='';el.style.paddingBottom='';for(const [c] of pinned)c.style.marginTop='';}};hAnim.finished.then(done,done);
  const tEl=el.querySelector(a.panel?'.tp-t h3':'.orow-t b');
  if(tEl&&a.t&&b.t){const dx=(b.t.r.left-b.r.left)-(a.t.r.left-a.r.left),dy=(b.t.r.top-b.r.top)-(a.t.r.top-a.r.top),s=b.t.fs/a.t.fs;tEl.style.transformOrigin='0 0';const ta=tEl.animate([{transform:`translate(${dx}px,${dy}px) scale(${s})`},{transform:'none'}],{duration:D,easing:EASE});const tdone=()=>{tEl.style.transformOrigin='';};ta.finished.then(tdone,tdone);}
  const rest=a.panel?el.querySelectorAll('.tp-t p,.tp-h .stat,.tp-fold,.tp-in>:not(.tp-h)'):el.querySelectorAll('.orow-t small,.orow>.sdot,.orow>.i');
  for(const r of rest)r.animate([{opacity:0,transform:'translateY(-6px)'},{opacity:1,transform:'none'}],{duration:a.panel?300:220,delay:a.panel?110:140,easing:'ease-out',fill:'backwards'});
 }
 swapping.timer=setTimeout(finishSwap,D+30);
 if(!aid||top0===undefined)return;const sc=document.scrollingElement||document.documentElement,t0=performance.now();
 const keep=()=>{const el=document.querySelector(`#main [data-k="task-panel-${CSS.escape(aid)}"],#main .orow[data-id="${CSS.escape(aid)}"]`);if(!el)return;const d=el.getBoundingClientRect().top-top0;if(Math.abs(d)>.5)sc.scrollTop+=d;if(performance.now()-t0<D+40)requestAnimationFrame(keep);};requestAnimationFrame(keep);
}
addEventListener('resize',()=>{fitRecent();sizeRing();clipFade();});
/* ---------- 整页滚动（10/5 Ken：两栏不各自滚，整页一起滚） ----------
   右栏「设置」吸顶；滚下去以后顶上那一条（窗口按钮）里，滚上去的内容淡出；左下角出「回到顶部」；
   系统滚动条藏起来，换成右边一根细、淡、短的条（滚动时出现，停 1 秒淡掉；鼠标移到右边缘也出现，能拖）。设置抽屉里也是这根条。 */
(()=>{const root=document.documentElement,rail=$('#rail'),still=matchMedia('(prefers-reduced-motion: reduce)');
 /* 右栏卡片停的位置：平时停在页面上边距（窗口按钮那一条）下面；卡片比窗口还高时往上提，先跟着滚，底边露出来再停 */
 function railTop(){const st=rail.querySelector('.rail-stick');if(!st)return;const pad=parseFloat(getComputedStyle($('#app')).paddingTop)||48,v=Math.round(Math.min(pad,innerHeight-st.offsetHeight-32))+'px';if(rail.style.getPropertyValue('--rail-top')!==v)rail.style.setProperty('--rail-top',v);}
 const up=document.createElement('button');up.type='button';up.className='to-top';up.setAttribute('aria-label',T("ui.window.common.text2"));up.title=T("ui.window.common.text2");up.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 18.5V6M6.5 11.5 12 6l5.5 5.5"/></svg>';document.body.append(up);
 up.addEventListener('click',()=>{const kb=document.activeElement===up&&root.dataset.input!=='pointer';scrollTo({top:0,behavior:still.matches?'auto':'smooth'});up.classList.remove('on');if(kb)document.querySelector('#main [role="tab"][aria-selected="true"]')?.focus({preventScroll:true});else up.blur();});
 let tick=0;const onScroll=()=>{if(tick)return;tick=requestAnimationFrame(()=>{tick=0;const y=scrollY;root.classList.toggle('scrolled',y>1);up.classList.toggle('on',y>innerHeight*.35);});};
 function bar(scroller,host,doc){const b=document.createElement('div');b.className='sbar';b.setAttribute('aria-hidden','true');b.innerHTML='<i></i>';b.hidden=true;host.append(b);const t=b.firstChild;let hide=0,drag=null,raf=0,k=null;
  const place=()=>{raf=0;const view=doc?innerHeight:scroller.clientHeight,total=scroller.scrollHeight,max=total-view;
   if(!doc){b.style.top=(scroller.offsetTop+8)+'px';b.style.bottom=Math.max(8,host.clientHeight-scroller.offsetTop-scroller.clientHeight+8)+'px';}
   if(max<2||!view){if(!b.hidden)b.hidden=true;k=null;return;}if(b.hidden)b.hidden=false;
   const track=b.clientHeight,len=Math.round(Math.max(24,Math.min(track*.45,track*view/total))),pos=(track-len)*Math.min(1,Math.max(0,scroller.scrollTop/max));
   t.style.height=len+'px';t.style.transform=`translateY(${pos.toFixed(1)}px)`;k={track,len,max};};
  const queue=()=>{if(!raf)raf=requestAnimationFrame(place);};
  const show=()=>{b.classList.add('on');clearTimeout(hide);hide=setTimeout(()=>{if(!drag)b.classList.remove('on');},1000);};
  (doc?window:scroller).addEventListener('scroll',()=>{queue();show();},{passive:true});
  t.addEventListener('pointerdown',e=>{if(e.button!==0||!k)return;e.preventDefault();t.setPointerCapture(e.pointerId);drag={y:e.clientY,top:scroller.scrollTop,ratio:k.max/Math.max(1,k.track-k.len)};b.classList.add('drag');});
  t.addEventListener('pointermove',e=>{if(drag)scroller.scrollTop=drag.top+(e.clientY-drag.y)*drag.ratio;});
  const end=()=>{if(!drag)return;drag=null;b.classList.remove('drag');show();};
  for(const name of ['pointerup','pointercancel','lostpointercapture'])t.addEventListener(name,end);
  return queue;}
 const docBar=bar(document.scrollingElement||root,document.body,true),drawerBody=$('#drawerBody'),drawerBar=bar(drawerBody,$('#drawer'),false);
 /* 底部留白由 CSS 固定；不再用当前溢出状态反写被观察容器。 */
 let lay=0,seenStick=null;const relayout=()=>{if(!lay)lay=requestAnimationFrame(()=>{lay=0;const st=rail.querySelector('.rail-stick');if(st&&st!==seenStick){seenStick=st;ro.observe(st);}fitRecent();railTop();docBar();});};
 const ro=new ResizeObserver(()=>relayout());ro.observe($('#app'));ro.observe(rail);
 new ResizeObserver(drawerBar).observe(drawerBody);new MutationObserver(drawerBar).observe(drawerBody,{childList:true,subtree:true,characterData:true});
 addEventListener('scroll',onScroll,{passive:true});addEventListener('resize',()=>{relayout();drawerBar();onScroll();});
 railTop();onScroll();})();
// H10 display fence: an HTTP state snapshot started before a later stream update
// must not restore an invalidated completion proof. This is not an auth token.
let h10StreamArrivalSerial=0;
/* 0010（Claude，#55）：后台直接给窗口看的那些话（连接卡、修复清单、工具表提示、更新失败、Chrome 助手、刷新任务的步骤、摘要和任务页上那句话、自动任务标题）
   以后都带一个 X_key（和要填的 X_params），窗口按 ui.server.<X_key> 从自己的词条取字，跟着窗口的语言走。
   后台没给 key、或者这一版窗口还没有这条词（新旧版本错开）时，才退回后台原来那句。参数里也可以再套 {key,params}，最多套两层（刷新任务里「助手那句话」里还带着文件夹那句）。
   状态一到就换好（adoptState），换语言时再换一遍（applyLocalText）；有 key 就总是按 key 取，所以换几遍都一样。 */
const SERVER_KEY=/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9_]*){1,7}$/,SERVER_PARAM=/^[A-Za-z][A-Za-z0-9_]*$/;
function serverWord(key,params,depth=0){if(typeof key!=='string'||!SERVER_KEY.test(key))return null;const full='ui.server.'+key,out={};if(params&&typeof params==='object'&&!Array.isArray(params))for(const [name,value] of Object.entries(params)){if(!SERVER_PARAM.test(name))continue;if(typeof value==='string'||typeof value==='number')out[name]=value;else if(depth<2&&value&&typeof value==='object'){const nested=serverWord(value.key,value.params,depth+1);if(nested!=null)out[name]=nested;}}const text=T(full,out);return text===full?null:text;}
function serverText(o,field){if(!o)return '';const word=serverWord(o[field+'_key'],o[field+'_params']);return word??(typeof o[field]==='string'?o[field]:'');}
function localizeFields(o,fields){if(!o||typeof o!=='object'||!fields.some(f=>o[f+'_key']))return o;const next={...o};for(const f of fields)if(o[f+'_key'])next[f]=serverText(o,f);return next;}
function localizeTask(t){if(!t||typeof t!=='object')return t;let next=localizeFields(t,['title','summary']);const a=t.automatic_task;if(a&&typeof a==='object'){let na=localizeFields(a,['message']);if(Array.isArray(a.steps)&&a.steps.some(x=>x?.title_key||x?.detail_key)){if(na===a)na={...a};na.steps=a.steps.map(x=>localizeFields(x,['title','detail']));}if(a.tool_list_status?.message_key){if(na===a)na={...a};na.tool_list_status=localizeFields(a.tool_list_status,['message','new_conversation_note']);}if(na!==a){if(next===t)next={...t};next.automatic_task=na;}}return next;}
function localizeServerState(s){
 if(!s||typeof s!=='object')return s;const out={...s};
 const d=s.connection?.display;if(d){const nd=localizeFields(d,['title','detail']),w=d.settings_warning,nw=w?localizeFields(w,['title','detail']):w;if(nd!==d||nw!==w)out.connection={...s.connection,display:{...nd,...(w?{settings_warning:nw}:{})}};}
 const r=s.repair;if(r&&(Array.isArray(r.items)||r.summary)){out.repair={...r,items:Array.isArray(r.items)?r.items.map(item=>{const ni=localizeFields(item,['title','message']);return item?.action?.label_key?{...ni,action:localizeFields(item.action,['label'])}:ni;}):r.items,...(r.summary?{summary:localizeFields(r.summary,['text'])}:{})};}
 if(s.tools_list_status)out.tools_list_status=localizeFields(s.tools_list_status,['message','new_conversation_note']);
 if(s.tools_refresh){const tr=localizeFields(s.tools_refresh,['message','summary']);out.tools_refresh=s.tools_refresh.tool_list_status?.message_key?{...tr,tool_list_status:localizeFields(s.tools_refresh.tool_list_status,['message','new_conversation_note'])}:tr;}
 const ins=s.update?.install;if(ins?.message_key)out.update={...s.update,install:localizeFields(ins,['message'])};
 const h=s.automation?.browser?.extension?.helper;if(h?.message_key)out.automation={...s.automation,browser:{...s.automation.browser,extension:{...s.automation.browser.extension,helper:localizeFields(h,['message'])}}};
 if(Array.isArray(s.tasks))out.tasks=s.tasks.map(localizeTask);
 if(Array.isArray(s.activity?.items))out.activity={...s.activity,items:s.activity.items.map(g=>Array.isArray(g?.tasks)?{...g,tasks:g.tasks.map(localizeTask)}:g)};
 return out;}
function adoptState(state){if(swapping){swapPendingState=state;return;}S=localizeServerState(state);window.h10Refresh?.(S);window.ChatHandSkin?.adoptSettings(S.settings);synchronizeAppearance();if(IN_APP)setRootNumber('--ui-zoom',S.settings?.ui_zoom);if(!appearanceApplied){appearanceApplied=true;permissionHintReady=!S.settings?.onboarding;}window.wizardRefresh?.(S);noteBrowserFixed();scheduleRender();setTimeout(maybeShowAppMissing,0);}
// 1081（Claude，Ken 10/27 10:07）：点了「打开插件页面」以后插件连上了：「浏览器控制」那条自己消失，再提示一句。
function noteBrowserFixed(){if(!browserFixPending)return;const x=S?.automation?.browser?.extension||{};if(x.connected===true&&(x.compatibility?.state==='compatible'||x.compatibility?.state==='partial')){browserFixPending=false;void extensionSuccessToast(T("ui.window.capBrowser.connected"),'chrome-store');}}
function adoptPatch(patch){const next={...(swapPendingState||S)};for(const [key,value] of Object.entries(patch)){if(value===null)delete next[key];else next[key]=value;}adoptState(next);}
/* ---------- 动效：页面背景（1014 精修）
   trail 鼠标划过留下淡方块（1011 的）；dots 网点；orb 右上角光团；dots-orb 网点加光团（默认）；aurora 顶上极光（旧）。
   网点的鼠标效果两种：glow 附近的点亮起来，后面拖一小段尾巴（三层圆盘，整窗固定的网点遮罩，圆盘只做位移）；push 附近的点轻轻让开（画布）。
   右上角背景（orb / dots-orb）：画法在 backdrops.js（「柔光」：四团软光）。
   颜色：--fx-h 在 --hue-a～--hue-b（薄荷→天蓝→淡紫）之间来回走，时间和鼠标移动都会推它；光团、光斑、卡片边缘高光、任务流光一起变。
   窗口不在前台照常动（以前会停，看着像卡住了）；窗口最小化或被完全挡住时浏览器自己停；「减少动态效果」时光团只画一帧，光斑不出现。
   参数都读 CSS 变量（皮肤里写；变量改了发 chathand:fx 事件就重读）。 */
(()=>{const cv=$('#fx'),ctx=cv?.getContext?.('2d');if(!ctx)return;
 const root=document.documentElement,reduce=matchMedia('(prefers-reduced-motion: reduce)'),TAU=Math.PI*2;
 const COL=['--trail-rgb-a','--trail-rgb-b','--trail-rgb-c'],MODES=['trail','dots','orb','dots-orb','aurora'],PALS=['mint','dawn','sky','status'],GAPS=['14','16','20'],MICE=['glow','push'];
 const pick=(k,list,def)=>{try{const v=localStorage.getItem('chathand.'+k);if(list.includes(v))return v;}catch{}return def;};
 const save=(k,v)=>{try{localStorage.setItem('chathand.'+k,v);}catch{}};
 let mode=pick('fx',MODES,'dots-orb'),pal=pick('fx.pal',PALS,'mint'),gapK=pick('fx.gap',GAPS,'16'),mouse=pick('fx.mouse',MICE,'glow');
 let w=0,h=0,raf=0,last=null,amax=.12,cur=null,quiet=-Infinity;const cells=new Map(),offs=new Map();
 const CELL=12,TG=2,P=CELL+TG,IN=80,OUT=900,MAX=300,QUIET=900;
 /* 参数：全部从 CSS 变量读 */
 const F={};const num=(cs,k,d)=>{const v=parseFloat(cs.getPropertyValue(k));return Number.isFinite(v)?v:d;};
 function readFx(){const cs=getComputedStyle(root),dh=num(cs,'--theme-h',172)-172;Object.assign(F,{hueA:num(cs,'--hue-a',165)+dh,hueB:num(cs,'--hue-b',295)+dh,hueTime:num(cs,'--hue-time',1),hueMove:num(cs,'--hue-move',1),
  aL:num(cs,'--aura-l',.9),aC:num(cs,'--aura-c',.1),aAlpha:num(cs,'--aura-alpha',.6),aSize:num(cs,'--aura-size',1),aSpeed:num(cs,'--aura-speed',1),aReach:num(cs,'--aura-reach',.46),aX:num(cs,'--aura-x',0),aY:num(cs,'--aura-y',0),
  trail:num(cs,'--spot-trail',.6),spot:num(cs,'--spot-size',280),wash:num(cs,'--spot-wash',0),edge:num(cs,'--edge-size',200),edgeA:num(cs,'--edge-a',.8),
  dotsGap:num(cs,'--dots-gap',12),dotsSize:num(cs,'--dots-size',.75),spotDot:num(cs,'--spot-dot',.95),dotsA:num(cs,'--dots-a',1),gridSnap:num(cs,'--grid-snap',1),bgMotion:num(cs,'--bg-motion',1),dark:root.dataset.scheme==='dark'});root.classList.toggle('bg-still',F.bgMotion<.5);
  const snapOn=F.gridSnap>=.5;if(root.classList.contains('snap-grid')!==snapOn||snapOn){root.classList.toggle('snap-grid',snapOn);requestAnimationFrame(()=>{snapGrid();sizeRing();fitRecent();});}}
 /* 1011 的方块轨迹（trail 模式）：颜色从皮肤变量读 */
 const tri=()=>{const cs=getComputedStyle(root);return COL.map(t=>cs.getPropertyValue(t).split(',').map(Number));};
 const paint=(rgb,a)=>`rgba(${rgb},${a})`;
 const mix=(f,pal)=>{f=((f%3)+3)%3;const i=Math.floor(f),j=(i+1)%3,k=f-i;return pal[i].map((v,n)=>Math.round(v+(pal[j][n]-v)*k)).join(',');};
 const hasDots=()=>mode==='dots'||mode==='dots-orb',busy=()=>reduce.matches||!!document.querySelector('dialog[open]:not(.closing)');
 /* 网点的间距和大小读 CSS 变量（--dots-gap / --dots-size / --spot-dot，皮肤里写）；gapK 是旧的三档预设，只留着兼容 setFx。
    大小可以是 0（一个点都不画），所以不能写 ||（0 会被当成没设）。dotR 是底层点的半径，litR 是被鼠标照亮的点的半径。 */
 const gap=()=>Math.max(4,F.dotsGap||12),dotR=()=>Math.max(0,Number.isFinite(F.dotsSize)?F.dotsSize:.75),litR=()=>Math.max(0,Number.isFinite(F.spotDot)?F.spotDot:.95);
 /* 画布上点的半径：CSS 的点有一圈虚边（min(.6, 2r)），画布没有虚边，取到虚边的中间，即 r + min(.3, r)；r 为 0 时是 0，不画 */
 const cr=r=>r+Math.min(.3,r);
 const pushOn=()=>hasDots()&&mouse==='push';
 function size(){const d=Math.min(3,devicePixelRatio||1),need=mode==='trail'||pushOn();w=innerWidth;h=innerHeight;cv.width=need?Math.round(w*d):1;cv.height=need?Math.round(h*d):1;ctx.setTransform(d,0,0,d,0,0);base=null;paintStill();BD?.resize();}
 function hitCell(x,y,a){const cx=Math.floor(x/P),cy=Math.floor(y/P),k=cx+','+cy,now=performance.now(),c=cells.get(k);if(c){c.t=now;c.a=Math.max(c.a,a);return;}if(cells.size<MAX)cells.set(k,{cx,cy,t:now,a});}
 function drawTrail(now){const pal=tri();for(const [k,c] of cells){const age=now-c.t;if(age>IN+OUT){cells.delete(k);continue;}const f=age<IN?age/IN:1-(age-IN)/OUT,al=amax*c.a*(age<IN?f:f*f);ctx.fillStyle=paint(mix(c.cx*.135+c.cy*.105,pal),al.toFixed(3));const x=c.cx*P+TG/2,y=c.cy*P+TG/2;if(ctx.roundRect){ctx.beginPath();ctx.roundRect(x,y,CELL,CELL,2);ctx.fill();}else ctx.fillRect(x,y,CELL,CELL);}return cells.size>0;}
 /* 网点 · 让开（push）：网点改在画布上画，鼠标附近的点往外让一点、带上颜色，鼠标停下后弹回去 */
 let base=null,baseKey='',dotRGB=[23,26,24],dotA=.085,litRGB=[0,186,148],litA=.8,skyRGB=[38,156,236];
 const rgba=v=>{const m=String(v).match(/[\d.]+/g)||[];return [[+m[0]||0,+m[1]||0,+m[2]||0],m[3]!=null?+m[3]:1];};
 /* 网点原点：平时在每格中心（g/2）；对齐网点时落在网格线上——竖向从页面顶边起，横向跟着页面左边距（左右平分零头后，左边距除以 g 的余数）。
    整页滚动（10/5）：网点跟着页面走，画布固定在窗口上，所以底图多画一格高，按「滚动距离除以 g 的余数」sy 往上挪着贴 */
 let ox0=8,oy0=8,sy=0;
 const dotOrigin=g=>{if(!root.classList.contains('snap-grid'))return [g/2,g/2];const d=document.querySelector('.dash'),p=d?parseFloat(getComputedStyle(d).paddingLeft)||0:0;return [((p%g)+g)%g,0];};
 function buildBase(){const cs=getComputedStyle(root);[dotRGB,dotA]=rgba(cs.getPropertyValue('--dot'));dotA=Math.min(1,dotA*Math.max(0,F.dotsA));[litRGB,litA]=rgba(cs.getPropertyValue('--spot1'));[skyRGB]=rgba(cs.getPropertyValue('--spot2'));
  const d=Math.min(3,devicePixelRatio||1),g=gap(),oc=document.createElement('canvas');oc.width=cv.width;oc.height=Math.round((h+g)*d);const o=oc.getContext('2d');o.setTransform(d,0,0,d,0,0);
  o.fillStyle=paint(dotRGB.join(','),dotA);const r=cr(dotR());[ox0,oy0]=dotOrigin(g);if(r>0){o.beginPath();for(let y=oy0;y<h+2*g;y+=g)for(let x=ox0;x<w+g;x+=g){o.moveTo(x+r,y);o.arc(x,y,r,0,TAU);}o.fill();}
  base=oc;baseKey=dotKey();}
 const dotKey=()=>getComputedStyle(root).getPropertyValue('--dot')+'|'+gap()+'|'+dotR()+'|'+litR()+'|'+F.dotsA+'|'+F.gridSnap+'|'+w+'x'+h;
 function drawPush(){const g=gap(),rb=cr(dotR()),rl=cr(litR()),R=112,F7=7;if(!base||baseKey!==dotKey())buildBase();const oy=oy0-sy;
  ctx.drawImage(base,0,-sy,w,h+g);
  if(cur){const gx0=Math.floor((cur.x-R-ox0)/g),gx1=Math.ceil((cur.x+R-ox0)/g),gy0=Math.floor((cur.y-R-oy)/g),gy1=Math.ceil((cur.y+R-oy)/g);
   for(const o of offs.values())o.on=false;
   for(let gx=gx0;gx<=gx1;gx++)for(let gy=gy0;gy<=gy1;gy++){const x=ox0+gx*g,y=oy+gy*g,dx=x-cur.x,dy=y-cur.y,dd=Math.hypot(dx,dy);if(dd>R||dd<.01)continue;
    const k=gx+','+gy,e=(1-dd/R)**2;let o=offs.get(k);if(!o){o={x,y,ox:0,oy:0,e:0};offs.set(k,o);}o.on=true;o.tx=dx/dd*F7*e;o.ty=dy/dd*F7*e;o.te=1-dd/R;}}
  let moving=false;
  for(const [k,o] of offs){if(!cur||!o.on){o.tx=0;o.ty=0;o.te=0;}o.ox+=(o.tx-o.ox)*.16;o.oy+=(o.ty-o.oy)*.16;o.e+=(o.te-o.e)*.16;
   if(!o.on&&Math.abs(o.ox)<.05&&Math.abs(o.oy)<.05&&o.e<.01){offs.delete(k);continue;}moving=true;}
  if(offs.size){if(rb>0){ctx.globalCompositeOperation='destination-out';ctx.fillStyle=paint(dotRGB.join(','),1);ctx.beginPath();for(const o of offs.values()){ctx.moveTo(o.x+rb+1,o.y);ctx.arc(o.x,o.y,rb+1,0,TAU);}ctx.fill();ctx.globalCompositeOperation='source-over';}
   /* 亮点的半径从底层点（e=0）长到 --spot-dot（e=1）；两个一样大就只变颜色 */
   for(const o of offs.values()){const e=Math.max(0,Math.min(1,o.e)),rr=rb+(rl-rb)*e;if(rr<=0)continue;const c=skyRGB.map((v,n)=>Math.round(v+(litRGB[n]-v)*e));ctx.fillStyle=paint(c.join(','),(dotA+(litA-dotA)*Math.min(1,e*1.3)).toFixed(3));ctx.beginPath();ctx.arc(o.x+o.ox,o.y+o.oy,rr,0,TAU);ctx.fill();}}
  return moving||!!cur;}
 function paintStill(){ctx.clearRect(0,0,w,h);if(pushOn()){offs.clear();cur=null;drawPush();}}
 function frame(now){raf=0;if(!motionVisible())return;ctx.clearRect(0,0,w,h);let more=false;
  if(mode==='trail')more=drawTrail(now);
  else if(pushOn()){if(cur&&now-quiet>QUIET)cur=null;more=drawPush();}
  if(more)raf=requestAnimationFrame(frame);}
 function kick(){if(!raf)raf=requestAnimationFrame(frame);}

 /* ---- 共用的颜色：相位 phi 随时间慢慢走，鼠标每移动约 2400 像素走一圈；色相 = a～b 之间按余弦来回 ---- */
 let phi=0,hueT=performance.now(),moveAcc=0,cssH=null,cssH2=null,cssAt=0;
 /* 色相范围（第三个数是饱和度系数）：默认薄荷→淡紫；dawn / 等你处理 暖粉→杏；sky / 空闲 天蓝→淡紫；连不上 灰 */
 function arcRange(){const st=root.classList;if(pal==='dawn'||pal==='status'&&st.contains('st-wait'))return [345,410,1];if(pal==='sky'||pal==='status'&&st.contains('st-idle'))return [215,290,1];if(pal==='status'&&st.contains('st-off'))return [220,260,.15];return [F.hueA,F.hueB,1];}
 const hueAt=p=>{const [a,b]=arcRange();return a+(b-a)*(.5-.5*Math.cos(p));};
 function hueStep(now){const dt=Math.min(.1,Math.max(0,(now-hueT)/1000));hueT=now;phi+=dt*TAU/40*F.hueTime+moveAcc/2400*TAU*F.hueMove;moveAcc=0;}
 function hueCss(now){const h=hueAt(phi),h2=hueAt(phi+Math.PI);if(cssH!==null&&Math.abs(h-cssH)<.3&&Math.abs(h2-cssH2)<.3)return;if(!spotOn&&now-cssAt<240)return;cssH=h;cssH2=h2;cssAt=now;root.style.setProperty('--fx-h',h.toFixed(1));root.style.setProperty('--fx-h2',h2.toFixed(1));}
 function oklch(L,C,hue){const r0=hue*Math.PI/180,a=C*Math.cos(r0),b=C*Math.sin(r0),l=(L+.3963377774*a+.2158037573*b)**3,m=(L-.1055613458*a-.0638541728*b)**3,s=(L-.0894841775*a-1.291485548*b)**3;
  const g=x=>{x=Math.max(0,Math.min(1,x));return Math.round(255*(x<=.0031308?12.92*x:1.055*x**(1/2.4)-.055));};
  return [g(4.0767416621*l-3.3077115913*m+.2309699292*s),g(-1.2684380046*l+2.6097574011*m-.3413193965*s),g(-.0041960863*l-.7034186147*m+1.707614701*s)];}

 /* ---- 右上角背景：画法在 backdrops.js（「柔光」），这里只给它颜色和参数、按帧调用 ---- */
 const BD=window.ChatHandBackdrops||null;
 /* reduce()：「减少动态效果」或皮肤让背景不动（--bg-motion 为 0）时为真——背景只画一帧，不进循环 */
 const bctx={params:()=>F,phase:()=>phi,arc:()=>arcRange(),oklch,reduce:()=>reduce.matches||F.bgMotion<.5};
 /* ---- 鼠标光斑：三层圆盘（第一层最快，后两层慢一点拖出尾巴），外加一层不经过网点的淡光（--spot-wash） ---- */
 const spot=document.createElement('div');spot.className='fx-spot';spot.setAttribute('aria-hidden','true');spot.innerHTML='<i></i><i></i><i></i>';
 const wash=document.createElement('div');wash.className='fx-wash';wash.setAttribute('aria-hidden','true');wash.innerHTML='<i></i>';
 const discs=[...spot.children,wash.firstChild].map((el,i)=>({el,x:-999,y:-999,m:[1,1.14,1.3,1.6][i],lag:[0,.55,.8,.35][i]}));
 let tx=0,ty=0,spotOn=false,spotMoving=false,qtimer=0,lx=null,ly=null;
 function stepSpot(){let moving=false;for(const d of discs){const k=.34*(1-F.trail*d.lag);d.x+=(tx-d.x)*k;d.y+=(ty-d.y)*k;if(Math.abs(tx-d.x)>.25||Math.abs(ty-d.y)>.25)moving=true;else{d.x=tx;d.y=ty;}const s=F.spot*d.m/2;d.el.style.transform=`translate3d(${(d.x-s).toFixed(1)}px,${(d.y-s).toFixed(1)}px,0)`;}edgeLight();return moving;}
 /* 卡片边缘高光：鼠标附近的卡片，把鼠标在卡片里的位置写进 --mx/--my（CSS 用它画描边上的一段亮光） */
 const EDGE='.card,.tp-in,.orow';let lit=new Set();
 function edgeLight(){if(F.edgeA<=0){for(const el of lit){el.style.removeProperty('--mx');el.style.removeProperty('--my');}lit=new Set();return;}const x=discs[0].x,y=discs[0].y,R=F.edge*1.6,next=new Set();
  for(const el of document.querySelectorAll(EDGE)){const b=el.getBoundingClientRect();if(!b.width||x<b.left-R||x>b.right+R||y<b.top-R||y>b.bottom+R)continue;next.add(el);el.style.setProperty('--mx',(x-b.left).toFixed(0)+'px');el.style.setProperty('--my',(y-b.top).toFixed(0)+'px');}
  for(const el of lit)if(!next.has(el)){el.style.removeProperty('--mx');el.style.removeProperty('--my');}lit=next;}
 function spotOff(){spotOn=false;spot.classList.remove('on');wash.classList.remove('on');root.classList.remove('fx-near');}

 /* ---- 一个循环管光团（30 帧/秒）、光斑（跟手）、颜色 ---- */
 let lraf=0,lastAura=-1e9,lastLoop=-Infinity,tickT=0;
 const motionVisible=()=>!document.hidden&&window.__chathandWindowVisible!==false;
 const motionActive=now=>root.classList.contains('st-run')||now-quiet<QUIET||spotMoving;
 function loop(now){lraf=0;if(!motionVisible())return;if(now-lastLoop<1000/30){if(motionActive(now)||spotOn||spotMoving)lraf=requestAnimationFrame(loop);return;}lastLoop=now;hueStep(now);let again=false;
  if(spotOn||spotMoving){spotMoving=stepSpot();again=spotOn||spotMoving;}
  if(BD?.attached()&&!bctx.reduce()&&motionActive(now)){if(now-lastAura>=1000/30){BD.frame(now);lastAura=now;}again=true;}
  root.classList.toggle('fx-active',motionActive(now));
  hueCss(now);
  if(again)lraf=requestAnimationFrame(loop);else idleTick();}
 function kickLoop(){if(lraf||!motionVisible())return;clearTimeout(tickT);tickT=0;lraf=requestAnimationFrame(loop);}
 /* 光团关着、鼠标也没动时：只要有在跑的任务（流光跟着变色），每 250 毫秒推一下颜色 */
 function idleTick(){if(tickT||lraf||!motionVisible())return;if(!root.classList.contains('st-run')||reduce.matches)return;tickT=setTimeout(()=>{tickT=0;const now=performance.now();hueStep(now);hueCss(now);idleTick();},250);}

 function move(e){if(busy()||!motionVisible())return;quiet=performance.now();const x=e.clientX,y=e.clientY;
  if(lx!==null){const m=Math.hypot(x-lx,y-ly);if(m<300)moveAcc+=m;}lx=x;ly=y;
  if(mode==='trail'){if(last){const dx=x-last.x,dy=y-last.y,n=Math.min(40,Math.ceil(Math.hypot(dx,dy)/(P/2)));for(let i=1;i<=n;i++)hitCell(last.x+dx*i/n,last.y+dy*i/n,1);}else hitCell(x,y,1);
   for(let i=0;i<2;i++)if(Math.random()<.35)hitCell(x+(Math.random()*3-1.5)*P,y+(Math.random()*3-1.5)*P,.35+Math.random()*.3);
   amax=parseFloat(getComputedStyle(root).getPropertyValue('--trail-a'))||.12;last={x,y};kick();kickLoop();return;}
  if(!hasDots()){kickLoop();return;}
  if(mouse==='push'){cur={x,y};quiet=performance.now();kick();kickLoop();return;}
  tx=x;ty=y;if(!spotOn){for(const d of discs){d.x=x;d.y=y;}}
  spotOn=true;spot.classList.add('on');wash.classList.toggle('on',F.wash>0);root.classList.add('fx-near');
  clearTimeout(qtimer);qtimer=setTimeout(spotOff,QUIET);kickLoop();}
 function apply(){for(const m of MODES)root.classList.toggle('bg-'+m,m===mode);for(const p of PALS)root.classList.toggle('pal-'+p,p===pal);
  root.classList.toggle('glass',mode!=='trail');root.classList.toggle('dots-canvas',pushOn());
  cells.clear();offs.clear();last=null;cur=null;spotOff();readFx();
  const wantSpot=hasDots()&&mouse==='glow'&&!reduce.matches;if(wantSpot&&!spot.isConnected){document.body.prepend(wash);document.body.prepend(spot);}if(!wantSpot){spot.remove();wash.remove();}
  if(mode==='orb'||mode==='dots-orb')BD?.attach(bctx);else BD?.detach();
  document.querySelector('.fx-orb')?.remove();
  let old=document.querySelector('.fx-aurora');if(mode==='aurora'&&!old){old=document.createElement('div');old.className='fx-aurora';old.setAttribute('aria-hidden','true');old.innerHTML='<i></i>'.repeat(4);document.body.prepend(old);}if(mode!=='aurora')old?.remove();
  base=null;size();hueCss(performance.now());if(BD?.attached()&&motionVisible()){BD.frame(performance.now());lastAura=performance.now();}kickLoop();}
 window.setFx=(m,o={})=>{if(MODES.includes(m))mode=m;if(PALS.includes(o.pal))pal=o.pal;if(GAPS.includes(String(o.gap)))gapK=String(o.gap);if(MICE.includes(o.mouse))mouse=o.mouse;
  save('fx',mode);save('fx.pal',pal);save('fx.gap',gapK);save('fx.mouse',mouse);apply();};
 window.getFx=()=>({mode,pal,gap:gapK,mouse});
 /* 状态：在跑、等你处理、空闲、连不上（pal-status 时颜色跟着变）；有在跑的任务时，保证流光的颜色在走 */
 window.fxStatus=st=>{for(const s of ['run','wait','idle','off'])root.classList.toggle('st-'+s,s===st);if(st==='run')kickLoop();else idleTick();};
 const refresh=()=>{readFx();scrolled();base=null;paintStill();BD?.refresh();cssH=null;hueCss(performance.now()+1e3);lastAura=-1e9;if(BD?.attached()&&motionVisible())BD.frame(performance.now());kickLoop();};
 /* 页面滚动：光斑的网点遮罩、让开模式的画布都跟着网点挪（只挪不到一格的零头） */
 function scrolled(){const g=gap(),v=Math.round((((scrollY%g)+g)%g)*100)/100;spot.style.setProperty('--sy',v+'px');if(v!==sy){sy=v;if(pushOn()){offs.clear();kick();}}}
 readFx();apply();scrolled();addEventListener('resize',size);addEventListener('scroll',scrolled,{passive:true});addEventListener('pointermove',move,{passive:true});
 root.addEventListener('mouseleave',()=>{last=null;cur=null;lx=null;spotOff();kick();});
 matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change',refresh);
 new MutationObserver(refresh).observe(root,{attributes:true,attributeFilter:['data-theme','data-scheme','data-skin']});
 addEventListener('chathand:fx',refresh);addEventListener('chathand:skin',refresh);
 addEventListener('blur',()=>{last=null;cur=null;lx=null;spotOff();kick();});
 function visibilityChanged(){const visible=motionVisible();root.classList.toggle('fx-paused',!visible);if(!visible){cancelAnimationFrame(lraf);lraf=0;cancelAnimationFrame(raf);raf=0;clearTimeout(tickT);tickT=0;spotOff();cur=null;last=null;}else{hueT=performance.now();BD?.frame(hueT);kickLoop();}}
 document.addEventListener('visibilitychange',visibilityChanged);
 addEventListener('chathand:window-visibility',visibilityChanged);
 reduce.addEventListener?.('change',apply);})();

/* ---------- 浏览器、桌面控制的旧弹窗（浏览器控制页信息表里「连接方式」那一行打开） ----------
   1052 补丁 2（Claude，10/16）：标题叫「连接方式」，和打开它的那一行同名；选连接方式的下拉框挪到标题下面，不再另起一个同名小标题，
   下面是这种方式现在怎么样，和「重新检查连接」这类按钮（都放一行）。原来那个叫停浏览器动作的按钮去掉了。 */
function browserSheet(){
 const b=S.automation?.browser||{},x=b.extension||{},p=b.personal||{},v=p.chrome||{},backend=S.settings.browser_backend||'extension',personal=backend==='personal',mac=(S.platform||'darwin')==='darwin',unavailable=personal&&!mac,observed=personal?v:(mac?v:{}),minimum=personal?Math.max(144,Number(v.minimum_major)||144):128,tooOld=!unavailable&&Number.isInteger(observed.major)&&observed.major<minimum,connected=personal?p.connected===true:x.connected===true,canConnect=personal&&!unavailable&&observed.installed!==false&&!tooOld;
 const description=unavailable?T("ui.window.browserSheet.text"):personal?(connected?T("ui.window.browserSheet.text2"):T("ui.window.browserSheet.text3")):backend==='isolated'?T("ui.window.browserSheet.text4"):(connected?T("ui.window.browserSheet.text5"):T("ui.window.browserSheet.text6"));
 const requirement=personal?T("ui.window.browserSheet.text7",{"minimum":minimum}):T("ui.window.browserSheet.text8"),version=observed.version?T("ui.window.browserSheet.text9",{"version":E(observed.version)}):T("ui.window.browserSheet.text10");
 const primary=unavailable?'':personal?(canConnect?btn(connected?T("ui.window.browserSheet.text11"):T("ui.window.browserSheet.text12"),'connectLegacy','','sm primary'):btn(T("ui.window.browserSheet.text13"),'chromeUpdate','','sm primary')):tooOld?btn(T("ui.window.browserSheet.text14"),'chromeUpdate','','sm primary'):btn(x.connected?T("ui.window.browserSheet.text11"):T("ui.window.blockCard.text2"),x.connected&&x.distribution==='chrome_web_store'?'browserReconnect':'extensionSetup','','sm primary');
 const acts=(backend==='isolated'?btn(T("ui.window.browserSheet.text15"),'openIsolated','','sm'):primary)+(personal&&!unavailable?btn(T("ui.window.browserSheet.text16"),'chromeSetup','','sm ghost'):'');
 modal(("<h2>"+(TH("ui.window.browserSheet.text18"))+"</h2><select id=\"backend\" aria-label=\""+(TH("ui.window.browserSheet.text18"))+"\">"+(browserBackends().map(([id,label])=>`<option value="${id}" ${backend===id?'selected':''}>${label}</option>`).join(''))+"</select><p>"+(description)+"</p>"+(backend==='isolated'?'':`<p>${version} · ${requirement}</p>`)+(tooOld?("<p class=\"notice\">"+(TH("ui.window.browserSheet.text17",{"minimum":minimum}))+"</p>"):'')+(acts?`<div class="actions">${acts}</div>`:'')));
}
// 浏览器的三种连接方式：弹窗里的下拉框和浏览器控制页的「连接方式」那一行都用这一份名字。
function browserBackends(){return [['extension',T("ui.window.browserBackends.text")],['personal',T("ui.window.browserBackends.text2")],['isolated',T("ui.window.browserBackends.text3")]];}

let chromeInstallView=0,chromeInstallTimer=null,chromeInstallActive=false,chromeInstallRun=0;
const chromeInstallSuccessKeys=new Set();
function chromeInstallSucceeded(status,message){const key=chromeAttemptID(status)||'run:'+chromeInstallRun;if(chromeInstallSuccessKeys.has(key))return;chromeInstallSuccessKeys.add(key);if(chromeInstallSuccessKeys.size>32)chromeInstallSuccessKeys.delete(chromeInstallSuccessKeys.values().next().value);stopChromeInstallView(false);void extensionSuccessToast(message,'chrome-install');}
function stopChromeInstallView(cancel=true){const active=chromeInstallActive;chromeInstallActive=false;chromeInstallView++;if(chromeInstallTimer!==null){clearTimeout(chromeInstallTimer);chromeInstallTimer=null;}if(cancel&&active)void native('extensionCancel');}
function showChromeInstall(status){
 /* 1070 C3：一键换成新版（原生 extensionRepair）跟一键装共用这一个进度框，换的时候标题、字和后续按钮换成「换」的那套。
    这一轮是装还是换，记在 chromeInstallKind；状态里带了 kind 就以它为准（测试单独跑这个函数时没有那个变量，用 typeof 判断）。 */
 const repair=(status.kind??(typeof chromeInstallKind==='undefined'?'install':chromeInstallKind))==='repair',helper=repair?S?.automation?.browser?.extension?.helper:null;
 const done=status.phase==='installed_verified',active=status.active===true;
 if(done){chromeInstallSucceeded(status,repair?(helper?.expected_build?T("ui.window.extGuide.doneReplace",{build:helper.expected_build}):T("ui.window.extGuide.doneReplaceNoBuild")):T("ui.window.showChromeInstall.text"));return;}
 const cancelled=['INSTALL_CANCELLED','CHROME_INSTALL_CANCELLED'].includes(status.code);
 const specific={CHROME_INSTALL_PROFILE_UNKNOWN:T("ui.chrome.profile.unknown"),CHROME_DATA_ACCESS_DENIED:T("ui.chrome.dataAccess.blocked"),CHROME_DATA_ACCESS_WAITING:T("ui.chrome.dataAccess.waiting"),CHROME_DATA_ACCESS_TIMEOUT:T("ui.chrome.dataAccess.expired"),CHROME_INSTALL_ACCESSIBILITY_REQUIRED:T("ui.window.showChromeInstall.chromeInstallAccessibilityRequired.text"),CHROME_INSTALL_ACCESSIBILITY_TIMEOUT:T("ui.window.showChromeInstall.axTimeout"),INSTALL_ACCESS_CHANGED:T("ui.window.showChromeInstall.installAccessChanged.text"),CHROME_INSTALL_USER_INTERRUPTED:T("ui.window.showChromeInstall.chromeInstallUserInterrupted.text"),CHROME_INSTALL_CHROME_UNAVAILABLE:T("ui.window.showChromeInstall.chromeInstallChromeUnavailable.text"),CHROME_INSTALL_CHROME_TOO_OLD:T("ui.window.showChromeInstall.chromeInstallChromeTooOld.text"),CHROME_INSTALL_MANAGED_POLICY_BLOCKED:T("ui.window.showChromeInstall.chromeInstallManagedPolicyBlocked.text"),CHROME_INSTALL_NOT_INSTALLED:T("ui.window.showChromeInstall.notInstalled"),CHROME_INSTALL_OTHER_PROFILE:T("ui.window.showChromeInstall.otherProfile"),CHROME_INSTALL_NATIVE_HOST_NOT_CONNECTED:T("ui.window.showChromeInstall.nativeHostNotConnected"),CHROME_INSTALL_TARGET_HANDSHAKE_TIMEOUT:T("ui.window.showChromeInstall.handshakeTimeout")}[status.code];
 const retry=!active&&['CHROME_INSTALL_NOT_INSTALLED','CHROME_INSTALL_OTHER_PROFILE','CHROME_INSTALL_NATIVE_HOST_NOT_CONNECTED','CHROME_INSTALL_TARGET_HANDSHAKE_TIMEOUT'].includes(status.code);
 const waitAX=active&&status.stage==='waiting_accessibility';
 /* 1070 C1：辅助功能没开时，主按钮先开桌面控制（或只差辅助功能），授权完原生自己接着装 */
 const axFix=!active&&(['CHROME_INSTALL_ACCESSIBILITY_REQUIRED','CHROME_INSTALL_ACCESSIBILITY_TIMEOUT'].includes(status.code)||(status.code==='INSTALL_ACCESS_CHANGED'&&(!capOn('desktop_enabled')||!capOn('browser_enabled'))));
 const repairText=repair&&(status.code==='CHROME_INSTALL_ACCESSIBILITY_REQUIRED'||(status.code==='INSTALL_ACCESS_CHANGED'&&axFix))?T("ui.window.showChromeInstall.repairNeedsAX"):'';
 const text=status.code==='CHROME_DATA_ACCESS_WAITING'?specific:waitAX?T("ui.window.showChromeInstall.waitAX"):active?T(repair?"ui.window.showChromeInstall.repairRunning":"ui.window.showChromeInstall.text2"):repairText||specific||(cancelled?T(repair?"ui.window.showChromeInstall.repairCancelled":"ui.window.showChromeInstall.text3"):T(repair?"ui.window.showChromeInstall.repairUnconfirmed":"ui.window.showChromeInstall.text4"));
 const stage={preparing:T("ui.window.showChromeInstall.preparing.text"),opening_chrome:T("ui.window.showChromeInstall.opening_chrome.text"),checking_profile:T("ui.window.showChromeInstall.checking_profile.text"),extensions:T("ui.window.showChromeInstall.extensions.text"),loading_directory:T("ui.window.showChromeInstall.loading_directory.text"),validating_helper:T("ui.window.showChromeInstall.validating_helper.text"),waiting_accessibility:T("ui.window.showChromeInstall.waiting_accessibility.text"),removing_copy:T("ui.window.showChromeInstall.removing_copy.text")}[status.stage];
 const dataBlocked=status.code==='CHROME_DATA_ACCESS_DENIED';
 const detail=!active&&status.stage==='preparing'&&['CHROME_INSTALL_TARGET_UNKNOWN','CHROME_INSTALL_SHEET_UNKNOWN'].includes(status.code)&&typeof status.detail_code==='string'&&/^(WINDOWS_AX_ERROR|WINDOWS_VALUE_MISSING|WINDOWS_VALUE_INVALID|WINDOWS_TOO_MANY|WINDOW_ID_DUPLICATE|WINDOW_ROLE_AX_ERROR|WINDOW_ROLE_VALUE_INVALID|WINDOW_ROLE_MISMATCH|WINDOW_ID_READER_MISSING|WINDOW_ID_UNAVAILABLE|SHEETS_DEADLINE|SHEETS_TIMEOUT_AX_ERROR|SHEETS_AX_ERROR|SHEETS_NOVALUE_WITH_VALUE|SHEETS_VALUE_MISSING|SHEETS_VALUE_NOT_ARRAY|SHEETS_ARRAY_CAST_FAILED|SHEETS_ELEMENT_INVALID|SHEETS_PRESENT)$/.test(status.detail_code)?status.detail_code:'';
 const fallback=status.code==='CHROME_INSTALL_SHEET_UNKNOWN'&&detail==='SHEETS_AX_ERROR'&&status.ax_error===-25205&&typeof status.fallback_code==='string'&&/^(ENTRY_VALUE_PRESENT|DEADLINE|PERMISSION_CHANGED|TIMEOUT_SETUP_FAILED|WINDOW_ROLE_READ_FAILED|WINDOW_ROLE_INVALID|CHILDREN_READ_FAILED|CHILDREN_INVALID|CHILDREN_EMPTY|CHILDREN_LIMIT|CHILD_IDENTITY_INVALID|CHILD_ROLE_READ_FAILED|CHILD_ROLE_INVALID|CHILD_ROLE_DISALLOWED|CHILD_PARENT_READ_FAILED|CHILD_PARENT_INVALID|SNAPSHOT_CHANGED)$/.test(status.fallback_code)?status.fallback_code:'';
 const context=fallback==='CHILDREN_EMPTY'?[
  ['SAME','OTHER','UNKNOWN','PROCESS_CHANGED','ANCHOR_MISSING'].includes(status.window_relation)?'WINDOW_'+status.window_relation:'',
  ...[['empty_window_minimized','MINIMIZED'],['empty_window_main','MAIN'],['empty_window_focused','FOCUSED'],['app_active','APP_ACTIVE'],['app_hidden','APP_HIDDEN']].map(([key,label])=>typeof status[key]==='boolean'?label+'_'+String(status[key]).toUpperCase():''),
  ['STANDARD','DIALOG','UNKNOWN'].includes(status.window_subrole)?'SUBROLE_'+status.window_subrole:''
 ].filter(Boolean).join(' / '):'';
 const stopCode=detail?status.code+' / '+detail+(Number.isInteger(status.ax_error)&&status.ax_error>=-2147483648&&status.ax_error<=2147483647?' / AX '+status.ax_error:'')+(fallback?' / '+fallback:'')+(context?' / '+context:''):status.code;
 const needsChrome=['CHROME_INSTALL_CHROME_UNAVAILABLE','CHROME_INSTALL_CHROME_TOO_OLD'].includes(status.code);
 modal(("<h2>"+(TH(repair?"ui.window.helperSheet.title":"ui.window.capBrowser.act.text2"))+"</h2><p role=\"status\">"+(text)+"</p>"+(stage?`<p>${E(T(active?"ui.window.showChromeInstall.currentStage":"ui.window.showChromeInstall.stoppedStage",{stage}))}</p>`:'')+(!active&&!specific&&!cancelled&&typeof status.code==='string'&&status.code?`<p>${E(T("ui.window.showChromeInstall.stopCode",{code:stopCode}))}</p>`:'')+"<div class=\"actions\">"+(active?(waitAX?btn(T("ui.window.showChromeInstall.openAX"),'computerPermissions','','sm'):'')+btn(T("ui.window.doneList.text2"),'extensionCancel','','sm'):dataBlocked?btn(T('ui.chrome.dataAccess.openSettings'),'chromeDataAccessSettings','','sm primary'):status.code==='CHROME_INSTALL_MANAGED_POLICY_BLOCKED'?btn(T("ui.window.permissionTierChanges.text4"),'closeModal','','sm'):needsChrome?btn(status.code==='CHROME_INSTALL_CHROME_UNAVAILABLE'?T("ui.window.showChromeInstall.text8"):T("ui.window.browserSheet.text14"),'chromeUpdate','','sm primary'):(axFix?btn(T(capOn('desktop_enabled')?(repair?"ui.window.showChromeInstall.axOnRepair":"ui.window.showChromeInstall.axOn"):(repair?"ui.window.showChromeInstall.desktopOnRepair":"ui.window.showChromeInstall.desktopOn")),repair?'extensionRepairWithDesktop':'extensionSetupWithDesktop','','sm primary'):retry?btn(T(repair?"ui.window.showChromeInstall.retryRepair":"ui.window.showChromeInstall.retry"),repair?'extensionRepair':'extensionSetup','','sm primary'):'')+btn(T(repair?"ui.window.showChromeInstall.manualRepair":"ui.window.showChromeInstall.text9"),repair?'extGuideReplace':'extensionManual','','sm'))+"</div>"),'chrome-install');
}
function showChromeProfiles(result){
 const profiles=Array.isArray(result.profiles)?result.profiles.filter(p=>typeof p?.id==='string'&&/^(Default|Profile [0-9]{1,6})$/.test(p.id)).slice(0,100):[];
 const repair=typeof result.repair==='boolean'?result.repair:(typeof chromeInstallKind!=='undefined'&&chromeInstallKind==='repair');
 modal(("<h2>"+(TH(repair?"ui.window.showChromeProfiles.titleReplace":"ui.window.showChromeProfiles.text2"))+"</h2><p>"+(TH(repair?"ui.chrome.profile.chooseReplace":"ui.chrome.profile.choose"))+"</p><div class=\"actions\">"+(profiles.map(p=>btn((p.name||p.id)+(p.installed?T("ui.window.showChromeProfiles.text"):''),repair?'extensionRepair':'extensionSetup',p.id,'sm '+(p.id===result.selected_profile?'primary':''))).join(''))+"</div>"));
}
function startChromeInstallView(){
 stopChromeInstallView(false);chromeInstallRun++;const generation=chromeInstallView;chromeInstallActive=true;showChromeInstall({phase:'loading',active:true,stage:'preparing'});return generation;
}
/* 原生回「开始了」时带了这一轮的 attempt_id 就一路带上，后台只回这一轮的状态；没带就跟以前一样 */
const chromeAttemptID=r=>typeof r?.attempt_id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.attempt_id)?r.attempt_id.toLowerCase():'';
function pollChromeInstallView(generation,attempt=''){
 if(generation!==chromeInstallView||!chromeInstallActive)return;
 const poll=async()=>{if(generation!==chromeInstallView)return;try{const status=await api('/api/browser/extension/install/status',attempt?{attempt_id:attempt}:{});if(generation!==chromeInstallView)return;/* 1070：先等辅助功能的那一轮，原生已经回过「开始了」，有几个 Chrome 用户要选时改从这里的状态带过来（choose_profile），停下轮询、弹选用户的框；选完照常重新装或换 */if(status?.choose_profile===true&&Array.isArray(status.profiles)&&status.profiles.length&&(!attempt||chromeAttemptID(status)===attempt)){if(typeof status.repair==='boolean')chromeInstallKind=status.repair?'repair':'install';stopChromeInstallView(false);showChromeProfiles(status);return;}if(status.phase!=='idle')showChromeInstall(status);if(!status.active&&status.phase!=='idle'){stopChromeInstallView(false);void refresh();return;}}catch{if(generation!==chromeInstallView)return;stopChromeInstallView();showChromeInstall({phase:'stopped'});return;}chromeInstallTimer=setTimeout(poll,600);};
 chromeInstallTimer=setTimeout(poll,600);
}
let chromeInstallKind='install';/* 'install'：原生 extensionSetup；'repair'：原生 extensionRepair（1070 C3，把 Chrome 里的旧副本换成 ChatHand 文件夹里的） */
let chromeInstallWaitAX=false;/* 1070 C1：从「打开桌面控制，接着装」进来的这一轮，一路带上 wait_for_accessibility（选 Chrome 用户那一步也带） */
async function startExtensionSetup(id,kind='install'){chromeInstallKind=kind;const generation=startChromeInstallView();let r;try{r=await native(kind==='repair'?'extensionRepair':'extensionSetup',{...(id?{profile_id:id}:{}),...(chromeInstallWaitAX?{wait_for_accessibility:true}:{})});}catch(error){if(generation!==chromeInstallView)return;stopChromeInstallView();showChromeInstall({phase:'stopped'});return;}if(generation!==chromeInstallView)return;if(kind==='repair'&&r?.error==='NATIVE_ACTION_UNKNOWN'){stopChromeInstallView(false);extRepairUnsupported=true;extGuideModal('replace',S.automation?.browser?.extension?.helper?.folder||extGuide?.folder||'',T("ui.window.extGuide.autoReplaceUnavailable"));scheduleRender();return;}if(r?.choose_profile){stopChromeInstallView(false);showChromeProfiles(r);return;}if(r?.error||r?.started!==true){stopChromeInstallView(false);showChromeInstall({phase:'stopped',code:r?.error==='NATIVE_TIMEOUT'?'CHROME_DATA_ACCESS_TIMEOUT':r?.error?.code||r?.error_code||r?.error,...(typeof r?.detail_code==='string'?{stage:'preparing',detail_code:r.detail_code,ax_error:r.ax_error,fallback_code:r.fallback_code,window_relation:r.window_relation,empty_window_minimized:r.empty_window_minimized,empty_window_main:r.empty_window_main,empty_window_focused:r.empty_window_focused,app_active:r.app_active,app_hidden:r.app_hidden,window_subrole:r.window_subrole}:{})});return;}pollChromeInstallView(generation,chromeAttemptID(r));}
/* Chrome 网上应用店（#89）：正式版的 Chrome 插件只从应用店装。ChatHand 让后台先登记本机连接、选好 Chrome 用户，
   再在那个用户的 Chrome 里打开插件页面；「添加至 Chrome」由用户自己点。原生回 opened:true 只说明页面打开了，不说明装好了，
   装没装好只看 store/status 报不报 connected（哪个 Chrome 用户里连上的都算）。不要辅助功能，也不碰桌面控制。
   旧的本地装法（插件文件夹、辅助功能、一键换新）只留给 distribution 是 legacy_unpacked 的测试配置，上面那些函数原样留着。 */
const chromeStoreMode=()=>typeof S==='object'&&S?.automation?.browser?.extension?.distribution==='chrome_web_store';
// 这一版的应用店配置没配好（store_url 缺了或不对）：装不了，直接说，不出「打开 Chrome」的说明
const chromeStorePending=()=>chromeStoreMode()&&S.automation.browser.extension.configuration_state==='pending';
const CHROME_STORE_SLOW_MS=90000,CHROME_STORE_MIN_MAJOR=128,CHROME_STORE_CANT_CHECK=5;
let chromeStoreProfile='',chromeStoreProfiles=[],chromeStoreStarted=0,chromeStoreShown='',chromeStoreFails=0,chromeStoreReconnecting=false,chromeStoreUpdating=false;
// 框的标题：第一次装、插件连不上（reconnect）、插件要更新（updating）各一个。
const chromeStoreTitle=()=>chromeStoreUpdating?"ui.chrome.store.updateTitle":chromeStoreReconnecting?"ui.chrome.store.reconnectTitle":"ui.window.capBrowser.act.text2";
const chromeStoreKey=v=>v.phase+(v.slow?':slow':'')+(v.cant?':cant':'');
const chromeStoreProfileList=list=>(Array.isArray(list)?list:[]).filter(p=>typeof p?.id==='string'&&/^(Default|Profile (0|[1-9][0-9]{0,5}))$/.test(p.id)).slice(0,100);
const chromeStoreCode=r=>r?.error_code||r?.error?.code||(typeof r?.error==='string'?r.error:'');
const CHROME_STORE_STOP_TEXT={CHROME_STORE_OPEN_FAILED:"ui.chrome.store.openFailed",CHROME_STORE_PROFILES_UNAVAILABLE:"ui.chrome.store.profilesUnavailable",CHROME_STORE_PROFILE_UNKNOWN:"ui.chrome.store.profileGone",CHROME_STORE_PROFILE_INVALID:"ui.chrome.store.profileGone",CHROME_DATA_ACCESS_DENIED:"ui.chrome.store.dataAccess",CHROME_STORE_CONFIGURATION_PENDING:"ui.chrome.store.notReady",CHROME_STORE_LISTING_INVALID:"ui.chrome.store.notReady",CHROME_LOCAL_INSTALL_DISABLED:"ui.chrome.store.notReady",CHROME_STORE_HOST_UNAVAILABLE:"ui.chrome.store.hostUnavailable",INSTALL_ACCESS_CHANGED:"ui.chrome.store.accessChanged",OWNED_WINDOW_REQUIRED:"ui.chrome.store.windowOnly",NATIVE_APP_REQUIRED:"ui.chrome.store.windowOnly"};
// 1081（Claude，Ken 10/27 10:07、10:18）：转圈只给 ChatHand 自己在做的事（正在打开）；等人在 Chrome 里点、或者查不到，都不转圈。
function chromeStoreWait(text,spin=true){return "<p class=\"cs-wait\" role=\"status\">"+(spin?"<span class=\"spinner\" aria-hidden=\"true\"></span>":'')+"<span>"+E(text)+"</span></p>";}
// Ken 10/26：要点的两个按钮都在 Chrome 里，不在 ChatHand 里。画两张小图：Chrome 打开的插件页面、Chrome 弹出的框，要点的按钮圈出来。
// 图只是示意（aria-hidden），意思写在图下面那句里。
function chromeStorePics(){
 const bar="<span class=\"cs-bar\"><i></i><i></i><i></i><b></b></span>",lines="<span class=\"cs-ln\"></span><span class=\"cs-ln s\"></span>";
 const page="<span class=\"cs-win\" aria-hidden=\"true\">"+bar+"<span class=\"cs-page\"><span class=\"cs-item\"><img src=\"/h10/assets/AppIcon-rounded-512.png\" alt=\"\" width=\"20\" height=\"20\"><b>ChatHand</b><em class=\"cs-hl\">"+TH("ui.chrome.store.picAdd")+"</em></span>"+lines+"</span></span>";
 const ask="<span class=\"cs-win\" aria-hidden=\"true\">"+bar+"<span class=\"cs-page cs-under\">"+lines+"<span class=\"cs-dlg\"><b>"+TH("ui.chrome.store.picAsk")+"</b>"+lines+"<span class=\"cs-dbtns\"><i>"+TH("ui.chrome.store.picCancel")+"</i><em class=\"cs-hl\">"+TH("ui.chrome.store.picConfirm")+"</em></span></span></span></span>";
 return "<div class=\"cs-pics\"><figure>"+page+"<figcaption>"+TH("ui.chrome.store.stepPage")+"</figcaption></figure><figure>"+ask+"<figcaption>"+TH("ui.chrome.store.stepDialog")+"</figcaption></figure></div>";
}
function showChromeStore(view){
 const x=typeof S==='object'?S?.automation?.browser?.extension||{}:{},close=btn(T("ui.window.static.close"),'closeModal','','sm');
 chromeStoreShown=chromeStoreKey(view);
 // 打开 Chrome 之前先说清楚：会打开 Chrome、在 Chrome 里点哪两下。Chrome 一打开就挡在 ChatHand 前面，打开以后再说就看不到了。
 // 这台 Mac 没装 Chrome、或者 Chrome 太旧装不了插件，就只说这一件事，按钮是下载或更新 Chrome。
 if(view.phase==='intro'){
  const c=typeof S==='object'&&(S?.platform||'darwin')==='darwin'?S?.automation?.browser?.personal?.chrome||{}:{},missing=c.installed===false,tooOld=!missing&&Number.isInteger(c.major)&&c.major<CHROME_STORE_MIN_MAJOR;
  if(missing||tooOld){modal("<h2>"+TH("ui.window.capBrowser.act.text2")+"</h2><p>"+(missing?TH("ui.chrome.store.noChrome"):TH("ui.chrome.store.chromeTooOld",{version:E(c.version||String(c.major))}))+"</p><div class=\"actions\">"+btn(T(missing?"ui.window.showChromeInstall.text8":"ui.window.browserSheet.text14"),'chromeUpdate','','sm primary')+close+"</div>",'chrome-store');return;}
  modal("<h2>"+TH("ui.window.capBrowser.act.text2")+"</h2><p>"+TH("ui.chrome.store.introText")+"</p>"+chromeStorePics()+"<p class=\"hint\">"+TH("ui.chrome.store.permNote")+"</p><div class=\"actions\">"+btn(T("ui.chrome.store.open"),'chromeStoreOpen','','sm primary')+btn(T("ui.chrome.store.cancel"),'closeModal','','sm')+"</div>",'chrome-store');return;}
 if(view.phase==='opening'){modal("<h2>"+TH(chromeStoreTitle())+"</h2>"+chromeStoreWait(T("ui.chrome.store.opening"))+"<div class=\"actions\">"+btn(T("ui.chrome.store.cancel"),'extensionCancel','','sm')+"</div>",'chrome-store');return;}
 if(view.phase==='choose_profile'){
  const profiles=chromeStoreProfileList(view.profiles);
  // 1081（Claude）：Chrome 用户一行一个排成一列，「关闭」单独放在下面，不跟用户名挤一排、看着像又一个用户。
  modal("<h2>"+TH("ui.chrome.store.profileTitle")+"</h2><p>"+TH("ui.chrome.store.profileText")+"</p><div class=\"cs-profiles\">"+profiles.map(p=>btn(p.name||p.id,chromeStoreReconnecting&&!chromeStoreUpdating?'chromeStoreReconnect':'chromeStoreOpen',p.id,'sm'+(p.id===view.selected_profile?' primary':''))).join('')+"</div><div class=\"actions\">"+close+"</div>",'chrome-store');return;}
 if(view.phase==='waiting'){
  // 回到 ChatHand 时看到的：还在等你在 Chrome 里点那两下，图跟打开前一样。Chrome 里那页关掉了或者没看到，点「再打开一次」。
  // 1081（Claude，Ken 10/27 10:07）：插件装过（连不上、要更新）不进这个框，见 startChromeStore。
  const cant=view.cant===true;
  // 1081（Claude，ChatGPT 复查 D04）：连着几次都查不到连上没有，是 ChatHand 自己这边的事，照直说，不再让人去看 Chrome 里点了没有。
  // 查不到时只说查不到、点哪里，不再放那两张图（那是让人去 Chrome 里点的）。
  const body=cant?chromeStoreWait(T("ui.chrome.store.cantCheck"),false)+"<p class=\"hint\">"+TH("ui.chrome.store.cantCheckHint")+"</p>":chromeStoreWait(T("ui.chrome.store.waitChrome"),false)+chromeStorePics()+(view.slow?"<p class=\"notice\">"+TH("ui.chrome.store.slow")+"</p>":'');
  // Ken 10/26：默认开在 Chrome 正在用的那个用户里，不先问；有几个用户时说一句开在哪个，开错了点「换一个」
  const who=chromeStoreProfiles.length>1?chromeStoreProfiles.find(p=>p.id===chromeStoreProfile):null;
  const where=who?"<p class=\"hint cs-profile\">"+TH("ui.chrome.store.openedIn",{name:E(who.name||who.id)})+" "+tbtn(T("ui.chrome.store.switchProfile"),'chromeStoreSwitch')+"</p>":'';
  const again="<p class=\"hint cs-again\">"+TH("ui.chrome.store.reopenAsk")+" "+tbtn(T("ui.chrome.store.reopen"),'chromeStoreOpen',chromeStoreProfile)+"</p>";
  const acts=(view.slow&&!cant?btn(T("ui.window.browserSheet.text11"),'browserReconnect','','sm'):'')+close;
  modal("<h2>"+TH("ui.window.capBrowser.act.text2")+"</h2>"+body+(cant?'':where+again)+(x.store_published===false?"<p class=\"hint\">"+TH("ui.chrome.store.unpublished")+"</p>":'')+"<div class=\"actions\">"+acts+"</div>",'chrome-store');return;}
 // 停下了：每个原因一句话，只给接下来能做的按钮；认不出的原因带上代码，方便对照
 // 1081（Claude，ChatGPT 复查 D05）：知道这台 Mac 装了 Chrome，就不说「确认装了 Chrome」，也不出「下载 Chrome」。
 const installed=typeof S==='object'&&S?.automation?.browser?.personal?.chrome?.installed===true;
 const code=typeof view.code==='string'?view.code:'',key=installed&&code==='CHROME_STORE_OPEN_FAILED'?"ui.chrome.store.stopped":CHROME_STORE_STOP_TEXT[code]||"ui.chrome.store.stopped",dead=key==="ui.chrome.store.notReady"||key==="ui.chrome.store.windowOnly",data=code==='CHROME_DATA_ACCESS_DENIED';
 const retry=chromeStoreReconnecting&&!chromeStoreUpdating?'chromeStoreReconnect':'chromeStoreOpen',acts=data?btn(T("ui.chrome.dataAccess.openSettings"),'chromeStorePrivacy','','sm primary')+btn(T("ui.wizard.retry"),retry,'','sm'):dead?'':btn(T("ui.wizard.retry"),retry,'','sm primary')+(!installed&&['CHROME_STORE_OPEN_FAILED','CHROME_STORE_PROFILES_UNAVAILABLE'].includes(code)?btn(T("ui.window.showChromeInstall.text8"),'chromeUpdate','','sm'):'');
 modal("<h2>"+TH(chromeStoreTitle())+"</h2><p role=\"status\">"+TH(key)+"</p>"+(code&&(dead||!CHROME_STORE_STOP_TEXT[code])?"<p class=\"hint\">"+E(T("ui.window.showChromeInstall.stopCode",{code}))+"</p>":'')+"<div class=\"actions\">"+acts+close+"</div>",'chrome-store');
}
async function startChromeStore(profileId='',{reconnect=false}={}){
 stopChromeInstallView(false);chromeInstallRun++;const generation=chromeInstallView;chromeInstallActive=true;chromeStoreReconnecting=reconnect===true;
 {const was=typeof S==='object'?S?.automation?.browser?.extension||{}:{};chromeStoreUpdating=was.connection_state==='connected'&&was.compatibility?.state==='incompatible';}
 if(profileId)chromeStoreProfile=profileId;
 showChromeStore({phase:'opening'});
 // 后台只在浏览器控制开着时登记本机连接；从「安装 Chrome 插件」进来就是要用浏览器，先把开关打开
 try{if(!capOn('browser_enabled')){await api('/api/settings',{browser_enabled:true});await refresh();}}
 catch(error){if(generation!==chromeInstallView)return;chromeInstallActive=false;showChromeStore({phase:'stopped',code:error?.code||'INSTALL_ACCESS_CHANGED'});return;}
 if(generation!==chromeInstallView)return;
 let r;try{r=await native('openChromeStore',profileId?{profile_id:profileId}:{});}catch{r={error_code:'CHROME_STORE_OPEN_FAILED'};}
 if(generation!==chromeInstallView)return;
 const code=chromeStoreCode(r);
 if(r?.cancelled===true||code==='CHROME_STORE_CANCELLED'){chromeInstallActive=false;await closeModal(false);return;}
 if(r?.choose_profile===true){chromeInstallActive=false;showChromeStore({phase:'choose_profile',profiles:r.profiles,selected_profile:r.selected_profile});return;}
 if(r?.opened!==true||code){chromeInstallActive=false;showChromeStore({phase:'stopped',code:code||'CHROME_STORE_OPEN_FAILED'});return;}
 if(typeof r.selected_profile==='string')chromeStoreProfile=r.selected_profile;
 chromeStoreProfiles=chromeStoreProfileList(r.profiles);
 // 1081（Claude，Ken 10/27 10:07）：插件装过（连不上、要更新），点「打开插件页面」只在 Chrome 里打开那一页，不再弹转圈等着的框：
 // 在那页点什么，「浏览器控制」那条已经写了；连上了那条自己消失，再提示一句。只有第一次装才留在框里等。
 if(chromeStoreUpdating||chromeStoreReconnecting){chromeInstallActive=false;browserFixPending=true;await closeModal(false);toast(T("ui.chrome.store.pageOpened"));return;}
 chromeStoreStarted=Date.now();chromeStoreFails=0;showChromeStore({phase:'waiting'});pollChromeStore(generation);
}
function pollChromeStore(generation){
 const poll=async()=>{
  if(generation!==chromeInstallView||!chromeInstallActive)return;
  const d=$('#modal');if(!d?.open||d.dataset.kind!=='chrome-store'){stopChromeInstallView(false);return;}
  let s=null;try{s=await api('/api/browser/extension/store/status',{});chromeStoreFails=0;}catch{chromeStoreFails++;}
  if(generation!==chromeInstallView||!chromeInstallActive)return;
  if(s?.connected===true){stopChromeInstallView(false);if(s.compatibility?.state!=='incompatible')void extensionSuccessToast(T("ui.window.capBrowser.connected"),'chrome-store');else{browserFixPending=true;await closeModal(false);}void refresh();return;}
  // 查一次没查到不算数，画面不动、接着查；连着 CHROME_STORE_CANT_CHECK 次都查不到，才换成「查不到」那一版。
  const view=s||chromeStoreFails>=CHROME_STORE_CANT_CHECK?{phase:'waiting',slow:Date.now()-chromeStoreStarted>=CHROME_STORE_SLOW_MS,cant:!s}:null;
  if(view&&chromeStoreKey(view)!==chromeStoreShown)showChromeStore(view);
  chromeInstallTimer=setTimeout(poll,1000);
 };
 chromeInstallTimer=setTimeout(poll,1000);
}
async function openChromeStorePrivacy(){let r;try{r=await native('openPrivacySettings');}catch{r=null;}if(r?.opened!==true)toast(T("ui.chrome.store.privacyFailed"),'warn');}
function desktopSheet(){const p=perms();modal(("<h2>"+(TH("ui.window.permCard.text5"))+"</h2><p>"+(TH("ui.window.desktopSheet.text4",{"value":p.accessibility?T("ui.window.pgDesktop.text"):T("ui.window.desktopSheet.text"),"value2":p.screen_recording?T("ui.window.pgDesktop.text"):T("ui.window.desktopSheet.text")}))+"</p><p>"+(TH("ui.window.desktopSheet.text5"))+"</p><div class=\"actions\">"+(btn(T("ui.window.desktopSheet.text2"),'computerPermissions','','sm primary'))+(btn(T("ui.window.pgDesktop.text3"),'repairPermissions','','sm'))+(btn(T("ui.window.desktopSheet.text3"),'restartAfterPermissions','','sm ghost'))+"</div>"));}

/* ---------- 刷新 ---------- */
function refresh(){if(typeof swapping!=='undefined'&&swapping){if(typeof swapRefresh!=='undefined')swapRefresh=true;return refreshPromise||Promise.resolve();}if(refreshing){refreshQueued=true;return refreshPromise;}refreshing=true;refreshPromise=(async()=>{do{refreshQueued=false;try{const streamAtRequest=h10StreamArrivalSerial;const state=await api('/api/state');if(streamAtRequest===h10StreamArrivalSerial)adoptState(state);if(Date.now()-nativeStatusAt>10000){nativeStatusAt=Date.now();const n=await native('getNativeStatus').catch(()=>null);if(n&&!n.error&&n.login_item){nativeStatus=n;scheduleRender();}}if(!P)P=await api('/api/product-config').catch(()=>({}));if(!announced&&S.settings?.last_seen_version!==S.version){announced=true;void api('/api/settings',{last_seen_version:S.version}).catch(()=>{});}}catch{if(!S)paintRegion('main',("<div class=\"empty-task\" style=\"margin:auto\"><p class=\"et-title\">"+(TH("ui.window.refresh.text"))+"</p></div>"));}}while(refreshQueued);})().finally(()=>{refreshing=false;refreshPromise=null;});return refreshPromise;}

/* ---------- 动作 ---------- */
// 1069 第 4 条（Claude）：H10 完成页那两个开关。不问：关就是把这项能力关掉；开就是打开开关，再把缺的补上——
// 浏览器控制直接装 Chrome 助手，桌面控制直接弹系统设置的授权。装和授权的进度在 App 自己的弹框里（盖在设置窗口上面）。
async function setCapability(kind,on){
 const key=kind==='browser'?'browser_enabled':kind==='desktop'?'desktop_enabled':null;if(!key)return;
 try{
  if(on&&capUnsupported(key)){await explainUnsupported(key);return;}
  // 应用店装法、插件还没装过：开关先不动，说明框里点「打开 Chrome」才打开（startChromeStore 会开）；点「取消」就什么都没改（Codex 10/26 复查）
  const storeFirst=kind==='browser'&&on&&chromeStoreMode()&&!browserOn()&&S.automation.browser.extension.installed!==true;
  if(capOn(key)!==on&&!storeFirst){await api('/api/settings',{[key]:on});await refresh();}
  if(!on)return;
  if(kind==='browser'&&!browserOn())await action('extensionSetup');
  else if(kind==='desktop'&&desktopState()!=='on')await native('computerPermissions');
 }catch(error){toast(userMessage(error),'warn');}
}
function capUnsupported(key){return key==='terminal_enabled'?capTerminal().sup===false:key==='desktop_enabled'?capDesktop().sup===false:false;}
async function explainUnsupported(key){const c=S.capabilities||{},term=key==='terminal_enabled',name=term?T("ui.window.permCard.text3"):T("ui.window.permCard.text5"),oldMac=c.supported_os===false;
 const why=oldMac?T("ui.window.explainUnsupported.text",{"name":name}):term?T("ui.window.explainUnsupported.text2"):T("ui.window.explainUnsupported.text3");
 const fix=oldMac?T("ui.window.explainUnsupported.text4"):T("ui.window.explainUnsupported.text5");
 if(await ask({icon:term?'i-terminal':'i-monitor',title:T("ui.window.explainUnsupported.title.text",{"name":name}),body:[why,fix],ok:T("ui.window.connModel.left.text3"),cancel:T("ui.window.matterReport.text10")}))await action('aiBrief');}
let CAP_WORDS={terminal_enabled:['terminal',T("ui.window.permCard.text3"),T("ui.window.pgUsage.text5")],browser_enabled:['browser',T("ui.window.permCard.text4"),T("ui.window.capWords.browser_enabled.text")],desktop_enabled:['desktop',T("ui.window.permCard.text5"),T("ui.window.capWords.desktop_enabled.text")]};
// 1030：三个能力开关先说明影响，再由用户确认；首页与抽屉共用。
function capabilityTogglePrompt(key,on){
 const copy={
  terminal_enabled:{icon:'i-terminal',off:T("ui.window.capabilityTogglePrompt.terminal_enabled.off.text"),on:T("ui.window.capabilityTogglePrompt.terminal_enabled.on.text")},
  browser_enabled:{icon:'i-globe',off:T("ui.window.capabilityTogglePrompt.browser_enabled.off.text"),on:T("ui.window.capabilityTogglePrompt.browser_enabled.on.text")},
  desktop_enabled:{icon:'i-monitor',off:T("ui.window.capabilityTogglePrompt.desktop_enabled.off.text"),on:T("ui.window.capabilityTogglePrompt.desktop_enabled.on.text")}
 }[key];
 return {title:T(on?"ui.window.capabilityTogglePrompt.enableTitle":"ui.window.capabilityTogglePrompt.disableTitle",{name:CAP_WORDS[key][1]}),body:on?copy.on:copy.off,ok:on?T("ui.window.capabilityTogglePrompt.enable.text"):T("ui.window.capabilityTogglePrompt.title.text"),icon:copy.icon,warning:!on&&runningCount()>0?T("ui.window.capabilityTogglePrompt.warning.text"):''};
}
/* 1070 十四（Claude）：连接页的动作。改用走 /api/connection/use，删除走 /api/connection/remove（Codex 补充第十四条）；
   后台还没有这两个接口时（API_UNKNOWN），用现有的几个接口凑一样的事。 */
const safeConnCode=e=>{const c=e?.code||e?.error_code;return typeof c==='string'&&/^[A-Z0-9_]{1,80}$/.test(c)?c:'OPERATION_UNAVAILABLE';};
const connWait=ms=>new Promise(r=>setTimeout(r,ms));
async function connUseFallback(r){
 if(r==='site'){if(!siteHealthy()){await api('/api/site-b/verify',{});await refresh();}if(!siteHealthy())return {error_code:'B_ROUTE_NOT_HEALTHY'};return api('/api/site-b/select',{route:'site'});}
 if(!openaiLive()&&routeStatus('openai').st!=='connecting')await api(connectionMethod()==='relay'?'/api/relay/restore':'/api/connect/restore',{});
 for(let i=0;i<24&&S?.site_b?.routes?.openai?.health_fresh!==true;i++){await connWait(500);await refresh();}
 return api('/api/site-b/select',{route:'openai'});}
// 改用另一条：先把它连上再切；没切成，原来那条照旧。
async function connUse(r){
 if(connBusy||!CONN_ORDER.includes(r))return;connBusy=r;render();let res=null,err=null;
 try{try{res=await api('/api/connection/use',{route:r});}catch(e){if(!notReady(e))throw e;res=await connUseFallback(r);}}
 catch(e){err=e;}
 finally{connBusy='';}
 await refresh();
 if(err?.quiet){render();return;}
 const code=err?safeConnCode(err):res?.error_code?safeConnCode({code:res.error_code}):'';
 if(code)toast(T("ui.h10.host.routeSwitchFailed",{code}),'warn');
 else if(S?.site_b?.selected!==r)toast(T("ui.h10.host.switchNotConfirmed"),'warn');
 else{connTab=r;toast(T("ui.h10.host.routeSwitched",{route:connRouteName(r)}));}
 render();}
async function connRemoveFallback(r){
 if(r==='site'){const res=await api('/api/site-b/revoke',{});await refresh();
  if(openaiAdded()&&S?.site_b?.selected==='site'){try{await connUseFallback('openai');}catch{}}
  return {ok:true,revoke:res?.remote_revocation==='confirmed'?'CONFIRMED':'UNCONFIRMED'};}
 // 停通道会顺手把访问关掉；删完换到 Site 以后，原来没暂停的再打开。
 const wasPaused=userPaused(),relay=connectionMethod()==='relay'||S?.relay?.paired===true||S?.credentials?.relay===true,tunnel=S?.credentials?.tunnel===true||!!S?.settings?.tunnel;
 if(relay)await api('/api/relay/forget',{});
 if(tunnel){try{await api('/api/tunnel/stop',{});}catch{}
  try{await api('/api/tunnel/forget',{});}catch(e){if(e?.code!=='TUNNEL_RUNNING')throw e;await connWait(600);await api('/api/tunnel/forget',{});}}
 await refresh();
 if(siteConfigured()){if(S?.site_b?.selected!=='site'){try{await api('/api/site-b/select',{route:'site'});}catch{}}if(!wasPaused){try{await api('/api/access',{enabled:true});}catch{}}}
 return {ok:true,revoke:'SKIPPED'};}
// 删除：只删本机这头（Site 解绑、通道密钥），ChatGPT 和 OpenAI 那边的东西不动。删的是在用的那条，后台换到另一条。
async function connRemove(r){
 if(!CONN_ORDER.includes(r))return;
 const o=otherRoute(r),other=routeAdded(o),name=connRouteName(r);
 if(!await ask({title:T("ui.window.conn.removeTitle",{name}),body:[T(r==='site'?"ui.window.conn.removeSite":"ui.window.conn.removeTunnel"),routeInUse(r)&&other?T("ui.window.conn.removeThen",{name:connRouteName(o)}):'',other?'':T("ui.window.conn.removeLast")],ok:T("ui.window.conn.remove"),okStyle:'warn-soft',icon:connRouteIcon(r),dangerous:true}))return;
 let res;
 try{try{res=await api('/api/connection/remove',{route:r});}catch(e){if(!notReady(e))throw e;res=await connRemoveFallback(r);}}
 catch(e){await refresh();if(e?.quiet)return;toast(T("ui.window.conn.removeFailed",{code:safeConnCode(e)}),'warn');return;}
 if(res?.ok===false||res?.error_code){await refresh();toast(T("ui.window.conn.removeFailed",{code:safeConnCode({code:res.error_code})}),'warn');return;}
 connTab='';await refresh();toast(res?.revoke==='UNCONFIRMED'?T("ui.window.conn.removedUnconfirmed"):T("ui.window.conn.removed",{name}));render();}
// 我自己修：Site 被别的电脑改连走了就新建一个；授权过期去重新收；别的到配置窗口里这条卡住的那一页。
// OpenAI 通道密钥没通过去向导重填；在用的走原来的「修复」；备用的重连一次。
async function connFixSelf(r){
 if(r==='site'){const x=S?.site_b?.routes?.site||{},b=siteBlock(true);closeDrawer();
  if(b?.kind==='replaced')window.startH10?.({route:'site',screen:'f6'});
  else if(x.state==='auth_required')window.startH10?.({route:'site',screen:'f11',purpose:'renew'});
  else window.startH10?.({route:'site'});
  return;}
 const a=S?.connection?.automatic||{};
 if(a.phase==='needs_login'||a.error_code==='CREDENTIAL_SAVE_FAILED'||a.error_code==='CONNECTION_AUTH_FAILED'){closeDrawer();await window.startWizard?.({initialStep:0});return;}
 if(selectedConnection()==='openai'){await action('repair');return;}
 await api(connectionMethod()==='relay'?'/api/relay/restore':'/api/connect/restore',{});toast(T("ui.window.action.restoreSaved.text"));await refresh();}
// 我自己添加：Site 到自己配的那一页；OpenAI 通道开向导（以前走过几步的从头来）。
async function connAddSelf(r){closeDrawer();if(r==='site'){window.startH10?.({route:'site',screen:'f10'});return;}
 // 1081（Claude，ChatGPT 复查 D01）：先把「这次要配的」记成 OpenAI 通道（只是记一下，不换正在用的那条），向导里的测试和进度都照这条走。
 try{await api('/api/setup/route',{route:'openai'});await refresh();}catch{}
 const s=Math.min(6,Number(S?.settings?.setup_step||0));await window.startWizard?.(s>=2?{initialStep:0}:{});}
async function action(name,id,el){switch(name){
 case'closeModal':await closeModal();return;
  case 'clearDoneSearch':doneQuery='';render();$('#doneSearch')?.focus();return;
  /* 1026：搜索框右边的小叉：清掉文字、退出输入，搜索框收回成放大镜（Ken 10/7） */
  case 'cancelDoneSearch':doneQuery='';doneSearchFocus=false;$('#doneSearch')?.blur();render();requestAnimationFrame(()=>{const box=$('#doneSearch');box?.blur();box?.closest('.done-search')?.classList.remove('open');});return;
  /* 1052 补丁 2（Claude）：待办事项页的搜索和已完成那个一样：清空、小叉收起 */
  case 'clearMatterSearch':matterQuery='';render();$('#matterSearch')?.focus();return;
  case 'cancelMatterSearch':matterQuery='';matterSearchFocus=false;$('#matterSearch')?.blur();render();requestAnimationFrame(()=>{const box=$('#matterSearch');box?.blur();box?.closest('.done-search')?.classList.remove('open');});return;
 case'valueReset':valueResetConfirm=true;valueResetError='';scheduleRender();return;
 case'valueResetNo':valueResetConfirm=false;valueResetError='';scheduleRender();return;
 case'valueResetYes':{if(valueResetBusy||!valueResetConfirm)return;valueResetBusy=true;valueResetError='';scheduleRender();try{await api('/api/value/reset',{});valueResetConfirm=false;toast(T("ui.window.action.valueResetYes.text"));await refresh();}catch{valueResetError=T("ui.window.action.valueResetYes.text2");}finally{valueResetBusy=false;scheduleRender();}return;}
 case'openPrompt':await openChatGPT(id);return;
 case'openChatGPT':await openChatGPT('');return;
 case'permHint':{const hint=document.querySelector('.permission-hint');if(hint&&!matchMedia('(prefers-reduced-motion: reduce)').matches)await hint.animate([{opacity:1,translate:'0 0'},{opacity:0,translate:'0 -6px'}],{duration:180,easing:'ease-in',fill:'forwards'}).finished.catch(()=>{});await markSeen('perm-hint-1012');return;}
 case'setupItem':openDrawer({admin:'terminal',desktop:'desktop',browser:'browser',folder:'scope'}[id]||'settings',id==='admin'?'admin':null);return;
 case'technicalInfo':openDrawer('help');requestAnimationFrame(()=>{const details=$('#drawerBody .tech');if(details){details.open=true;details.scrollIntoView({block:'start'});}});return;
 case'language':{if(languageBusy||!LANGUAGE_CHOICES.includes(id)||!LANGUAGE_CHOICES.includes(languagePreference)||id===languagePreference)return;const previous=languagePreference;languageBusy=true;languagePreference=id;applyLocalText();try{const result=await native('setLanguage',{language:id});if(result?.error||result?.error_code||!LANGUAGE_CHOICES.includes(result?.preference)||!['zh','en'].includes(result?.locale))throw Error('LANGUAGE_NOT_SET');languagePreference=result.preference;window.ChatHandText.installCatalogs({locale:result.locale});}catch{languagePreference=previous;toast(T("ui.window.action.language.text"),'warn');}finally{languageBusy=false;applyLocalText();}return;}
 case'appearance':return chooseAppearance(id);
 case'tier':{if(shownTier()===id||!['full','light'].includes(id))return;const n=runningCount(),label=id==='full'?T("ui.window.permCard.text"):T("ui.window.permCard.text2");if(!await ask({title:T("ui.window.action.tier.title.text",{"label":label}),body:permissionTierChanges(id),warning:n?T("ui.window.action.tier.warning.text",{"n":n}):T("ui.window.action.tier.warning.text2"),ok:T("ui.window.action.tier.ok.text",{"label":label}),icon:id==='full'?'i-shield':'i-folder'}))return;await applyTier(id,id==='light'&&!scopeFull()?S.project?.path:undefined);return;}

 case'confirmSettings':{const c=(S.confirmations||[]).find(x=>x.id===id);showPage('settings',confirmSettingsSection(c));return;}
 case'confirmAnswer':{if(!IN_APP||!confirmReady.has(id))return;const scope=el?.dataset.scope||'',c=(S.confirmations||[]).find(x=>x.id===id);if(!c)return;confirmReady.delete(id);confirmArmed.delete(id);scheduleRender();const result=await native('confirmAnswer',{id,scope}),code=result?.error?.code||result?.error_code||null;
  if(result?.ok===false||result?.state==='unknown'||result?.do_not_replay===true){setConfirmFeedback(id,result?.result_line||T("ui.window.action.confirmAnswer.text"),'muted');await refresh();return;}
  if(code){const msg=result?.error?.message||result?.message||code;if(code==='CONFIRM_NOT_HUMAN'){confirmErrors.set(id,{human:true,text:T("ui.window.action.confirmAnswer.text.text")});armConfirmation(id);}else setConfirmFeedback(id,T("ui.window.action.confirmAnswer.text2",{"msg":msg}),'muted');scheduleRender();return;}
  const words={deny:T("ui.window.pgDesktop.text2")},base=scope==='always'?T("ui.window.action.confirmAnswer.text3",{"value":c.item?.name||T("ui.window.confirmationCard.text")}):words[scope]||T("ui.window.action.confirmAnswer.text4"),tail=result?.ai_waiting===true?T("ui.window.action.confirmAnswer.text5"):T("ui.window.action.confirmAnswer.text6");setConfirmFeedback(id,base+tail,scope==='deny'?'muted':'ok');await refresh();return;}
 case'revokeAlwaysAllowed':{const records=Array.isArray(S.permissions?.always_allowed)?S.permissions.always_allowed:[],item=records.find(record=>record.gate===el?.dataset.gate&&record.id===el?.dataset.permissionId);if(!item||typeof item.gate!=='string'||typeof item.id!=='string')return;const result=await api('/api/permissions/revoke',{gate:item.gate,id:item.id});if(result?.ok!==true){toast(T("ui.window.action.revokeAlwaysAllowed.text"),'warn');await refresh();return;}const undo=typeof result.undo?.receipt_id==='string'?result.undo:null,count=Number(result.revoked_high_risk_count),message=item.gate==='scope'&&item.id==='full'&&Number.isInteger(count)&&count>=0?T("ui.window.action.revokeAlwaysAllowed.text2",{"count":count}):T("ui.window.action.revokeAlwaysAllowed.text3",{"value":typeof item.name==='string'?item.name:T("ui.window.confirmationCard.text")});await permissionRevokedToast(message,undo);await refresh();return;}

 case'checkpointAction':{const checkpointAction=el?.dataset.checkpointAction;if(!Object.prototype.hasOwnProperty.call(CHECKPOINT_ACTIONS,checkpointAction))return;const result=await native('checkpointAction',{task_id:id,checkpoint_seq:Number(el.dataset.checkpointSeq),choice:el.dataset.choice}),code=result?.error?.code||result?.error_code||null;if(code){toast(result?.error?.message||result?.message||code,'warn');return;}await refresh();return;}
 case'matterOpen':{
  const item=matterRows().find(m=>m.id===id);if(!item)return;
  const detail=await matterDetail(id,item),why=String(item.waiting_for||'').trim();
  // 1056 后（Claude，10/17 12:59）：标题只放标题；下面一行状态和在等什么，再一行编号 · 来源 · 更新时间；
  // 按钮和其他弹窗一样大、一样排（左边次要、右边主按钮），去掉没用的「关闭」（右上角 ×、Esc、点外面都能关）；「删除」鼠标移上去变警示色。
  modal(`<h2>${E(item.title)}</h2><p class="mt-dsum"><span class="mt-st ${matterTone(item)}">${E(matterLabel(item))}</span>${why&&why!==matterLabel(item)?`<span>${E(why)}</span>`:''}</p><p class="mt-did">${E([id,item.source?.label,item.updated_at?T("ui.window.action.matterOpen.text",{"when":when(item.updated_at)}):''].filter(Boolean).join(' · '))}</p>${detail}<div class="actions foot">${!item.deleted?btn(T("ui.window.toolWords.delete_file.text"),'matterDeleteOne',id,'warn'):btn(T("ui.window.toolWords.restore_file.text"),'matterRestoreOne',id)}${btn(T("ui.window.matterBar.text4"),'matterOpenSingle',id,'primary')}</div>`);
  return;
 }
 // 1053 后 待办空状态（Claude，10/17）：ⓘ 说明卡开 / 关
 case'matterHelp':matterHelpOpen=!matterHelpOpen;render();if(matterHelpOpen)requestAnimationFrame(()=>$('#matterHelpPop')?.focus?.());return;
 case'matterSelectAll':for(const m of matterVisible())matterSelected.add(m.id);render();return;
 case'matterSelectNone':matterSelected.clear();render();return;
 case'matterOpenSingle':matterSelected.clear();matterSelected.add(id);return action('matterOpenNew','',el);
 case'matterOpenNew':{
  const ids=matterIdsToAct();if(!ids.length){toast(T("ui.window.matterWriteSelected.text"));return;}
  let ref=ids.join('、');if(ids.length>10){const result=await api('/api/matters/selection',{ids});ref=result.selection_id;}
  await openChatGPT(T("ui.window.action.matterOpenNew.text",{"ref":ref}));return;
 }
 // 1053 后（Claude，10/17）：行上的「处理」只开这一条，不清掉已经勾的。
 case'matterGo':{const item=matterRows().find(m=>m.id===id&&!m.deleted);if(!item)return;
  await openChatGPT(T("ui.window.action.matterGo.text",{"id":id}));return;
 }
 case'matterUndoLast':{
  const items=matterRows().filter(m=>matterLastDeleted.includes(m.id)&&m.deleted);
  if(!items.length){matterLastDeleted=[];render();return;}
  const {saved,failed,unknown}=await matterWriteBatched('restore',items,'matter-ui-undo-');
  // 没恢复成的留在「撤销删除」里，可以再点一次。
  matterLastDeleted=[...failed.map(x=>x.id),...unknown.map(m=>m.id)];await refresh();armMatterUndo();
  if(!failed.length&&!unknown.length){toast(T("ui.window.action.matterUndoLast.text"));return;}
  matterReport('restore',saved,failed,unknown,T("ui.window.action.matterUndoLast.text2"));return;
 }
 case'matterResolve':await matterWriteSelected('append');return;
 case'matterBatchDelete':await matterWriteSelected(matterShowDeleted?'restore':'delete');armMatterUndo();return;
 // 1052 R13（Claude）：先关详情再写；没成时弹的说明框不会被跟着关掉。
 case'matterDeleteOne':case'matterRestoreOne':matterSelected.clear();matterSelected.add(id);if($('#modal').open)await closeModal();await matterWriteSelected(name==='matterDeleteOne'?'delete':'restore');armMatterUndo();return;
 // 1052 R13（Claude）：条数用后台给的总数（列表最多带 500 条）；没有就不弹；清完撤销删除也清掉，说清删了几条。
 case'matterPurge':{if(!matterShowDeleted)return;const n=S.matters?.deleted_count??matterRows().filter(m=>m.deleted).length;if(!n){toast(T("ui.window.action.matterPurge.text"));return;}
  if(await ask({title:T("ui.window.action.matterPurge.title.text"),body:[T("ui.window.action.matterPurge.body.text",{"n":n})],ok:T("ui.window.action.matterPurge.ok.text")})){const r=await api('/api/matters/purge',{confirmed:true});matterSelected.clear();matterLastDeleted=[];armMatterUndo();await refresh();toast(T("ui.window.action.matterPurge.text3",{"value":r?.purged??n}));}return;}
 case'updateClose':bubbleHidden.add(id);scheduleRender();return;
 case'copy':await copyText(id,el);if(extGuide)extGuideMarkCopied(id===extGuide.folder);return;
 case'copyPrompt':await copyText(id,el);toast(PROMPT_COPY_HINT);return;
 case'drawer':openDrawer(id||'settings');return;
 case'closeDrawer':closeDrawer();return;
 case'focusTask':swapFocus(id,el);return;
  case'collapseTask':swapFocus('',el);return;
  case'openRefreshTools':await native('openExternal',{url:refreshToolsURL()});return;
  case'helperSheet':if(chromeStoreMode()){await startChromeStore();return;}helperSheet();return;
  case'returnExistingRefreshTab':{if(!IN_APP)return;const r=await api('/api/refresh/return-existing-tab',{});if(r?.shown!==true)throw Error(T("ui.window.action.returnExistingRefreshTab.text"));return;}
  case'undoTask':await undoTask(id);return;
  case'openTaskFile':case'revealTaskFile':case'quickLookTaskFile':{const r=await native(name,{task_id:id,path:el?.dataset.path||''});if(r?.error==='FILE_GONE')toast(T("ui.window.action.quickLookTaskFile.text"),'warn');else if(r?.error==='NEEDS_CONFIRM'){if(await ask({title:T("ui.window.action.quickLookTaskFile.title.text"),body:[T("ui.window.action.quickLookTaskFile.body.text")],ok:T("ui.window.blockCard.text20")}))await native(name,{task_id:id,path:el?.dataset.path||'',confirmed:true});}else if(r?.error)toast(T("ui.window.action.quickLookTaskFile.text2",{"value":r.message||r.error}),'warn');return;}
 case'permissionHistorySettings':{const row=S.permissions?.history?.find(x=>x.event_id===id);if(!row?.active)return;const view=row.action==='tier'?'permissionPreset':row.gate==='scope'?'scope':row.gate==='capability'?row.id:'terminal';openDrawer(view,view==='terminal'&&row.gate!=='capability'?row.id:null);return;}
 case'jumpSettings':openDrawer(['conn','scope','terminal','browser','desktop','help'].includes(id)?id:'settings');return;
 case'openTask':openDrawer('task',id);return;
 case'navigate':window.showPage(id);return;
 case'setting':window.showPage(id==='connection'?'conn':'settings');return;
 case'keyLostReopen':await keyLostReopen();return;
 case'appMissing':appMissingDialog();return;
 case'appMissingAI':await closeModal();closeDrawer();await openChatGPT(appUnbound()?T("ui.window.appMissing.unbound.prompt"):T("ui.window.appMissing.prompt"),{work:true});return;
 case'appMissingManual':await appMissingManual();return;
 case'openH10':closeDrawer();window.startH10?.();return;
 case'openH10renew':closeDrawer();window.startH10?.({route:'site',screen:'f11',purpose:'renew'});return;
 case'siteDisconnect':await siteDisconnect();return;
 case'toolsStaleDismiss':markSeen(id);return;
 case'helperNoticeDismiss':markSeen(id);return;
 case'helperNoticeSteps':markSeen(id);openDrawer('browser');return;
 // 1069 第 8 条（Claude）：「设置 ChatGPT Site / OpenAI 通道」「重新配」「开始设置」都进第三版引导，从选方式开始（AI 在配就看进度，卡住的停在卡住那页），
 // 不再直接跳到完成页，也不再开旧向导；旧向导只在 OpenAI 通道点「我自己配」时出现。不会清掉已经配好、测过的连接。
 case'manual':closeDrawer();window.startH10?.({entry:'settings'});return;
 // 1069 A4/A5（Claude）：首页 Site 卡片上的两个出口。
 // 1070 十四（Claude）：OpenAI 通道已经加了就直接改用；没加才去帮我配。
 case'useOpenAI':if(openaiAdded()){await connUse('openai');return;}closeDrawer();window.h10UseOpenAI?.();return;
 case'connTab':connTab=CONN_ORDER.includes(id)?id:'';connMenu=false;render();return;
 case'connMenu':connMenu=!connMenu;render();return;
 case'connUse':await connUse(id);return;
 case'connRemove':await connRemove(id);return;
 case'connFixSelf':await connFixSelf(id);return;
 case'connAddSelf':await connAddSelf(id);return;
 // 让 ChatGPT 帮我配 / 帮我添加 / 修：到配置窗口的进度页，那边复制好那句话、打开 ChatGPT 填好。
 case'connAssist':{const [r,intent]=String(id).split(':');if(!CONN_ORDER.includes(r))return;closeDrawer();window.h10Assist?.(r,['setup','add'].includes(intent)?intent:'add');return;}
 case'connRepairAI':if(!CONN_ORDER.includes(id))return;closeDrawer();window.h10Assist?.(id,'repair');return;
 case'connReconfigure':if(!CONN_ORDER.includes(id))return;closeDrawer();window.startH10?.({entry:'settings',route:id});return;
 case'newSite':closeDrawer();window.startH10?.({route:'site',screen:'f6'});return;
 case'codexTest':await openChatGPT(T("ui.window.action.codexTest.text"),{work:true});return;
 case'removeSkill':await api('/api/setup/skill/remove',{});toast(T("ui.window.action.removeSkill.text"));break;
 case'testConnection':{if(selectedConnection()==='site'){await openChatGPT(siteTestPrompt());return;}const r=await api('/api/tunnel/doctor',{}).catch(e=>({error:e})),cp=r?.control_plane;toast(r?.error?T("ui.window.action.testConnection.text2",{"userMessage":userMessage(r.error,T("ui.window.action.testConnection.text"))}):cp?.state==='down'?T("ui.window.action.testConnection.text3"):r?.ok||connected()?T("ui.window.action.testConnection.text4"):T("ui.window.action.testConnection.text5"),r?.error||cp?.state==='down'?'warn':'');await refresh();break;}
 case'scopeMenu':if(scopeOpen)await closeScope();else{scopeOpen=true;render();$('.scope .mi[aria-checked="true"]')?.focus();}return;
 case'scopeFull':{await closeScope();if(S.mode==='full')return;if(!await ask({title:T("ui.window.action.scopeFull.title.text"),body:[T("ui.window.action.scopeFull.body.text"),T("ui.window.action.scopeFull.body.text2"),T("ui.window.action.scopeFull.body.text3"),stopNote()],ok:T("ui.window.blockCard.text9")}))return;await api('/api/mode',{mode:'full',confirm:true});toast(T("ui.window.action.scopeFull.text"));break;}
 case'scopeFolder':{await closeScope();if(S.mode!=='full')return;const n=runningCount();if(n&&!await ask({title:T("ui.window.action.scopeFolder.title.text"),body:[homePath(S.project?.path),stopNote()],ok:T("ui.window.action.scopeFolder.ok.text")}))return;await api('/api/mode',{mode:'auto'});toast(T("ui.window.action.scopeFolder.text"));break;}
 case'scopePick':{await closeScope();await chooseFolderAndApply();break;}
 case'riskSheet':openDrawer('terminal');return;
 case'blockEnable':openDrawer('terminal',id);return;
 case'blockDismiss':await api('/api/blocks/dismiss',{id});toast(T("ui.window.action.blockDismiss.text"));break;
 case'capEnable':await api('/api/settings',{[CAP_KEYS[id]]:true});toast(T("ui.window.action.capEnable.text"));break;
 case'resumeAI':{const online=connState()==='online';await api('/api/access',{enabled:true});toast(online?T("ui.window.action.resumeAI.text"):T("ui.window.action.resumeAI.notOnline"));}break; // 0010：没连上就别说「已恢复」了事
 case'approveJob':await api('/api/jobs/approve',{id});toast(T("ui.window.action.approveJob.text"));break;
 case'rejectJob':await api('/api/jobs/reject',{id});toast(T("ui.window.action.rejectJob.text"));break;
 case'askYes':settleAsk(true);return;
 case'askNo':settleAsk(false);return;
 case'browserReconnect':{const result=await api('/api/browser/extension/reconnect',{});reconnectConfirm=result.user_install_confirmation_required===true;toast(T("ui.window.action.browserReconnect.text"));break;}
 case'browserSheet':browserSheet();return;
 case'desktopSheet':desktopSheet();return;
 case'viewDiff':{const [task,op]=id.split('|');const r=await api('/api/task-changes',{id:task,operation_id:op});const c=diffCount(r.before||'',r.after||'');modal(("<h2>"+(E(r.path||T("ui.window.action.viewDiff.text")))+"</h2><p>"+(("<span class=\"add\">"))+"+"+(c.add)+(("</span>"))+" "+(("<span class=\"del\">"))+"−"+(c.del)+(("</span>"))+(r.current_differs_from_receipt?T("ui.window.action.viewDiff.text2"):'')+"</p><h3>"+(TH("ui.window.action.viewDiff.text4"))+"</h3><pre>"+(E(r.before||T("ui.window.action.viewDiff.text3")))+"</pre><h3>"+(TH("ui.window.action.viewDiff.text5"))+"</h3><pre>"+(E(r.after||''))+"</pre>"));return;}
 case'exportDiagnostic':{const r=await api('/api/support/export',{});toast(T("ui.window.action.exportDiagnostic.text",{"value":String(r.file||'').split('/').pop()}));break;}
 /* 检查并修复、请 AI 检查：后端接口见开发任务书「前后端接口」 */
 case'repair':{if(selectedConnection()==='site'){closeDrawer();window.startH10?.({route:'site'});return;}try{await api('/api/support/repair',{login_item_requires_approval:!!nativeStatus?.login_item?.requires_approval});}catch(e){if(notReady(e)){toast(T("ui.window.action.repair.text"));return;}throw e;}if(drawer?.view!=='help')openDrawer('help');break;}
 case'repairAct':{let item={};try{item=JSON.parse(id||'{}');}catch{}const target=REPAIR_ACTIONS[item.kind];if(target)return action(target[0],target[1],el);return;}
 case'aiBrief':{if(selectedConnection()==='site'){closeDrawer();window.startH10?.({route:'site'});return;}let r;try{r=await api('/api/support/ai-brief',{});}catch(e){if(notReady(e)){toast(T("ui.window.action.aiBrief.text"));return;}throw e;}await openChatGPT(r.text?'@ChatHand '+r.text:'');return;}
 case'copyTech':await copyText(techRows().map(([k,v])=>`${k}：${v}`).join('\n'),el);return;
 case'openLoginItems':{const r=await native('openLoginItemsSettings');if(r?.error)toast(T("ui.window.action.openLoginItems.text"));return;}
 /* 版本与更新 */
 case'checkUpdate':{const r=await api('/api/support/update',{});toast(r?.status==='available'?T("ui.window.updateLine.text2",{"value":r.version||''}):r?.status==='up_to_date'?T("ui.window.updateLine.text3"):T("ui.window.action.checkUpdate.text"),r?.status==='available'||r?.status==='up_to_date'?'':'warn');break;}
 case'updateInstall':{try{await api('/api/update/install',{version:id});}catch(e){if(notReady(e)){await openURL(S.update?.url||RELEASES_URL);return;}throw e;}break;}
 case'updateLater':bubbleHidden.add(id);scheduleRender();void api('/api/update/dismiss',{version:id}).catch(()=>{});return;
 case'updateCancel':await api('/api/update/cancel',{}).catch(e=>{if(!notReady(e))throw e;});break;
 case'updateAck':await api('/api/update/ack',{}).catch(e=>{if(!notReady(e))throw e;});break;
 case'toggleExecution':await api('/api/access',{enabled:!S.enabled});toast(S.enabled?T("ui.window.action.toggleExecution.text"):T("ui.window.action.toggleExecution.text2"));break;
 case'restoreSaved':{if(selectedConnection()==='site'){closeDrawer();window.startH10?.({route:'site'});return;}const r=await native('restoreTunnel');if(r?.error)throw Error(r.error?.message||r.error);toast(T("ui.window.action.restoreSaved.text"));}break;
 case'chooseWorkspace':{const r=await native('chooseFolder');if(pickedFolder(r)){const p=await api('/api/projects/add',{name:r.path.split(/[\\/]/).pop()||T("ui.window.workspaceName.text"),folder:r.path,scope:'folder'});await api('/api/projects/select',{id:p.id});await api('/api/setup/workspace',{});}if($('#modal').open)closeModal();}break;
 case'confirmWorkspace':await api('/api/setup/workspace',{});break;
 case'revealWorkspace':await native('revealWorkspace');break;
 // 应用店版：各处的「安装 Chrome 插件」（设置页的浏览器控制开关、抽屉、首页卡片、检查并修复）都先出说明，点「打开 Chrome」才打开（chromeStoreOpen）
 case'extensionSetup':if(chromeStoreMode()){stopChromeInstallView(false);chromeStoreReconnecting=false;chromeStoreUpdating=false;showChromeStore(chromeStorePending()?{phase:'stopped',code:'CHROME_STORE_CONFIGURATION_PENDING'}:{phase:'intro'});break;}if(!id)chromeInstallWaitAX=false;await startExtensionSetup(id);break;
 case'chromeStoreOpen':await startChromeStore(id);break;
 case'chromeStoreReconnect':await startChromeStore(id,{reconnect:true});break;
 // 1081（Claude，Ken 10/27 10:07）：「再试一次」：ChatHand 再在后台打开一次 Chrome、等插件连上（app/server.mjs 的 reconnect）。等的时候那条只写「正在连接…」。
 case'browserRetry':{browserRetrying=true;render();let r=null;try{r=await api('/api/browser/extension/reconnect',{});}catch{}browserRetrying=false;await refresh();render();if(r?.connected===true)void extensionSuccessToast(T("ui.window.capBrowser.connected"),'chrome-store');break;}
 case'extensionSetupWithDesktop':case'extensionRepairWithDesktop':{if(chromeStoreMode()){await startChromeStore();break;}if(capUnsupported('desktop_enabled')){await explainUnsupported('desktop_enabled');return;}const patch={};if(!capOn('desktop_enabled'))patch.desktop_enabled=true;if(!capOn('browser_enabled'))patch.browser_enabled=true;if(Object.keys(patch).length){await api('/api/settings',patch);await refresh();}chromeInstallWaitAX=true;await startExtensionSetup('',name==='extensionRepairWithDesktop'?'repair':'install');break;}
 case'extensionRepair':if(chromeStoreMode()){await startChromeStore(id);break;}if(!id)chromeInstallWaitAX=false;await startExtensionSetup(id,'repair');break;
 case'chromeDataAccessSettings':{if(chromeStoreMode()){await openChromeStorePrivacy();return;}stopChromeInstallView(false);const generation=chromeInstallView;chromeInstallActive=true;showChromeInstall({phase:'waiting_permission',active:true,code:'CHROME_DATA_ACCESS_WAITING'});let r;try{r=await native('openChromeDataAccessSettings');}catch{r={error_code:'CHROME_DATA_ACCESS_TIMEOUT'};}if(generation!==chromeInstallView)return;if(r?.repaired){stopChromeInstallView(false);await closeModal();await action('repair');return;}if(r?.choose_profile){stopChromeInstallView(false);showChromeProfiles(r);return;}if(r?.started===true){chromeInstallActive=true;pollChromeInstallView(generation,chromeAttemptID(r));return;}stopChromeInstallView(false);showChromeInstall({phase:'stopped',code:r?.error==='NATIVE_TIMEOUT'?'CHROME_DATA_ACCESS_TIMEOUT':r?.error?.code||r?.error_code||r?.error});return;}
 case'chromeStoreSwitch':stopChromeInstallView(false);showChromeStore({phase:'choose_profile',profiles:chromeStoreProfiles,selected_profile:chromeStoreProfile});break;
 case'extensionCancel':{if(chromeStoreMode()){stopChromeInstallView(false);await native('extensionCancel');await closeModal(false);break;}stopChromeInstallView(false);const generation=chromeInstallView;await native('extensionCancel');if(generation===chromeInstallView)showChromeInstall({phase:'stopped',code:'INSTALL_CANCELLED'});break;}
 case'copyHelperFolder':{const folder=S.automation?.browser?.extension?.helper?.folder;if(folder)await copyText(folder,el);break;}
 case'revealHelperFolder':{if(chromeStoreMode()){await startChromeStore();break;}const r=await native('revealChromeHelper');if(r?.error)throw Error(r.error?.message||T("ui.window.action.revealHelperFolder.text"));break;}
 case'chromeStorePrivacy':await openChromeStorePrivacy();return;
 case'extensionManual':{if(chromeStoreMode()){await startChromeStore();return;}const r=await native('extensionManual');if(r?.error)throw Error(r.error?.message||r.error);if(!r.store_url)extGuideModal('install',r.extension_folder||S.automation?.browser?.extension?.helper?.folder||'');return;}
 case'extGuideReplace':{if(chromeStoreMode()){await startChromeStore();return;}const h=S.automation?.browser?.extension?.helper;extGuideModal('replace',h?.folder||extGuide?.folder||'');return;}
 /* 1070 C2：打开扩展程序页。原生打不开（回了 error / error_code，或者 opened 不是 true），就把地址复制好，让用户粘到地址栏 */
 case'extensionSettings':{if(chromeStoreMode()){await startChromeStore();return;}const r=await native('extensionSettings');if(r?.opened!==true||r?.error||r?.error_code){let copied=false;try{await navigator.clipboard.writeText('chrome://extensions');copied=true;}catch{const c=await native('copyText',{text:'chrome://extensions'});copied=!c?.error;}if(copied&&extGuide)extGuideMarkCopied(false);toast(T(copied?"ui.window.extGuide.addressCopied":"ui.window.extGuide.openFailed"),copied?'':'warn');}return;}
 case'chromeSetup':await native('chromeSetup');break;
 case'chromeUpdate':await native('chromeUpdate');break;
 case'connectLegacy':await api('/api/browser/personal/connect',{});break;
 case'openIsolated':await api('/api/automation/browser',{});break;
 case'repairPermissions':{const r=await native('repairPermissions');if(r?.error)throw Error(r.error);break;}
 case'restartAfterPermissions':{const r=await native('restartAfterPermissions');if(r?.error)throw Error(r.error);break;}
 case'computerPermissions':await native('computerPermissions');break;
 case'stopAll':if(!await ask({title:T("ui.window.action.stopAll.title.text"),body:[T("ui.window.action.stopAll.body.text")],warning:stopNote(),ok:T("ui.window.stallToolWords.task_stop.text"),icon:'i-power'}))return;await api('/api/automation/stop',{});toast(T("ui.window.action.stopAll.text"));break;
 case'disconnect':if(selectedConnection()==='site'){await siteDisconnect();return;}if(!await ask({title:T("ui.window.action.disconnect.title.text"),body:[T("ui.window.connectionPage.paused.text2")],warning:stopNote(),ok:T("ui.window.action.disconnect.ok.text"),icon:'i-power'}))return;await api(S.relay?.online?'/api/relay/stop':'/api/tunnel/stop',{});break;
 case'bindTask':modal(("<h2>"+(TH("ui.window.conversationActions.text3"))+"</h2><p>"+(TH("ui.window.action.bindTask.text3"))+"</p><label for=\"chatURL\">"+(TH("ui.window.action.bindTask.text4"))+"</label><input id=\"chatURL\" placeholder=\"https://chatgpt.com/c/…\" value=\""+(E(allTasks().find(t=>t.task_id===id)?.group?.conversation_url||''))+"\"><label for=\"chatTitle\">"+(TH("ui.window.action.bindTask.text5"))+"</label><input id=\"chatTitle\" value=\""+(E(chatTitle(allTasks().find(t=>t.task_id===id)||{})||allTasks().find(t=>t.task_id===id)?.title||T("ui.window.action.bindTask.text")))+"\"><div class=\"actions\">"+(btn(T("ui.window.action.bindTask.text2"),'saveTaskLink',id,'primary sm'))+"</div>"));return;
 case'saveTaskLink':await api('/api/activity/bind',{task_id:id,url:$('#chatURL').value,title:$('#chatTitle').value});closeModal();break;
 case'openChatURL':{const r=await native('focusURL',{url:id,browser:S.settings.browser});if(r?.error)await openURL(id);return;}
 case'stopTask':await api('/api/tasks/stop',{id});if($('#modal').open)closeModal();toast(T("ui.window.action.stopTask.text"));break;
 case'external':await openURL(id);return;
 case'installSkill':await openLocalSetupHandoff();return;
 case'startDiagnostic':observation=await api('/api/diagnostics/start',{});toast(T("ui.window.action.startDiagnostic.text"));render();return;
 case'endDiagnostic':if(!observation)throw Error(T("ui.window.action.endDiagnostic.text"));{const r=await api('/api/diagnostics/end',{id:observation.id});observation=null;modal(("<h2>"+(TH("ui.window.action.endDiagnostic.text2"))+"</h2><pre>")+E(JSON.stringify(r,null,2))+'</pre>');}return;
 }await refresh();render();}
async function toggleRisk(id,on){return setRisk(id,on);}
const drawerEl=$('#drawer');drawerEl.addEventListener('close',()=>{const toastNode=$('#toast');if(toastNode?.parentElement===drawerEl)document.body.append(toastNode);if(drawerEl.open||drawerClosing)return;stopValueNumber();drawer=null;drawerReturnFocus?.isConnected&&drawerReturnFocus.focus();drawerReturnFocus=null;reportChrome();});closeOnBackdrop(drawerEl,closeDrawer);drawerEl.addEventListener('cancel',e=>{e.preventDefault();closeDrawer();});
document.addEventListener('keydown',e=>{if(e.target.matches?.('[data-value-day]')&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key)){const grid=e.target.closest('.value-days'),cells=[...grid.querySelectorAll('button:not([disabled])')],i=cells.indexOf(e.target),step={ArrowLeft:-7,ArrowRight:7,ArrowUp:-1,ArrowDown:1}[e.key],n=e.key==='Home'?0:e.key==='End'?cells.length-1:Math.max(0,Math.min(cells.length-1,i+step));e.preventDefault();for(const cell of cells)cell.tabIndex=-1;cells[n].tabIndex=0;cells[n].focus();return;}const dialog=$('#modal').open?$('#modal'):$('#drawer').open&&!$('#drawer').classList.contains('closing')?$('#drawer'):null;if(dialog&&e.key==='Tab'){const controls=[...dialog.querySelectorAll('button:not([disabled]),a[href],input,textarea,select,summary,[tabindex="0"]')].filter(el=>!el.hidden&&el.getClientRects().length);const first=controls[0],last=controls.at(-1);if(controls.length&&(e.shiftKey&&(!dialog.contains(document.activeElement)||document.activeElement===first)||!e.shiftKey&&(!dialog.contains(document.activeElement)||document.activeElement===last))){e.preventDefault();(e.shiftKey?last:first).focus();}}
 if($('#modal').open&&askResolve&&e.key==='Enter'){e.preventDefault();if(!askDangerous)$('#modal [data-action="askYes"]')?.click();return;}
if(e.key==='Escape'&&matterHelpOpen){e.preventDefault();matterHelpOpen=false;render();$('.mt-help-btn')?.focus();return;}if(e.key==='Escape'&&scopeOpen){e.preventDefault();void closeScope().then(()=>$('.scope-btn')?.focus());return;}if((e.key==='Enter'||e.key===' ')&&e.target?.matches?.('[role="button"][data-action]')){e.preventDefault();e.target.click();}});
const busyActions=new Set();
/* 焦点框只在用键盘时出现：用鼠标点开的弹窗，不再一打开就在「取消」外面套一圈蓝框；按 Tab 之后照常显示 */
addEventListener('pointerdown',()=>{document.documentElement.dataset.input='pointer';},true);
addEventListener('keydown',e=>{if(!['Shift','Control','Alt','Meta','CapsLock'].includes(e.key))document.documentElement.dataset.input='keyboard';},true);
document.body.addEventListener('click',async e=>{
 // 1053 后 待办空状态（Claude，10/17）：点说明卡外面就收起（点到别的按钮照常往下走）
 if(matterHelpOpen&&!e.target.closest('.mt-help')){matterHelpOpen=false;render();}
 const nav=e.target.closest('[data-page]');if(nav){e.preventDefault();window.showPage(nav.dataset.page);return;}
 const tb=e.target.closest('#app [data-tab]');if(tb&&['run','matters','done'].includes(tb.dataset.tab)){const from=tab;tab=tb.dataset.tab;focusTask=null;if(from!==tab){doneQuery='';matterQuery='';matterSelected.clear();}if(tb.classList.contains('more')){doneFilter='all';doneQuery='';}render();toListTop();if(from!==tab)tabIn(tab==='run'?-1:1);return;}
 const f=e.target.closest('[data-filter]');if(f){const changed=doneFilter!==f.dataset.filter;doneFilter=f.dataset.filter;render();if(changed)filterIn();return;}
 const mf=e.target.closest('[data-matter-filter]');if(mf){const next=mf.dataset.matterFilter;if(next!==matterFilter){matterFilter=next;matterShowDeleted=next==='deleted';matterSelected.clear();render();filterIn();}return;}
 if(scopeOpen&&!e.target.closest('.scope')){await closeScope();}
 const t=e.target.closest('[data-toggle]');if(t&&t.dataset.toggle.startsWith('risk:')){await toggleRisk(t.dataset.toggle.slice(5),t.getAttribute('aria-checked')!=='true');return;}
 if(t){const key=t.dataset.toggle,on=t.getAttribute('aria-checked')!=='true',inDrawer=!!t.closest('#drawer');if(capUnsupported(key)){t.setAttribute('aria-checked','false');await explainUnsupported(key);return;}if(CAP_WORDS[key]&&!await ask(capabilityTogglePrompt(key,on))){t.setAttribute('aria-checked',String(!on));return;}t.setAttribute('aria-checked',String(on));try{if(key==='launch_at_login'){const r=await native('setLoginItemEnabled',{enabled:on});if(r.error||r.error_code)throw Error(r.message||T("ui.window.common.text3"));nativeStatus={...nativeStatus,login_item:r};nativeStatusAt=Date.now();if(r.requires_approval)toast(T("ui.window.common.text4"));}else await api('/api/settings',{[key]:on});const cap=CAP_WORDS[key];if(cap){if(inDrawer){flash=cap[0];setTimeout(()=>{flash='';document.querySelectorAll('.dp-res.flash').forEach(el=>el.classList.remove('flash'));},1400);}else toast(on?T("ui.window.common.text5",{"value":cap[1]}):T("ui.window.common.text6",{"value":cap[1],"value2":cap[2]}));}await refresh();render();}catch(error){t.setAttribute('aria-checked',String(!on));toast(userMessage(error),'warn');}return;}
 const b=e.target.closest('[data-action]');if(!b)return;const busyKey=b.dataset.action+':'+(b.dataset.id||'');if(busyActions.has(busyKey))return;busyActions.add(busyKey);if(b.tagName==='A')e.preventDefault();const lock=b.tagName==='BUTTON',hadFocus=document.activeElement===b;if(lock)b.disabled=true;try{await action(b.dataset.action,b.dataset.id,b);}catch(error){if(!error?.quiet)toast(userMessage(error),'warn');}finally{busyActions.delete(busyKey);if(lock&&b.isConnected){b.disabled=false;/* 1081：按钮忙的时候是 disabled，焦点会掉到页面上；做完如果焦点还没去别处，就还给这个按钮，键盘用户不用从头 Tab。 */if(hadFocus&&(!document.activeElement||document.activeElement===document.body))b.focus({preventScroll:true});}}});
/* 已完成的搜索：输入就过滤；⌘F 把光标放进搜索框，Esc 清空 */
// 1025：搜索平时是一个放大镜，鼠标移上去或聚焦时向左展开成输入框；有字或正在输入时保持展开。
document.addEventListener('mousedown',e=>{if(e.target.closest?.('.done-clear'))e.preventDefault();});
document.addEventListener('focusin',e=>{if(e.target.id==='doneSearch'){doneSearchFocus=true;e.target.closest('.done-search')?.classList.add('open');}else if(e.target.id==='matterSearch'){matterSearchFocus=true;e.target.closest('.done-search')?.classList.add('open');}});
document.addEventListener('focusout',e=>{if(e.target.id==='doneSearch'){doneSearchFocus=false;if(!doneQuery)e.target.closest('.done-search')?.classList.remove('open');}else if(e.target.id==='matterSearch'){matterSearchFocus=false;if(!matterQuery)e.target.closest('.done-search')?.classList.remove('open');}});
// 1026：带虚线的说明词（.term[data-tip]），鼠标移上去或键盘聚焦时，在它下面弹一行说明。用一个浮层，不会被列表裁掉。
// 10/30：抽屉和弹框是 showModal 打开的，在最上面一层，挂在 body 上的提示会被盖住；提示跟着放进那个弹框里。
function showTip(el){let tip=$('#tip');if(!tip){tip=document.createElement('div');tip.id='tip';tip.setAttribute('role','tooltip');}const host=el.closest('dialog[open]')||document.body;if(tip.parentNode!==host)host.append(tip);tip.textContent=el.dataset.tip||'';tip.hidden=false;const r=el.getBoundingClientRect(),w=tip.offsetWidth,h=tip.offsetHeight;let x=Math.min(Math.max(8,r.left),innerWidth-w-8),y=r.bottom+6;if(y+h>innerHeight-8)y=r.top-h-6;tip.style.left=x+'px';tip.style.top=y+'px';}
function hideTip(){const tip=$('#tip');if(tip)tip.hidden=true;}
document.addEventListener('mouseover',e=>{const el=e.target.closest?.('[data-tip]');if(el)showTip(el);else hideTip();});
document.addEventListener('mouseout',e=>{if(e.target.closest?.('[data-tip]'))hideTip();});
document.addEventListener('focusin',e=>{if(e.target.matches?.('[data-tip]'))showTip(e.target);});
document.addEventListener('focusout',e=>{if(e.target.matches?.('[data-tip]'))hideTip();});
document.addEventListener('scroll',hideTip,true);
document.body.addEventListener('input',e=>{if(e.target.id==='matterSearch'){matterQuery=e.target.value;matterSelected.clear();const pos=e.target.selectionStart;render();const box=$('#matterSearch');if(box&&document.activeElement!==box){box.focus();try{box.setSelectionRange(pos,pos);}catch{}}return;}if(e.target.id!=='doneSearch')return;doneQuery=e.target.value;const pos=e.target.selectionStart;render();const box=$('#doneSearch');if(box&&document.activeElement!==box){box.focus();try{box.setSelectionRange(pos,pos);}catch{}}});
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&!e.shiftKey&&!e.altKey&&e.key.toLowerCase()==='f'&&!drawer&&!$('#modal').open){e.preventDefault();if(tab==='matters'){requestAnimationFrame(()=>{const box=$('#matterSearch');box?.focus();box?.select();});return;}if(tab!=='done'){tab='done';focusTask=null;render();}requestAnimationFrame(()=>{const box=$('#doneSearch');box?.focus();box?.select();});return;}if(e.key==='Escape'&&e.target.id==='doneSearch'&&doneQuery){e.preventDefault();doneQuery='';render();$('#doneSearch')?.focus();}if(e.key==='Escape'&&e.target.id==='matterSearch'&&matterQuery){e.preventDefault();matterQuery='';render();$('#matterSearch')?.focus();}});
/* 1030：成果小卡片整块单击就打开（Ken 10/7：去掉单独的「打开」按钮，只留「在访达中显示」） */
document.body.addEventListener('change',async e=>{try{if(e.target.matches?.('[data-matter-check]')){const id=e.target.dataset.matterCheck;if(e.target.checked)matterSelected.add(id);else matterSelected.delete(id);render();return;}if(e.target.id==='valuePlan'){const select=e.target,previous=S.settings.value_plan||'auto';select.disabled=true;try{await api('/api/settings',{value_plan:select.value});await refresh();}catch{select.value=previous;toast(T("ui.window.common.text7"),'warn');}finally{if(select.isConnected)select.disabled=false;}return;}if(e.target.id==='backend'){await api('/api/browser/select',{backend:e.target.value});await refresh();browserSheet();return;}}catch(error){toast(userMessage(error),'warn');}});
// Same-origin H10 view reuses the local UI owner+window-key guards; no credential crosses into a view model.
window.ChatHandH10Bridge=Object.freeze({
 state:()=>S,api:(route,body)=>api(route,body),
 native:(action,data)=>native(action,data),
 openChatGPT:(prompt,options)=>openChatGPT(prompt,options),
 refresh:()=>refresh(),applyTier:tier=>applyTier(tier),
 showPage:name=>window.showPage?.(name),
 toast:message=>toast(message), // 0012：「换一种连接方式」弹框确定后出「已切换到…」
 setCapability:(kind,on)=>setCapability(kind,on), // 1069：完成页两个开关直接装、直接授权
 setRisk:(kind,on)=>setRisk(kind,on),
 // 1081 N203（Claude）：旧私有发布桥退役，这里不再给 H10 读发布配置、开私有 Site 的入口。
 installationDescriptor:()=>({}), // DMG source is separate from Site creation.
 siteTemplateDescriptor:()=>S?.site_b?.verified_template_source||null // Trusted local server projection only; absent until signed release inputs exist.
});
addEventListener('DOMContentLoaded',()=>{if(S){window.wizardRefresh?.(S);scheduleRender();}},{once:true});
window.ChatHandSkin?.connect({save:skin=>api('/api/settings',{skin}),onError:message=>toast(message,'warn')});

/* Native UI locale arrives asynchronously. Rebuild translated constants and invalidate
   region caches so the first state render cannot retain the fallback language. */
function applyLocalText(){
PROMPT_LABELS=[T("ui.window.promptLabels.text"),T("ui.window.promptLabels.text2"),T("ui.window.promptLabels.text3")];
PROMPT_COPY_HINT=T("ui.window.promptCopyHint.text");
NAV=[['home',T("ui.window.nav.text")],['tasks',T("ui.window.nav.text2")],['conn',T("ui.window.nav.text3")],['settings',T("ui.window.nav.text4")]];
TOOL_WORDS={save_files:T("ui.window.toolWords.save_files.text"),write_file:T("ui.window.toolWords.write_file.text"),write_text:T("ui.window.toolWords.write_file.text"),edit_file:T("ui.window.toolWords.edit_file.text"),create_directory:T("ui.window.toolWords.create_directory.text"),move_file:T("ui.window.toolWords.move_file.text"),move_path:T("ui.window.toolWords.move_file.text"),rename_file:T("ui.window.toolWords.rename_file.text"),delete_file:T("ui.window.toolWords.delete_file.text"),trash_path:T("ui.window.toolWords.trash_path.text"),restore_file:T("ui.window.toolWords.restore_file.text"),restore_trash:T("ui.window.toolWords.restore_trash.text"),copy_file:T("ui.window.toolWords.copy_file.text")};
EXIT_WORDS={0:[T("ui.window.exitWords.text"),T("ui.window.exitWords.text2")],1:[T("ui.window.exitWords.text3"),T("ui.window.exitWords.text4")],2:[T("ui.window.exitWords.text5"),T("ui.window.exitWords.text6")],126:[T("ui.window.exitWords.text7"),T("ui.window.exitWords.text8")],127:[T("ui.window.exitWords.text9"),T("ui.window.exitWords.text10")],130:[T("ui.window.exitWords.text11"),T("ui.window.exitWords.text12")],137:[T("ui.window.exitWords.text13"),T("ui.window.exitWords.text14")],143:[T("ui.window.exitWords.text15"),T("ui.window.exitWords.text16")]};
MATTER_FILTERS=[['all',T("ui.window.matterFilters.text")],['waiting_user',T("ui.window.matterLabel.text")],['parked',T("ui.window.matterLabel.text4")],['resolved',T("ui.window.matterLabel.text3")],['deleted',T("ui.window.matterFilters.text2")]];
MATTER_TRY_PROMPT=T("ui.window.matterTryPrompt.text");
MATTER_DONE={delete:T("ui.window.matterDone.delete.text"),restore:T("ui.window.matterDone.restore.text"),append:T("ui.window.matterDone.append.text")};
MATTER_FAIL_WORDS={MATTER_REVISION_CONFLICT:T("ui.window.matterFailWords.matterRevisionConflict.text"),MATTER_DELETED:T("ui.window.matterFailWords.matterDeleted.text"),MATTER_NOT_DELETED:T("ui.window.matterFailWords.matterNotDeleted.text"),MATTER_MISSING:T("ui.window.matterFailWords.matterMissing.text"),OP_CONFLICT:T("ui.window.matterFailWords.opConflict.text"),MATTER_PROJECT_OWNER:T("ui.window.matterFailWords.matterProjectOwner.text"),MATTER_INVALID:T("ui.window.matterFailWords.matterInvalid.text")};
MATTER_ACTION_WORDS={create:T("ui.window.matterActionWords.create.text"),append:T("ui.window.matterActionWords.append.text"),delete:T("ui.window.toolWords.delete_file.text"),restore:T("ui.window.toolWords.restore_file.text")};
MATTER_EVIDENCE_WORDS={user_report:T("ui.window.matterEvidenceWords.user_report.text"),source_report:T("ui.window.matterEvidenceWords.source_report.text"),screenshot:T("ui.window.matterEvidenceWords.screenshot.text"),tool_receipt:T("ui.window.matterEvidenceWords.tool_receipt.text"),independent_check:T("ui.window.matterEvidenceWords.independent_check.text"),user_close:T("ui.window.matterEvidenceWords.user_close.text")};
CHECKPOINT_ACTIONS={resume_browser:T("ui.window.checkpointActions.resume_browser.text"),resume_desktop:T("ui.window.checkpointActions.resume_browser.text"),stop_here:T("ui.window.checkpointActions.stop_here.text")};
DRAWER_TITLES={settings:T("ui.window.nav.text4"),conn:T("ui.window.connCard.label"),scope:T("ui.window.permCard.label3"),terminal:T("ui.window.permCard.text3"),browser:T("ui.window.permCard.text4"),desktop:T("ui.window.permCard.text5"),help:T("ui.window.rail.text"),task:T("ui.window.drawerTitles.task.text"),usage:T("ui.window.drawerTitles.usage.text"),alwaysAllowed:T("ui.window.drawerTitles.alwaysAllowed.text"),permissionPreset:T("ui.window.drawerTitles.permissionPreset.text"),language:T("ui.window.pgSettings.language")};
FAQ=[[T("ui.window.faq.text"),T("ui.window.faq.text2")],[T("ui.window.faq.text3"),T("ui.window.faq.text4")],[T("ui.window.faq.text5"),T("ui.window.faq.text6")],[T("ui.window.faq.text7"),T("ui.window.faq.text8")],[T("ui.window.faq.text9"),T("ui.window.faq.text10")],[T("ui.window.faq.text11"),T("ui.window.faq.text12")]];
STALL_TOOL_WORDS={read_text:T("ui.window.stallToolWords.read_text.text"),read_file:T("ui.window.stallToolWords.read_text.text"),get_file_info:T("ui.window.stallToolWords.get_file_info.text"),search_text:T("ui.window.stallToolWords.search_text.text"),start_search:T("ui.window.stallToolWords.search_text.text"),list_directory:T("ui.window.stallToolWords.list_directory.text"),propose_command:T("ui.window.pgUsage.text5"),command_result:T("ui.window.stallToolWords.command_result.text"),command_input:T("ui.window.stallToolWords.command_input.text"),write_text:T("ui.window.stallToolWords.write_text.text"),edit_file:T("ui.window.stallToolWords.edit_file.text"),create_directory:T("ui.window.toolWords.create_directory.text"),move_path:T("ui.window.toolWords.move_file.text"),trash_path:T("ui.window.toolWords.trash_path.text"),begin_task:T("ui.window.stepsOf.title.text4"),task_checkpoint:T("ui.window.stallToolWords.task_checkpoint.text"),task_status:T("ui.window.stallToolWords.task_status.text"),finish_task:T("ui.window.stallToolWords.finish_task.text"),bridge_info:T("ui.window.stallToolWords.bridge_info.text"),show_task:T("ui.window.stallToolWords.show_task.text"),search_results:T("ui.window.stallToolWords.search_results.text"),stop_search:T("ui.window.stallToolWords.stop_search.text"),cancel_command:T("ui.window.stallToolWords.cancel_command.text"),list_commands:T("ui.window.stallToolWords.list_commands.text"),input_status:T("ui.window.stallToolWords.input_status.text"),restore_file:T("ui.window.stallToolWords.restore_file.text"),restore_trash:T("ui.window.toolWords.restore_trash.text"),operation_status:T("ui.window.stallToolWords.operation_status.text"),system_inspect:T("ui.window.stallToolWords.system_inspect.text"),git_inspect:T("ui.window.stallToolWords.git_inspect.text"),desktop_action:T("ui.window.stallToolWords.desktop_action.text"),browser_status:T("ui.window.stallToolWords.browser_status.text"),browser_open:T("ui.window.stallToolWords.browser_open.text"),browser_tabs:T("ui.window.stallToolWords.browser_tabs.text"),browser_snapshot:T("ui.window.stallToolWords.browser_snapshot.text"),browser_read:T("ui.window.stallToolWords.browser_snapshot.text"),browser_find:T("ui.window.stallToolWords.browser_find.text"),browser_action:T("ui.window.pgUsage.text6"),browser_batch:T("ui.window.pgUsage.text6"),browser_wait_for:T("ui.window.stallToolWords.browser_wait_for.text"),browser_screenshot:T("ui.window.stallToolWords.browser_screenshot.text"),browser_upload:T("ui.window.stallToolWords.browser_upload.text"),browser_download:T("ui.window.stallToolWords.browser_download.text"),browser_close:T("ui.window.stallToolWords.browser_close.text"),computer_status:T("ui.window.stallToolWords.computer_status.text"),computer_observe:T("ui.window.stallToolWords.computer_observe.text"),computer_screenshot:T("ui.window.stallToolWords.computer_screenshot.text"),computer_action:T("ui.window.pgUsage.text7"),computer_batch:T("ui.window.pgUsage.text7"),computer_applications:T("ui.window.stallToolWords.computer_applications.text"),computer_focus:T("ui.window.stallToolWords.computer_focus.text"),automation_stop:T("ui.window.stallToolWords.automation_stop.text"),save_files:T("ui.window.toolWords.save_files.text"),expect_download:T("ui.window.stallToolWords.expect_download.text"),artifact_status:T("ui.window.stallToolWords.artifact_status.text"),image_batch_start:T("ui.window.stallToolWords.image_batch_start.text"),image_batch_save:T("ui.window.stallToolWords.image_batch_save.text"),image_batch_status:T("ui.window.stallToolWords.image_batch_status.text"),matter_write:T("ui.window.colHead.text3"),matter_query:T("ui.window.stallToolWords.matter_query.text"),task_history:T("ui.window.stallToolWords.task_history.text"),task_changes:T("ui.window.stallToolWords.task_changes.text"),log_note:T("ui.window.stallToolWords.log_note.text"),task_stop:T("ui.window.stallToolWords.task_stop.text"),request_permission:T("ui.window.stallToolWords.request_permission.text"),connection_check:T("ui.window.stallToolWords.connection_check.text"),list_conversations:T("ui.window.stallToolWords.list_conversations.text"),records_export:T("ui.window.stallToolWords.records_export.text"),install_update:T("ui.window.stallToolWords.install_update.text"),request_update:T("ui.window.stallToolWords.request_update.text"),upgrade_status:T("ui.window.stallToolWords.upgrade_status.text")};
CAP_WORDS={terminal_enabled:['terminal',T("ui.window.permCard.text3"),T("ui.window.pgUsage.text5")],browser_enabled:['browser',T("ui.window.permCard.text4"),T("ui.window.capWords.browser_enabled.text")],desktop_enabled:['desktop',T("ui.window.permCard.text5"),T("ui.window.capWords.desktop_enabled.text")]};
 for(const node of document.querySelectorAll('[data-local-text]'))node.textContent=T(node.dataset.localText);
 for(const node of document.querySelectorAll('[data-local-text-aria]'))node.setAttribute('aria-label',T(node.dataset.localTextAria));
 if(S)S=localizeServerState(S); // 0010（Claude，#55）：后台那些话也跟着换语言
 lastKey='';regionKeys.clear();regionHTML.clear();if(S)scheduleRender();
}
window.ChatHandText.subscribe(applyLocalText);
applyLocalText();
const localTextReady=native('getLocalTextCatalogs',{}).then(result=>{if(result?.catalogs)window.ChatHandText.installCatalogs(result);if(LANGUAGE_CHOICES.includes(result?.preference)){languagePreference=result.preference;applyLocalText();}return result;});
window.ChatHandLocalTextReady=localTextReady;

refresh();window.ChatHandStream?.start(
 state=>{h10StreamArrivalSerial++;adoptState(state);},
 patch=>{h10StreamArrivalSerial++;adoptPatch(patch);},
 status=>{if(status==='blocked')keyLostSoon();}
);addEventListener('pagehide',()=>window.ChatHandStream?.stop());

// The solid native under-page area follows the actual theme/skin background.
// This message accepts a color only and cannot change any permission.
(()=>{if(!IN_APP)return;let scheduled=0,last='';
 const sync=()=>{scheduled=0;const raw=getComputedStyle(document.body).backgroundColor;if(raw===last)return;const match=raw.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/);if(!match)return;const color=[...match.slice(1,4).map(Number).map(x=>x/255),match[4]===undefined?1:Number(match[4])];if(color.some(x=>!Number.isFinite(x)||x<0||x>1)||color[3]!==1)return;last=raw;native('pageBackground',{color}).then(result=>{if((result?.error||result?.error_code)&&last===raw)last='';});};
 const schedule=()=>{if(!scheduled)scheduled=requestAnimationFrame(sync);};
 const observer=new MutationObserver(schedule);observer.observe(document.documentElement,{attributes:true});observer.observe(document.body,{attributes:true});
 matchMedia('(prefers-color-scheme: dark)').addEventListener('change',schedule);window.addEventListener('pageshow',schedule);schedule();
})();
