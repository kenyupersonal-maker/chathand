import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ORIGINAL, SCENARIOS, initialize, validateConfig, assertInside, fileHash,
  inventory, checkManifest, prepareScenario, parseArgs, prepareReport, scenarioPlan, blockers, inspectionExitCode,
  privateEnvironment,validateAuthority,authorizeWorker,seedDesktop,verifiedCandidateReady,
  classifyPendingResult,observedPageReady,privateUpgradeHome,relativeSourceClosure,controllerOptions,installerProcessSpec,parseInstallerProcesses,parseCLIOutcome,installerStateSample,falseFailedWhileInstalling,processFrame,validateProcessFrame} from './rehearse-1060-isolated.mjs';

const parent = fs.realpathSync('/tmp');
const script = fileURLToPath(new URL('./rehearse-1060-isolated.mjs', import.meta.url));
const roots = [];
function fixture() {
  const root = path.join(parent, 'chathand-1060-rehearsal-unit-' + crypto.randomUUID());
  const config = initialize(root);
  roots.push(root);
  return config;
}
function put(file, contents) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  fs.writeFileSync(file, contents, {flag: 'wx', mode: 0o600});
}
function rejects(fn, code) { assert.throws(fn, e => e.code === code); }

test('dedicated private roots and four disjoint scenarios; no App or runtime created', () => {
  const config = fixture();
  assert.equal(fs.statSync(config.root).mode & 0o777, 0o700);
  assert.deepEqual(Object.keys(config.scenarios), SCENARIOS);
  assert.equal(validateConfig(config), config);
  assert.equal(fs.existsSync(config.inputs.originalApp), false);
  assert.equal(fs.readdirSync(path.join(config.root, 'scenarios')).length, 0);
  assert.equal(fs.existsSync(path.join(config.root, '.rehearsal-root.json')), true);
});

test('refuse Applications, formal data, root reuse and noncanonical arguments', () => {
  const config = fixture();
  for (const value of ['/Applications/ChatHand.app', path.join(os.homedir(), 'Library/Application Support/ChatHand/data'),
    path.join(config.root, 'Applications/ChatHand.app'), config.root + '/../escape', config.root + '\0bad']) {
    const changed = structuredClone(config);
    changed.scenarios.success.target = value;
    assert.throws(() => validateConfig(changed));
  }
  assert.throws(() => initialize(config.root), e => e.code === 'EEXIST');
  assert.throws(() => initialize('/Applications/chathand-1060-rehearsal-fixture'));
  assert.throws(() => parseArgs(['init', '--root', 'relative']));
  assert.throws(() => parseArgs(['preflight', '--config', config.root + '/a/../rehearsal.json']));
});

test('reject sibling-prefix escape, symlinked parent/root, dangling symlink, hardlink', () => {
  const config = fixture(), outside = fixture();
  rejects(() => assertInside(config.root, config.root + '-sibling/file'), 'PATH_OUTSIDE_TEMP_ROOT');
  fs.symlinkSync(outside.root, path.join(config.root, 'escape'));
  rejects(() => assertInside(config.root, path.join(config.root, 'escape/never-read')), 'PATH_ALIAS_OR_SPECIAL_FILE');
  fs.symlinkSync(path.join(outside.root, 'nonexistent'), path.join(config.root, 'dangling'));
  rejects(() => assertInside(config.root, path.join(config.root, 'dangling')), 'PATH_ALIAS_OR_SPECIAL_FILE');
  put(path.join(outside.root, 'plain'), 'fake fixture');
  fs.linkSync(path.join(outside.root, 'plain'), path.join(config.root, 'hardlink'));
  rejects(() => fileHash(config.root, path.join(config.root, 'hardlink')), 'PATH_ALIAS_OR_SPECIAL_FILE');
  const alias = path.join(config.root, 'chathand-1060-rehearsal-alias');
  fs.symlinkSync(outside.root, alias);
  rejects(() => validateConfig({...config, root: alias}), 'DEDICATED_PRIVATE_TEMP_ROOT_REQUIRED');
});

