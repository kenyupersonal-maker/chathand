/** ONE1052: Source-only F1/F5/DMG offline source.
 * Rendering runs in a packaging step (not at runtime); output embeds styles and
 * approved media, with no file:// imports, test fixtures, or fabricated URL.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {uiText} from '../local-text.mjs';
import {createDmgText,localizeTemplate,assertSelfContained} from '../assets/dmg/src/localize.mjs';
import {renderH10} from './views.mjs';
import {assets} from './assets.mjs';
import {installationHandoff,INSTALL_PROMPT_TEMPLATE} from './prompts.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const firstOpenSource=path.resolve(root,'../assets/dmg/src');
const MIME={'.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'};
function safeAsset(source){
 if(typeof source!=='string'||!source.startsWith('./assets/')||source.split('/').includes('..'))throw Error('H10_OFFLINE_ASSET_INVALID');
 const file=path.resolve(root,source),assetRoot=path.join(root,'assets');
 const real=fs.realpathSync(file);
 if(!real.startsWith(fs.realpathSync(assetRoot)+path.sep)||!fs.lstatSync(file).isFile())throw Error('H10_OFFLINE_ASSET_SCOPE');
 const mime=MIME[path.extname(file)];if(!mime)throw Error('H10_OFFLINE_ASSET_TYPE');
 return 'data:'+mime+';base64,'+fs.readFileSync(file).toString('base64');
}
function offlineAssets(){
 return Object.freeze(Object.fromEntries(Object.entries(assets).map(([k,asset])=>[
  k,{...asset,src:safeAsset(asset.src),
   ...(asset.presentation?.kind==='source-html-layers'?{presentation:{
    ...asset.presentation,
    base:{...asset.presentation.base,src:safeAsset(asset.presentation.base.src)},
    callout:{...asset.presentation.callout,src:safeAsset(asset.presentation.callout.src)}
   }}:{})}
 ])));
}
function approvedLocation(release){
 // Future release pipeline must supply verified metadata. No raw URL, untrusted
 // package filename, model text, or dummy Site identity qualifies as approval.
 if(release==null)return {};
 if(release.verified_by_release_pipeline!==true)throw Error('H10_RELEASE_NOT_VERIFIED');
 if(Object.keys(release).some(k=>!['verified_by_release_pipeline','downloadURL','localPath'].includes(k)))throw Error('H10_RELEASE_FIELDS_INVALID');
 const hasDownload=typeof release.downloadURL==='string'&&/^https:\/\/[^\s]+$/.test(release.downloadURL);
 const hasLocal=typeof release.localPath==='string'&&release.localPath.startsWith('/')&&!/[\r\n\0]/.test(release.localPath);
 if(hasDownload===hasLocal)throw Error('H10_RELEASE_LOCATION_INVALID');
 return hasDownload?{downloadURL:release.downloadURL}:{localPath:release.localPath};
}
// 1081 N203（Claude）：旧的私有发布桥（Site 上 /release/bridge）退役。旧桥那种 release 写法
// （site_origin、bridge_path…）不再认，跟别的未核验来源一样在 approvedLocation 里报 H10_RELEASE_NOT_VERIFIED。

const escapeScriptJSON=x=>JSON.stringify(x).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
const escapeHTML=x=>String(x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function doc(title,body,script){
 const theme=fs.readFileSync(path.join(firstOpenSource,'h10-offline-theme.css'),'utf8');
 const css=fs.readFileSync(path.join(root,'h10.css'),'utf8');
 return '<!doctype html><html lang="'+(globalThis.__CHATHAND_TEXT_STATE__?.locale==='en'?'en':'zh-CN')+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+
  escapeHTML(title)+'</title><style>'+theme+'\n'+css+
  '\n.h10-offline-status{max-width:1100px;margin:0 auto;padding:14px 36px;color:var(--ink-2);font-size:13px}'+
  '.h10-offline-status:empty{display:none}.h10-offline-disabled{padding:10px 30px;color:var(--o-ink)}'+
  '</style></head><body><p id="h10-offline-status" class="h10-offline-status" role="status"></p><div id="h10-offline-root">'+body+
  '</div><script>'+script+'</script></body></html>';
}
export function renderOfflinePage({screen,release=null,localAppCandidate=false}={}){
 if(!['f1','f5'].includes(screen))throw Error('H10_OFFLINE_SCREEN_INVALID');
 const location=approvedLocation(release),handoff=installationHandoff(location),sourceAssets=offlineAssets();
 const base={provenance:'host',screen,connectionRoute:'site',setupMode:'manual',
  offlineManualPrivacySettings:screen==='f5',
  installLocation:location,releaseActionHandledByHost:Boolean(localAppCandidate),
  verificationConfigured:false,sourceURLConfigured:false,
  downloadConfigured:false,chatgptDownloadConfigured:false,terminalCommand:null,
  guideMedia:'gatekeeperDone',launchState:'idle'};
 // Pre-render the three original Gatekeeper frames; user interaction only
 // chooses which approved layer to show. Nothing is fetched from file://.
 const images=screen==='f5'?['gatekeeperDone','gatekeeperOpen','gatekeeperConfirm']:[null];
 const frames=images.map(key=>renderH10({...base,...(key?{guideMedia:key}:{})},{assets:sourceAssets,review:false}));
 const script='(()=>{\n'+
  'const pages='+escapeScriptJSON(frames)+';\n'+
  'const handoff='+escapeScriptJSON(handoff)+';\n'+
  'const useLocalCandidate='+escapeScriptJSON(localAppCandidate===true)+';\n'+
  'const canonicalTemplate='+escapeScriptJSON(INSTALL_PROMPT_TEMPLATE)+';\n'+
  'const status=document.getElementById("h10-offline-status"),root=document.getElementById("h10-offline-root");\n'+
  'const say=text=>{status.textContent=text};\n'+
  'const copy=async text=>{try{await navigator.clipboard.writeText(text);return true}catch(e){}'+
   'const a=document.createElement("textarea");a.value=text;document.body.append(a);a.select();'+
   'let ok=false;try{ok=document.execCommand("copy")}catch(e){}a.remove();return ok};\n'+
  'function mountedApp(){if(!useLocalCandidate||location.protocol!=="file:")return null;'+
   'let file;try{file=decodeURIComponent(location.pathname)}catch{return null;}'+
   'if(!file.startsWith("/Volumes/")||!file.endsWith(".html")||file.includes("\\0"))return null;'+
   'const end=file.lastIndexOf("/");if(end<=9)return null;return file.slice(0,end)+"/ChatHand.app";}\n'+
  'let opened=false;async function launch(){let h=handoff;'+
   'if(!h.configured){const local=mountedApp();if(local){const prompt=canonicalTemplate.replace('+escapeScriptJSON(uiText('ui.h10.prompts.downloadLocationPlaceholder'))+',()=>local);'+
   'h={configured:true,prompt,deepLink:"codex://new?prompt="+encodeURIComponent(prompt)};}}'+
   'if(!h.configured||!h.deepLink){say('+escapeScriptJSON(uiText('ui.offline.installSourceMissing'))+');return;}'+
   'const copied=await copy(h.prompt);opened=true;'+
   'try{location.href=h.deepLink}catch(e){}'+
   'say(copied?'+escapeScriptJSON(uiText('ui.offline.launchCopied'))+':'+escapeScriptJSON(uiText('ui.offline.launchCopyUnconfirmed'))+');'+
   'setTimeout(()=>{if(!document.hidden){say('+escapeScriptJSON(uiText('ui.offline.launchNoFeedback'))+')}},2000)}\n'+
  'document.addEventListener("click",async event=>{const button=event.target.closest("button[data-action]");if(!button||button.disabled)return;'+
   'const action=button.dataset.action;switch(action){'+
    'case "system-guide-step":{const i=Number(button.dataset.value);if(i>=0&&i<pages.length){root.innerHTML=pages[i]}return;}'+
    'case "install-assisted":await launch();return;'+
    'case "open-privacy-settings":say('+escapeScriptJSON(uiText('ui.offline.openPrivacySettings'))+');return;'+
    'case "gatekeeper-help":say('+escapeScriptJSON(uiText('ui.offline.gatekeeperHelp'))+');return;'+
    'case "download-package":say('+escapeScriptJSON(uiText('ui.offline.downloadMissing'))+');return;'+
    'case "verify-package":say('+escapeScriptJSON(uiText('ui.offline.verifySignature'))+');return;'+
    'case "release-source":say('+escapeScriptJSON(uiText('ui.offline.sourceMissing'))+');return;'+
    'case "copy-terminal-command":say('+escapeScriptJSON(uiText('ui.offline.terminalCommandMissing'))+');return;'+
    'default:say('+escapeScriptJSON(uiText('ui.offline.actionRequiresApp'))+');return;'+
   '}});\n'+
  // Entry F1 in a generated approved release attempts the desktop link only
  // after a genuine verified descriptor exists. No auto-send or claimed success.
  (screen==='f1'?'if(handoff.configured||(useLocalCandidate&&mountedApp()))setTimeout(()=>void launch(),300);\n':'')+
  'if(!handoff.configured&&!useLocalCandidate)say('+escapeScriptJSON(uiText('ui.offline.sourceTemplateDisabled'))+');'+
  'else if(useLocalCandidate)say('+escapeScriptJSON(uiText('ui.offline.localCandidate'))+');\n})();';
 return doc(screen==='f1'?uiText('ui.offline.installTitle'):uiText('ui.offline.firstOpenTitle'),frames[0],script);
}

export function renderDmgArtwork(options={}){
 const text=createDmgText(options);
 // Only F4 source art; real ChatHand.app and Applications alias are supplied
 // separately by Finder and are never painted into the background.
 let html=fs.readFileSync(path.join(firstOpenSource,'background.template.html'),'utf8');
 const version=JSON.parse(fs.readFileSync(path.resolve(root,'../../package.json'),'utf8')).version;
 if(!html.includes('width:698px;height:718px')||!html.includes('@VERSION@'))throw Error('H10_DMG_F4_SOURCE_CHANGED');
 html=localizeTemplate(html,text,{'@VERSION@':escapeHTML(version)});
 assertSelfContained(html);
 return html;
}
