#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {start}=require('./server');
const {launchBrowser,openProduct}=require('./common');
const {OUT,sourceHashes}=require('./skin-layout');
const PAIRS=[['--ink','--win'],['--ink','--card'],['--ink-2','--card'],['--ink-3','--card'],['--accent-ink','--accent'],['--g-ink','--g-soft'],['--o-ink','--o-soft'],['--y-ink','--y-bg'],['--ink','--fill']];
const STATUS=['--g','--o','--y-ink','--accent'];
const composite=(fg,bg)=>{const a=fg[3]??1;return fg.slice(0,3).map((n,i)=>n*a+bg[i]*(1-a)).concat(1);};
const linear=n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;};
const luminance=rgb=>rgb.slice(0,3).map(linear).reduce((s,n,i)=>s+n*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
function lab(rgb){const [r,g,b]=rgb.map(linear),f=t=>t>216/24389?Math.cbrt(t):(24389/27*t+16)/116;const x=f((r*.4124564+g*.3575761+b*.1804375)/.95047),y=f(r*.2126729+g*.7151522+b*.072175),z=f((r*.0193339+g*.119192+b*.9503041)/1.08883);return [116*y-16,500*(x-y),200*(y-z)];}
function deltaE(lab1,lab2){
 const rad=d=>d*Math.PI/180,deg=r=>r*180/Math.PI,[L1,a1,b1]=lab1,[L2,a2,b2]=lab2,C1=Math.hypot(a1,b1),C2=Math.hypot(a2,b2),Cb=(C1+C2)/2,G=.5*(1-Math.sqrt(Cb**7/(Cb**7+25**7))),A1=(1+G)*a1,A2=(1+G)*a2,c1=Math.hypot(A1,b1),c2=Math.hypot(A2,b2),h=(a,b)=>((deg(Math.atan2(b,a))+360)%360),h1=h(A1,b1),h2=h(A2,b2),dL=L2-L1,dC=c2-c1;
 let dh=h2-h1;if(c1*c2===0)dh=0;else if(dh>180)dh-=360;else if(dh< -180)dh+=360;const dH=2*Math.sqrt(c1*c2)*Math.sin(rad(dh/2)),Lb=(L1+L2)/2,cb=(c1+c2)/2;
 let hb=(h1+h2)/2;if(c1*c2===0)hb=h1+h2;else if(Math.abs(h1-h2)>180)hb+=(h1+h2<360?180:-180);
 const T=1-.17*Math.cos(rad(hb-30))+.24*Math.cos(rad(2*hb))+.32*Math.cos(rad(3*hb+6))-.20*Math.cos(rad(4*hb-63)),SL=1+.015*(Lb-50)**2/Math.sqrt(20+(Lb-50)**2),SC=1+.045*cb,SH=1+.015*cb*T,RT=-2*Math.sqrt(cb**7/(cb**7+25**7))*Math.sin(rad(60*Math.exp(-(((hb-275)/25)**2))));
 return Math.sqrt((dL/SL)**2+(dC/SC)**2+(dH/SH)**2+RT*(dC/SC)*(dH/SH));
}
async function values(page){const names=[...new Set([...PAIRS.flat(),...STATUS])];return page.evaluate(names=>{
 const probe=document.createElement('span');probe.style.cssText='position:fixed;visibility:hidden;pointer-events:none';document.body.append(probe);const out={};for(const name of names){probe.style.color=`var(${name})`;const css=getComputedStyle(probe).color;const match=css.match(/^rgba?\(([^)]+)\)$/);let rgb;if(match){rgb=match[1].split(/[\s,\/]+/).filter(Boolean).map(Number);if(rgb.length===3)rgb.push(1);}else{/* oklch()、color() 等：画到 1×1 画布上读回 sRGB */const cv=document.createElement('canvas');cv.width=cv.height=1;const g=cv.getContext('2d');g.fillStyle=css;g.fillRect(0,0,1,1);const d=g.getImageData(0,0,1,1).data;if(!d[3]&&!/\/\s*0(\.0*)?\s*\)$/.test(css))throw Error('颜色未解析成 sRGB：'+name+'='+css);rgb=[d[0],d[1],d[2],+(d[3]/255).toFixed(4)];}out[name]={css,rgb,raw:getComputedStyle(document.documentElement).getPropertyValue(name).trim()};}probe.remove();return out;
 },names);}
async function colorReport(skin){
 if(Math.abs(deltaE([50,2.6772,-79.7751],[50,0,-82.7485])-2.0425)>.0001)throw Error('CIEDE2000 参考向量未通过');
 const hashes=sourceHashes(),srv=await start({port:0}),browser=await launchBrowser(),samples={},rows=[],distances=[];
 try{for(const id of ['default',skin])for(const theme of ['light','dark']){const {page,ctx}=await openProduct(browser,srv.url,theme,'idle',{extra:`&skin=${encodeURIComponent(id)}&skinswitch=0`});try{await page.waitForTimeout(100);const actual=await page.evaluate(()=>window.ChatHandSkin?.current()||'default');if(actual!==id)throw Error(`请求 ${id}，实际 ${actual}`);samples[id+'-'+theme]=await values(page);}finally{await ctx.close();}}
 }finally{await browser.close();await srv.close();}
 for(const theme of ['light','dark']){
  const ratios={};for(const id of ['default',skin]){const v=samples[id+'-'+theme],win=composite(v['--win'].rgb,[255,255,255]),card=composite(v['--card'].rgb,win);ratios[id]=PAIRS.map(([fg,bg])=>{const under=bg==='--win'?[255,255,255]:bg==='--card'?win:card,back=composite(v[bg].rgb,under),front=composite(v[fg].rgb,back);return {foreground:fg,background:bg,foregroundCss:v[fg].css,backgroundCss:v[bg].css,underlying:under,effectiveForeground:front,effectiveBackground:back,ratio:contrast(front,back)};});}
  ratios[skin].forEach((r,i)=>{const baseline=ratios.default[i].ratio;rows.push({theme,...r,defaultRatio:baseline,ok:r.ratio+1e-9>=baseline&&(!['--ink','--ink-2'].includes(r.foreground)||r.ratio>=4.5)});});
  const v=samples[skin+'-'+theme],win=composite(v['--win'].rgb,[255,255,255]);for(let i=0;i<STATUS.length;i++)for(let j=i+1;j<STATUS.length;j++){const a=STATUS[i],b=STATUS[j],distance=deltaE(lab(composite(v[a].rgb,win).slice(0,3)),lab(composite(v[b].rgb,win).slice(0,3)));distances.push({theme,a,b,deltaE2000:distance,ok:distance>=20});}
 }
 const stable=JSON.stringify(hashes)===JSON.stringify(sourceHashes()),r={skin,sourceHashes:hashes,sourcesStable:stable,contrast:{ok:rows.every(r=>r.ok),rows},separation:{ok:distances.every(r=>r.ok),min:Math.min(...distances.map(r=>r.deltaE2000)),rows:distances},samples};fs.writeFileSync(path.join(OUT,'colors.json'),JSON.stringify(r,null,2));if(!stable)throw Error('颜色检查期间 UI 文件被改动');return r;
}
module.exports={colorReport,lab,deltaE,contrast,composite};
if(require.main===module)colorReport(process.argv.find(a=>a.startsWith('--skin='))?.split('=')[1]||process.env.SKIN||'default').then(r=>{console.log(JSON.stringify({skin:r.skin,contrast:r.contrast,separation:r.separation},null,2));if(!r.contrast.ok||!r.separation.ok)process.exitCode=1;}).catch(e=>{console.error(e);process.exitCode=1;});
