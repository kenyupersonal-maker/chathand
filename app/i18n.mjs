import fs from 'node:fs';

// Module-relative in source and Contents/Resources/runtime/app in every bundle.
const read=language=>{
 try{return JSON.parse(fs.readFileSync(new URL(`../locales/${language}.json`,import.meta.url),'utf8'));}
 catch{console.error(`[i18n] I18N_CATALOG_UNAVAILABLE ${language}`);return {};}
};
export const catalogs=Object.freeze({zh:Object.freeze(read('zh')),en:Object.freeze(read('en'))});
export function normalizeLocale(value){
 const first=Array.isArray(value)?value[0]:value;
 if(typeof first!=='string'||first.length>128)return 'zh';
 const language=first.trim().replaceAll('_','-').toLowerCase();
 return /^en(?:-[a-z0-9]+)*$/.test(language)?'en':'zh';
}
const placeholders=value=>[...new Set([...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(m=>m[1]))].sort();
export function validateCatalogs({zh,en},requiredKeys=[]){
 if(!zh||!en||Array.isArray(zh)||Array.isArray(en)||typeof zh!=='object'||typeof en!=='object')throw Error('I18N_CATALOG_INVALID');
 if(!Object.keys(zh).length)throw Error('I18N_CHINESE_MISSING catalog');
 for(const key of new Set([...Object.keys(zh),...Object.keys(en),...requiredKeys])){
  if(!/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9_]*)*$/.test(key))throw Error(`I18N_KEY_INVALID ${key}`);
  if(typeof zh[key]!=='string'||!zh[key].trim())throw Error(`I18N_CHINESE_MISSING ${key}`);
  if(en[key]!==undefined&&typeof en[key]!=='string')throw Error(`I18N_ENGLISH_INVALID ${key}`);
  if(en[key]?.trim()&&JSON.stringify(placeholders(zh[key]))!==JSON.stringify(placeholders(en[key])))throw Error(`I18N_PLACEHOLDER_MISMATCH ${key}`);
 }
 return true;
}
export function createTranslator(tables,{diagnostic=event=>console.error(`[i18n] ${event.code} ${event.key}`)}={}){
 return (key,params={},locale='zh')=>{
  const chinese=tables.zh[key];
  if(typeof chinese!=='string'||!chinese.trim()){diagnostic({code:'I18N_KEY_MISSING',key});return key;}
  const english=tables.en?.[key];
  const sentence=normalizeLocale(locale)==='en'&&typeof english==='string'&&english.trim()?english:chinese;
  // A single pass, only declared placeholders; values are never interpreted as HTML.
  return sentence.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g,(literal,name)=>Object.hasOwn(params,name)?String(params[name]):literal);
 };
}
// Native launcher supplies Locale.preferredLanguages (not browser locale). This
// synchronous read never launches a process or waits in connection/notification paths.
export function systemLocale({preferredLanguages}={}){
 return normalizeLocale(preferredLanguages!==undefined?preferredLanguages:process.env.CHATHAND_SYSTEM_LOCALE);
}
export const t=createTranslator(catalogs);
export const localText=(key,params={})=>t(key,params,systemLocale());
// Host passes locale explicitly. No Mac/browser language is used for cards.
export function cardText(hostLocale){
 const locale=normalizeLocale(hostLocale);
 return {locale,texts:Object.fromEntries(Object.keys(catalogs.zh).filter(key=>key.startsWith('card.')).map(key=>[key,t(key,{},locale)]))};
}
