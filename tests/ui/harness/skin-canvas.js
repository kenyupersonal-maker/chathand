#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {start}=require('./server');
const {launchBrowser,NATIVE_SHIM,NOW}=require('./common');
const {OUT,sourceHashes}=require('./skin-layout');
async function canvasReport(skin){
 const hashes=sourceHashes(),srv=await start({port:0}),browser=await launchBrowser(),rows=[];
 try{for(const theme of ['light','dark']){const captures={};for(const variant of ['baseline','default',skin]){
  const ctx=await browser.newContext({viewport:{width:1280,height:860},colorScheme:theme,locale:'zh-CN',timezoneId:'Asia/Shanghai'});await ctx.addInitScript(NATIVE_SHIM);
  await ctx.addInitScript(()=>{window.__canvasTime=1000;const frames=new Map();let serial=0;Object.defineProperty(performance,'now',{value:()=>window.__canvasTime});Math.random=()=>.9;window.requestAnimationFrame=cb=>{frames.set(++serial,cb);return serial;};window.cancelAnimationFrame=id=>frames.delete(id);window.__canvasStep=t=>{window.__canvasTime=t;const batch=[...frames.values()];frames.clear();for(const cb of batch)cb(t);};});
  const page=await ctx.newPage();
  if(variant==='baseline')for(const file of ['app.js','style.css'])await page.route('**/'+file,route=>route.fulfill({status:200,contentType:file.endsWith('.css')?'text/css':'application/javascript',body:fs.readFileSync(path.join(OUT,'sources',file),'utf8')}));
  await page.goto(`${srv.url}/?s=idle&now=${NOW}&skin=${variant==='baseline'?'default':variant}&skinswitch=0#token`);await page.evaluate(async()=>{await refresh();if(!document.querySelector('#main > *'))throw Error('假服务主界面未就绪');});
  const data=await page.evaluate(()=>{
   const cv=document.querySelector('#fx'),ctx=cv.getContext('2d'),out=[];
   for(const [time,x,y] of [[1000,450,200],[1040,480,230],[1080,520,255],[1150,560,280]]){window.__canvasTime=time;dispatchEvent(new PointerEvent('pointermove',{clientX:x,clientY:y,bubbles:true}));window.__canvasStep(time+40);const rgba=ctx.getImageData(0,0,cv.width,cv.height).data;let count=0;for(let i=3;i<rgba.length;i+=4)if(rgba[i])count++;out.push({time:time+40,count,png:cv.toDataURL('image/png')});}
   window.__canvasStep(3000);const cleared=ctx.getImageData(0,0,cv.width,cv.height).data.every(v=>v===0);return {out,cleared,tokens:['--trail-rgb-a','--trail-rgb-b','--trail-rgb-c'].map(t=>getComputedStyle(document.documentElement).getPropertyValue(t).trim())};
  });
  captures[variant]={...data,out:data.out.map((r,i)=>{const buffer=Buffer.from(r.png.split(',')[1],'base64');const dir=path.join(OUT,'canvas');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,`${variant}-${theme}-${i}.png`),buffer);return {time:r.time,count:r.count,sha256:crypto.createHash('sha256').update(buffer).digest('hex')};})};await ctx.close();
 }
 rows.push({theme,defaultEquivalent:captures.baseline.out.every((v,i)=>v.sha256===captures.default.out[i].sha256),defaultPalette:captures.default.tokens.join('|')==='3,212,170|56,189,248|167,139,250',newPaletteDifferent:captures[skin].tokens.join('|')!==captures.default.tokens.join('|'),newCanvasDifferent:captures[skin].out.some((v,i)=>v.sha256!==captures.default.out[i].sha256),geometryEquivalent:captures[skin].out.every((v,i)=>v.count===captures.default.out[i].count),clears:[...Object.values(captures)].every(x=>x.cleared),captures});
 }}finally{await browser.close();await srv.close();}
 const stable=JSON.stringify(hashes)===JSON.stringify(sourceHashes()),r={skin,sourceHashes:hashes,sourcesStable:stable,ok:stable&&rows.every(x=>x.defaultEquivalent&&x.defaultPalette&&x.newPaletteDifferent&&x.newCanvasDifferent&&x.clears),rows};fs.writeFileSync(path.join(OUT,'canvas.json'),JSON.stringify(r,null,2));return r;
}
module.exports={canvasReport};
if(require.main===module)canvasReport(process.argv.find(a=>a.startsWith('--skin='))?.split('=')[1]||'quiet-titanium').then(r=>{console.log(JSON.stringify({ok:r.ok,sourcesStable:r.sourcesStable,rows:r.rows.map(({captures,...rest})=>rest)},null,2));if(!r.ok)process.exitCode=1;}).catch(e=>{console.error(e);process.exitCode=1;});
