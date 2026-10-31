import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {DiagnosticEvents,readOnboardingEvents} from '../app/diagnostic-events.mjs';
import {OnboardingTelemetry,onboardingFields} from '../app/onboarding-telemetry.mjs';
import {diagnostic,exportDiagnostic} from '../app/v1/support.mjs';
import {run} from '../skills/chathand-setup/scripts/setup.mjs';
import {fixture} from '../test/helpers.mjs';
import {desktop} from './1052-a-fixture.mjs';
const temp=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'ch1060-onboarding-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};
const valid={step:'setup_skill',phase:'end',result:'failed',error_code:'LOCAL_FAILED',actor:'unknown',wait_ms:12,source:'server',span:'o_'+'a'.repeat(24)};
test('strict metadata rejects arbitrary fields, actor, error strings and impossible start spans',t=>{
 const d=temp(t),events=new DiagnosticEvents(d);
 for(const patch of [{title:'PRIVATE'},{path:'/PRIVATE'},{url:'https://PRIVATE'},{body:'PRIVATE'},{receipt:{secret:'PRIVATE'}},{actor:'AI probably'},{error_code:'SECRETKEY'},{step:'PRIVATE'},{wait_ms:-1},{phase:'start',result:'ok'},{span:'PRIVATE'}])assert.equal(events.record('onboarding.step',{...valid,...patch}),false);
 assert.equal(events.record('onboarding.step',valid),true);
 assert.deepEqual(readOnboardingEvents(d).events.map(({at,kind,...row})=>row),[valid]);
 assert.equal(onboardingFields({...valid,error_code:'PRIVATE_SECRET'}),null);
});
test('real writer measures success/failure, closes once and preserves original error',async t=>{
 const d=temp(t);let time=1000;const events=new DiagnosticEvents(d,{now:()=>time}),observer=new OnboardingTelemetry(events,{now:()=>time});
 const end=observer.begin('site_deploy');time+=20;end('unobservable','UNOBSERVABLE');end('ok','NONE');
 const error=Object.assign(Error('PRIVATE_EXCEPTION'),{code:'PRIVATE_SECRET'});
 await assert.rejects(observer.run('setup_connect',async()=>{time+=42;throw error;}),e=>e===error);
 const rows=readOnboardingEvents(d).events;assert.equal(rows.length,4);assert.equal(rows[1].result,'unobservable');assert.equal(rows[1].wait_ms,20);assert.equal(rows[3].wait_ms,42);assert.equal(rows[3].error_code,'UNKNOWN');assert.ok(rows.every(r=>r.actor==='unknown'));
 assert.ok(!fs.readFileSync(path.join(d,'diagnostics/events.jsonl'),'utf8').includes('PRIVATE'));
});
test('rotated diagnostics export survives restart, rebuilds schema and stays bounded',t=>{
 const d=temp(t),writer=new DiagnosticEvents(d,{maxBytes:800,retain:5});for(let i=0;i<15;i++){const end=new OnboardingTelemetry(writer).begin('setup_skill');end();}
 const file=path.join(d,'diagnostics/events.jsonl');fs.appendFileSync(file,JSON.stringify({...valid,kind:'onboarding.step',at:'2026-10-18T00:00:00.000Z',title:'PRIVATE_TITLE',url:'https://PRIVATE',receipt:'PRIVATE_RECEIPT'})+'\n');
 const exported=readOnboardingEvents(d,{limit:5});assert.ok(exported.events.length<=5);assert.equal(exported.truncated,true);
 const output=diagnostic({},[],exported);assert.ok(!JSON.stringify(output).includes('PRIVATE'));assert.ok(output.onboarding.events.length>0);
 const actual=exportDiagnostic({},[],{downloads:path.join(d,'exports'),onboarding:exported});assert.deepEqual(JSON.parse(fs.readFileSync(actual.file)).onboarding.events,output.onboarding.events);
 assert.equal(readOnboardingEvents(d,{limit:0}).events.length,0);
 const outside=path.join(d,'outside');fs.writeFileSync(outside,JSON.stringify(valid));fs.unlinkSync(file);fs.symlinkSync(outside,file);assert.ok(readOnboardingEvents(d).unreadable>=1);
});
test('unified setup doctor/connect preserve result and report real invocation, no actor guess',async t=>{
 const d=temp(t),observer=new OnboardingTelemetry(new DiagnosticEvents(d)),runtime={fixture:true};
 const status={version:'fixture',connection:{ready:true,healthy:true},site_b:{selected:'openai'}};
 const doctor=await run(['doctor'],{locate:()=>runtime,call:async()=>status,telemetry:observer});assert.equal(doctor.connected,true);
 const connected=await run(['connect'],{locate:()=>runtime,call:async()=>status,telemetry:observer});assert.equal(connected.preserved_existing_connection,true);
 const rows=readOnboardingEvents(d).events;assert.deepEqual(rows.map(r=>r.step),['setup_doctor','setup_doctor','setup_connect','setup_connect']);assert.ok(rows.every(r=>r.actor==='unknown'&&r.source==='setup_skill'));
});
test('actual first RPC gets one local observation per process; invalid tool errors remain errors',async t=>{
 const f=fixture(t),rpc=()=>f.tools.rpc({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'PRIVATE_BAD_TOOL',arguments:{secret:'PRIVATE_SECRET'}}},'chatgpt');
 const first=await rpc();assert.ok(first.error||first.result?.isError);await rpc();
 const rows=readOnboardingEvents(f.stateDir).events.filter(r=>r.step==='first_tool_call');assert.equal(rows.length,2);assert.equal(rows[1].result,'failed');assert.equal(rows[1].actor,'unknown');assert.ok(!JSON.stringify(rows).includes('PRIVATE'));
});
test('real isolated owner endpoint rejects missing native key and unsafe metadata; support export contains steps',async t=>{
 const f=await desktop(t),a=f.app,origin='http://127.0.0.1:'+a.apiPort;
 const send=(body,key)=>fetch(origin+'/api/onboarding/event',{method:'POST',headers:{Authorization:'Bearer '+a.adminToken,'Content-Type':'application/json',...(key?{'X-ChatHand-UI':key}:{})},body:JSON.stringify(body)});
 const safe={...valid,step:'setup_conversation',source:'native',observed_at:'2026-10-18T00:00:00.000Z'};
 assert.equal((await send(safe)).status,403);assert.equal((await send({...safe,actor:'ai'},a.uiKey)).status,400);assert.equal((await send({...safe,observed_at:undefined},a.uiKey)).status,400);assert.equal((await send({...safe,title:'PRIVATE'},a.uiKey)).status,400);assert.equal((await send(safe,a.uiKey)).status,200);
 const installed=await a.handle('/api/setup/skill');assert.equal(installed.installed,true);
 const rows=readOnboardingEvents(path.join(f.root,'state')).events;assert.ok(rows.some(r=>r.step==='setup_skill'&&r.phase==='start'));assert.ok(rows.some(r=>r.step==='setup_skill'&&r.phase==='end'));assert.ok(rows.some(r=>r.step==='setup_conversation'&&r.observed_at===safe.observed_at));
 const exported=await a.handle('/api/diagnostics/export');assert.deepEqual(exported.onboarding.events,rows);
 const support=await a.handle('/api/support/export');assert.ok(support.file.startsWith(path.join(fs.realpathSync(f.root),'state/integration-home/Downloads')));const saved=JSON.parse(fs.readFileSync(support.file));assert.deepEqual(saved.onboarding.events,rows);assert.ok(!JSON.stringify(saved).includes('PRIVATE'));
});

