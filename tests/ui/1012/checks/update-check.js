'use strict';
const path=require('node:path');
const {open}=require('../shoot');
const {result,settle,OUT}=require('./common');
const checks=[];
const check=(name,ok,detail)=>checks.push({name,ok:!!ok,...(detail?{detail}:{})});
(async()=>{
 for(const [locale,theme] of [['zh','light'],['zh','dark'],['en','light']]){
  const ctx=await open('task=none&update=failed&auto_update=0&appearance='+theme,{theme,w:1050,h:820,dsf:1});
  try{
   const p=ctx.page;
   await p.evaluate(({locale})=>{
    ChatHandText.installCatalogs({locale});
    const originalAPI=api;
    window.__updateRequests=0;
    api=async(route,data)=>{
     if(route==='/api/support/update'){window.__updateRequests++;return structuredClone(window.__updateReply);}
     return originalAPI(route,data);
    };
    openDrawer('settings');
   },{locale});
   await settle(p);
   const cases=[
    ['failed available',{status:'failed',availability:'available',version:'1.0.0-beta.38'},'ui.window.updateLine.text2',false],
    ['failed current',{status:'failed',availability:'up_to_date'},'ui.window.updateLine.text3',false],
    ['installing available',{status:'installing',availability:'available',version:'1.0.0-beta.38'},'ui.window.updateLine.text2',false],
    ['legacy available',{status:'available',version:'1.0.0-beta.38'},'ui.window.updateLine.text2',false],
    ['failed unknown',{status:'failed',availability:'unknown'},'ui.window.action.checkUpdate.text',true],
    ['stale available unknown',{status:'available',availability:'unknown'},'ui.window.action.checkUpdate.text',true],
   ];
   for(const [name,response,key,warn] of cases){
    await p.evaluate(response=>{window.__updateReply=response;},response);
    await p.click('[data-action="checkUpdate"]');
    await settle(p);
    const observed=await p.evaluate(({key})=>({text:document.getElementById('toast').textContent,expected:T(key,{value:'1.0.0-beta.38'}).replace(/[。.]+$/,''),warn:document.getElementById('toast').classList.contains('toast-warn'),installState:S.update.install.state}),{key});
    check(`${locale} ${theme}: ${name}`,observed.text===observed.expected&&observed.warn===warn&&observed.installState==='failed',observed);
    if(name==='failed available')await p.screenshot({path:path.join(OUT,`update-check-${locale}-${theme}.png`)});
   }
   check(`${locale} ${theme}: one request per click`,await p.evaluate(()=>window.__updateRequests===6));
   check(`${locale} ${theme}: no browser errors`,ctx.errs.length===0,ctx.errs);
  }finally{await ctx.close();}
 }
 result('update-check',checks);
})().catch(error=>{console.error(error);process.exitCode=1;});
