import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
import {generateDmgSources,pageFiles} from '../ui/assets/dmg/src/generate.mjs';
import {createDmgText,readCatalogs,localizeTemplate,scriptJSON,catalogFingerprint,sourceFiles} from '../ui/assets/dmg/src/localize.mjs';
import {renderOfflinePage,renderDmgArtwork} from '../ui/h10/offline.mjs';
import {installCatalogs} from '../ui/local-text.mjs';

// Optional staging input lets parallel extraction run before Root merges catalogs.
// The default always exercises the repository's single canonical catalog source.
const catalogs=process.env.CHATHAND_DMG_TEST_CATALOGS?JSON.parse(fs.readFileSync(process.env.CHATHAND_DMG_TEST_CATALOGS,'utf8')):readCatalogs();
const chinese={zh:catalogs.zh,en:{}};
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1060-dmg-locales-'));
const scripts=html=>[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
const normalizeLang=html=>html.replace('<html lang="en">','<html lang="zh-CN">');
const fixtureEnglish=Object.fromEntries(Object.entries(catalogs.zh).filter(([key])=>key.startsWith('dmg.')).map(([key,value])=>[key,'EN fixture ['+key+'] '+[...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match=>match[0]).join(' ')]));
fixtureEnglish['ui.h10.prompts.installPrompt']='EN fixture install {location}';
fixtureEnglish['ui.h10.prompts.downloadLocationPlaceholder']=catalogs.zh['ui.h10.prompts.downloadLocationPlaceholder'];

function checkStandalone(html){
 assert.doesNotMatch(html,/\{location\}/);
 assert.doesNotMatch(html,/@(?:[A-Z_]+|(?:TEXT|JS|HTML):[^@]+)@|<script[^>]+src=|<link\b|https?:\/\//i);
 for(const script of scripts(html))assert.doesNotThrow(()=>new vm.Script(script));
}

test('build language is explicit; empty English falls back without reading browser or OS',()=>{
 const zh=createDmgText({catalogs:chinese}),en=createDmgText({locale:'en',catalogs:{zh:catalogs.zh,en:{'dmg.jump.title':' \t'}}});
 assert.equal(zh.text('dmg.jump.title'),catalogs.zh['dmg.jump.title']);
 assert.equal(en.text('dmg.jump.title'),zh.text('dmg.jump.title'));
 assert.throws(()=>createDmgText({locale:'fr',catalogs:chinese}),/DMG_LOCALE_INVALID/);
 assert.throws(()=>zh.text('dmg.test.missing'),/DMG_CHINESE_MISSING/);
 const text=createDmgText({locale:'en',catalogs:{zh:{'dmg.test.sentence':'你好，{name}。'},en:{'dmg.test.sentence':'Fixture {name}.'}}});
 assert.equal(text.text('dmg.test.sentence',{name:'$&'}),'Fixture $&.');
 assert.doesNotMatch(fs.readFileSync('ui/assets/dmg/src/localize.mjs','utf8'),/navigator\.language|AppleLanguages/);
 assert.doesNotMatch(fs.readFileSync('scripts/build-dmg.py','utf8'),/system_locale|AppleLanguages/);
});

test('temporary generation keeps default Chinese paths and creates zh/en self-contained fallback pages',t=>{
 const outputDir=temp();t.after(()=>fs.rmSync(outputDir,{recursive:true,force:true}));
 const files=generateDmgSources({outputDir,catalogs:chinese});assert.equal(files.length,6);
 for(const name of pageFiles){
  const zh=fs.readFileSync(path.join(outputDir,'zh',name),'utf8'),en=fs.readFileSync(path.join(outputDir,'en',name),'utf8');
  assert.equal(fs.readFileSync(path.join(outputDir,name),'utf8'),zh);
  assert.equal(normalizeLang(en),zh);checkStandalone(zh);checkStandalone(en);
 }
 const bg=renderDmgArtwork({catalogs:chinese});assert.match(bg,/width:698px;height:718px/);
 assert.ok(bg.includes(catalogs.zh['dmg.background.title']));
});

test('synthetic English fixture changes actual pages, rich sentences and script feedback, while machine commands stay identical',t=>{
 const outputDir=temp();t.after(()=>fs.rmSync(outputDir,{recursive:true,force:true}));
 generateDmgSources({outputDir,catalogs:{zh:catalogs.zh,en:fixtureEnglish}});
 for(const name of pageFiles){
  const zh=fs.readFileSync(path.join(outputDir,'zh',name),'utf8'),en=fs.readFileSync(path.join(outputDir,'en',name),'utf8');
  assert.notEqual(normalizeLang(en),zh);assert.match(en,/EN fixture/);checkStandalone(en);
  assert.doesNotMatch(en,/\{(?:searchKeys|enterKey|pasteKeys|openAnyway|open|illustrationNote)\}/);
 }
 const html=fs.readFileSync(path.join(outputDir,'en','第一次打开.html'),'utf8');
 const zh=fs.readFileSync(path.join(outputDir,'zh','第一次打开.html'),'utf8');
 assert.equal(html.match(/<code id="cmd">([\s\S]*?)<\/code>/)[1],zh.match(/<code id="cmd">([\s\S]*?)<\/code>/)[1]);
 assert.match(html,/<span class="keys"><kbd>⌘<\/kbd><kbd>EN fixture/);
 assert.match(fs.readFileSync(path.join(outputDir,'en','让 ChatGPT 来装.html'),'utf8'),/EN fixture \[dmg\.prompt\.openCopied\]/);
 assert.match(html,/EN fixture install/);
});

test('translation text cannot inject HTML or terminate inline scripts; rich markup is allowlisted',t=>{
 const outputDir=temp();t.after(()=>fs.rmSync(outputDir,{recursive:true,force:true}));
 const payload='Fixture </script><img src=x onerror="bad()"> & \' " \u2028 \u2029';
 const en={...fixtureEnglish,'dmg.jump.title':payload,'dmg.prompt.openCopied':payload,'dmg.firstOpen.openTerminal':payload+' {searchKeys} {enterKey}'};
 generateDmgSources({outputDir,catalogs:{zh:catalogs.zh,en}});
 for(const name of pageFiles){
  const html=fs.readFileSync(path.join(outputDir,'en',name),'utf8');checkStandalone(html);
  assert.doesNotMatch(html,/<img src=x/);
 }
 const html=fs.readFileSync(path.join(outputDir,'en','让 ChatGPT 来装.html'),'utf8');
 assert.equal(scripts(html).length,1);assert.match(html,/&lt;\/script&gt;/);assert.match(html,/\\u003c\/script\\u003e/);
 assert.equal(vm.runInNewContext(scriptJSON(payload)),payload);
 const text=createDmgText({catalogs:{zh:{...catalogs.zh,'dmg.test.rich':'{unapproved}'},en:{}}});
 assert.throws(()=>localizeTemplate('@HTML:dmg.test.rich@',text),/DMG_RICH_SLOT_INVALID/);
});

test('offline status text and titles use shared runtime and safely serialize the selected language',()=>{
 installCatalogs({locale:'zh',catalogs:chinese});
 const zh=renderOfflinePage({screen:'f1'});checkStandalone(zh);
 assert.ok(zh.includes(catalogs.zh['ui.offline.installTitle']));
 const phrase='Offline fixture </script> & "';
 installCatalogs({locale:'en',catalogs:{zh:catalogs.zh,en:{'ui.offline.installTitle':'Fixture title','ui.offline.sourceTemplateDisabled':phrase}}});
 const en=renderOfflinePage({screen:'f1'});assert.match(en,/<html lang="en">/);assert.match(en,/<title>Fixture title<\/title>/);checkStandalone(en);
 const elements={},document={getElementById:id=>elements[id]??={textContent:''},addEventListener:()=>{}};
 vm.runInNewContext(scripts(en)[0],{document,setTimeout:()=>{},navigator:{},location:{}});
 assert.equal(elements['h10-offline-status'].textContent,phrase);
 installCatalogs({locale:'zh',catalogs:chinese});
});

test('catalog stamp changes for translations and packaging retains audited APFS/grid layout',()=>{
 assert.notEqual(catalogFingerprint(chinese),catalogFingerprint({zh:catalogs.zh,en:fixtureEnglish}));
 const source=fs.readFileSync('scripts/build-dmg.py','utf8');
 assert.match(source,/'filesystem': 'APFS'/);assert.match(source,/'grid_spacing': 100/);
 assert.match(source,/catalog_sha256/);assert.match(source,/stamp\.get\('locale'\) != locale/);
 for(const file of sourceFiles)assert.ok(fs.existsSync(file),file);
});

test('real packager preflight selects zh/en assets and rejects stale catalogs before any signing or mount',t=>{
 const root=temp();t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const write=(name,bytes)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);};
 const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
 write('package.json',fs.readFileSync('package.json'));write('scripts/build-dmg.py',fs.readFileSync('scripts/build-dmg.py'));
 // Import is reached only after the actual preflight succeeds; terminate before codesign.
 write('scripts/local_text.py',"raise SystemExit('DMG_TEST_PREFLIGHT_PASSED')\n");
 for(const locale of ['zh','en'])write('locales/'+locale+'.json',JSON.stringify(catalogs[locale]));
 for(const file of sourceFiles)write(file,fs.readFileSync(file));
 fs.mkdirSync(path.join(root,'Own.app'));
 const metadata={};
 for(const locale of ['zh','en']){
  const fileAssets={};
  for(const name of ['background.html','background.png','background@2x.png','background.tiff','让 ChatGPT 来装.html','第一次打开.html','codexdoc.icns','helpdoc.icns']){
   let bytes=Buffer.from(locale+' preflight fixture '+name);
   if(name.endsWith('.png')){bytes=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.writeUInt32BE(name.includes('@2x')?1396:698,16);bytes.writeUInt32BE(name.includes('@2x')?1436:718,20);}
   write('ui/assets/dmg/'+locale+'/'+name,bytes);fileAssets[name]={sha256:sha(bytes)};
  }
  const stamp={format:1,width:698,height:718,version:JSON.parse(fs.readFileSync('package.json')).version,locale,
   template_sha256:sha(fs.readFileSync('ui/assets/dmg/src/background.template.html')),catalog_sha256:catalogFingerprint(catalogs),
   source_sha256:Object.fromEntries(sourceFiles.map(file=>[file,sha(fs.readFileSync(file))])),assets:fileAssets};
  metadata[locale]=stamp;write('ui/assets/dmg/'+locale+'/background.stamp.json',JSON.stringify(stamp));
 }
 const run=locale=>spawnSync('/usr/bin/python3',[path.join(root,'scripts/build-dmg.py'),'--app',path.join(root,'Own.app'),'--output',path.join(root,'never-built.dmg'),...(locale?['--locale',locale]:[])],{encoding:'utf8'});
 for(const locale of [undefined,'zh','en']){const result=run(locale);assert.match(result.stderr,/DMG_TEST_PREFLIGHT_PASSED/);assert.doesNotMatch(result.stderr,/codesign|hdiutil|dmgbuild/);}
 const changed={...catalogs.en,'dmg.jump.title':'Changed test fixture'};write('locales/en.json',JSON.stringify(changed));
 assert.match(run('en').stderr,/DMG_BACKGROUND_STAMP_INVALID/);
 write('locales/en.json',JSON.stringify(catalogs.en));
 write('ui/assets/dmg/en/background.stamp.json',JSON.stringify({...metadata.en,locale:'zh'}));
 assert.match(run('en').stderr,/DMG_BACKGROUND_STAMP_INVALID/);
 assert.equal(fs.existsSync(path.join(root,'never-built.dmg')),false);
});

