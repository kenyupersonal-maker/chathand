/* Shared local UI text runtime. Locale comes from the native shell only. */
(function(root){
 'use strict';
 const state=root.__CHATHAND_TEXT_STATE__||(root.__CHATHAND_TEXT_STATE__={locale:'zh',catalogs:{zh:{},en:{}},revision:0,listeners:new Set()});
 const own=(object,key)=>Object.prototype.hasOwnProperty.call(object||{},key);
 const localeOf=value=>/^en(?:[-_]|$)/i.test(String(value||''))?'en':'zh';
 const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 const trustedMark=Symbol.for('ChatHand.localText.trusted');
 const trusted=value=>Object.freeze({[trustedMark]:true,value:String(value??'')});
 function template(key){const current=state.catalogs[state.locale]||{},fallback=state.catalogs.zh||{};return typeof current[key]==='string'&&current[key].trim().length?current[key]:typeof fallback[key]==='string'&&fallback[key].trim().length?fallback[key]:String(key);}
 function format(key,params={},asHTML=false){const source=template(key);return source.split(/(\{[A-Za-z][A-Za-z0-9_]*\})/g).map(part=>{const match=/^\{([A-Za-z][A-Za-z0-9_]*)\}$/.exec(part);if(!match)return asHTML?escape(part):part;const name=match[1];if(!own(params,name))return part;const value=params[name];return asHTML?(value?.[trustedMark]===true?value.value:escape(value)):String(value?.[trustedMark]===true?value.value:value??'');}).join('');}
 function t(key,params={}){return format(key,params,false);}
 function html(key,params={}){return format(key,params,true);}
 function installCatalogs(input={}){const incoming=input.catalogs||(own(input,'zh')||own(input,'en')?input:null);let changed=false;if(incoming)for(const locale of ['zh','en'])if(incoming[locale]&&typeof incoming[locale]==='object'){const next={...(state.catalogs[locale]||{})};for(const [key,value] of Object.entries(incoming[locale])){if(input.overwrite===false&&own(next,key))continue;if(next[key]!==value){next[key]=value;changed=true;}}state.catalogs[locale]=next;}if(own(input,'locale')){const next=localeOf(input.locale);if(state.locale!==next){state.locale=next;changed=true;}}if(root.document?.documentElement){root.document.documentElement.lang=state.locale==='en'?'en':'zh-CN';root.document.documentElement.dataset.localTextLocale=state.locale;}if(changed){state.revision++;if(input.overwrite!==false)for(const listener of [...state.listeners])listener(state);}return state;}
 function subscribe(listener){state.listeners.add(listener);return ()=>state.listeners.delete(listener);}
 const api={t,html,trusted,installCatalogs,update:installCatalogs,subscribe,get locale(){return state.locale;},get revision(){return state.revision;}};
 t.html=html;root.ChatHandText=api;
 if(root.__CHATHAND_TEXT_CATALOGS__)installCatalogs({catalogs:root.__CHATHAND_TEXT_CATALOGS__,overwrite:false});
})(globalThis);
