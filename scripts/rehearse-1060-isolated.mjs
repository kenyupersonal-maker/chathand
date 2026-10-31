#!/usr/bin/env node
// Genuine temporary-root runtime adapter. Real execution additionally requires a
// frozen-candidate authority receipt; preflight never executes supplied code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';

export const ORIGINAL = Object.freeze({
  commit: 'c35e3379820a9b614172871ef7f80e0611744922', build: 1059,
  dmgSha256: 'dacc925801ffe57b5eddbe5155283e950058990c12d90566549054190a2bb35b',
  manifestSha256: '0749dfe0294f0f39ceff51f656ff5f6231e2a4ba4f688ad46836140caafb02c1',
  controller: Object.freeze({entry:'app/v1/update.mjs', sha256:'1e1d86ce233fd4f1bc6ca687d130759ae1fb7b48acad72fe47a3d7b4697f4b8e', closureCount:88, closureSha256:'25ba6f3dc887f871807b1f6b7d00cb7f2f725812e5e66f4ae2e49d2a15b87531'}),
  // Original CLI's static closure, retained as immutable provenance only;
  // normal updates execute the candidate CLI through the old controller.
  sources: Object.freeze({
    'app/v07/paths.mjs': '2db8e998713c4d72591787c53846b776a5ec8f4d99844ea16080877cc5ef886e',
    'app/v07/upgrade-transaction.mjs': '41b745a6ad380a1a68d29f20bb3e4d2b4a73ef4647690698b037b5ac502fbf16',
    'app/v08/upgrade-guard.mjs': 'b00e3e5e317284a28ebcdaf5cb16eab41a1bcda36b4c4c4878e7404f5b3ddf5f',
    'app/v09/payload-integrity.mjs': 'cff74358f0e0fbf2951f0c13ac6f17262fdb3b8c69bf4a9d65e6715ba3996823',
    'app/v1/blocked.mjs': '5b1a6b478cfde24dec1135e6a36ac4aeeef41b779393a151ca006c48a9013e1b',
    'app/v1/client-features.mjs': 'edbe821174402a27a0e89e44834449a37caa9085f48556e23242541171a40c58',
    'app/v1/high-risk.mjs': 'f05806d649dc599bd744b4b3a539ebe0de60b6a22daee15f8495f177943b386b',
    'engine/src/control-errors.mjs': '64b65409568bdd7a3b7b2b20613669f2f6f94478f7b610a20f32c5c875aac0a3',
    'engine/src/core.mjs': 'f8b58700cff040afc07092ecd81fb56f2451bcc68890c697188fc19556aafe64',
    'scripts/upgrade.mjs': '1061efda9382d200241ffb78a237a948facc9898168f9314af493bb93c7e07c7'
  })
});
export const SCENARIOS = Object.freeze(['success', 'verification-rollback', 'health-timeout-rollback', 'signed-page']);
const pathKeys = ['packageRoot', 'target', 'state', 'home', 'profile', 'backup', 'workspace', 'evidence'];
const inputKeys = ['originalApp', 'originalUpdater', 'originalDmg', 'originalManifest', 'candidateApp', 'candidateManifest', 'boundaryProbe'];
const fail = code => { throw Object.assign(new Error(code), {code}); };
const within = (parent, child) => child.startsWith(parent + path.sep);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const own = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.keys(obj).length === keys.length && keys.every(k => Object.hasOwn(obj, k));

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') ||
      value !== path.normalize(value) || value.split(path.sep).some(s => s === 'Applications')) fail('UNSAFE_PATH');
  return value;
}
function tempParents() {
  // Stable across the worker's deliberately private TMPDIR. Do not allow a
  // caller-supplied TMPDIR to turn an arbitrary directory into a trusted root.
  return [...new Set(['/tmp', '/private/tmp'].filter(p => fs.existsSync(p)).map(p => fs.realpathSync(p)))];
}
export function assertRoot(root) {
  absolute(root);
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(root) !== root ||
      !tempParents().some(p => within(p, root)) ||
      !/^chathand-1060-rehearsal-[a-zA-Z0-9_-]+$/.test(path.basename(root)) ||
      (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) fail('DEDICATED_PRIVATE_TEMP_ROOT_REQUIRED');
  return root;
}
// Config, state and executable paths never traverse aliases. Bundle inventory
// alone has the narrower relative-file-link policy below.
export function assertInside(root, value, {exists = false} = {}) {
  absolute(value);
  if (!within(root, value)) fail('PATH_OUTSIDE_TEMP_ROOT');
  let current = root;
  for (const part of path.relative(root, value).split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (e) { if (e.code === 'ENOENT' && !exists) continue; throw e; }
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) fail('PATH_ALIAS_OR_SPECIAL_FILE');
  }
  return value;
}
function readJSON(root, file) {
  assertInside(root, file, {exists: true});
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > 32 * 1024 * 1024) fail('INVALID_JSON_FILE');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeNew(root, file, value) {
  assertInside(root, file);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
}
export function makeConfig(root) {
  const inputs = path.join(root, 'inputs');
  return {format: 1, root, inputs: {
    originalApp: path.join(inputs, 'original1059/ChatHand.app'),
    originalUpdater: path.join(inputs, 'original1059/ChatHand.app/Contents/Resources/runtime/scripts/upgrade.mjs'),
    originalDmg: path.join(inputs, 'original1059/ChatHand-1059.dmg'),
    originalManifest: path.join(inputs, 'original1059/payload-manifest.json'),
    candidateApp: path.join(inputs, 'signed1060/ChatHand.app'),
    candidateManifest: path.join(inputs, 'signed1060/payload-manifest.json'),
    boundaryProbe: path.join(inputs, 'probe/BoundaryProbe')
  }, scenarios: Object.fromEntries(SCENARIOS.map(name => {
    const base = path.join(root, 'scenarios', name);
    return [name, Object.fromEntries(pathKeys.map(key => [key, path.join(base,
      key === 'target' ? 'target/ChatHand-Rehearsal.app' : key === 'backup' ? 'home/Library/Application Support/ChatHand/upgrades' : key)]))];
  }))};
}
export function validateConfig(config) {
  if (!own(config, ['format', 'root', 'inputs', 'scenarios']) || config.format !== 1 ||
      !own(config.inputs, inputKeys) || !own(config.scenarios, SCENARIOS)) fail('CONFIG_SCHEMA');
  const root = assertRoot(config.root);
  for (const key of inputKeys) assertInside(root, config.inputs[key]);
  if (config.inputs.originalUpdater !== path.join(config.inputs.originalApp, 'Contents/Resources/runtime/scripts/upgrade.mjs')) fail('UPDATER_MUST_BELONG_TO_ORIGINAL_APP');
  const boundaries = inputKeys.filter(k => k !== 'originalUpdater').map(k => config.inputs[k]);
  for (const name of SCENARIOS) {
    const scenario = config.scenarios[name];
    if (!own(scenario, pathKeys)) fail('SCENARIO_SCHEMA');
    for (const key of pathKeys) {
      assertInside(root, scenario[key]);
      boundaries.push(scenario[key]);
    }
    if(scenario.backup!==privateUpgradeHome(scenario.home))fail('SCENARIO_BACKUP_MUST_MATCH_PRIVATE_HOME');
    // Avoid the original updater's lsregister branch, which keys on this basename.
    if (!scenario.target.endsWith('.app') || path.basename(scenario.target) === 'ChatHand.app') fail('ALTERNATE_TARGET_APP_NAME_REQUIRED');
  }
  for (let i = 0; i < boundaries.length; i++) for (let j = i + 1; j < boundaries.length; j++) {
    if(boundaries[i]!==boundaries[j]&&SCENARIOS.some(name=>{const s=config.scenarios[name];return boundaries[i]===s.home&&boundaries[j]===s.backup||boundaries[j]===s.home&&boundaries[i]===s.backup;}))continue;
    if (boundaries[i] === boundaries[j] || within(boundaries[i], boundaries[j]) || within(boundaries[j], boundaries[i])) fail('PATHS_OVERLAP');
  }
  return config;
}
export function initialize(root) {
  absolute(root);
  const parent = fs.realpathSync(path.dirname(root));
  if (!tempParents().some(p => parent === p || within(p, parent))) fail('TEMP_PARENT_REQUIRED');
  // Require canonical spelling. /tmp callers should use /private/tmp on macOS.
  if (path.dirname(root) !== parent || !/^chathand-1060-rehearsal-[a-zA-Z0-9_-]+$/.test(path.basename(root))) fail('DEDICATED_PRIVATE_TEMP_ROOT_REQUIRED');
  fs.mkdirSync(root, {mode: 0o700}); // exclusive: never reuse somebody else's root
  const config = validateConfig(makeConfig(root));
  for (const dir of ['inputs/original1059', 'inputs/signed1060', 'inputs/probe', 'evidence', 'scenarios']) fs.mkdirSync(path.join(root, dir), {recursive: true, mode: 0o700});
  writeNew(root, path.join(root, 'rehearsal.json'), config);
  writeNew(root, path.join(root, '.rehearsal-root.json'), {format: 1, purpose: '1060 isolated rehearsal', createdAt: new Date().toISOString()});
  return config;
}
export function fileHash(root, file) {
  assertInside(root, file, {exists: true});
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) fail('REGULAR_INPUT_REQUIRED');
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) hash.update(buffer.subarray(0, count));
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('INPUT_CHANGED_DURING_READ');
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}
export function inventory(root, directory) {
  assertInside(root, directory, {exists: true});
  if (!fs.statSync(directory).isDirectory()) fail('APP_DIRECTORY_REQUIRED');
  const files = [];
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      const relative = path.relative(directory, file).split(path.sep).join('/');
      if (!stat.isDirectory() && stat.nlink !== 1) fail('PATH_ALIAS_OR_SPECIAL_FILE');
      if (stat.isSymbolicLink()) files.push({path: relative, link: bundleFileLink(root, directory, file)});
      else {
        assertInside(root, file, {exists: true});
        if (stat.isDirectory()) visit(file);
        else files.push({path: relative, bytes: stat.size, sha256: fileHash(root, file)});
      }
    }
  }
  visit(directory);
  return {algorithm: 'sha256(JSON.stringify(sorted file inventory))', sha256: sha(JSON.stringify(files)), files};
}
// Preserve the signed package's link bytes. Every hop must be relative, remain
// lexically inside this exact App, resolve inside it, and end at a single-link
// regular file. Directory links are not needed by either pinned package layout.
function bundleFileLink(root, directory, file) {
  assertInside(root, path.dirname(file), {exists: true});
  const original = fs.readlinkSync(file), seen = new Set();
  function resolve(value) {
    if (!within(directory, value)) fail('BUNDLE_LINK_ESCAPE');
    let current = directory;
    const parts = path.relative(directory, value).split(path.sep);
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let stat;
      try { stat = fs.lstatSync(current); } catch { fail('BUNDLE_LINK_BROKEN'); }
      if (stat.isSymbolicLink()) {
        if (stat.nlink !== 1) fail('PATH_ALIAS_OR_SPECIAL_FILE');
        if (seen.has(current)) fail('BUNDLE_LINK_CYCLE');
        seen.add(current);
        const link = fs.readlinkSync(current);
        if (!link || path.isAbsolute(link) || path.win32.isAbsolute(link) || link.includes('\\') || link.includes('\0')) fail('BUNDLE_LINK_ESCAPE');
        const next = path.resolve(path.dirname(current), link);
        if (!within(directory, next)) fail('BUNDLE_LINK_ESCAPE');
        return resolve(path.resolve(next, ...parts.slice(i + 1)));
      }
      if (i < parts.length - 1 && !stat.isDirectory()) fail('BUNDLE_LINK_BROKEN');
      if (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) fail('PATH_ALIAS_OR_SPECIAL_FILE');
    }
    const stat = fs.lstatSync(current);
    if (!stat.isFile() || stat.nlink !== 1) fail('BUNDLE_LINK_TARGET_NOT_REGULAR_FILE');
    return current;
  }
  const resolved = resolve(file);
  if (!within(directory, fs.realpathSync(file)) || fs.realpathSync(file) !== resolved) fail('BUNDLE_LINK_ESCAPE');
  return original;
}
export function checkManifest(root, file, actual) {
  const manifest = readJSON(root, file);
  const entries = Array.isArray(manifest) ? manifest : manifest?.files;
  if (!Array.isArray(entries) || !entries.length) fail('MANIFEST_INVALID');
  const names = new Set();
  const expected = entries.map(e => {
    if (!e || typeof e.path !== 'string' || !e.path || e.path.includes('\\') || e.path.includes('\0') ||
        path.posix.isAbsolute(e.path) || path.win32.isAbsolute(e.path) || e.path.split('/').some(p => !p || p === '.' || p === '..') || names.has(e.path)) fail('MANIFEST_ENTRY_INVALID');
    names.add(e.path);
    if (own(e, ['path', 'link']) && typeof e.link === 'string' && e.link && !e.link.includes('\\') && !e.link.includes('\0') &&
        !path.isAbsolute(e.link) && !path.win32.isAbsolute(e.link)) return {path: e.path, link: e.link};
    if (!own(e, ['path', 'bytes', 'sha256']) || !Number.isSafeInteger(e.bytes) || e.bytes < 0 || !/^[a-f0-9]{64}$/.test(e.sha256)) fail('MANIFEST_ENTRY_INVALID');
    return {path: e.path, bytes: e.bytes, sha256: e.sha256};
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const ordered = [...actual.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (JSON.stringify(expected) !== JSON.stringify(ordered)) fail('MANIFEST_APP_MISMATCH');
}
export function blockers() {
  return [
    {code:'FINAL_CANDIDATE_AUTHORITY_REQUIRED', layer:'real execution',
      required:'Root freezes the original/candidate inventories, helper and unique boundary-probe bytes in execution-authority.json. The run checks these before any App launch, and runs the unique native probe twice through the final helper before ChatHand.'},
    {code:'ORIGINAL_WINDOW_HOOK_UNAVAILABLE',layer:'original1059 window',
      required:'The immutable original1059 controller requestLocal/install runs with default exec/spawn and temporary paths. Its old window has no rehearsal page hook; do not fabricate old-window observations.'},
    {code:'FINAL_NATIVE_PAGE_HOOK_REQUIRED',layer:'signed-page',
      required:'The final App must include the actual native observer attached to its real WKWebView/bootstrap/backend. Continuous first30s, genuine owned-backend restart and automatic page recovery, then hide/show observations are required. Automatic native reload is allowed and reported.'},
    {code:'NATIVE_CHANNEL_REQUIRES_SEPARATE_ACCEPTANCE',layer:'Chrome browser',
      required:'The adapter does not drive or register a formal browser profile. A genuine isolated browser/native-messaging receipt is separate from installer success.'}
  ];
}
export function scenarioPlan(config) {
  return SCENARIOS.map(name => ({name, status: 'NOT_EXECUTED', paths: config.scenarios[name],
    proposedControllerArguments:name==='signed-page'?null:{stateDir:config.scenarios[name].state,upgradeHome:config.scenarios[name].backup,currentAppPath:config.scenarios[name].target,downloadsDir:path.join(config.scenarios[name].home,'Downloads'),defaultExec:true,defaultSpawn:true},
    expected: name === 'success' ? {
      steps: ['real old App healthy in temporary target', 'unchanged original1059 Updater.requestLocal/install with default exec/spawn and private HOME', 'real signature/identity checks and staging; natural candidate node/scripts/upgrade.mjs --install', 'real stop; backup; migrate; replace', 'real new executable start', 'real verify and commit'],
      terminal: 'COMMITTED / committed', assertions: ['build 1060 / API31', 'retained temporary settings', 'no false FAILED', 'guard inactive and install.lock absent', 'legacy entry compatibility', 'real isolated Chrome native channel', 'window completion and owned service exit']
    } : name === 'signed-page' ? {
      steps: ['verify exact signed candidate ui asset hashes', 'real native injection into full packaged page', 'observe timer and state transitions continuously over first 30 seconds', 'kill exact owned temporary backend; actual App recovers with new PID and automatic page reload', 'hide then show actual window; page resumes'],
      assertions: ['timestamped DOM observations and screenshots', 'no manual refresh or substituted injection', 'runtime identity remains bound to candidate hashes']
    } : {
      steps: ['independent fresh old App / temporary synthetic state', 'same real updater steps through new_app_installed', name === 'verification-rollback' ? 'after new_app_installed and confirmed candidate PID/build, change genuine browser setting through owner API; expect SETTING_NOT_RETAINED_BROWSER' : 'real new process starts; saved relay credential is absent; wait original 60000 ms verify deadline for RELAY_NOT_RESTORED', 'updater stops new process, restores old App and state, resumes old process'],
      terminal: 'ROLLED_BACK / rolled_back', assertions: ['original error_code and CLI-equivalent exit preserved', 'new_app_installed true before fault', 'restored build 1059 and old executable identity healthy', 'no install.lock / active guard / active pending transaction; terminal result can await acknowledgment', 'no late new process takeover', 'watchdog expiry is incomplete, never rollback PASS']
    }
  }));
}
export function privateUpgradeHome(home) {return path.join(home,'Library','Application Support','ChatHand','upgrades');}
// Pin the whole original controller closure before evaluating any of its code.
// This is a bounded scan of immutable package source, never a config/data read.
export function relativeSourceClosure(root,runtime,entry) {
  assertInside(root,runtime,{exists:true});const pending=[entry],seen=new Map();
  while(pending.length){const rel=pending.pop();if(seen.has(rel))continue;
    if(seen.size>=256||!/^[-A-Za-z0-9_./]+\.mjs$/.test(rel)||rel.split('/').some(p=>p==='..'||!p))fail('ORIGINAL_CONTROLLER_CLOSURE_INVALID');
    const file=assertInside(root,path.join(runtime,rel),{exists:true});if(fs.statSync(file).size>1024*1024)fail('ORIGINAL_CONTROLLER_CLOSURE_INVALID');
    const text=fs.readFileSync(file,'utf8');seen.set(rel,fileHash(root,file));
    for(const m of text.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g))if(m[1].startsWith('.')){
      const next=path.posix.normalize(path.posix.join(path.posix.dirname(rel),m[1]));if(next.startsWith('../')||path.posix.isAbsolute(next))fail('ORIGINAL_CONTROLLER_CLOSURE_INVALID');pending.push(next);
    }
  }
  const files=[...seen].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,sha256])=>({path,sha256}));
  return {algorithm:'sha256(JSON.stringify(sorted relative-source hashes))',sha256:sha(JSON.stringify(files)),files};
}
export function inspectOriginalController(config) {
  const runtime=path.join(config.inputs.originalApp,'Contents/Resources/runtime'),closure=relativeSourceClosure(config.root,runtime,ORIGINAL.controller.entry);
  if(closure.files.length!==ORIGINAL.controller.closureCount||closure.sha256!==ORIGINAL.controller.closureSha256||fileHash(config.root,path.join(runtime,ORIGINAL.controller.entry))!==ORIGINAL.controller.sha256)fail('ORIGINAL_CONTROLLER_SOURCE_BYTES_MISMATCH');
  return closure;
}
export function inspectInputs(config) {
  const {root, inputs} = validateConfig(config), checks = [], identities = {};
  function check(name, fn) {
    try { const result = fn(); checks.push({name, status: 'MATCH'}); return result; }
    catch (e) { checks.push({name, status: 'REJECTED', code: e.code || 'INVALID_INPUT'}); return null; }
  }
  check('original DMG pinned hash', () => {
    identities.originalDmgSha256 = fileHash(root, inputs.originalDmg);
    if (identities.originalDmgSha256 !== ORIGINAL.dmgSha256) fail('ORIGINAL_DMG_HASH_MISMATCH');
  });
  check('original manifest pinned hash', () => {
    if (fileHash(root, inputs.originalManifest) !== ORIGINAL.manifestSha256) fail('ORIGINAL_MANIFEST_HASH_MISMATCH');
  });
  for (const [name, app, build, manifest] of [
    ['original', inputs.originalApp, 1059, inputs.originalManifest], ['candidate', inputs.candidateApp, 1060, inputs.candidateManifest]
  ]) {
    const tree = check(`${name} App inventory`, () => inventory(root, app));
    if (tree) identities[name] = tree;
    check(`${name} build`, () => {
      const pkg = readJSON(root, path.join(app, 'Contents/Resources/runtime/package.json'));
      if (pkg.kenBridge?.build_number !== build || pkg.kenBridge?.bundle_id !== 'com.kenyu.chathand') fail('BUILD_OR_BUNDLE_MISMATCH');
      if (build === 1060 && pkg.kenBridge?.connector_api !== 31) fail('CANDIDATE_API31_REQUIRED');
      if (identities[name]) identities[name].build = build;
    });
    if (tree) check(`${name} manifest matches App`, () => checkManifest(root, manifest, tree));
  }
  for (const [relative, expected] of Object.entries(ORIGINAL.sources)) check(`original source ${relative}`, () => {
    if (fileHash(root, path.join(inputs.originalApp, 'Contents/Resources/runtime', relative)) !== expected) fail('ORIGINAL_SOURCE_BYTES_MISMATCH');
  });
  identities.originalControllerClosure=check('original1059 controller full import closure',()=>inspectOriginalController(config));
  identities.actualUpdaterSha256 = check('actual explicit updater SHA', () => fileHash(root, inputs.originalUpdater));
  for (const relative of ['Contents/MacOS/KenBridge', 'Contents/Resources/runtime/bin/ken-upgrade-control']) {
    check(`candidate legacy entry ${relative}`, () => fileHash(root, path.join(inputs.candidateApp, relative)));
  }
  check('candidate complete page assets', () => {
    identities.pageAssets = Object.fromEntries(['index.html', 'app.js', 'style.css'].map(name =>
      [name, fileHash(root, path.join(inputs.candidateApp, 'Contents/Resources/runtime/ui', name))]));
  });
  return {checks, identities};
}
export function prepareReport(config, command) {
  validateConfig(config);
  const inspection = inspectInputs(config);
  return {format: 1, command, status: 'BLOCKED_NOT_EXECUTED', createdAt: new Date().toISOString(),
    scope: 'Preparation only; not installer/page acceptance or release/Mac mini acceptance',
    originalSource: ORIGINAL, inputs: config.inputs, ...inspection,
    blockers: blockers(), scenarios: scenarioPlan(config),
    runtimeEvidence: {startedProcesses: [], screenshots: [], signatureVerification: 'NOT_EXECUTED',
      transaction: 'NOT_EXECUTED', locks: 'NOT_EXECUTED', health: 'NOT_EXECUTED', credentialsRead: false,
      credentialsScope:'Formal saved credentials only; a real run uses newly generated temporary owner credentials solely in memory'},
    exitCode: inspectionExitCode(inspection.checks)};
}
// Even perfect input identity is only preparation, never runtime acceptance.
export function inspectionExitCode(checks) {
  return checks.some(c => c.status === 'REJECTED') ? 66 : 78;
}
export function parseArgs(args) {
  const [command, flag, value, ...extra] = args;
  if (command === '--help' && args.length === 1) return {command: 'help'};
  if (!['init', 'preflight', 'run'].includes(command) || extra.length || !value ||
      flag !== (command === 'init' ? '--root' : '--config')) fail('USAGE');
  absolute(value);
  return {command, value};
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const helperPath = app => path.join(app, 'Contents/Resources/runtime/bin/ken-upgrade-control');
const xml = s => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function mkdirPrivate(root, directory) { assertInside(root,directory); fs.mkdirSync(directory,{recursive:true,mode:0o700}); }
export function privateEnvironment(root, scenario, {observePage=false}={}) {
  assertRoot(root);
  for(const key of ['home','state','evidence']) assertInside(root,scenario[key],{exists:true});
  const env={HOME:scenario.home,CFFIXED_USER_HOME:scenario.home,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8',
    TMPDIR:scenario.home,CHATHAND_STATE_DIR:scenario.state,KEN_BRIDGE_STATE_DIR:scenario.state,
    CHATHAND_REHEARSAL_ROOT:root,CHATHAND_REHEARSAL_HOME:scenario.home,CHATHAND_REHEARSAL_LOG_DIR:scenario.evidence};
  if(observePage)env.CHATHAND_REHEARSAL_PAGE_DIR=assertInside(root,path.join(scenario.evidence,'page'),{exists:true});
  return env;
}
function nativeCommand(program,args,env,timeout=20000) {
  const r=spawnSync(program,args,{env,encoding:'utf8',timeout,maxBuffer:1024*1024});
  const value={exit:r.status,signal:r.signal||null,stdout:r.stdout||'',stderr:r.stderr||''};
  if(r.error) value.error=r.error.code||'CHILD_ERROR';
  return value;
}
function helperCommand(helper,args,env) {
  const r=nativeCommand(helper,args,env);
  if(r.exit!==0) throw Object.assign(Error('NATIVE_HELPER_FAILED'),{code:'NATIVE_HELPER_FAILED',child:r});
  let value;try{value=JSON.parse(r.stdout);}catch{fail('NATIVE_HELPER_OUTPUT_INVALID');}
  return value;
}
// This function only constructs a new unique-ID probe bundle. It never uses a
// ChatHand bundle identifier, reads formal preferences or requests permissions.
export async function exerciseNativeBoundary({root,helper,probeExecutable}) {
  assertRoot(root);assertInside(root,probeExecutable,{exists:true});
  const base=path.join(root,'boundary-'+crypto.randomUUID()),app=path.join(base,'BoundaryProbe.app');
  const scenario={home:path.join(base,'home'),state:path.join(base,'state'),evidence:path.join(base,'evidence')};
  for(const dir of Object.values(scenario))mkdirPrivate(root,dir);
  const identifier='invalid.chathand.rehearsalprobe.'+crypto.randomUUID().replaceAll('-',''),scheme='chathand1060probe'+crypto.randomUUID().replaceAll('-','');
  const env=privateEnvironment(root,scenario),receipt={kind:'unique-native-boundary-probe',identifier,scheme,root,app,runs:[],passed:false};
  const queryScheme=()=>{const r=nativeCommand(probeExecutable,['--scheme-status',scheme],env);if(r.exit!==0)fail('PROBE_SCHEME_QUERY_FAILED');const v=JSON.parse(r.stdout);if(v.scheme!==scheme)fail('PROBE_SCHEME_QUERY_INVALID');return v;};
  receipt.schemeBeforeBundle=queryScheme();
  if(receipt.schemeBeforeBundle.default_handler!==null||receipt.schemeBeforeBundle.all_handlers.length)fail('PROBE_SCHEME_NOT_FRESH');
  mkdirPrivate(root,path.join(app,'Contents/MacOS'));
  fs.copyFileSync(probeExecutable,path.join(app,'Contents/MacOS/BoundaryProbe'),fs.constants.COPYFILE_EXCL);
  fs.chmodSync(path.join(app,'Contents/MacOS/BoundaryProbe'),0o700);
  fs.writeFileSync(path.join(app,'Contents/Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>BoundaryProbe</string><key>CFBundleIdentifier</key><string>${xml(identifier)}</string><key>CFBundleName</key><string>IsolatedBoundaryProbe</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/><key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>${xml(identifier)}</string><key>CFBundleURLSchemes</key><array><string>${scheme}</string></array></dict></array></dict></plist>`,{flag:'wx',mode:0o600});
  const file=path.join(scenario.evidence,'probe-receipt.json');
  try {
    for(let round=1;round<=2;round++) {
      const run={round};receipt.runs.push(run);
      run.launch=helperCommand(helper,['start',app],env);
      try {
        const deadline=performance.now()+15000;
        while(performance.now()<deadline) {
          try {const value=readJSON(root,path.join(scenario.evidence,'boundary-probe.json'));if(value.pid===run.launch.pid)run.observation=value;}catch{}
          if(run.observation?.passed===true)break;
          await wait(100);
        }
        run.info=helperCommand(helper,['info',app],env);
        run.schemeWhileRunning=queryScheme();
      } finally {
        run.stop=helperCommand(helper,['stop-exact',app,String(run.launch.pid)],env);
        run.afterStop=helperCommand(helper,['info',app],env);
        run.schemeAfterStop=queryScheme();
      }
      if(run.observation?.passed!==true || run.info.pids.length!==1 || run.info.pids[0]!==run.launch.pid || run.afterStop.running!==false) fail('NATIVE_BOUNDARY_PROBE_FAILED');
      if(JSON.stringify(run.schemeWhileRunning)!==JSON.stringify(receipt.schemeBeforeBundle)||JSON.stringify(run.schemeAfterStop)!==JSON.stringify(receipt.schemeBeforeBundle))fail('LAUNCHSERVICES_SCHEME_CHANGED');
    }
    receipt.passed=true;
  } catch(e) {receipt.error=e.code||'NATIVE_BOUNDARY_PROBE_FAILED';if(e.child)receipt.child=e.child;}
  writeNew(root,file,receipt);receipt.receipt=file;return receipt;
}
export function validateAuthority(config,report) {
  const a=readJSON(config.root,path.join(config.root,'execution-authority.json'));
  const keys=['format','frozen','originalInventorySha256','candidateInventorySha256','originalUpdaterSha256','candidateHelperSha256','boundaryProbeSha256','scenarios'];
  if(!own(a,keys)||a.format!==1||a.frozen!==true||!Array.isArray(a.scenarios)||!a.scenarios.length||new Set(a.scenarios).size!==a.scenarios.length||a.scenarios.some(n=>!SCENARIOS.includes(n))) fail('FINAL_CANDIDATE_AUTHORITY_INVALID');
  const expected={originalInventorySha256:report.identities.original?.sha256,candidateInventorySha256:report.identities.candidate?.sha256,
    originalUpdaterSha256:ORIGINAL.sources['scripts/upgrade.mjs'],candidateHelperSha256:fileHash(config.root,helperPath(config.inputs.candidateApp)),boundaryProbeSha256:fileHash(config.root,config.inputs.boundaryProbe)};
  for(const [key,value] of Object.entries(expected)) if(a[key]!==value) fail('FROZEN_INPUT_IDENTITY_CHANGED');
  return a;
}
export function seedDesktop(scenario,name) {
  const id=crypto.randomUUID(),fault=['verification-rollback','health-timeout-rollback'].includes(name);
  return {version:1,projects:[{id,name:'Disposable rehearsal workspace',path:scenario.workspace,scope:'folder'}],active:id,
    mode:'auto',conversations:[],notifications:false,browser:'chrome',browser_backend:'extension',browser_mode_version:2,
    onboarding:true,tunnel:null,auto_approve_tasks:true,access_enabled:true,auto_connect:fault,connection_preference:fault?'relay':'none',
    high_risk:{browser:false,computer:false,commands:false,admin:false}};
}
function signatureReceipt(app,env) {
  const verify=nativeCommand('/usr/bin/codesign',['--verify','--deep','--strict',app],env,30000);
  const detail=nativeCommand('/usr/bin/codesign',['-d','-r-','--entitlements',':-',app],env);
  return {verify,detail,passed:verify.exit===0&&detail.exit===0};
}
export function prepareScenario(config,name) {
  const s=config.scenarios[name],root=config.root;
  // Never overlay or reuse a partially executed scenario.
  if(pathKeys.some(key=>fs.existsSync(s[key]))) fail('SCENARIO_ALREADY_PREPARED');
  for(const key of pathKeys.filter(k=>k!=='target'))mkdirPrivate(root,s[key]);
  mkdirPrivate(root,path.dirname(s.target));
  const old=name==='signed-page'?config.inputs.candidateApp:config.inputs.originalApp;
  fs.cpSync(old,s.target,{recursive:true,dereference:false,verbatimSymlinks:true,errorOnExist:true,force:false});
  fs.cpSync(config.inputs.candidateApp,path.join(s.packageRoot,'ChatHand.app'),{recursive:true,dereference:false,verbatimSymlinks:true,errorOnExist:true,force:false});
  fs.copyFileSync(config.inputs.candidateManifest,path.join(s.packageRoot,'payload-manifest.json'),fs.constants.COPYFILE_EXCL);
  writeNew(root,path.join(s.state,'desktop.json'),seedDesktop(s,name));
  if(['signed-page','success'].includes(name))mkdirPrivate(root,path.join(s.evidence,'page'));
  return s;
}
export function verifiedCandidateReady({journal,state,identity,target,expectedVersion}) {
  return journal?.new_app_installed===true && journal.phase==='verifying' && state?.version===expectedVersion && state?.about?.build===1060 &&
    identity?.pids?.length===1 && identity?.executable_paths?.length===1 && identity.executable_paths[0].startsWith(target+'/Contents/MacOS/');
}
// Read only the temporary runtime descriptor. Neither the descriptor nor its
// generated admin token is emitted into receipts, command lines or environment.
async function ownerHTTP(root,stateDir,route,body) {
  if(!['/api/state','/api/settings'].includes(route))fail('REHEARSAL_OWNER_ROUTE_INVALID');
  const r=readJSON(root,path.join(stateDir,'runtime.json'));
  if(!Number.isInteger(r.pid)||r.pid<2||!/^http:\/\/127\.0\.0\.1:\d+$/.test(r.ui_origin)||typeof r.admin_token!=='string')fail('TEMPORARY_RUNTIME_INVALID');
  const response=await fetch(r.ui_origin+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+r.admin_token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(3000)});
  if(!response.ok)fail('TEMPORARY_OWNER_NOT_READY');return response.json();
}
function stateReceipt(state) {
  return {version:state.version,build:state.about?.build,connector_api:state.manifest?.connector_api,
    schema_sha256:state.manifest?.schema_sha256,upgrade_pending:state.upgrade_pending,relay_online:state.relay?.online,
    browser:state.settings?.browser,notifications:state.settings?.notifications,connection_preference:state.settings?.connection_preference,
    auto_connect:state.settings?.auto_connect,lifecycle_exit_requested:state.lifecycle?.exit_requested===true,
    update_install_state:state.update?.install?.state,update_install_code:state.update?.install?.code,update_rolled_back:state.update?.install?.rolled_back,
    update_status:state.update?.status};
}
export function classifyPendingResult({pending,result,state}) {
  const active=['installing','restarting','verifying','waiting_tasks','downloading','waiting_download'];
  if(state?.upgrade_pending===true||active.includes(state?.update?.install?.state))return 'ACTIVE';
  if(!pending)return 'ABSENT';
  if(['COMMITTED','ROLLED_BACK'].includes(result?.status)&&result.to===pending.to&&
    Number.isFinite(pending.started_at)&&Number.isFinite(Date.parse(result.time))&&Date.parse(result.time)>=pending.started_at)return 'TERMINAL_AWAITING_ACKNOWLEDGMENT';
  return 'UNRESOLVED_PENDING';
}
async function healthyOwner(config,s,version,ms=30000) {
  const deadline=performance.now()+ms;
  while(performance.now()<deadline) {
    try{const state=await ownerHTTP(config.root,s.state,'/api/state');if(state.version===version&&state.lifecycle?.exit_requested!==true)return state;}catch{}
    await wait(150);
  }
  fail('REAL_OWNER_NOT_READY');
}
function runtimeIdentity(config,s,helper,env) {
  const app=helperCommand(helper,['info',s.target],env),runtime=readJSON(config.root,path.join(s.state,'runtime.json'));
  const backend=helperCommand(helper,['pid-info',s.target,String(runtime.pid)],env);
  return {...app,backend};
}
function pageRows(root,s) {
  const file=path.join(s.evidence,'page/page-observations.jsonl');
  if(!fs.existsSync(file))return [];
  assertInside(root,file,{exists:true});
  if(fs.statSync(file).size>16*1024*1024)fail('PAGE_OBSERVATIONS_TOO_LARGE');
  // Ignore only the in-progress last line of the observer's append.
  const lines=fs.readFileSync(file,'utf8').split('\n');lines.pop();
  return lines.map(line=>JSON.parse(line));
}
export function observedPageReady(row,{backendPID,origin,version}={}) {
  const p=row?.page;
  return row?.kind==='page_sample'&&row.window_visible===true&&p?.ready==='complete'&&p.native_auth===true&&p.native_bridge===true&&
    p.stream_status==='live'&&p.state_build===1060&&typeof p.main_text==='string'&&p.main_text.trim().length>0&&
    /^http:\/\/127\.0\.0\.1:\d+$/.test(p.origin)&&Number.isFinite(p.time_origin)&&Number.isFinite(p.performance_ms)&&
    (backendPID===undefined||row.backend_pid===backendPID)&&(origin===undefined||p.origin===origin)&&(version===undefined||p.state_version===version);
}
async function waitPage(config,s,predicate,ms=30000) {
  const until=performance.now()+ms;
  while(performance.now()<until) {
    const rows=pageRows(config.root,s),row=rows.findLast(predicate);
    if(row)return row;
    await wait(200);
  }
  fail('ACTUAL_NATIVE_PAGE_NOT_READY');
}
async function pageCommand(config,s,action) {
  const id=crypto.randomUUID(),directory=path.join(s.evidence,'page');
  const file=path.join(directory,'page-command.json'),staged=path.join(directory,'command-'+id+'.json');
  writeNew(config.root,staged,{id,action});assertInside(config.root,file);fs.renameSync(staged,file);
  return waitPage(config,s,r=>r.kind==='page_command'&&r.id===id,10000);
}
async function signedPageScenario(config,s,helper,env,version,report,stamp) {
  report.controller=null;report.pageEvidence=path.join(s.evidence,'page');
  const launchedAt=performance.now();report.initialLaunch=helperCommand(helper,['start',s.target],env);
  stamp('signed_native_started',{pid:report.initialLaunch.pid});
  const initial=await healthyOwner(config,s,version),identity=runtimeIdentity(config,s,helper,env);
  report.before=stateReceipt(initial);report.beforeIdentity=identity;
  const descriptor=readJSON(config.root,path.join(s.state,'runtime.json'));
  const first=await waitPage(config,s,r=>observedPageReady(r,{backendPID:identity.backend.pid,origin:descriptor.ui_origin,version}));
  stamp('actual_page_live',{backend_pid:identity.backend.pid,document_time_origin:first.page.time_origin});
  while(performance.now()-launchedAt<30000)await wait(200);
  const rows=pageRows(config.root,s),samples=rows.filter(r=>r.kind==='page_sample'),last=samples.at(-1);
  const stable=samples.filter(r=>observedPageReady(r,{backendPID:identity.backend.pid,origin:descriptor.ui_origin,version}));
  report.first30Seconds={elapsedMs:Math.round(performance.now()-launchedAt),sampleCount:samples.length,liveSampleCount:stable.length,
    firstLiveMonotonicMs:first.monotonic_ms,lastMonotonicMs:last?.monotonic_ms,
    jsTimeAdvancedMs:last?.page?.time_origin===first.page.time_origin?last.page.performance_ms-first.page.performance_ms:null,
    snapshotCount:rows.filter(r=>r.kind==='snapshot').length};
  if(!observedPageReady(last,{backendPID:identity.backend.pid,origin:descriptor.ui_origin,version})||stable.length<2||
    !(report.first30Seconds.jsTimeAdvancedMs>0)||report.first30Seconds.snapshotCount<1)fail('SIGNED_PAGE_FIRST30_NOT_OBSERVED');
  const immediatelyBefore=runtimeIdentity(config,s,helper,env);
  if(immediatelyBefore.pids.length!==1||immediatelyBefore.pids[0]!==report.initialLaunch.pid||immediatelyBefore.backend.pid!==identity.backend.pid||
    immediatelyBefore.backend.executable!==identity.backend.executable)fail('OWNED_BACKEND_IDENTITY_CHANGED');
  // Exact actual temporary backend only. The observer supplies no restart or
  // bootstrap behavior; the product's ordinary owned-backend recovery must act.
  process.kill(identity.backend.pid,'SIGKILL');stamp('owned_backend_sigkill',{pid:identity.backend.pid,executable:identity.backend.executable});
  const deadline=performance.now()+30000;let recovered,newIdentity,newDescriptor;
  while(performance.now()<deadline) {
    try {
      const next=readJSON(config.root,path.join(s.state,'runtime.json'));
      if(next.pid!==identity.backend.pid) {
        const state=await ownerHTTP(config.root,s.state,'/api/state'),actual=runtimeIdentity(config,s,helper,env);
        if(state.version===version&&state.about?.build===1060&&actual.backend.pid===next.pid&&actual.pids.length===1&&actual.pids[0]===report.initialLaunch.pid) {
          recovered=state;newIdentity=actual;newDescriptor=next;break;
        }
      }
    }catch{}
    await wait(200);
  }
  if(!recovered)fail('REAL_OWNED_BACKEND_NOT_RECOVERED');
  const resumed=await waitPage(config,s,r=>r.monotonic_ms>last.monotonic_ms&&observedPageReady(r,{backendPID:newIdentity.backend.pid,origin:newDescriptor.ui_origin,version}));
  report.restart={beforeBackend:identity.backend,afterIdentity:newIdentity,after:stateReceipt(recovered),
    nativePIDUnchanged:true,manualRefresh:false,documentReloaded:resumed.page.time_origin!==first.page.time_origin,
    beforeTimeOrigin:first.page.time_origin,afterTimeOrigin:resumed.page.time_origin};
  stamp('actual_page_recovered',{backend_pid:newIdentity.backend.pid,document_reloaded:report.restart.documentReloaded});
  report.hide=await pageCommand(config,s,'hide');
  report.hidden=await waitPage(config,s,r=>r.kind==='page_sample'&&r.monotonic_ms>=report.hide.monotonic_ms&&r.window_visible===false&&r.page?.stream_status==='paused',10000);
  await wait(1500);
  report.show=await pageCommand(config,s,'show');
  report.shown=await waitPage(config,s,r=>r.monotonic_ms>=report.show.monotonic_ms&&observedPageReady(r,{backendPID:newIdentity.backend.pid,origin:newDescriptor.ui_origin,version}),15000);
  report.snapshotRequest=await pageCommand(config,s,'snapshot');
  await wait(500);report.afterIdentity=runtimeIdentity(config,s,helper,env);
  if(report.afterIdentity.pids.length!==1||report.afterIdentity.pids[0]!==report.initialLaunch.pid||report.afterIdentity.backend.pid!==newIdentity.backend.pid)fail('PAGE_REOPEN_PROCESS_CHANGED');
  report.status='PASSED_SIGNED_PAGE_SCENARIO';
}
export function controllerOptions(s,{metadata,oldState,oldPkg,env}) {
  // Paths and starting metadata are explicit test preparation. Execution,
  // signature checks, staging, spawn and lifecycle methods are never replaced.
  return {stateDir:s.state,upgradeHome:s.backup,currentAppPath:s.target,
    downloadsDir:path.join(s.home,'Downloads'),state:{data:metadata},
    version:oldPkg.version,build:oldPkg.kenBridge.build_number,
    schemaSha:oldState.manifest.schema_sha256,env};
}
export function installerProcessSpec(s,build=1060) {
  const stage=path.join(s.backup,'staging','local-'+build),runtime=path.join(stage,'ChatHand.app/Contents/Resources/runtime');
  return {stage,app:path.join(stage,'ChatHand.app'),node:path.join(runtime,'bin/node'),
    currentNode:path.join(runtime,'bin/ChatHandNode'),script:path.join(runtime,'scripts/upgrade.mjs'),
    args:['--install',stage,'--destination',s.target,'--result',path.join(s.state,'update-result.json')]};
}
export function parseInstallerProcesses(output,s,build=1060,parentPID=process.pid) {
  const spec=installerProcessSpec(s,build);
  return String(output).split('\n').flatMap(line=>{
    const match=/^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);if(!match)return [];
    const pid=Number(match[1]),ppid=Number(match[2]),executable=match[3];
    return pid>1&&ppid===parentPID&&[spec.node,spec.currentNode].includes(executable)?[{pid,ppid,stage:spec.stage,executable_path:executable}]:[];
  });
}
export function processFrame(s,workerPID,sequence,output,now=Date.now()) {
  return {format:1,worker_pid:workerPID,sequence,generated_at_ms:now,processes:parseInstallerProcesses(output,s,1060,workerPID)};
}
export function validateProcessFrame(frame,s,workerPID,now=Date.now(),minimumSequence=0) {
  if(!own(frame,['format','worker_pid','sequence','generated_at_ms','processes'])||frame.format!==1||frame.worker_pid!==workerPID||!Number.isSafeInteger(frame.sequence)||frame.sequence<minimumSequence||!Number.isSafeInteger(frame.generated_at_ms)||frame.generated_at_ms>now+500||now-frame.generated_at_ms>5000||!Array.isArray(frame.processes)||frame.processes.length>16)fail('PROCESS_FRAME_INVALID_OR_STALE');
  const spec=installerProcessSpec(s),seen=new Set();
  for(const row of frame.processes){if(!own(row,['pid','ppid','stage','executable_path'])||!Number.isSafeInteger(row.pid)||row.pid<2||seen.has(row.pid)||row.ppid!==workerPID||row.stage!==spec.stage||![spec.node,spec.currentNode].includes(row.executable_path))fail('PROCESS_FRAME_INVALID_OR_STALE');seen.add(row.pid);}
  return frame.processes;
}
const processFrameSequences=new Map();
function installerProcesses(s,env,build=1060) {
  if(build!==1060)fail('PROCESS_FRAME_BUILD_INVALID');
  const root=assertRoot(env.CHATHAND_REHEARSAL_ROOT),file=assertInside(root,path.join(s.evidence,'process-frame.json'),{exists:true}),stat=fs.statSync(file);
  if(stat.size>16384||(stat.mode&0o077)!==0||process.getuid&&stat.uid!==process.getuid())fail('PROCESS_FRAME_INVALID_OR_STALE');
  const frame=readJSON(root,file),rows=validateProcessFrame(frame,s,process.pid,Date.now(),processFrameSequences.get(file)||0);processFrameSequences.set(file,frame.sequence);return rows;
}
function startProcessSupervisor(config,s,workerPID,env) {
  assertRoot(config.root);if(!Number.isSafeInteger(workerPID)||workerPID<2)fail('PROCESS_SUPERVISOR_WORKER_INVALID');
  let sequence=0,written=0,errorCount=0,lastError=null;const history=new Map();
  const tick=()=>{try{
    // This function runs only in the unsandboxed outer supervisor. No args.
    const result=nativeCommand('/bin/ps',['-axo','pid=,ppid=,comm='],env,3000);if(result.exit!==0)fail('PROCESS_SUPERVISOR_PS_FAILED');
    const frame=processFrame(s,workerPID,++sequence,result.stdout);for(const row of frame.processes){if(history.size>=16&&!history.has(row.pid))fail('PROCESS_SUPERVISOR_LIMIT');history.set(row.pid,row);}
    const staged=path.join(s.evidence,'process-frame-'+crypto.randomUUID()+'.json'),destination=path.join(s.evidence,'process-frame.json');writeNew(config.root,staged,frame);assertInside(config.root,destination);fs.renameSync(staged,destination);written++;
  }catch(e){errorCount++;lastError=e.code||'PROCESS_SUPERVISOR_FAILED';}};
  tick();const timer=setInterval(tick,250);
  return {stop(){clearInterval(timer);return {kind:'outer PID/PPID/executable-path supervisor',worker_pid:workerPID,frames_written:written,last_sequence:sequence,error_count:errorCount,last_error:lastError,observed_processes:[...history.values()]};}};
}
async function stopSupervisedInstallers(config,s,helper,env,observation) {
  const spec=installerProcessSpec(s),receipt={purpose:'emergency cleanup of previously observed direct temporary worker children; never transaction acceptance',stops:[],passed:true};
  for(const row of observation.observed_processes){try{
    try{process.kill(row.pid,0);}catch(e){if(e.code==='ESRCH'){receipt.stops.push({pid:row.pid,already_gone:true});continue;}throw e;}
    const identity=helperCommand(helper,['pid-info',spec.app,String(row.pid)],env);
    if(row.ppid!==observation.worker_pid||row.stage!==spec.stage||![spec.node,spec.currentNode].includes(identity.executable))fail('INSTALLER_PID_IDENTITY_CHANGED');
    process.kill(row.pid,'SIGTERM');const until=performance.now()+5000;let gone=false;
    while(performance.now()<until){try{process.kill(row.pid,0);}catch(e){if(e.code==='ESRCH'){gone=true;break;}throw e;}await wait(100);}
    receipt.stops.push({pid:row.pid,executable:identity.executable,terminated:gone});if(!gone)receipt.passed=false;
  }catch(e){receipt.stops.push({pid:row.pid,error:e.code||'EXACT_INSTALLER_CLEANUP_FAILED'});receipt.passed=false;}}
  return receipt;
}
export function parseCLIOutcome(text) {
  if(typeof text!=='string'||Buffer.byteLength(text)>2*1024*1024)fail('CLI_LOG_INVALID');
  const lines=text.split('\n');
  for(let i=lines.length-1;i>=0;i--)if(lines[i].trim()==='{'){
    for(let j=lines.length-1;j>i;j--)if(lines[j].trim()==='}')try{
      const value=JSON.parse(lines.slice(i,j+1).join('\n'));
      if(['COMMITTED','ROLLED_BACK','ROLLBACK_FAILED','FAILED'].includes(value.status)&&typeof value.transaction==='string')return value;
    }catch{}
  }
  return null;
}
function readCLIOutcome(root,s) {
  const file=assertInside(root,path.join(s.backup,'last-update.log'),{exists:true});
  if(fs.statSync(file).size>2*1024*1024)fail('CLI_LOG_INVALID');return parseCLIOutcome(fs.readFileSync(file,'utf8'));
}
export function installerStateSample({journal,state,guard,installLock,cliPresent,elapsedMs}) {
  return {monotonic_ms:elapsedMs,phase:journal.phase,new_app_installed:journal.new_app_installed===true,
    build:state.about?.build,install_state:state.update?.install?.state,install_code:state.update?.install?.code||null,
    upgrade_pending:state.upgrade_pending===true,guard_phase:guard?.phase||'none',
    guard_active:guard?.phase==='verifying',install_lock:installLock,cli_present:cliPresent};
}
export function falseFailedWhileInstalling(sample) {
  return sample.build===1060&&sample.phase==='verifying'&&sample.install_lock===true&&sample.cli_present===true&&sample.install_state==='failed';
}
async function stopOwnedInstaller(config,s,helper,env) {
  const spec=installerProcessSpec(s),observed=installerProcesses(s,env),receipt={purpose:'emergency exact temporary CLI cleanup; never rollback evidence',stopped:[]};
  for(const row of observed){
    const identity=helperCommand(helper,['pid-info',spec.app,String(row.pid)],env);
    if(identity.executable!==spec.currentNode&&identity.executable!==spec.node)fail('INSTALLER_PID_IDENTITY_CHANGED');
    if(!installerProcesses(s,env).some(p=>p.pid===row.pid))continue;
    process.kill(row.pid,'SIGTERM');receipt.stopped.push({pid:row.pid,executable:identity.executable});
  }
  const until=performance.now()+5000;while(performance.now()<until&&installerProcesses(s,env).length)await wait(100);
  receipt.absent=installerProcesses(s,env).length===0;return receipt;
}
async function worker(config,name) {
  const root=config.root,s=config.scenarios[name],helper=helperPath(path.join(s.packageRoot,'ChatHand.app')),env=privateEnvironment(root,s,{observePage:['signed-page','success'].includes(name)});
  const report={name,status:'RUNNING',startedAt:new Date().toISOString(),timeline:[],controller:'unchanged original1059 Updater.requestLocal/install; default exec/spawn; naturally staged candidate CLI',factory:null,fullProductAcceptance:false,processObservation:'fresh external PID/PPID/path frame plus helper physical-executable checks; no ps in sandbox worker',installerStateSamples:[]};
  const start=performance.now(),stamp=(phase,extra={})=>report.timeline.push({phase,monotonic_ms:Math.round(performance.now()-start),...extra});
  let controller,monitorDone=false,monitorFailure=null,monitor,cliComplete=false;
  try {
    for(const [relative,expected] of Object.entries(ORIGINAL.sources))if(fileHash(root,path.join(config.inputs.originalApp,'Contents/Resources/runtime',relative))!==expected)fail('ORIGINAL_SOURCE_BYTES_MISMATCH');
    report.originalControllerClosure=inspectOriginalController(config);
    const oldPkg=readJSON(root,path.join(config.inputs.originalApp,'Contents/Resources/runtime/package.json'));
    const newPkg=readJSON(root,path.join(config.inputs.candidateApp,'Contents/Resources/runtime/package.json'));
    // The old CLI is imported only for its frozen settings comparison exports.
    // Its createUpgradeRunner is never called. The real controller chooses CLI bytes.
    const settingsContract=await import(pathToFileURL(config.inputs.originalUpdater).href);
    if(name==='signed-page') {await signedPageScenario(config,s,helper,env,newPkg.version,report,stamp);return report;}
    report.initialLaunch=helperCommand(helper,['start',s.target],env);stamp('old_native_started',{pid:report.initialLaunch.pid});
    const old=await healthyOwner(config,s,oldPkg.version);
    if(old.settings?.notifications!==false||old.settings?.browser!=='chrome')fail('SYNTHETIC_STATE_NOT_RETAINED');
    report.before=stateReceipt(old);report.beforeIdentity=runtimeIdentity(config,s,helper,env);stamp('old_owner_healthy');
    const metadata=readJSON(root,path.join(s.state,'desktop.json'));
    report.retainedSettingsSha256=sha(JSON.stringify(metadata));
    const original=await import(pathToFileURL(path.join(config.inputs.originalApp,'Contents/Resources/runtime',ORIGINAL.controller.entry)).href);
    controller=new original.Updater(controllerOptions(s,{metadata,oldState:old,oldPkg,env}));
    report.preparation={home:s.home,state:s.state,upgradeHome:s.backup,defaultUpgradeHomeMatched:s.backup===privateUpgradeHome(s.home),controllerLifecycleKeySupplied:false,lifecycle:'product default; owner API then exact-helper fallback if its normal authorization requires it',defaultExec:true,defaultSpawn:true};
    await controller.requestLocal({app_path:path.join(s.packageRoot,'ChatHand.app')});stamp('old_controller_request_local_accepted');
    const spec=installerProcessSpec(s,newPkg.kenBridge.build_number);let observedCLI=null;
    monitor=(async()=>{
      let prior='',lastSample=-Infinity;
      while(!monitorDone) {
        try {
          const processes=installerProcesses(s,env,newPkg.kenBridge.build_number);if(processes.length>1)fail('MULTIPLE_EXACT_INSTALLERS');
          if(processes[0]){
            observedCLI=processes[0];if(!report.candidateCLI){
              const identity=helperCommand(helper,['pid-info',spec.app,String(observedCLI.pid)],env);
              if(![spec.node,spec.currentNode].includes(identity.executable))fail('INSTALLER_PID_IDENTITY_CHANGED');
              if(inventory(root,spec.app).sha256!==inventory(root,config.inputs.candidateApp).sha256)fail('NATURAL_STAGED_CANDIDATE_CHANGED');
              report.candidateCLI={...observedCLI,executable:identity.executable,stagedCandidateInventoryMatched:true,actualExitObserved:false,scriptSelectionEvidence:'pinned original1059 controller default spawn and staged candidate source; process arguments not inspected'};stamp('natural_candidate_cli_observed',{pid:observedCLI.pid});
            }
          }
          const j=readJSON(root,path.join(s.backup,'current.json'));
          if(j.phase!==prior){prior=j.phase;stamp('transaction_'+j.phase,{new_app_installed:j.new_app_installed===true});}
          if(j.new_app_installed===true&&j.phase==='verifying') {
            report.replacementObserved=true;
            const state=await ownerHTTP(root,s.state,'/api/state');
            let guard=null;try{guard=readJSON(root,path.join(s.state,'upgrade-guard.json'));}catch{}
            const sample=installerStateSample({journal:j,state,guard,installLock:fs.existsSync(path.join(s.backup,'install.lock')),cliPresent:processes.length===1,elapsedMs:Math.round(performance.now()-start)});
            if(falseFailedWhileInstalling(sample))report.falseFailedWhileInstallerActive=true;
            if(sample.monotonic_ms-lastSample>=1000||report.installerStateSamples.at(-1)?.install_state!==sample.install_state){if(report.installerStateSamples.length<200)report.installerStateSamples.push(sample);else report.omittedInstallerStateSamples=(report.omittedInstallerStateSamples||0)+1;lastSample=sample.monotonic_ms;}
            if(!report.newIdentity||name==='verification-rollback'&&!report.faultApplied){
              const identity=runtimeIdentity(config,s,helper,env);
              if(verifiedCandidateReady({journal:j,state,identity,target:s.target,expectedVersion:newPkg.version})) {
                if(!report.newIdentity){report.newIdentity=identity;report.newState=stateReceipt(state);stamp('candidate_owner_confirmed',{pid:identity.pids[0],build:1060});}
                if(name==='verification-rollback'&&!report.faultApplied) {
                  await ownerHTTP(root,s.state,'/api/settings',{browser:'safari'});
                  const changed=await ownerHTTP(root,s.state,'/api/state');if(changed.settings?.browser!=='safari')fail('REAL_SETTING_FAULT_NOT_APPLIED');
                  report.faultApplied=true;stamp('real_browser_setting_changed');
                }
              }
            }
          }
        }catch(e){if(['REAL_SETTING_FAULT_NOT_APPLIED','MULTIPLE_EXACT_INSTALLERS','INSTALLER_PID_IDENTITY_CHANGED','NATURAL_STAGED_CANDIDATE_CHANGED','INSTALLER_PROCESS_OBSERVATION_FAILED'].includes(e.code)){monitorFailure=e;return;}}
        await wait(100);
      }
    })();
    stamp('old_controller_install_started');controller.install('local:'+newPkg.kenBridge.build_number);
    const installation=controller.run;if(!installation?.promise)fail('ORIGINAL_CONTROLLER_INSTALL_NOT_STARTED');await installation.promise;
    report.controllerAfterSpawn={install_state:controller.value.install.state,install_message:controller.value.install.message||null,request_status:controller.request?.status||null,request_message:controller.request?.message||null};
    if(controller.value.install.state!=='restarting')fail('ORIGINAL_CONTROLLER_DID_NOT_SPAWN_CANDIDATE');
    const deadline=start+185000;let outcome=null;
    while(performance.now()<deadline){
      try{outcome=readCLIOutcome(root,s);}catch(e){if(e.code==='CLI_LOG_INVALID')throw e;}
      const cliPresent=installerProcesses(s,env,newPkg.kenBridge.build_number).length!==0;
      if(outcome&&!cliPresent){cliComplete=true;break;}
      if(observedCLI&&!cliPresent){
        let failedResult;try{failedResult=readJSON(root,path.join(s.state,'update-result.json'));}catch{}
        if(['FAILED','ROLLBACK_FAILED'].includes(failedResult?.status)){
          cliComplete=true;report.result=failedResult;try{report.journal=readJSON(root,path.join(s.backup,'current.json'));}catch{}
          report.cliFailure={status:failedResult.status,transaction_error_code:report.journal?.error_code||null,rollback_error:report.journal?.rollback_error||null,log:path.join(s.backup,'last-update.log')};
          fail('NATURAL_CANDIDATE_CLI_FAILED');
        }
      }
      await wait(150);
    }
    if(!cliComplete)fail('NATURAL_CANDIDATE_CLI_INCOMPLETE');
    if(!observedCLI||!report.candidateCLI)fail('NATURAL_CANDIDATE_CLI_NOT_OBSERVED');
    report.outcome=outcome;stamp('candidate_cli_finished');report.candidateCLI.completedAndAbsent=true;
    // Default detached spawn intentionally exposes no child handle to the caller.
    // This is the CLI's documented exit convention, never a fabricated observed exit.
    report.candidateCLIEquivalentExit=outcome.status==='ROLLED_BACK'?2:outcome.status==='COMMITTED'?0:1;
    monitorDone=true;await monitor;if(monitorFailure)throw monitorFailure;
    report.journal=readJSON(root,path.join(s.backup,'current.json'));report.result=readJSON(root,path.join(s.state,'update-result.json'));
    if(outcome.transaction!==path.join(s.backup,report.journal.id)||outcome.status!==report.result.status)fail('NATURAL_CLI_RESULT_JOURNAL_MISMATCH');
    const expectedVersion=name==='success'?newPkg.version:oldPkg.version;
    let state=await healthyOwner(config,s,expectedVersion);
    const pending=fs.existsSync(path.join(s.state,'update-pending.json'))?readJSON(root,path.join(s.state,'update-pending.json')):null;
    const uiDeadline=performance.now()+10000;
    while(performance.now()<uiDeadline) {
      const ui=state.update?.install;if(name==='success'?ui?.state==='idle':ui?.state==='failed'&&ui?.rolled_back===true)break;
      await wait(200);state=await ownerHTTP(root,s.state,'/api/state');
    }
    report.after=stateReceipt(state);report.afterIdentity=runtimeIdentity(config,s,helper,env);
    report.pendingClassification=classifyPendingResult({pending,result:report.result,state});
    report.retainedSettings=Object.fromEntries(settingsContract.UPGRADE_SETTINGS.map(field=>[field,settingsContract.retainedUpgradeSetting(metadata,state.settings,field)]));
    const backupMetadata=readJSON(root,path.join(report.journal.stateBackup,'desktop.json'));
    report.stateBackup={directory:report.journal.stateBackup,desktopSha256:sha(JSON.stringify(backupMetadata)),retainedSettings:Object.fromEntries(settingsContract.UPGRADE_SETTINGS.map(field=>[field,settingsContract.retainedUpgradeSetting(backupMetadata,state.settings,field)]))};
    report.installLockAbsent=!fs.existsSync(path.join(s.backup,'install.lock'));report.targetInventory=inventory(root,s.target).sha256;
    const expectedInventory=inventory(root,name==='success'?config.inputs.candidateApp:config.inputs.originalApp).sha256;
    const terminal=name==='success'?'COMMITTED':'ROLLED_BACK',phase=name==='success'?'committed':'rolled_back';
    const expectedError=name==='verification-rollback'?'SETTING_NOT_RETAINED_BROWSER':name==='health-timeout-rollback'?'RELAY_NOT_RESTORED':null;
    if(outcome.status!==terminal||report.journal.phase!==phase||!report.installLockAbsent||report.targetInventory!==expectedInventory||state.upgrade_pending===true)fail('REAL_TERMINAL_ASSERTION_FAILED');
    if(state.about?.build!==(name==='success'?1060:1059)||report.afterIdentity.pids.length!==1||(name==='success'&&state.manifest?.connector_api!==31))fail('REAL_TERMINAL_IDENTITY_MISMATCH');
    if(name!=='success'){
      report.restoredLegacyProcessNames=report.afterIdentity.executable_paths?.[0]===s.target+'/Contents/MacOS/KenBridge'&&report.afterIdentity.backend.executable===s.target+'/Contents/Resources/runtime/bin/node';
      if(!report.restoredLegacyProcessNames)fail('ORIGINAL_PROCESS_NAMES_NOT_RESTORED');
    }
    if(!['ABSENT','TERMINAL_AWAITING_ACKNOWLEDGMENT'].includes(report.pendingClassification)||(name==='success'?state.update?.install?.state!=='idle':state.update?.install?.state!=='failed'||state.update?.install?.rolled_back!==true))fail('REAL_UPDATE_UI_TERMINAL_NOT_SETTLED');
    if(!Object.values(report.retainedSettings).every(Boolean)||!Object.values(report.stateBackup.retainedSettings).every(Boolean))fail('RESTORED_TEMPORARY_SETTINGS_MISMATCH');
    if(expectedError&&(outcome.error_code!==expectedError||!report.replacementObserved||!report.newIdentity))fail('REAL_FAILURE_NOT_OBSERVED');
    if(report.falseFailedWhileInstallerActive)fail('CANDIDATE_FALSE_FAILED_WHILE_INSTALLING');
    if(!report.installerStateSamples.some(row=>row.build===1060&&row.install_lock&&row.cli_present))fail('REAL_INSTALLER_GUARD_STATE_NOT_OBSERVED');
    if(name==='verification-rollback'&&!report.faultApplied)fail('REAL_SETTING_FAULT_NOT_APPLIED');
    if(name==='health-timeout-rollback'){
      const verify=report.timeline.find(e=>e.phase==='transaction_verifying'),end=report.timeline.find(e=>e.phase==='candidate_cli_finished');report.observedVerifyToTerminalMs=verify&&end?end.monotonic_ms-verify.monotonic_ms:null;
      if(report.observedVerifyToTerminalMs===null||report.observedVerifyToTerminalMs<59500)fail('ORIGINAL_HEALTH_TIMEOUT_NOT_OBSERVED');
    }
    if(name==='success'){
      report.pageEvidence=path.join(s.evidence,'page');
      try{const row=await waitPage(config,s,row=>observedPageReady(row,{backendPID:report.afterIdentity.backend.pid,version:newPkg.version}),10000);report.postInstallPage={observed:true,sample:row,owner_install_state:state.update?.install?.state,meaning:'real live page paired with same backend owner idle; no old-window hook or injected DOM replacement'};await pageCommand(config,s,'snapshot');}
      catch(e){report.postInstallPage={observed:false,code:e.code||e.message};}
    }
    for(let i=0;i<5;i++){await wait(1000);const live=await ownerHTTP(root,s.state,'/api/state');if(live.version!==expectedVersion)fail('DELAYED_CANDIDATE_TAKEOVER');}
    report.status='PASSED_INSTALLER_SCENARIO';
  }catch(e){report.status='FAILED';report.error=e.code||e.message||'REHEARSAL_FAILED';if(e.child)report.child=e.child;}
  finally {
    monitorDone=true;if(monitor)await monitor;controller?.close();
    if(report.initialLaunch){
      try{if(name!=='signed-page'&&!cliComplete){report.installerEmergencyCleanup=await stopOwnedInstaller(config,s,helper,env);if(!report.installerEmergencyCleanup.absent)fail('OWNED_INSTALLER_STILL_RUNNING');}
        const cleanup=await emergencyCleanup(config,name);report.ownedAppAfterStop=cleanup.after;report.finalCleanup=cleanup;if(!cleanup.passed)fail('OWNED_APP_STILL_RUNNING');}
      catch(e){report.cleanupError=e.code||e.message;report.status='FAILED';}
    }
    report.elapsedMs=Math.round(performance.now()-start);writeNew(root,path.join(s.evidence,'worker-result.json'),report);
  }
  return report;
}
// Internal worker is not a bypass around the frozen-input gate. This runs before
// any supplied module is imported or any candidate helper is executed.
export function authorizeWorker(config,name) {
  validateConfig(config);
  const inspection=inspectInputs(config);
  if(inspection.checks.some(c=>c.status!=='MATCH'))fail('WORKER_INPUT_IDENTITY_REJECTED');
  const authority=validateAuthority(config,inspection);
  if(!authority.scenarios.includes(name))fail('WORKER_SCENARIO_NOT_AUTHORIZED');
  const s=config.scenarios[name];
  if(inventory(config.root,path.join(s.packageRoot,'ChatHand.app')).sha256!==authority.candidateInventorySha256||
    inventory(config.root,s.target).sha256!==(name==='signed-page'?authority.candidateInventorySha256:authority.originalInventorySha256))fail('WORKER_SCENARIO_COPY_CHANGED');
  return authority;
}
async function emergencyCleanup(config,name) {
  const s=config.scenarios[name],helper=helperPath(config.inputs.candidateApp),env=privateEnvironment(config.root,s),receipt={purpose:'exact temporary-process cleanup only; never rollback evidence',passed:false};
  try {
    if(!fs.existsSync(s.target)){receipt.targetMissing=true;return receipt;}
    let backend;try{const r=readJSON(config.root,path.join(s.state,'runtime.json'));backend=helperCommand(helper,['pid-info',s.target,String(r.pid)],env);}catch{}
    receipt.before=helperCommand(helper,['info',s.target],env);receipt.stops=[];
    for(const pid of receipt.before.pids)receipt.stops.push({pid,result:helperCommand(helper,['stop-exact',s.target,String(pid)],env)});
    receipt.after=helperCommand(helper,['info',s.target],env);
    if(backend) {
      const deadline=performance.now()+12000;let running=true;
      while(performance.now()<deadline) {
        try {const actual=helperCommand(helper,['pid-info',s.target,String(backend.pid)],env);running=actual.executable===backend.executable;}catch{running=false;}
        if(!running)break;await wait(200);
      }
      receipt.backend={pid:backend.pid,executable:backend.executable,stillRunning:running};
    }
    receipt.passed=receipt.after.running===false&&receipt.backend?.stillRunning!==true;
  }catch(e){receipt.error=e.code||'EXACT_CLEANUP_FAILED';if(e.child)receipt.child=e.child;}
  writeNew(config.root,path.join(s.evidence,'emergency-cleanup-'+crypto.randomUUID()+'.json'),receipt);return receipt;
}
async function runWorker(config,name,workerScript,policy) {
  const s=config.scenarios[name],env=privateEnvironment(config.root,s,{observePage:['signed-page','success'].includes(name)}),node=path.join(config.inputs.originalApp,'Contents/Resources/runtime/bin/node');
  assertInside(config.root,node,{exists:true});
  const log=path.join(s.evidence,'original-updater.log'),fd=fs.openSync(log,'wx',0o600);
  const child=spawn('/usr/bin/sandbox-exec',['-f',policy,node,workerScript,'--internal-worker',path.join(config.root,'rehearsal.json'),name],{cwd:config.root,env:{...env,CHATHAND_REHEARSAL_WORKER:'1'},stdio:['ignore',fd,fd]});
  const supervisor=name==='signed-page'||!Number.isSafeInteger(child.pid)?null:startProcessSupervisor(config,s,child.pid,env);
  const started=performance.now();
  const result=await new Promise(resolve=>{
    let timedOut=false,hardStop;
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');hardStop=setTimeout(()=>child.kill('SIGKILL'),3000);},210000);
    child.on('error',e=>{clearTimeout(timer);clearTimeout(hardStop);resolve({exit:null,signal:null,error:e.code||'SPAWN_ERROR'});});
    child.on('exit',(code,signal)=>{clearTimeout(timer);clearTimeout(hardStop);resolve({exit:code,signal:signal||null,timedOut});});
  });if(supervisor)result.processSupervisor=supervisor.stop();fs.closeSync(fd);result.elapsedMs=Math.round(performance.now()-started);result.pid=child.pid;result.log=log;
  let receipt;try{receipt=readJSON(config.root,path.join(s.evidence,'worker-result.json'));}catch{}
  const expectedStatus=name==='signed-page'?'PASSED_SIGNED_PAGE_SCENARIO':'PASSED_INSTALLER_SCENARIO',expectedExit=receipt?.candidateCLIEquivalentExit??0;
  const passed=!result.timedOut&&result.exit===expectedExit&&receipt?.status===expectedStatus;
  if(!passed&&result.processSupervisor)result.installerEmergencyCleanup=await stopSupervisedInstallers(config,s,helperPath(config.inputs.candidateApp),env,result.processSupervisor);
  const cleanup=passed?null:await emergencyCleanup(config,name);
  return {name,process:result,receipt:receipt||null,...(cleanup?{emergencyCleanup:cleanup}:{}),status:passed?expectedStatus:'INCOMPLETE_OR_FAILED'};
}
export async function executeRehearsal(config,report) {
  if(process.platform!=='darwin')fail('MAC_REQUIRED');
  const authority=validateAuthority(config,report),root=config.root,helper=helperPath(config.inputs.candidateApp);
  report.executionAuthority=authority;
  // A copy executes inside the same confinement; supplied modules are never
  // evaluated during preflight, and the immutable old package remains separate.
  const support=path.join(root,'support-'+crypto.randomUUID());mkdirPrivate(root,support);
  const supportEnv={HOME:support,CFFIXED_USER_HOME:support,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8'};
  report.signatures={original:signatureReceipt(config.inputs.originalApp,supportEnv),candidate:signatureReceipt(config.inputs.candidateApp,supportEnv)};
  if(!Object.values(report.signatures).every(x=>x.passed))fail('SIGNATURE_VERIFICATION_FAILED');
  report.nativeBoundary=await exerciseNativeBoundary({root,helper,probeExecutable:config.inputs.boundaryProbe});
  if(!report.nativeBoundary.passed)fail('NATIVE_BOUNDARY_PROBE_FAILED');
  const advertised=helperCommand(helper,['rehearsal-profile',root],supportEnv);
  if(advertised.isolation_protocol!==1||typeof advertised.profile!=='string')fail('CANDIDATE_HELPER_PROTOCOL_REQUIRED');
  const policy=path.join(support,'updater.sb');fs.writeFileSync(policy,advertised.profile,{flag:'wx',mode:0o600});
  const workerScript=path.join(support,'rehearse-1060-isolated.mjs');fs.copyFileSync(fileURLToPath(import.meta.url),workerScript,fs.constants.COPYFILE_EXCL);
  report.scenarios=[];report.status='RUNNING';report.runtimeEvidence.signatureVerification='PASSED';report.runtimeEvidence.credentialsRead=false;
  for(const name of authority.scenarios) {
    prepareScenario(config,name);report.scenarios.push(await runWorker(config,name,workerScript,policy));
    if(!['PASSED_INSTALLER_SCENARIO','PASSED_SIGNED_PAGE_SCENARIO'].includes(report.scenarios.at(-1).status))break;
  }
  const receipts=report.scenarios.map(s=>s.receipt).filter(Boolean),seenPIDs=new Set();
  for(const r of receipts)for(const identity of [r.beforeIdentity,r.newIdentity,r.afterIdentity,r.restart?.afterIdentity]) {
    for(const [kind,pid,executable] of [
      ...(identity?.pids||[]).map((pid,i)=>['native',pid,identity.executable_paths?.[i]]),
      ...(identity?.backend?[['backend',identity.backend.pid,identity.backend.executable]]:[])]) {
      if(!seenPIDs.has(pid)){seenPIDs.add(pid);report.runtimeEvidence.startedProcesses.push({scenario:r.name,kind,pid,executable});}
    }
  }
  report.runtimeEvidence.transaction=receipts.filter(r=>r.outcome).map(r=>({scenario:r.name,status:r.outcome.status,error_code:r.outcome.error_code||null,candidateCLIEquivalentExit:r.candidateCLIEquivalentExit}));
  report.runtimeEvidence.locks=receipts.filter(r=>r.outcome).map(r=>({scenario:r.name,installLockAbsent:r.installLockAbsent,pendingClassification:r.pendingClassification}));
  report.runtimeEvidence.health=receipts.filter(r=>r.before).map(r=>({scenario:r.name,before:r.before,after:r.after||r.restart?.after||null,cleanup:r.ownedAppAfterStop||null}));
  for(const r of receipts.filter(r=>r.pageEvidence))for(const row of pageRows(root,config.scenarios[r.name]).filter(row=>row.kind==='snapshot'))report.runtimeEvidence.screenshots.push(path.join(r.pageEvidence,row.file));
  report.blockers=report.blockers.filter(b=>b.code!=='FINAL_CANDIDATE_AUTHORITY_REQUIRED'&&
    !(b.code==='FINAL_NATIVE_PAGE_HOOK_REQUIRED'&&report.scenarios.some(s=>s.status==='PASSED_SIGNED_PAGE_SCENARIO')));
  report.status=report.scenarios.length===authority.scenarios.length&&report.scenarios.every(s=>['PASSED_INSTALLER_SCENARIO','PASSED_SIGNED_PAGE_SCENARIO'].includes(s.status))?'PASSED_REQUESTED_SCENARIOS':'INCOMPLETE_OR_FAILED';
  report.scope='Only the explicitly requested temporary-root scenarios. Original1059 old-window hook and real Chrome native-channel acceptance are independent.';
  report.exitCode=report.status==='PASSED_REQUESTED_SCENARIOS'?0:1;return report;
}

export async function main(args) {
  const {command, value} = parseArgs(args);
  if (command === 'help') {
    console.log('init --root ABS_PRIVATE_TEMP/chathand-1060-rehearsal-ID\npreflight --config ABS_ROOT/rehearsal.json\nrun --config ABS_ROOT/rehearsal.json\nPreflight is read-only. Real run requires frozen execution-authority.json, matching final bytes and successful native confinement probes.');
    return 0;
  }
  if (command === 'init') { const config = initialize(value); console.log(path.join(config.root, 'rehearsal.json')); return 0; }
  // Validate config location before reading it: never inspect formal data/credentials.
  const root = assertRoot(path.dirname(value));
  if (path.basename(value) !== 'rehearsal.json') fail('CONFIG_LOCATION');
  const config = validateConfig(readJSON(root, value));
  if (config.root !== root) fail('CONFIG_ROOT_MISMATCH');
  let report = prepareReport(config, command);
  if(command === 'run' && report.exitCode !== 66) {
    try { report = await executeRehearsal(config, report); }
    catch(e) { report.status=report.status==='RUNNING'?'INCOMPLETE_OR_FAILED':'REFUSED_NOT_EXECUTED'; report.refusal=e.code||'RUNTIME_PRECONDITION'; report.exitCode=78; }
  }
  const evidence = assertInside(root, path.join(root, 'evidence'), {exists: true});
  if (!fs.statSync(evidence).isDirectory()) fail('EVIDENCE_DIRECTORY_REQUIRED');
  const reportFile = path.join(evidence, `${Date.now()}-${crypto.randomUUID()}-${command}.json`);
  writeNew(root, reportFile, report);
  console.log(JSON.stringify({status: report.status, report: reportFile, exitCode: report.exitCode}));
  return report.exitCode;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if(process.argv[2]==='--internal-worker') {
      if(process.env.CHATHAND_REHEARSAL_WORKER!=='1'||process.argv.length!==5)fail('WORKER_ENTRY_NOT_AUTHORIZED');
      const root=assertRoot(path.dirname(process.argv[3]));
      if(process.env.CHATHAND_REHEARSAL_ROOT!==root||path.basename(process.argv[3])!=='rehearsal.json'||!SCENARIOS.includes(process.argv[4]))fail('WORKER_ARGUMENTS');
      const config=validateConfig(readJSON(root,process.argv[3]));
      if(config.root!==root)fail('CONFIG_ROOT_MISMATCH');
      authorizeWorker(config,process.argv[4]);
      const result=await worker(config,process.argv[4]);process.exitCode=['PASSED_INSTALLER_SCENARIO','PASSED_SIGNED_PAGE_SCENARIO'].includes(result.status)?result.candidateCLIEquivalentExit??0:1;
    } else {process.exitCode = await main(process.argv.slice(2));}
  }
  catch (e) { console.error(JSON.stringify({status: 'REFUSED', code: e.code || 'INVALID_INPUT'})); process.exitCode = 64; }
}

// 1063 adds a separate ordinary LaunchServices entry without weakening the
// fixed sandbox. The gateway is disposable; the product binary remains intact.
export function makeLaunchServicesGateway({root,directory,binary,profile,environment,arguments:args=[],gatewayBinary}) {
 assertRoot(root);
 for(const file of [binary,profile,gatewayBinary])assertInside(root,file,{exists:true});
 assertInside(root,directory);if(fs.existsSync(directory))fail('REHEARSAL_GATEWAY_ALREADY_EXISTS');
 const contents=path.join(directory,'Contents');
 for(const dir of ['MacOS','Resources'])fs.mkdirSync(path.join(contents,dir),{recursive:true,mode:0o700});
 const id='invalid.chathand.launchgateway.'+crypto.randomBytes(12).toString('hex');
 fs.copyFileSync(gatewayBinary,path.join(contents,'MacOS','LaunchGateway'),fs.constants.COPYFILE_EXCL);
 fs.chmodSync(path.join(contents,'MacOS','LaunchGateway'),0o700);
 const plist=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>LaunchGateway</string><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleName</key><string>Isolated Launch Gateway</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`;
 fs.writeFileSync(path.join(contents,'Info.plist'),plist,{flag:'wx',mode:0o600});
 fs.writeFileSync(path.join(contents,'Resources','launch.json'),JSON.stringify({root,binary,profile,environment,arguments:args}),{flag:'wx',mode:0o600});
 return directory;
}
