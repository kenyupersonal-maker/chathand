/** Build-only text adapter: explicit language, canonical catalogs, no OS/browser lookup. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..');
export const escapeHTML=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const scriptJSON=value=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
export function readCatalogs(){
 return Object.fromEntries(['zh','en'].map(locale=>[locale,JSON.parse(fs.readFileSync(path.join(repo,'locales',locale+'.json'),'utf8'))]));
}
export function createDmgText({locale='zh',catalogs=readCatalogs()}={}){
 if(!['zh','en'].includes(locale))throw Error('DMG_LOCALE_INVALID');
 const sentence=key=>{
  const chinese=catalogs.zh?.[key],english=catalogs.en?.[key];
  if(typeof chinese!=='string'||!chinese.trim())throw Error('DMG_CHINESE_MISSING '+key);
  return locale==='en'&&typeof english==='string'&&english.trim()?english:chinese;
 };
 const text=(key,params={})=>sentence(key).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g,(token,name)=>Object.hasOwn(params,name)?String(params[name]):token);
 return {locale,lang:locale==='en'?'en':'zh-CN',text,sentence,catalogs};
}
function richText(key,t){
 const kbd=value=>'<kbd>'+escapeHTML(value)+'</kbd>';
 const slots={
  searchKeys:'<span class="keys">'+kbd('⌘')+kbd(t.text('dmg.keyboard.space'))+'</span>',
  pasteKeys:'<span class="keys">'+kbd('⌘')+kbd('V')+'</span>',
  enterKey:kbd(t.text('dmg.keyboard.enter')),
  illustrationNote:'<small>'+escapeHTML(t.text('dmg.guide.illustrationNote'))+'</small>',
  openAnyway:'<span class="nb">'+escapeHTML(t.text('dmg.guide.openAnyway'))+'</span>',
  open:'<span class="nb">'+escapeHTML(t.text('dmg.guide.open'))+'</span>'
 };
 return escapeHTML(t.sentence(key)).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g,(_,name)=>{
  if(!Object.hasOwn(slots,name))throw Error('DMG_RICH_SLOT_INVALID '+name);
  return slots[name];
 });
}
export function localizeTemplate(html,t,values={}){
 // A single substitution pass prevents catalog text from becoming template source.
 return html.replace(/@(TEXT|JS|HTML):(dmg\.[A-Za-z0-9.]+)@|@([A-Z_]+)@/g,(token,mode,key,name)=>{
  if(name==='LANG')return t.lang;
  if(name)return Object.hasOwn(values,token)?values[token]:token;
  return mode==='JS'?scriptJSON(t.text(key)):mode==='HTML'?richText(key,t):escapeHTML(t.text(key));
 });
}
export function assertSelfContained(html){
 if(/@[A-Z_]+@|@(TEXT|JS|HTML):[^@]+@|codex:\/\/threads\/new|<script[^>]+src=|<link\b|https?:\/\//i.test(html))throw Error('H10_OFFLINE_UNRESOLVED_SOURCE');
}

export function catalogFingerprint(catalogs){
 const relevant=Object.fromEntries(['zh','en'].map(locale=>[locale,Object.fromEntries(Object.entries(catalogs[locale]||{}).filter(([key])=>key.startsWith('dmg.')||['ui.h10.prompts.installPrompt','ui.h10.prompts.downloadLocationPlaceholder'].includes(key)).sort(([a],[b])=>a<b?-1:a>b?1:0))]));
 return crypto.createHash('sha256').update(JSON.stringify(relevant)).digest('hex');
}
export const sourceFiles=['ui/h10/offline.mjs','ui/h10/prompts.mjs',...['background.template.html','jump.template.html','first-open.template.html','system-guide.html','theme.css','localize.mjs','generate.mjs','render.mjs','install-command.txt','codexdoc.svg','helpdoc.svg'].map(name=>'ui/assets/dmg/src/'+name)];
