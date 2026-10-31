import {uiText,uiHTML,trustedHTML} from '../local-text.mjs';
import { assets as defaultAssets, assetLabels } from './assets.mjs';
import { installationHandoff, SITE_TEMPLATE_FALLBACK_REASONS } from './prompts.mjs';
import { manualSiteView, siteTutorial, siteAsset } from './manual-site.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
// 1068（Claude，Ken 10/20）：按钮只有两档。大（h10-button-l，高 40）：每屏的主按钮和跟它并排的次按钮；主按钮自动是大的。
// 中（默认，高 32）：卡片里、右上角的小动作。没有框的灰字是 link。尺寸都在 h10.css 开头那一段。
const button = (label, action, primary=false, disabled=false, value='', size=primary?'l':'') => `<button type="button" class="h10-button${primary?' h10-button-primary':''}${size==='l'?' h10-button-l':''}" data-action="${esc(action)}"${value!==''?` data-value="${esc(value)}"`:''}${disabled?' disabled':''}>${esc(label)}</button>`;
const link = (label, action, disabled=false) => `<button type="button" class="h10-link" data-action="${esc(action)}"${disabled?' disabled':''}>${esc(label)}</button>`;
const heading = (title, subtitle='') => `<div class="h10-heading"><h1>${esc(title)}</h1>${subtitle?`<p>${esc(subtitle)}</p>`:''}</div>`;
// Exact check-path from supplied fixed-source first-open.template.html (.i-ok),
// with the same stroke geometry from its theme.css. Reused UI icon, not redrawn art.
const sourceCheck = '<svg class="h10-source-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg>';
// 1069 第 3 条（Claude，Ken 10/22）：完成页的大对勾改成实心绿底、白勾（跟开关打开的绿一样），出现时轻轻弹一下、勾画出来。
const doneMark = '<svg class="h10-done-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><circle cx="32" cy="32" r="32"/><path pathLength="1" d="m20 33 8 8 16-17"/></svg>';
// 1081（Claude，Ken 10/26）：向导里「这一步现在做不了」的空状态，跟主窗口连接页的空状态用同一个图标块（app.js 的 emptyIllustration，样式在 style.css 的 .empty-art），
// 不放卡片。图标是 index.html 里那套 symbol；64 见方，跟完成页的大对勾一样大。
const stateIcon = id => `<div class="empty-art h10-state-icon" aria-hidden="true"><i class="ew-ring" style="--ro:16px;--ra:1"></i><i class="ew-ring" style="--ro:32px;--ra:.62"></i><i class="ew-ring" style="--ro:48px;--ra:.32"></i><svg viewBox="0 0 24 24" focusable="false"><use href="#${esc(id)}"/></svg></div>`;

function media(key, vm, ctx, className='', labelOverride='') {
  const asset = ctx.assets[key];
  const applicable = asset?.src && asset.routes?.includes(vm.connectionRoute);
  // 0011（Claude）：圈重点不再用手画的橙色椭圆图片，改成跟手动向导一样的圆角框（.h10-callout-ring），位置还是原来那一块。
  // Keep each original source resource in a top-level HTML image. In the final
  // dark capture the composite loaded, but its nested SVG callouts did not paint.
  const layers = asset?.presentation;
  const layered = applicable && layers?.kind === 'source-html-layers';
  const viewport = layers?.viewport || {x:0,y:0,width:layers?.width,height:layers?.height};
  const ring = layers?.ring || layers?.callout; // 0011：原来椭圆的外框是斜的，权限那张另给一个框住整行的位置
  const content = applicable
    ? layered
      ? `<div class="h10-source-stage" style="--h10-source-ratio:${viewport.width/viewport.height}" data-composition="source-html-layers"${layers.viewport?` data-source-crop="${viewport.x},${viewport.y},${viewport.width},${viewport.height}"`:''}><img src="${esc(layers.base.src)}" alt="${esc(asset.alt || labelOverride || assetLabels[key] || '')}" width="${layers.width}" height="${layers.height}" data-source-node="${esc(layers.base.sourceNode)}" style="left:${-viewport.x/viewport.width*100}%;top:${-viewport.y/viewport.height*100}%;width:${layers.width/viewport.width*100}%;height:${layers.height/viewport.height*100}%" draggable="false"><span class="h10-source-callout h10-callout-ring" aria-hidden="true" data-source-node="${esc(layers.callout.sourceNode)}" style="left:${(ring.x-viewport.x)/viewport.width*100}%;top:${(ring.y-viewport.y)/viewport.height*100}%;width:${ring.width/viewport.width*100}%;height:${ring.height/viewport.height*100}%"></span></div>`
      : `<img src="${esc(asset.src)}" alt="${esc(asset.alt || labelOverride || assetLabels[key] || '')}"${asset.width?` width="${esc(asset.width)}" height="${esc(asset.height)}"`:''} draggable="false">`
    : ctx.review
      ? `<div class="h10-missing" data-missing-asset="${esc(key)}"><strong>${esc(labelOverride || assetLabels[key] || key)}</strong><span>${esc(uiText("ui.h10.views.sourceAssetMissing"))}</span></div>`
      : `<div class="h10-blank" data-missing-asset="${esc(key)}" aria-hidden="true"></div>`;
  return `<div class="h10-media ${className}" data-asset-key="${esc(key)}"${applicable?` data-asset-role="${esc(asset.role||'illustration')}" data-provenance="${esc(asset.provenance)}"${asset.sourceNode?` data-source-node="${esc(asset.sourceNode)}"`:''}`:''}>${content}</div>`;
}

function brand(vm, ctx, subtitle=uiText("ui.h10.views.firstSetup")) {
  const asset=ctx.assets.appIcon;
  return `<div class="h10-brand">${asset?.src?`<img src="${esc(asset.src)}" alt="" width="40" height="40">`:''}<div><strong>ChatHand</strong><small>${esc(subtitle)}</small></div></div>`;
}

function shell(vm, ctx, content, extraClass='') {
  const done=vm.screen==='f15';
  const manual=manualSiteView(vm);
  const check=manual?`<img src="${siteAsset('check')}" alt="">`:sourceCheck;
  // 1069（Claude）：配过一次以后再进来，左上角写「连接设置」，不再写「首次设置」。
  const title=vm.brandSubtitle||uiText("ui.h10.views.firstSetup");
  return `<section class="h10 h10-shell${manual?' h10-manual-site':''}" data-screen="${esc(vm.screen)}"><header class="h10-header">${brand(vm,ctx,title)}<ol class="h10-stepper" aria-label="${esc(title)}" data-done="${done}"><li${!done?' aria-current="step"':''}><span class="h10-step-num">${done?check:'1'}</span>${esc(uiText("ui.h10.views.connection"))}</li><li${done?' aria-current="step"':''}><span class="h10-step-num">${done?check:'2'}</span>${esc(uiText("ui.h10.views.complete"))}</li></ol><div class="h10-header-end">${done?'':button(uiText("ui.h10.views.dismiss"),'dismiss')}</div></header><main class="h10-main ${extraClass}">${content}</main></section>`;
}

