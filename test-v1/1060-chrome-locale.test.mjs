import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {text,setSystemLanguage,languageState} from '../browser-extension/locale.js';
import {catalogs} from '../browser-extension/locale-catalogs.js';
import {validateCatalogs} from '../app/i18n.mjs';
import {BrowserDriver} from '../browser-extension/driver.js';

test('Chrome flat catalogs retain Chinese when English is empty; browser locale is not OS locale',()=>{
 assert.equal(validateCatalogs(catalogs),true);
 assert.deepEqual(languageState(),{locale:'zh',source:'fallback'});
 assert.equal(setSystemLanguage({locale:'en-US',source:'navigator'}),false);
 assert.equal(setSystemLanguage({locale:'en-US',source:'system'}),true);
 assert.deepEqual(languageState(),{locale:'en',source:'system'});
 for(const key of Object.keys(catalogs.zh))assert.equal(text(key),catalogs.en[key]||catalogs.zh[key]);
 assert.equal(text('chrome.connected',{},'en',{zh:{'chrome.connected':'中文'},en:{'chrome.connected':''}}),'中文');
 assert.equal(text('chrome.connected',{},'en',{zh:{'chrome.connected':'中文'},en:{'chrome.connected':'Fake translation'}}),'Fake translation');
 assert.equal(setSystemLanguage({locale:'<script>',source:'system'}),false);
 assert.equal(setSystemLanguage({locale:'zh-TW',source:'system'}),true);
});

test('Chrome groups prefer ChatHand and reuse legacy groups without duplicating them',async()=>{
 for(const groups of [[],[{id:2,title:'Ken Bridge'}],[{id:2,title:'Ken Bridge'},{id:3,title:'ChatHand'}]]){
  const calls=[];const api={tabs:{group:async options=>{calls.push(options);return options.groupId??4;}},tabGroups:{query:async()=>groups,update:async(id,options)=>calls.push({id,...options})}};
  const driver=new BrowserDriver(api,{experience:true});await driver.group(11,driver.generation);
  assert.deepEqual(calls[0],{tabIds:[11],...(groups.length?{groupId:groups.length===2?3:2}:{})});
  assert.equal(calls[1].title,'ChatHand');
 }
});

test('Manifest keeps native machine identity and uses bundled Chrome locale messages',()=>{
 const manifest=JSON.parse(fs.readFileSync(new URL('../browser-extension/manifest.json',import.meta.url)));
 assert.equal(manifest.default_locale,'zh_CN');assert.equal(manifest.name,'__MSG_helperName__');
 for(const lang of ['zh_CN','en']){
  const messages=JSON.parse(fs.readFileSync(new URL(`../browser-extension/_locales/${lang}/messages.json`,import.meta.url)));
  assert.equal(messages.helperName.message,(lang==='en'&&catalogs.en['chrome.helperName'])||catalogs.zh['chrome.helperName']);
 }
 const background=fs.readFileSync(new URL('../browser-extension/background.js',import.meta.url),'utf8');
 assert.ok(background.includes("connectNative('com.kenyu.chathand.browser')"));
});
