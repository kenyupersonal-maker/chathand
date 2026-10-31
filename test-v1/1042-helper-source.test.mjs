import {createLegacyChromeInstallSource} from '../test-support/legacy-chrome-install-source.mjs';
import {legacyChromeDistribution} from '../app/v1/chrome-distribution.mjs';
class ChromeInstallProbe extends ProductionChromeInstallProbe {constructor(options){super({...options,distribution:legacyChromeDistribution()});}}
const publishHelper=options=>productionPublishHelper({...options,distribution:legacyChromeDistribution()});
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {publishHelper as productionPublishHelper,helperFolder} from '../app/v1/chrome-helper-source.mjs';
import {installSource,helperFingerprint,ChromeInstallProbe as ProductionChromeInstallProbe} from '../app/v1/chrome-install-probe.mjs';
const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function temp(t){const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1042-copy-')));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));return home;}
test('stable helper publication matches bundle, idempotent and old pinned copy is recoverable',t=>{
 const root=createLegacyChromeInstallSource(t,{sourceRoot:repositoryRoot});
 const home=temp(t),first=publishHelper({root,home});assert.equal(first.folder,helperFolder(home));assert.equal(helperFingerprint(first.folder),installSource(root).fingerprint);
 assert.equal(publishHelper({root,home}).changed,false);fs.appendFileSync(path.join(first.folder,'popup.css'),'\n/* old version fixture */');
 const second=publishHelper({root,home});assert.equal(second.changed,true);assert.equal(fs.existsSync(second.backup),true);assert.equal(helperFingerprint(second.folder),first.fingerprint);
 assert.match(fs.readFileSync(path.join(second.backup,'popup.css'),'utf8'),/old version fixture/);
});
test('linked old manifest or unrelated pinned identity is refused before publication',t=>{
 const root=createLegacyChromeInstallSource(t,{sourceRoot:repositoryRoot});
 const home=temp(t),result=publishHelper({root,home}),manifest=path.join(result.folder,'manifest.json'),original=fs.readFileSync(manifest);
 fs.renameSync(manifest,manifest+'.old');fs.symlinkSync(manifest+'.old',manifest);assert.throws(()=>publishHelper({root,home}),{code:'INSTALL_SOURCE_CHANGED'});
 fs.unlinkSync(manifest);fs.renameSync(manifest+'.old',manifest);const data=JSON.parse(original);data.key='different-public-key';fs.writeFileSync(manifest,JSON.stringify(data));
 assert.throws(()=>publishHelper({root,home}),{code:'INSTALL_SOURCE_CHANGED'});assert.equal(JSON.parse(fs.readFileSync(manifest)).key,'different-public-key');
});
test('revoked publish guard leaves no helper, no stage and no unrelated writes',t=>{
 const root=createLegacyChromeInstallSource(t,{sourceRoot:repositoryRoot});
 const home=temp(t);let calls=0;const guard=()=>{if(++calls>=5)throw Object.assign(Error(),{code:'INSTALL_ACCESS_CHANGED'});};
 assert.throws(()=>publishHelper({root,home,guard}),{code:'INSTALL_ACCESS_CHANGED'});const parent=path.dirname(helperFolder(home));assert.equal(fs.existsSync(helperFolder(home)),false);assert.equal(fs.readdirSync(parent).some(n=>n.startsWith('.chrome-helper-staging-')),false);
});
test('loaded helper copy mutation invalidates native lease without exposing the folder',t=>{
 const root=createLegacyChromeInstallSource(t,{sourceRoot:repositoryRoot});
 const home=temp(t),copy=publishHelper({root,home}),policy={epoch:1,permissionRevision:0,check(){}},extension={session:null,pending:new Map(),status:()=>({connected:true})};
 const probe=new ChromeInstallProbe({root,state:{data:{browser_enabled:true,desktop_enabled:true}},policy,extension,origin:()=> 'http://127.0.0.1:12345'});
 const begin=probe.begin(),lease=probe.setFolder(begin.lease_id,copy.folder);assert.equal(lease.extension_folder,copy.folder);
 fs.appendFileSync(path.join(copy.folder,'background.js'),'\n//changed');assert.equal(probe.publicStatus().active,false);assert.equal(JSON.stringify(probe.publicStatus()).includes(copy.folder),false);probe.close();
});
