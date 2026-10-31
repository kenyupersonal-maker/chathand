import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';
const run=(program,args,timeout=90000)=>{const r=spawnSync(program,args,{encoding:'utf8',timeout});assert.equal(r.status,0,r.stderr);return r.stdout;};
test('Keep/Delete uninstall remove only the fixed signed own App backup and preserve other manual-install contents',{skip:process.platform!=='darwin',timeout:150000},t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-manual-app-backup-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const binary=path.join(root,'checks');run('/usr/bin/xcrun',['swiftc','-swift-version','5','-module-cache-path',path.join(root,'cache'),'-parse-as-library','native/ChatHandUninstall.swift','native/tests/ManualAppBackupChecks.swift','-o',binary]);
 const code=path.join(root,'fixture.c'),executable=path.join(root,'owned-executable');fs.writeFileSync(code,'int main(void){return 0;}');run('/usr/bin/xcrun',['clang',code,'-o',executable]);
 const rows=[];
 for(const mode of ['keep','delete'])for(const kind of ['owned','foreign','tampered']){
  const home=path.join(root,mode+'-'+kind),app=path.join(home,'Applications/ChatHand.app'),support=path.join(home,'Library/Application Support/ChatHand'),state=path.join(support,'data'),manual=path.join(support,'manual-install'),backup=path.join(manual,'previous.app');
  fs.mkdirSync(path.join(app,'Contents/MacOS'),{recursive:true});fs.mkdirSync(state,{recursive:true});fs.writeFileSync(path.join(state,'desktop.json'),'{"fixture":true}');
  fs.copyFileSync(executable,path.join(app,'Contents/MacOS/ChatHand'));fs.writeFileSync(path.join(app,'Contents/Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.kenyu.chathand</string><key>CFBundleExecutable</key><string>ChatHand</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  run('/usr/bin/codesign',['--force','--sign','-',app]);fs.mkdirSync(manual,{recursive:true});fs.cpSync(app,backup,{recursive:true,verbatimSymlinks:true});fs.writeFileSync(path.join(manual,'unrelated.txt'),'synthetic foreign manual-install content');
  if(kind==='foreign')fs.writeFileSync(path.join(backup,'Contents/Info.plist'),fs.readFileSync(path.join(backup,'Contents/Info.plist'),'utf8').replace('com.kenyu.chathand','invalid.foreign.product'));
  if(kind==='tampered')fs.appendFileSync(path.join(backup,'Contents/MacOS/ChatHand'),'synthetic signature tamper');
  const before=fs.readFileSync(path.join(manual,'unrelated.txt'));const result=JSON.parse(run(binary,[home,mode],15000));assert.equal(result.complete,true);assert.equal(fs.existsSync(app),false);assert.deepEqual(fs.readFileSync(path.join(manual,'unrelated.txt')),before);assert.equal(fs.existsSync(state),mode==='keep');
  assert.equal(fs.existsSync(backup),kind!=='owned');assert.ok(result.items.some(x=>x.stage==='app_backup'&&x.code===(kind==='owned'?'REMOVED':'FOREIGN_RETAINED')));const removals=result.events.filter(x=>x.code==='REMOVED');assert.equal(removals.at(-1).stage,'app');assert.deepEqual(result.events.at(-1),{stage:'result',code:'COMPLETED'});rows.push({mode,kind,backup_removed:kind==='owned',foreign_manual_content_retained:true,complete:result.complete,terminal_event:result.events.at(-1).code});
 }
 console.log(JSON.stringify(rows,null,2));
});
