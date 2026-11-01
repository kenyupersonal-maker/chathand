import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('1084 exit owner records reject malformed inputs, recover free stale records, wait through partial writes and recognize zombies',{skip:process.platform!=='darwin',timeout:120000},t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1084-owner-records-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const app=path.join(root,'OwnerRecords1084.app'),binary=path.join(app,'Contents/MacOS/OwnerRecords1084');fs.mkdirSync(path.dirname(binary),{recursive:true});
 fs.writeFileSync(path.join(app,'Contents/Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.chathand.ownerrecords1084</string><key>CFBundleExecutable</key><string>OwnerRecords1084</string><key>CFBundleVersion</key><string>1084</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
 const swift=path.join(root,'OwnerRecordsChecks.swift');fs.writeFileSync(swift,String.raw`
import AppKit
import Foundation
import Darwin
private func check(_ value:Bool,_ label:String){if !value{fputs("FAIL: \(label)\n",stderr);exit(1)}}
@main struct Checks {
 static func main() throws {
  let a=CommandLine.arguments,root=URL(fileURLWithPath:a[1]),state=root.appendingPathComponent("data"),source=Bundle.main.bundleURL,scope=InstanceLifecycle.Scope(root:root.path)
  try FileManager.default.createDirectory(at:state,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
  let lock=state.appendingPathComponent("native-instance.lock")
  func write(_ data:Data){try! data.write(to:lock);try! FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:lock.path)}
  func value(_ pid:Any,_ seconds:Any,_ micros:Any,_ flag:Any?=nil)->Data {var v:[String:Any]=["pid":pid,"seconds":seconds,"micros":micros];if let flag{v["quitting"]=flag};return try! JSONSerialization.data(withJSONObject:v)}
  if a.count>2 && a[2]=="partial" {
   let lease=try InstanceLifecycle.acquire(state:state)!;let own=try InstanceLifecycle.identity(getpid())!
   _=ftruncate(lease.descriptor,0);try Data().write(to:root.appendingPathComponent("partial-ready"))
   usleep(150_000);let bytes=value(Int(own.pid),own.seconds,own.micros,true)
   _=bytes.withUnsafeBytes{Darwin.write(lease.descriptor,$0.baseAddress!,$0.count)}
   usleep(180_000);withExtendedLifetime(lease){};return
  }
  for bad in [value(0,1,0),value(UInt64.max,1,0),value(true,1,0),value(123,-1,0),value(123,true,0),value(123,1,1_000_000),Data("{".utf8),Data()] {write(bad);check(InstanceLifecycle.readOwner(state:state)==nil,"malformed or partial record rejected")}
  write(value(123,1,0));check(InstanceLifecycle.readOwner(state:state)?.quitting==false,"legacy fields remain compatible")
  write(value(123,1,0,1));check(InstanceLifecycle.readOwner(state:state)?.quitting==false,"numeric flag cannot impersonate a boolean")
  write(value(123,1,0,true));check(InstanceLifecycle.readOwner(state:state)?.quitting==true,"boolean quitting flag accepted")
  let sleeper=Process();sleeper.executableURL=URL(fileURLWithPath:"/bin/sleep");sleeper.arguments=["5"];try sleeper.run()
  let identity=try InstanceLifecycle.identity(sleeper.processIdentifier)!
  write(value(Int(identity.pid),identity.seconds+1,identity.micros,true))
  var diagnostics=[String]()
  var stale=try InstanceLifecycle.claim(state:state,source:source,build:1084,scope:scope,activateExisting:false,diagnostic:{_,code,_ in diagnostics.append(code)})
  check(stale != nil && diagnostics.contains("INSTANCE_STALE_QUIT_RECORD"),"free lock with reused PID start time recovers safely")
  stale=nil;sleeper.terminate();sleeper.waitUntilExit()
  try? FileManager.default.removeItem(at:lock)
  let partial=Process();partial.executableURL=Bundle.main.executableURL;partial.arguments=[root.path,"partial"];try partial.run()
  let ready=root.appendingPathComponent("partial-ready"),readyUntil=Date().addingTimeInterval(2)
  while !FileManager.default.fileExists(atPath:ready.path) && Date()<readyUntil{usleep(5_000)}
  check(FileManager.default.fileExists(atPath:ready.path),"partial writer starts")
  let began=ProcessInfo.processInfo.systemUptime
  var waited=try InstanceLifecycle.claim(state:state,source:source,build:1084,scope:scope,activateExisting:false,diagnostic:{_,code,_ in diagnostics.append(code)})
  check(waited != nil && ProcessInfo.processInfo.systemUptime-began>=0.2,"empty in-progress record never wakes a disappearing owner")
  partial.waitUntilExit();waited=nil
  var zombie:Int32=0
  let program=strdup("/bin/sleep"),duration=strdup("0.1")
  var arguments:[UnsafeMutablePointer<CChar>?]=[program,duration,nil]
  let spawned=posix_spawn(&zombie,"/bin/sleep",nil,nil,&arguments,environ)
  free(program);free(duration)
  check(spawned==0 && zombie>1,"zombie fixture posix_spawn succeeds")
  let before=try InstanceLifecycle.identity(zombie)!
  usleep(170_000)
  let owner=InstanceLifecycle.OwnerRecord(pid:zombie,seconds:before.seconds,micros:before.micros,quitting:true)
  check(try InstanceLifecycle.waitForQuittingOwner(owner,timeout:0.05)==false,"unreaped zombie remains alive with its exact kernel identity")
  let runtime=state.appendingPathComponent("runtime.json")
  try JSONSerialization.data(withJSONObject:["pid":Int(zombie)]).write(to:runtime)
  try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:runtime.path)
  var failedClosed=false
  do {_ = try InstanceLifecycle.captureBackend(state:state,source:source,scope:scope)}catch let error as InstanceLifecycle.Failure {failedClosed=error.code=="INSTANCE_PID_UNKNOWN"}
  check(failedClosed,"ordinary unknown-live backend identity still fails closed")
  let reaped=DispatchSemaphore(value:0)
  DispatchQueue.global().asyncAfter(deadline:.now()+0.1){var status:Int32=0;_=waitpid(zombie,&status,0);reaped.signal()}
  let closedBackend=try InstanceLifecycle.captureBackend(state:state,source:source,scope:scope,exitingOwnerObserved:true)
  check(closedBackend==nil && reaped.wait(timeout:.now()+1) == .success,"confirmed quit handoff tolerates stale runtime until the zombie backend is reaped")
  check(try InstanceLifecycle.waitForQuittingOwner(owner,timeout:0.05),"reaped process is confirmed gone")
  try FileManager.default.removeItem(at:runtime)
  let gate=root.appendingPathComponent(".native-startup")
  let worker=DispatchQueue(label:"fixture-owned-worker"),done=DispatchSemaphore(value:0)
  var held:InstanceLifecycle.Lease?
  worker.async{held=try! InstanceLifecycle.claim(state:gate,source:source,build:1084,scope:scope,activateExisting:false,diagnostic:{_,_,_ in});done.signal()}
  check(done.wait(timeout:.now()+3) == .success,"worker obtains startup gate before main handoff")
  let dataLease=try InstanceLifecycle.claim(state:state,source:source,build:1084,scope:scope,activateExisting:false,diagnostic:{_,_,_ in})
  check(try InstanceLifecycle.markOwnedLeasesQuitting()==2,"both live leases are marked, including worker-owned startup gate")
  check(InstanceLifecycle.readOwner(state:gate)?.quitting==true && InstanceLifecycle.readOwner(state:state)?.quitting==true,"both identity records retain quitting")
  check(try InstanceLifecycle.markOwnedLeasesQuitting()==0,"marking is idempotent")
  withExtendedLifetime((held,dataLease)){}
  print("PASS: malformed, legacy, stale PID, partial write, zombie, worker lease, two-lock quit records")
 }
}
`);
 const cache=process.env.CHATHAND_TEST_SWIFT_CACHE||path.join(root,'cache');fs.mkdirSync(cache,{recursive:true});
 const compile=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','-module-cache-path',cache,'-framework','Cocoa','native/InstanceLifecycle.swift',swift,'-o',binary],{encoding:'utf8',timeout:90000});assert.equal(compile.status,0,compile.stderr);
 const sign=spawnSync('/usr/bin/codesign',['--force','--sign','-',app],{encoding:'utf8'});assert.equal(sign.status,0,sign.stderr);
 const result=spawnSync(binary,[root],{encoding:'utf8',timeout:12000});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PASS: malformed, legacy, stale PID, partial write, zombie/);
});