// 0011（Claude）：F6 两张配图改成直接画在页面里的矢量图，跟着浅色/深色走，Retina 上不糊。
// 不画 ChatGPT 的标志：左边是一段对话（贴进去的那句话 + 两条做完了的回复），连到右边的 ChatHand；右边是三张截图步骤卡，第三张在点。
const artCheck=(cx,cy,r,cls='h10-art-tick')=>`<path class="${cls}" d="M${cx-r*.45} ${cy+r*.02}l${r*.32} ${r*.32} ${r*.6}-${r*.62}"/>`;
function assistedArt(ctx){
  const icon=ctx.assets.appIcon?.src;
  return `<svg viewBox="0 0 388 168" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
<rect class="h10-art-card" x="36.5" y="20.5" width="180" height="127" rx="14"/>
<rect class="h10-art-mint-soft" x="92" y="34" width="110" height="38" rx="12"/>
<rect class="h10-art-mint-line" x="104" y="45" width="84" height="5" rx="2.5"/><rect class="h10-art-mint-line" x="104" y="56" width="58" height="5" rx="2.5"/>
<rect class="h10-art-fill" x="50" y="82" width="112" height="24" rx="10"/><circle class="h10-art-mint" cx="63" cy="94" r="6.5"/>${artCheck(63,94,6.5)}<rect class="h10-art-line" x="76" y="91.5" width="70" height="5" rx="2.5"/>
<rect class="h10-art-fill" x="50" y="112" width="96" height="24" rx="10"/><circle class="h10-art-mint" cx="63" cy="124" r="6.5"/>${artCheck(63,124,6.5)}<rect class="h10-art-line" x="76" y="121.5" width="54" height="5" rx="2.5"/>
<path class="h10-art-dash" d="M226 84H272"/><circle class="h10-art-mint-soft" cx="249" cy="84" r="8"/><circle class="h10-art-mint" cx="249" cy="84" r="4"/>
${icon?`<image href="${esc(icon)}" x="282" y="52" width="64" height="64"/>`:`<rect class="h10-art-ink" x="282" y="52" width="64" height="64" rx="15"/>`}
<circle class="h10-art-badge" cx="342" cy="56" r="11"/>${artCheck(342,56,11)}
</svg>`;
}
function manualArt(){
  const cards=[36,148,260].map((x,i)=>{
    const y=26,last=i===2;
    const chip=last?`<circle class="h10-art-mint" cx="${x+20}" cy="${y+20}" r="10"/><text class="h10-art-num" x="${x+20}" y="${y+20}" text-anchor="middle" dominant-baseline="central">3</text>`:`<circle class="h10-art-mint-soft" cx="${x+20}" cy="${y+20}" r="10"/>${artCheck(x+20,y+20,10,'h10-art-tick-soft')}`;
    const shot=`<rect class="h10-art-fill" x="${x+12}" y="${y+40}" width="68" height="36" rx="6"/>`+(last?`<rect class="h10-art-target" x="${x+20}" y="${y+51}" width="52" height="15" rx="7.5"/>`:`<rect class="h10-art-line" x="${x+20}" y="${y+50}" width="40" height="5" rx="2.5"/><rect class="h10-art-line" x="${x+20}" y="${y+60}" width="28" height="5" rx="2.5"/>`);
    return `<g${last?'':' class="h10-art-done"'}><rect class="h10-art-card" x="${x+.5}" y="${y+.5}" width="92" height="116" rx="12"/>${chip}${shot}<rect class="h10-art-line" x="${x+12}" y="${y+86}" width="60" height="5" rx="2.5"/><rect class="h10-art-line" x="${x+12}" y="${y+97}" width="40" height="5" rx="2.5"/></g>`;
  }).join('');
  const chevron=x=>`<path class="h10-art-chevron" d="M${x-2} 79l5 5-5 5"/>`;
  return `<svg viewBox="0 0 388 168" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">${cards}${chevron(138)}${chevron(250)}<path class="h10-art-cursor" transform="translate(320 85)" d="M0 0v17l4.6-4.2 3.2 6.8 2.8-1.3-3.1-6.6h6.2z"/></svg>`;
}

// 1083（Claude，Ken 10/28 21:38）：选了 Site、建 Site 以前查网络，被拦或者连不上时，「选怎么配」（F6）和「建 Site」（F10）整页换成这个样子，
// 跟「暂时无法创建 ChatGPT Site」同一种空状态：图标、标题、一句话、一个主按钮、一个灰链接。
// 被 Cloudflare 网络验证拦（challenged）：多半是代理或 VPN，主按钮「改用 OpenAI 通道」，灰链接「重新检查」（关了代理或 VPN 以后点）。
// 连不上（unreachable）：多半是网断了，主按钮「重新检查」，灰链接「改用 OpenAI 通道」。重新检查时那个按钮写「正在检查…」并灰着。
function siteNetworkState(vm,ctx) {
  const challenged=vm.siteNetwork==='challenged',rechecking=vm.siteNetworkRechecking===true;
  const recheck=uiText(rechecking?"ui.h10.views.siteNetworkRechecking":"ui.h10.views.siteNetworkRecheck"),openai=uiText("ui.h10.host.useOpenAI");
  const more=inner=>`<nav class="h10-quiet-links" aria-label="${esc(uiText("ui.h10.views.connectionMoreActions"))}">${inner}</nav>`;
  const main=challenged?button(openai,'switch-openai',true):button(recheck,'recheck-site-network',true,rechecking);
  const other=challenged?more(link(recheck,'recheck-site-network',rechecking)):more(link(openai,'switch-openai'));
  const head=challenged?heading(uiText("ui.h10.views.siteNetworkBlockedTitle"),uiText("ui.h10.views.siteNetworkBlockedIntro"))
    :heading(uiText("ui.h10.views.siteNetworkUnreachableTitle"),uiText("ui.h10.views.siteNetworkUnreachableIntro"));
  return shell(vm,ctx,`<div class="h10-state" data-state="site-network" data-net="${challenged?'challenged':'unreachable'}">${stateIcon('i-site')}${head}<div class="h10-state-action">${main}</div>${other}</div>`);
}

function welcome(vm,ctx) {
  // 1083（Claude）：选了 Site，网络被拦或者连不上，整页换成上面那个样子；还在查时两个「开始」先灰着，写「正在检查网络…」。
  if(vm.siteNetwork==='challenged'||vm.siteNetwork==='unreachable')return siteNetworkState(vm,ctx);
  const checking=vm.siteNetwork==='checking',start=uiText(checking?"ui.h10.views.siteNetworkChecking":"ui.h10.views.start");
  // Desktop detection is a separate input, not a connection status.
  // 0011（Claude）：两张卡用同一套行（subgrid）：顶上都留出「推荐」那条的高度、标题、配图、说明、时长、按钮，各占一行，左右对齐；中间不要竖线和「或」，只留空白。
  const found=vm.desktopApp==='found';
  // 0012（Claude，Ken 10/19）：换过连接方式（或者本来就不是默认的那条，1083 起默认是 OpenAI 通道）时，两张卡的标题后面标上现在走哪种，让人看得出换成了。
  const tag=vm.routeTag?`<span class="h10-route-tag">${esc(vm.routeTag)}</span>`:'';
  const card=(key,title,badge,art,alt,description,meta,extra,action)=>`<article class="h10-card h10-choice" data-choice="${key}">${badge?`<span class="h10-badge">${esc(badge)}</span>`:''}<h2>${esc(title)}${tag}</h2><div class="h10-media h10-art" data-asset-key="${key}" data-asset-role="illustration" role="img" aria-label="${esc(alt)}">${art}</div><p class="h10-choice-description">${esc(description)}</p><div class="h10-choice-meta"><p>${esc(meta)}</p>${extra}</div><div class="h10-choice-action">${action}</div></article>`;
  return shell(vm,ctx,heading(uiText("ui.h10.views.welcomeTitle"),uiText("ui.h10.views.welcomeIntroduction"))+`
  <div class="h10-choices">
    ${card('assisted',uiText("ui.h10.views.assisted"),uiText("ui.h10.views.recommended"),assistedArt(ctx),uiText("ui.h10.assets.assistedAlt"),vm.assistedCopiesSentence?uiText("ui.h10.views.assistedCopyExplanation"):uiText("ui.h10.views.assistedExplanation"),uiText("ui.h10.views.assistedDuration"),found?`<p class="h10-desktop">${esc(uiText("ui.h10.views.desktopFound"))}</p>`:'',button(start,'choose-assisted',true,vm.assistedDisabled===true||checking))}
    ${card('manual',uiText("ui.h10.views.manual"),'',manualArt(),uiText("ui.h10.assets.manualAlt"),uiText("ui.h10.views.manualExplanation"),uiText("ui.h10.views.manualDuration"),'',button(start,'choose-manual',false,checking))}
  </div><footer class="h10-footer">${link(uiText("ui.h10.views.changeRouteFooter"),'change-route')}</footer>`,'h10-main-welcome');
}

