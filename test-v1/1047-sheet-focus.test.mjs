import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {controlErrorDetails, controlErrorRecovery} from '../engine/src/control-errors.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const source=name=>fs.readFileSync(path.join(root,name),'utf8');

test('1047 production pins observed sheet instead of accepting any same-app dialog',()=>{
 const native=source('native/ComputerControl.swift');
 assert.match(native,/var interactionSurface: InteractionSurface\?/);
 assert.match(native,/foreground\(target,estimatedSeconds:estimatedSeconds,observedSurface:surface\)/);
 assert.match(native,/sameWindow\(surface\.element, focusedWindow\(target\.app\)\)/);
 assert.match(native,/CFEqual\(parent, elements\[depth-1\]\)/);
 assert.match(native,/CFEqual\(ownerWindow, target\.window\)/);
 assert.match(native,/interactionSurfaceCurrent\(surface, target: target\)/);
 assert.match(native,/surface\.frame\.contains\(point\)/);
 assert.match(native,/elementBelongsToSurface\(element, surface: surface/);
 assert.match(native,/foregroundInputEvents \+= 1\s+event\.post/);
 assert.match(native,/static func sameWindow[\s\S]*?return CFEqual\(first, second\)/,'do not globally relax exact window equality');
 const b2=source('native/B2TargetClick.swift');
 assert.match(b2,/windowCount == 1/);
 assert.match(b2,/ComputerControl\.sameWindow\(target\.window, focusedWindow\)/);
 assert.match(b2,/FrontGuard\.read\(\) == front/);
 assert.doesNotMatch(b2,/InteractionSurface|AXSheet|\.activate\(/,'B2 eligibility is unchanged');
});

test('1047 native surface topology, dispatch provenance and negative gates run without desktop input', {skip:process.platform!=='darwin',timeout:120000},t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1047-surface-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const cache=process.env.CHATHAND_TEST_SWIFT_CACHE||path.join(dir,'module-cache');
 fs.mkdirSync(cache,{recursive:true});
 const binary=path.join(dir,'pure-surface-checks');
 const env={...process.env,CHATHAND_STATE_DIR:path.join(dir,'state'),CLANG_MODULE_CACHE_PATH:cache};
 const build=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','-module-cache-path',cache,
  '-framework','Cocoa','-framework','ApplicationServices','-framework','ScreenCaptureKit','-framework','Vision',
  'native/LocalText.swift','native/ComputerControl.swift','native/B2TargetClick.swift','test-v1/1047-sheet-focus.swift','-o',binary],
  {cwd:root,env,encoding:'utf8',timeout:90000});
 assert.equal(build.status,0,(build.error?.code||'')+' '+build.stderr);
 fs.cpSync(path.join(root,'locales'),path.join(dir,'locales'),{recursive:true});
 const run=spawnSync(binary,[],{cwd:root,env,encoding:'utf8',timeout:5000});
 assert.equal(run.status,0,run.stderr);
 assert.match(run.stdout,/PASS \d+ isolated 1047 surface checks; zero real events/);
 console.log(run.stdout.trim());
});

test('1047 focus diagnostics preserve only fixed reasons and bounded counts; no raw fields',()=>{
 const raw={delivery_unconfirmed:false,do_not_replay:false,focus_reason:'surface_changed',foreground_input_events:0,
   title:'private-window-title',password:'fixture-secret',argv:['private'],raw_arguments:{secret:'fixture-secret'}};
 const clean=controlErrorDetails('FOCUS_CHANGED',raw,x=>x);
 assert.deepEqual(clean,{delivery_unconfirmed:false,do_not_replay:false,focus_reason:'surface_changed',foreground_input_events:0});
 for(const reason of ['front_app_changed','surface_changed','focused_surface_changed']){
  assert.equal(controlErrorDetails('FOCUS_CHANGED',{focus_reason:reason},x=>x).focus_reason,reason);
 }
 for(const value of [-1,1.5,100001,NaN,Infinity,'1']) {
  assert.equal(controlErrorDetails('FOCUS_CHANGED',{foreground_input_events:value},x=>x)?.foreground_input_events,undefined);
 }
 assert.equal(controlErrorDetails('FOCUS_CHANGED',{focus_reason:'private-model-controlled-text'},x=>x),null);
 assert.equal(controlErrorDetails('BROWSER_TIMEOUT',{focus_reason:'surface_changed',foreground_input_events:2},x=>x),null);
 assert.deepEqual(controlErrorRecovery('FOCUS_CHANGED'),{next_action:'computer_observe',automatic_retry:false,create_new_task:false});
 const posted=controlErrorDetails('FOCUS_CHANGED',{delivery_unconfirmed:true,do_not_replay:true,foreground_input_events:2,focus_reason:'front_app_changed'},x=>x);
 assert.equal(posted.do_not_replay,true);
 assert.equal(posted.foreground_input_events,2);
});