test('known product codes and timeout are retained; unknown messages and writer failures cannot alter behavior',async t=>{
 const d=temp(t),observer=new OnboardingTelemetry(new DiagnosticEvents(d));
 for(const error of [Object.assign(Error('PRIVATE'),{code:'B_PAIRING_SIGNATURE'}),Error('SETTING_NOT_RETAINED_BROWSER'),Object.assign(Error('PRIVATE_URL'),{code:'B_SITE_REQUEST_TIMEOUT'}),Object.assign(Error('https://PRIVATE'),{code:'PRIVATE_SECRET'})])await assert.rejects(observer.run('site_pair',async()=>{throw error;}),actual=>actual===error);
 const ends=readOnboardingEvents(d).events.filter(r=>r.phase==='end');assert.deepEqual(ends.map(r=>r.error_code),['B_PAIRING_SIGNATURE','SETTING_NOT_RETAINED_BROWSER','B_SITE_REQUEST_TIMEOUT','UNKNOWN']);assert.equal(ends[2].result,'timeout');assert.ok(!JSON.stringify(ends).includes('PRIVATE'));
 const broken=new OnboardingTelemetry({record(){throw Error('PRIVATE_WRITER_ERROR');}}),value={receipt:'PRIVATE'};
 assert.equal(await broken.run('setup_skill',async()=>value),value);
 const original=Error('ORIGINAL');await assert.rejects(broken.run('setup_skill',async()=>{throw original;}),e=>e===original);
});

