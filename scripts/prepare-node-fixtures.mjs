// Explicit preparation, separate from tests and from App/DMG packaging.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){if(!['--root','--out','--sites-prepare'].includes(args[i])||!args[i+1])throw Error('Expected --out DIRECTORY [--root REPO] [--sites-prepare FILE]');options[args[i]]=args[i+1];}
if(process.platform!=='darwin')throw Error('Native fixtures require macOS');
if(!options['--out'])throw Error('Explicit --out DIRECTORY is required');
const root=fs.realpathSync(options['--root']||fileURLToPath(new URL('../',import.meta.url))),out=path.resolve(options['--out']);
if(out===root||out.startsWith(root+path.sep))throw Error('Fixture output must be outside the source worktree');
fs.mkdirSync(out,{mode:0o700});
const digest=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sourceFiles=['native/ArtifactFileAccess.swift','native/DocumentReader.swift','native/SQLiteDescriptorVFS.c','native/UpgradeControl.swift','native/InstanceLifecycle.swift','native/tests/ExactAppProcessTests.swift','native/tests/InstanceLifecycleFixture.swift','native/tests/UpgradeLaunchScopeFixture.swift','native/tests/SleepFixture.swift'];
const sources=Object.fromEntries(sourceFiles.map(p=>[p,digest(path.join(root,p))]));
const commands=[],env={...process.env,SWIFT_MODULECACHE_PATH:path.join(out,'swift-cache'),CLANG_MODULE_CACHE_PATH:path.join(out,'clang-cache')};
function run(command,args){
 commands.push([command,...args]);
 const r=spawnSync(command,args,{cwd:root,env,encoding:'utf8',timeout:300000});
 fs.appendFileSync(path.join(out,'compile.log'),JSON.stringify(commands.at(-1))+'\n'+(r.stdout||'')+(r.stderr||''));
 if(r.error||r.status!==0)throw Error('Fixture compilation failed; inspect '+path.join(out,'compile.log'));
}
const binaries={};
function compile(name,files,flags=[]){
 const destination=path.join(out,name);
 run('/usr/bin/xcrun',['swiftc','-swift-version','5','-module-cache-path',path.join(out,'swift-cache'),...flags,...files,'-o',destination]);
 binaries[name]={path:destination,sha256:digest(destination),sources:files.filter(p=>Object.hasOwn(sources,p))};
}
run('/usr/bin/xcrun',['clang','-O2','-c','native/SQLiteDescriptorVFS.c','-o',path.join(out,'sqlite-descriptor-vfs.o')]);
compile('document_reader',['native/DocumentReader.swift',path.join(out,'sqlite-descriptor-vfs.o')],['-O','-framework','Foundation','-framework','PDFKit','-lsqlite3']);
binaries.document_reader.sources.push('native/SQLiteDescriptorVFS.c');
compile('artifact_io',['native/ArtifactFileAccess.swift'],['-parse-as-library','-DARTIFACT_IO_CLI','-O','-framework','Foundation','-framework','ImageIO','-framework','CoreGraphics']);
compile('upgrade_control',['native/UpgradeControl.swift','native/InstanceLifecycle.swift'],['-parse-as-library','-framework','Cocoa']);
compile('exact_app_process_tests',['native/UpgradeControl.swift','native/InstanceLifecycle.swift','native/tests/ExactAppProcessTests.swift'],['-parse-as-library','-DEXACT_APP_PROCESS_TESTS','-framework','Cocoa']);
compile('instance_lifecycle_fixture',['native/InstanceLifecycle.swift','native/tests/InstanceLifecycleFixture.swift'],['-parse-as-library','-framework','Cocoa']);
compile('upgrade_launch_scope_fixture',['native/InstanceLifecycle.swift','native/tests/UpgradeLaunchScopeFixture.swift'],['-parse-as-library','-framework','Cocoa']);
compile('sleep_fixture',['native/tests/SleepFixture.swift']);
if(options['--sites-prepare']){
 const plugin=path.resolve(path.dirname(options['--sites-prepare']),'../../..');
 const files={sites_prepare:'skills/sites/scripts/prepare-site-build.cjs',sites_package:'scripts/package-site.mjs',sites_archive_path:'scripts/archive-path.mjs',sites_metrics:'scripts/workflow-metrics.mjs'};
 for(const [name,relative] of Object.entries(files)){
  const original=path.join(plugin,relative),destination=path.join(out,'sites-tool',relative);
  if(!fs.lstatSync(original).isFile())throw Error('Sites input must be a regular file: '+relative);
  const originalHash=digest(original);fs.mkdirSync(path.dirname(destination),{recursive:true});
  fs.copyFileSync(original,destination,fs.constants.COPYFILE_EXCL);
  if(digest(destination)!==originalHash)throw Error('Sites helper copy changed');
  binaries[name]={path:destination,sha256:originalHash,sources:[],original};
 }
 binaries.sites_package.dependencies=['sites_prepare','sites_archive_path','sites_metrics'];
}
for(const [file,hash] of Object.entries(sources))if(digest(path.join(root,file))!==hash)throw Error('Source changed during preparation: '+file);
const manifest={schema_version:1,purpose:'explicit-node-fixtures',platform:process.platform,arch:process.arch,prepared_at:new Date().toISOString(),source_root:root,sources,binaries,commands};
const file=path.join(out,'manifest.json');fs.writeFileSync(file,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({manifest:file,sha256:digest(file),components:Object.keys(binaries)}));