const stepTitleKeys=Object.freeze(["ui.h10.views.verifyPackageStep","ui.h10.views.installStep","ui.h10.views.siteCreationStep","ui.h10.views.macConnectionStep","ui.h10.views.connectionTitle"]);
// 1066 第 77 条（Claude）：帮我配的进度页只剩这一张，走 OpenAI 通道也用它，第三、四步换成通道自己的两步。
// 两条路都是五步，host 给的 steps 跟着下标走，不用分开算长度。
const openaiStepTitleKeys=Object.freeze(["ui.h10.views.verifyPackageStep","ui.h10.views.installStep","ui.h10.views.tunnelCreationStep","ui.h10.views.keyHandoffStep","ui.h10.views.connectionTitle"]);
const titleList=keys=>Object.freeze(Object.defineProperties(new Array(keys.length),Object.fromEntries(keys.map((key,index)=>[index,{enumerable:true,get:()=>uiText(key)}]))));
export const STEP_TITLES=titleList(stepTitleKeys);
export const OPENAI_STEP_TITLES=titleList(openaiStepTitleKeys);

// 1068 第 99 条（Claude）：ChatGPT 在帮你配时，页面最上面是这一块：标题、去 ChatGPT 那边的一句话，下面一个「回到 ChatGPT」。
// 1081（Claude）：还没在 ChatGPT 里发出去时，标题换成「在 ChatGPT 里发出去就开始」（host 给 assistedWaiting）。
// 1081（Claude，Ken 10/27 10:18）：alt 是另一种情况的做法，单独一行，不跟上一句并成一句。
function assistedHeading(intro=uiText("ui.h10.views.assistedProgressIntroduction"),title=uiText("ui.h10.views.assistedProgressTitle"),alt='',retry=false) {
  return `<div class="h10-heading h10-assist-top"><h1>${esc(title)}</h1><p>${esc(intro)}</p>${alt?`<p class="h10-assist-alt">${esc(alt)}</p>`:''}<div class="h10-assist-action">${button(uiText(retry?"ui.h10.views.retryOpenChatGPT":"ui.h10.views.backToChatGPT"),retry?'retry-assisted':'back-to-chatgpt',true)}</div></div>`;
}

function progress(vm,ctx) {
  // Supplied F7-step5 and F12′ frames share the same exported design pixels.
  // The host retains all five steps; focused step 5 reuses the same teaching view.
  if(vm.expandConnectionStep) return shell(vm,ctx,heading(uiText("ui.h10.views.connectionTitle"),uiText("ui.h10.views.connectionAutomaticCompletion"))+siteIssue(vm)+connectCard(vm,ctx));
  const openai=vm.connectionRoute==='openai';
  const rows=(openai?OPENAI_STEP_TITLES:STEP_TITLES).map((title,index)=>{
    const step=vm.steps?.[index]||{};
    const state=['pending','active','done','attention'].includes(step.state)?step.state:'pending';
    // These are renderer inputs from the host; no timers or inferred completion.
    // 1066 第 77 条（Claude）：照 F7 原型——做完的绿勾，在做的绿点，要你处理的橙色「!」，没到的空圈。右边只有没到的那几步画「—」。
    const mark=state==='done'?sourceCheck:state==='active'?'<i class="h10-progress-pulse" aria-hidden="true"></i>':state==='attention'?'!':'';
    const time=step.timeLabel||(state==='pending'?'—':'');
    return `<li class="h10-progress-row" data-state="${state}"${state==='active'?' aria-current="step"':''}><span class="h10-progress-dot" aria-label="${esc({pending:uiText("ui.h10.views.pending"),active:uiText("ui.h10.views.active"),done:uiText("ui.h10.views.done"),attention:uiText("ui.h10.views.attention")}[state])}">${mark}</span><div><span class="h10-progress-label">${esc(title)}</span>${step.detail?`<small>${esc(step.detail)}</small>`:''}</div><span class="h10-progress-time">${esc(time)}</span></li>`;
  }).join('');
  // 1081（Claude，ChatGPT 复查）：「已经填好了，去那边按回车」那一条不要了：顶上那句已经说了，「回到 ChatGPT」就在它旁边。
  // 1066 第 77 条（Claude）：右上角的状态前面加一个点，绿的是在做，橙的是卡住了要你看（statusTone 由 host 给）。
  const tone=['active','attention','done'].includes(vm.statusTone)?vm.statusTone:'';
  const status=vm.statusLabel?`<span class="h10-status"${tone?` data-tone="${tone}"`:''}>${tone?'<i aria-hidden="true"></i>':''}${esc(vm.statusLabel)}</span>`:'';
  // 1068 第 99、101 条（Claude）：OpenAI 通道测过以后不再停在这里点「继续选权限」，host 直接带到完成页（权限在那一页）。
  const intro=vm.assistedIntro||vm.assistedWaitingIntro||(vm.assistedSentenceCopied&&vm.assistedStarted!==true?uiText("ui.h10.views.assistedCopiedIntroduction"):uiText("ui.h10.views.assistedProgressIntroduction"));
  // 1068 第 99 条（Claude）：「回到 ChatGPT」从底下的小链接挪到最上面，做成主按钮；ChatGPT 那边可能在等你点「允许」。
  const footer=link(uiText("ui.h10.views.copyAssistedSentence"),'copy-assisted')+
    (vm.connectionRoute==='site'?link(uiText("ui.h10.views.receivedCode"),'to-receive'):'')+
    (openai&&vm.openaiTestAvailable===true?link(uiText("ui.h10.views.openaiSelfTest"),'openai-test'):'')+
    link(uiText("ui.h10.views.chooseManual"),'choose-manual');
  // 1069（Claude）：帮我配的时候 Site 被网络验证拦住、或者被别的电脑改连走，进度上面放那张问题卡，出口（改用 OpenAI 通道等）就在这一页。
  return shell(vm,ctx,assistedHeading(intro,vm.assistedOpenFailed===true?uiText("ui.h10.views.assistedOpenFailedTitle"):vm.assistedWeb===true?uiText("ui.h10.views.assistedWebTitle"):vm.assistedWaiting===true?uiText("ui.h10.views.assistedWaitingTitle"):undefined,vm.assistedWebAlt||'',vm.assistedOpenFailed===true)+(vm.siteBlocked?siteIssue(vm):'')+`<section class="h10-card h10-card-accent h10-progress"><div class="h10-progress-header"><div><h2>${esc(uiText("ui.h10.views.connectionProgressTitle"))}</h2>${vm.contextLabel?`<p>${esc(vm.contextLabel)}</p>`:''}</div>${status}</div><ol class="h10-progress-list">${rows}</ol>${vm.expandConnectionStep?`<div class="h10-progress-expanded">${connectCard(vm,ctx)}</div>`:''}<footer class="h10-progress-footer">${footer}</footer></section>`);
}

