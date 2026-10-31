import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read=name=>fs.readFileSync(new URL("../../"+name,import.meta.url),'utf8');
const catalogs={zh:JSON.parse(read('locales/zh.json')),en:JSON.parse(read('locales/en.json'))};
const source=read('ui/app.js');
const formatter=source.slice(source.indexOf('function formatTokens('),source.indexOf('\nfunction formatValueUSD('));
function fixture(){
 const context=vm.createContext({__CHATHAND_TEXT_CATALOGS__:catalogs,navigator:{language:'en-US'},document:{documentElement:{dataset:{}}}});
 context.window=context;
 vm.runInContext(read('ui/local-text.js'),context);
 vm.runInContext('const T=(key,params={})=>window.ChatHandText.t(key,params);'+source.match(/^const valueNumber=.*$/m)[0]+'\n'+formatter,context);
 return context;
}
// Frozen pre-change Chinese algorithm, including its thresholds and rounding.
function originalChinese(input){
 const n=Number.isFinite(Number(input))?Math.max(0,Number(input)):0;
 return n<1e4?Math.round(n).toLocaleString('en-US'):n<1e6?Number((n/1e4).toFixed(1))+' 万':n<1e8?Math.round(n/1e4)+' 万':Number((n/1e8).toFixed(1))+' 亿';
}

test('English selected catalog displays K/M/B and promotes rounded unit boundaries',()=>{
 const f=fixture();f.ChatHandText.update({locale:'en'});
 for(const [input,expected] of [[0,'0'],[999,'999'],[999.49,'999'],[999.5,'1K'],[1000,'1K'],[1250,'1.3K'],[76000,'76K'],[999400,'999.4K'],[999499,'999.5K'],[999500,'999.5K'],[999949,'999.9K'],[999950,'1M'],[999999,'1M'],[1e6,'1M'],[1.2e8,'120M'],[999499000,'999.5M'],[999499999,'999.5M'],[999500000,'999.5M'],[999949000,'999.9M'],[999950000,'1B'],[1e9,'1B'],[1.25e9,'1.3B'],[1e12,'1000B'],[1e15,'1000000B'],[-20,'0'],[Infinity,'0'],['76000','76K'],['not-a-number','0']]){
  assert.equal(f.formatTokens(input),expected,String(input));
  assert.doesNotMatch(f.formatTokens(input),/^1000[KM]$/);
 }
});

test('default and explicit Chinese preserve every original threshold and rounding result',()=>{
 const f=fixture();assert.equal(f.ChatHandText.locale,'zh');
 assert.equal(catalogs.zh['ui.window.formatTokens.text'],'{value} 万');
 assert.equal(catalogs.zh['ui.window.formatTokens.text2'],'{value} 亿');
 const values=[undefined,null,false,true,'',NaN,Infinity,-Infinity,-1,'76000','invalid',999,1000,76000,1e6,1.2e8,1e9,1e12,Number.MAX_VALUE];
 for(const boundary of [999.5,1000,9999.5,1e4,999500,999999.5,1e6,99999999.5,1e8,1e9])for(const delta of [-1,-.5,-.01,0,.01,.5,1])values.push(boundary+delta);
 let state=1066;for(let i=0;i<5000;i++){state=(Math.imul(state,1664525)+1013904223)>>>0;values.push(state/4294967296*1e12);}
 for(const locale of [undefined,'zh-CN']){
  if(locale)f.ChatHandText.update({locale});
  for(const input of values)assert.equal(f.formatTokens(input),originalChinese(input),String(input));
 }
});

test('switching the authoritative catalog changes only display, regardless of browser language',()=>{
 const f=fixture(),input=76000;
 assert.equal(f.navigator.language,'en-US');assert.equal(f.formatTokens(input),'7.6 万');
 f.ChatHandText.update({locale:'en-GB'});f.navigator.language='zh-CN';
 assert.equal(f.formatTokens(input),'76K');assert.equal(f.formatTokens(1.2e8),'120M');
 f.ChatHandText.update({locale:'zh'});
 assert.equal(f.formatTokens(input),'7.6 万');assert.equal(f.formatTokens(1.2e8),'1.2 亿');
 assert.equal(input,76000);
 assert.doesNotMatch(formatter,/navigator|languagechange/);
});

test('without a window bridge or catalog the original Chinese fallback remains available',()=>{
 for(const globals of [{},{window:{}},{window:{ChatHandText:undefined}}]){
  const f=vm.createContext(globals);
  vm.runInContext('const T=(key,{value})=>value+(key.endsWith("text2")?" 亿":" 万");'+source.match(/^const valueNumber=.*$/m)[0]+'\n'+formatter,f);
  for(const n of [999,1000,76000,1e6,1.2e8,1e9])assert.equal(f.formatTokens(n),originalChinese(n));
 }
});
