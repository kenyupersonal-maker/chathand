import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {assets} from '../ui/h10/assets.mjs';
import {renderOfflinePage} from '../ui/h10/offline.mjs';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
test('replacement teaching media and app icon registry describe actual source bytes',()=>{
 for(const key of ['appIcon','gatekeeperDone','gatekeeperConfirm','assisted']){
  const file=new URL('../ui/h10/'+assets[key].src,import.meta.url);
  assert.equal(sha(fs.readFileSync(file)),assets[key].sha256,key);
 }
 const png=fs.readFileSync(new URL('../ui/h10/'+assets.assisted.src,import.meta.url));
 assert.equal(png.readUInt32BE(16),388);assert.equal(png.readUInt32BE(20),168);
});
// 1081 N203（Claude）：旧的私有发布桥退役，releaseBridgeViews 跟着拿掉。原来借它查的「嵌的是现在这套图、不是旧的圆角图标」
// 和「F5 三帧」挪到还在用的离线 F1/F5 页上查（Ken 10/27 定的：退役流程里还有用的保障，挪到现在的流程上测）。
test('offline F1/F5 pages embed current replacements rather than the old rounded icon',()=>{
 const f1=renderOfflinePage({screen:'f1'}),f5=renderOfflinePage({screen:'f5'}),all=f1+f5;
 for(const key of ['appIcon','gatekeeperDone','gatekeeperConfirm','assisted']){
  const bytes=fs.readFileSync(new URL('../ui/h10/'+assets[key].src,import.meta.url));
  assert.ok(all.includes(bytes.toString('base64')),key);
 }
 const pages=/const pages=(.*?);\nconst handoff=/s.exec(f5);
 assert.ok(pages,'F5 frames');assert.equal(JSON.parse(pages[1]).length,3);
});