function thumbs(keys,selected,vm,ctx,action) {
  return `<div class="h10-thumbs" aria-label="${esc(uiText("ui.h10.views.tutorialSteps"))}">${keys.map((key,index)=>`<button type="button" class="h10-thumb" aria-label="${esc(assetLabels[key])}" aria-pressed="${selected===key}" data-action="${esc(action)}" data-value="${index}">${media(key,vm,ctx)}</button>`).join('')}</div>`;
}

// The two guide pages share the existing work-guide-step action. Turning a page
// changes only the teaching diagram; Site receipt and verification stay in host.mjs.
function manualWorkSetup(vm,ctx,{preparing,note}) {
  const text=key=>esc(uiText(`ui.h10.manual.${key}`));
  if(vm.templateFileMode===true&&!preparing)return shell(vm,ctx,heading(uiText("ui.h10.views.templateFileTitle"),uiText("ui.h10.views.templateFileIntroduction"))+`
    <section class="h10-card h10-site-guide h10-site-file">${siteTutorial('workFile')}<div class="h10-site-guide-copy"><p class="h10-site-eyebrow">${esc(uiText("ui.h10.views.provideLocalTemplate"))}</p><h2>${text('fileTitle')}</h2><p>${text('fileBody')}</p><div class="h10-site-guide-actions">${button(uiText("ui.h10.views.copyTemplateFollowup"),'copy-template-followup',true)}${link(uiText("ui.h10.views.revealTemplateFile"),'template-file')}</div><nav class="h10-site-guide-nav" aria-label="${esc(uiText('ui.h10.views.tutorialSteps'))}">${button(uiText('ui.h10.manual.backToPrompt'),'template-file-back',false,false,'','l')}</nav></div></section>${siteReceiveBlock(vm)}${note}`);
  const keys=['workOpen','workEnter'];
  const chosen=keys.includes(vm.guideMedia)?vm.guideMedia:keys[vm.guideStep===2?1:0];
  const index=keys.indexOf(chosen);
  const dots=`<div class="h10-site-guide-dots" aria-label="${esc(uiText('ui.h10.views.tutorialSteps'))}">${keys.map((key,i)=>`<button type="button" aria-label="${esc(assetLabels[key])}" aria-pressed="${i===index}" data-action="work-guide-step" data-value="${i}"><span></span></button>`).join('')}</div>`;
  return shell(vm,ctx,heading(uiText("ui.h10.views.siteCreationTitle"),uiText("ui.h10.views.siteCreationIntroduction"))+`
    <section class="h10-card h10-site-guide"><div class="h10-site-guide-visual">${siteTutorial(chosen)}${dots}</div><div class="h10-site-guide-copy"><p class="h10-site-eyebrow">${esc(uiText('ui.h10.manual.guideProgress',{step:index+1}))}</p><h2>${text(index?'sendTitle':'workTitle')}</h2><p>${text(index?'sendBody':'workBody')}</p><div class="h10-site-guide-actions">${button(uiText('ui.h10.views.openChatGPT'),'open-work',true,preparing)}${link(uiText('ui.h10.views.copyWorkPrompt'),'copy-work-prompt',preparing)}</div><nav class="h10-site-guide-nav" aria-label="${esc(uiText('ui.h10.views.tutorialSteps'))}">${button(uiText(index?'ui.h10.manual.previous':'ui.h10.manual.next'),'work-guide-step',false,false,index?'0':'1','l')}</nav></div></section>
    <nav class="h10-site-aux" aria-label="${esc(uiText('ui.h10.views.connectionMoreActions'))}">${link(uiText(vm.templateSourceKind==='bundled_local'?'ui.h10.views.provideLocalTemplate':'ui.h10.views.missingTemplate'),'template-file')}${link(uiText('ui.h10.views.noWork'),'change-route')}${siteReceiveBlock(vm,true)}</nav>${note}`);
}

