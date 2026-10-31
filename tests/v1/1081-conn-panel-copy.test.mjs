// 1081（Claude，Ken 10/26）：设置 → ChatGPT 连接的结果条和 Site 能不能建。
// 结果条：「使用中」是跟在标题后面的标签；好着的时候下面写多久前确认过（前面不带「云端」），不再写「ChatGPT 还没用过它」。
// Site：不再要求先开过一次 Site 配对才算能建；到了建站那一页没有建站话，先开一次 Site 配对拿到。
// 拿不到时那一页（Ken 10/26 说看着诡异、看不懂）：空状态，「再试一次」加「改用 OpenAI 通道」，字里没有内部用语。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {renderH10} from '../../ui/h10/views.mjs';
const P=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const app=fs.readFileSync(path.join(P,'ui/app.js'),'utf8'),host=fs.readFileSync(path.join(P,'ui/h10/host.mjs'),'utf8');
const zh=JSON.parse(fs.readFileSync(path.join(P,'locales/zh.json'),'utf8')),en=JSON.parse(fs.readFileSync(path.join(P,'locales/en.json'),'utf8'));
const between=(src,a,b)=>{const i=src.indexOf(a),j=src.indexOf(b,i);assert.ok(i>=0&&j>i,`${a} … ${b}`);return src.slice(i,j);};
const plain=x=>JSON.parse(JSON.stringify(x));
const lit=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

function panel(state,over={}){
 const T=(k,p)=>p?`${k}${JSON.stringify(p)}`:k;
 const box=vm.createContext({S:state,flash:'',
  T,TH:(k,p)=>`${k}{${Object.entries(p||{}).map(([n,v])=>`${n}=${v}`).join(',')}}`,E:x=>String(x??''),icon:x=>`<i ${x}>`,
  btn:(l,a)=>`<button ${a}>${l}</button>`,tbtn:(l,a)=>`<tbtn ${a}>${l}</tbtn>`,kvRow:(k,v,act='')=>`<row k="${k}">${v}${act}</row>`,sw:()=>'<sw>',
  timed:(ms,fmt,text,cls='',source='')=>`<time ${source}>${text}</time>`,confirmedAgo:()=>'ui.window.confirmedAgo.text2',ago:()=>'ago',when:()=>'when',
  connModel:()=>({st:'online',label:'L',sub:'S'}),linkHeld:()=>false,paused:()=>false,siteBlock:()=>null,appMissing:()=>false,appUnbound:()=>false,shownAppName:()=>'ChatHand-Mac',
  routeStatus:()=>({st:'online'}),siteHealthy:()=>true,siteTested:()=>true,siteOrigin:()=>null,
  routeLastCall:()=>null,...over});
 vm.runInContext(between(app,'function connRes(','function connStandby(')+between(app,'function connKV(','function connFoot('),box);
 return box;
}
const openaiState=(extra={})=>({relay:{online:false},connection:{device_name:'Mac',display:{connected:true,last_confirmed_at:1000}},setup_test:{verified:true},...extra});

