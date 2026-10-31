import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const source=fs.readFileSync(path.join(root,'native/ChromeHelperInstall.swift'),'utf8');
function method(from,to){const a=source.indexOf(from),b=source.indexOf(to,a);assert.ok(a>0&&b>a,from);return source.slice(a,b);}
function compile(content,pure=false){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1079-context-')));
 for(const n of ['home','tmp','cache'])fs.mkdirSync(path.join(dir,n));
 const cache=process.env.CHATHAND_TEST_SWIFT_CACHE||path.join(dir,'cache');fs.mkdirSync(cache,{recursive:true});
 const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:path.join(dir,'home'),TMPDIR:path.join(dir,'tmp'),CLANG_MODULE_CACHE_PATH:cache};
 const file=path.join(dir,'Checks.swift'),bin=path.join(dir,'checks');fs.writeFileSync(file,content);
 const args=['swiftc','-swift-version','5','-parse-as-library','-module-cache-path',cache];
 if(pure)args.push('-DCHATHAND_INSTALL_PURE_TEST','native/LocalText.swift','native/ChromeHelperInstall.swift');
 const build=spawnSync('/usr/bin/xcrun',[...args,file,'-o',bin],{cwd:root,env,encoding:'utf8',timeout:150000});assert.equal(build.status,0,build.stderr);
 const run=spawnSync(bin,[dir],{cwd:dir,env,encoding:'utf8',timeout:15000});assert.equal(run.status,0,run.stderr);console.log(run.stdout.trim());return run.stdout;
}
test('1079 actual discovery proof and finite identity inventory classify empty windows without private metadata',{skip:process.platform!=='darwin',timeout:180000},()=>{
 let boundary=fs.readFileSync(path.join(root,'tests/v1/1076-chrome-sheet-attribute-checks.swift'),'utf8').split('@main struct Checks')[0]
 .replace('/* PRODUCTION_DIAGNOSTIC_TYPES */',method('enum ChromeInstallDetailCode:','/// Chrome exposes version fields'))
 .replace('/* PRODUCTION_DIAGNOSTIC_READERS */',method('    private func installFailure(','    private func windowInventory('))
 .replace('/* PRODUCTION_SHEET_ELEMENTS */',method('    private func sheetElements(','    private func sheets()'))
 .replace('/* PRODUCTION_SHEETS */',method('    private func sheets()','    private func picker()'))
 .replace('/* PRODUCTION_INVENTORY */',method('    private func windowInventory(','    private func captureTarget('))
 .replace('/* PRODUCTION_VISIBLE */',method('    private func extensionsPageVisible()','    private func attr('))
 .replace('    var number:','    var value: String?\n    var number:')
 .replace('case sheet = "CHROME_INSTALL_SHEET_UNKNOWN"','case accessibility = "CHROME_INSTALL_ACCESSIBILITY_REQUIRED", chromeMissing = "CHROME_INSTALL_CHROME_UNAVAILABLE", controls = "CHROME_INSTALL_CONTROLS_UNKNOWN", profile = "CHROME_INSTALL_PROFILE_UNKNOWN", otherProfile = "CHROME_INSTALL_OTHER_PROFILE", sheet = "CHROME_INSTALL_SHEET_UNKNOWN"')
 .replace('    var runningApplications =','    func urlForApplication(withBundleIdentifier: String) -> URL? { URL(fileURLWithPath:"/fixture/Chrome.app") }\n    var runningApplications =')
 .replaceAll('ProcessInfo','DiagnosticClock');
 const version=fs.readFileSync(path.join(root,'tests/v1/chrome-version-page-checks.swift'),'utf8');
 let decoder=version.slice(version.indexOf('struct FixtureHome'),version.indexOf('final class PreparationSchedule'))
 .replace('    init(_ window: AXUIElement)', '    init(runtime: URL) {}\n    init(_ window: AXUIElement)')
 .replace('name == "AXChildren" ? node.children : nil','["AXChildren","AXWindows"].contains(name) ? node.children : nil')
 .replace('/* PRODUCTION_NODES */',method('    private func nodes(','    private func unique('))
 .replace('/* PRODUCTION_ADDRESS */',method('    private func isAddress(','    private func address()'))
 .replace('/* PRODUCTION_VERSION */',method('    static func observedProfiles(','    private func versionEvidence(').replaceAll('ChromeInstallAXAdapter','Decoder').replaceAll('Bundle(','FixtureBundle(')+method('    private func versionEvidence(','    func observe('))
 .replaceAll('ProcessInfo','DiagnosticClock');
 const types=method('enum ChromeVersionPageEvidence {','/// A blocked/queued AX reader')+'\nenum ChromeInstallObservation { case version(profile: String, major: Int) }\n';
 const support='\nstruct FixtureBundle { let bundleIdentifier: String? = "com.google.Chrome"; init?(url: URL) {} }\nenum DiagnosticClock { static var now: TimeInterval = 100; static var systemUptime: TimeInterval { now }; static var processInfo: DiagnosticClock.Type { Self.self } }\n';
 assert.match(compile(boundary+types+support+decoder+fs.readFileSync(path.join(root,'tests/v1/1079-chrome-window-context-checks.swift'),'utf8')),/PASS: \d+ window attribution checks/);
});
test('1079 typed empty-window context survives controller and acknowledged main, rejecting malformed optional fields',{skip:process.platform!=='darwin',timeout:180000},()=>{
 const main=fs.readFileSync(path.join(root,'native/main.swift'),'utf8'),a=main.indexOf('            func progress(_ event:String'),b=main.indexOf('            func deliver(',a),c=main.indexOf('                // The bridge has already returned started;',b);
 assert.ok(a>0&&b>a&&c>b);
 const support=fs.readFileSync(path.join(root,'tests/v1/1077-chrome-preflight-receipt-checks.swift'),'utf8').split('@main struct Checks')[0]
 .replace('/* PRODUCTION_PROGRESS */',main.slice(a,b)).replace('/* PRODUCTION_DELIVER_ERROR */',main.slice(b,c)+'\n            }');
 const cancel=main.slice(main.indexOf('    private func cancelChromePreparation('),main.indexOf('    private func observeChromeProfiles('));
 const checks=fs.readFileSync(path.join(root,'tests/v1/1079-chrome-window-context-receipt-checks.swift'),'utf8').replace('/* PRODUCTION_CANCEL */',cancel);
 assert.match(compile(support+checks,true),/PASS: \d+ window context receipt checks/);
});