function workSetup(vm,ctx) {
  // 1052 C3-6/C6（Claude）：三种样子。建不了（这版没带模板）；建站话（主路）；
  // ChatGPT 拿不到模板时，ChatHand 把随 App 带的 zip 放进「下载」，用户拖进 Work。
  // 这个页面不读、不传文件；复制和在 Finder 里选中都由原生做，只认窗口里的点击。
  const ready=vm.templateConfigured===true&&vm.sitePromptEnabled===true&&
    typeof vm.workPrompt==='string'&&vm.workPrompt.length>0;
  // 1081（Claude）：刚进来、本机服务正在开 Site 配对拿建站那句话时，照常画这一页，两个按钮先灰着；拿不到才是「建不了」那一页。
  // 在「建不了」那一页点「再试一次」时不跳回这一页，留在原地、按钮写「正在重试…」。
  const retrying=vm.siteRetrying===true;
  // 1083（Claude）：建 Site 以前查网络。被拦或者连不上，整页换成 siteNetworkState；还在查时跟「正在准备」一样，两个按钮先灰着。
  if(vm.siteNetwork==='challenged'||vm.siteNetwork==='unreachable')return siteNetworkState(vm,ctx);
  const preparing=!ready&&vm.templatePreparing===true&&!retrying||vm.siteNetwork==='checking';
  const note=vm.noticeCopy?`<p class="h10-host-message" role="status">${esc(vm.noticeCopy)}</p>`:'';
  // 1081（Claude，Ken 10/26）：原来这页是一块空卡片里只放一个「换一种连接方式」，说明写「建站用的模板没有随这版一起带上」，
  // Ken 说看着诡异、也看不懂。改成空状态的样子：图标、一句标题、一句话、一个主按钮、一个灰链接，不放卡片。
  // 这一版带着建站要的东西（template_ready 不是 false），多半只是刚才没准备好：主按钮「再试一次」，灰链接「改用 OpenAI 通道」。
  // 真没带（开发版会这样；正式版出现就是装的包不完整，Ken 16:22 的字让用户重新安装）：不给「再试一次」，主按钮就是「改用 OpenAI 通道」。
  // 1082（Claude，Ken 10/28 15:50）：按钮底下不再叠一行橙字复读（这一页不画 note）。按「点过再试一次、还是不行」分两种样子：
  // 第一次进来：副标题说原因和两条路，主按钮「再试一次」，灰链接「改用 OpenAI 通道」；
  // 重试失败后：副标题换成橙色的「本机配置仍未就绪（错误码），请退出并重新打开 ChatHand 后再试。」（Ken 16:22），主按钮变成「改用 OpenAI 通道」，「再试一次」退成灰链接。
  // 进这一页前本机服务已经静默重试过一次（host.mjs 的 primeSiteTemplate），出这一页时已经是两次都没拿到。
  if(!ready&&!preparing){
    const retry=vm.siteRetryAvailable!==false;
    const failed=retry&&vm.siteRetryFailed===true;
    const retryLabel=uiText(retrying?"ui.h10.views.siteRetrying":"ui.h10.views.siteRetry"),openai=uiText("ui.h10.host.useOpenAI");
    const more=inner=>`<nav class="h10-quiet-links" aria-label="${esc(uiText("ui.h10.views.connectionMoreActions"))}">${inner}</nav>`;
    const main=!retry?button(openai,'switch-openai',true):failed?button(openai,'switch-openai',true,retrying):button(retryLabel,'retry-site',true,retrying);
    const other=!retry?'':failed?more(link(retryLabel,'retry-site',retrying)):more(link(openai,'switch-openai',retrying));
    const title=uiText("ui.h10.views.templateUnavailableTitle");
    const failedCopy=vm.siteRetryErrorCode?uiText("ui.h10.host.siteRetryFailedCode",{code:vm.siteRetryErrorCode}):uiText("ui.h10.host.siteRetryFailed");
    const head=failed?`<div class="h10-heading"><h1>${esc(title)}</h1><p class="h10-state-alert" role="status">${esc(failedCopy)}</p></div>`
      :heading(title,uiText(retry?"ui.h10.views.templateUnavailableIntroduction":"ui.h10.views.templateUnavailableNoRetry"));
    return shell(vm,ctx,`<div class="h10-state" data-state="site-unavailable"${failed?' data-retry="failed"':''}>${stateIcon('i-site')}${head}<div class="h10-state-action">${main}</div>${other}</div>`);
  }
  if(manualSiteView(vm))return manualWorkSetup(vm,ctx,{preparing,note});
  if(vm.templateFileMode===true&&!preparing){
    return shell(vm,ctx,heading(uiText("ui.h10.views.templateFileTitle"),uiText("ui.h10.views.templateFileIntroduction"))+`
  <section class="h10-card h10-card-accent h10-guide"><div>${media('workFile',vm,ctx,'h10-guide-media')}</div><div class="h10-guide-controls"><ol class="h10-instructions"><li aria-current="step"><span class="h10-instruction-num">1</span> ${esc(uiText("ui.h10.views.dragTemplateStep"))}</li><li><span class="h10-instruction-num">2</span> ${esc(uiText("ui.h10.views.sendFollowupStep"))}</li></ol>${button(uiText("ui.h10.views.copyTemplateFollowup"),'copy-template-followup',true)}${button(uiText("ui.h10.views.revealTemplateFile"),'template-file')}${link(uiText("ui.h10.views.backToSitePrompt"),'template-file-back')}</div></section>
  ${siteReceiveBlock(vm)}${note}`);
  }
  const step=vm.guideStep===2?2:1;
  const keys=['workOpen','workEnter'];
  const chosen=keys.includes(vm.guideMedia)?vm.guideMedia:keys[step-1];
  return shell(vm,ctx,heading(uiText("ui.h10.views.siteCreationTitle"),uiText("ui.h10.views.siteCreationIntroduction"))+`
  <section class="h10-card h10-card-accent h10-guide"><div>${media(chosen,vm,ctx,'h10-guide-media')}${thumbs(keys,chosen,vm,ctx,'work-guide-step')}</div><div class="h10-guide-controls"><ol class="h10-instructions"><li${step===1?' aria-current="step"':''}><span class="h10-instruction-num">1</span> ${esc(uiText("ui.h10.views.openWorkStep"))}</li><li${step===2?' aria-current="step"':''}><span class="h10-instruction-num">2</span> ${esc(uiText("ui.h10.views.sendWorkPromptStep"))}</li></ol>${button(uiText("ui.h10.views.openChatGPT"),'open-work',true,preparing)}${button(uiText("ui.h10.views.copyWorkPrompt"),'copy-work-prompt',false,preparing)}<div class="h10-or" role="separator"><span>${esc(uiText("ui.h10.views.or"))}</span></div>${link(uiText(vm.templateSourceKind==='bundled_local'?"ui.h10.views.provideLocalTemplate":"ui.h10.views.missingTemplate"),'template-file')}${link(uiText("ui.h10.views.noWork"),'change-route')}</div></section>
  ${siteReceiveBlock(vm)}${note}`);
}

// 0011（Claude）：F11 的配图原来是左上角一张很小的截图，看不清。改成居中画一个代码块，右上角「复制」被圈出来、鼠标在点。
function copyArt(){
  return `<svg viewBox="0 0 280 112" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
<rect class="h10-art-card" x="20.5" y="8.5" width="239" height="95" rx="12"/>
<path class="h10-art-head" d="M21 20.5a12 12 0 0 1 12-12h215a12 12 0 0 1 12 12V36H21z"/>
<rect class="h10-art-line" x="36" y="20" width="40" height="5" rx="2.5"/>
<rect class="h10-art-target" x="196" y="14" width="52" height="17" rx="8.5"/><rect class="h10-art-copy" x="205" y="18.5" width="6" height="7" rx="1.5"/><rect class="h10-art-copy" x="207.5" y="20.5" width="6" height="7" rx="1.5"/><rect class="h10-art-mint-line" x="218" y="20" width="22" height="5" rx="2.5"/>
<rect class="h10-art-line" x="36" y="50" width="150" height="5" rx="2.5"/><rect class="h10-art-line" x="36" y="62" width="112" height="5" rx="2.5"/><rect class="h10-art-line" x="36" y="74" width="132" height="5" rx="2.5"/><rect class="h10-art-line" x="36" y="86" width="72" height="5" rx="2.5"/>
<path class="h10-art-cursor" transform="translate(234 25)" d="M0 0v17l4.6-4.2 3.2 6.8 2.8-1.3-3.1-6.6h6.2z"/>
</svg>`;
}

// 1081（Claude）：收配对代码的那一行（收到了在配 / 没配成 / 等完了），F11 和 F10 共用。
function receiveStatusLine(vm){
  const status=vm.receiveStatus;
  return status==='received'?`<p class="h10-receive-state" data-state="received" role="status"><span class="h10-spin" aria-hidden="true"></span>${esc(vm.receiveStatusCopy||uiText("ui.h10.views.receivingCredential"))}</p>`
    :status==='error'?`<p class="h10-receive-state" data-state="error" role="alert">${esc(vm.receiveStatusCopy||'')}</p>`
    :status==='expired'?`<p class="h10-receive-state" data-state="expired" role="status">${esc(uiText("ui.h10.views.watchExpired"))}${link(uiText("ui.h10.views.renewWatch"),'rewatch')}</p>`:'';
}
// 1081（Claude，Ken 10/27「能自己判断的就别让人点」）：建 Site 那页。后台已经在等 Site 给的配对代码时，
// 不再让人点「下一步」去另一页：直接写「点「复制」这里会自己收到」，收到了就在这一页显示进展，配好了自己去下一页。
// 后台没在等（还没点打开 ChatGPT / 复制那句话）时照旧给「下一步」。
function siteReceiveBlock(vm,compact=false){
  const st=vm.receiveStatus;
  if(st==='received'||st==='error')return `<div class="h10-next">${receiveStatusLine(vm)}</div>`;
  return vm.siteWatching===true
    ?`<p class="h10-next" role="status">${esc(uiText("ui.h10.views.siteReadyAuto"))}</p>`
    :compact?link(uiText('ui.h10.manual.receiveEntry'),'to-receive'):`<p class="h10-next">${esc(uiText("ui.h10.views.siteReadyNext"))}${link(uiText(manualSiteView(vm)?'ui.h10.manual.receiveNext':"ui.h10.views.next"),'to-receive')}</p>`;
}

