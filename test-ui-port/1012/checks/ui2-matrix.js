'use strict';
const {fs,path,assert,out,launch,open,audit,save}=require('./ui2-common');
const cases=[
 ...Array.from({length:7},(_,i)=>({name:'wizard'+i,q:'wizard='+i+(i===1?'&conn=connecting&key=wait':'')})),
 {name:'wizard3-ok',q:'wizard=3&test=ok'},
 ...[['waiting','wait','connecting'],['got','got','connecting'],['connected','connected','online'],['expired','expired','connecting'],['fail','fail','connecting']].map(([name,key,conn])=>({name:'key-'+name,q:`wizard=1&key=${key}&conn=${conn}`})),
 {name:'tier-full',q:'wizard=4&tier=full'},{name:'tier-light',q:'wizard=4&tier=light'},{name:'tier-focus',q:'wizard=4&tier=full',focus:true},
 ...[['none','off','none','none'],['admin','on','none','none'],['partial','off','partial','none'],['restart','off','restart','none'],['browser-down','off','none','down'],['done','on','ok','ok']].map(([name,admin,perm,chrome])=>({name:'open-full-'+name,q:`wizard=5&tier=full&admin=${admin}&perm=${perm}&chrome=${chrome}`})),
 {name:'open-light-none',q:'wizard=5&tier=light&folder=todo&chrome=none'},{name:'open-light-done',q:'wizard=5&tier=light&folder=done&chrome=ok'},
 {name:'finish-pending',q:'wizard=6&tier=full&admin=off&perm=none&chrome=none'},{name:'finish-done',q:'wizard=6&tier=full&admin=on&perm=ok&chrome=ok'},
 {name:'open-full-waiting',q:'wizard=5&tier=full&admin=waiting&perm=none&chrome=none'},
 {name:'open-full-cancelled',q:'wizard=5&tier=full&openstatus=admin:cancelled&perm=none&chrome=none'},
];
(async()=>{const browser=await launch(),rows=[];fs.mkdirSync(out+'/after',{recursive:true});
 try{for(const theme of ['light','dark'])for(const [w,h] of [[1280,860],[980,680]])for(const item of cases){
  const t=await open(browser,item.q,{theme,w,h});try{
   if(/(^|&)wizard=6(&|$)/.test(item.q)){await t.page.evaluate(()=>window.startWizard({initialStep:6}));await t.page.waitForFunction(()=>!document.querySelector('#setupWizard').hidden&&document.querySelector('#setupWizard').dataset.step==='6');await t.page.waitForTimeout(220);}if(item.focus)await t.page.locator('[data-tier="full"]').focus();
   const metrics=await audit(t.page);/* 0011：左栏换成页头：页头离顶 48、左右居中，四段排在一行；内容区在页头下面固定空 48，宽 880、居中。 */if(/^wizard[0-6]$/.test(item.name)){assert.ok(metrics.header&&metrics.wizMain,'wizard header and main');assert.equal(metrics.header.y,48);assert.equal(metrics.header.x*2+metrics.header.width,w);assert.equal(metrics.stepper.length,4);assert.equal(new Set(metrics.stepper).size,1);assert.equal(metrics.wizMain.y-metrics.header.bottom,48);assert.deepEqual([metrics.wizMain.x,metrics.wizMain.width],[(w-880)/2,880]);}const file=item.name+'-'+theme+'-'+w+'.png';await t.page.screenshot({path:out+'/after/'+file});rows.push({name:item.name,theme,w,h,file,errors:t.errors,metrics});
  }finally{await t.close();}
  if(rows.length%20===0)console.log('screenshots',rows.length);
 }}finally{await browser.close();save('matrix.json',rows);}
 // 0011：完成页（后台第 4..6 步现在都落到这里）设计上允许「用到时再开」多时往下滚，但「打开 ChatGPT」要贴在窗口底边、不滚就点得到；横向仍不许滚。
 const problems=rows.filter(r=>r.errors.length||r.metrics.bodyOverflow||r.metrics.colorFailures.length||(Number(r.metrics.screen)>=4&&((r.metrics.wizMain?!r.metrics.finish||r.metrics.finish.top<0||r.metrics.finish.bottom>r.h+1:r.metrics.scroll?.total>r.metrics.scroll?.client+1)||r.metrics.scroll?.scrollWidth>r.metrics.scroll?.width+1))||r.metrics.cards.length&&((r.metrics.cards[0].w!==r.metrics.cards[1].w)||(r.metrics.cards[0].h!==r.metrics.cards[1].h)));
 save('matrix-problems.json',problems);console.log('A/D/F screens',rows.length,'problems',problems.length);assert.equal(problems.length,0);
})().catch(e=>{console.error(e);process.exitCode=1;});
