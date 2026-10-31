import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('1079 identity inventory tolerates only explicit unknown empty non-targets; new target binds atomically after strict readiness',{skip:process.platform!=='darwin',timeout:180000},()=>{
 const source=fs.readFileSync(path.join(root,'native/ChromeHelperInstall.swift'),'utf8');
 function part(a,b){const s=source.indexOf(a),e=source.indexOf(b,s);assert.ok(s>0&&e>s,a);return source.slice(s,e);}
 let boundary=fs.readFileSync(path.join(root,'test-v1/1076-chrome-sheet-attribute-checks.swift'),'utf8').split('@main struct Checks')[0]
 .replace('/* PRODUCTION_DIAGNOSTIC_TYPES */',part('enum ChromeInstallDetailCode:','/// Chrome exposes version fields'))
 .replace('/* PRODUCTION_DIAGNOSTIC_READERS */',part('    private func installFailure(','    private func windowInventory('))
 .replace('/* PRODUCTION_SHEET_ELEMENTS */',part('    private func sheetElements(','    private func sheets()'))
 .replace('/* PRODUCTION_SHEETS */',part('    private func sheets()','    private func picker()'))
 .replace('/* PRODUCTION_INVENTORY */',part('    private func windowInventory(','    private func captureTarget('))
 .replace('/* PRODUCTION_VISIBLE */',part('    private func extensionsPageVisible()','    private func attr('))
 .replace('case sheet = "CHROME_INSTALL_SHEET_UNKNOWN"','case focus = "CHROME_INSTALL_FOCUS_UNKNOWN", chromeMissing = "CHROME_INSTALL_CHROME_UNAVAILABLE", timeout = "CHROME_INSTALL_TIMEOUT", sheet = "CHROME_INSTALL_SHEET_UNKNOWN"')
 .replace('    var number:','    var fixtureFrame: CGRect? = CGRect(value:1)\n    var number:')
 .replace('enum B2TargetClick {','enum B2TargetClick {\n    static func windowInfo(pid:Int32,id:UInt32) -> [String:Any]? { fixtureInfoHook?(); return fixtureWindowInfo }')
 .replace('    func sheetCount()',part('    private struct CandidateWindow {','    private var pendingCandidate:').replace('private struct CandidateWindow','struct CandidateWindow')+'\n    var pendingCandidate: CandidateWindow?\n    var baselineIDs=Set<CGWindowID>(), launchRequested=true, launchError=false, interrupted=false\n    var windowID:CGWindowID?, frame:CGRect?\n'+part('    func observationBudget(until deadline: TimeInterval) {\n','    /// Preserve the measured NSWorkspace')+part('    private func captureTarget(','    func bind(_ lease:')+part('    private func identity(foreground:','    func check(_ stage:')+'\n    func poll() throws -> ChromeInstallObservation? { try observeRunningChrome() }\n    func verifyIdentity() throws { try identity(foreground:false) }\n    func bool(_ n:FixtureAX,_ name:String)->Bool? { false }\n    func belongs(_ n:FixtureAX,to:FixtureAX)->Bool { false }\n    func appElement() throws -> FixtureAX { fixtureApp }\n    func sheetCount()')
 .replace('func nodes(_ root: FixtureAX) throws -> [FixtureAX] { [root]', 'func nodes(_ root: FixtureAX) throws -> [FixtureAX] { fixtureContentReads += 1; return [root]')
 .replaceAll('ProcessInfo','PolicyClock');
 const support=`
 typealias CFDictionary=[String:Any]
 struct CGRect:Equatable { let value:Int; init(value:Int){self.value=value};init?(dictionaryRepresentation:[String:Any]){guard let n=dictionaryRepresentation["value"] as? Int else{return nil};value=n} }
 let kCGWindowBounds="bounds",kCGWindowIsOnscreen="onscreen"
 var fixtureContentReads=0
 var fixtureWindowInfo:[String:Any]?=["bounds":["value":1]],fixtureInfoHook:(()->Void)?
 enum ComputerControl {static func elementFrame(_ node:FixtureAX)->CGRect? {node.fixtureFrame}}
 enum ChromeInstallObservation {case runningChrome}
 enum PolicyClock {static var now:TimeInterval=100;static var processInfo:PolicyClock.Type {Self.self};static var systemUptime:TimeInterval{now}}
 `;
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1079-policy-')));for(const n of ['home','tmp','cache'])fs.mkdirSync(path.join(dir,n));
 const cache=process.env.CHATHAND_TEST_SWIFT_CACHE||path.join(dir,'cache');fs.mkdirSync(cache,{recursive:true});
 const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:path.join(dir,'home'),TMPDIR:path.join(dir,'tmp'),CLANG_MODULE_CACHE_PATH:cache};
 const file=path.join(dir,'Checks.swift'),bin=path.join(dir,'checks');fs.writeFileSync(file,boundary+support+fs.readFileSync(path.join(root,'test-v1/1079-chrome-window-policy-checks.swift'),'utf8'));
 const built=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','-module-cache-path',cache,file,'-o',bin],{cwd:dir,env,encoding:'utf8',timeout:150000});assert.equal(built.status,0,built.stderr);
 const run=spawnSync(bin,[],{cwd:dir,env,encoding:'utf8',timeout:15000});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS: \d+ window policy checks/);console.log(run.stdout.trim());
});
