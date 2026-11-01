'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../..'),out=process.env.CHATHAND_UI_OUTPUT,rows=[];
const {chromium}=require(path.join(root,'node_modules/playwright-core'));
(async()=>{assert.ok(out,'CHATHAND_UI_OUTPUT required');fs.mkdirSync(out,{recursive:true});const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1013-ui-'));process.env.CHATHAND_STATE_DIR=isolated;const server=await require('../server').start(),browser=await chromium.launch({executablePath:process.env.CHATHAND_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
async function run(name,fn){if(process.env.CHATHAND_UI_NAME_FILTER&&!name.includes(process.env.CHATHAND_UI_NAME_FILTER))return;const context=await browser.newContext({viewport:{width:1280,height:860}}),page=await context.newPage();try{await fn(page);rows.push({name,pass:true});console.log(name+' PASS');}catch(e){rows.push({name,pass:false,error:e.message});console.log(name+' FAIL '+e.message);}finally{await context.close();}}
async function configure(page,settings){await page.addInitScript(value=>window.__entrySettings=value,settings);const original=fs.readFileSync(path.join(root,'tests/ui/1012/fake.js'),'utf8');await page.route('**/__fake.js',route=>route.fulfill({contentType:'text/javascript',body:original.replace('return st;',"if(window.__entrySettings){Object.assign(st.settings,window.__entrySettings);if(window.__entrySettings.remove_step)delete st.settings.setup_step;if(window.__entrySettings.no_tunnel_id){delete st.settings.setup_tunnel_id;delete st.connection.tunnel_id;}}return st;")}));await page.goto(server.url+'/?task=none&conn='+ (settings.disconnected?'unset':'online')+'&skill='+(settings.skill?'1':'0')+'#tok.uikey',{waitUntil:'load'});await page.waitForFunction(()=>typeof S!=='undefined'&&S&&window.wizardRefresh);}
try{
 for(const [name,settings,target] of [
 // 1083（Claude，Ken 10/28 21:38）：新装没选过连接方式默认 OpenAI 通道（原来是 Site），两种「默认」的目标改了名字。
 ['fresh choice',{setup_complete:false,remove_step:true,tunnel:null,disconnected:true,no_tunnel_id:true},'h10-default-choice'],
 ['completed saved connection stays closed',{setup_complete:true,setup_step:6,tunnel:{saved:true}},'closed'],
 ['completed without saved connection',{setup_complete:true,setup_step:6,tunnel:null,disconnected:true},'h10-openai-choice'],
 ['step6 incomplete without saved connection',{setup_complete:false,setup_step:6,tunnel:null,disconnected:true,no_tunnel_id:true},'h10-default-choice'],
 ['unfinished displayed step3 resumes index2',{setup_complete:false,setup_step:2,tunnel:{saved:true}},'wizard2'],
 ['saved connection stays closed',{setup_complete:false,remove_step:true,tunnel:{saved:true}},'closed'],
 ['installed skill disconnected',{setup_complete:false,remove_step:true,tunnel:null,disconnected:true,skill:true,no_tunnel_id:true},'h10-default-assisted']
 ])await run(name,async page=>{
  await configure(page,settings);
  if(target.startsWith('h10-')){
   const screen=target==='h10-default-assisted'?'f7':'f6';
   await page.waitForFunction(screen=>!document.querySelector('#h10Host').hidden&&document.querySelector('#h10Host [data-screen="'+screen+'"]'),screen);
   assert.equal(await page.evaluate(()=>connected()),false,'no configured connection is implied by the entry screen');
   assert.equal(await page.evaluate(()=>!!S.settings.tunnel),false);
   assert.equal(await page.evaluate(()=>S.setup_skill.installed),target==='h10-default-assisted');
   const labels=async()=>page.locator('#h10Host .h10-progress-label').allTextContents();
   const titles=async keys=>page.evaluate(keys=>keys.map(key=>ChatHandText.t(key)),keys);
   if(target==='h10-default-assisted'){
    assert.equal(await page.evaluate(()=>!!(S.settings.setup_tunnel_id||S.connection?.tunnel_id)),false,'no recorded tunnel ID or setup route');
    assert.equal(await page.evaluate(()=>window.h10Entry(S)?.route),'openai','with nothing recorded the default assisted path is the OpenAI Tunnel');
    assert.deepEqual(await labels(),await titles(['ui.h10.views.verifyPackageStep','ui.h10.views.installStep','ui.h10.views.tunnelCreationStep','ui.h10.views.keyHandoffStep','ui.h10.views.connectionTitle']));
    assert.deepEqual(await page.locator('#h10Host .h10-progress-row').evaluateAll(rows=>rows.map(row=>row.dataset.state)),['done','done','active','pending','pending']);
    assert.equal(await page.locator('#h10Host [data-action="to-receive"]').count(),0,'no Site credential continuation on the OpenAI Tunnel');
    assert.equal(await page.locator('#h10Host [data-action="choose-manual"]').count(),1);
    // ChatGPT 实际在建 Site（开了 Site 配对）：进度照它画成 Site，收配对数据的出口也在。
    await page.evaluate(()=>{S.site_b={...(S.site_b||{}),pairing:{phase:'pairing'}};window.h10Refresh();});
    assert.deepEqual(await labels(),await titles(['ui.h10.views.verifyPackageStep','ui.h10.views.installStep','ui.h10.views.siteCreationStep','ui.h10.views.macConnectionStep','ui.h10.views.connectionTitle']),'Site pairing evidence draws the Site the assistant is actually building');
    assert.deepEqual(await page.locator('#h10Host .h10-progress-row').evaluateAll(rows=>rows.map(row=>row.dataset.state)),['done','done','done','active','pending'],'new Site pairing evidence advances only the corresponding stages');
    assert.equal(await page.locator('#h10Host [data-action="to-receive"]').count(),1,'Site credential continuation remains available');
   }else if(target==='h10-default-choice'){
     assert.equal(await page.evaluate(()=>window.h10Entry(S)?.route),'openai','a fresh install starts on the OpenAI Tunnel route');
     assert.equal(await page.locator('#h10Host [data-choice="assisted"]').count(),1);
     assert.equal(await page.locator('#h10Host [data-choice="manual"]').count(),1);
     assert.equal(await page.locator('#h10Host .h10-route-tag').count(),0);
     assert.equal(await page.locator('#h10Host [data-action="change-route"]').count(),1);
     assert.equal(await page.locator('#h10Host [data-action="choose-assisted"]').isEnabled(),true);
     assert.equal(await page.locator('#h10Host [data-action="choose-manual"]').isEnabled(),true);
     await page.locator('#h10Host [data-action="choose-assisted"]').click();
     await page.waitForFunction(()=>document.querySelector('#h10Host [data-screen="f7"]'));
     assert.deepEqual(await labels(),await titles(['ui.h10.views.verifyPackageStep','ui.h10.views.installStep','ui.h10.views.tunnelCreationStep','ui.h10.views.keyHandoffStep','ui.h10.views.connectionTitle']));assert.deepEqual(await page.evaluate(()=>window.__calls.find(call=>call.kind==='post'&&call.name==='/api/setup/skill')?.data?.route),'openai');
     assert.equal(await page.evaluate(()=>window.__calls.some(call=>call.kind==='post'&&call.name==='/api/setup/skill')),true,'assisted choice starts the existing setup handoff');
     assert.equal(await page.evaluate(()=>window.__calls.some(call=>call.kind==='post'&&call.name==='/api/setup/site/network-check')),false,'the OpenAI Tunnel never runs the Site network check');
   }else{
    assert.equal(await page.locator('#h10Host [data-choice="assisted"]').count(),1);
    assert.equal(await page.locator('#h10Host [data-choice="manual"]').count(),1);
    assert.deepEqual(await page.locator('#h10Host .h10-route-tag').allTextContents(),await titles(['ui.h10.host.openaiRoute','ui.h10.host.openaiRoute']));
    assert.equal(await page.locator('#h10Host [data-action="choose-assisted"]').isEnabled(),true);
    assert.equal(await page.locator('#h10Host [data-action="choose-manual"]').isEnabled(),true);
    await page.locator('#h10Host [data-action="choose-assisted"]').click();
    await page.waitForFunction(()=>document.querySelector('#h10Host [data-screen="f7"]'));
    assert.deepEqual(await labels(),await titles(['ui.h10.views.verifyPackageStep','ui.h10.views.installStep','ui.h10.views.tunnelCreationStep','ui.h10.views.keyHandoffStep','ui.h10.views.connectionTitle']));
    assert.equal(await page.evaluate(()=>window.__calls.some(call=>call.kind==='post'&&call.name==='/api/setup/skill')),true,'assisted choice starts the existing setup handoff');
   }
   await page.evaluate(()=>window.wizardRefresh(S));
   assert.equal(await page.evaluate(()=>connected()),false,'configuration progress does not certify a connection');
   assert.equal(await page.locator('#setupWizard').isHidden(),true);
   return;
  }
  if(target==='wizard2')await page.waitForFunction(()=>document.querySelector('#setupWizard').dataset.step==='2'&&!document.querySelector('#setupWizard').hidden);else if(target==='closed'){await page.waitForTimeout(100);assert.equal(await page.locator('#setupWizard').isHidden(),true);}});
 // 1083（Claude，Ken 10/28 21:38）：换成 ChatGPT Site、Site 还没建好时，先问本机服务这台 Mac 的网络会不会被 Cloudflare 网络验证拦住。
 // 查的时候两个「开始」灰着；没被拦照旧往下走，60 秒内不再查；被拦或者连不上，整页换成被拦的样子，不开帮我配、也不开 Site 配对；
 // 本机服务开 Site 配对时自己查出来被拦（SITE_NETWORK_CHALLENGED），也换成这一页。
 const freshInstall={setup_complete:false,remove_step:true,tunnel:null,disconnected:true,no_tunnel_id:true};
 const netCalls=page=>page.evaluate(()=>window.__calls.filter(call=>call.kind==='post'&&call.name==='/api/setup/site/network-check').map(call=>call.data));
 const posts=(page,name)=>page.evaluate(name=>window.__calls.filter(call=>call.kind==='post'&&call.name===name).length,name);
 const labelsOf=page=>page.locator('#h10Host .h10-progress-label').allTextContents();
 const textOf=(page,keys)=>page.evaluate(keys=>keys.map(key=>ChatHandText.t(key)),keys);
 async function chooseSite(page){
  await page.waitForFunction(()=>!document.querySelector('#h10Host').hidden&&document.querySelector('#h10Host [data-screen="f6"]'));
  await page.locator('#h10Host [data-action="change-route"]').click();
  assert.deepEqual(await page.locator('#h10RouteDialog input[name="h10-route"]').evaluateAll(inputs=>inputs.map(input=>input.value)),['openai','site'],'the OpenAI Tunnel is listed first');
  assert.equal(await page.locator('#h10RouteDialog input[name="h10-route"][value="openai"]').isChecked(),true);
  await page.locator('#h10RouteDialog input[name="h10-route"][value="site"]').check();
  await page.locator('#h10RouteDialog [data-route-dialog="confirm"]').click();
 }
 await run('choosing Site checks the network before setup starts',async page=>{
  await configure(page,freshInstall);
  assert.deepEqual(await netCalls(page),[],'the default OpenAI Tunnel does not check the Site network');
  await page.evaluate(()=>{window.__demo.delayRoute='/api/setup/site/network-check';window.__demo.routeDelay=1500;});
  await chooseSite(page);
  await page.waitForFunction(()=>document.querySelector('#h10Host [data-action="choose-assisted"]')?.disabled===true);
  const [checking]=await textOf(page,['ui.h10.views.siteNetworkChecking']);
  assert.deepEqual((await page.locator('#h10Host [data-action="choose-assisted"], #h10Host [data-action="choose-manual"]').allTextContents()).map(text=>text.trim()),[checking,checking]);
  assert.equal(await page.locator('#h10Host [data-action="choose-manual"]').isDisabled(),true,'neither start button works while the network check runs');
  await page.waitForFunction(()=>document.querySelector('#h10Host [data-action="choose-assisted"]')?.disabled===false,null,{timeout:8000});
  assert.equal(await page.locator('#h10Host [data-state="site-network"]').count(),0);
  assert.deepEqual(await page.locator('#h10Host .h10-route-tag').allTextContents(),['ChatGPT Site','ChatGPT Site']);
  assert.deepEqual(await netCalls(page),[{}],'one check, without force');
  await page.locator('#h10Host [data-action="choose-assisted"]').click();
  await page.waitForFunction(()=>document.querySelector('#h10Host [data-screen="f7"]'));
  assert.deepEqual(await labelsOf(page),await textOf(page,['ui.h10.views.verifyPackageStep','ui.h10.views.installStep','ui.h10.views.siteCreationStep','ui.h10.views.macConnectionStep','ui.h10.views.connectionTitle']));
  assert.equal(await page.evaluate(()=>window.__calls.find(call=>call.kind==='post'&&call.name==='/api/setup/skill')?.data?.route),'site');
  assert.equal((await netCalls(page)).length,1,'a clear result from the last 60 seconds is reused when setup starts');
 });
 await run('Site blocked by the network check offers the OpenAI Tunnel instead',async page=>{
  await configure(page,freshInstall);
  await page.evaluate(()=>{window.__demo.siteNet='challenged';});
  await chooseSite(page);
  await page.waitForSelector('#h10Host [data-state="site-network"][data-net="challenged"]');
  const [title,openai,recheck]=await textOf(page,['ui.h10.views.siteNetworkBlockedTitle','ui.h10.host.useOpenAI','ui.h10.views.siteNetworkRecheck']);
  assert.equal((await page.locator('#h10Host [data-state="site-network"] h1, #h10Host [data-state="site-network"] h2').first().textContent()).trim(),title);
  assert.equal((await page.locator('#h10Host .h10-state-action [data-action="switch-openai"]').textContent()).trim(),openai,'the main button switches to the OpenAI Tunnel');
  assert.equal((await page.locator('#h10Host .h10-quiet-links [data-action="recheck-site-network"]').textContent()).trim(),recheck,'checking again is the quiet link');
  assert.equal(await page.locator('#h10Host [data-action="choose-assisted"], #h10Host [data-action="choose-manual"]').count(),0,'no way to start Site setup on a blocked network');
  assert.equal(await posts(page,'/api/setup/skill'),0);assert.equal(await posts(page,'/api/setup/site/start'),0);
  await page.locator('#h10Host [data-action="switch-openai"]').click();
  await page.waitForFunction(()=>document.querySelector('#h10Host [data-screen="f6"]')&&!document.querySelector('#h10Host [data-state="site-network"]')&&document.querySelector('#h10Host [data-action="choose-assisted"]')?.disabled===false);
  assert.deepEqual(await page.locator('#h10Host .h10-route-tag').allTextContents(),await textOf(page,['ui.h10.host.openaiRoute','ui.h10.host.openaiRoute']));
  assert.equal(await posts(page,'/api/setup/skill'),0,'switching routes does not start setup by itself');
 });
 await run('an unreachable Site puts Check Again first, and a clear recheck restores setup',async page=>{
  await configure(page,freshInstall);
  await page.evaluate(()=>{window.__demo.siteNet='unreachable';});
  await chooseSite(page);
  await page.waitForSelector('#h10Host [data-state="site-network"][data-net="unreachable"]');
  const [title,openai,recheck,rechecking]=await textOf(page,['ui.h10.views.siteNetworkUnreachableTitle','ui.h10.host.useOpenAI','ui.h10.views.siteNetworkRecheck','ui.h10.views.siteNetworkRechecking']);
  assert.equal((await page.locator('#h10Host [data-state="site-network"] h1, #h10Host [data-state="site-network"] h2').first().textContent()).trim(),title);
  assert.equal((await page.locator('#h10Host .h10-state-action [data-action="recheck-site-network"]').textContent()).trim(),recheck,'the main button checks again');
  assert.equal((await page.locator('#h10Host .h10-quiet-links [data-action="switch-openai"]').textContent()).trim(),openai,'switching to the OpenAI Tunnel is the quiet link');
  await page.evaluate(()=>{window.__demo.siteNet='clear';window.__demo.delayRoute='/api/setup/site/network-check';window.__demo.routeDelay=1500;});
  await page.locator('#h10Host [data-action="recheck-site-network"]').click();
  await page.waitForFunction(()=>document.querySelector('#h10Host [data-action="recheck-site-network"]')?.disabled===true);
  assert.equal(await page.locator('#h10Host [data-state="site-network"][data-net="unreachable"]').count(),1,'the blocked page stays while checking again');
  assert.equal((await page.locator('#h10Host [data-action="recheck-site-network"]').textContent()).trim(),rechecking);
  await page.waitForFunction(()=>!document.querySelector('#h10Host [data-state="site-network"]')&&document.querySelector('#h10Host [data-action="choose-assisted"]')?.disabled===false,null,{timeout:8000});
  assert.deepEqual(await netCalls(page),[{},{force:true}],'checking again skips the 60-second cache');
 });
 await run('Site start refused by the local network check shows the blocked page, not the retry page',async page=>{
  await configure(page,freshInstall);
  await page.evaluate(()=>{window.__demo.failRoute='/api/setup/site/start';window.__demo.failCode='SITE_NETWORK_CHALLENGED';});
  await chooseSite(page);
  await page.waitForFunction(()=>document.querySelector('#h10Host [data-action="choose-manual"]')?.disabled===false);
  await page.locator('#h10Host [data-action="choose-manual"]').click();
  await page.waitForSelector('#h10Host [data-screen="f10"] [data-state="site-network"][data-net="challenged"]',{timeout:8000});
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('#h10Host [data-action="retry-site"]').count(),0,'not the “can’t create a Site right now” page');
  assert.equal(await posts(page,'/api/setup/site/start'),1,'no silent retry after the network check refused');
  assert.equal((await netCalls(page)).length,1,'the F6 result was reused on the Site page');
 });
 // 0011：向导没有单独的第 4、5 步了（并进完成页）。测试过了点「继续」去完成页，后台说测试结果找不到时，回到测试这一步、换新暗号、报那句话。
 await run('lost result on finish returns to test',async page=>{await page.goto(server.url+'/?task=none&wizard=3&test=wait#tok.uikey');await page.waitForFunction(()=>document.querySelector('#setupWizard').dataset.step==='3'&&!document.querySelector('#setupWizard').hidden);const old=await page.evaluate(()=>S.setup_test.nonce);await page.evaluate(()=>{window.__demo.failRoute='/api/setup/progress';window.__demo.failCode='SETUP_TEST_REQUIRED';window.__demo.failStep=6;window.__demo.test='ok';window.__push();});await page.waitForFunction(()=>document.querySelector('#wizardError')?.textContent,null,{timeout:8000});assert.equal(await page.evaluate(()=>document.querySelector('#setupWizard').dataset.step),'3');assert.equal(await page.locator('#wizardError').textContent(),'未找到测试结果，请重新测试。');assert.notEqual(await page.evaluate(()=>S.setup_test.nonce),old);assert.equal(await page.evaluate(()=>S.setup_test.verified),false);assert.equal(await page.locator('#wizardNext').count(),0);const calls=await page.evaluate(()=>window.__calls.filter(x=>x.kind==='post'));assert.ok(calls.some(x=>x.name==='/api/setup/progress'&&x.data.step===6));assert.ok(calls.some(x=>x.name==='/api/setup/progress'&&x.data.step===3));assert.equal(calls.filter(x=>x.name==='/api/setup/test/start').length,1);});
 for(const start of [4,5])await run('old step '+start+' progress lands on completion',async page=>{await page.goto(server.url+'/?task=none&wizard='+start+'&test=ok#tok.uikey');await page.waitForFunction(()=>!document.querySelector('#h10Host').hidden&&document.querySelector('#h10Host [data-screen="f15"]'));assert.equal(await page.locator('#setupWizard').isHidden(),true);const calls=await page.evaluate(()=>window.__calls.filter(x=>x.kind==='post'&&x.name==='/api/setup/progress'));assert.ok(calls.some(x=>x.data.step===6));});

 // 0011：小步骤从竖排的 .tut-row 改成截图下面的圆点，说明在右边 .wiz-instruction；页数看「第几步，共几步」，大步骤看顶上四段。
 await run('tool permission fifth sub-instruction and screenshot',async page=>{await page.goto(server.url+'/?task=none&wizard=2#tok.uikey');await page.waitForFunction(()=>document.querySelector('#setupWizard').dataset.step==='2');assert.equal(await page.locator('.setup-step').count(),4);assert.equal(await page.locator('.wiz-dots [data-sub]').count(),5);await page.locator('[data-sub="4"]').click();assert.equal(await page.locator('.wiz-instruction').textContent(),'打开 ChatGPT 的「设置 → 插件 → ChatHand」，在「权限」中选择「允许使用所有工具」。否则写入文件、运行命令等操作会被 ChatGPT 拦截。AI 能执行哪些操作，仍由 ChatHand 的权限设置和高危开关控制。');const image=page.locator('.tut-frame img');await image.waitFor();await page.waitForFunction(()=>{const image=document.querySelector('.tut-frame img');return image.complete&&image.naturalWidth>0;});assert.match(await image.getAttribute('src'),/s5e-tool-permissions\.png$/);const geometry=await image.evaluate(img=>({w:img.naturalWidth,h:img.naturalHeight,rendered:img.getBoundingClientRect().width}));assert.deepEqual([geometry.w,geometry.h],[1120,480]);assert.ok(geometry.rendered>0);const bounds=await page.locator('.tut-frame').evaluate(frame=>{const f=frame.getBoundingClientRect(),i=frame.querySelector('img').getBoundingClientRect(),r=frame.querySelector('.tut-ring').getBoundingClientRect();return {frame:{x:f.x,y:f.y,right:f.right,bottom:f.bottom},image:{x:i.x,y:i.y,right:i.right,bottom:i.bottom},ring:{x:r.x,y:r.y,right:r.right,bottom:r.bottom}};});const focus=[175,30,385,205];const scale=Math.min((bounds.frame.right-bounds.frame.x)/focus[2],(bounds.frame.bottom-bounds.frame.y)/focus[3]);const focused={x:bounds.frame.x+((bounds.frame.right-bounds.frame.x)-focus[2]*scale)/2,y:bounds.frame.y+((bounds.frame.bottom-bounds.frame.y)-focus[3]*scale)/2,right:bounds.frame.x+((bounds.frame.right-bounds.frame.x)-focus[2]*scale)/2+focus[2]*scale,bottom:bounds.frame.y+((bounds.frame.bottom-bounds.frame.y)-focus[3]*scale)/2+focus[3]*scale};for(const rect of [bounds.ring,focused])assert.ok(rect.x>=bounds.frame.x-1&&rect.y>=bounds.frame.y-1&&rect.right<=bounds.frame.right+1&&rect.bottom<=bounds.frame.bottom+1,'ring and focus remain within tutorial frame');assert.equal(await page.locator('.tut-ring').count(),1);await page.screenshot({path:path.join(out,'tool-permissions-substep.png'),fullPage:true});await page.locator('.tut-frame').click();const zoomImage=page.locator('.tutorialZoom img');await zoomImage.waitFor();await page.waitForFunction(()=>{const image=document.querySelector('.tutorialZoom img');return image.complete&&image.naturalWidth===1120&&image.naturalHeight===480;});const zoomGeometry=await zoomImage.evaluate(img=>({w:img.naturalWidth,h:img.naturalHeight,renderedWidth:img.getBoundingClientRect().width,renderedHeight:img.getBoundingClientRect().height}));assert.deepEqual([zoomGeometry.w,zoomGeometry.h],[1120,480]);assert.ok(zoomGeometry.renderedWidth>0&&zoomGeometry.renderedHeight>0);fs.writeFileSync(path.join(out,'tool-permissions-render.json'),JSON.stringify({natural_pixels:[1120,480],CSS_pixels:[560,240],focus,rings:[[187,189,363,34]],bounds,focused,zoom:zoomGeometry,headless_isolated_fake:true},null,2)+'\n');assert.equal(await page.locator('.wiz-count').textContent(),'第 5 步，共 5 步');assert.match(await page.locator('.setup-step.current').textContent(),/添加到 ChatGPT/);});
 await run('read-only points to ChatGPT all tools permission',async page=>{await page.goto(server.url+'/?task=none&wizard=3&test=read#tok.uikey');await page.waitForFunction(()=>document.querySelector('#setupWizard').dataset.step==='3');assert.equal((await page.locator('#wizardTest').textContent()).trim(),'ChatGPT 已连接这台 Mac，正在确认…');assert.equal(await page.locator('#wizardNext').count(),0);await page.waitForFunction(()=>document.querySelector('#wizardTest').textContent.includes('允许使用所有工具'),null,{timeout:20000});const text=await page.locator('#wizardTest').textContent();assert.ok(text.includes('ChatGPT 尚未获得修改权限。'));assert.ok(text.includes('如不希望每次确认：在 ChatGPT 的插件设置中，将 ChatHand 的「权限」设为「允许使用所有工具」。'));assert.equal(await page.locator('#wizardTest .wiz-conn').getAttribute('data-state'),'attention');assert.equal(await page.locator('#wizardNext').count(),0);assert.equal(await page.locator('[data-wizard="retest"]').count(),0);});
 // 0011：完成页跟 Site 的完成页一套：四段都打勾、范围两个单选（默认整台电脑）、底下「打开 ChatGPT」。ChatGPT 工具权限那句在「添加到 ChatGPT」第 5 页讲过，完成页不再重复。
 await run('completion page: all stages done, scope and open ChatGPT',async page=>{await page.goto(server.url+'/?task=none&wizard=6#tok.uikey');await page.waitForFunction(()=>typeof window.startWizard==='function'&&typeof S!=='undefined'&&S);await page.evaluate(()=>window.startWizard({initialStep:6}));await page.waitForFunction(()=>document.querySelector('#setupWizard').dataset.step==='6'&&!document.querySelector('#setupWizard').hidden);assert.equal(await page.locator('.setup-step').count(),4);assert.equal(await page.locator('.setup-step[data-state="done"]').count(),4);assert.equal(await page.locator('#setupWizard input[data-tier]').count(),2);assert.equal(await page.locator('#setupWizard input[data-tier="full"]').isChecked(),true);assert.equal(await page.locator('[data-wizard="finish"]').textContent(),'打开 ChatGPT');});
}finally{await browser.close();await server.close();fs.rmSync(isolated,{recursive:true,force:true});}
fs.writeFileSync(path.join(out,'setup-1013.json'),JSON.stringify({headless_isolated_fake:true,real_GUI_or_clipboard_used:false,rows},null,2)+'\n');console.log(JSON.stringify({pass:rows.filter(x=>x.pass).length,fail:rows.filter(x=>!x.pass).length}));if(rows.some(x=>!x.pass))process.exitCode=1;
})().catch(e=>{console.error(e.message);process.exitCode=1;});
