import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createChromeLocator,findChromeApp} from '../../app/v08/chrome-location.mjs';
import {chromeVersionInfo} from '../../app/v08/personal-chrome.mjs';

const standard='/Applications/Google Chrome.app',user='/Users/fixture/Applications/Google Chrome.app',external='/Volumes/Apps Disk/Browsers/Google Chrome.app';
function fixture(paths=[],stdout='',status=0){
 const calls=[],existing=new Set(paths);let time=1000;
 const deps={home:'/Users/fixture',platform:'darwin',now:()=>time,exists:p=>existing.has(p),run:(program,args,options)=>{calls.push({program,args,options});return {status,stdout};}};
 return {find:createChromeLocator(deps),deps,calls,existing,advance:ms=>{time+=ms;}};
}
test('1030 B：标准 Applications 安装优先，不调用 Spotlight',()=>{const f=fixture([standard,user,external],external);assert.equal(f.find(),standard);assert.equal(f.find(),standard);assert.equal(f.calls.length,0);});
test('1030 B：用户 Applications 安装，不调用 Spotlight',()=>{const f=fixture([user]);assert.equal(f.find(),user);assert.equal(f.calls.length,0);});
test('1030 B：仅 mdfind 找到非标准磁盘安装，缓存成功路径',()=>{
 const f=fixture([external],'/tmp/not-an-app\n/Volumes/Missing.app\n'+external+'\n');assert.equal(f.find(),external);assert.equal(f.find(),external);assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].program,'/usr/bin/mdfind');assert.deepEqual(f.calls[0].args,["kMDItemCFBundleIdentifier == 'com.google.Chrome'"]);assert.equal(f.calls[0].options.timeout,2000);assert.equal(f.calls[0].options.shell,undefined);
});
test('1030 B：均不存在保持未安装，空结果不会每次轮询都启动 mdfind',()=>{
 const f=fixture();assert.equal(f.find(),null);assert.equal(f.find(),null);assert.equal(f.calls.length,1);f.advance(60001);assert.equal(f.find(),null);assert.equal(f.calls.length,2);
 f.existing.add(user);assert.equal(f.find(),user,'new standard-location installation is noticed without waiting for Spotlight');
});
test('1030 B：定位缓存已失效时重新定位；Spotlight 异常不冒充已安装',()=>{
 const f=fixture([external],external);assert.equal(f.find(),external);f.existing.delete(external);assert.equal(f.find(),null);assert.equal(f.calls.length,2);
 const bad=createChromeLocator({home:'/fake',platform:'darwin',exists:()=>false,run:()=>{throw Error('unavailable');}});assert.equal(bad(),null);
 assert.equal(fixture([external],external,1).find(),null);
});
test('1030 B：非 macOS 不运行 mdfind，显式测试依赖不污染共用缓存',()=>{
 let runs=0;const deps={home:'/fake',platform:'linux',exists:()=>false,run:()=>{runs++;return {};}};assert.equal(createChromeLocator(deps)(),null);assert.equal(findChromeApp(deps),null);assert.equal(runs,0);
});
test('1030 B：四种位置的 chromeVersionInfo 使用定位结果，版本和未安装文案语义不变',()=>{
 for(const [installedPath,spotlight] of [[standard,''],[user,''],[external,external],[null,'']]){
  const f=fixture(installedPath?[installedPath]:[],spotlight),versionCalls=[];
  const info=chromeVersionInfo({locate:f.find,run:(program,args)=>{versionCalls.push([program,args]);return {status:0,stdout:'154.0.8037.98\n'};}});
  if(installedPath){assert.equal(info.installed,true);assert.equal(info.version,'154.0.8037.98');assert.equal(info.supported,true);assert.equal(versionCalls[0][1].at(-1),installedPath+'/Contents/Info.plist');}
  else{assert.deepEqual(info,{installed:false,version:null,major:null,supported:false,minimum_major:144});assert.equal(versionCalls.length,0);}
 }
});
test('1030 B：两个 Node 消费者共用定位，Swift 打开入口先按 bundle id 找 Chrome',()=>{
 const read=p=>fs.readFileSync(new URL("../../"+p,import.meta.url),'utf8'),browser=read('app/v07/browser.mjs'),personal=read('app/v08/personal-chrome.mjs'),swift=read('native/main.swift');
 assert.ok(browser.includes('findChromeApp()')&&personal.includes('locate=findChromeApp'));assert.ok(browser.includes("executablePath:path.join(chromeApp,'Contents/MacOS/Google Chrome')"));
 assert.ok(swift.includes('NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome")'));
 for(const section of ['extensionSettings','chromeSetup','reconnectBrowserHelper','chromeUpdate']){const from=swift.indexOf('case "'+section+'":'),end=swift.indexOf('\n        case ',from+1);assert.ok(swift.slice(from,end).includes('chromeApplicationURL()'),section);}
});