test('refuse shared state/home/profile/backup/evidence across scenarios and input overlap', () => {
  for (const key of ['state', 'home', 'profile', 'backup', 'evidence']) {
    const config = fixture();
    config.scenarios['verification-rollback'][key] = config.scenarios.success[key];
    assert.throws(()=>validateConfig(config),e=>['PATHS_OVERLAP','SCENARIO_BACKUP_MUST_MATCH_PRIVATE_HOME'].includes(e.code));
  }
  const config = fixture();
  config.scenarios.success.state = path.join(config.inputs.originalApp, 'state');
  rejects(() => validateConfig(config), 'PATHS_OVERLAP');
});

test('refuse injected environment/adapter/force flags and updater from candidate', () => {
  const config = fixture();
  rejects(() => validateConfig({...config, env: {HOME: os.homedir()}}), 'CONFIG_SCHEMA');
  config.inputs.originalUpdater = path.join(config.inputs.candidateApp, 'Contents/Resources/runtime/scripts/upgrade.mjs');
  rejects(() => validateConfig(config), 'UPDATER_MUST_BELONG_TO_ORIGINAL_APP');
  for (const args of [[], ['run'], ['run', '--force', '/private/tmp/x'],
    ['run', '--config', '/private/tmp/x', '--force'], ['run', '--config', '/private/tmp/x', '--adapter', '/private/tmp/a'],
    ['preflight', '--config', '/private/tmp/x', '--config', '/private/tmp/y']]) {
    rejects(() => parseArgs(args), 'USAGE');
  }
});

test('avoid original updater LaunchServices registration basename', () => {
  const config = fixture();
  config.scenarios.success.target = path.join(config.root, 'target/ChatHand.app');
  rejects(() => validateConfig(config), 'ALTERNATE_TARGET_APP_NAME_REQUIRED');
});

test('hash inventory binds ordinary bytes and relative internal file-link text', () => {
  const config = fixture(), app = config.inputs.candidateApp;
  put(path.join(app, 'z'), 'fake Z');
  put(path.join(app, 'a/a'), 'fake A');
  const first = inventory(config.root, app);
  assert.deepEqual(first.files.map(e => e.path), ['a/a', 'z']);
  assert.deepEqual(first, inventory(config.root, app));
  fs.writeFileSync(path.join(app, 'z'), 'changed fake Z');
  assert.notEqual(first.sha256, inventory(config.root, app).sha256);
  fs.symlinkSync('z', path.join(app, 'alias'));
  const linked = inventory(config.root, app);
  assert.deepEqual(linked.files.find(e => e.path === 'alias'), {path:'alias',link:'z'});
  fs.unlinkSync(path.join(app, 'alias'));
  fs.symlinkSync('./z', path.join(app, 'alias'));
  assert.notEqual(inventory(config.root, app).sha256, linked.sha256);
  // General state/exec/file reads remain strict even for a valid bundle link.
  rejects(() => fileHash(config.root, path.join(app, 'alias')), 'PATH_ALIAS_OR_SPECIAL_FILE');
});

test('bundle links match real npm and dependency layouts without dereferencing inventory', () => {
  const config=fixture(),app=config.inputs.originalApp;
  put(path.join(app,'runtime/lib/node_modules/npm/bin/npm-cli.js'),'fixture npm');
  put(path.join(app,'runtime/node_modules/playwright-core/cli.js'),'fixture playwright');
  fs.mkdirSync(path.join(app,'runtime/bin'));
  fs.mkdirSync(path.join(app,'runtime/node_modules/.bin'));
  fs.symlinkSync('../lib/node_modules/npm/bin/npm-cli.js',path.join(app,'runtime/bin/npm'));
  fs.symlinkSync('../playwright-core/cli.js',path.join(app,'runtime/node_modules/.bin/playwright-core'));
  assert.deepEqual(inventory(config.root,app).files.filter(e=>e.link),[
    {path:'runtime/bin/npm',link:'../lib/node_modules/npm/bin/npm-cli.js'},
    {path:'runtime/node_modules/.bin/playwright-core',link:'../playwright-core/cli.js'}]);
});

