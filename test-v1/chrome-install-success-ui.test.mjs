import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(process.env.CHATHAND_SUCCESS_UI_SOURCE||new URL('../ui/app.js',import.meta.url),'utf8');
const section=(from,to)=>{const start=source.indexOf(from),end=source.indexOf(to,start);assert.ok(start>=0&&end>start,from);return source.slice(start,end);};
const A='00000000-0000-4000-8000-00000000000a',B='00000000-0000-4000-8000-00000000000b';
function fixture(status={phase:'installed_verified',active:false,attempt_id:A}){
  const views=[],toasts=[],calls=[],timers=new Map();let serial=0,refreshes=0;
  const context=vm.createContext({T:(key,p)=>key+(p?JSON.stringify(p):''),TH:key=>key,E:String,S:{automation:{browser:{extension:{helper:{expected_build:1071}}}}},
    capOn:()=>true,scheduleRender(){},btn:(_text,action)=>'ACTION:'+action,modal:(html,kind)=>views.push({html,kind}),
    extensionSuccessToast:async(message,kind)=>toasts.push({message,kind}),native:async action=>{calls.push(action);return {started:true,attempt_id:A};},
    api:async()=>status,refresh:async()=>{refreshes++;},setTimeout:fn=>{timers.set(++serial,fn);return serial;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(section('let chromeInstallView=','function desktopSheet()'),context);
  return {context,views,toasts,calls,timers,get refreshes(){return refreshes;},
    async tick(){const [id,fn]=[...timers][0]||[];assert.ok(fn);timers.delete(id);await fn();}};
}

test('verified automatic repair shows one success toast, ends polling and never cancels the completed installer',async()=>{
  const f=fixture();await f.context.startExtensionSetup('','repair');await f.tick();
  assert.equal(f.views.length,1,'only the progress dialog was rendered');
  assert.equal(f.views[0].kind,'chrome-install');
  assert.deepEqual(f.toasts,[{message:'ui.window.extGuide.doneReplace{"build":1071}',kind:'chrome-install'}]);
  assert.equal(f.timers.size,0);assert.equal(f.refreshes,1);
  assert.equal(f.calls.includes('extensionCancel'),false);
  for(let i=0;i<3;i++)f.context.showChromeInstall({phase:'installed_verified',attempt_id:A});
  assert.equal(f.toasts.length,1,'repeated terminal status cannot notify again');
});

test('legacy status without an attempt id notifies once per new user-started run',()=>{
  const f=fixture();f.context.startChromeInstallView();
  f.context.showChromeInstall({phase:'installed_verified'});f.context.showChromeInstall({phase:'installed_verified'});
  assert.equal(f.toasts.length,1);
  f.context.startChromeInstallView();f.context.showChromeInstall({phase:'installed_verified'});
  assert.equal(f.toasts.length,2);
});

test('a later distinct install can notify while a repeated completed attempt remains silent',()=>{
  const f=fixture();f.context.startChromeInstallView();f.context.showChromeInstall({phase:'installed_verified',attempt_id:A});
  f.context.startChromeInstallView();f.context.showChromeInstall({phase:'installed_verified',attempt_id:A.toUpperCase()});
  assert.equal(f.toasts.length,1);
  f.context.showChromeInstall({phase:'installed_verified',attempt_id:B});assert.equal(f.toasts.length,2);
});

test('failed and waiting-for-permission flows retain their modal recovery actions',()=>{
  const f=fixture();f.context.showChromeInstall({phase:'stopped',code:'CHROME_DATA_ACCESS_DENIED'});
  assert.match(f.views.at(-1).html,/ACTION:chromeDataAccessSettings/);
  f.context.showChromeInstall({phase:'waiting_permission',active:true,stage:'waiting_accessibility'});
  assert.match(f.views.at(-1).html,/ACTION:computerPermissions/);assert.match(f.views.at(-1).html,/ACTION:extensionCancel/);
  assert.equal(f.toasts.length,0);
});

test('manual recheck notifies only after a new healthy transition and clears its guide',()=>{
  const toasts=[],dialog={open:true,dataset:{kind:'ext-guide'}},context=vm.createContext({$:()=>dialog,
    S:{automation:{browser:{extension:{helper:{build:1071}}}}},T:key=>key,healthy:false,
    extGuideOK:()=>context.healthy,modal(){},E:String,btn:()=>'',extensionSuccessToast:async(...args)=>toasts.push(args)});
  vm.runInContext('let extGuide={mode:"replace",okAtOpen:true};'+section('function extGuideTick()','function helperSheet()'),context);
  context.healthy=true;context.extGuideTick();assert.equal(toasts.length,0,'already healthy at open');
  context.healthy=false;context.extGuideTick();context.healthy=true;context.extGuideTick();context.extGuideTick();
  assert.equal(toasts.length,1);assert.equal(toasts[0][1],'ext-guide');assert.equal(vm.runInContext('extGuide',context),null);
});

function toastHostFixture(kind){
  const closed=[],shown=[],appended=[],dialog={open:true,dataset:{kind}},drawer={open:true,append:t=>{appended.push(t);t.parentElement=drawer;}},toast={parentElement:null};
  let release;
  const context=vm.createContext({$:id=>({'#modal':dialog,'#drawer':drawer,'#toast':toast})[id],document:{body:{append(){throw Error('wrong toast host');}}},
    closeModal:cancel=>{closed.push(cancel);return new Promise(resolve=>release=()=>{dialog.open=false;resolve();});},quietModalOpen:()=>dialog.open&&dialog.dataset.kind==='key-lost',
    toast:(...args)=>shown.push(args)});
  vm.runInContext(section('async function extensionSuccessToast(','function extGuideTick()'),context);
  return {context,closed,shown,appended,dialog,release:()=>release()};
}

test('success closes only its owned dialog, waits for it, and shows the toast in the open drawer',async()=>{
  const f=toastHostFixture('chrome-install'),pending=f.context.extensionSuccessToast('done','chrome-install');
  assert.deepEqual(f.closed,[false]);assert.equal(f.shown.length,0);
  f.release();await pending;assert.deepEqual(f.shown,[['done']]);assert.equal(f.appended.length,1);
});

test('a success response cannot close an unrelated dialog or replace key-loss guidance',async()=>{
  for(const kind of ['unrelated','key-lost']){const f=toastHostFixture(kind);await f.context.extensionSuccessToast('done','chrome-install');
    assert.equal(f.closed.length,0);assert.equal(f.dialog.open,true);assert.equal(f.shown.length,kind==='key-lost'?0:1);}
});

test('closing after success suppresses cancellation while a normal user close still cancels',async()=>{
  for(const cancel of [false,true]){const stopped=[],dialog={open:true,close(){this.open=false;}},context=vm.createContext({$:()=>dialog,
      stopChromeInstallView:value=>stopped.push(value),modalClosing:null,microReduce:{matches:true}});
    vm.runInContext(section('function closeModal(','$(\'#modal\').addEventListener(\'cancel\''),context);
    await context.closeModal(cancel);assert.deepEqual(stopped,[cancel]);assert.equal(dialog.open,false);}
});