test('Chrome renders generated fallback and synthetic English pages without network requests or page errors',async t=>{
 const outputDir=temp();t.after(()=>fs.rmSync(outputDir,{recursive:true,force:true}));
 const browser=await chromium.launch({executablePath:process.env.CHATHAND_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 t.after(()=>browser.close());
 for(const [mode,enCatalog] of [['fallback',{}],['synthetic',fixtureEnglish]]){
  const target=path.join(outputDir,mode);generateDmgSources({outputDir:target,catalogs:{zh:catalogs.zh,en:enCatalog}});
  for(const locale of ['zh','en'])for(const name of pageFiles){
   const page=await browser.newPage(),requests=[],errors=[];
   // Keep the real OS clipboard untouched; the page still executes its async copy flow.
   await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__copiedFixture=value;}}}));
   page.on('request',request=>requests.push(request.url()));page.on('pageerror',error=>errors.push(error.message));
   await page.goto(pathToFileURL(path.join(target,locale,name)).href);
   assert.deepEqual(errors,[]);assert.deepEqual(requests.filter(url=>!/^file:|^data:/.test(url)),[]);
   assert.equal(await page.locator('html').getAttribute('lang'),locale==='en'?'en':'zh-CN');
   const body=await page.locator('body').innerText();
   if(mode==='synthetic'&&locale==='en')assert.match(body,/EN fixture/);
   else assert.ok(body.includes(catalogs.zh[name==='background.html'?'dmg.background.title':name==='第一次打开.html'?'dmg.firstOpen.title':'dmg.jump.title']));
   if(name==='让 ChatGPT 来装.html'){
    await page.locator('#copy').click();
    await page.waitForFunction(()=>document.getElementById('after')?.textContent.length>0);
    assert.equal(typeof await page.evaluate(()=>window.__copiedFixture),'string');
    assert.equal(await page.locator('#after').textContent(),locale==='en'&&mode==='synthetic'?fixtureEnglish['dmg.prompt.copiedHint']:catalogs.zh['dmg.prompt.copiedHint']);
   }
   await page.close();
  }
 }
});