test('bundle links reject absolute, lexical escape, other App/root, broken, cyclic and directory targets', () => {
  for(const kind of ['absolute','absolute-inside','lexical','same-root-other-app','other-root','broken','cycle','directory','intermediate-absolute','intermediate-escape','hardlink']) {
    const config=fixture(),other=fixture(),app=config.inputs.originalApp,link=path.join(app,'alias');
    put(path.join(app,'file'),'safe fixture');put(path.join(config.inputs.candidateApp,'file'),'other fixture');put(path.join(other.root,'file'),'outside fixture');
    let target;
    if(kind==='absolute')target=path.join(other.root,'file');
    if(kind==='absolute-inside')target=path.join(app,'file');
    if(kind==='lexical')target='../ChatHand.app/file'; // still inside after lexical normalization
    if(kind==='same-root-other-app')target=path.relative(app,path.join(config.inputs.candidateApp,'file'));
    if(kind==='other-root')target=path.relative(app,path.join(other.root,'file'));
    if(kind==='broken')target='missing';
    if(kind==='cycle'){target='second';fs.symlinkSync('alias',path.join(app,'second'));}
    if(kind==='directory'){target='folder';fs.mkdirSync(path.join(app,'folder'));}
    if(kind==='intermediate-absolute'){target='second';fs.symlinkSync(path.join(app,'file'),path.join(app,'second'));}
    if(kind==='intermediate-escape'){target='second';fs.symlinkSync(path.relative(app,path.join(config.inputs.candidateApp,'file')),path.join(app,'second'));}
    if(kind==='hardlink'){target='hard';fs.linkSync(path.join(app,'file'),path.join(app,'hard'));}
    if(kind==='lexical') {
      // Escape and reentry via a symlink is forbidden even when realpath ends inside.
      fs.symlinkSync(app,path.join(config.root,'reentry'));
      target=path.relative(app,path.join(config.root,'reentry/file'));
    }
    fs.symlinkSync(target,link);
    assert.throws(()=>inventory(config.root,app),e=>['BUNDLE_LINK_ESCAPE','BUNDLE_LINK_BROKEN','BUNDLE_LINK_CYCLE','BUNDLE_LINK_TARGET_NOT_REGULAR_FILE','PATH_ALIAS_OR_SPECIAL_FILE'].includes(e.code),kind);
  }
});

test('safe relative link chains stay pinned while normal file hashes remain mandatory', () => {
  const config=fixture(),app=config.inputs.candidateApp;
  put(path.join(app,'file'),'fixture');
  fs.symlinkSync('file',path.join(app,'second'));fs.symlinkSync('second',path.join(app,'first'));
  const actual=inventory(config.root,app),manifest=config.inputs.candidateManifest;
  put(manifest,JSON.stringify({version:'fixture',files:actual.files}));
  assert.doesNotThrow(()=>checkManifest(config.root,manifest,actual));
  fs.writeFileSync(path.join(app,'file'),'changed fixture');
  rejects(()=>checkManifest(config.root,manifest,inventory(config.root,app)),'MANIFEST_APP_MISMATCH');
});

test('original array manifest and candidate object retain exact typed entries; malformed and duplicate entries refuse', () => {
  const config=fixture(),app=config.inputs.originalApp;
  put(path.join(app,'file'),'fixture');fs.symlinkSync('file',path.join(app,'alias'));
  const actual=inventory(config.root,app),manifest=config.inputs.originalManifest;
  put(manifest,JSON.stringify(actual.files));
  assert.doesNotThrow(()=>checkManifest(config.root,manifest,actual));
  for(const entries of [
    [...actual.files,actual.files[0]],
    [{path:'../escape',bytes:1,sha256:'a'.repeat(64)}],
    [{path:'file',link:'file',bytes:7,sha256:'a'.repeat(64)}],
    [{path:'file',bytes:7}],
    [{path:'alias',link:'/absolute'}],
    [{path:'alias',link:'file',extra:true}]
  ]) {fs.writeFileSync(manifest,JSON.stringify(entries));rejects(()=>checkManifest(config.root,manifest,actual),'MANIFEST_ENTRY_INVALID');}
  fs.writeFileSync(manifest,JSON.stringify(actual.files.map(e=>e.link?{path:e.path,bytes:7,sha256:'a'.repeat(64)}:e)));
  rejects(()=>checkManifest(config.root,manifest,actual),'MANIFEST_APP_MISMATCH');
});

