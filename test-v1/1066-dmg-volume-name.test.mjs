// Actual packager CLI/preflight in a synthetic tree. Stop at the existing text
// import boundary, before codesign, Swift, dmgbuild or hdiutil can be invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {catalogFingerprint,sourceFiles} from '../ui/assets/dmg/src/localize.mjs';
const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-dmg-name1066-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const write=(name,bytes)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);};
 write('package.json',JSON.stringify({version:'1.0.0-fixture'}));write('scripts/build-dmg.py',fs.readFileSync(process.env.CHATHAND_DMG_PACKAGER_SOURCE||path.join(repository,'scripts/build-dmg.py')));
 const catalogs={zh:{'dmg.entry':'中文入口','dmg.help':'中文说明','dmg.applications':'应用程序'},en:{'dmg.entry':'Entry','dmg.help':'Help','dmg.applications':'Applications'}};
 for(const lang of ['zh','en'])write('locales/'+lang+'.json',JSON.stringify(catalogs[lang]));
 for(const file of sourceFiles)write(file,'synthetic source '+file);
 fs.mkdirSync(path.join(root,'Own.app'));
 const sourceHashes=Object.fromEntries(sourceFiles.map(file=>[file,sha(fs.readFileSync(path.join(root,file)))]));
 for(const locale of ['zh','en']){
  const assets={};for(const name of ['background.html','background.png','background@2x.png','background.tiff','让 ChatGPT 来装.html','第一次打开.html','codexdoc.icns','helpdoc.icns']){
   let bytes=Buffer.from(locale+' synthetic '+name);
   if(name.endsWith('.png')){bytes=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.writeUInt32BE(name.includes('@2x')?1396:698,16);bytes.writeUInt32BE(name.includes('@2x')?1436:718,20);}
   write('ui/assets/dmg/'+locale+'/'+name,bytes);assets[name]={sha256:sha(bytes)};
  }
  write('ui/assets/dmg/'+locale+'/background.stamp.json',JSON.stringify({format:1,width:698,height:718,version:'1.0.0-fixture',locale,template_sha256:sourceHashes['ui/assets/dmg/src/background.template.html'],catalog_sha256:catalogFingerprint(catalogs),source_sha256:sourceHashes,assets}));
 }
 write('scripts/local_text.py',`import json, sys
frame = sys._getframe()
while frame is not None and not str(frame.f_globals.get('__file__', '')).endswith('/scripts/build-dmg.py'):
    frame = frame.f_back
if frame is None:
    raise SystemExit('DMG_TEST_CALLER_MISSING')
state = frame.f_globals
print(json.dumps({'volume_name': state['volume_name'], 'locale': state['locale'], 'asset_locale': state['assets'].name}, ensure_ascii=False))
raise SystemExit('DMG_TEST_PREFLIGHT_ONLY')
`);
 const run=args=>spawnSync(process.env.CHATHAND_TEST_PYTHON||'/usr/bin/python3',[path.join(root,'scripts/build-dmg.py'),'--app',path.join(root,'Own.app'),'--output',path.join(root,'never-built.dmg'),...args],{encoding:'utf8',env:{...process.env,PYTHONIOENCODING:'utf-8'}});
 return {root,run};
}
test('1066 actual CLI gives Chinese and English different default volume names, preserving English and explicit overrides',t=>{
 const f=fixture(t),names=[];
 for(const [args,expected,locale] of [[[],'ChatHand 1.0.0-fixture 中文','zh'],[['--locale','zh'],'ChatHand 1.0.0-fixture 中文','zh'],[['--locale','en'],'ChatHand 1.0.0-fixture','en'],[['--locale','zh','--volume-name','Explicit Fixture'],'Explicit Fixture','zh'],[['--locale','en','--volume-name','Explicit Fixture'],'Explicit Fixture','en']]){
  const result=f.run(args);assert.notEqual(result.status,0);assert.match(result.stderr,/DMG_TEST_PREFLIGHT_ONLY/);assert.doesNotMatch(result.stderr,/codesign|hdiutil|dmgbuild/);const output=JSON.parse(result.stdout);assert.equal(output.volume_name,expected);assert.equal(output.locale,locale);assert.equal(output.asset_locale,locale);names.push(output.volume_name);
 }
 assert.equal(names[0],names[1]);assert.notEqual(names[1],names[2],'default mount names cannot collide across the two languages');assert.equal(fs.existsSync(path.join(f.root,'never-built.dmg')),false);
});
test('1066 volume naming leaves the actual stale-background preflight in force for both languages',t=>{
 const f=fixture(t);for(const locale of ['zh','en']){fs.appendFileSync(path.join(f.root,'ui/assets/dmg',locale,'background.tiff'),'stale bitmap');const result=f.run(['--locale',locale]);assert.notEqual(result.status,0);assert.match(result.stderr,/DMG_BACKGROUND_STAMP_INVALID/);assert.doesNotMatch(result.stderr,/DMG_TEST_PREFLIGHT_ONLY|codesign|hdiutil|dmgbuild/);assert.equal(result.stdout,'');assert.equal(fs.existsSync(path.join(f.root,'never-built.dmg')),false);}
});
