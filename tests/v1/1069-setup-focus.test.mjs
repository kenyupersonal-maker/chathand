import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
test('1069 native focus consumes only a new verified completion and seeds historical startup watermarks',{skip:process.platform!=='darwin',timeout:120000},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1069-focus-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const source=path.join(root,'main.swift'),binary=path.join(root,'focus');
 fs.writeFileSync(source,`import Foundation
@main struct Checks { static func main() {
 let now=2_000_000.0;var focus=SetupCompletionFocus(startedAtMS:now)
 func check(_ value:Bool) {if !value {exit(1)}}
 check(!focus.consume(["active":false,"last_at":now-1_000,"finished_at":now-500],nowMS:now))
 check(!focus.consume(["active":false,"last_at":now-1_000,"finished_at":now-500],nowMS:now+1))
 check(!focus.consume(["active":true,"last_at":now+1,"finished_at":now-500],nowMS:now+2))
 check(focus.consume(["active":false,"last_at":now+1,"finished_at":now+3],nowMS:now+4))
 check(!focus.consume(["active":false,"last_at":now+1,"finished_at":now+3],nowMS:now+5))
 check(!focus.consume(["active":true,"last_at":now+10,"finished_at":now+11],nowMS:now+12))
 check(!focus.consume(["active":false,"last_at":now+10,"finished_at":now+11],nowMS:now+13))
 var first=SetupCompletionFocus(startedAtMS:now);check(first.consume(["active":false,"last_at":now+1,"finished_at":now+2],nowMS:now+3));check(!first.consume(["active":false,"last_at":now+1,"finished_at":now+2],nowMS:now+4))
 var fresh=SetupCompletionFocus(startedAtMS:now);check(!fresh.consume(nil,nowMS:now));check(!fresh.consume(["active":false,"last_at":1,"finished_at":2],nowMS:now))
 print("PASS")
}}`);
 const result=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','-module-cache-path',path.join(root,'cache'),'-framework','Cocoa','-framework','WebKit','native/ClientFeatures.swift','native/WindowChrome.swift',source,'-o',binary],{encoding:'utf8',timeout:90000});assert.equal(result.status,0,result.stderr);const ran=spawnSync(binary,[],{encoding:'utf8',timeout:5000});assert.equal(ran.status,0,ran.stderr);assert.match(ran.stdout,/PASS/);
});
test('1069 native completion observer is part of poll and does not modify ordinary automatic window presentation',()=>{const source=fs.readFileSync(new URL('../../native/main.swift',import.meta.url),'utf8');assert.match(source,/setupCompletionFocus.consume\(obj\["setup_activity"\]/);const automatic=source.slice(source.indexOf('func showAutomatically()'),source.indexOf('func windowShouldClose'));assert.doesNotMatch(automatic,/NSApp.activate/);});