test('scenario copies preserve signed relative link text and matching inventories', () => {
  const config=fixture();
  for(const app of [config.inputs.originalApp,config.inputs.candidateApp]) {
    put(path.join(app,'file'),'fixture');fs.symlinkSync('file',path.join(app,'alias'));
  }
  put(config.inputs.candidateManifest,JSON.stringify({files:inventory(config.root,config.inputs.candidateApp).files}));
  const old=inventory(config.root,config.inputs.originalApp),candidate=inventory(config.root,config.inputs.candidateApp);
  const scenario=prepareScenario(config,'success');
  assert.equal(fs.readlinkSync(path.join(scenario.target,'alias')),'file');
  assert.equal(inventory(config.root,scenario.target).sha256,old.sha256);
  assert.equal(inventory(config.root,path.join(scenario.packageRoot,'ChatHand.app')).sha256,candidate.sha256);
});

test('fake executable source is hashed but never imported; mismatch is preserved', () => {
  const config = fixture();
  const sentinel = path.join(config.root, 'SHOULD-NOT-EXIST');
  put(config.inputs.originalUpdater, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(sentinel)}, 'unsafe');`);
  put(config.inputs.originalDmg, 'fake DMG');
  put(config.inputs.originalManifest, '{}');
  const report = prepareReport(config, 'run');
  assert.equal(report.status, 'BLOCKED_NOT_EXECUTED');
  assert.equal(report.exitCode, 66);
  assert.equal(fs.existsSync(sentinel), false);
  assert.equal(report.checks.find(c => c.name === 'original source scripts/upgrade.mjs').code, 'ORIGINAL_SOURCE_BYTES_MISMATCH');
  assert.equal(report.checks.find(c => c.name === 'original DMG pinned hash').code, 'ORIGINAL_DMG_HASH_MISMATCH');
  assert.deepEqual(report.runtimeEvidence.startedProcesses, []);
  assert.equal(report.scenarios.every(s => s.status === 'NOT_EXECUTED'), true);
  assert.notEqual(report.identities.actualUpdaterSha256, ORIGINAL.sources['scripts/upgrade.mjs']);
});

test('scenario requirements keep real replacement, full timeout and page injection distinct', () => {
  const plans = scenarioPlan(fixture());
  assert.equal(plans[0].expected.terminal, 'COMMITTED / committed');
  assert.equal(plans[1].expected.terminal, 'ROLLED_BACK / rolled_back');
  assert.match(JSON.stringify(plans[2]), /60000/);
  assert.match(JSON.stringify(plans[1]), /new_app_installed true before fault/);
  assert.match(JSON.stringify(plans[3]), /real native injection/);
  assert.ok(blockers().some(b => b.code === 'FINAL_CANDIDATE_AUTHORITY_REQUIRED'));
  assert.ok(blockers().some(b => b.code === 'FINAL_NATIVE_PAGE_HOOK_REQUIRED'));
  assert.ok(blockers().some(b => b.code === 'ORIGINAL_WINDOW_HOOK_UNAVAILABLE'));
  assert.equal(plans[0].proposedControllerArguments.defaultExec,true);
  assert.equal(plans[0].proposedControllerArguments.defaultSpawn,true);
  assert.equal(Object.hasOwn(plans[0],'proposedFactoryArguments'),false);
  assert.match(JSON.stringify(plans[0]),/naturally|natural candidate/);
});

test('helper environment is an allowlist with separate home/state and opt-in page directory', () => {
  const config=fixture(),s=config.scenarios.success;
  for(const p of [s.home,s.state,s.evidence])fs.mkdirSync(p,{recursive:true,mode:0o700});
  const env=privateEnvironment(config.root,s);
  assert.equal(env.HOME,s.home);assert.equal(env.CFFIXED_USER_HOME,s.home);
  assert.equal(env.CHATHAND_STATE_DIR,s.state);assert.equal(env.KEN_BRIDGE_STATE_DIR,s.state);
  assert.equal(env.TMPDIR,s.home);assert.equal(Object.hasOwn(env,'CHATHAND_REHEARSAL_PAGE_DIR'),false);
  assert.equal(Object.hasOwn(env,'HTTP_PROXY'),false);assert.equal(Object.hasOwn(env,'TOKEN'),false);
  assert.equal(Object.keys(env).length,10);
  fs.mkdirSync(path.join(s.evidence,'page'),{mode:0o700});
  assert.equal(privateEnvironment(config.root,s,{observePage:true}).CHATHAND_REHEARSAL_PAGE_DIR,path.join(s.evidence,'page'));
  rejects(()=>privateEnvironment(config.root,{...s,home:os.homedir()}),'PATH_OUTSIDE_TEMP_ROOT');
});

test('frozen authority binds original/candidate inventories and actual helper/probe bytes', () => {
  const config=fixture(),helper=path.join(config.inputs.candidateApp,'Contents/Resources/runtime/bin/ken-upgrade-control');
  put(helper,'fake helper bytes; never execute');put(config.inputs.boundaryProbe,'fake probe bytes; never execute');
  const report={identities:{original:{sha256:'a'.repeat(64)},candidate:{sha256:'b'.repeat(64)}}};
  const a={format:1,frozen:true,originalInventorySha256:report.identities.original.sha256,candidateInventorySha256:report.identities.candidate.sha256,
    originalUpdaterSha256:ORIGINAL.sources['scripts/upgrade.mjs'],candidateHelperSha256:fileHash(config.root,helper),boundaryProbeSha256:fileHash(config.root,config.inputs.boundaryProbe),scenarios:['success','signed-page']};
  put(path.join(config.root,'execution-authority.json'),JSON.stringify(a));
  assert.deepEqual(validateAuthority(config,report),a);
  fs.writeFileSync(helper,'changed helper bytes; never execute');
  rejects(()=>validateAuthority(config,report),'FROZEN_INPUT_IDENTITY_CHANGED');
  fs.writeFileSync(path.join(config.root,'execution-authority.json'),JSON.stringify({...a,scenarios:['success','success']}));
  rejects(()=>validateAuthority(config,report),'FINAL_CANDIDATE_AUTHORITY_INVALID');
});

test('genuine setting fault waits for replacement journal, actual build and exact native path', () => {
  const target=fixture().scenarios['verification-rollback'].target;
  const value={journal:{new_app_installed:true,phase:'verifying'},state:{version:'1.0.0-test',about:{build:1060}},
    identity:{pids:[1234],executable_paths:[target+'/Contents/MacOS/ChatHand']},target,expectedVersion:'1.0.0-test'};
  assert.equal(verifiedCandidateReady(value),true);
  for(const journal of [{phase:'staged',new_app_installed:false},{phase:'new_installed',new_app_installed:true}])assert.equal(verifiedCandidateReady({...value,journal}),false);
  assert.equal(verifiedCandidateReady({...value,state:{version:'1.0.0-test',manifest:{build_number:1060},about:{build:1059}}}),false);
  assert.equal(verifiedCandidateReady({...value,identity:{pids:[1234],executable_paths:['/Applications/ChatHand.app/Contents/MacOS/ChatHand']}}),false);
  assert.equal(verifiedCandidateReady({...value,identity:{pids:[1234,1235],executable_paths:value.identity.executable_paths}}),false);
});

test('synthetic setup inhibits notifications and uses absent relay only for genuine fault scenarios', () => {
  const config=fixture();
  for(const name of SCENARIOS) {
    const value=seedDesktop(config.scenarios[name],name),fault=name.endsWith('rollback');
    assert.equal(value.notifications,false);assert.equal(value.auto_connect,fault);
    assert.equal(value.connection_preference,fault?'relay':'none');assert.equal(value.browser,'chrome');
    assert.equal(Object.hasOwn(value,'credentials'),false);assert.equal(Object.hasOwn(value,'admin_token'),false);
  }
});

test('retained pending/result is a terminal acknowledgment, while active or mismatched records are unresolved', () => {
  const pending={to:'1.0.1',started_at:1000},result={to:'1.0.1',time:new Date(2000).toISOString(),status:'ROLLED_BACK'},state={upgrade_pending:false,update:{install:{state:'failed',rolled_back:true}}};
  assert.equal(classifyPendingResult({pending,result,state}),'TERMINAL_AWAITING_ACKNOWLEDGMENT');
  assert.equal(classifyPendingResult({pending,result,state:{...state,upgrade_pending:true}}),'ACTIVE');
  assert.equal(classifyPendingResult({pending,result,state:{update:{install:{state:'verifying'}}}}),'ACTIVE');
  assert.equal(classifyPendingResult({pending,result:{...result,time:new Date(500).toISOString()},state}),'UNRESOLVED_PENDING');
  assert.equal(classifyPendingResult({pending,result:{...result,to:'other'},state}),'UNRESOLVED_PENDING');
  assert.equal(classifyPendingResult({pending:null,result,state}),'ABSENT');
});

test('page observations require real native bridge/auth, current live stream and exact backend identity', () => {
  const row={kind:'page_sample',window_visible:true,backend_pid:2345,page:{ready:'complete',native_auth:true,native_bridge:true,stream_status:'live',state_build:1060,state_version:'1.0.1',main_text:'Disposable fixture only',origin:'http://127.0.0.1:54321',time_origin:1000,performance_ms:100}};
  const expected={backendPID:2345,origin:row.page.origin,version:'1.0.1'};
  assert.equal(observedPageReady(row,expected),true);
  for(const patch of [{native_auth:false},{native_bridge:false},{stream_status:'reconnecting'},{state_build:1059},{main_text:''}])assert.equal(observedPageReady({...row,page:{...row.page,...patch}},expected),false);
  assert.equal(observedPageReady(row,{...expected,backendPID:2346}),false);
  assert.equal(observedPageReady({...row,window_visible:false},expected),false);
});

test('worker entry cannot import unverified supplied code even with its internal environment flag', () => {
  const config=fixture(),sentinel=path.join(config.root,'SHOULD-NOT-EXECUTE');
  put(config.inputs.originalUpdater,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(sentinel)},'bad');`);
  rejects(()=>authorizeWorker(config,'success'),'WORKER_INPUT_IDENTITY_REJECTED');
  const args=[script,'--internal-worker',path.join(config.root,'rehearsal.json'),'success'];
  const refused=spawnSync(process.execPath,args,{encoding:'utf8',env:{PATH:process.env.PATH}});
  assert.equal(refused.status,64);assert.equal(JSON.parse(refused.stderr).code,'WORKER_ENTRY_NOT_AUTHORIZED');
  const flagged=spawnSync(process.execPath,args,{encoding:'utf8',env:{PATH:process.env.PATH,CHATHAND_REHEARSAL_WORKER:'1',CHATHAND_REHEARSAL_ROOT:config.root}});
  assert.equal(flagged.status,64);assert.equal(JSON.parse(flagged.stderr).code,'WORKER_INPUT_IDENTITY_REJECTED');
  assert.equal(fs.existsSync(sentinel),false);
});

