import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {t as translate} from '../app/i18n.mjs';
const T=(key,params={})=>translate(key,params,'zh');

const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('confirmation cards use native human-checked answer and never call answer HTTP directly',()=>{
 const ui=read('ui/app.js');
 assert.ok(ui.includes("native('confirmAnswer',{id,scope})"));
 assert.equal(ui.includes('/api/confirm/answer'),false);
 assert.ok(ui.includes("scopes.includes('always')?['always']:[]"),'current capability grants expose only the persistent permission scope');assert.match(ui,/data-scope=\\?"deny\\?"/);
 assert.ok(ui.includes('setTimeout(()=>{confirmArmed.delete(id);confirmReady.add(id);scheduleRender();},1000)'));
 assert.match(ui,/data-action=\\?"confirmAnswer\\?"/);assert.match(ui,/ready\?'':'disabled'/);
 assert.equal(/autofocus/i.test(ui),false);
 assert.equal(/confirm[^\n]{0,100}\.focus\(/.test(ui),false);
});

test('confirmation card copy, scope choices, failure states and notification routing are present',()=>{
 const ui=read('ui/app.js');
 const localized=[['ui.window.confirmationCard.text7',{exp:'',openB:'',name:'浏览器',closeB:''},'ChatGPT 请求使用「浏览器」'],['ui.window.confirmationCard.text8',{value:'打开网页',value2:''},'用途：打开网页'],['ui.window.confirmationCard.text9',{value:'读取页面'},'开启后可以：读取页面'],['ui.window.confirmationCard.text10',{value:'可能提交表单'},'风险：可能提交表单'],['ui.window.confirmationCard.text4',{},'允许'],['ui.window.confirmationCard.text5',{},'保持关闭'],['ui.window.confirmationCard.text2',{openSpan:'',mins:1,closeSpan:''},'1 分钟内有效'],['ui.window.confirmationsTop.text',{},'此确认已过期'],['ui.window.confirmationsTop.text2',{},'ChatGPT 已撤回此请求'],['ui.window.action.confirmAnswer.text.text',{},'未识别到你的点击：请直接用鼠标或触控板点击，或在设置中开启']];
 for(const [key,params,expected] of localized){assert.ok(ui.includes(key),key);assert.ok(T(key,params).includes(expected),key);}
 assert.equal(ui.includes('这个任务里都行'),false);assert.equal(ui.includes('已打开「'),false);
 assert.ok(ui.includes('CONFIRM_NOT_HUMAN')&&ui.includes('ui.window.action.confirmAnswer.text.text'));
 assert.ok(ui.includes('ui.window.confirmationsTop.text')&&ui.includes('ui.window.confirmationsTop.text2'));
 assert.ok(ui.includes("addEventListener('confirmationRequested'"));
 assert.ok(ui.includes("if(!IN_APP)acts="),'outside the native app only Settings is offered');
});

test('can-enable legacy block cards are suppressed; needs-user cards use blocked say_to_user and keep a local-open button',()=>{
 const ui=read('ui/app.js');
 assert.ok(ui.includes("if(blocked?.kind==='can_enable')return '';"));
 assert.ok(ui.includes("if(blocked?.kind==='needs_user')"));
 assert.ok(ui.includes('blocked.say_to_user'));
 assert.ok(ui.includes('T("ui.window.blockCard.text3")')&&T('ui.window.blockCard.text3')==='前往开启');
});

test('confirmation card styling uses orange outline, compact closed state and flash',()=>{
 const css=read('ui/style.css');
 assert.match(css,/\.confirm-card\{[^}]*border:1px solid var\(--o\)/);
 assert.ok(css.includes('.confirm-card .confirm-risk{color:var(--o-ink)}'));
 assert.ok(css.includes('.confirm-card.compact')&&css.includes('.confirm-card.flash'));
});
