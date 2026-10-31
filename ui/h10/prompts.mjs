import {uiText,subscribe} from '../local-text.mjs';
/** Approved H10 sentence; one source for F1 / DMG / F5 / welcome / zip handoff.
 * The renderer does not open URLs, copy text, switch Work, or send anything.
 */
export const INSTALL_DEEP_LINK_PREFIX='codex://new?prompt=';
export let INSTALL_PROMPT_TEMPLATE = uiText("ui.h10.prompts.installPrompt", {location: uiText("ui.h10.prompts.downloadLocationPlaceholder")});

subscribe(()=>{INSTALL_PROMPT_TEMPLATE=uiText("ui.h10.prompts.installPrompt", {location: uiText("ui.h10.prompts.downloadLocationPlaceholder")});});

export function installationPrompt({ downloadURL, localPath } = {}) {
  if (downloadURL && localPath) throw new TypeError('Choose downloadURL OR localPath.');
  const location = localPath || downloadURL;
  if (location != null && typeof location !== 'string') throw new TypeError('Location must be a string.');
  return uiText("ui.h10.prompts.installPrompt", {location: location || uiText("ui.h10.prompts.downloadLocationPlaceholder")});
}

/** Only a prepared descriptor. Missing location produces no runnable deep link.
 * Approved H10 scheme differs from legacy codex://threads/new?prompt=… .
 * Official ChatGPT desktop documentation confirms this compatibility scheme and
 * prompt-to-draft support (provided DEEP-LINK-TARGET-FACTS.md). This artifact does
 * not launch it or verify the target UI, Work selection, or runtime prefill.
 */

/** F10 is an owner-private Site creation handoff, never a DMG install handoff.
 * A missing approved signed template or pairing hash is an explicit blocker.
 * This UI consumes only the trusted, locally verified release descriptor.
 */
export const SITE_TEMPLATE_FALLBACK_REASONS = Object.freeze({
 DOWNLOAD_FAILED:'download_failed',
 CAPABILITY_UNAVAILABLE:'capability_unavailable'
});

function verifiedSiteTemplateSource(input){
 const d=input&&typeof input==='object'&&!Array.isArray(input)?input:{};
 const local=d.source_kind==='bundled_local';
 if(d.verified_source!==true||typeof d.template_sha256!=='string'||!/^[a-f0-9]{64}$/.test(d.template_sha256))return null;
 let url;
 if(local){if(d.template_file!=='chathand-site-template-1060-local.zip'||'template_url' in d)return null;}
 else{
  if(d.source_kind!==undefined&&d.source_kind!=='remote')return null;
  try{url=new URL(d.template_url);}catch{return null;}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search||!['github.com','raw.githubusercontent.com'].includes(url.hostname))return null;
 }
 return {source:local?'signed_local_site_template':'signed_site_template',sourceKind:local?'bundled_local':'remote',templateURL:local?null:url.href,sha256:d.template_sha256};
}
export function siteCreationHandoff(input={}){
 const d=input&&typeof input==='object'&&!Array.isArray(input)?input:{};
 const invalid={configured:false,prompt:null,reason:'SITE_TEMPLATE_RELEASE_NOT_VERIFIED',
  needs:[uiText("ui.h10.prompts.verifiedTemplateNeeded"),uiText("ui.h10.prompts.templateShaNeeded"),uiText("ui.h10.prompts.pairingHashNeeded")],userMustSubmit:true};
 const source=verifiedSiteTemplateSource(d);
 if(!source||typeof d.pairing_hash!=='string'||!/^[a-f0-9]{64}$/.test(d.pairing_hash))return invalid;
 const prompt=source.sourceKind==='bundled_local'?uiText("ui.h10.prompts.localCreateSitePrompt", {templateSha:source.sha256,pairingHash:d.pairing_hash}):
  uiText("ui.h10.prompts.createSitePrompt", {templateURL:source.templateURL,templateSha:source.sha256,pairingHash:d.pairing_hash});
 return Object.freeze({configured:true,prompt,...source,pairingHash:d.pairing_hash,userMustSubmit:true,
   fallbackReason:d.download_failed===true?SITE_TEMPLATE_FALLBACK_REASONS.DOWNLOAD_FAILED:
     d.capability_unavailable===true?SITE_TEMPLATE_FALLBACK_REASONS.CAPABILITY_UNAVAILABLE:null});
}

