import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Source-only H11 B acceptance: no AX, input events, capture, OS prompts or GUI.
test('H11 desktop defaults stay background, protected and bound to the original window',()=>{
 const swift=fs.readFileSync(new URL('../native/ComputerControl.swift',import.meta.url),'utf8');
 const schema=fs.readFileSync(new URL('../app/v07/computer.mjs',import.meta.url),'utf8');
 const section=(start,end)=>{
  const from=swift.indexOf(start);assert.ok(from>=0,start);
  const to=swift.indexOf(end,from+start.length);assert.ok(to>from,end);
  return swift.slice(from,to);
 };
 assert.doesNotMatch(swift,/NSPasteboard|clipboardType|canRestoreClipboard|addGlobalMonitor|addLocalMonitor|userIntervened|foregroundApproved|COMPUTER_USER_ACTIVITY/);
 const defaults=section('@MainActor static func perform(', '        let estimatedSeconds =');
 assert.doesNotMatch(defaults,/session\.foreground|sendMouse|sendKey|unicode\(|\.post\(tap:|session\.confirm/);
 const press=defaults.indexOf('AXUIElementPerformAction(element, kAXPressAction');
 const value=defaults.indexOf('AXUIElementSetAttributeValue(element,kAXValueAttribute');
 for(const at of [press,value]){
  assert.ok(at>0);
  for(const guard of ['try await session.authorize()', 'try revalidate(args)', 'guard inputAllowedForBundle',
   'try checkSystemPassword(target, element: entry?.element)']){
   assert.ok(defaults.indexOf(guard)>=0&&defaults.indexOf(guard)<at,guard+' before every default AX mutation');
  }
 }
 assert.match(defaults,/case \.unconfirmed: throw ControlFailure\("COMPUTER_ACTION_UNCONFIRMED"/);
 assert.match(defaults,/case \.verified: return .*"background":true,"verified":true/);
 const target=section('    static func target(', '    static func listWindows(');
 assert.ok(target.indexOf('guard !securityProblem')<target.indexOf('return result'));
 const foreground=section('        func foreground(', '        func checkForeground(');
 assert.doesNotMatch(foreground,/confirm\(/);
 assert.ok(foreground.indexOf('foregroundNotice = "借用前台约')<foreground.indexOf('target.app.activate'));
 assert.ok(foreground.indexOf('panelLabel?.stringValue')<foreground.indexOf('target.app.activate'));
 assert.ok(foreground.indexOf('guard inputAllowedForBundle')<foreground.indexOf('AXUIElementPerformAction'));
 assert.ok(foreground.indexOf('!securityProblem(target)')<foreground.indexOf('AXUIElementPerformAction'));
 const check=section('        func checkForeground(', '        @discardableResult func finish(');
 // 1047 keeps exact foreground PID and the observed input-surface object.
 // A positively bound AXSheet is not CFEqual to its parent AXWindow.
 assert.match(check,/foregroundSurfaceProblem\(targetPID: targetApp\?\.processIdentifier/);
 assert.match(check,/frontPID: NSWorkspace\.shared\.frontmostApplication\?\.processIdentifier/);
 assert.match(check,/sameWindow\(\$0\.element, focusedWindow\(app\)\)/);
 assert.match(check,/interactionSurfaceCurrent\(\$0, target: target\)/);
 const focusRules=section('    static func foregroundSurfaceProblem(', '    static func foregroundFailure(');
 assert.match(focusRules,/frontPID == targetPID/);
 assert.match(focusRules,/guard surfaceCurrent/);
 assert.match(focusRules,/return focusMatches \? nil/);
 const posts=[...swift.matchAll(/event\.post\(tap:/g)];assert.equal(posts.length,4);
 for(const post of posts){
  assert.match(swift.slice(Math.max(0,post.index-220),post.index),/try session\.checkForeground\([^\n]*\)\s*session\.foregroundInputEvents \+= 1\s*$/,'guard immediately before counting and posting each global event');
 }
 const restore=section('        @discardableResult func finish(', '\n    static func pause(');
 assert.match(restore,/targetWindowToken:\(foregroundSurface\?\.element \?\? targetWindow\)\.map \{ axIdentity\(\$0\) \}/);
 assert.match(restore,/guard surfaceRestoreSafe/);
 assert.match(restore,/currentWindowToken:liveWindow\.map \{ axIdentity\(\$0\) \}/);
 assert.match(restore,/windows\(\$0\)\.contains/);
 assert.match(restore,/boolAttr\(window,kAXMinimizedAttribute as String\) == originalMinimized/);
 const latest=section('@MainActor static func latestObservation(', '@MainActor static func openPath(');
 assert.doesNotMatch(latest,/removeValue|focusedWindow/);
 assert.match(latest,/self\.target\(args\)/);
 assert.match(latest,/expectedPID:snapshot\.pid,expectedWindowToken:snapshot\.windowToken/);
 assert.match(latest,/actualPID:target\.app\.processIdentifier,actualWindowToken:axIdentity\(target\.window\)/);
 const batch=section('output = try await runBatch(steps, foregroundEvents:', '                    } else {');
 assert.match(batch,/foregroundEvents: \{ session\.foregroundInputEvents \}/);
 assert.match(batch,/postStepReadback\(step,/);
 assert.match(batch,/perform: \{ try await perform\(\$0,session:session\) \}/);
 assert.match(batch,/observe: \{ try await latestObservation\(\$0,includeImage:false\) \}/);
 assert.match(batch,/check: \{ try session\.check\(\) \}/);
 const readback=section('@MainActor static func postStepReadback(', '@MainActor static func runBatch(');
 assert.match(readback,/if dispatchedB2 \{/);
 assert.match(readback,/uncertain: true/);
 assert.match(readback,/throw ControlFailure\("COMPUTER_ACTION_UNCONFIRMED"/);
 const batchRules=section('@MainActor static func runBatch(', '    static func changes(');
 assert.match(batchRules,/failure = e; break/);
 assert.match(batchRules,/"status":"not_attempted"/);
 assert.match(swift,/SCContentFilter\(desktopIndependentWindow: window\)/);
 assert.match(swift,/output\["foreground_notice"\] = notice/);
 assert.match(swift,/@objc func pressed\(\)[\s\S]*?ComputerControl\.stopped = true/);
 assert.doesNotMatch(section('@MainActor static func openPath(', '    static func execute('),/session\.confirm|require_confirmation/,'open_path follows scope and identity without a new confirmation');
 assert.doesNotMatch(schema,/SECURE_INPUT|COMPUTER_CONFIRM_REQUIRED/);
 assert.doesNotMatch(schema,/Stop on failure, user activity|Foreground use requires local confirmation|前台或剪贴板操作要先/);
});
