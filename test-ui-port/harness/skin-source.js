#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {ROOT}=require('./common');
const {OUT,sourceHashes}=require('./skin-layout');
async function sourceReport(){
 const {cssRules}=await import('../../scripts/skin-css-parser.mjs');
 const hashes=sourceHashes(),issues=[],read=(name,base)=>fs.readFileSync(base?path.join(OUT,'sources',name):path.join(ROOT,'ui',name),'utf8');
 const oldRules=cssRules(read('style.css',true)),allNew=cssRules(read('style.css')),oldVars=new Set(oldRules.flatMap(r=>r.declarations.filter(d=>d.prop.startsWith('--')).map(d=>d.prop))),vars=new Map();
 for(const r of allNew)for(const d of r.declarations)if(d.prop.startsWith('--')&&!oldVars.has(d.prop)&&!vars.has(d.prop))vars.set(d.prop,d.value);
 const expand=(value,local=vars)=>{for(let i=0;i<8;i++){const before=value;value=value.replace(/var\((--[\w-]+)\)/g,(all,k)=>local.get(k)??all);if(value===before)break;}return value;};
 const norm=s=>s.replace(/\s+/g,' ').replace(/\s*([,:()])\s*/g,'$1').trim();
 function cssCompare(file,before,after){
  const a=cssRules(before),b=cssRules(after),existing=new Set(a.flatMap(r=>r.declarations.filter(d=>d.prop.startsWith('--')).map(d=>d.prop))),local=new Map(vars);
  for(const r of b)for(const d of r.declarations)if(d.prop.startsWith('--')&&!existing.has(d.prop)&&!local.has(d.prop))local.set(d.prop,d.value);
  const normalize=(rules,isNew)=>rules.map(r=>({selector:norm(r.selector),ancestors:r.ancestors.map(norm),declarations:r.declarations.filter(d=>!(isNew&&d.prop.startsWith('--')&&!existing.has(d.prop))).map(d=>({prop:d.prop,value:norm(isNew?expand(d.value,local):d.value)}))})).filter(r=>r.declarations.length||r.statement);
  const x=normalize(a,false),y=normalize(b,true);if(JSON.stringify(x)!==JSON.stringify(y)){for(let i=0;i<Math.max(x.length,y.length);i++)if(JSON.stringify(x[i])!==JSON.stringify(y[i]))issues.push({file,rule:i,before:x[i],after:y[i]});}
 }
 cssCompare('style.css',read('style.css',true),read('style.css'));cssCompare('wizard.css',read('wizard.css',true),read('wizard.css'));
 const tw0=read('task-widget.html',true),tw1=read('task-widget.html');cssCompare('task-widget.html',tw0.match(/<style>([\s\S]*?)<\/style>/)[1],tw1.match(/<style>([\s\S]*?)<\/style>/)[1]);if(tw0.replace(/<style>[\s\S]*?<\/style>/,'')!==tw1.replace(/<style>[\s\S]*?<\/style>/,''))issues.push({file:'task-widget.html',reason:'CSS 以外的结构、文案或脚本改变'});
 const app=read('app.js'),appNormalized=app.replace("COL=['--trail-rgb-a','--trail-rgb-b','--trail-rgb-c']","COL=[[3,212,170],[56,189,248],[167,139,250]]").replace('function tint(c,palette)','function tint(c)').replace('const colors=getComputedStyle(document.documentElement),palette=COL.map(token=>colors.getPropertyValue(token).split(\',\').map(Number));','').replaceAll('palette[i]','COL[i]').replaceAll('palette[j]','COL[j]').replaceAll('tint(c,palette)','tint(c)');
 if(appNormalized!==read('app.js',true))issues.push({file:'app.js',reason:'存在 Canvas token 读取以外的变化'});
 const index=read('index.html'),base=read('index.html',true),addedComments=[...index.matchAll(/<!--[\s\S]*?-->/g)].map(m=>m[0]).filter(c=>!base.includes(c));
 const resources=[...index.matchAll(/<(?:script|link)\b[^>]*(?:skin\.js|skin-switcher\.css|skin-switcher\.js)[^>]*>(?:<\/script>)?/g)].map(m=>m[0]);
 if(resources.length!==3)issues.push({file:'index.html',reason:`必须恰好 3 个皮肤资源入口，实际 ${resources.length}`});if(addedComments.length!==3)issues.push({file:'index.html',reason:`必须恰好 3 个新增说明注释，实际 ${addedComments.length}`});
 let stripped=index;for(const text of [...resources,...addedComments])stripped=stripped.replace(text,'');stripped=expand(stripped);const tidy=s=>s.replace(/>\s+</g,'><').trim();if(tidy(stripped)!==tidy(base))issues.push({file:'index.html',reason:'新增 3 注释+3资源入口、颜色 token 以外仍有变化'});
 const report={ok:!issues.length,sourceHashes:hashes,files:5,checks:['原有CSS选择器/声明/顺序与展开后数值完全一致','app.js仅Canvas颜色来源变化','widget CSS以外字节一致','index仅颜色+3说明+3资源入口'],issues};fs.writeFileSync(path.join(OUT,'source-integrity.json'),JSON.stringify(report,null,2));return report;
}
module.exports={sourceReport};
if(require.main===module)sourceReport().then(r=>{console.log(JSON.stringify(r,null,2));if(!r.ok)process.exitCode=1;}).catch(e=>{console.error(e);process.exitCode=1;});
