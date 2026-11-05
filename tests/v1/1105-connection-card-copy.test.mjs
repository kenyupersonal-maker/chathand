import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {connectionDisplay} from '../../app/v1/connection-display.mjs';

const app=fs.readFileSync(new URL('../../ui/app.js',import.meta.url),'utf8');
const source=app.slice(app.indexOf('function connCard(){'),app.indexOf('function permCard(){'));
const locales=Object.fromEntries(['zh','en'].map(lang=>[lang,JSON.parse(fs.readFileSync(new URL(`../../locales/${lang}.json`,import.meta.url),'utf8'))]));

function card(lang,{display,st='offline',sub,site=false}={}){
 const words=locales[lang],title=words['ui.server.connection.notConnected.title'];
 const S={connection:display?{display}:{},relay:{online:false}};
 const box={S,selectedConnection:()=>site?'site':'openai',connModel:()=>({st,dot:'cloud-down',label:title,sub:sub??title,left:'',right:''}),
  T:key=>words[key]||key,TH:(key,params={})=>words[key].replace(/\{(\w+)\}/g,(_,name)=>params[name]??''),
  E:String,statDot:()=>'',icon:()=>'',connectionIcon:()=>'',connectionName:()=>site?'ChatGPT Site':'OpenAI Tunnel'};
 vm.createContext(box);vm.runInContext(source,box);return box.connCard();
}

test('connection card shortens only its disconnected subtitle in both languages',()=>{
 for(const [lang,short] of [['zh','未连接'],['en','Not connected']]){
  const display=connectionDisplay({automatic:{phase:'idle'}});
  const html=card(lang,{display});
  assert.ok(html.includes(locales[lang]['ui.server.connection.notConnected.title']),'top status keeps its full title');
  assert.ok(html.includes(`<small title="${short}">${short}</small>`),'the subtitle is concise');
  assert.ok(card(lang,{st:'unset'}).includes(`<small title="${short}">${short}</small>`),'also handles an unset connection before a display arrives');
 }
});

test('connection card keeps a specific connection problem or a Site subtitle',()=>{
 const message='Check the key';
 const display=connectionDisplay({automatic:{phase:'needs_login'}});
 assert.ok(card('en',{display,sub:message}).includes(`<small title="${message}">${message}</small>`));
 assert.ok(card('en',{site:true,st:'unset',sub:'Site is not set up'}).includes('<small title="Site is not set up">Site is not set up</small>'));
});