test('delayed native flush preserves strict original start/end timestamps separately from server receipt time',t=>{
 const d=temp(t),received=Date.parse('2026-10-18T00:02:00.000Z'),writer=new DiagnosticEvents(d,{now:()=>received});
 const start={...valid,step:'permission_accessibility',source:'native',phase:'start',result:'pending',error_code:'NONE',wait_ms:0,observed_at:'2026-10-18T00:00:00.000Z'};
 const end={...start,phase:'end',result:'ok',wait_ms:45000,observed_at:'2026-10-18T00:00:45.000Z'};
 // Simulates both original native observations queued for two minutes before backend handshake.
 assert.equal(writer.record('onboarding.step',start),true);assert.equal(writer.record('onboarding.step',end),true);
 for(const observed_at of ['2026-02-30T00:00:00.000Z','2026-10-18T00:00:00Z','2026-10-18T00:00:00.000+00:00','2026-10-18T00:00:00.000Z PRIVATE',42])assert.equal(writer.record('onboarding.step',{...end,observed_at}),false);
 const rows=readOnboardingEvents(d).events,exported=diagnostic({},[],{events:rows});
 assert.deepEqual(rows.map(r=>r.at),Array(2).fill('2026-10-18T00:02:00.000Z'));assert.deepEqual(rows.map(r=>r.observed_at),[start.observed_at,end.observed_at]);assert.equal(rows[1].wait_ms,45000);assert.deepEqual(exported.onboarding.events,rows);
});
test('actual extracted native queue waits for owner handshake and retains failed delivery for retry',t=>{
 if(process.platform!=='darwin'){t.skip('macOS Foundation fixture');return;}
 const source=fs.readFileSync(new URL('../native/main.swift',import.meta.url),'utf8');
 const helper=source.slice(source.indexOf('    // Metadata-only owner calls.'),source.indexOf('    var ownsService = false'));
 const attach=source.slice(source.indexOf('    func attach(_ r:'),source.indexOf('    func api('));assert.match(attach,/onboardingFlush\(\)/);
 const recovery=source.slice(source.indexOf('    private func scheduleBackendRecovery'),source.indexOf('    @objc private func uninstallChatHand'));assert.match(recovery,/onboardingSending = false/);
 const program=`import Foundation
final class NativeFixture {
 var interfaceKeyShared=false,origin=""
 var calls:[[String:Any]]=[]
 var replies:[[String:Any]]=[["recorded":false],["error":["code":"LOCAL_NETWORK"]],["recorded":true],["recorded":true]]
 func api(_ endpoint:String,_ body:[String:Any]?=nil,completion:@escaping([String:Any])->Void){precondition(endpoint=="/api/onboarding/event");calls.append(body!);completion(replies.removeFirst())}
${helper}
 func check(){
  let end=onboardingBegin("first_launch_guidance");precondition(calls.isEmpty && onboardingPending.count==1)
  let observed=onboardingPending[0]["observed_at"] as! String
  interfaceKeyShared=true;origin="http://127.0.0.1:12345";onboardingFlush()
  precondition(onboardingPending.count==1 && onboardingDeliveryState=="unconfirmed" && onboardingDeliveryFailures==1)
  onboardingRetryAfter=0;onboardingFlush()
  precondition(onboardingPending.count==1 && onboardingDeliveryFailures==2)
  onboardingRetryAfter=0;onboardingFlush()
  precondition(onboardingPending.isEmpty && onboardingDeliveryState=="recorded")
  precondition(calls.prefix(3).allSatisfy{ $0["observed_at"] as? String==observed })
  end("unknown","HOST_UNCONFIRMED");precondition(calls.count==4 && onboardingPending.isEmpty)
  precondition(calls.last?["phase"] as? String=="end")
  let data=try! JSONSerialization.data(withJSONObject:calls);print(String(data:data,encoding:.utf8)!)
 }
}
NativeFixture().check()
`;
 const file=path.join(temp(t),'NativeTelemetryFixture.swift');fs.writeFileSync(file,program);
 const result=spawnSync('/usr/bin/xcrun',['swift',file],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr);
 const calls=JSON.parse(result.stdout);assert.equal(calls.length,4);assert.ok(calls.every(r=>onboardingFields(r)));assert.ok(calls[3].observed_at>=calls[0].observed_at);
});

test('lost response retry remains in raw evidence but exports one event identity and keeps distinct operations',t=>{
 const d=temp(t);let received=Date.parse('2026-10-18T00:02:00.000Z');const writer=new DiagnosticEvents(d,{now:()=>received});
 const original={...valid,step:'permission_accessibility',source:'native',phase:'end',result:'ok',error_code:'NONE',wait_ms:45000,observed_at:'2026-10-18T00:00:45.000Z'};
 assert.equal(writer.record('onboarding.step',original),true); // Server persisted it; response never arrived.
 received+=5000;assert.equal(writer.record('onboarding.step',original),true); // Same immutable native queue head retries.
 const distinct={...original,span:'o_'+'b'.repeat(24)};assert.equal(writer.record('onboarding.step',distinct),true);
 const raw=fs.readFileSync(path.join(d,'diagnostics/events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(raw.length,3);
 const view=readOnboardingEvents(d).events;assert.equal(view.length,2);assert.equal(view[0].at,'2026-10-18T00:02:00.000Z');assert.equal(view[0].observed_at,original.observed_at);assert.equal(view[1].span,distinct.span);
 const projected=diagnostic({},[],{events:raw});assert.equal(projected.onboarding.events.length,2);assert.deepEqual(projected.onboarding.events,view);
 const exported=exportDiagnostic({},[],{downloads:path.join(d,'exports'),onboarding:{events:raw}});assert.deepEqual(JSON.parse(fs.readFileSync(exported.file)).onboarding.events,view);
});