test('matching fixture metadata can never turn preparation into a successful rehearsal exit', () => {
  assert.equal(inspectionExitCode([{name: 'fake identity', status: 'MATCH'}]), 78);
  assert.equal(inspectionExitCode([{name: 'fake identity', status: 'REJECTED'}]), 66);
});

test('CLI only runs fake path fixtures; distinct report per refusal, no output overwrite', () => {
  const config = fixture(), configFile = path.join(config.root, 'rehearsal.json');
  const first = spawnSync(process.execPath, [script, 'preflight', '--config', configFile], {encoding: 'utf8'});
  const second = spawnSync(process.execPath, [script, 'run', '--config', configFile], {encoding: 'utf8'});
  for (const result of [first, second]) {
    assert.equal(result.status, 66, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, 'BLOCKED_NOT_EXECUTED');
    const report = JSON.parse(fs.readFileSync(summary.report, 'utf8'));
    assert.equal(report.runtimeEvidence.health, 'NOT_EXECUTED');
    assert.equal(report.runtimeEvidence.credentialsRead, false);
  }
  assert.equal(fs.readdirSync(path.join(config.root, 'evidence')).length, 2);
  assert.equal(fs.readdirSync(path.join(config.root, 'scenarios')).length, 0);
  const bad = spawnSync(process.execPath, [script, 'run', '--config', configFile, '--force'], {encoding: 'utf8'});
  assert.equal(bad.status, 64);
  assert.equal(JSON.parse(bad.stderr).code, 'USAGE');
});

