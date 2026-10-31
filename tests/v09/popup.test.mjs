import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('停用偏好保存失败时，弹窗重试的是停用动作',async()=>{
  const elements=Object.fromEntries(['#status','#preference-error','#toggle'].map(key=>[key,{textContent:'',hidden:false,disabled:false,onclick:null}]));
  const calls=[];
  let failed=true;
  const chrome={runtime:{sendMessage:async message=>{
    calls.push(message.action);
    if(message.action==='status')return {enabled:false,connected:false,preference_error:failed?'PREFERENCE_SAVE_FAILED':null,preference_error_enabled:failed?false:null};
    if(message.action==='disable'){failed=false;return {enabled:false};}
    throw Error('UNEXPECTED_ACTION');
  }}};
  const document={documentElement:{lang:''},querySelector:key=>elements[key],querySelectorAll:()=>[]};
  const key='__popupFixture';
  globalThis[key]={chrome,document};
  try{
    const source=fs.readFileSync(new URL('../../browser-extension/popup.js',import.meta.url),'utf8');
    const localeUrl=new URL('../../browser-extension/locale.js',import.meta.url).href;
    const moduleSource=`const {chrome,document}=globalThis[${JSON.stringify(key)}];\n`+source.replace("'./locale.js'",JSON.stringify(localeUrl));
    await import('data:text/javascript;base64,'+Buffer.from(moduleSource).toString('base64'));
  }finally{delete globalThis[key];}
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(elements['#toggle'].textContent,'重试停用');
  assert.match(elements['#preference-error'].textContent,/停用状态保存失败/);
  await elements['#toggle'].onclick();
  assert.deepEqual(calls,['status','disable','status']);
  assert.equal(elements['#toggle'].textContent,'启用浏览器控制');
  assert.equal(elements['#preference-error'].hidden,true);
});
