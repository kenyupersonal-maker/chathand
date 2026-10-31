// ONE1052 release-only descriptor/H10/offline tests.
// No Site network, user file, native UI, build/sign/install or real credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {renderOfflinePage} from '../ui/h10/offline.mjs';
import {installationPrompt} from '../ui/h10/prompts.mjs';

function fixturePage(html,href){
 const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
 if(!script)throw Error('INLINE_SCRIPT_MISSING');
 const events=new Map(),timers=[],copied=[];
 const elements={};
 const document={
  getElementById:id=>(elements[id]??={textContent:'',innerHTML:'',style:{}}),
  addEventListener:(name,handler)=>events.set(name,handler),
  body:{appendChild:()=>{}},
  hidden:false,
  createElement:()=>({style:{},select:()=>{},remove:()=>{},value:''}),
  execCommand:()=>true
 };
 const url=new URL(href),locations=[];
 const location={protocol:url.protocol,pathname:url.pathname,origin:url.origin,href};
 Object.defineProperty(location,'href',{get:()=>href,set:v=>{locations.push(v);href=v;}});
 const sandbox={document,location,URL,decodeURIComponent,encodeURIComponent,
  navigator:{clipboard:{writeText:async text=>{copied.push(text)}}},
  setTimeout:cb=>{timers.push(cb);return 1;},clearTimeout:()=>{},
  console:{log:()=>{}}};
 vm.runInNewContext(script,sandbox,{timeout:1000});
 return {events,timers,copied,locations,document,location,
  click:async action=>events.get('click')({target:{closest:()=>({dataset:{action},disabled:false})}})};
}
test('offline F1 in mounted DMG uses adjacent .app candidate path, canonical copy and deep-link, not a second DMG',async()=>{
 const html=renderOfflinePage({screen:'f1',localAppCandidate:true});
 assert.match(html,/data-action="install-assisted"/);
 const page=fixturePage(html,'file:///Volumes/ChatHand%20TEST/%E8%AE%A9%20ChatGPT%20%E6%9D%A5%E8%A3%85.html');
 await page.click('install-assisted');
 assert.equal(page.copied.length,1);
 const text=page.copied[0];
 assert.equal(text,installationPrompt({localPath:'/Volumes/ChatHand TEST/ChatHand.app'}));
 assert.ok(text.includes('/Volumes/ChatHand TEST/ChatHand.app'));
 assert.ok(!text.includes('~/Downloads')&&!text.includes('SIWC'));
 assert.ok(page.locations.some(s=>s.startsWith('codex://new?prompt=')));
 assert.ok(page.document.getElementById('h10-offline-status').textContent.includes('不代表'));
});
test('copied standalone HTML outside mounted DMG cannot invent a local source',async()=>{
 const page=fixturePage(renderOfflinePage({screen:'f5',localAppCandidate:true}),
  'file:///Users/example/Downloads/%E7%AC%AC%E4%B8%80%E6%AC%A1%E6%89%93%E5%BC%80.html');
 await page.click('install-assisted');
 assert.equal(page.copied.length,0);
 assert.equal(page.locations.length,0);
 assert.match(page.document.getElementById('h10-offline-status').textContent,/没有可验证/);
});
test('user selected local DMG comes only from native macOS file picker, not renderer verified boolean',()=>{
 const swift=fs.readFileSync(new URL('../native/main.swift',import.meta.url),'utf8');
 const host=fs.readFileSync(new URL('../ui/h10/host.mjs',import.meta.url),'utf8');
 const install=fs.readFileSync(new URL('../codex/INSTALL.md',import.meta.url),'utf8');
 assert.match(swift,/case "chooseReleaseDMG"/);
 assert.match(swift,/interfaceKeyShared && ownsService && data\.isEmpty/);
 assert.match(swift,/p\.allowedFileTypes = \["dmg"\]/);
 assert.match(swift,/"signature_verified":false,"installed":false/);
 assert.match(host,/native\?\.\('chooseReleaseDMG',\{\}\)/);
 assert.match(host,/picked\?\.user_selected===true/);
 assert.match(host,/picked\?\.signature_verified===false/);
 assert.match(host,/userSelectedDMG=null/);
 assert.match(install,/本机|local/i);
 assert.match(install,/codesign|签名/);
 assert.doesNotMatch(host,/\.replace\('verified_by_release_pipeline',true\)/);
});

test('formal candidate still uses default signed build:trial entry and separate DMG packaging',()=>{
 const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
 assert.equal(pkg.kenBridge.connector_api,31);assert.ok(Number.isSafeInteger(pkg.kenBridge.build_number));
 assert.equal(pkg.scripts['build:trial'],'node scripts/build-v09.mjs');
 const build=fs.readFileSync(new URL('../scripts/build-v09.mjs',import.meta.url),'utf8');
 assert.match(build,/signApplication/);
 assert.match(build,/unsigned/);
 assert.ok(!build.includes('scripts/build-mac.sh'));
 const dmgb=fs.readFileSync(new URL('../scripts/build-dmg.py',import.meta.url),'utf8');
 assert.match(dmgb,/dmgbuild\.build_dmg/);
});
