import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureID = 'test.chathand.exitreopen1084';
const delays = [0, 500, 1000, 2000, 3000, 4000];
const fixtureEnvironment = { ...process.env };
for (const key of Object.keys(fixtureEnvironment)) if (key.startsWith('CHATHAND_REHEARSAL_') || key === 'CHATHAND_STATE_DIR' || key === 'KEN_BRIDGE_STATE_DIR') delete fixtureEnvironment[key];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000, env: fixtureEnvironment, ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr || ''}${result.stdout || ''}`);
  return result.stdout.trim();
}
function rows(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function extractSwiftMethod(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `production method missing: ${signature}`);
  const open = source.indexOf('{', start); assert.notEqual(open, -1, `method body missing: ${signature}`);
  let depth = 0, quoted = false, escaped = false;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') { quoted = true; continue; }
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`unterminated method: ${signature}`);
}
function extractSwiftRange(source, startSignature, endSignature) {
  const start = source.indexOf(startSignature), end = source.indexOf(endSignature, start);
  assert.notEqual(start, -1, `production source block missing: ${startSignature}`);
  assert.notEqual(end, -1, `production source block end missing: ${endSignature}`);
  assert.ok(end > start, `invalid production source block: ${startSignature}`);
  return source.slice(start, end).trimEnd();
}
async function waitFor(check, timeout = 12000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = check(); if (value) return value; await sleep(25); }
  assert.fail('timed out waiting for fixture receipt');
}
function cli(binary, action, app, pid) {
  const output = run(binary, ['controller', action, app, ...(pid == null ? [] : [String(pid)])]);
  return action === 'quit' ? { action } : JSON.parse(output);
}
function cliAsync(binary, action, app, pid) {
  return new Promise(resolve => {
    const child = spawn(binary, ['controller', action, app, ...(pid == null ? [] : [String(pid)])], { env: fixtureEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; }); child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('1084 private exit/reopen fixture', { skip: process.platform !== 'darwin', timeout: 360000 }, async t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chathand-1084-exit-reopen-')));
  fs.chmodSync(base, 0o700);
  const app = path.join(base, 'Fixture.app'), contents = path.join(app, 'Contents');
  const macos = path.join(contents, 'MacOS'), resources = path.join(contents, 'Resources');
  const helperDir = path.join(resources, 'runtime', 'bin');
  fs.mkdirSync(macos, { recursive: true }); fs.mkdirSync(helperDir, { recursive: true });
  const appBin = path.join(macos, 'ChatHandExitReopenFixture');
  const helper = path.join(helperDir, 'ken-upgrade-control');
  const backendBin = path.join(helperDir, 'ExitReopenBackend');
  const baseline=process.env.CHATHAND_EXIT_REOPEN_BASELINE==='1';
  const baselineCommit='43d9a8a';
  const productionSource=file=>baseline ? run('/usr/bin/git',['show',baselineCommit+':'+file],{cwd:root}) : fs.readFileSync(path.join(root,file),'utf8');
  const sourceInstance=productionSource('native/InstanceLifecycle.swift');
  const replacementID = (sourceInstance.match(/com\.kenyu\.chathand/g) || []).length;
  const replacementApp = (sourceInstance.match(/\/Applications\/ChatHand\.app/g) || []).length;
  assert.ok(replacementID >= 1 && replacementApp === 1, 'expected fixture-safe edits to match only the product identifier and default app path');
  const instanceCopy = path.join(base, 'InstanceLifecycle.swift');
  let fixtureInstance=sourceInstance.replaceAll('com.kenyu.chathand', fixtureID).replace('/Applications/ChatHand.app', app);
  // Keep the frozen baseline's decisions/order; suppress only its error UI.
  if(baseline)fixtureInstance=fixtureInstance.replace('config.activates=activate\n','config.activates=activate;config.promptsUserIfNeeded=false\n');
  fs.writeFileSync(instanceCopy,fixtureInstance);
  const plist = {
    CFBundleExecutable: 'ChatHandExitReopenFixture', CFBundleIdentifier: fixtureID,
    CFBundleName: 'ChatHand Exit Reopen Fixture', CFBundlePackageType: 'APPL',
    CFBundleVersion: '1084', LSUIElement: true
  };
  fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${Object.entries(plist).map(([k,v]) => `<key>${k}</key>${typeof v === 'boolean' ? (v ? '<true/>' : '<false/>') : `<string>${String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</string>`}`).join('')}</dict></plist>`);
  const cache = process.env.CHATHAND_TEST_SWIFT_CACHE || path.join(base, 'swift-module-cache');
  const productionMain=productionSource('native/main.swift');
  const productionQuitBlock = extractSwiftRange(productionMain, '@objc func quit()', '    private func installerOwnsBackend()');
  const productionRelaunch = extractSwiftMethod(productionMain, baseline ? 'func relaunchChatHand(completion: @escaping ([String:Any])->Void)' : 'func relaunchChatHand(afterExitOnly:Bool = false, activate:Bool = true, completion: @escaping ([String:Any])->Void)');
  const appShouldTerminate = extractSwiftMethod(productionMain, 'func applicationShouldTerminate(_ sender:NSApplication)->NSApplication.TerminateReply');
  const appShouldReopen = extractSwiftMethod(productionMain, 'func applicationShouldHandleReopen(_ sender:NSApplication,hasVisibleWindows:Bool)->Bool');
  const fixtureTemplate = fs.readFileSync(path.join(root, 'native/tests/1084ExitReopenChecks.swift'), 'utf8');
  let generatedFixture = fixtureTemplate
    .replace('__PRODUCTION_QUIT_BLOCK__', productionQuitBlock)
    .replace('__PRODUCTION_RELAUNCH_METHOD__', productionRelaunch)
    .replace('__PRODUCTION_APPLICATION_SHOULD_TERMINATE__', appShouldTerminate)
    .replace('__PRODUCTION_APPLICATION_SHOULD_HANDLE_REOPEN__', appShouldReopen);
  if(baseline){
    const begin=generatedFixture.indexOf('                let quitDeadline =');
    const end=generatedFixture.indexOf('                guard let startup =',begin);
    assert.ok(begin>=0 && end>begin);
    generatedFixture=generatedFixture.slice(0,begin)+'                let diagnostic:InstanceLifecycle.Diagnostic={_,code,pid in emit(self.records,code,["owner_pid":Int(pid)])}\n                _ = try InstanceLifecycle.captureBackend(state:self.stateURL,source:source,scope:scope)\n'+generatedFixture.slice(end);
  }
  assert.doesNotMatch(generatedFixture, /__PRODUCTION_[A-Z_]+__/);
  const fixtureSource = path.join(base, 'ExitReopenFixture.generated.swift'); fs.writeFileSync(fixtureSource, generatedFixture);
  const fixtureBuild = run('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-module-cache-path', cache, '-parse-as-library', '-framework', 'Cocoa', '-framework', 'Security', instanceCopy, path.join(root, 'native/NativeTermination.swift'), fixtureSource, '-o', appBin]);
  void fixtureBuild;
  const helperSource=path.join(base,'UpgradeControl.swift');fs.writeFileSync(helperSource,productionSource('native/UpgradeControl.swift'));
  const helperBuild = spawnSync('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-module-cache-path', cache, '-parse-as-library', '-framework', 'Cocoa', '-framework', 'Security', instanceCopy, helperSource, '-o', helper], { encoding: 'utf8', timeout: 120000 });
  assert.equal(helperBuild.status, 0, helperBuild.stderr || helperBuild.stdout);
  fs.copyFileSync(appBin, backendBin);
  run('/bin/chmod', ['700', appBin, helper]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', fixtureID, '--deep', app]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  let completed = false;
  t.after(() => {
    // Cleanup only fixture receipt PIDs whose executable path is the exact known fixture binary.
    const known = rows(path.join(base, 'events.jsonl')).flatMap(row => [
      [row.pid, appBin], [row.helper_pid, helper], [row.backend_pid, backendBin]
    ]).filter(([pid, expected]) => Number.isInteger(pid) && pid > 1 && expected);
    for (const [pid, expected] of known) {
      const comm = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).stdout.trim();
      if (comm === expected) spawnSync('/bin/kill', ['-TERM', String(pid)]);
    }
    if (completed) fs.rmSync(base, { recursive: true, force: true });
    else console.error(`1084 fixture records retained for diagnosis: ${base}`);
  });

  const evidence = process.env.CHATHAND_EXIT_REOPEN_EVIDENCE || path.join(base, 'evidence.json');
  const smoke = process.env.CHATHAND_EXIT_REOPEN_SMOKE === '1';
  const cases = [];
  const modes = ['new-instance', 'bundle-reopen'];
  outer: for (const mode of modes) for (const delay of (baseline?[0]:delays)) for (let round = 1; round <= (baseline?1:3); round++) {
    if (smoke && !(mode === 'bundle-reopen' && delay === 0 && round === 1)) continue;
    const caseDir = path.join(base, `case-${mode}-${delay}-${round}`); fs.mkdirSync(caseDir, { mode: 0o700 });
    const events = path.join(base, 'events.jsonl');
    try {
    fs.rmSync(events, { force: true }); fs.rmSync(path.join(base, 'state'), { recursive: true, force: true });
    fs.mkdirSync(path.join(base, 'state'), { mode: 0o700 });
    const launch = cli(appBin, 'launch', app);
    const owner = (await waitFor(() => rows(events).find(row => row.event === 'OWNER_READY'))).pid;
    const pendingQuit = cliAsync(appBin, 'quit', app, owner);
    const requested = await waitFor(() => rows(events).find(row => row.event === 'QUIT_REQUESTED'));
    const marked = baseline ? requested : await waitFor(() => rows(events).find(row => row.event === 'INSTANCE_MARKED_QUITTING'));
    await sleep(Math.max(0, delay - (Date.now() - requested.time * 1000)));
    const openElapsedMs=Date.now()-requested.time*1000;
    let branch = 'new-open';
    if (mode === 'new-instance') cli(appBin, 'launch', app);
    else {
      const oldAlive = spawnSync('/bin/kill', ['-0', String(owner)]).status === 0;
      branch = oldAlive ? 'helper-targeted-old-owner' : 'cold-open-after-old-gone';
      cli(appBin, 'open', app);
    }
    if(baseline){
      await waitFor(()=>spawnSync('/bin/kill',['-0',String(owner)]).status!==0,10000);
      const quitResult=await pendingQuit;assert.equal(quitResult.code,0,quitResult.stderr);
      await sleep(150);
      const snapshot=cli(appBin,'snapshot',app);
      const record={baseline_commit:baselineCommit,mode,requested_delay_ms:delay,actual_open_elapsed_ms:Math.round(openElapsedMs),round,old_pid:owner,branch,expected_failure:'no surviving fixture app',active_owner_pids:snapshot.pids,records:rows(events),quit_controller:quitResult};
      cases.push(record);
      fs.writeFileSync(path.join(caseDir,'records.json'),JSON.stringify(record,null,2),{mode:0o600});
      fs.writeFileSync(evidence,JSON.stringify({fixture_id:fixtureID,baseline:true,baseline_commit:baselineCommit,cases},null,2),{mode:0o600});
      assert.equal(snapshot.pids.length,0,'unchanged baseline loses both open paths during the quit window');
      console.log('baseline '+mode+' delay='+delay+': no surviving app as expected');
      continue;
    }
    const newOwner = await waitFor(() => rows(events).filter(row => row.event === 'OWNER_READY' && row.pid !== owner).at(-1), 20000);
    await waitFor(() => spawnSync('/bin/kill', ['-0', String(owner)]).status !== 0, 10000);
    const quitResult=await pendingQuit;assert.equal(quitResult.code,0,quitResult.stderr);
    const snapshot = await waitFor(() => {
      const result = cli(appBin, 'snapshot', app);
      return result.pids.length === 1 && result.pids[0] === newOwner.pid ? result : null;
    }, 3000);
    const allRows = rows(events), nativeExit = allRows.find(row => row.event === 'NATIVE_TERMINATE' && row.pid === owner);
    const quitElapsedMs = nativeExit ? Math.round((nativeExit.time - requested.time) * 1000) : null;
    const record = { mode, delay_ms: delay, requested_delay_ms:delay, actual_open_elapsed_ms:Math.round(openElapsedMs), round, old_pid: owner, new_pid: newOwner.pid, branch, marked_uptime: marked.uptime, quit_elapsed_ms: quitElapsedMs, active_owner_pids: snapshot.pids, records: allRows };
    fs.writeFileSync(path.join(caseDir, 'records.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
    assert.equal(snapshot.pids.length, 1, `case ${mode}/${delay}/${round} must leave exactly one live fixture app process`);
    assert.ok(quitElapsedMs != null && quitElapsedMs < 3000, `owner quit must finish before the 3 second cap; observed ${quitElapsedMs} ms`);
    cli(appBin, 'probe', app);
    const windowReceipt = await waitFor(() => rows(events).find(row => row.event === 'WINDOW_REQUESTIBLE' && row.pid === newOwner.pid));
    assert.equal(windowReceipt.visible, true, 'probe should present a genuinely visible window briefly');
    assert.equal(windowReceipt.miniaturized, false, 'probe window should not be miniaturized');
    record.window_receipt=windowReceipt;record.records=rows(events);record.helper_records=rows(path.join(base,'state','diagnostics','native-events.jsonl'));record.quit_controller=quitResult;cases.push(record);
    fs.writeFileSync(path.join(caseDir,'records.json'),JSON.stringify(record,null,2),{mode:0o600});
    fs.writeFileSync(evidence, JSON.stringify({ fixture_id: fixtureID, substitutions: { bundle_id: replacementID, app_path: replacementApp }, smoke, cases }, null, 2), { mode: 0o600 });
    console.log(`${mode} delay=${delay} round=${round}: old=${owner} new=${newOwner.pid} branch=${branch}`);
    cli(appBin, 'quit', app, newOwner.pid);
    await waitFor(() => spawnSync('/bin/kill', ['-0', String(newOwner.pid)]).status !== 0, 10000);
    if (smoke) break outer;
    } catch (error) {
      const partial = { mode, delay_ms: delay, round, error: String(error), records: rows(events) };
      fs.writeFileSync(path.join(caseDir, 'records.json'), JSON.stringify(partial, null, 2), { mode: 0o600 });
      fs.writeFileSync(evidence, JSON.stringify({ fixture_id: fixtureID, substitutions: { bundle_id: replacementID, app_path: replacementApp }, smoke, completed_cases: cases, failed_case: partial }, null, 2), { mode: 0o600 });
      throw error;
    }
  }
  assert.equal(cases.length, baseline ? 2 : smoke ? 1 : 36);
  const edges=[];
  if (!smoke && !baseline) {
    const events = path.join(base, 'events.jsonl');
    fs.rmSync(events, { force: true }); fs.rmSync(path.join(base, 'state'), { recursive: true, force: true }); fs.mkdirSync(path.join(base, 'state'), { mode: 0o700 });
    const onlyQuit = cli(appBin, 'launch', app);
    const firstOwner = await waitFor(() => rows(events).find(row => row.event === 'OWNER_READY'));
    cli(appBin, 'quit', app, firstOwner.pid);
    await waitFor(() => spawnSync('/bin/kill', ['-0', String(firstOwner.pid)]).status !== 0, 10000);
    await sleep(250);
    assert.equal(rows(events).filter(row => row.event === 'OWNER_READY').length, 1, 'ordinary Quit must not relaunch an owner');
    assert.equal(rows(events).some(row => row.event === 'RELAUNCH_REQUESTED'), false, 'ordinary Quit must not start the reopen helper');
    assert.equal(cli(appBin,'snapshot',app).pids.length,0);
    edges.push({kind:'quit-only',records:rows(events)});

    fs.rmSync(events, { force: true }); fs.rmSync(path.join(base, 'state'), { recursive: true, force: true }); fs.mkdirSync(path.join(base, 'state'), { mode: 0o700 });
    cli(appBin, 'launch', app);
    const old = await waitFor(() => rows(events).find(row => row.event === 'OWNER_READY'));
    const doubleQuit=cliAsync(appBin,'quit',app,old.pid);
    await waitFor(() => rows(events).find(row => row.event === 'INSTANCE_MARKED_QUITTING'));
    const [a, b] = await Promise.all([cliAsync(appBin, 'launch', app), cliAsync(appBin, 'launch', app)]);
    const newReady = await waitFor(() => rows(events).filter(row => row.event === 'OWNER_READY' && row.pid !== old.pid).at(-1), 20000);
    assert.equal((await doubleQuit).code,0);
    const live = await waitFor(() => { const result = cli(appBin, 'snapshot', app); return result.pids.length === 1 && result.pids[0] === newReady.pid ? result : null; }, 3000);
    assert.equal(live.pids.length, 1, `double-open race must leave one owner (launch statuses ${a.code}, ${b.code}; winner ${newReady.pid})`);
    edges.push({kind:'double-open',records:rows(events),final_pids:live.pids});
    cli(appBin, 'quit', app, newReady.pid);
    await waitFor(() => spawnSync('/bin/kill', ['-0', String(newReady.pid)]).status !== 0, 10000);
  }
  fs.writeFileSync(evidence,JSON.stringify({fixture_id:fixtureID,substitutions:{bundle_id:replacementID,app_path:replacementApp},baseline,baseline_commit:baseline?baselineCommit:null,baseline_error_ui_suppression:baseline,smoke,cases,edges},null,2),{mode:0o600});
  completed = true;
});
