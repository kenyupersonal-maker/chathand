import {patchChromeScreenshot} from './patch-chrome-screenshot.mjs';
import {copyLocaleResources} from './locale-resources.mjs';
import {packageChromeLocales} from './package-chrome-locales.mjs';
import {bundleTunnel} from './bundle-tunnel.mjs';
import {signApplication} from './signing.mjs';
import {stageProcessCompatibility,validateProcessIdentityBaseline} from './process-identity.mjs';
import {preflightSiteTemplate,copySiteTemplate} from './site-template-package.mjs';
import {copyBundleTree,swiftPrivacyFlags,clangPrivacyFlags,swiftPackagePrivacyFlags} from './build-privacy.mjs';
import {resolveIsolatedUnsignedOptions,assertFreshIsolatedTarget,swiftIsolationArguments,swiftIsolationEnvironment,swiftCompilerCacheArguments} from './build-v09-isolation.mjs';
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')),logs=[];
const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1]};
const unsigned=args.includes('--unsigned');
const isolated=resolveIsolatedUnsignedOptions(args,{root,unsigned});
const identityFile=option('--process-identity-baseline');
const outputArg=option('--output'),npmArg=option('--npm')||(args[0]&&!args[0].startsWith('--')?args[0]:undefined);
const app=isolated?.app||path.resolve(root,outputArg||path.join('dist','ChatHand.app'));
const reports=isolated?.reports||path.join(root,'reports'),bin=isolated?.bin||path.join(root,'bin');
if(isolated)assertFreshIsolatedTarget(isolated);
fs.mkdirSync(reports,{recursive:true});
const reportSuffix=outputArg?`-${path.basename(app,'.app').replace(/[^A-Za-z0-9._-]+/g,'-')}`:'';
const buildReportPath=path.join(reports,`build-v09${reportSuffix}.json`),buildLogPath=path.join(reports,`build-v09${reportSuffix}-log.json`);
function run(program,commandArgs,timeout=120000){const swiftPMArgs=isolated&&program==='/usr/bin/xcrun'&&commandArgs[0]==='swift'&&commandArgs[1]==='build'?swiftIsolationArguments(isolated):[];const swiftCompilerArgs=isolated&&program==='/usr/bin/xcrun'&&commandArgs[0]==='swiftc'?swiftCompilerCacheArguments(isolated):[];const env=isolated?swiftIsolationEnvironment(isolated):undefined;const finalArgs=[...commandArgs,...swiftPMArgs,...swiftCompilerArgs];const r=spawnSync(program,finalArgs,{cwd:root,env,encoding:'utf8',timeout,maxBuffer:8*1024*1024});logs.push({program,args:finalArgs,exit_code:r.status,stdout:r.stdout||'',stderr:r.stderr||''});if(r.status!==0)throw Error('BUILD_FAILED '+path.basename(program)+' '+(r.stderr||r.stdout||r.error?.message||'').slice(-3000));return r.stdout;}
function copy(a,b){copyBundleTree(a,b,root);}
try{
 if(unsigned&&!outputArg)throw Error('UNSIGNED_BUILD_REQUIRES_EXPLICIT_ISOLATED_OUTPUT');
 const processIdentityBaseline=identityFile?validateProcessIdentityBaseline(JSON.parse(fs.readFileSync(identityFile,'utf8'))):null;
 if(!unsigned&&!processIdentityBaseline)throw Error('PROCESS_IDENTITY_BASELINE_REQUIRED');
 if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('APPLE_SILICON_MAC_REQUIRED');run(process.execPath,['scripts/generate-version.mjs','--check']);run(process.execPath,['scripts/check-contract.mjs']);
 const sourceCommit=run('/usr/bin/git',['rev-parse','HEAD']).trim();
 if(run('/usr/bin/git',['status','--porcelain','--untracked-files=normal']).trim())throw Error('SOURCE_NOT_FROZEN');
 const siteTemplate=preflightSiteTemplate(root);
 if(fs.existsSync(app))throw Error('BUILD_ALREADY_EXISTS');const contents=path.join(app,'Contents'),runtime=path.join(contents,'Resources/runtime');for(const d of ['MacOS','Resources/runtime/bin','Resources/runtime/engine'])fs.mkdirSync(path.join(contents,d),{recursive:true});
 fs.mkdirSync(bin,{recursive:true});
 fs.copyFileSync(path.join(root,'native/Info.plist'),path.join(contents,'Info.plist'));
 copyLocaleResources(root,contents,{infoPlistKeys:{NSAppleEventsUsageDescription:'native.permission.appleEventsUsage'}});run(process.execPath,['scripts/check-locales.mjs']);run(process.execPath,['scripts/ui-locale-resources.mjs','--check']);
 for(const name of ['AppIcon.icns','MenuBarIcon.png','MenuBarIcon@2x.png','AppIcon-rounded-512.png'])fs.copyFileSync(path.join(root,'ui/assets/app',name),path.join(contents,'Resources',name));
 copy(path.join(root,'codex'),path.join(contents,'Resources/codex'));
 const target=process.arch+'-apple-macosx14.0';
 run('/usr/bin/xcrun',['swift','build','--package-path','native','-c','release','--triple',target,'--product','ChatHandShell',...swiftPackagePrivacyFlags(root)]);
 const swiftBin=run('/usr/bin/xcrun',['swift','build','--package-path','native','-c','release','--triple',target,'--show-bin-path']).trim();
 fs.copyFileSync(path.join(swiftBin,'ChatHandShell'),path.join(contents,'MacOS/KenBridge'));
 copy(path.join(swiftBin,'PermissionFlow_PermissionFlow.bundle'),path.join(contents,'Resources/PermissionFlow_PermissionFlow.bundle'));
 run('/usr/bin/xcrun',['swiftc',...swiftPrivacyFlags(root),'-swift-version','5','-parse-as-library','-O','-framework','Cocoa','native/UpgradeControl.swift','native/InstanceLifecycle.swift','-o',path.join(runtime,'bin/ken-upgrade-control')]);
 run('/usr/bin/xcrun',['clang',...clangPrivacyFlags(root),'-O2','-c','native/SQLiteDescriptorVFS.c','-o',path.join(bin,'sqlite-descriptor-vfs.o')]);
 run('/usr/bin/xcrun',['swiftc',...swiftPrivacyFlags(root),'-swift-version','5','-O','-framework','Foundation','-framework','PDFKit','native/DocumentReader.swift',path.join(bin,'sqlite-descriptor-vfs.o'),'-lsqlite3','-o',path.join(bin,'ken-document-reader')]);
 run('/usr/bin/xcrun',['swiftc',...swiftPrivacyFlags(root),'-swift-version','5','-O','native/LocalText.swift','native/BrowserHost.swift','-o',path.join(runtime,'bin/ken-browser-host')]);
 run('/usr/bin/xcrun',['swiftc',...swiftPrivacyFlags(root),'-swift-version','5','-parse-as-library','-DARTIFACT_IO_CLI','-O','-framework','Foundation','-framework','ImageIO','-framework','CoreGraphics','native/ArtifactFileAccess.swift','-o',path.join(runtime,'bin/ken-artifact-io')],300000);
 for(const f of ['app','ui','connectors','cloud','contracts','scripts','browser-extension','skills','plugins'])copy(path.join(root,f),path.join(runtime,f));copy(path.join(root,'engine/src'),path.join(runtime,'engine/src'));copy(path.join(root,'node_modules'),path.join(runtime,'node_modules'));
 packageChromeLocales(runtime);
 const screenshotAdapter=patchChromeScreenshot(runtime);
 copySiteTemplate(siteTemplate,runtime);
 copy(path.join(root,'licenses'),path.join(runtime,'licenses'));
 for(const f of ['package.json','package-lock.json','LICENSE','THIRD_PARTY_NOTICES.md'])fs.copyFileSync(path.join(root,f),path.join(runtime,f));fs.copyFileSync(process.execPath,path.join(runtime,'bin/node'));fs.copyFileSync(path.join(bin,'ken-document-reader'),path.join(runtime,'bin/ken-document-reader'));
 const tunnelRuntime=await bundleTunnel(runtime,isolated?{cache:isolated.tunnelCache}:undefined);
 const npm=npmArg||path.resolve(process.execPath,'../../lib/node_modules/npm');if(fs.existsSync(npm)){copy(npm,path.join(runtime,'lib/node_modules/npm'));fs.symlinkSync('../lib/node_modules/npm/bin/npm-cli.js',path.join(runtime,'bin/npm'));fs.symlinkSync('../lib/node_modules/npm/bin/npx-cli.js',path.join(runtime,'bin/npx'));}
 for(const f of ['bin/node','bin/ken-document-reader','bin/ken-upgrade-control','bin/ken-browser-host','bin/ken-artifact-io']){fs.chmodSync(path.join(runtime,f),0o755);}
 const processLayout=stageProcessCompatibility(app,{root,run});
 if(run('/usr/bin/git',['rev-parse','HEAD']).trim()!==sourceCommit||run('/usr/bin/git',['status','--porcelain','--untracked-files=normal']).trim())throw Error('SOURCE_CHANGED_DURING_BUILD');
 // One identity per App build, shared by both language DMGs and sealed by the
 // App signature. Local previews may keep the same public build number.
 const provenance={build_id:crypto.randomUUID(),chrome_screenshot_adapter:screenshotAdapter,build_number:pkg.kenBridge.build_number,tunnel_runtime:tunnelRuntime,artifact_io_sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(runtime,'bin/ChatHandArtifactIO'))).digest('hex'),version:pkg.version,source_commit:sourceCommit,source_clean:true,platform:process.platform,arch:process.arch,node:process.version,package_lock_sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'package-lock.json'))).digest('hex'),built_at:new Date().toISOString()};
 const writeProvenance=()=>{provenance.artifact_io_sha256=crypto.createHash('sha256').update(fs.readFileSync(path.join(runtime,'bin/ChatHandArtifactIO'))).digest('hex');fs.writeFileSync(path.join(runtime,'build-provenance.json'),JSON.stringify(provenance,null,2)+'\n');};
 provenance.process_layout=processLayout;
 const signature=unsigned?(writeProvenance(),{verification:'UNSIGNED_DEVELOPMENT_ONLY'}):signApplication(app,undefined,{beforeSeal:writeProvenance,processIdentityBaseline});
 const metadata=JSON.parse(run(path.join(contents,'MacOS/KenBridge'),['--self-check']));if(metadata.version!==pkg.version||metadata.bundle_id!=='com.kenyu.chathand')throw Error('BUNDLE_METADATA_MISMATCH');
 const permissions=isolated?undefined:JSON.parse(run(path.join(contents,'MacOS/KenBridge'),['--computer-status']));
 const result={status:'PASS',version:pkg.version,artifact:app,provenance,signature,minimum_macos:'14.0',...(isolated?{native_permissions_observed:'NOT_TESTED'}:{native_permissions_observed:permissions}),desktop_action_acceptance:'NOT_TESTED_REQUIRES_LOCAL_PERMISSION',live_upgrade_acceptance:'NOT_EXECUTED',time:new Date().toISOString()};fs.writeFileSync(buildReportPath,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(e){fs.writeFileSync(buildReportPath,JSON.stringify({status:'FAIL',error:e.message},null,2));console.error(e.message);process.exitCode=1;}
finally{fs.writeFileSync(buildLogPath,JSON.stringify(logs,null,2));}
