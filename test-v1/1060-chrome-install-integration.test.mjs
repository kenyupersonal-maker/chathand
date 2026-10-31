import {createLegacyChromeInstallSource} from '../test-support/legacy-chrome-install-source.mjs';
import {legacyChromeDistribution} from '../app/v1/chrome-distribution.mjs';
const publishHelper=options=>productionPublishHelper({...options,distribution:legacyChromeDistribution()});
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {publishHelper as productionPublishHelper} from '../app/v1/chrome-helper-source.mjs';
import {installSource,helperFingerprint,INSTALL_SOURCE_FILES,LEGACY_INSTALL_SOURCE_FILES} from '../app/v1/chrome-install-probe.mjs';
import {frame,FrameReader,nativeSystemLanguage} from '../app/v09/extension-host.mjs';
import {setSystemLanguage,languageState} from '../browser-extension/locale.js';

const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function home(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1060-helper-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}

test('published helper includes every locale, icon and imported module with a matching fingerprint',t=>{
 const root=createLegacyChromeInstallSource(t,{sourceRoot:repositoryRoot});
 const result=publishHelper({root,home:home(t)}),manifest=JSON.parse(fs.readFileSync(path.join(result.folder,'manifest.json')));
 assert.equal(helperFingerprint(result.folder),installSource(root).fingerprint);
 for(const item of INSTALL_SOURCE_FILES)assert.equal(fs.lstatSync(path.join(result.folder,item)).isFile(),true,item);
 for(const icon of Object.values(manifest.icons))assert.ok(fs.existsSync(path.join(result.folder,icon)));
 for(const locale of ['zh_CN','en'])assert.ok(fs.existsSync(path.join(result.folder,'_locales',locale,'messages.json')));
 for(const module of ['background.js','experience.js','popup.js','locale.js']){
  const source=fs.readFileSync(path.join(result.folder,module),'utf8');
  for(const match of source.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g))assert.ok(fs.existsSync(path.resolve(result.folder,match[1])),match[1]);
 }
});

test('an authentic older helper layout is replaced and its previous directory is retained',t=>{
 const root=createLegacyChromeInstallSource(t,{sourceRoot:repositoryRoot});
 const userHome=home(t),first=publishHelper({root,home:userHome}),manifestPath=path.join(first.folder,'manifest.json');
 const current=JSON.parse(fs.readFileSync(manifestPath)),oldBuild=installSource(root).build-1,old={...current,version:'1.0.0.'+oldBuild,name:'ChatHand browser helper'};
 delete old.default_locale;delete old.icons;
 if(old.action)old.action={...old.action,default_icon:undefined};
 fs.writeFileSync(manifestPath,JSON.stringify(old));
 for(const item of INSTALL_SOURCE_FILES.filter(x=>!LEGACY_INSTALL_SOURCE_FILES.includes(x)))fs.renameSync(path.join(first.folder,item),path.join(first.folder,item+'.saved'));
 const update=publishHelper({root,home:userHome});
 assert.equal(update.changed,true);assert.ok(update.backup);
 assert.equal(JSON.parse(fs.readFileSync(path.join(update.backup,'manifest.json'))).version,'1.0.0.'+oldBuild);
 assert.equal(helperFingerprint(update.folder),installSource(root).fingerprint);
});

test('a current helper missing a required module is not mistaken for a legacy layout',t=>{
 const root=createLegacyChromeInstallSource(t,{sourceRoot:repositoryRoot});
 const userHome=home(t),first=publishHelper({root,home:userHome});
 fs.renameSync(path.join(first.folder,'locale.js'),path.join(first.folder,'locale.js.saved'));
 assert.throws(()=>publishHelper({root,home:userHome}),{code:'ENOENT'});
 assert.ok(fs.existsSync(path.join(first.folder,'locale.js.saved')));
});

test('native OS language crosses the real framing protocol; missing or unrelated locale stays unproven',()=>{
 assert.equal(nativeSystemLanguage({LANG:'en_US.UTF-8'}),null);
 assert.equal(nativeSystemLanguage({CHATHAND_SYSTEM_LOCALE:'<invalid>'}),null);
 for(const locale of ['en-US','zh-Hans-CN']){
  const message=nativeSystemLanguage({CHATHAND_SYSTEM_LOCALE:locale});
  const delivered=[];const reader=new FrameReader(value=>delivered.push(value));const bytes=frame(message);
  reader.push(bytes.subarray(0,3));reader.push(bytes.subarray(3));
  assert.deepEqual(delivered,[{kind:'system_language',source:'system',locale}]);
  assert.equal(setSystemLanguage(delivered[0]),true);
  assert.equal(languageState().locale,locale.startsWith('en')?'en':'zh');
 }
});