function credentialReceive(vm,ctx) {
  // Never accepts opaque grant/key/clipboard contents. Only nonsensitive labels.
  // 1052 C4（Claude）：主路是自己收（原生只在这一页开着时看剪贴板，最多 10 分钟）；⌘V 兜底。
  // renew 是凭据过期（auth_required）那一页，同样自己收。
  const auto=vm.receiveMode==='automatic-capable';
  const renew=vm.receivePurpose==='renew';
  const title=renew?uiText("ui.h10.views.credentialExpiredTitle"):uiText("ui.h10.views.receiveTitle");
  const sub=renew?uiText("ui.h10.views.renewCredentialIntroduction"):auto?uiText("ui.h10.views.receiveAutomaticIntroduction"):uiText("ui.h10.views.receiveManualIntroduction");
  const status=vm.receiveStatus;
  const statusLine=receiveStatusLine(vm);
  const message=auto?uiText("ui.h10.views.receiveAutomatic"):(vm.receiveInstructionCopy||'');
  // 1068（Claude，Ken 10/20）：「重新验证本次配对」「换一种连接」原来是贴着窗口底边的两个按钮，改成卡片下面一行灰色小链接，跟 F12 一样。
  const paste=auto||status==='expired'?`<p class="h10-paste">${uiHTML("ui.h10.views.pasteFallbackPrompt", {shortcut: trustedHTML('<kbd>⌘V</kbd>')})}</p>`:'';
  if(manualSiteView(vm))return shell(vm,ctx,heading(title,sub)+`<section class="h10-card h10-site-guide h10-site-receive">${siteTutorial('credentialCopy')}<div class="h10-site-guide-copy"><h2>${esc(message||uiText('ui.h10.host.pasteCredentialInstruction'))}</h2><p>${esc(uiText('ui.h10.manual.receiveContinue'))}</p>${statusLine||`<p class="h10-site-wait" role="status"><i aria-hidden="true"></i>${esc(uiText(auto?'ui.h10.manual.waitingReceive':'ui.h10.host.pasteCredentialInstruction'))}</p>`}${paste}</div></section><nav class="h10-quiet-links" aria-label="${esc(uiText('ui.h10.views.connectionMoreActions'))}">${renew?'':link(uiText('ui.h10.manual.receiveBack'),'back-to-work')}${vm.canVerifyPairing===true?link(uiText('ui.h10.host.verifyPairing'),'verify-pairing'):''}${link(uiText('ui.h10.views.useDifferentConnection'),'change-route')}</nav>${vm.noticeCopy?`<p class="h10-host-message" role="status">${esc(vm.noticeCopy)}</p>`:''}`);
  return shell(vm,ctx,heading(title,sub)+`<section class="h10-card h10-card-accent h10-receive"><div class="h10-media h10-art h10-receive-art" data-asset-key="credentialCopy" data-asset-role="illustration" role="img" aria-label="${esc(uiText("ui.h10.assets.credentialCopyAlt"))}">${copyArt()}</div>${message&&!['received','error','expired'].includes(status)?`<p class="h10-receive-message" role="status">${esc(message)}</p>`:''}${statusLine}</section>${paste}<nav class="h10-quiet-links" aria-label="${esc(uiText("ui.h10.views.connectionMoreActions"))}">${renew?'':link(uiText("ui.h10.views.backToSite"),'back-to-work')}${vm.canVerifyPairing===true?link(uiText("ui.h10.host.verifyPairing"),'verify-pairing'):''}${link(uiText("ui.h10.views.useDifferentConnection"),'change-route')}</nav>${vm.noticeCopy?`<p class="h10-host-message" role="status">${esc(vm.noticeCopy)}</p>`:''}`);
}

export function connectCard(vm,ctx,{primary=true}={}) {
  // Route-qualified media is mandatory; no Site inference from old OpenAI images.
  const connectKey=vm.connectAssetKey||'siteConnect';
  const permissionKey=vm.permissionAssetKey||'sitePermissions';
  // 1068 第 101 条（Claude）：「打开插件设置」放在两张图正下方、居中；重新检查 Site 的结果写在卡片里，不再是窗口顶上那条。
  const tone=['checking','healthy','unhealthy','failed'].includes(vm.siteCheckState)?vm.siteCheckState:'';
  const check=vm.siteCheckCopy?`<p class="h10-connect-status" role="status"${tone?` data-state="${tone}"`:''}>${tone==='checking'?'<span class="h10-spin" aria-hidden="true"></span>':''}${esc(vm.siteCheckCopy)}</p>`:'';
  return `<section class="h10-card h10-connect"><div class="h10-connect-media">${manualSiteView(vm)?siteTutorial(connectKey)+siteTutorial(permissionKey):media(connectKey,vm,ctx)+media(permissionKey,vm,ctx)}</div><div class="h10-connect-actions">${button(uiText("ui.h10.views.openPluginSettings"),'open-plugin-settings',primary,false,'','l')}<p>${esc(uiText("ui.h10.views.connectionPermission"))}</p></div>${check}</section>`;
}

function siteIssue(vm) {
  // 1052 C3-7（Claude）：按 Site 那一行的 reason 显示一句话和对应的按钮。
  // 1069（Claude）：被别的电脑改连走了有两个出口（新建一个 Site／改用 OpenAI 通道），第二个是次按钮。
  const i=vm.siteIssue;
  if(!i?.copy) return '';
  const actions=(i.action&&i.label?button(i.label,i.action,true):'')+(i.action2&&i.label2?button(i.label2,i.action2,false,false,'','l'):'');
  return `<section class="h10-card h10-issue" role="alert"><p>${esc(i.copy)}</p>${actions?`<div class="h10-issue-actions">${actions}</div>`:''}</section>`;
}

// 1068 第 101 条（Claude）：「重新检查 Site 连接」「换一种连接」改成卡片下面一行灰色小链接（原来是贴在窗口底边的两个按钮）。
function connectLinks(vm) {
  const links=(vm.canRecheckSite===true?link(uiText("ui.h10.views.recheckSite"),'recheck-site',vm.siteCheckState==='checking'):'')+link(uiText("ui.h10.views.useDifferentConnection"),'change-route');
  return `<nav class="h10-quiet-links" aria-label="${esc(uiText("ui.h10.views.connectionMoreActions"))}">${links}</nav>`;
}

function connect(vm,ctx) {
  // ChatGPT 正在帮你配：这一页主要是「回到 ChatGPT」，自己连的步骤收起来，要看再点开。
  // 一屏只有一个主按钮：折叠块里的「打开插件设置」用普通按钮。
  if(vm.assistedTop===true) return shell(vm,ctx,assistedHeading()+siteIssue(vm)+`<details class="h10-card h10-manual-fold"><summary>${esc(uiText("ui.h10.views.manualConnectSummary"))}</summary>${connectCard(vm,ctx,{primary:false})}</details>`+connectLinks(vm));
  return shell(vm,ctx,heading(uiText("ui.h10.views.connectionTitle"),uiText("ui.h10.views.connectionAutomaticCompletion"))+siteIssue(vm)+connectCard(vm,ctx)+connectLinks(vm));
}