test('private-root permissions are enforced and fixture evidence is retained', t => {
  const config = fixture();
  fs.chmodSync(config.root, 0o755);
  rejects(() => validateConfig(config), 'DEDICATED_PRIVATE_TEMP_ROOT_REQUIRED');
  fs.chmodSync(config.root, 0o700);
  assert.ok(roots.every(root => fs.existsSync(path.join(root, 'rehearsal.json'))));
  t.diagnostic('UNIT FIXTURES ONLY; all preserved: ' + JSON.stringify(roots));
});


test('private default backup is the single permitted home nesting, never inside state or a foreign home',()=>{
 const config=fixture(),s=config.scenarios.success;
 assert.equal(s.backup,privateUpgradeHome(s.home));assert.equal(s.backup.startsWith(s.state+path.sep),false);
 assert.equal(validateConfig(config),config);
 for(const backup of [path.join(s.state,'upgrades'),path.join(s.home,'other'),config.scenarios['verification-rollback'].backup]){
  const changed=structuredClone(config);changed.scenarios.success.backup=backup;
  rejects(()=>validateConfig(changed),'SCENARIO_BACKUP_MUST_MATCH_PRIVATE_HOME');
 }
 const changed=structuredClone(config);changed.scenarios.success.profile=path.join(s.home,'profile');rejects(()=>validateConfig(changed),'PATHS_OVERLAP');
});

