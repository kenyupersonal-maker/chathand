import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {t as translate} from '../../app/i18n.mjs';
const T=(key,params={})=>translate(key,params,'zh');
test('task timeline shows exit codes in plain words with a hover explanation',()=>{
 const app=fs.readFileSync(new URL('../../ui/app.js',import.meta.url),'utf8'),css=fs.readFileSync(new URL('../../ui/style.css',import.meta.url),'utf8');
 assert.ok(!app.includes("'退出码 '+j.exit_code"));
 const start=app.indexOf('let EXIT_WORDS='),end=app.indexOf('function timelineResult(',start),ctx=vm.createContext({T});assert.ok(start>=0&&end>start);vm.runInContext(app.slice(start,end)+';globalThis.exitWords=exitWords',ctx);
 for(const [code,key,textKey] of [[0,'ui.window.exitWords.text','ui.window.exitWords.text2'],[1,'ui.window.exitWords.text3','ui.window.exitWords.text4'],[2,'ui.window.exitWords.text5','ui.window.exitWords.text6'],[126,'ui.window.exitWords.text7','ui.window.exitWords.text8'],[127,'ui.window.exitWords.text9','ui.window.exitWords.text10'],[130,'ui.window.exitWords.text11','ui.window.exitWords.text12'],[137,'ui.window.exitWords.text13','ui.window.exitWords.text14'],[143,'ui.window.exitWords.text15','ui.window.exitWords.text16']])assert.equal(ctx.exitWords(code).text,T(key));
 assert.equal(ctx.exitWords(0).tip,T('ui.window.exitWords.tip.text',{value:T('ui.window.exitWords.text2'),n:0}));assert.equal(ctx.exitWords(99).text,T('ui.window.exitWords.text3'));
 assert.ok(app.includes('class="term" tabindex="0" data-tip='));assert.match(css,/\.term\{[^}]*underline dashed/);assert.match(css,/#tip\{[^}]*position:fixed/);
});
