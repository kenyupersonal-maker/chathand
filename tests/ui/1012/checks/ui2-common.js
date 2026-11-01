'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'../../../..'),out=path.join(process.env.CHATHAND_UI_OUTPUT,'wizard');
const {chromium}=require(path.join(root,'node_modules/playwright-core'));
fs.mkdirSync(path.join(out,'after'),{recursive:true});
const launch=()=>chromium.launch({executablePath:process.env.CHATHAND_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
async function open(browser,query,{theme='light',w=1280,h=860,reducedMotion='no-preference',settle=220}={}){
 const context=await browser.newContext({viewport:{width:w,height:h},colorScheme:theme,deviceScaleFactor:1,locale:'zh-CN',reducedMotion}),page=await context.newPage(),errors=[];
 await context.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__clip=String(text);},readText:async()=>window.__clip||''}}));
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto(process.env.CHATHAND_UI_URL+'/?'+(new URLSearchParams(query).has('task')?'':'task=none&')+query+'&now=1790957400000#tok.uikey');
 await page.waitForFunction(()=>typeof S!=='undefined'&&S&&window.startWizard);
 await page.waitForFunction(()=>Array.from(document.images).every(i=>i.complete));await page.waitForTimeout(settle);
 return {page,context,errors,close:()=>context.close()};
}
async function audit(page){return page.evaluate(()=>{
 const box=document.querySelector('#setupWizard'),rail=box.querySelector('.setup-rail')?.getBoundingClientRect(),main=box.querySelector('.setup-main')?.getBoundingClientRect(),cards=Array.from(box.querySelectorAll('.tier-card')).map(e=>{const r=e.getBoundingClientRect();return{w:r.width,h:r.height};});
 // 0011：向导没有左栏了。页头 .h10-header（四段 .wiz-stepper）在上，内容 .wiz-main 在下，整个 #setupWizard 自己滚动；完成页的「打开 ChatGPT」贴在窗口底边。
 const header=box.querySelector('.h10-header')?.getBoundingClientRect(),wizMain=box.querySelector('.wiz-main')?.getBoundingClientRect(),stepper=Array.from(box.querySelectorAll('.wiz-stepper>li')).map(e=>Math.round(e.getBoundingClientRect().top)),finish=box.querySelector('[data-wizard="finish"]')?.getBoundingClientRect(),scroll=box.querySelector('.setup-scroll')||(wizMain?box:null);
 const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
 const rgba=c=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=c;ctx.fillRect(0,0,1,1);const x=Array.from(ctx.getImageData(0,0,1,1).data);return[x[0],x[1],x[2],x[3]/255];};
 const over=(a,b)=>{const t=a[3]+b[3]*(1-a[3]);return t?[...(a.slice(0,3).map((v,i)=>(v*a[3]+b[i]*b[3]*(1-a[3]))/t)),t]:[0,0,0,0];};
 const lum=c=>c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((v,x,i)=>v+x*[.2126,.7152,.0722][i],0);
 const ratio=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
 function bg(e){const chain=[];for(;e;e=e.parentElement)chain.push(e);let c=[255,255,255,1];for(const el of chain.reverse())c=over(rgba(getComputedStyle(el).backgroundColor),c);return c;}
 // 1084（Ken 10/29）：文字颜色只看「同一档同一个色值」，不再按对比度卡。允许的档从主窗口 :root 现取（探针放在 body 下，不在 .h10 里），外加白字（薄荷绿角标上）。
 const probe=document.createElement('i'),tiers={};document.body.appendChild(probe);for(const name of ['--ink','--ink-2','--ink-3','--ink-4','--accent','--accent-ink','--g-ink','--o-ink']){probe.style.color='var('+name+')';tiers[name]=rgba(getComputedStyle(probe).color);}probe.remove();tiers.white=[255,255,255,1];
 const tierOf=c=>Object.keys(tiers).find(k=>tiers[k].every((v,i)=>Math.abs(v-c[i])<=(i===3?.01:2)))||null;
 const failures=[],texts=[],walker=document.createTreeWalker(box,NodeFilter.SHOW_TEXT);let n;
 while(n=walker.nextNode()){
  const text=n.textContent.trim(),e=n.parentElement;if(!text||!e||!e.getClientRects().length||e.closest('[hidden]')||getComputedStyle(e).visibility!=='visible')continue;
  const range=document.createRange();range.selectNodeContents(n);if(!range.getBoundingClientRect().width)continue;
  const s=getComputedStyle(e),fore=rgba(s.color);let opacity=1;for(let p=e;p&&p!==box.parentElement;p=p.parentElement)opacity*=Number(getComputedStyle(p).opacity);fore[3]*=opacity;const tier=tierOf(fore);
  const entry={text:text.slice(0,70),tag:e.tagName,font:s.fontSize,color:fore.map(v=>Math.round(v*100)/100),tier};texts.push(entry);if(!tier)failures.push(entry);
 }
 const border=box.querySelector('.tier-card.chosen');return{screen:box.dataset.step??box.dataset.screen,rail:rail?{width:rail.width,x:rail.x,height:rail.height}:null,main:main?{x:main.x,width:main.width,height:main.height}:null,header:header?{x:header.x,y:header.y,width:header.width,bottom:header.bottom}:null,wizMain:wizMain?{x:wizMain.x,y:wizMain.y,width:wizMain.width}:null,stepper,finish:finish?{top:finish.top,bottom:finish.bottom}:null,scroll:scroll?{client:scroll.clientHeight,total:scroll.scrollHeight,width:scroll.clientWidth,scrollWidth:scroll.scrollWidth}:null,cards,bodyOverflow:document.documentElement.scrollWidth>innerWidth,colorFailures:failures,textTiers:[...new Set(texts.map(t=>t.tier))],borderContrast:border?ratio(rgba(getComputedStyle(border).borderColor),bg(border)):null};
});}
function save(name,value){fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2));}
module.exports={fs,path,assert,root,out,launch,open,audit,save};