test('bounded controller closure follows actual relative imports and binds every byte without evaluating them',()=>{
 const c=fixture(),runtime=path.join(c.root,'closure');
 put(path.join(runtime,'app/update.mjs'),"import fs from 'node:fs';import {x} from './dependency.mjs';export const unsafe=()=>fs.writeFileSync('/never','bad');");
 put(path.join(runtime,'app/dependency.mjs'),"export {x} from '../shared.mjs';");put(path.join(runtime,'shared.mjs'),'export const x=1;');
 const before=relativeSourceClosure(c.root,runtime,'app/update.mjs');assert.equal(before.files.length,3);assert.deepEqual(before.files.map(e=>e.path),['app/dependency.mjs','app/update.mjs','shared.mjs']);
 fs.writeFileSync(path.join(runtime,'shared.mjs'),'export const x=2;');assert.notEqual(relativeSourceClosure(c.root,runtime,'app/update.mjs').sha256,before.sha256);
 fs.writeFileSync(path.join(runtime,'app/dependency.mjs'),"import '../../outside.mjs';export const x=1;");
 // Side-effect-only relative imports must also remain within this runtime.
 rejects(()=>relativeSourceClosure(c.root,runtime,'app/update.mjs'),'ORIGINAL_CONTROLLER_CLOSURE_INVALID');
});

test('original controller configuration provides only temporary preparation, no exec/spawn/result/lifecycle substitutes',()=>{
 const c=fixture(),s=c.scenarios.success,metadata={browser:'chrome'},oldState={manifest:{schema_sha256:'a'.repeat(64)}},oldPkg={version:'1.0.0-beta.9',kenBridge:{build_number:1059}},env={HOME:s.home};
 const options=controllerOptions(s,{metadata,oldState,oldPkg,env});
 for(const forbidden of ['exec','spawn','sleep','now','lifecycleKey','finishUpgrade','installerActive'])assert.equal(Object.hasOwn(options,forbidden),false);
 assert.equal(options.upgradeHome,privateUpgradeHome(env.HOME));assert.equal(options.currentAppPath,s.target);assert.equal(options.state.data,metadata);assert.equal(options.env,env);
});

