import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createTranslator, normalizeLocale, validateCatalogs, t, systemLocale, cardText} from '../../app/i18n.mjs';
import {copyLocaleResources} from '../../scripts/locale-resources.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
test('locale uses first system preference and unsupported/missing locale stays Chinese',()=>{
 for(const [input,want] of [[undefined,'zh'],['fr-FR','zh'],['zh-Hant-TW','zh'],['en_US','en'],[['fr','en'],'zh'],[['en-GB','zh'],'en']])assert.equal(normalizeLocale(input),want);
 assert.equal(systemLocale({preferredLanguages:['en-US']}),'en');
});
test('empty, whitespace and missing English all fall back to complete Chinese sentences',()=>{
 const tr=createTranslator({zh:{'x.one':'你好，{name}。','x.two':'完成。','x.three':'关闭。'},en:{'x.one':'  ','x.two':''}});
 assert.equal(tr('x.one',{name:'{other}'},'en-US'),'你好，{other}。');
 assert.equal(tr('x.two',{},'en'),'完成。');assert.equal(tr('x.three',{},'en'),'关闭。');
});
test('nonempty English and literal HTML parameters are plain text without recursive interpolation',()=>{
 const tr=createTranslator({zh:{x:'你好，{name}。'},en:{x:'Hello, {name}.'}});
 assert.equal(tr('x',{name:'<b>{secret}</b>',secret:'NO'},'en'),'Hello, <b>{secret}</b>.');
 assert.equal(tr('x',{},'en'),'Hello, {name}.');
});
test('unknown runtime key emits categorical diagnostic without supplied parameter values',()=>{
 const log=[],tr=createTranslator({zh:{x:'好'},en:{}},{diagnostic:e=>log.push(e)});
 assert.equal(tr('missing',{secret:'private'}),'missing');assert.deepEqual(log,[{code:'I18N_KEY_MISSING',key:'missing'}]);
});
test('build validation rejects missing Chinese, invalid values, and mismatched placeholder sets',()=>{
 assert.throws(()=>validateCatalogs({zh:{},en:{orphan:''}}),/CHINESE_MISSING/);
 assert.throws(()=>validateCatalogs({zh:{x:''},en:{}}),/CHINESE_MISSING/);
 assert.throws(()=>validateCatalogs({zh:{x:2},en:{}}),/CHINESE_MISSING/);
 assert.throws(()=>validateCatalogs({zh:{x:'{name}'},en:{x:'{other}'}}),/PLACEHOLDER_MISMATCH/);
 assert.throws(()=>validateCatalogs({zh:{x:'好'},en:{}},['absent']),/CHINESE_MISSING/);
 assert.doesNotThrow(()=>validateCatalogs({zh:{x:'好'},en:{}}));
});
test('root catalogs are real resources and caller cwd cannot change lookup',()=>{
 const result=spawnSync(process.execPath,['--input-type=module','-e',`import {t} from ${JSON.stringify(new URL("../../app/i18n.mjs",import.meta.url).href)};process.stdout.write(t('native.menu.quit',{},'en'));`],{cwd:os.tmpdir(),encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'Quit ChatHand');assert.equal(t('native.menu.quit'),'退出 ChatHand');
});
test('packaged app, runtime and installer receive exact two catalogs at module/bundle locations',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-i18n-'));
 try{copyLocaleResources(root,path.join(temp,'ChatHand.app/Contents'));copyLocaleResources(root,path.join(temp,'Installer.app/Contents'),{runtime:false,displayNameKey:'installer.appName'});
 for(const [language,title] of [['zh','安装或升级 ChatHand'],['en','Install or Update ChatHand']])assert.equal(fs.readFileSync(path.join(temp,'Installer.app/Contents/Resources',language+'.lproj/InfoPlist.strings'),'utf8'),`"CFBundleDisplayName" = "${title}";\n`);
 for(const folder of ['ChatHand.app/Contents/Resources/locales','ChatHand.app/Contents/Resources/runtime/locales','Installer.app/Contents/Resources/locales'])for(const lang of ['zh','en'])assert.deepEqual(fs.readFileSync(path.join(temp,folder,lang+'.json')),fs.readFileSync(path.join(root,'locales',lang+'.json')));
 fs.mkdirSync(path.join(temp,'ChatHand.app/Contents/Resources/runtime/app'),{recursive:true});fs.copyFileSync(path.join(root,'app/i18n.mjs'),path.join(temp,'ChatHand.app/Contents/Resources/runtime/app/i18n.mjs'));
 const result=spawnSync(process.execPath,['--input-type=module','-e',`import {t} from ${JSON.stringify(new URL('file://'+path.join(temp,'ChatHand.app/Contents/Resources/runtime/app/i18n.mjs')).href)};process.stdout.write(t('native.menu.quit'));`],{cwd:'/',encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'退出 ChatHand');
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('card locale comes only from host argument, absent or unsupported stays Chinese',()=>{
 assert.equal(cardText('en-US').locale,'en');assert.equal(cardText().locale,'zh');assert.equal(cardText('fr').locale,'zh');assert.equal(cardText('en').texts['card.action.resume'],'Let AI Continue');assert.equal(cardText().texts['card.action.resume'],'让 AI 继续');
});
test('Swift reads shared JSON and real app, standalone runtime helper, installer helper layouts',{skip:process.platform!=='darwin',timeout:120000},()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-native-i18n-'));
 try{
  const fixture=path.join(temp,'fixture');fs.mkdirSync(fixture);fs.writeFileSync(path.join(fixture,'zh.json'),JSON.stringify({'test.empty':'你好，{name}。','test.missingEnglish':'关闭。','test.english':'你好，{name}。'}));fs.writeFileSync(path.join(fixture,'en.json'),JSON.stringify({'test.empty':' ','test.english':'Hello, {name}.'}));
  const binary=path.join(temp,'compiled');const compiled=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','native/LocalText.swift','native/MenuBarState.swift','native/tests/LocalTextChecks.swift','-o',binary],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(compiled.status,0,compiled.stderr);
  for(const [relative,withRuntime] of [['Main.app/Contents/MacOS/Test',true],['Helper.app/Contents/Resources/runtime/bin/Test',true],['Installer.app/Contents/MacOS/Test',false]]){
   const contents=path.join(temp,relative.split('/Contents/')[0],'Contents'),target=path.join(temp,relative);copyLocaleResources(root,contents,{runtime:withRuntime});fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(binary,target);fs.chmodSync(target,0o755);
   // A standalone helper cannot rely on the external application's Bundle.main.
   if(relative.startsWith('Helper')){fs.rmSync(path.join(contents,'Resources/locales'),{recursive:true});fs.rmSync(path.join(contents,'Resources/runtime/locales/en.json'));}
   const result=spawnSync(target,[fixture],{cwd:'/',encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PASS: 13/);
  }
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('widget metadata carries normalized host locale with complete translated fallback templates',async()=>{
 const {widgetShellPresentation}=await import('../../app/v1/widget-shell.mjs');
 const view=widgetShellPresentation('show_task',{},'en-US');assert.equal(view.i18n.locale,'en');assert.equal(view.i18n.texts['card.result.selected'],'Selected “{label}”');assert.equal(widgetShellPresentation('show_task',{}).i18n.texts['card.result.selected'],'已选「{label}」');assert.equal(widgetShellPresentation('show_task',{}).i18n.locale,'zh');
});
test('installer bootstrap without Node reads the shared JSON rather than a duplicated string',{skip:process.platform!=='darwin'},()=>{
 const result=spawnSync('/bin/bash',[path.join(root,'scripts/local-text.sh'),'installer.openPackage'],{cwd:'/',encoding:'utf8',env:{PATH:'/usr/bin:/bin'}});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),t('installer.openPackage'));
});
test('packaging Python resolves same JSON independent of cwd and keeps values literal',()=>{
 const script=`import sys;sys.path.insert(0,${JSON.stringify(path.join(root,'scripts'))});from local_text import local_text,normalize_locale;assert normalize_locale('en_US') == 'en';assert normalize_locale('fr') == 'zh';assert local_text('card.result.selected',{'label':'<b>{other}</b>'},'en') == 'Selected “<b>{other}</b>”';print(local_text('dmg.entry',locale='en'))`;
 const result=spawnSync('/usr/bin/python3',['-B','-c',script],{cwd:'/',encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'AI Setup.html');
});
test('deployed Node runtime tolerates a missing English catalog and still uses Chinese',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-missing-en-'));
 try{
  const app=path.join(temp,'app');fs.mkdirSync(app);fs.mkdirSync(path.join(temp,'locales'));fs.copyFileSync(path.join(root,'app/i18n.mjs'),path.join(app,'i18n.mjs'));fs.copyFileSync(path.join(root,'locales/zh.json'),path.join(temp,'locales/zh.json'));
  const result=spawnSync(process.execPath,['--input-type=module','-e',`import {t} from ${JSON.stringify(new URL('file://'+path.join(app,'i18n.mjs')).href)};process.stdout.write(t('native.menu.quit',{},'en'));`],{cwd:'/',encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'退出 ChatHand');assert.match(result.stderr,/I18N_CATALOG_UNAVAILABLE en/);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('notification templates localize known labels while preserving caller supplied names literally',async()=>{
 const {Confirmations}=await import('../../app/v1/confirmations.mjs');
 for(const name of ['命令','外部名称{secret}']){
  const events=[],confirm=new Confirmations({emit:(kind,data)=>events.push({kind,data})});
  try{confirm.create({task_id:'locale-fixture',blocked:{kind:'can_enable',gate:'capability',item:{id:'terminal',name},cause:'fixture',effect:{},where:{}}});const event=events.find(e=>e.kind==='confirmation_required');assert.equal(event.data.title,'ChatGPT 请求使用「'+name+'」');}finally{confirm.close();}
 }
});
