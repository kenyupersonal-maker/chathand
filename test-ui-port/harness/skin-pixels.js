#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {launchBrowser}=require('./common');
const {OUT,MATRIX}=require('./skin-layout');
async function comparePixels(before='baseline',after='extracted',{only=[]}={}){
 const browser=await launchBrowser(),rows=[];
 try{const page=await browser.newPage();for(const theme of ['light','dark'])for(const st of MATRIX){
  const name=st.name+'-'+theme;if(only.length&&!only.includes(name))continue;const images=[before,after].map(d=>'data:image/png;base64,'+fs.readFileSync(path.join(OUT,d,name+'.png')).toString('base64'));
  const result=await page.evaluate(async images=>{const imgs=await Promise.all(images.map(src=>new Promise((r,j)=>{const im=new Image();im.onload=()=>r(im);im.onerror=j;im.src=src;})));const [w,h]=[imgs[0].width,imgs[0].height];if(imgs.some(im=>im.width!==w||im.height!==h))throw Error('截图尺寸不一致');const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(imgs[0],0,0);const a=ctx.getImageData(0,0,w,h);ctx.drawImage(imgs[1],0,0);const b=ctx.getImageData(0,0,w,h);let changed=0,maxChannel=0;const diff=ctx.createImageData(w,h);for(let i=0;i<a.data.length;i+=4){let d=0;for(let c=0;c<4;c++)d=Math.max(d,Math.abs(a.data[i+c]-b.data[i+c]));if(d){changed++;maxChannel=Math.max(maxChannel,d);diff.data[i]=255;diff.data[i+3]=255;}else{diff.data[i]=a.data[i];diff.data[i+1]=a.data[i+1];diff.data[i+2]=a.data[i+2];diff.data[i+3]=55;}}ctx.putImageData(diff,0,0);return {pixels:w*h,changed,percent:changed/(w*h)*100,maxChannel,diff:changed?canvas.toDataURL('image/png'):null};},images);
  if(result.diff){const d=path.join(OUT,`diff-${before}-${after}`);fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,name+'.png'),Buffer.from(result.diff.split(',')[1],'base64'));}delete result.diff;rows.push({name,...result,ok:result.percent<=.02});
 }}finally{await browser.close();}
 const report={before,after,states:rows.length,limitPercent:.02,maxPercent:Math.max(...rows.map(r=>r.percent)),totalChanged:rows.reduce((s,r)=>s+r.changed,0),ok:rows.every(r=>r.ok),rows};fs.writeFileSync(path.join(OUT,`pixels-${before}-${after}.json`),JSON.stringify(report,null,2));return report;
}
module.exports={comparePixels};
if(require.main===module){const get=(k,d)=>process.argv.find(a=>a.startsWith('--'+k+'='))?.split('=')[1]||d;comparePixels(get('before','baseline'),get('after','extracted'),{only:get('only','').split(',').filter(Boolean)}).then(r=>{console.log(JSON.stringify(r,null,2));if(!r.ok)process.exitCode=1;}).catch(e=>{console.error(e);process.exitCode=1;});}