// 断言跟着 Ken 10/27 10:37 改：「使用中」从标题后面挪到卡片右上角的角标（span.conn-corner，卡片带 cur），每种状态都一样。
test('the in-use bar says 连接正常 with a 使用中 corner badge, and how long ago it was confirmed instead of “ChatGPT hasn’t used it”',()=>{
 const corner=(html,title)=>{assert.match(html,new RegExp('^<div class="dp-res conn-res[^"]* cur[ "][^>]*><span class="conn-corner">ui\\.window\\.conn\\.inUseTag</span>'),'the badge is the first thing in the card');assert.match(html,new RegExp('<b>'+title+'</b>'),'the title has nothing after it');assert.doesNotMatch(html,/tag cur/);};
 const tunnel=panel(openaiState()).connUseRes('openai');
 corner(tunnel,'ui\\.window\\.conn\\.useOk');
 assert.match(tunnel,/<time confirmation>ui\.window\.confirmedAgo\.text2<\/time>/,'OpenAI shows how long ago it was confirmed, ticking off the confirmation clock');
 assert.doesNotMatch(tunnel,/connModel\.left\.text/,'no 「云端」 in front of it');
 assert.doesNotMatch(tunnel,/neverUsed|lastUsed/);
 const site=panel({site_b:{routes:{site:{}}}}).connUseRes('site');
 corner(site,'ui\\.window\\.conn\\.useOk');assert.match(site,/ui\.window\.confirmedAgo\.text(?!2)/);assert.doesNotMatch(site,/connModel\.left\.text/,'a Site is not “the cloud”');
 const untested=panel({site_b:{routes:{site:{}}}},{siteTested:()=>false}).connUseRes('site');
 corner(untested,'ui\\.window\\.conn\\.untested');
 const idle=panel(openaiState({connection:{display:{connected:false}}}),{routeStatus:()=>({st:'idle'})}).connUseRes('openai');
 corner(idle,'ui\\.window\\.conn\\.idleRes');
 const broken=panel(openaiState(),{otherRoute:r=>r==='site'?'openai':'site',nbName:x=>x,routeAdded:()=>false,connRouteName:x=>x,fullStop:x=>x,connBusy:''});
 assert.match(broken.connBroken('site','down',true),/^<div class="dp-res conn-res warn cur"><span class="conn-corner">ui\.window\.conn\.inUseTag<\/span>/,'the broken in-use bar keeps the badge');
 assert.doesNotMatch(broken.connBroken('site','down',false),/conn-corner| cur"/,'a backup route never gets the badge');
 // 换连接方式的框里也一样：「使用中」是选项右上角的角标，「已连上」还跟在名字后面
 const host=fs.readFileSync(new URL('../../ui/h10/host.mjs',import.meta.url),'utf8'),dialog=host.slice(host.indexOf('function openRouteDialog('),host.indexOf("routeDialog.addEventListener('click'"));
 assert.match(dialog,/cur\.className='h10-route-cur';cur\.textContent=uiText\("ui\.h10\.host\.routeDialogCurrent"\);option\.classList\.add\('cur'\);option\.append\(cur\)/);
 assert.match(dialog,/chip\.className='h10-route-chip';chip\.textContent=uiText\("ui\.h10\.host\.routeDialogConnected"\);name\.append\(chip\)/);
 assert.doesNotMatch(dialog,/routeDialogCurrent[^;]*name\.append/);
});

test('the info rows: a passed setup test still reads 通过 after a restart, and 最近一次用 only appears once it was used',()=>{
 const rows=panel(openaiState()).connKV('openai',true);
 assert.match(rows,/<row k="ui\.window\.pgConn\.text7">ui\.window\.pgConn\.text9<tbtn testConnection>ui\.window\.pgConn\.text11/);
 assert.doesNotMatch(rows,/conn\.lastUse|conn\.never/);
 const untested=panel(openaiState({setup_test:{verified:false}})).connKV('openai',true);
 assert.match(untested,/pgConn\.text10<tbtn testConnection>ui\.window\.conn\.untestedAct/);
 const used=panel(openaiState(),{routeLastCall:()=>({time:5})}).connKV('openai',true);
 assert.match(used,/<row k="ui\.window\.conn\.lastUse"><time >ago<\/time>/);
});

// 1082（Ken 10/28 16:22）：进建站页拿不到时会隔 0.8 秒静默再开一次，所以这里能定：前几次失败（failTimes）、第几次以后拿到建站那句话（readyAfter）、
// 等的时候离开这一页（leaveOnWait）。setTimeout 记下要等多久、真等 0 毫秒；同时记下等的时候页面是不是还在「正在准备」。
function sitePieces(b,descriptor=null,{fail=null,screen='f10',failTimes=Infinity,readyAfter=0,leaveOnWait=false}={}){
 const calls=[],waits=[],primingWhileWaiting=[];let renders=0,refreshed=0,desc=descriptor;
 const box=vm.createContext({screen,noticeText:'',
  bridge:()=>({siteTemplateDescriptor:()=>desc,refresh:async()=>{refreshed++;}}),
  siteCreationHandoff:d=>({configured:!!d?.ok}),bState:()=>b,render:()=>{renders++;},
  uiText:(k,p)=>p?`${k}${JSON.stringify(p)}`:k,safeCode:e=>e?.code||'OPERATION_FAILED',
  setTimeout:(fn,ms)=>{waits.push(ms);primingWhileWaiting.push(box.__t.priming());if(leaveOnWait)box.screen='f6';return setTimeout(fn,0);},
  api:async(p,body)=>{calls.push([p,body]);if(fail&&calls.length<=failTimes)throw Object.assign(Error(fail),{code:fail});if(readyAfter&&calls.length>=readyAfter)desc={ok:true};return {route:'site'};}});
 vm.runInContext(between(host,'const siteHandoff=','const routeName=')+';globalThis.__t={siteCreatable,primeSiteTemplate,retrySiteTemplate,priming:()=>sitePriming,retrying:()=>siteRetrying,failure:()=>siteRetryFailure,primeError:()=>sitePrimeError};',box);
 return {t:box.__t,box,calls,waits,primingWhileWaiting,renders:()=>renders,refreshed:()=>refreshed};
}

test('Site counts as creatable without a pairing started in the last 24 hours, unless this build has no template',()=>{
 assert.equal(sitePieces({routes:{}}).t.siteCreatable(),true,'fresh install, no pairing intent yet');
 assert.equal(sitePieces({routes:{},pairing:{template_ready:true}}).t.siteCreatable(),true);
 assert.equal(sitePieces({routes:{},pairing:{template_ready:false}}).t.siteCreatable(),false,'only a build without the template says no');
 assert.equal(sitePieces({routes:{site:{configured:true}},pairing:{template_ready:false}}).t.siteCreatable(),true,'an already paired Site can always be continued');
});

test('the Site page starts one Site pairing to get its prompt, and only when it has none',async()=>{
 // 1082：这一次就拿到了建站那句话（readyAfter:1），所以只开一次、不等；拿不到时的静默重试见下一条。
 const fresh=sitePieces({routes:{}},null,{readyAfter:1});
 const run=fresh.t.primeSiteTemplate();assert.equal(fresh.t.priming(),true);await fresh.t.primeSiteTemplate();await run;
 assert.deepEqual(plain(fresh.calls),[['/api/setup/site/start',{}]],'a second call while the first runs does nothing');
 assert.deepEqual(fresh.waits,[],'got the prompt the first time: no quiet retry');
 assert.equal(fresh.refreshed(),1);assert.equal(fresh.t.priming(),false);assert.ok(fresh.renders()>=2);
 const ready=sitePieces({routes:{}},{ok:true});await ready.t.primeSiteTemplate();assert.equal(ready.calls.length,0);
 const none=sitePieces({routes:{},pairing:{template_ready:false}});await none.t.primeSiteTemplate();assert.equal(none.calls.length,0);
 assert.match(host,/function setScreen\(value,purpose\)\{[^\n]*if\(value==='f10'\)void primeSiteTemplate\(\);\}/);
 assert.match(host,/if\(screen==='f10'\)void primeSiteTemplate\(\);/);
});

// 1082（Ken 10/28 16:22）：进这一页时本机服务可能刚启动、还没应答。第一次没拿到，隔 0.8 秒静默再开一次，等的时候页面还是「正在准备」；
// 两次都没拿到才出「暂时无法创建 ChatGPT Site」。只多试这一次；离开了这一页就不试；点「再试一次」只开一次。
test('entering the Site page quietly tries once more 0.8 s later before it shows “can’t create”, and only once',async()=>{
 const late=sitePieces({routes:{},pairing:{template_ready:true}},null,{fail:'OPERATION_UNAVAILABLE',failTimes:1,readyAfter:2});
 const run=late.t.primeSiteTemplate();assert.equal(late.t.priming(),true);await run;
 assert.deepEqual(plain(late.calls),[['/api/setup/site/start',{}],['/api/setup/site/start',{}]],'the first one got no answer, the quiet second one got the prompt');
 assert.deepEqual(late.waits,[800]);assert.deepEqual(late.primingWhileWaiting,[true],'the page keeps its “preparing” look while it waits');
 assert.equal(late.t.priming(),false);assert.equal(late.t.primeError(),null);assert.equal(late.refreshed(),1);
 assert.equal(late.t.failure(),null,'no “can’t create” state was recorded');
 const down=sitePieces({routes:{},pairing:{template_ready:true}},null,{fail:'B_PAIRING_START_UNAVAILABLE'});
 await down.t.primeSiteTemplate();
 assert.equal(down.calls.length,2,'two tries in all, then the page shows “can’t create”');assert.deepEqual(down.waits,[800]);
 assert.equal(down.t.priming(),false);assert.equal(down.t.primeError(),'B_PAIRING_START_UNAVAILABLE');
 const answeredEmpty=sitePieces({routes:{},pairing:{template_ready:true}});
 await answeredEmpty.t.primeSiteTemplate();
 assert.equal(answeredEmpty.calls.length,2,'the service answered but there is still no prompt: also tries once more');assert.equal(answeredEmpty.refreshed(),2);
 const away=sitePieces({routes:{},pairing:{template_ready:true}},null,{fail:'X',leaveOnWait:true});
 await away.t.primeSiteTemplate();assert.equal(away.calls.length,1,'left the page while waiting: no second try');assert.equal(away.t.priming(),false);
 const elsewhere=sitePieces({routes:{},pairing:{template_ready:true}},null,{fail:'X',screen:'f6'});
 await elsewhere.t.primeSiteTemplate();assert.equal(elsewhere.calls.length,1);assert.deepEqual(elsewhere.waits,[],'not on the Site page: no waiting');
 const b={routes:{},pairing:{template_ready:true}},gone=sitePieces(b);
 gone.box.api=async p=>{gone.calls.push([p,{}]);b.pairing.template_ready=false;throw Object.assign(Error('B_TEMPLATE_UNVERIFIED'),{code:'B_TEMPLATE_UNVERIFIED'});};
 await gone.t.primeSiteTemplate();assert.equal(gone.calls.length,1,'the service says this copy has no Site template: trying again would not help');assert.deepEqual(gone.waits,[]);
 const manual=sitePieces({routes:{},pairing:{template_ready:true}},null,{fail:'B_PAIRING_START_UNAVAILABLE'});
 await manual.t.retrySiteTemplate();
 assert.equal(manual.calls.length,1,'“Try Again” is the user’s own click: one try');assert.deepEqual(manual.waits,[]);
 assert.deepEqual(plain(manual.t.failure()),{code:'B_PAIRING_START_UNAVAILABLE'});
 assert.match(host,/const SITE_PRIME_RETRY_MS=800;/);assert.match(host,/try\{await primeSiteTemplate\(\{silentRetry:false\}\);\}/);
});

test('while the prompt is being fetched the Site page shows its steps with the two buttons greyed, not “can’t set up a Site”',()=>{
 const base={provenance:'host',screen:'f10',connectionRoute:'site',setupMode:'manual',connectionActor:'user',guideStep:1,steps:[],templateConfigured:false,sitePromptEnabled:false,workPrompt:null};
 const preparing=renderH10({...base,templatePreparing:true});
 assert.match(preparing,/data-action="open-work" disabled/);assert.match(preparing,/data-action="copy-work-prompt" disabled/);
 const failed=renderH10({...base,templatePreparing:false});
 assert.doesNotMatch(failed,/data-action="open-work"/);
 // 1081（Ken 10/26）：不再是一块空卡片里只放一个「换一种连接方式」。空状态：图标、标题、一句话，主按钮「再试一次」，灰链接「改用 OpenAI 通道」。
 assert.match(failed,/<div class="h10-state" data-state="site-unavailable"><div class="empty-art h10-state-icon" aria-hidden="true">/);
 assert.match(failed,/<use href="#i-site"\/>/);
 assert.doesNotMatch(failed,/h10-card|h10-guide-blocked|data-action="change-route"/);
 assert.match(failed,new RegExp(`<div class="h10-state-action"><button type="button" class="h10-button h10-button-primary h10-button-l" data-action="retry-site">${lit(zh['ui.h10.views.siteRetry'])}</button></div>`));
 assert.match(failed,new RegExp(`<nav class="h10-quiet-links"[^>]*><button type="button" class="h10-link" data-action="switch-openai">${lit(zh['ui.h10.host.useOpenAI'])}</button></nav>`));
 assert.equal((failed.match(/h10-button-primary/g)||[]).length,1,'one primary button');
 assert.match(failed,new RegExp(`<h1>${lit(zh['ui.h10.views.templateUnavailableTitle'])}</h1><p>${lit(zh['ui.h10.views.templateUnavailableIntroduction'])}</p>`));
 // 点了「再试一次」：留在这一页，按钮写「正在重试…」、灰着，旁边的链接也灰着，不跳回带步骤的那一页。
 const retrying=renderH10({...base,templatePreparing:true,siteRetrying:true});
 assert.match(retrying,/data-state="site-unavailable"/);assert.doesNotMatch(retrying,/data-action="open-work"/);
 assert.match(retrying,new RegExp(`data-action="retry-site" disabled>${lit(zh['ui.h10.views.siteRetrying'])}<`));
 assert.match(retrying,/data-action="switch-openai" disabled/);
 // 这一版真没带建站的东西（只有开发版）：不给「再试一次」，主按钮就是「改用 OpenAI 通道」。
 const none=renderH10({...base,templatePreparing:false,siteRetryAvailable:false});
 assert.doesNotMatch(none,/retry-site/);assert.match(none,/class="h10-button h10-button-primary h10-button-l" data-action="switch-openai"/);
 assert.match(none,new RegExp(`<p>${lit(zh['ui.h10.views.templateUnavailableNoRetry'])}</p>`));assert.doesNotMatch(none,/h10-quiet-links/);
 // 1082（Ken 10/28 15:50）：按钮底下不再叠一行橙字复读；这一页不画 noticeCopy。
 const note=renderH10({...base,templatePreparing:false,noticeCopy:'still'});
 assert.doesNotMatch(note,/h10-host-message|still/);
 // 点过「再试一次」还是不行：副标题换成橙色的「依然无法连接（错误码）…」，主按钮变成「改用 OpenAI 通道」，「再试一次」退成灰链接。
 const again=renderH10({...base,templatePreparing:false,siteRetryFailed:true,siteRetryErrorCode:'B_PAIRING_START_UNAVAILABLE'});
 assert.match(again,/<div class="h10-state" data-state="site-unavailable" data-retry="failed">/);
 assert.match(again,new RegExp(`<h1>${lit(zh['ui.h10.views.templateUnavailableTitle'])}</h1><p class="h10-state-alert" role="status">${lit(zh['ui.h10.host.siteRetryFailedCode'].replace('{code}','B_PAIRING_START_UNAVAILABLE'))}</p>`));
 assert.doesNotMatch(again,new RegExp(lit(zh['ui.h10.views.templateUnavailableIntroduction'])));
 assert.match(again,new RegExp(`<div class="h10-state-action"><button type="button" class="h10-button h10-button-primary h10-button-l" data-action="switch-openai">${lit(zh['ui.h10.host.useOpenAI'])}</button></div>`));
 assert.match(again,new RegExp(`<nav class="h10-quiet-links"[^>]*><button type="button" class="h10-link" data-action="retry-site">${lit(zh['ui.h10.views.siteRetry'])}</button></nav>`));
 assert.equal((again.match(/h10-button-primary/g)||[]).length,1,'still one primary button');
 const againNoCode=renderH10({...base,templatePreparing:false,siteRetryFailed:true});
 assert.match(againNoCode,new RegExp(`<p class="h10-state-alert" role="status">${lit(zh['ui.h10.host.siteRetryFailed'])}</p>`));
 // 在这个样子里再点「再试一次」：灰链接写「正在重试…」、灰着，主按钮也灰着，样子不跳。
 const againRetrying=renderH10({...base,templatePreparing:true,siteRetrying:true,siteRetryFailed:true});
 assert.match(againRetrying,/data-retry="failed"/);
 assert.match(againRetrying,new RegExp(`class="h10-link" data-action="retry-site" disabled>${lit(zh['ui.h10.views.siteRetrying'])}<`));
 assert.match(againRetrying,/class="h10-button h10-button-primary h10-button-l" data-action="switch-openai" disabled/);
 // 开发版没带建站的东西：不管重试过没有，都只有「改用 OpenAI 通道」。
 const noneAgain=renderH10({...base,templatePreparing:false,siteRetryAvailable:false,siteRetryFailed:true});
 assert.doesNotMatch(noneAgain,/retry-site|data-retry|h10-state-alert/);
});

// 1082（Ken 10/28 15:50）：还是不行时不再写一行提示（noticeText 一直是空的），只记下「重试失败过」和错误码，页面据此换样子。
test('“Try Again” on that page starts one more Site pairing and, when it still fails, switches the page to its “still can’t connect” state',async()=>{
 const ok=sitePieces({routes:{},pairing:{template_ready:true}});
 assert.equal(ok.t.failure(),null,'first time on the page: not failed yet');
 const run=ok.t.retrySiteTemplate();assert.equal(ok.t.retrying(),true);await ok.t.retrySiteTemplate();await run;
 assert.deepEqual(plain(ok.calls),[['/api/setup/site/start',{}]],'a second click while retrying does nothing');
 assert.equal(ok.t.retrying(),false);
 assert.deepEqual(plain(ok.t.failure()),{code:null},'the server answered but there is still no prompt, so the retry still counts as failed');
 assert.equal(ok.box.noticeText,'','no extra line under the buttons or in the top bar');
 const done=sitePieces({routes:{},pairing:{template_ready:true}},{ok:true});await done.t.retrySiteTemplate();
 assert.equal(done.t.failure(),null,'already has the prompt: not failed');assert.equal(done.box.noticeText,'');
 const failed=sitePieces({routes:{},pairing:{template_ready:true}},null,{fail:'B_PAIRING_START_UNAVAILABLE'});await failed.t.retrySiteTemplate();
 assert.deepEqual(plain(failed.t.failure()),{code:'B_PAIRING_START_UNAVAILABLE'});assert.equal(failed.box.noticeText,'');
 const away=sitePieces({routes:{},pairing:{template_ready:true}},null,{fail:'X',screen:'f6'});await away.t.retrySiteTemplate();
 assert.equal(away.t.failure(),null,'left the page meanwhile: the Site page state is not touched');assert.equal(away.box.noticeText,'');
 assert.match(host,/siteRetryFailed:!!siteRetryFailure&&site\.configured!==true,siteRetryErrorCode:siteRetryFailure\?\.code\|\|null,/);
 assert.match(host,/case'retry-site':void retrySiteTemplate\(\);return;/);assert.match(host,/case'switch-openai':void switchRoute\('openai'\);return;/);
 assert.match(host,/siteRetryAvailable:b\.pairing\?\.template_ready!==false,siteRetrying,/);
});

test('copy on the Site pages and the connection page is in plain words, zh and en together',()=>{
 const keys=['ui.h10.views.templateUnavailableTitle','ui.h10.views.templateUnavailableIntroduction','ui.h10.views.templateUnavailableNoRetry',
  'ui.h10.views.siteRetry','ui.h10.views.siteRetrying','ui.h10.host.siteRetryFailed','ui.h10.host.siteRetryFailedCode','ui.h10.host.siteUnavailable',
  'ui.h10.host.templateUnavailable','ui.h10.host.templateMissing','ui.h10.host.siteTemplateUnverified','ui.h10.host.installSourceMissing',
  'ui.h10.host.newTemplateMissing','ui.h10.host.operationUnavailable','ui.h10.host.chatGPTOpened','ui.h10.host.chatGPTOpenUnconfirmed',
  'ui.h10.host.sitePairing','ui.h10.host.pairingVerificationPending','ui.h10.host.siteVerificationRequired','ui.h10.host.pairingStoppedAssisted',
  'ui.h10.host.stuckIntro','ui.h10.host.manifestRejected','ui.setup.tunnelRecorded','ui.setup.localTunnelConnected','ui.setup.readWriteProbeReceived',
  'ui.h10.views.receivingCredential','ui.h10.host.receivedPairingData','ui.h10.host.pairingInProgress','ui.h10.host.credentialsUpdating',
  'ui.h10.host.pairingFailed','ui.h10.host.credentialsRenewed','ui.h10.host.pairingUnverified','ui.h10.host.verificationFailed','ui.h10.host.verifyPairing',
  'ui.h10.views.credentialExpiredTitle','ui.h10.host.renewCredentials','ui.h10.prompts.credentialRejected','ui.h10.prompts.templateMismatch',
  'ui.h10.prompts.credentialsExpired','ui.h10.prompts.pairingIntentMissing','ui.h10.prompts.pairingIntentExpired','ui.h10.assets.credentialCopyAlt',
  'ui.window.connModel.label.text3','ui.window.connModel.sub.text3',
  'ui.window.connectionPage.connecting.text3','ui.window.connectionPage.offline.text3','ui.window.connectionPage.unset.text2','ui.window.offlineReason.text3',
  'ui.window.taskState.label.text','ui.window.techRows.text3','ui.window.techRows.siteLink','ui.window.siteRow.text2'];
 for(const k of keys){
  assert.equal(typeof zh[k],'string',k);assert.equal(typeof en[k],'string',k);
  assert.doesNotMatch(zh[k],/宿主|回执|设备健康|凭据|核验|实例|握手|心跳|路由|配对摘要|这版 ChatHand|这一版 ChatHand|本人/,k);
  assert.doesNotMatch(en[k],/receipt|credential|host |device health|verif|this build|handshake|heartbeat/i,k);
 }
 assert.equal(en['ui.h10.views.siteRetry'],'Try Again');assert.equal(en['ui.h10.host.verifyPairing'],'Check again','a gray link: sentence case');
 // 技术信息里 Site 那几行：不再有「宿主连接 · 还需取得真实回执」那一行，「设备健康」改叫「Site 连接」。
 const tech=between(app,'function techRows(','const px=');
 assert.doesNotMatch(tech,/techRows\.text10|techRows\.text11|connModel\.label\.text3/);assert.match(tech,/techRows\.siteLink/);
 assert.match(host,/assistedIntro:screen!=='f7'\|\|handoffFailed\?null:stopped\?uiText\("ui\.h10\.host\.pairingStoppedIntro"\):stuck\?uiText\("ui\.h10\.host\.stuckIntro"\):null,/);
});

test('copy: one 特点 line per route, the same line in the route dialog, no 好在/要做 and no “never used”',()=>{
 for(const L of [zh,en]){
  for(const k of ['ui.window.conn.steps','ui.window.conn.stepsSite','ui.window.conn.stepsTunnel','ui.window.conn.neverUsed','ui.window.conn.lastUsed','ui.window.conn.never'])assert.equal(L[k],undefined,k);
  assert.equal(L['ui.h10.host.routeSiteNote'],L['ui.window.conn.prosSite']);assert.equal(L['ui.h10.host.routeOpenAINote'],L['ui.window.conn.prosTunnel']);
  assert.equal(L['ui.h10.host.routeDialogCurrent'],L['ui.window.conn.inUseTag']);
 }
 assert.equal(zh['ui.window.conn.pros'],'特点');assert.equal(zh['ui.window.conn.useOk'],'连接正常');assert.equal(zh['ui.window.conn.inUseTag'],'使用中');assert.equal(en['ui.window.conn.inUseTag'],'In use');
 assert.match(zh['ui.window.conn.prosSite'],/Cloudflare/);assert.doesNotMatch(zh['ui.window.conn.prosSite']+zh['ui.window.conn.prosTunnel'],/后台/);
 assert.doesNotMatch(app,/conn\.steps|neverUsed|conn\.lastUsed"/);
});

// 1081（Claude，Ken 10/27 11:39、11:43、12:18）：在用的那条停着时让它接着能用的按钮是黑色主按钮；换连接方式里「已连上」只用绿字；任务详情重新排。
test('Ken 10/27 11:43: on the in-use card, the one button that gets it working again is primary; “Test” on a working one stays plain',()=>{
 const res=between(app,'function connUseRes(r)','\nfunction ');
 for(const action of ['resumeAI','restoreSaved','appMissing'])for(const m of res.matchAll(new RegExp(`'${action}','',('[^']*')`,'g')))assert.equal(m[1],"'sm primary'",action);
 assert.match(res,/'resumeAI','','sm primary'/);assert.match(res,/'testConnection','','sm'\)/);
});
// 断言跟着 Ken 10/27 12:18 改：原来是绿字、浅绿底、前面一个小绿点（11:39），现在小绿点和底色都去掉，只用绿字。
test('Ken 10/27 12:18: “Connected” in the route dialog is plain green text, no dot and no background',()=>{
 const css=fs.readFileSync(path.join(P,'ui/h10/h10.css'),'utf8');
 assert.match(css,/#h10RouteDialog \.h10-route-chip \{[^}]*background:none;color:var\(--g-ink\)/);
 assert.doesNotMatch(css,/h10-route-chip::before|h10-route-chip::after/);
});
// 断言跟着 Ken 10/27 12:18 改：原来是「状态 → 结果 → 来源和用量 → 过程」几块各带小标题（11:39），Ken 说零碎、没有视觉中心。
// 现在最上面一张结果卡（状态、结果、你要做，进行中右边是「停止这个任务」），下面「来自」「开始」「用量」几行信息，再下面是过程；对话名只写一次。
test('Ken 10/27 12:18: task details open with one result card, then From / Started / Usage rows, then the timeline; the chat name is written once',async()=>{
 const {installUiTextContext}=await import('../support/ui-text-context.mjs');
 const box={E:x=>String(x??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])),loadChanges:()=>{},kind:()=>'ok',active:()=>false,changeCache:new Map(),btn:(name,action)=>`<button data-action="${action}">${name}</button>`,ibtn:(icon,name,action)=>`<button data-action="${action}">${name}</button>`,refreshToolsFigure:()=>'',when:()=>'今天 11:50',valueTaskDetail:()=>'USAGE',statusWords:()=>'成功完成',outputsOf:()=>[],stallRecords:()=>'',tl:()=>'<ol>TIMELINE</ol>',Map};
 vm.createContext(box);installUiTextContext(box);
 for(const [a,b] of [['function isRefreshTask','function taskGroups'],['function conversationLink','function statusWords'],['function refreshTaskNeedsManual','/* 1027：停住记录']])vm.runInContext(between(app,a,b),box);
 const render=(t,over={})=>vm.runInContext('pgTask(t)',Object.assign(box,{t},over));
 const linked={task_id:'t1',status:'completed',created_at:1,summary:'周报写好了。',user_action:'不用做什么。',group:{id:'g1',title:'周报对话',conversation_url:'https://chatgpt.com/c/x',link_source:'user_bound'}};
 const html=render(linked);
 const at=s=>{const i=html.indexOf(s);assert.ok(i>=0,s);return i;};
 assert.ok(html.startsWith('<div class="dp-res td-res ok" data-k="task-result"><svg class="i" aria-hidden="true"><use href="#i-check-circle"/></svg><div><b>成功完成</b><p class="td-sum">周报写好了。</p>'),'the result card comes first: green, status, then the result');
 assert.match(html,/<p class="td-ua none"><span>你要做<\/span>无需操作。<\/p>/,'nothing to do is written quietly');
 assert.ok(at('data-k="task-result"')<at('data-k="task-from"')&&at('data-k="task-from"')<at('data-k="task-started"')&&at('data-k="task-started"')<at('data-k="value-task-detail"')&&at('data-k="value-task-detail"')<at('TIMELINE'));
 assert.match(html,/<div class="kvr" data-k="task-from"><span class="k">来自<\/span><span class="v"><span class="td-v">对话「周报对话」<\/span><span class="td-acts"><button data-action="openChatURL">回到对话<\/button><button data-action="bindTask">更改关联<\/button><\/span><\/span><\/div>/);
 assert.match(html,/<div class="kvr" data-k="task-started"><span class="k">开始<\/span><span class="v"><span class="td-v">今天 11:50<\/span><\/span><\/div>/);
 assert.match(html,/<div class="kvr" data-k="value-task-detail"><span class="k">用量<\/span><span class="v"><span class="td-v">USAGE<\/span><\/span><\/div>/);
 assert.equal(html.split('周报对话').length-1,1,'the chat name is written once');
 assert.doesNotMatch(html,/原对话未关联|来源和用量|data-action="stopTask"|<h4>结果<\/h4>|td-meta/);
 // 进行中、没关联：灰卡、会呼吸的绿点，右边「停止这个任务」；「来自」写 ChatGPT，下面「关联原对话」
 const running=render({task_id:'t2',status:'active',created_at:1,group:null},{active:()=>true,taskState:()=>({dot:'ok live',label:'运行中',line:'上一步在 8 秒前'})});
 assert.ok(running.startsWith('<div class="dp-res td-res" data-k="task-result"><span class="td-dot"><i class="sdot ok live" aria-hidden="true"></i></span><div><b>运行中</b><small>上一步在 8 秒前</small></div><button data-action="stopTask">停止任务</button></div>'));
 assert.match(running,/<div class="kvr" data-k="task-from"><span class="k">来自<\/span><span class="v"><span class="td-v">ChatGPT<\/span><span class="td-acts"><button data-action="bindTask">关联原对话<\/button><\/span><\/span><\/div>/);
 // 没完成、自动关联的：橙卡，「你要做」那句加粗；对话名下面小字「自动关联」
 const failed=render({task_id:'t3',status:'failed',created_at:1,summary:'没找到文件夹。',user_action:'回到对话，告诉 ChatGPT 在哪。',group:{id:'g2',title:'整理照片',conversation_url:'https://chatgpt.com/c/y',link_source:'auto_detected'}},{active:()=>false,kind:()=>'fail',statusWords:()=>'没完成'});
 assert.ok(failed.startsWith('<div class="dp-res td-res warn" data-k="task-result"><svg class="i" aria-hidden="true"><use href="#i-bang-circle"/></svg><div><b>没完成</b><p class="td-sum">没找到文件夹。</p><p class="td-ua"><span>你要做</span>回到对话，告诉 ChatGPT 在哪。</p>'));
 assert.match(failed,/<span class="td-v">对话「整理照片」<small>自动关联<\/small><\/span><span class="td-acts">/);
 // 「回到对话」这些按钮一律在对话名下面，不随名字长短换位置
 const css=fs.readFileSync(path.join(P,'ui/style.css'),'utf8');
 assert.match(css,/\.td-facts \.kvr \.v\{display:flex;flex-direction:column;align-items:flex-start;/);
 // 后台默认的「无需操作。」和 ChatGPT 交回的「不用做什么。」一律显示成 noAction，英文界面换成英文
 assert.match(app,/ua==='无需操作。'\|\|ua==='不用做什么。'\?T\("ui\.window\.taskInfo\.noAction"\):ua/);
 for(const [k,z,e] of [['from','来自','From'],['started','开始','Started'],['usage','用量','Usage'],['noAction','无需操作。','Nothing to do.']]){assert.equal(zh['ui.window.taskInfo.'+k],z);assert.equal(en['ui.window.taskInfo.'+k],e);}
 for(const k of ['ui.window.taskInfo.title','ui.window.pgTask.text5','ui.window.pgTask.text7'])for(const L of [zh,en])assert.equal(L[k],undefined,k);
});