function completion(vm,ctx) {
  // This is a presentation boundary, NOT a verifier. Host must derive this view
  // from current-installation/current-binding connection_check evidence.
  if (vm.completionView!=='current-installation-verified' && !(ctx.review && vm.completionView==='design-example')) throw new TypeError('F15 requires an explicit completion view.');
  if (!['computer','folder'].includes(vm.scope)) throw new TypeError('F15 requires the current approved scope.');
  const folder=vm.scope==='folder';
  // 1068（Claude，Ken 10/20）：下面两块设置左右并排、一样高。左边「AI 能碰多大范围」是两张能点的选项卡（跟「换一种连接方式」弹框一个样子），
  // 右边是三行开关；文件夹模式下保留实际状态并说明这里不可更改。
  // 「安全与隐私」放在范围那块的右上角：它打开的是设置里「权限与能力」那一段，跟这两块是一回事，跟底下两个按钮没关系。
  // 「试试这句」那块不要了（Ken 10/20）：底下「打开 ChatGPT」点了直接打开、把试用的话填好。
  const option=(value,label,note,checked,tag='')=>`<label class="h10-option"><input type="radio" name="h10-scope" value="${value}" data-action="scope-request"${checked?' checked':''}><span class="h10-option-text"><span class="h10-option-name">${esc(label)}${tag?`<span class="h10-chip">${esc(tag)}</span>`:''}</span><span class="h10-option-note">${esc(note)}</span></span></label>`;
  const scope=`<section class="h10-card h10-scope" role="radiogroup" aria-labelledby="h10ScopeTitle"><div class="h10-card-head"><h3 id="h10ScopeTitle">${esc(uiText("ui.h10.views.scopeTitle"))}</h3>${link(uiText("ui.h10.views.safetyPrivacy"),'privacy')}</div><div class="h10-options">${option('computer',uiText("ui.h10.views.computerScope"),uiText("ui.h10.views.computerScopeExplanation"),!folder,uiText("ui.h10.views.recommended"))}${option('folder',uiText("ui.h10.views.folderScope"),uiText("ui.h10.views.folderScopeExplanation"),folder)}</div></section>`;
  const capability=(key,name,note,on,action,disabled,configured)=>{
    const tip=`h10-${key}-folder-tip`;
    const control=`<button type="button" class="switch" role="switch" data-action="${action}" aria-checked="${(folder?configured:on)===true}" aria-label="${esc(name)}"${folder?` aria-disabled="true" aria-describedby="${tip}"`:disabled?' disabled':''}></button>`;
    return `<div class="h10-capability${folder?' is-blocked':''}">${key==='admin'?'<div class="h10-media h10-capability-icon" aria-hidden="true"><svg class="h10-capability-symbol" viewBox="0 0 24 24"><use href="#i-key"/></svg></div>':media(key,vm,ctx,'h10-capability-icon')}<span class="h10-capability-text"><span class="h10-capability-name">${esc(name)}</span><span class="h10-capability-note">${esc(note)}</span></span><span class="h10-switch-wrap">${control}${folder?`<span class="h10-switch-tip" role="tooltip" id="${tip}">${esc(uiText(key==='admin'?"ui.h10.views.folderAdminUnavailable":"ui.h10.views.folderCapabilityUnavailable"))}</span>`:''}</span></div>`;
  };
  const adminNote=!folder&&vm.adminEnabled&&!vm.adminReady?uiText("ui.window.pgTerminal.text5"):uiText("ui.wizard.adminPasswordExplanation");
  const caps=`<section class="h10-card h10-capabilities"><div class="h10-card-head"><h3>${esc(uiText("ui.h10.views.optionalCapabilities"))}</h3></div><div class="h10-capability-list">${capability('browserControl',uiText("ui.h10.views.browserControl"),vm.browserCapabilityCopy||uiText("ui.h10.views.browserExtensionRequired"),vm.browserReady,'browser-capability',vm.browserCapabilityDisabled===true,vm.browserEnabled)}${capability('desktopControl',uiText("ui.h10.views.desktopControl"),vm.desktopCapabilityCopy||uiText("ui.h10.views.desktopPermissionsRequired"),vm.desktopReady,'desktop-capability',vm.desktopCapabilityDisabled===true,vm.desktopEnabled)}${capability('admin',uiText("ui.wizard.softwareAndSettings"),adminNote,vm.adminEnabled,'admin-capability',vm.adminCapabilityDisabled===true,vm.adminEnabled)}</div></section>`;
  const t=vm.doneMarkElapsed,animate=Number.isFinite(t)&&t>=0&&t<700;
  return shell(vm,ctx,`<div class="h10-complete-mark${animate?' h10-done-animate':''}"${animate?` style="--h10-done-t:${-Math.round(t)}ms"`:''} aria-hidden="true">${manualSiteView(vm)?`<img class="h10-site-done" src="${siteAsset('done')}" alt="">`:doneMark}</div>${heading(uiText("ui.h10.views.completionTitle"),uiText("ui.h10.views.completionIntroduction",{app:vm.appName||'ChatHand'}))}<div class="h10-completion-cards"><div class="h10-settings">${scope}${caps}</div></div><footer class="h10-footer">${button(uiText("ui.h10.views.openChatGPT"),'open-chatgpt',true)}${button(uiText("ui.h10.views.finish"),'finish',false,false,'','l')}</footer>${vm.manualSwitchTo&&vm.manualSwitchLabel?`<nav class="h10-quiet-links" aria-label="${esc(uiText("ui.h10.views.connectionMoreActions"))}"><button type="button" class="h10-link" data-action="manual-switch" data-value="${esc(vm.manualSwitchTo)}">${esc(vm.manualSwitchLabel)}</button></nav>`:''}`,'h10-completion');
}

function launchState(vm) {
  if(vm.launchState==='opening') return uiText("ui.h10.views.openingChatGPT");
  if(vm.launchState==='fallback') return uiHTML("ui.h10.views.chatGPTMissing", {link: trustedHTML(link(uiText("ui.h10.views.download"),'download-chatgpt',!vm.chatgptDownloadConfigured))});
  return '';
}

