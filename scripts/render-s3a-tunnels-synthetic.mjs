import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'ui/assets/tutorial/s3a-tunnels.png');
const tutorial=JSON.parse(fs.readFileSync(path.join(root,'ui/assets/tutorial/tutorial.json'),'utf8'));

function entries(value,out=[]){
 if(Array.isArray(value)){for(const item of value)entries(item,out);}
 else if(value&&typeof value==='object'){
  if(value.shot==='s3a-tunnels')out.push(value);
  for(const item of Object.values(value))entries(item,out);
 }
 return out;
}

const refs=entries(tutorial);
assert.equal(refs.length,2,'tutorial must keep both s3a-tunnels references');
assert.deepEqual(refs.map(x=>x.focus),[[560,0,720,190],[260,84,560,110]]);
assert.deepEqual(refs.map(x=>x.rings),[[[1143,8,117,40]],[[731,119,44,36]]]);

const html=`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic tunnel settings example</title>
<style>
*{box-sizing:border-box}html,body{margin:0;width:1280px;height:372px;overflow:hidden;background:#fff;color:#171717;font:14px/1.35 Arial,Helvetica,sans-serif}
.screen{display:flex;width:1280px;height:372px;background:#fff}.sidebar{width:260px;height:372px;flex:none;background:#f7f7f7;border-right:1px solid #e7e7e7;color:#252525}
.side-head{height:56px;display:flex;align-items:center;gap:12px;padding:0 20px;border-bottom:1px solid #e9e9e9;font-size:14px;font-weight:500}
.back{width:12px;height:12px;border-left:2px solid #333;border-bottom:2px solid #333;transform:rotate(45deg);margin-left:2px}
.collapse{margin-left:auto;width:14px;height:14px;border:1.5px solid #666;border-radius:2px;position:relative}.collapse:before{content:"";position:absolute;top:0;bottom:0;left:4px;border-left:1px solid #777}
.nav{padding:8px 8px 0}.nav-item{height:35px;display:flex;align-items:center;padding:0 11px;margin-bottom:1px;border-radius:8px;color:#333;font-size:14px}.nav-item.selected{background:#ececec;font-weight:600}
.main{position:relative;width:1020px;height:372px;overflow:hidden}.top{position:absolute;inset:0 0 auto 0;height:56px;border-bottom:1px solid #e6e6e6;display:flex;align-items:center}
h1{position:absolute;left:24px;top:13px;margin:0;font-size:20px;line-height:28px;font-weight:650;letter-spacing:-.25px}
.badge{position:absolute;left:136px;top:17px;height:22px;padding:0 8px;display:flex;align-items:center;border:1px solid #cbd7df;border-radius:11px;background:#f2f7fa;color:#425968;font-size:9px;line-height:1;font-weight:700;letter-spacing:.55px;white-space:nowrap}
.actions{position:absolute;right:20px;top:8px;height:40px;display:flex;gap:8px}.action{height:40px;border:0;border-radius:10px;padding:0 13px;background:#ededed;color:#202020;font:500 13px Arial,Helvetica,sans-serif;white-space:nowrap}.docs{width:90px}.download{width:180px}.create-tunnel{width:117px;background:#151515;color:#fff;padding:0 10px}
.table-head{position:absolute;left:24px;top:88px;height:28px;color:#343434;font-size:11px;font-weight:700;letter-spacing:.35px;white-space:nowrap}
.table-head span,.cell{position:absolute}.col-tunnel{left:0}.col-id{left:181px}.col-org{left:525px}.col-workspace{left:657px}.col-created{left:790px}
.row{position:absolute;left:0;right:0;top:119px;height:76px;border-top:1px solid #eeeeee}
.tunnel-name{left:24px;top:12px;font-size:15px;font-weight:650}.description{left:24px;top:39px;width:205px;color:#777;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.id-value{left:205px;top:15px;color:#6f6f6f;font-size:12px;white-space:nowrap}.copy-id{position:absolute;left:480px;top:4px;width:28px;height:28px;border:0;background:transparent;padding:0}
.copy-icon,.copy-icon:after{position:absolute;width:12px;height:13px;border:1.5px solid #606060;border-radius:2px;content:""}.copy-icon{left:8px;top:9px}.copy-icon:after{left:3px;top:-4px;background:#fff}
.org{left:525px;top:15px;color:#383838;font-size:13px}.workspace{left:657px;top:15px;color:#383838;font-size:13px}.created{left:790px;top:12px;display:flex;gap:8px;align-items:flex-start}
.avatar{width:28px;height:28px;border-radius:50%;background:#e9e9e9;color:#555;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600}.person{font-size:13px;color:#333;line-height:16px}.email{display:block;margin-top:3px;color:#777;font-size:11px}
.row-actions{position:absolute;right:22px;top:14px;display:flex;gap:24px;align-items:center}.edit{width:14px;height:14px;border:1.5px solid #555;border-radius:2px;position:relative;transform:scale(.82)}.edit:after{content:"";position:absolute;width:12px;border-top:2px solid #555;transform:rotate(-46deg);left:3px;top:5px}.trash{width:13px;height:14px;border:1.5px solid #ca6666;border-top:2px solid #ca6666;border-radius:1px 1px 3px 3px;position:relative}.trash:before{content:"";position:absolute;width:17px;left:-3.5px;top:-5px;border-top:1.5px solid #ca6666}.trash:after{content:"";position:absolute;left:4px;top:3px;height:7px;border-left:1px solid #ca6666}
</style></head><body><div class="screen" aria-label="Synthetic example settings screen">
<aside class="sidebar"><div class="side-head"><span class="back" aria-hidden="true"></span><span>Back to project</span><span class="collapse" aria-hidden="true"></span></div><nav class="nav" aria-label="Settings"><div class="nav-item">General</div><div class="nav-item">API keys</div><div class="nav-item">Admin keys</div><div class="nav-item">People</div><div class="nav-item">Projects</div><div class="nav-item">Billing</div><div class="nav-item">Limits</div><div class="nav-item selected">Tunnels</div><div class="nav-item">Usage</div></nav></aside>
<main class="main"><header class="top"><h1>Tunnels</h1><span class="badge">SYNTHETIC EXAMPLE</span><div class="actions"><button class="action docs">Read docs</button><button class="action download">Download tunnel-client</button><button class="action create-tunnel">Create tunnel</button></div></header>
<div class="table-head"><span class="col-tunnel">TUNNEL</span><span class="col-id">ID</span><span class="col-org">ORGANIZATIONS</span><span class="col-workspace">WORKSPACES</span><span class="col-created">CREATED BY</span></div>
<section class="row" aria-label="Example tunnel row"><strong class="cell tunnel-name">sample-tunnel</strong><span class="cell description">Example connection for tutorial only</span><span class="cell id-value">tunnel_example_00000000</span><button class="copy-id" aria-label="Copy example tunnel ID"><span class="copy-icon" aria-hidden="true"></span></button><span class="cell org">Example org</span><span class="cell workspace">Sample workspace</span><span class="cell created"><span class="avatar">E</span><span class="person">Example user<span class="email">user@example.invalid</span></span></span><span class="row-actions" aria-hidden="true"><i class="edit"></i><i class="trash"></i></span></section>
</main></div></body></html>`;

