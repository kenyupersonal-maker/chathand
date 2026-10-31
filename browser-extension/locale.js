import {catalogs} from './locale-catalogs.js';

// Only the native port may supply OS language. Browser/page language is unrelated.
let language = {locale:'zh',source:'fallback'};
export function languageState(){return {...language};}
export function setSystemLanguage(message){
 if(message?.source!=='system'||typeof message.locale!=='string'||message.locale.length>128||! /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*$/.test(message.locale))return false;
 language={locale:/^en(?:[-_]|$)/i.test(message.locale)?'en':'zh',source:'system'};
 return true;
}
export function text(key,params={},locale=language.locale,tables=catalogs){
 const chinese=tables.zh[key];if(typeof chinese!=='string'||!chinese.trim())return key;
 const english=tables.en?.[key];const sentence=locale==='en'&&typeof english==='string'&&english.trim()?english:chinese;
 return sentence.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g,(literal,name)=>Object.hasOwn(params,name)?String(params[name]):literal);
}
