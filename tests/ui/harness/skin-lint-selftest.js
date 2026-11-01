#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {OUT}=require('./skin-layout');
(async()=>{
 const {checkSkin}=await import('../../../scripts/check-skin.mjs'),{checkTokens}=await import('../../../scripts/check-skin-tokens.mjs');const checks=[];
 const test=(name,fn)=>{try{fn();checks.push({name,ok:true});}catch(e){checks.push({name,ok:false,detail:e.message});}};
 const lint=source=>checkSkin({skinSources:{'ui/skins/fixture.css':source},resourceSources:{}});
 for(const prop of ['width','height','padding','margin','font-size','line-height','letter-spacing','display','position','gap','transform'])test('拦截原有节点 '+prop,()=>assert.equal(lint(`html[data-skin=x] .card{${prop}:1px}`).ok,false));
 for(const name of ['--font','--mono','--ease','--d'])test('拦截框架变量 '+name,()=>assert.equal(lint(`html[data-skin=x]{${name}:test}`).ok,false));
 test('允许安全伪元素装饰',()=>assert.equal(lint('html[data-skin=x] body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:-1;background:linear-gradient(white,transparent)}').ok,true));
 test('伪元素不能接收点击',()=>assert.equal(lint('html[data-skin=x] body::before{content:"";position:fixed;pointer-events:auto}').ok,false));
 test('超240ms被拦',()=>assert.equal(lint('.card{transition:opacity .3s}@media(prefers-reduced-motion:reduce){.card{transition:none}}').ok,false));
 test('几何过渡被拦',()=>assert.equal(lint('.card{transition:transform .1s}@media(prefers-reduced-motion:reduce){.card{transition:none}}').ok,false));
 test('缺减少动态被拦',()=>assert.equal(lint('.card{transition:opacity .1s}').ok,false));
 test('安全过渡通过',()=>assert.equal(lint('.card{transition:opacity .1s}@media(prefers-reduced-motion:reduce){.card{transition:none}}').ok,true));
 test('外链资源被拦',()=>assert.equal(checkSkin({skinSources:{},resourceSources:{'ui/test.html':'<script src="https://example.invalid/a.js"></script>','ui/a.css':'.a{background:url(https://example.invalid/a.png)}'}}).ok,false));
 test('用户链接、SVG xmlns、官方网址action保留',()=>assert.equal(checkSkin({skinSources:{},resourceSources:{'ui/test.html':'<a href="https://example.invalid">用户链接</a><svg xmlns="http://www.w3.org/2000/svg"></svg>','ui/a.js':"action('external','https://example.invalid')"}}).ok,true));
 const clean=await checkTokens({includeSkins:false,sources:{'ui/test.css':':root{--x:#fff}.x{color:var(--x);fill:currentColor;background:transparent;white-space:nowrap;content:"black"}', 'ui/test.html':'<svg><path fill="currentColor" stroke="none"/></svg><a href="https://example.invalid/#fff">white</a>', 'ui/app.js':"const url='https://example.invalid/#fff'; action('menu');"}});test('语法解析不把文字URL和SVG currentColor当漏色',()=>assert.equal(clean.ok,true,JSON.stringify(clean.issues)));
 const bad=await checkTokens({includeSkins:false,sources:{'ui/test.css':'.a{color:white;background:#abc;border-color:rgb(1,2,3);outline-color:hsl(30,20%,10%);box-shadow:0 0 2px rebeccapurple}', 'ui/app.js':"const color='#fff'; el.style.color='black';"}});test('hex/rgb/hsl/命名色和JS颜色字符串被拦',()=>assert.equal(bad.ok,false));test('CSS五种写死颜色全部定位',()=>assert.equal(bad.issues.filter(i=>i.file==='ui/test.css').length,5));
 const result={ok:checks.every(c=>c.ok),passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).length,checks};fs.writeFileSync(path.join(OUT,'lint-selftest.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