export function installationHandoff(options = {}) {
  const prompt = installationPrompt(options);
  const configured = Boolean(options.downloadURL || options.localPath);
  return Object.freeze({ prompt, configured, deepLink: configured ? `${INSTALL_DEEP_LINK_PREFIX}${encodeURIComponent(prompt)}` : null, copy: 'silent', fallbackAfterMs: 2000, userMustSubmit: true });
}

/** 1052 C3-6（Claude）：用户把 ChatHand 放进「下载」的模板 zip 拖进 Work 以后，跟着发的这句。 */
export function siteTemplateFileFollowup(input={}){
 const h=siteCreationHandoff(input);
 if(h.configured!==true)return null;
 return uiText("ui.h10.prompts.templateFollowupPrompt", {sha256: h.sha256, pairingHash: h.pairingHash});
}

/** 1052 C6（Claude）：欢迎页「让 ChatGPT 帮我配」复制的一句话。点名设置技能；跑不了本机命令就退回 Work 给代码那条路。 */
export function siteAssistedSentence(input={}){
 const h=siteCreationHandoff(input);
 if(h.configured!==true)return null;
 return h.sourceKind==='bundled_local'?uiText("ui.h10.prompts.localAssistedSitePrompt", {sha256:h.sha256,pairingHash:h.pairingHash}):
  uiText("ui.h10.prompts.assistedSitePrompt", {templateURL: h.templateURL, sha256: h.sha256, pairingHash: h.pairingHash});
}

/** 1052 C3-7 / C6（Claude）：Site 报模板版本对不上时，交给 ChatGPT 的一句。只更新原来那个 Site。 */
export function siteUpdateHandoff(input={},origin=''){
 const h=verifiedSiteTemplateSource(input);let site;
 try{site=new URL(origin);}catch{return null;}
 if(!h||site.protocol!=='https:'||!site.hostname.endsWith('.chatgpt.site')||site.origin!==origin)return null;
 return h.sourceKind==='bundled_local'?uiText("ui.h10.prompts.localUpdateSitePrompt", {siteOrigin:site.origin,templateSha:h.sha256}):
  uiText("ui.h10.prompts.updateSitePrompt", {siteOrigin: site.origin, templateURL: h.templateURL, templateSha: h.sha256});
}

/** 1052 C3-7 / C4-7（Claude）：按 Site 那一行的状态给一句用户能照做的话。没有就回空。 */
export function siteRouteCopy(route={}){
 if(route?.configured!==true)return '';
 if(route.state==='auth_required')return uiText("ui.h10.prompts.credentialsExpired");
 if(route.reason==='B_TEMPLATE_MISMATCH')return uiText("ui.h10.prompts.templateMismatch");
 return '';
}

/** 1052 C4（Claude）：导入、配对没成时的话。代码来自原生或 server 的 error_code。 */
export const SITE_PAIRING_ERROR_COPY=Object.freeze({
 get B_PAIRING_INTENT_MISSING(){return uiText("ui.h10.prompts.pairingIntentMissing");},
 get B_PAIRING_INTENT_EXPIRED(){return uiText("ui.h10.prompts.pairingIntentExpired");},
 get B_CLIPBOARD_GRANT_INVALID(){return uiText("ui.h10.prompts.clipboardGrantInvalid");},
 get B_TEMPLATE_MISMATCH(){return uiText("ui.h10.prompts.templateMismatch");},
 get B_CREDENTIAL_REJECTED(){return uiText("ui.h10.prompts.credentialRejected");},
 get B_SITE_UNREACHABLE(){return uiText("ui.h10.prompts.siteUnreachable");},
 // 0010（Claude）：Mac mini 1062 续测——代码本身没问题，是原生那道「1 秒内亲手按 ⌘V」没过。别让人回去要新代码。1063 拿掉这道检查以后这句就不会再出现。
 get NATIVE_SITE_PASTE_GESTURE_REQUIRED(){return uiText("ui.h10.prompts.pasteGestureRequired");}
});
export function sitePairingErrorCopy(code){
 // 1070（Claude）：英文界面不用全角括号。
 const ok=typeof code==='string'&&/^[A-Z0-9_]{1,80}$/.test(code),en=globalThis.ChatHandText?.locale==='en';
 return SITE_PAIRING_ERROR_COPY[code]||uiText("ui.h10.prompts.pairingFailed", {errorSuffix: ok?(en?' ('+code+')':'（'+code+'）'):''});
}
