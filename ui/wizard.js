'use strict';
(()=>{
 // 0011（Claude）：手动向导换成跟 Site 那套（H10）一样的样子：同一个页头、同一种卡片和按钮，内容区离页头固定 48 点。
 // 后台还是 0..6 七步（/api/setup/progress 不变），窗口上只给四段：创建通道（0 通道、1 密钥）、添加到 ChatGPT（2）、测试连接（3）、完成（6）。
 // 原来的 4「权限」、5「开通」不再单独成页、不再拦人：范围和「用到时再开」都放进完成页，停在 4、5 的（旧版本做到一半）直接记成配完。
 // 每一张只讲一张截图、一件事：左边截图，右边这一步怎么做和要用到的按钮，「继续」翻到下一张，翻完这一段再进下一段。
 const tx=(key,params)=>window.ChatHandText.t(key,params);
 const stageKeys=["ui.wizard.createTunnel","ui.wizard.addToChatGPT","ui.wizard.testConnection","ui.wizard.complete"];
 let labels=stageKeys.map(key=>tx(key));
 const stageOf=s=>s<=1?0:s===2?1:s===3?2:3;
 const ids=['s-tunnel','s-key','s-add','s-test'];
 let tutorial=null,step=0,sub=0,opened=false,autoOpened=false,tunnel='',last4='',lastStatus='',busy=false,actionGeneration=0,selectedTier='full',openStatus='',browserGuide=false;
 function resolvePasteRuntimeKeyResponse(r){
  if(r?.error)return {error:r.error.message||r.error};
  if(r?.saved===true)return {saved:true,last4:typeof r.last4==='string'?r.last4:''};
  const messages={
   CLIPBOARD_KEY_INVALID:window.ChatHandText.t("ui.wizard.clipboardKeyInvalid"),
   EXPLICIT_PASTE_REQUIRED:window.ChatHandText.t("ui.wizard.pasteRequired"),
   CREDENTIAL_STORE_CORRUPT:window.ChatHandText.t("ui.wizard.credentialStoreUnreadable"),
   CREDENTIAL_WRITE_VERIFY_FAILED:window.ChatHandText.t("ui.wizard.keyWriteFailed"),
   KEY_INVALID:window.ChatHandText.t("ui.wizard.keyInvalid"),
   TUNNEL_ID_INVALID:window.ChatHandText.t("ui.wizard.tunnelInvalid"),
   TUNNEL_NOT_FOUND:window.ChatHandText.t("ui.wizard.tunnelNotFound"),
   SETUP_KEY_FAILED:window.ChatHandText.t("ui.wizard.setupKeyFailed")
  };
  return {saved:false,error:messages[r?.error_code]||window.ChatHandText.t("ui.wizard.saveKeyFailed")};
 }
 let watch={active:false,received:false,last4:null,request:null,startedAt:0,error:'',starting:false},watchPoll=0,watchStart=null,watchTunnel='',watchGeneration=0,watchOwner=false;
 // Repaint callbacks may replay a key-watch projection already consumed before local progress.
 let watchSnapshot=null;
 function watchState(){return {...watch,elapsedMs:watch.startedAt?Math.max(0,Date.now()-watch.startedAt):0};}
 function notifyWatch(){if(opened)updateStatus();}
 function stopWatchPoll(){if(watchPoll)clearInterval(watchPoll);watchPoll=0;}
 function watchPolling(){if(watchOwner&&watch.active&&!watchPoll)watchPoll=setInterval(()=>{const generation=watchGeneration;if(window.ChatHandStream?.status?.()!=='live')void watchStatus().catch(error=>{if(!watchOwner||generation!==watchGeneration)return;watch.error=userMessage(error,window.ChatHandText.t("ui.wizard.watchInterrupted"));notifyWatch();});},3000);if(!watchOwner||!watch.active)stopWatchPoll();}
 function syncKeyWatch(state){const key=state.setup?.key_watch,bound=state.settings?.setup_tunnel_id||state.settings?.tunnel?.tunnel_id||state.connection?.tunnel_id;if(!watchOwner||!key||bound&&bound!==watchTunnel||key===watchSnapshot)return;watchSnapshot=key;watch.active=key.active===true;watch.received=key.received===true;watch.last4=watch.received&&typeof key.last4==='string'?key.last4.slice(-4):null;if(watch.received){watch.error='';watch.request=null;}watchPolling();}
 async function watchStatus(generation=watchGeneration,id=watchTunnel){const value=await api('/api/setup/await-key/status',{});if(!watchOwner||generation!==watchGeneration||id!==watchTunnel)return value;if(value.request&&value.request.tunnel_id!==id||watch.received&&!value.received)return value;watch={...watch,...value,last4:value.received&&typeof value.last4==='string'?value.last4.slice(-4):null};if(value.request)watch.startedAt=value.request.expires_at-600000;watchPolling();notifyWatch();if(value.received&&window.ChatHandStream?.status?.()!=='live'&&watchOwner&&generation===watchGeneration)await refresh();return value;}
 window.ChatHandKeyWatch={
  state:watchState,
  start(tunnel){
   if(watchOwner&&watchTunnel===tunnel){if(watchStart)return watchStart;if(watch.active||watch.received)return Promise.resolve(watchState());}
   const generation=++watchGeneration;last4='';watchOwner=true;watchTunnel=tunnel;stopWatchPoll();watch={active:false,received:false,last4:null,request:null,startedAt:Date.now(),error:'',starting:true};
   watchSnapshot=S?.setup?.key_watch??null;
   const current=()=>watchOwner&&generation===watchGeneration&&watchTunnel===tunnel;
   const pending=(async()=>{try{let existing=null;if(S.setup?.key_watch?.active)existing=await watchStatus(generation,tunnel);if(!current())return watchState();if(!existing?.active||existing.request?.tunnel_id!==tunnel){const value=await api('/api/setup/await-key',{tunnel_id:tunnel});if(!current())return watchState();watch={...watch,...value};await watchStatus(generation,tunnel);}}catch(error){if(current()){watch.active=false;watch.error=userMessage(error,window.ChatHandText.t("ui.wizard.startWatchFailed"));}}finally{if(current()){watch.starting=false;watchPolling();notifyWatch();}if(watchStart===pending)watchStart=null;}return watchState();})();watchStart=pending;return pending;
  },
  async cancel(){
   const tunnel=watchTunnel,request=watch.request,received=watch.received,active=watch.active,pending=watchStart,generation=++watchGeneration;watchOwner=false;stopWatchPoll();watch.active=false;watch.starting=false;watch.request=null;
   if(received||!active&&!pending)return;
   try{if(pending)await pending;let previous=request;if(!previous&&generation===watchGeneration){const value=await api('/api/setup/await-key/status',{});if(value.received||value.request?.tunnel_id!==tunnel)return;previous=value.request;}if(previous?.id)await api('/api/setup/await-key/cancel',{id:previous.id});}catch(error){if(generation===watchGeneration)watch.error=userMessage(error,window.ChatHandText.t("ui.wizard.cancelWatchFailed"));}
  }
 };
 // holdAdvance：用户在这一段里往回翻过，就不再自动往下走，直到他自己翻回最后一张或者换段。keyWas：上一次看时密钥收到没有，只在刚收到的那一下翻到最后一张。
 let advanceTimer=0,advanceFrom=-1,holdAdvance=false,keyWas=false;
 // 1081（Claude）：adding：配好过（在用 Site，或以前配过）再来加这条通道，测过以后不进完成页，回到「ChatGPT 连接」。
 // 测试那一页：testSentAt 点「去 ChatGPT 发这句话」或「复制」的时间，过 60 秒还没收到才给帮助；testRenewed 发过的那句过期、已经自己换了新的；
 // readSeenAt ChatGPT 连到这台 Mac、还没改东西的那一刻，过 15 秒还没改才提示去点「允许」。
 let adding=false,testSentAt=0,testRenewed=false,renewingTest=false,renewTriedAt=0,readSeenAt=0;
 function stopAdvance(){if(advanceTimer)clearTimeout(advanceTimer);advanceTimer=0;advanceFrom=-1;}
 // 1081（Claude，ChatGPT 复查 D01）：这个向导只配 OpenAI 通道。已经在用 Site 时，Site 连着、Site 测过，都不算这条通道连上、测过。
 // openaiLive/tunnelText 在 app.js 里；测试单独跑这个文件时没有它们，就退回原来的 connected/connectionText。
 function testVerified(){return S.setup_test?.verified===true&&S.setup_test.route!=='site';}
 const linkedTunnel=()=>typeof openaiLive==='function'?openaiLive():typeof connected==='function'&&connected();
 const tunnelLine=()=>typeof tunnelText==='function'?tunnelText():connectionText();
 // 1081（Claude）：「加到 ChatGPT」那一段，进来以后 ChatGPT 经 OpenAI 通道来拿过工具清单（setup.openai_seen_at，后台记的），就是加好了，自己往下走。
 let addPageAt=0;
 function advanceReady(){return step===1?linkedTunnel():step===2?Number(S.setup?.openai_seen_at)>addPageAt&&linkedTunnel():step===3?testVerified():false;}
 function autoAdvance(){if(!opened||busy||holdAdvance||!advanceReady()){stopAdvance();return;}if(advanceTimer&&advanceFrom===step)return;stopAdvance();advanceFrom=step;advanceTimer=setTimeout(async()=>{advanceTimer=0;if(!opened||busy||holdAdvance||step!==advanceFrom||!advanceReady())return;busy=true;try{await move(nextStep(step));}catch(error){const msg=box.querySelector('#wizardError');if(msg)msg.textContent=userMessage(error,window.ChatHandText.t("ui.wizard.nextStepFailed"));}finally{busy=false;if(opened)updateStatus();}},1200);}
 function enterStep(){if(step===2)addPageAt=Date.now();if(step===1&&!S.credentials?.tunnel)void window.ChatHandKeyWatch.start(tunnel);}
 function keyHTML(){const w=watchState(),linked=linkedTunnel(),own=watchOwner&&watchTunnel===tunnel,stored=S.credentials?.tunnel&&(S.setup?.key_watch?.received||!!last4),received=own?w.received||!!last4:stored,suffix=own?w.last4||last4:S.setup?.key_watch?.last4||last4;const text=linked?window.ChatHandText.t("ui.wizard.connectedMark"):received?window.ChatHandText.t("ui.wizard.keyReceivedConnecting", {last4: E(typeof suffix==='string'?suffix.slice(-4):'')}):w.error?window.ChatHandText.t("ui.wizard.pasteKeyPrompt"):w.active||w.starting?window.ChatHandText.t("ui.wizard.copyPlatformKey"):window.ChatHandText.t("ui.wizard.keyWaitExpired");return `<strong class="${linked||received?'good':''}">${!linked&&!received&&!w.error&&(w.active||w.starting)?'<span class="key-breath" aria-hidden="true"></span>':''}${text}</strong>${linked||received?'':w.error?`<p class="attention">${E(w.error)}</p><p>${E(window.ChatHandText.t("ui.wizard.keyStorageExplanation"))}</p>`:w.active||w.starting?`<p>${E(window.ChatHandText.t("ui.wizard.pasteConsentAlternative"))}</p>`:`${button(window.ChatHandText.t("ui.wizard.awaitKeyAgain"),'awaitKey')}<p>${E(window.ChatHandText.t("ui.wizard.pasteAlternative"))}</p>`}`;}
 const box=document.createElement('section');box.id='setupWizard';box.hidden=true;box.setAttribute('aria-label',window.ChatHandText.t("ui.wizard.accessibleTitle"));document.body.append(box);
 const zoom=document.createElement('dialog');zoom.className='tutorialZoom';document.body.append(zoom);
 {let down=false;const out=e=>{if(e.target!==zoom)return false;const r=zoom.getBoundingClientRect();return e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom;};zoom.addEventListener('pointerdown',e=>{down=out(e);});zoom.addEventListener('click',e=>{if(down&&out(e))zoom.close();down=false;});}
 // 0011：按钮一律用 H10 的样子（h10-button），主按钮加 h10-button-primary。第三个参数可以是 true（禁用），也可以是选项。
 const button=(text,action,options=false)=>{const o=options===true?{disabled:true}:options||{};return `<button type="button" class="h10-button${o.primary?' h10-button-primary':''}${o.cls?' '+o.cls:''}" data-wizard="${action}"${o.id?` id="${o.id}"`:''}${o.label?` aria-label="${E(o.label)}"`:''}${o.disabled?' disabled':''}>${E(text)}</button>`;};
 // 0010（Claude）：测试那句话点名这台 Mac 在 ChatGPT 里的那个应用。账号里有好几个 ChatHand（共用账号、或者旧的新的都在）时，
 // 只说「用 ChatHand」，ChatGPT 会挑错，测到别的电脑上去，这台就一直等不到（Mac mini 1062 实测）。
 // 名字由后台给（settings.chatgpt_app_name；新配时给建议名 chatgpt_app_name_suggested，教程就让用户填这个），不知道就照旧说 ChatHand。
 const cleanAppName=v=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,60):'';
 const appName=()=>cleanAppName(S.settings?.chatgpt_app_name);
 const tutorialApp=()=>appName()||cleanAppName(S.settings?.chatgpt_app_name_suggested)||'ChatHand';
 const prompt=()=>appName()?window.ChatHandText.t("ui.setup.connectionTestPromptNamed", {app: appName(), nonce: S.setup_test?.nonce||''}):window.ChatHandText.t("ui.setup.connectionTestPrompt", {nonce: S.setup_test?.nonce||''}); // 1081（Claude）：跟帮我配、设置助手用同一句，末尾让 ChatGPT 只回「连好了，回到 ChatHand 就行」
 window.startWizard=async({restart=false,initialStep=null}={})=>{adding=S.settings?.setup_ever_complete===true||S.settings?.setup_complete===true;testSentAt=0;testRenewed=false;readSeenAt=0;if(restart){await api('/api/setup/progress',{step:0,restart:true});S.setup_test={status:'not_started',verified:false};S.settings.setup_step=0;S.settings.setup_complete=false;}if(!tutorial)tutorial=await (await fetch('/assets/tutorial/tutorial.json')).json();step=initialStep??(restart?0:Math.min(6,Number(S.settings.setup_step||0)));tunnel=S.settings.setup_tunnel_id||S.settings.tunnel?.tunnel_id||'';last4=S.settings.setup_key_last4||'';selectedTier=shownTier();opened=true;box.hidden=false;document.querySelector('#app').inert=true;sub=0;holdAdvance=false;keyWas=false;
  // 0011：原来的第 4 步「权限」、第 5 步「开通」并进完成页，不再拦人。停在 4、5 的（旧版本做到一半）直接记成配完。
  if(step===4||step===5)await finishSetup();
  if(step===3&&!testVerified()&&(!S.setup_test?.nonce||S.setup_test.expired))S.setup_test=await api('/api/setup/test/start',{});if(step===6&&!adding&&await showSharedCompletion())return;draw();enterStep();};
 async function finishSetup(){try{await api('/api/setup/progress',{step:6,...(validTunnel()?{tunnel_id:tunnel.trim()}:{})});step=6;S.settings.setup_step=6;S.settings.setup_complete=true;}catch(error){if(error?.code==='SETUP_TEST_REQUIRED'){step=3;sub=0;if(!S.setup_test?.nonce||S.setup_test.expired)S.setup_test=await api('/api/setup/test/start',{});}else step=6;}}
 // 1052（Claude）：开机自动打开哪个设置页。wizardRefresh 和 h10/host.mjs 开机时都用它。
 // 返回 null：不进 H10，按原来的旧向导/设置助手判断。
 window.h10Entry=state=>{
  const s=state||{},settings=s.settings||{},b=s.site_b||{},step=settings.setup_step;
  if(settings.setup_complete===true)return null;
  if(b.routes?.openai?.configured===true||s.credentials?.tunnel===true||settings.tunnel||['tunnel','relay'].includes(settings.connection_preference))return null;
  if(Number.isInteger(step)&&step>=1&&step<=5)return null;
  // Site 已配对、还没配完：直接到「在 ChatGPT 里连上」。
  if(b.routes?.site?.configured===true)return {route:'site',screen:'f12'};
  // 选过「帮我配」、配置助手已经装好：回到帮我配的进度（F7），不再让人选一次。
  // 1066 第 77 条（Claude）：原来回到旧设置助手那一页（10 月初的样子、步骤是 OpenAI 通道那五步），走 Site 也是它。
  // 一句话安装就是这条：AI 装好 ChatHand 和配置助手再打开窗口。
  // 走哪条路不看 selected（新装默认就是 openai）。1083（Claude，Ken 10/28 21:38）：没选过默认 OpenAI 通道（配置助手也是），原来是 ChatGPT Site；
  // 只有配置助手已经开过 Site 配对（setup_site_select_on_pair，或者正在配对）才是 Site。打开以后 F7 还会照实际进展再对一次。
  const setupRoute=['site','openai'].includes(s.setup_route)?s.setup_route:settings.setup_site_select_on_pair===true||['pairing','awaiting_pairing'].includes(b.pairing?.phase)?'site':'openai';
  if(s.setup_skill?.installed===true)return {route:setupRoute,screen:'f7',assisted:true};
  return {route:setupRoute,screen:'f6'};
 };
 window.wizardRefresh=state=>{
  syncKeyWatch(state);
  if(!autoOpened){
   // 1052（Claude）：进不进第三版引导（H10）看 window.h10Entry，不看 selected——C1 以后新装默认选 openai，Site 配好才切过去。
   // 已经在用 OpenAI 通道、旧向导做到一半的，照旧走下面原来的判断。
   const entry=window.h10Entry(state);
   if(entry?.route){autoOpened=true;window.startH10?.(entry);}
   else{
    const settings=state.settings||{},unfinished=settings.setup_complete!==true,resume=unfinished&&Number.isInteger(settings.setup_step)&&settings.setup_step>=0&&settings.setup_step<=5&&state.site_b?.routes?.site?.configured!==true;
    // 配过 Site 的不再弹 OpenAI 通道的设置助手。
    const choose=!resume&&!settings.tunnel&&state.credentials?.tunnel!==true&&state.site_b?.routes?.site?.configured!==true;
    if(resume&&typeof window.startWizard==='function'){autoOpened=true;void window.startWizard();}
    // 1066 第 77 条（Claude）：OpenAI 通道还没配好的，也进第三版引导：配置助手装好了到 F7，没装到 F6 先选帮我配还是自己配。
    else if(choose&&typeof window.startH10==='function'){autoOpened=true;window.startH10(state.setup_skill?.installed===true&&!connected()?{route:'openai',screen:'f7',assisted:true}:{route:'openai'});}
    else if(!resume&&!choose)autoOpened=true;
   }
  }
  if(!opened)return;const key=JSON.stringify([state.connection?.ready,state.connection?.automatic,state.setup_test,state.permissions,state.setup,state.credentials,state.automation?.browser?.extension?.connected,state.automation?.computer?.permissions]);if(lastStatus!==key){lastStatus=key;updateStatus();}
 };
 // 0011：测试过了直接到完成页（后台第 6 步）；「上一步」退回上一段时停在那一段的最后一张。
 const nextStep=s=>s===3?6:s+1;
 async function move(next,{toEnd=false}={}){stopAdvance();if(step===1&&next!==1)await window.ChatHandKeyWatch.cancel();try{await api('/api/setup/progress',{step:next,tunnel_id:tunnel,app_name:tutorialApp()});}catch(error){if(error.code!=='SETUP_TEST_REQUIRED')throw error;await api('/api/setup/progress',{step:3,tunnel_id:tunnel});S.setup_test=await api('/api/setup/test/start',{});step=3;sub=0;holdAdvance=false;draw();enterStep();const message=box.querySelector('#wizardError');if(message)message.textContent=tx("ui.wizard.testResultMissing");return;}step=next;holdAdvance=false;testSentAt=0;testRenewed=false;readSeenAt=0;sub=toEnd?pageCount(next)-1:0;if(step>=4){selectedTier=shownTier();S.settings.setup_step=step;S.settings.setup_complete=step===6;}if(step===3&&!testVerified()&&(!S.setup_test?.nonce||S.setup_test.expired)){S.setup_test=await api('/api/setup/test/start',{});}if(step===6&&adding){await closeWizard();window.openDrawer?.('conn');toast(tx("ui.wizard.channelAdded"));return;}if(step===6&&typeof showSharedCompletion==='function'&&await showSharedCompletion())return;draw();enterStep();}
 const lineIcon=(name)=>{const paths={check:'<path d="M4 8.5l3 3 6-7"/>',minus:'<path d="M4 8h8"/>',shield:'<path d="M8 2l5 2v4c0 3-2 5-5 6-3-1-5-3-5-6V4z"/>',desktop:'<rect x="2" y="3" width="12" height="8" rx="1.5"/><path d="M5 14h6M8 11v3"/>',folder:'<path d="M2 5h5l2 2h5v6H2zM2 5V3h5l2 2"/>',admin:'<circle cx="5" cy="11" r="3"/><path d="M7 9l7-7M11 5l2 2"/>',browser:'<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c3 3 3 9 0 12M8 2c-3 3-3 9 0 12"/>'};return `<svg viewBox="0 0 16 16" aria-hidden="true">${paths[name]||paths.desktop}</svg>`;};
 function setupItems(){return window.setupItems?.()||(S.setup?.open_items||[]).map(i=>({...i,done:i.status==='done',blocking:!['done','cancelled'].includes(i.status)}));}
 // 应用店装法看 distribution，不看 store_url：配置没配好时 store_url 是空的，也不能退回旧装法的说明（Codex 10/26 复查）
 const browserStore=()=>S.automation?.browser?.extension?.distribution==='chrome_web_store';
 const browserPending=()=>browserStore()&&S.automation.browser.extension.configuration_state==='pending';
 function openItemsHTML(items){return items.map(item=>{const {id,status,detail={}}=item,done=status==='done',titles={admin:window.ChatHandText.t("ui.wizard.softwareAndSettings"),desktop:window.ChatHandText.t("ui.wizard.desktopControl"),browser:window.ChatHandText.t("ui.wizard.browserControl"),folder:window.ChatHandText.t("ui.wizard.chooseFolder")},descriptions={admin:window.ChatHandText.t("ui.wizard.adminPasswordExplanation"),desktop:window.ChatHandText.t("ui.wizard.desktopPermissionsExplanation"),browser:browserPending()?window.ChatHandText.t("ui.chrome.store.resPending"):detail.installed&&!detail.connected&&!browserStore()?window.ChatHandText.t("ui.wizard.browserAwaitChrome"):browserStore()?window.ChatHandText.t("ui.wizard.browserStoreExplanation"):window.ChatHandText.t("ui.wizard.browserExtensionExplanation"),folder:window.ChatHandText.t("ui.wizard.folderScopeExplanation")},label=status==='needs_restart'?window.ChatHandText.t("ui.wizard.restart"):status==='cancelled'?window.ChatHandText.t("ui.wizard.retry"):id==='folder'?window.ChatHandText.t("ui.wizard.useFolder"):id==='browser'?browserStore()?window.ChatHandText.t("ui.wizard.addToChrome"):detail.installed&&!detail.connected?window.ChatHandText.t("ui.wizard.reconnect"):window.ChatHandText.t("ui.wizard.install"):window.ChatHandText.t("ui.wizard.open");const state=done?`<span class="open-done">${lineIcon('check')}${E(id==='folder'?window.ChatHandText.t("ui.wizard.folderSelected"):id==='browser'?window.ChatHandText.t(detail.connected===false?"ui.wizard.browserInstalled":"ui.wizard.connected"):window.ChatHandText.t("ui.wizard.opened"))}</span>`:status==='waiting'?`<span class="open-wait"><span class="spinner" aria-hidden="true"></span>${E(window.ChatHandText.t("ui.wizard.awaitConsent"))}</span>`:`${status==='cancelled'?`<span class="open-cancelled">${E(window.ChatHandText.t("ui.wizard.cancelled"))}</span>`:''}<button type="button" class="h10-button" data-wizard="openItem" data-item="${E(id)}">${label}</button>${id==='folder'?`<button type="button" class="h10-link" data-wizard="chooseWorkspace">${E(window.ChatHandText.t("ui.wizard.chooseAnother"))}</button>`:''}`;return `<section class="open-item ${done?'done':''}" data-open-item="${E(id)}"><div class="open-row"><span class="open-icon">${lineIcon(id)}</span><div class="open-text"><b>${E(titles[id]||id)}</b><p>${E(descriptions[id]||'')}</p>${id==='desktop'?`<div class="open-badges"><span class="${detail.accessibility?'good':'attention'}">${E(window.ChatHandText.t("ui.wizard.accessibilityStatus", {mark: detail.accessibility?'✓':'○'}))}</span><span class="${detail.screen_recording?'good':'attention'}">${E(window.ChatHandText.t("ui.wizard.recordingStatus", {mark: detail.screen_recording?'✓':'○'}))}</span></div>`:''}${status==='needs_restart'?`<p class="attention">${E(window.ChatHandText.t("ui.wizard.restartPermissionHint"))}</p>`:''}${id==='folder'&&detail.folder?`<span class="open-path" title="${E(detail.folder)}">${E(shortPath(detail.folder))}</span>`:''}</div><div class="open-actions">${state}</div></div>${id==='browser'&&!browserStore()?`<details class="browser-guide" ${browserGuide?'open':''}><summary>${E(window.ChatHandText.t("ui.wizard.extensionInstallHelp"))}</summary><ol><li>${E(window.ChatHandText.t("ui.wizard.extensionInstallFirst"))}</li><li>${E(window.ChatHandText.t("ui.wizard.extensionInstallDeveloperMode"))}</li><li>${E(window.ChatHandText.t("ui.wizard.extensionInstallLoadUnpacked"))}</li></ol><div class="extension-guide" aria-label="${E(window.ChatHandText.t("ui.wizard.extensionInstallDiagram"))}"><span>${E(window.ChatHandText.t("ui.wizard.extensions"))}</span><span>${E(window.ChatHandText.t("ui.wizard.developerModeOff"))}</span><strong>${E(window.ChatHandText.t("ui.wizard.loadUnpacked"))}</strong><small>${E(window.ChatHandText.t("ui.wizard.extensionSelectFolder"))}</small></div>${button(window.ChatHandText.t("ui.wizard.openExtensionFolder"),'extension')}${button(window.ChatHandText.t("ui.wizard.openChromeExtensions"),'extensions')}</details>`:''}</section>`;}).join('');}
 function fitOpenPaths(){for(const el of box.querySelectorAll('.open-path')){const parts=Array.from(el.title),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d'),style=getComputedStyle(el);ctx.font=style.font;let keep=parts.length,text=parts.join('');while(ctx.measureText(text).width>el.clientWidth&&keep>2){keep--;const left=Math.ceil(keep*.45);text=parts.slice(0,left).join('')+'…'+parts.slice(-(keep-left)).join('');}el.textContent=text;}}
 function shortPath(path){return path.length>52?path.slice(0,23)+'…'+path.slice(-26):path;}
 const tutorialText = item => window.ChatHandText.t(item.textKey, {app: tutorialApp()});
 const shownTier=()=>S.permissions?.tier==='light'?'light':'full';
 // 每一段有几张：0..2 跟教程里的小步骤一样多，测试和完成各一张。
 const pageCount=s=>s>=3?1:Math.max(1,(tutorial?.steps?.[ids[s]]?.subs||[]).length);
 const checkSVG='<svg class="h10-source-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg>';
 // 1069 第 3 条（Claude）：完成页的大对勾跟 H10 一样，实心绿底白勾（样式在 h10.css 的 .h10-done-mark）。
 const doneMarkSVG='<svg class="h10-done-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><circle cx="32" cy="32" r="32"/><path pathLength="1" d="m20 33 8 8 16-17"/></svg>';
 function keyReceived(){const w=watchState();return watchOwner&&watchTunnel===tunnel?w.received||!!last4:!!(S.credentials?.tunnel&&(S.setup?.key_watch?.received||last4));}
 function headerHTML(){const current=stageOf(step),finished=step===6;return `<header class="h10-header"><div class="h10-brand"><img src="/assets/app/AppIcon-rounded-512.png" alt="" width="40" height="40"><div><strong>ChatHand</strong><small>${E(tx("ui.wizard.firstSetup"))}</small></div></div><ol class="h10-stepper wiz-stepper" aria-label="${E(tx("ui.wizard.firstSetup"))}">${labels.map((label,i)=>{const state=finished||i<current?'done':i===current?'current':'todo';return `<li class="setup-step${i===current?' current':''}" data-state="${state}"${i===current?' aria-current="step"':''}><span class="h10-step-num">${state==='done'?checkSVG:i+1}</span>${E(label)}</li>`;}).join('')}</ol><div class="h10-header-end">${button(finished?tx("ui.wizard.close"):tx("ui.wizard.resumeLater"),'close',{cls:'setup-later'})}</div></header>`;}
 const external=action=>action?`<button type="button" class="h10-button" data-action="external" data-id="${E(action.href)}">${E(tutorialText(action))} ↗</button>`:'';
 const fold=(summary,html)=>`<details class="wiz-fold"><summary>${E(summary)}</summary><div class="wiz-fold-body">${html}</div></details>`;
 const status=()=>`<p id="wizardConnection" class="wiz-conn" role="status" data-state="wait"></p>`;
 function copyField(label,value,action,actionLabel){return `<div class="wiz-field"><span class="wiz-field-label">${E(label)}</span><code title="${E(value)}">${E(value)}</code>${button(tx("ui.wizard.copy"),action,{label:actionLabel})}</div>`;}
 const suggestedModel=()=>typeof S.setup?.device_model==='string'&&S.setup.device_model.trim()?S.setup.device_model:'Mac';
 const suggestedTunnelName=()=>tx("ui.wizard.tutorial.tunnel.suggestedName",{model:suggestedModel()});
 const suggestedTunnelDescription=()=>tx("ui.wizard.tutorial.tunnel.suggestedDescription");
 const suggestedRuntimeKeyName=()=>tx("ui.wizard.tutorial.key.suggestedName",{model:suggestedModel()});
 function suggestionField(label,value,action,actionLabel){return `<div class="wiz-suggestion"><span class="wiz-suggestion-label">${E(label)}</span><div class="wiz-suggestion-box"><span>${E(value)}</span><button type="button" class="wiz-copy-icon" data-wizard="${action}" aria-label="${E(actionLabel)}" title="${E(actionLabel)}"><svg class="i" aria-hidden="true" focusable="false"><use href="#i-copy"></use></svg></button></div></div>`;}
 // 这一张右边除了说明以外要放的东西（按钮、输入框、收密钥的框、折起来的帮助）。
 function extrasHTML(t,page,last){
  const action=(t.actions||[])[0];
  switch(step){
   case 0:
    if(page===0)return `<div class="wiz-actions">${external(action)}</div>${fold(tx("ui.wizard.accountEligibility"),`<p>${E(tutorialText(tutorial.steps['s-devmode'].lead))}</p>${tutorial.steps['s-devmode'].subs.map(s=>`<p>${E(tutorialText(s))}</p>`).join('')}`)}`;
    if(t.subs?.[page]?.textKey==='ui.wizard.tutorial.tunnel.fillTunnelDetails')return `<div class="wiz-suggestions">${suggestionField('Name',suggestedTunnelName(),'copySuggestedTunnelName',tx("ui.wizard.copyName"))}${suggestionField('Description',suggestedTunnelDescription(),'copySuggestedTunnelDescription',tx("ui.wizard.tutorial.tunnel.copyDescription"))}</div>`;
    if(t.subs?.[page]?.textKey==='ui.wizard.tutorial.tunnel.selectWorkspace')return `<p class="wiz-note">${E(tx("ui.wizard.tutorial.tunnel.oneWorkspaceHint"))}</p>`;
    if(last)return `<div class="wiz-input"><label for="wizardTunnel">${E(tx("ui.wizard.tunnelId"))}</label><div class="tunnel-entry"><input id="wizardTunnel" autocomplete="off" spellcheck="false" aria-describedby="wizardTunnelHint" placeholder="tunnel_…" value="${E(tunnel)}"><span id="wizardTunnelCheck" class="wiz-ok" hidden aria-label="${E(tx("ui.wizard.tunnelIdValid"))}">${checkSVG}</span></div><small id="wizardTunnelHint" class="wiz-attention" hidden>${E(tx("ui.wizard.tunnelIdInvalid"))}</small></div>`;
    return '';
   case 1:
    if(page===0)return `<div class="wiz-actions">${external(action)}</div>`;
    if(page===1&&t.note)return `<p class="wiz-note">${E(tutorialText(t.note))}</p><div class="wiz-suggestions">${suggestionField('Name',suggestedRuntimeKeyName(),'copySuggestedRuntimeKeyName',tx("ui.wizard.copyName"))}</div>`;
    if(last)return `<div class="key-slot" tabindex="0" role="button" aria-label="${E(tx("ui.wizard.pasteRuntimeKeyLabel"))}" aria-live="polite">${keyHTML()}</div>${status()}${connectionHelp()}`;
    return '';
   case 2:{
    let html='';
    if(page===0)html=`<div class="wiz-actions">${external(action)}</div>${fold(tx("ui.wizard.noCreateOption"),`<p>${E(tutorialText(tutorial.steps['s-devmode'].subs.find(s=>s.info)||{textKey:'ui.wizard.tutorial.devmode.enableDeveloperMode'}))}</p><p>${E(tx("ui.wizard.developerModeWebOnly"))}</p>`)}`;
    if(page===1)html=`<div class="wiz-fields">${copyField(tx("ui.wizard.name"),tutorialApp(),'copyName',tx("ui.wizard.copyName"))}${copyField(tx("ui.wizard.tunnelId"),tunnel,'copyTunnel',tx("ui.wizard.copyTunnelId"))}<div class="wiz-field"><span class="wiz-field-label">${E(tx("ui.wizard.pluginIcon"))}</span><span class="wiz-field-note">${E(tx("ui.wizard.pluginIconNote"))}</span>${button(tx("ui.wizard.showIcon"),'revealIcon')}</div></div>`;
    if(page===2&&t.trouble)html=fold(tx("ui.wizard.creationHelp"),`<p>${E(tutorialText(t.trouble))}</p><img class="trouble-shot" src="/assets/tutorial/${E(t.trouble.shot)}.png" alt="${E(tx("ui.wizard.creationFailureAlt"))}">`);
    return (page>=2?html+status():html)+`<p class="wiz-quiet"><button type="button" class="h10-link" data-wizard="alreadyAdded">${E(tx("ui.wizard.alreadyAdded"))}</button></p>`;}
   case 3:return `<div class="test-prompt"><p>${E(prompt())}</p>${button(tx("ui.wizard.copy"),'copyTestText',{label:tx("ui.wizard.test.copyLabel")})}</div><div class="wiz-actions">${button(tx("ui.wizard.test.send"),'copyTest',{primary:true})}</div><div id="wizardTest" class="wiz-test" role="status" aria-live="polite"></div><p class="wiz-quiet"><button type="button" class="h10-link" data-wizard="backToAdd">${E(tx("ui.wizard.test.backToAdd"))}</button></p>`;
  }
  return '';
 }
 function guideHTML(){
  const t=tutorial?.steps?.[ids[step]];if(!t)return '';
  const subs=t.subs||[],count=pageCount(step),page=Math.min(sub,count-1),last=page===count-1,item=subs[page]||subs[0]||{};
  const visual=item.shot?`<button type="button" class="tut-frame" data-wizard="zoom" aria-label="${E(tx("ui.wizard.zoomTutorial"))}"><span class="tut-clip"><img src="/assets/tutorial/${E(item.shot)}.png" alt="${E(tutorialText(item))}" draggable="false"></span><span class="zoom-hint">${E(tx("ui.wizard.zoomHint"))}</span></button>`:`<div class="tut-frame tut-empty"></div>`;
  const dots=count>1?`<div class="wiz-dots">${Array.from({length:count},(_,i)=>`<button type="button" data-sub="${i}" aria-label="${E(tx("ui.wizard.pageOf",{current:i+1,total:count}))}"${i===page?' aria-current="step"':''}></button>`).join('')}</div>`:'';
  // 1081（Claude）：拿密钥、加到 ChatGPT、试一句这三段，到了最后一张是等这边自己看到结果再往下走，不放「继续」；
  // 用户自己往回翻过（holdAdvance）、结果也已经有了，才放「继续」让他自己点。试一句那一段不放「上一步」，底下有「回到添加到 ChatGPT」。
  const autoStep=last&&step>=1&&step<=3,showNext=!autoStep||holdAdvance&&advanceReady();
  const back=step===3?'':step>0||page>0?button(tx("ui.wizard.previous"),'back'):'';
  const nav=back||showNext?`<div class="wiz-nav">${back}${showNext?button(tx("ui.wizard.continue"),'next',{primary:true,id:'wizardNext'}):''}</div>`:'';
  const below=dots;
  return `<div class="h10-heading wiz-heading"><h1>${E(tutorialText(t.title))}</h1><p>${E(tutorialText(t.lead))}</p></div><div class="h10-card wiz-card"><div class="wiz-visual">${visual}${below}</div><div class="wiz-panel">${count>1?`<p class="wiz-count">${E(tx("ui.wizard.pageOf",{current:page+1,total:count}))}</p>`:''}<p class="wiz-instruction">${E(tutorialText(item))}</p>${extrasHTML(t,page,last)}<p class="field-error" id="wizardError" role="alert"></p>${nav}</div></div>`;
 }
 function connectionHelp(){return fold(tx("ui.wizard.connectionHelp"),`<ol><li>${E(tx("ui.wizard.networkHelp"))}</li><li>${E(tx("ui.wizard.keyPermissionsHelp"))}</li><li>${E(tx("ui.wizard.clockHelp"))}</li></ol>${button(tx("ui.wizard.reconnect"),'connectAgain')}`);}
 // 完成页：跟 Site 那套的完成页一样。范围默认整台电脑，点了就改，不用再按「继续」；要系统确认的几项放在「用到时再开」，不拦人。
 function doneHTML(){
  const items=setupItems(),tier=selectedTier,intro=appName()?tx("ui.wizard.readyIntroductionNamed",{app:appName()}):tx("ui.h10.views.completionIntroduction",{app:'ChatHand'});
  const option=t=>`<div><label><input type="radio" name="wizard-tier" value="${t}" data-tier="${t}"${tier===t?' checked':''}>${E(t==='full'?tx("ui.wizard.computerScope"):tx("ui.wizard.folderScope"))}${t==='full'?` <span class="h10-badge">${E(tx("ui.wizard.recommended"))}</span>`:''}</label><p>${E(t==='full'?tx("ui.wizard.fullScopeExplanation"):tx("ui.wizard.lightScopeExplanation"))}</p></div>`;
  return `<div class="h10-complete-mark" aria-hidden="true">${doneMarkSVG}</div><div class="h10-heading"><h1>${E(tx("ui.h10.views.completionTitle"))}</h1><p>${E(intro)}</p></div><div class="h10-completion-cards"><fieldset class="h10-card h10-scope wiz-scope"><legend>${E(tx("ui.h10.views.scopeTitle"))}</legend><div class="h10-scope-options">${option('full')}${option('light')}</div></fieldset><section class="h10-card wiz-later"${items.length?'':' hidden'}><h3>${E(tx("ui.h10.views.optionalCapabilities"))}</h3><div id="wizardOpenItems" class="open-items">${openItemsHTML(items)}</div></section></div><p class="field-error" id="wizardError" role="alert"></p><footer class="h10-footer">${button(tx("ui.wizard.openChatGPT"),'finish',{primary:true})}</footer>`;
 }
 function draw(){box.dataset.step=String(step);box.dataset.wizPage=String(sub);openStatus='';box.innerHTML=`<section class="h10 h10-shell wiz" data-step="${step}">${headerHTML()}<main class="h10-main wiz-main${step===6?' h10-completion':''}">${step===6?doneHTML():guideHTML()}</main></section>`;updateStatus();fitShot();}
 function validTunnel(){return /^tunnel_[a-zA-Z0-9_-]{8,100}$/.test(tunnel.trim());}
 function updateStatus(){
  const count=pageCount(step),last=Math.min(sub,count-1)===count-1;
  if(step===0){const valid=validTunnel(),check=box.querySelector('#wizardTunnelCheck'),hint=box.querySelector('#wizardTunnelHint');if(check)check.hidden=!valid;if(hint)hint.hidden=!tunnel.trim()||valid;}
  // 密钥刚收到的那一下（不管停在哪一张），翻到最后一张给人看「已收到、正在连接」；之后用户往回翻，不再拉回来。
  if(step===1){const got=keyReceived(),fresh=got&&!keyWas;keyWas=got;if(fresh&&sub<count-1){sub=count-1;holdAdvance=false;draw();return;}const slot=box.querySelector('.key-slot');if(slot)slot.innerHTML=keyHTML();}
  if(step>=1&&step<=3&&last){const want=holdAdvance&&advanceReady();if(want!==!!box.querySelector('#wizardNext')){draw();return;}}
  const conn=box.querySelector('#wizardConnection');if(conn){const ok=linkedTunnel();conn.dataset.state=ok?'ok':'wait';conn.textContent=ok?tx("ui.wizard.tunnelConnected"):tunnelLine()||tx("ui.wizard.awaitTunnel");}
  const next=box.querySelector('#wizardNext');if(next)next.disabled=busy||last&&(step===0?!validTunnel():step===1||step===2?!linkedTunnel():step===3?!testVerified():false);
  const test=box.querySelector('#wizardTest');if(test){const t=S.setup_test?.route==='site'?{}:S.setup_test||{};const ok=t.verified===true;
   // 1081（Claude）：只一行状态。测试码过期了不让人点「重新测试」，自己换一个；发过旧的那句才说一声。
   if(!ok&&(t.expired===true||t.status==='expired')&&!renewingTest&&Date.now()-renewTriedAt>10000){renewingTest=true;renewTriedAt=Date.now();testRenewed=!!testSentAt;testSentAt=0;void api('/api/setup/test/start',{}).then(r=>{S.setup_test=r;if(opened&&step===3)draw();}).catch(()=>{}).finally(()=>{renewingTest=false;});}
   if(t.read&&!t.write&&!ok){if(!readSeenAt){readSeenAt=Date.now();setTimeout(()=>{if(opened)updateStatus();},15500);}}else readSeenAt=0;
   const slow=!!readSeenAt&&Date.now()-readSeenAt>=15000,lost=!ok&&!t.read&&!!testSentAt&&Date.now()-testSentAt>=60000,renewed=!ok&&!t.read&&testRenewed;
   const line=ok?tx("ui.wizard.test.passed"):t.read?(slow?tx("ui.wizard.test.needAllow"):tx("ui.wizard.test.reached")):renewed?tx("ui.wizard.test.renewed"):tx("ui.wizard.test.waiting");
   // 1081（Claude，Ken 10/27 10:18）：要点「允许」时，这次怎么做、以后不想再问怎么做，各占一行。
   const allow=t.read&&slow&&!ok?`<ul class="wiz-test-help">${["ui.wizard.test.allowOnce","ui.wizard.test.allowAlways"].map(k=>`<li>${E(tx(k))}</li>`).join('')}</ul>`:'';
   test.innerHTML=`<p class="wiz-conn" data-state="${ok?'ok':slow||renewed?'attention':'wait'}">${E(line)}</p>${allow}${lost?`<ul class="wiz-test-help">${["ui.wizard.test.help1","ui.wizard.test.help2","ui.wizard.test.help3"].map(k=>`<li>${E(tx(k,{app:tutorialApp()}))}</li>`).join('')}</ul>`:''}`;}
  if(step===6){
   const items=setupItems(),key=JSON.stringify(items),list=box.querySelector('#wizardOpenItems');
   if(list&&key!==openStatus){browserGuide=!!list.querySelector('.browser-guide[open]')||browserGuide;const active=document.activeElement?.closest?.('[data-item]')?.dataset.item;list.innerHTML=openItemsHTML(items);if(active)list.querySelector(`[data-item="${active}"]`)?.focus();openStatus=key;}
   const later=box.querySelector('.wiz-later');if(later)later.hidden=!items.length;
   if(!busy){selectedTier=shownTier();for(const radio of box.querySelectorAll('input[data-tier]'))radio.checked=radio.value===selectedTier;}
   fitOpenPaths();
  }
  autoAdvance();
 }
 // 1081（Claude，ChatGPT 复查 D01）：在用 Site、自己加 OpenAI 通道加到一半关掉：「这次要配的」改回 Site，首页和进度页不再当成还在配 OpenAI 通道。
 async function closeWizard(){stopAdvance();opened=false;box.hidden=true;document.querySelector('#app').inert=false;if(step===1)await window.ChatHandKeyWatch.cancel();const b=S.site_b||{};if(step!==6&&b.selected==='site'&&b.routes?.site?.configured===true&&S.setup_route==='openai'){try{await api('/api/setup/route',{route:'site'});}catch{}}}
 async function showSharedCompletion(){if(!testVerified()||typeof window.startH10!=='function'||document.getElementById('h10Host')?.hidden===false)return false;await closeWizard();try{window.startH10({route:'openai',screen:'f12',fromManualWizard:true});return true;}catch{opened=true;box.hidden=false;document.querySelector('#app').inert=true;return false;}}
 // 完成页改范围：点了就改，失败退回原来那个。
 async function chooseTier(tier){if(tier===S.permissions?.tier||!['full','light'].includes(tier))return;const generation=++actionGeneration;busy=true;selectedTier=tier;try{const ok=await window.applyTier?.(tier);if(ok!==true)throw Error(document.querySelector('#toast')?.textContent||tx("ui.wizard.changeTierFailed"));}catch(error){const msg=box.querySelector('#wizardError');if(msg)msg.textContent=userMessage(error,tx("ui.wizard.changeTierFailed"));}finally{if(generation===actionGeneration){busy=false;selectedTier=shownTier();if(opened)updateStatus();}}}
 async function openItem(id){const item=setupItems().find(i=>i.id===id);if(!item||item.done||item.status==='waiting')return;
  if(item.status==='needs_restart'){await api('/api/setup/progress',{step,tunnel_id:tunnel});await native('restartAfterPermissions');}
  else if(id==='admin'){const ok=await window.setRisk?.('admin',true);if(ok===false)throw Error(document.querySelector('#toast')?.textContent||window.ChatHandText.t("ui.wizard.openFailed"));}
  else if(id==='desktop')await native('computerPermissions');
  else if(id==='browser'){if(browserStore())await action('extensionSetup');else if(item.detail?.installed&&!item.detail?.connected)await api('/api/browser/extension/reconnect',{});else{browserGuide=true;box.querySelector('.browser-guide')?.setAttribute('open','');await action('extensionSetup');}}
  else if(id==='folder')await api('/api/setup/workspace',{});
  await refresh();updateStatus();
 }
 // 截图放在框里一张小卡上：按教程给的 focus 那一块放大到刚好装下（最多 2 倍），卡的大小跟着图走、在框里居中；
 // 图比卡大时，让 focus 那块居中，但不露出图外面的空白。圈画在框上，跟着图的位置走。
 function fitShot(){const frame=box.querySelector('.tut-frame'),clip=frame?.querySelector('.tut-clip'),img=clip?.querySelector('img');if(!img)return;const apply=()=>{if(!img.naturalWidth||!frame.clientWidth)return;frame.querySelectorAll('.tut-ring').forEach(x=>x.remove());const subs=tutorial.steps[ids[step]].subs,item=subs[Math.min(sub,subs.length-1)],w=img.naturalWidth/2,h=img.naturalHeight/2,[x,y,fw,fh]=item.focus||[0,0,w,h],pad=20,fW=frame.clientWidth,fH=frame.clientHeight,scale=Math.min(2,(fW-pad*2)/fw,(fH-pad*2)/fh),iw=w*scale,ih=h*scale,cw=Math.min(fW-pad*2,iw),ch=Math.min(fH-pad*2,ih),cx=Math.round((fW-cw)/2),cy=Math.round((fH-ch)/2),clamp=(v,lo)=>Math.max(lo,Math.min(0,v)),ix=clamp(cw/2-(x+fw/2)*scale,cw-iw),iy=clamp(ch/2-(y+fh/2)*scale,ch-ih);Object.assign(clip.style,{left:cx+'px',top:cy+'px',width:cw+'px',height:ch+'px'});Object.assign(img.style,{width:iw+'px',height:ih+'px',left:ix+'px',top:iy+'px'});for(const r of item.rings||[]){const ring=document.createElement('span');ring.className='tut-ring';Object.assign(ring.style,{left:cx+ix+r[0]*scale-4+'px',top:cy+iy+r[1]*scale-4+'px',width:r[2]*scale+8+'px',height:r[3]*scale+8+'px'});frame.append(ring);}};img.onload=apply;if(img.complete)apply();}
 async function copy(text){const r=await native('copyText',{text});if(r.error){await navigator.clipboard.writeText(text);}toast(window.ChatHandText.t("ui.wizard.copied"));}
 box.addEventListener('input',e=>{if(e.target.id==='wizardTunnel'){tunnel=e.target.value;updateStatus();}});
 // 用 click 不用 change：档位还是 custom 时「整台电脑」已经显示选中，再点一下也要能应用（已选中的单选不会再发 change）。方向键切换也会发 click。
 box.addEventListener('click',e=>{const radio=e.target.closest?.('input[data-tier]');if(radio?.checked)void chooseTier(radio.value);});
 box.addEventListener('click',async e=>{
  const navigation=e.target.closest('[data-wizard]');if(navigation?.dataset.wizard==='close'){actionGeneration++;busy=false;const finished=step===6;try{await closeWizard();if(finished)window.afterWizard?.();}catch(error){const msg=box.querySelector('#wizardError');if(msg)msg.textContent=userMessage(error,tx("ui.wizard.retryOperation"));}return;}
  // 「打开 ChatGPT」不等手上的请求：开通某一项还没回来时点它，照样打开 ChatGPT、收起向导。
  if(navigation?.dataset.wizard==='finish'){actionGeneration++;busy=false;try{await window.openChatGPT?.(typeof samplePrompts==='function'?samplePrompts()[0]:'');}catch{}finally{await closeWizard();window.afterWizard?.();}return;}
  if(busy)return;
  const dot=e.target.closest('[data-sub]');if(dot){const to=Math.max(0,Math.min(pageCount(step)-1,Number(dot.dataset.sub)||0));if(to<sub)holdAdvance=true;else if(to===pageCount(step)-1)holdAdvance=false;stopAdvance();sub=to;draw();return;}
  const b=e.target.closest('[data-wizard]');if(!b)return;
  // 同一段里翻张不找后台；翻出这一段才报进度。
  if(b.dataset.wizard==='back'&&sub>0){holdAdvance=true;stopAdvance();sub--;draw();return;}
  if(b.dataset.wizard==='next'&&sub<pageCount(step)-1){sub++;if(sub===pageCount(step)-1)holdAdvance=false;draw();return;}
  const generation=++actionGeneration;busy=true;updateStatus();
  try{switch(b.dataset.wizard){
   case'back':stopAdvance();await move(step===6?3:step-1,{toEnd:true});holdAdvance=true;draw();break;
   case'next':if(step===0&&!validTunnel())return;stopAdvance();tunnel=tunnel.trim();await move(nextStep(step));break;
   case'openItem':await openItem(b.dataset.item);break;
   case'connectAgain':await api('/api/connect/restore',{});await refresh();updateStatus();break;
   case'awaitKey':await window.ChatHandKeyWatch.start(tunnel);break;
   case'copyName':await copy(tutorialApp());break;
   case'copyTunnel':await copy(tunnel);break;
   case'copySuggestedTunnelName':await copy(suggestedTunnelName());break;
   case'copySuggestedTunnelDescription':await copy(suggestedTunnelDescription());break;
   case'copySuggestedRuntimeKeyName':await copy(suggestedRuntimeKeyName());break;
   // 图标文件在 App 里（ui/assets/app/ChatHand-plugin-icon.png，256×256、10 KB 以内，ChatGPT 的要求），原生在访达里选中它，拖进「图标」那一格。
   case'revealIcon':{const r=await native('revealPluginIcon',{});if(r?.error)throw Error(tx("ui.wizard.showIconFailed"));break;}
   case'copyTest':testSentAt=Date.now();testRenewed=false;setTimeout(()=>{if(opened)updateStatus();},60500);await window.openChatGPT?.(prompt());break;
   case'copyTestText':testSentAt=Date.now();testRenewed=false;setTimeout(()=>{if(opened)updateStatus();},60500);await copy(prompt());break;
   // 1081（Claude）：以前加过、ChatGPT 这次没来拿工具清单：直接去试一句。试一句那一页发现还没加：回到「添加到 ChatGPT」从头来。
   case'alreadyAdded':stopAdvance();await move(3);break;
   case'backToAdd':stopAdvance();await move(2);break;
   case'zoom':{const subs=tutorial.steps[ids[step]].subs,item=subs[Math.min(sub,subs.length-1)];zoom.innerHTML=`<button type="button" class="h10-button" aria-label="${E(tx("ui.wizard.closeScreenshot"))}">${E(tx("ui.wizard.close"))}</button><img src="/assets/tutorial/${E(item.shot)}.png" alt="${E(tutorialText(item))}"><p>${E(tutorialText(item))}</p>`;zoom.querySelector('button').onclick=()=>zoom.close();const big=zoom.querySelector('img'),size=()=>{const w=big.naturalWidth/2,h=big.naturalHeight/2,k=Math.min(1,innerWidth*.85/w,innerHeight*.72/h);Object.assign(big.style,{width:w*k+'px',height:h*k+'px'});};big.onload=size;if(big.complete)size();zoom.showModal();break;}
   case'chooseWorkspace':if(window.chooseFolderAndApply)await window.chooseFolderAndApply();else await action('chooseWorkspace');await refresh();updateStatus();break;
   case'extension':await action('extensionSetup');break;
   case'extensions':if(browserStore())await action('extensionSetup');else await native('extensionSettings');break;
   case'permissions':await native('computerPermissions');break;
  }}catch(error){const msg=box.querySelector('#wizardError');if(msg)msg.textContent=userMessage(error,tx("ui.wizard.retryOperation"));}
  finally{if(generation===actionGeneration){busy=false;if(opened)updateStatus();}}
 });
 box.addEventListener('keydown',async e=>{if(e.key==='Enter'&&e.target.id==='wizardTunnel'&&validTunnel()){e.preventDefault();box.querySelector('#wizardNext')?.click();return;}if(step!==1||!e.metaKey||e.key.toLowerCase()!=='v'||busy)return;e.preventDefault();busy=true;updateStatus();try{const result=resolvePasteRuntimeKeyResponse(await native('pasteRuntimeKey',{tunnel_id:tunnel,trigger:'command_v'}));if(result.error)throw Error(result.error);if(result.saved===true){last4=result.last4;draw();}}catch(error){const msg=box.querySelector('#wizardError');if(msg)msg.textContent=userMessage(error);}finally{busy=false;updateStatus();}});
 window.ChatHandText.subscribe(()=>{labels=stageKeys.map(key=>tx(key));box.setAttribute('aria-label',tx("ui.wizard.accessibleTitle"));if(opened){const active=box.querySelector('#wizardTunnel'),focused=active===document.activeElement,start=active?.selectionStart,end=active?.selectionEnd;draw();if(focused){const input=box.querySelector('#wizardTunnel');input?.focus();if(Number.isInteger(start)&&Number.isInteger(end))input?.setSelectionRange(start,end);}}});
 window.addEventListener('load',()=>{if(!autoOpened&&typeof S!=='undefined'&&S)window.wizardRefresh(S);});
 window.addEventListener('resize',()=>{fitShot();if(opened&&step===6)fitOpenPaths();});window.addEventListener('computerPermissionsUpdated',()=>void refresh());
})();
