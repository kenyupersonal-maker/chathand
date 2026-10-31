// Native refusal tests only. No genuine ChatHand bundle, signing or launch.
// Supply the separately compiled helper through CHATHAND_NATIVE_GUARD_HELPER.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {initialize,privateEnvironment} from './rehearse-1060-isolated.mjs';

const helper=process.env.CHATHAND_NATIVE_GUARD_HELPER;
test('compiled native helper refuses unsafe paths, aliases, environment and rehearsal trash', {skip:process.platform!=='darwin'||!helper}, t=>{
  assert.ok(path.isAbsolute(helper));assert.ok(fs.statSync(helper).isFile());
  const config=initialize(path.join(fs.realpathSync('/tmp'),'chathand-1060-rehearsal-nativeguards-'+crypto.randomUUID())),s=config.scenarios.success;
  for(const p of [s.home,s.state,s.evidence])fs.mkdirSync(p,{recursive:true,mode:0o700});
  const env=privateEnvironment(config.root,s);
  const call=(args,extra={})=>{
    const r=spawnSync(helper,args,{env:{...env,...extra},encoding:'utf8',timeout:20000});
    assert.equal(r.signal,null);assert.equal(r.error,undefined);return {exit:r.status,value:JSON.parse(r.stdout)};
  };
  const denied=(args,extra={},code)=>{const r=call(args,extra);assert.notEqual(r.exit,0);if(code)assert.equal(r.value.error,code);else assert.match(r.value.error,/^REHEARSAL_/);return r;};
  denied(['info','/Applications/ChatHand.app']);
  denied(['info',path.join(os.homedir(), 'Library/Application Support/ChatHand/data')]);
  denied(['trash',path.join(config.root,'not-a-formal-backup')],{},'REHEARSAL_TRASH_NOT_ALLOWED');
  const marker=path.join(config.root,'.rehearsal-root.json'),bytes=fs.readFileSync(marker);
  fs.writeFileSync(marker,'{}');denied(['rehearsal-profile',config.root],{},'REHEARSAL_ROOT_MARKER');fs.writeFileSync(marker,bytes);
  fs.chmodSync(config.root,0o755);denied(['rehearsal-profile',config.root],{},'REHEARSAL_ROOT_NOT_PRIVATE');fs.chmodSync(config.root,0o700);
  const alias=path.join(config.root,'alias');fs.symlinkSync(s.home,alias);denied(['info',alias],{},'REHEARSAL_PATH_ALIAS');
  const ordinary=path.join(config.root,'ordinary'),hard=path.join(config.root,'hard');fs.writeFileSync(ordinary,'synthetic');fs.linkSync(ordinary,hard);denied(['info',hard],{},'REHEARSAL_PATH_ALIAS');
  const app=path.join(config.root,'GuardProbe.app'),mac=path.join(app,'Contents/MacOS');fs.mkdirSync(mac,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(app,'Contents/Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>GuardProbe</string><key>CFBundleIdentifier</key><string>invalid.chathand.guardprobe</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  fs.writeFileSync(path.join(mac,'GuardProbe'),'#!/bin/sh\nexit 73\n',{mode:0o700});
  denied(['start',app],{CHATHAND_STATE_DIR:s.home,KEN_BRIDGE_STATE_DIR:s.home},'REHEARSAL_STATE_HOME_OVERLAP');
  denied(['start',app],{KEN_BRIDGE_STATE_DIR:s.home},'REHEARSAL_STATE_MISMATCH');
  denied(['start',app,'--not-authorized'],{},'REHEARSAL_ARGUMENTS_INVALID');
  denied(['start',app],{CHATHAND_REHEARSAL_PAGE_DIR:alias},'REHEARSAL_PATH_ALIAS');
  const profile=call(['rehearsal-profile',config.root],{CHATHAND_REHEARSAL_POLICY:'(allow default)'});
  assert.equal(profile.exit,0);assert.equal(profile.value.isolation_protocol,1);
  for(const expected of ['com.apple.cfprefsd.agent','com.apple.cfprefsd.daemon','com.apple.securityd','com.apple.usernotifications.usernotificationservice','(deny file-write*)','(deny network*)','localhost:*'])assert.ok(profile.value.profile.includes(expected));
  const remaining=call(['info',app]);assert.equal(remaining.value.running,false);
  t.diagnostic('Native refusal fixture retained: '+config.root);
});