test('natural CLI process evidence requires exact staged executable path and known worker parent, without arguments',()=>{
 const c=fixture(),s=c.scenarios.success,spec=installerProcessSpec(s),parentPID=12345;
 const expected={pid:4321,ppid:parentPID,stage:spec.stage,executable_path:spec.currentNode};
 assert.deepEqual(parseInstallerProcesses(' 4321 '+parentPID+' '+spec.currentNode+'\n',s,1060,parentPID),[expected]);
 assert.equal(parseInstallerProcesses(' 4321 '+parentPID+' '+spec.node,s,1060,parentPID).length,1);
 for(const line of [
  ' 4321 '+(parentPID+1)+' '+spec.currentNode,
  ' 4321 1 '+spec.currentNode,
  ' 4321 '+parentPID+' '+installerProcessSpec(c.scenarios['verification-rollback']).currentNode,
  ' 4321 '+parentPID+' /usr/bin/node',
  ' 4321 '+parentPID+' '+spec.script,
  ' 4321 '+parentPID+' '+spec.currentNode+'-foreign',
  ' 4321 '+parentPID+' '+spec.currentNode+' unexpected-field'
 ])assert.deepEqual(parseInstallerProcesses(line,s,1060,parentPID),[]);
 assert.deepEqual(Object.keys(expected),['pid','ppid','stage','executable_path']);
});

test('actual CLI log parser preserves real terminal outcome and error, never infers pass from an incomplete or console-only log',()=>{
 const outcome={status:'ROLLED_BACK',transaction:'/private/tmp/disposable/transaction',error_code:'SETTING_NOT_RETAINED_BROWSER',time:new Date(0).toISOString()};
 assert.deepEqual(parseCLIOutcome('working\n'+JSON.stringify(outcome,null,2)+'\nrolled back\n'),outcome);
 assert.equal(parseCLIOutcome('working\n'+JSON.stringify({status:'COMMITTED'},null,2)),null);
 assert.equal(parseCLIOutcome('working\n{\n  "status": "COMMITTED"'),null);
 assert.equal(parseCLIOutcome('COMMITTED'),null);rejects(()=>parseCLIOutcome('x'.repeat(2*1024*1024+1)),'CLI_LOG_INVALID');
});

test('finite candidate guard samples expose actual failed/code while locked and do not reclassify rollback or settled state',()=>{
 const value={journal:{phase:'verifying',new_app_installed:true},state:{about:{build:1060},update:{install:{state:'failed',code:'UPGRADE_CURRENT_INVALID'}},upgrade_pending:true},guard:{phase:'verifying'},installLock:true,cliPresent:true,elapsedMs:1234};
 const sample=installerStateSample(value);assert.equal(sample.install_state,'failed');assert.equal(sample.install_code,'UPGRADE_CURRENT_INVALID');assert.equal(sample.guard_active,true);assert.equal(falseFailedWhileInstalling(sample),true);
 for(const patch of [{phase:'rolled_back'},{install_lock:false},{cli_present:false},{build:1059},{install_state:'verifying'}])assert.equal(falseFailedWhileInstalling({...sample,...patch}),false);
 assert.equal(Object.hasOwn(sample,'admin_token'),false);
});


test('external process frame binds fresh worker PID and exact staged executable paths, rejecting stale or forged metadata',()=>{
 const s=fixture().scenarios.success,spec=installerProcessSpec(s),worker=12345,now=10000;
 const frame=processFrame(s,worker,3,' 45678 '+worker+' '+spec.currentNode,now);
 assert.equal(validateProcessFrame(frame,s,worker,now+200,3)[0].pid,45678);
 for(const patch of [{worker_pid:worker+1},{generated_at_ms:now-5001},{generated_at_ms:now+501},{sequence:2},{extra:true},{processes:[{...frame.processes[0],executable_path:'/usr/bin/node'}]},{processes:[{...frame.processes[0],ppid:1}]},{processes:[frame.processes[0],frame.processes[0]]}])rejects(()=>validateProcessFrame({...frame,...patch},s,worker,now,3),'PROCESS_FRAME_INVALID_OR_STALE');
 const empty=processFrame(s,worker,4,' 45678 1 '+spec.currentNode,now);assert.deepEqual(validateProcessFrame(empty,s,worker,now),[]);
});
