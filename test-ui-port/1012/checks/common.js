'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const OUT=path.join(process.env.CHATHAND_UI_OUTPUT,'main');fs.mkdirSync(OUT,{recursive:true});
function result(name,checks){const ok=checks.every(row=>row.ok);fs.writeFileSync(path.join(OUT,name+'.json'),JSON.stringify({ok,checks},null,2));console.log(JSON.stringify({name,ok,passed:checks.filter(row=>row.ok).length,total:checks.length,failed:checks.filter(row=>!row.ok)}));if(!ok)process.exitCode=1;}
async function settle(page){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
module.exports={OUT,result,settle};