const executablePath=process.env.CHATHAND_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if(!fs.existsSync(executablePath))throw Error('EXISTING_CHROME_REQUIRED');
const browser=await chromium.launch({headless:true,executablePath,args:['--disable-background-networking','--disable-extensions','--no-default-browser-check','--no-first-run']});
try{
 const context=await browser.newContext({viewport:{width:1280,height:372},deviceScaleFactor:2,locale:'en-US'});
 const page=await context.newPage();
 await page.route('**/*',route=>route.request().url()==='about:blank'?route.continue():route.abort());
 await page.setContent(html,{waitUntil:'load'});
 const boxes=await page.evaluate(()=>{
  const box=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
  return {create:box('.create-tunnel'),copy:box('.copy-id'),badge:box('.badge'),title:document.title};
 });
 assert.deepEqual(boxes.create,{x:1143,y:8,width:117,height:40},'Create tunnel ring target moved');
 assert.ok(boxes.copy.x>=731&&boxes.copy.y>=119&&boxes.copy.x+boxes.copy.width<=775&&boxes.copy.y+boxes.copy.height<=155,'copy ID ring no longer covers its target');
 assert.ok(boxes.copy.x>=260&&boxes.copy.y>=84&&boxes.copy.x+boxes.copy.width<=820&&boxes.copy.y+boxes.copy.height<=194,'copy ID focus crop no longer covers its target');
 await page.screenshot({path:output,type:'png',animations:'disabled'});
 await context.close();
 process.stdout.write(JSON.stringify({output,width:2560,height:744,synthetic:true,targets:boxes})+'\n');
}finally{await browser.close();}
