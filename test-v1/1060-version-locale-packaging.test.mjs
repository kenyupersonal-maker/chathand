import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generatedFiles} from '../scripts/generate-version.mjs';
import {copyLocaleResources} from '../scripts/locale-resources.mjs';
import {compareVersions} from '../app/v1/support.mjs';
import {t} from '../app/i18n.mjs';

test('the existing updater orders beta10 after beta9 and does not recognize rc1',()=>{
 assert.equal(compareVersions('1.0.0-rc.1','1.0.0-beta.9'),null);
 assert.equal(compareVersions('1.0.0-beta.10','1.0.0-beta.9'),1);
 assert.equal(compareVersions('1.0.0-beta.9','1.0.0-beta.10'),-1);
});
test('generated1060 metadata preserves identity and does not restore the legacy process name',()=>{
 const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url)));
 pkg.version='1.0.0-beta.10';pkg.kenBridge.build_number=1060;
 const output=generatedFiles(pkg),plist=output['native/Info.plist'];
 assert.match(plist,/<key>CFBundleExecutable<\/key><string>ChatHand<\/string>/);
 assert.match(plist,/<key>CFBundleIdentifier<\/key><string>com\.kenyu\.chathand<\/string>/);
 assert.match(plist,/<key>CFBundleVersion<\/key><string>1060<\/string>/);
 const usage=t('native.permission.appleEventsUsage',{},'zh');
 assert.notEqual(usage,'native.permission.appleEventsUsage');
 assert.ok(plist.includes(usage));
 assert.doesNotMatch(plist,/I18N_KEY_MISSING/);
});
test('InfoPlist strings localize actual OS permission description and retain Chinese fallback',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1060-plist-locale-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'locales'));
 const tables={zh:{'fixture.name':'ChatHand','fixture.usage':'按要求控制其他应用。'},en:{'fixture.name':'','fixture.usage':'Control other apps as requested.'}};
 for(const lang of ['zh','en'])fs.writeFileSync(path.join(root,'locales',lang+'.json'),JSON.stringify(tables[lang]));
 const contents=path.join(root,'Temporary.app/Contents');
 copyLocaleResources(root,contents,{displayNameKey:'fixture.name',infoPlistKeys:{NSAppleEventsUsageDescription:'fixture.usage'}});
 const en=fs.readFileSync(path.join(contents,'Resources/en.lproj/InfoPlist.strings'),'utf8');
 assert.match(en,/"CFBundleDisplayName" = "ChatHand";/);
 assert.match(en,/"NSAppleEventsUsageDescription" = "Control other apps as requested\.";/);
 assert.match(fs.readFileSync(path.join(contents,'Resources/zh.lproj/InfoPlist.strings'),'utf8'),/按要求控制其他应用。/);
 assert.throws(()=>copyLocaleResources(root,contents,{infoPlistKeys:{Unsupported:'fixture.usage'}}),/I18N_INFO_PLIST_KEY_INVALID/);
});