function release(vm,ctx) {
  // 1081 N203（Claude）：旧私有发布桥退役；只有本地 DMG 交接（或离线页里挂载盘旁的 App）能让「ChatGPT 帮我装」可点。
  const configured=installationHandoff(vm.installLocation).configured||vm.releaseActionHandledByHost===true;
  const points=[['releaseSource',uiText("ui.h10.views.releaseSourceTitle"),uiText("ui.h10.views.releaseSourceExplanation")],['releaseVerify',uiText("ui.h10.views.verificationTitle"),uiText("ui.h10.views.verificationExplanation")],['releasePrivacy',uiText("ui.h10.views.privacyTitle"),uiText("ui.h10.views.privacyExplanation")],['releaseLimits',uiText("ui.h10.views.limitsTitle"),uiText("ui.h10.views.limitsExplanation")]];
  return `<section class="h10 h10-release"><header class="h10-release-header">${brand(vm,ctx,uiText("ui.h10.views.desktopAssistant"))}<nav aria-label="${esc(uiText("ui.h10.views.releaseNavigation"))}">${link('GitHub ↗','release-source',!vm.sourceURLConfigured)}${link(uiText("ui.h10.views.verifyPackage"),'verify-package',!vm.verificationConfigured)}</nav></header><main><div class="h10-release-hero"><div><h1>${esc(uiText("ui.h10.views.releaseTitle"))}</h1><p class="h10-release-lead">${esc(uiText("ui.h10.views.releaseLead"))}</p><div class="h10-release-actions">${button(uiText("ui.h10.views.installAssisted"),'install-assisted',true,!configured)}${link(uiText("ui.h10.views.downloadManually"),'download-package',!vm.downloadConfigured)}</div><div class="h10-release-state" role="status">${launchState(vm)}</div></div>${media('people',vm,ctx)}</div><div class="h10-release-points">${points.map(([key,title,copy])=>`<article class="h10-card h10-release-point">${media(key,vm,ctx)}<h3>${title}</h3><p>${copy}</p></article>`).join('')}</div><footer class="h10-release-foot"><details><summary>${esc(uiText("ui.h10.views.gatekeeperQuestion"))}</summary>${vm.gatekeeperExplanationCopy?`<p>${esc(vm.gatekeeperExplanationCopy)}</p>`:ctx.review?`<p data-copy-gap="gatekeeper-explanation">${esc(uiText("ui.h10.views.gatekeeperCopyPending"))}</p>`:''}</details><p>${esc(uiText("ui.h10.views.systemRequirements"))}</p></footer></main></section>`;
}

function firstOpen(vm,ctx) {
  const keys=['gatekeeperDone','gatekeeperOpen','gatekeeperConfirm'];
  const selected=keys.includes(vm.guideMedia)?vm.guideMedia:keys[0];
  const current=keys.indexOf(selected);
  const steps=[uiText("ui.h10.views.gatekeeperDoneStep"),uiText("ui.h10.views.gatekeeperSettingsStep"),uiText("ui.h10.views.gatekeeperConfirmStep")];
  const configured=installationHandoff(vm.installLocation).configured||vm.releaseActionHandledByHost===true;
  // Only the static offline F5 gets a manual guide; native App keeps its fixed Settings action.
  const settingsControl=vm.offlineManualPrivacySettings===true
    ? `<p class="h10-system-manual">${esc(uiText("ui.h10.views.offlineSettingsExplanation"))}</p>`
    : button(uiText("ui.h10.views.openPrivacySettings"),'open-privacy-settings',true);
  return `<section class="h10 h10-first-open"><header class="h10-first-open-header"><h1>${esc(uiText("ui.h10.views.firstOpenTitle"))}</h1><p>${esc(uiText("ui.h10.views.firstOpenExplanation"))}</p></header><main class="h10-first-open-grid"><section class="h10-card h10-system"><div class="h10-system-heading"><h2>${esc(uiText("ui.h10.views.releaseMacSettings"))}</h2>${link(uiText("ui.h10.views.findHelp"),'gatekeeper-help')}</div>${media(selected,vm,ctx)}${thumbs(keys,selected,vm,ctx,'system-guide-step')}<ol class="h10-system-steps">${steps.map((copy,i)=>`<li${current===i?' aria-current="step"':''}><span class="h10-instruction-num">${i+1}</span> ${copy}</li>`).join('')}</ol>${settingsControl}</section><div class="h10-first-alts"><section class="h10-card h10-first-alt"><h2>${esc(uiText("ui.h10.views.assistedInstallTitle"))}</h2>${media('assisted',vm,ctx)}<p>${esc(uiText("ui.h10.views.assistedInstallExplanation"))}</p>${button(uiText("ui.h10.views.openChatGPTAttempt"),'install-assisted',true,!configured)}<small>${esc(uiText("ui.h10.views.desktopRequirement"))}</small>${vm.launchState?`<div class="h10-release-state" role="status">${launchState(vm)}</div>`:''}</section><div class="h10-or" role="separator"><span>${esc(uiText("ui.h10.views.or"))}</span></div><section class="h10-card h10-first-alt"><h2>${esc(uiText("ui.h10.views.terminalTitle"))}</h2><code class="h10-first-terminal">${esc(vm.terminalCommand || (ctx.review?uiText("ui.h10.views.terminalCommandPending"):''))}</code>${button(uiText("ui.h10.views.copyTerminal"),'copy-terminal-command',false,!vm.terminalCommand)}<small>${esc(uiText("ui.h10.views.terminalPasteHelp"))}</small></section></div></main><footer class="h10-first-footer"><p>${esc(uiText("ui.h10.views.macOS14OpenHelp"))}</p>${link(uiText("ui.h10.views.verifyPackage"),'verify-package',!vm.verificationConfigured)}</footer></section>`;
}

const renderers={f1:release,f5:firstOpen,f6:welcome,f7:progress,f10:workSetup,f11:credentialReceive,f12:connect,f15:completion};

/** Stateless views. All copy inputs are trusted approved text, never grant contents.
 * setupMode, connectionActor, and connectionRoute remain independent axes.
 * Host owns authorization, routing, timing, clipboard, authentication and receipts.
 */
export function renderH10(vm,{assets=defaultAssets,review=false}={}) {
  if(vm.provenance==='design-example' && !review) throw new TypeError('Design fixtures cannot mount in a production view.');
  if(!['site','openai'].includes(vm.connectionRoute)) throw new TypeError('Explicit connectionRoute required.');
  const render=renderers[vm.screen];
  if(!render) throw new TypeError('Unknown H10 screen.');
  return render(vm,{assets,review});
}

/** No global listener, no service call, no window navigation, no secret read.
 * Controlled radio values revert until the host supplies an accepted view model.
 */
export function mountH10(root,vm,options={}) {
  const focused=root.ownerDocument?.activeElement;
  const guideFocus=manualSiteView(vm)&&root.contains(focused)&&focused?.dataset?.action==='work-guide-step'
    ?{navigation:!!focused.closest('.h10-site-guide-nav'),value:focused.dataset.value}:null;
  root.innerHTML=renderH10(vm,options);
  if(guideFocus){
    const next=guideFocus.navigation?root.querySelector('.h10-site-guide-nav button')
      :root.querySelector(`.h10-site-guide-dots [data-value="${guideFocus.value==='1'?'1':'0'}"]`);
    next?.focus({preventScroll:true});
  }
  const emit=(action,value)=>{
    const detail=Object.freeze({action,value});
    options.onAction?.(detail);
    root.dispatchEvent(new CustomEvent('h10:action',{detail,bubbles:true}));
  };
  const click=event=>{
    const target=event.target.closest('button[data-action]');
    if(!target || !root.contains(target) || target.disabled || target.getAttribute('aria-disabled')==='true') return;
    event.preventDefault();emit(target.dataset.action,target.dataset.value ?? null);
  };
  const change=event=>{
    const target=event.target;
    if(!target.matches('input[data-action="scope-request"]')) return;
    const requested=target.value;
    root.querySelectorAll('input[name="h10-scope"]').forEach(input=>{input.checked=input.value===vm.scope;});
    emit('scope-request',requested);
  };
  root.addEventListener('click',click);root.addEventListener('change',change);
  return ()=>{root.removeEventListener('click',click);root.removeEventListener('change',change);};
}
