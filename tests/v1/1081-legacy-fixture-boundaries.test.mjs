import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createDesktop} from '../../app/server.mjs';
import {legacyChromeDistribution} from '../../app/v1/chrome-distribution.mjs';
import {installSource} from '../../app/v1/chrome-install-probe.mjs';
import {alignLegacyFixtureManifest} from '../support/legacy-chrome-install-source.mjs';
import {storeTestDistribution} from '../support/chrome-store-fixture.mjs';
import {fixture,waitFor} from './1070-chrome-server-fixture.mjs';
const repositoryRoot=fileURLToPath(new URL('../../',import.meta.url));
function temporary(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'1081-legacy-boundary-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}

test('legacy source override refuses store/default distributions and non-temporary paths before state writes',async t=>{
 const root=temporary(t),stateDir=path.join(root,'state');
 for(const chromeDistribution of [undefined,storeTestDistribution()]){
  await assert.rejects(createDesktop({stateDir,clientDeps:{chromeDistribution,legacyChromeInstallRoot:root}}),/LEGACY_CHROME_TEST_ROOT_REQUIRED/);
  assert.equal(fs.existsSync(stateDir),false);
 }
 await assert.rejects(createDesktop({stateDir,clientDeps:{chromeDistribution:legacyChromeDistribution(),legacyChromeInstallRoot:repositoryRoot}}),/ISOLATED_UPDATE_PATH_REQUIRED/);
 assert.equal(fs.existsSync(stateDir),false);
 assert.throws(()=>alignLegacyFixtureManifest(repositoryRoot),/ISOLATED_UPDATE_PATH_REQUIRED/);
});

test('legacy source override is unavailable outside the Node test runner',t=>{
 const root=temporary(t),stateDir=path.join(root,'state'),env={...process.env};delete env.NODE_TEST_CONTEXT;
 const source=`import {createDesktop} from ${JSON.stringify(new URL("../../app/server.mjs",import.meta.url).href)};\ntry { await createDesktop({stateDir:${JSON.stringify(stateDir)},clientDeps:{chromeDistribution:{distribution:'legacy_unpacked'},legacyChromeInstallRoot:${JSON.stringify(root)}}});process.exitCode=2; } catch(e) { if(e.message!=='LEGACY_CHROME_TEST_ROOT_REQUIRED')throw e; }`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',source],{env,encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);assert.equal(fs.existsSync(stateDir),false);
});

test('legacy server prepares its temporary package while ordinary store setup retains the product source',async t=>{
 const f=fixture(t,{chromeDistribution:legacyChromeDistribution(),browser:true,optedIn:true,preference:'none'}),app=await f.building;
 await waitFor(()=>f.calls.registers===1);
 const ext=app.tools.automation.browser.extension,sourceRoot=ext.installProbe.root;
 assert.notEqual(sourceRoot,path.resolve(repositoryRoot));
 const source=installSource(sourceRoot),prepared=await f.post('/api/browser/extension/prepare');
 assert.equal(prepared.status,200);
 assert.equal(JSON.parse(fs.readFileSync(path.join(prepared.body.extension_folder,'manifest.json'),'utf8')).version,source.version);
 const original=JSON.parse(fs.readFileSync(new URL('../../browser-extension/manifest.json',import.meta.url),'utf8'));
 assert.equal(ext.expectedHelper().version,original.version,'installer injection does not replace normal helper expectations');
});

test('ordinary store server does not create a legacy package or override source resolution',async t=>{
 const f=fixture(t,{chromeDistribution:storeTestDistribution(),browser:false,preference:'none'}),app=await f.building;
 assert.equal(app.tools.automation.browser.extension.installProbe.root,path.resolve(repositoryRoot));
 assert.equal(app.tools.automation.browser.extension.expectedHelper(),null);
});
