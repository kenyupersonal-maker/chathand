import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {NativeComputer} from '../app/v07/computer.mjs';

const root=fileURLToPath(new URL('..', import.meta.url));
const source=p=>fs.readFileSync(path.join(root,p),'utf8');
const computer=()=>new NativeComputer({data:{mode:'full'}},{});

const posted={method:'background_target_click',background:true,
  delivery_status:'posted_unconfirmed',delivery_unconfirmed:true,
  verified:false,completed:false,do_not_replay:true,automatic_retry:false,
  attempted_target_channels:10,target_focus_records:2,
  message:'已发出，未确认；先截图确认，不要再点。',next_action:'computer_screenshot'};

test('1044 normal complete B2 postResult is not an error or verified effect and preserves read-only guidance',()=>{
  const target={bundle_id:'fixture.b2',window_id:'w23'};
  const result=computer().postResult({...posted},{task_id:'fixture'},'fixture',target);
  assert.equal(result.method,'background_target_click');
  assert.deepEqual(result.next_target,target,'screenshot must use the original observed target');
  assert.equal(result.next_action,'computer_screenshot');
  assert.equal(result.delivery_status,'posted_unconfirmed');
  assert.equal(result.delivery_unconfirmed,true);
  assert.equal(result.do_not_replay,true);
  assert.equal(result.automatic_retry,false);
  assert.equal(result.verified,false);
  assert.equal(result.completed,false);
  assert.equal(result.background,true);
  assert.match(result.message,/先截图确认.*不要再点/);
  assert.equal(Object.hasOwn(result,'isError'),false,'not a rejected RPC');
});

test('1044 B2 batch stop always has nonreplayable normal stop and never suggests a second click',()=>{
  const batch={completed:false,stop_reason:'posted_unconfirmed',
    delivery_status:'posted_unconfirmed',do_not_replay:true,verified:false,
    receipts:[{step_id:'first',status:'posted_unconfirmed',result:posted},
      {step_id:'second',status:'not_attempted'}],remaining_steps:1};
  const target={bundle_id:'fixture.b2',window_id:'w23'};
  const out=computer().postResult(batch,{task_id:'fixture'},'fixture',target);
  assert.equal(out.next_action,'computer_screenshot');
  assert.deepEqual(out.next_target,target);
  assert.equal(out.completed,false);
  assert.equal(out.receipts[0].status,'posted_unconfirmed');
  assert.equal(out.receipts[1].status,'not_attempted');
  assert.equal(out.do_not_replay,true);
});

test('1044 AX success and failed or invalid B2 shapes cannot be confused with normal posted receipts',()=>{
  const nc=computer();
  assert.equal(nc.postResult({performed:'click',method:'accessibility_press',verified:true},{task_id:'fixture'},'fixture').next_action,
    'use_returned_observation_or_computer_observe');
  const target={bundle_id:'fixture.b2',window_id:'w23'};
  const goodBatch={completed:false,stop_reason:'posted_unconfirmed',
    delivery_status:'posted_unconfirmed',do_not_replay:true,verified:false,
    receipts:[{status:'posted_unconfirmed',result:posted},{status:'not_attempted'}],
    remaining_steps:1};
  for(const bad of [
    {...posted,delivery_status:'verified'}, {...posted,do_not_replay:false},
    {...posted,verified:true}, {...posted,completed:true},
    {...posted,background:false}, {...posted,delivery_unconfirmed:false},
    {...posted,attempted_target_channels:9}, {...posted,target_focus_records:1},
    {...posted,performed:'click'}, {...posted,failure:{code:'TARGET_CHANGED'}},
    {...goodBatch,verified:true}, {...goodBatch,completed:true},
    {...goodBatch,failure:{code:'TARGET_CHANGED'}},
    {...goodBatch,receipts:[{status:'posted_unconfirmed',result:{...posted,verified:true}},{status:'not_attempted'}]},
    {...goodBatch,remaining_steps:0}
  ]) {
    assert.throws(()=>nc.postResult(bad,{task_id:'fixture'},'fixture',target),
      e=>e.code==='COMPUTER_ACTION_UNCONFIRMED'&&
        e.details?.do_not_replay===true&&e.details?.delivery_unconfirmed===true,
      'malformed B2 receipt must be an uncertain error, not a non-error result');
  }
  const missingTarget=nc.postResult({...posted},{task_id:'fixture'},'fixture');
  assert.equal(missingTarget.next_action,'computer_observe','do not screenshot whichever App is now in front');
  assert.equal(Object.hasOwn(missingTarget,'next_target'),false);
  const wrongWindow=nc.postResult({...posted},{task_id:'fixture'},'fixture',
    {bundle_id:'fixture.b2',window_id:'not-a-window'});
  assert.equal(wrongWindow.next_action,'computer_observe','invalid saved window cannot become screenshot target');
});

test('1044 source keeps AX before B2, all guards, safe fallback, no extra keyboard or window qualification relaxation',()=>{
 const b2=source('native/B2TargetClick.swift'), native=source('native/ComputerControl.swift');
 const perform=native.slice(native.indexOf('@MainActor static func perform('),native.indexOf('@MainActor static func runBatch('));
 const ax=perform.indexOf('AXUIElementPerformAction(element, kAXPressAction');
 const background=perform.indexOf('B2TargetClick.attempt(');
 const foreground=perform.indexOf('session.foreground(');
 assert.ok(ax>=0&&background>ax&&foreground>background);
 assert.match(perform,/catch let failure as B2TargetClick\.Failure\s*\{\s*throw B2TargetClick\.controlFailure\(failure\)/);
 assert.match(perform,/if let receipt \{\s*return try B2TargetClick\.postedReceipt\(receipt\)/);
 assert.match(perform,/try checkSystemPassword\(target, element: entry\?\.element\)/);
 assert.match(native,/inputAllowedForBundle/);
 assert.match(b2,/windowCount == 1/);
 assert.match(b2,/focusedWindowID == id && responderWindowID == id && responderRoleKnown/);
 assert.match(b2,/throw Failure\(cause: error, receipt: receipt\)/);
 assert.match(b2,/guard receipt\.focusRecords == 2, receipt\.targetChannels == 10 else/);
 assert.doesNotMatch(b2,/AXManualAccessibility|AXEnhancedUserInterface|AXUIElementSetAttributeValue|\.activate\(/);
});

test('1044 native runBatch checks normal posted branch and remains non-replayable',()=>{
 const native=source('native/ComputerControl.swift');
 const batch=native.slice(native.indexOf('@MainActor static func runBatch('),native.indexOf('    static func changes('));
 assert.match(batch,/status":"posted_unconfirmed"/);
 assert.match(batch,/stopReason = "posted_unconfirmed"/);
 assert.match(batch,/status":"not_attempted"/);
 assert.match(batch,/failure == nil && stopReason == nil/);
 assert.match(batch,/output\["next_action"\] = "computer_screenshot"/);
 assert.match(batch,/throw ControlFailure\("COMPUTER_ACTION_UNCONFIRMED"/);
 assert.match(batch,/output\["do_not_replay"\] = true/);
});
