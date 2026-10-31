import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {BrowserDriver} from '../browser-extension/driver.js';

test('Chrome icon sizes and plugin assets come from the unchanged vector master',()=>{
 const base=new URL('../',import.meta.url);
 const manifest=JSON.parse(fs.readFileSync(new URL('browser-extension/manifest.json',base)));
 for(const size of [16,32,48,128]){
  const png=fs.readFileSync(new URL('browser-extension/'+manifest.icons[size],base));
  assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(png.readUInt32BE(16),size);assert.equal(png.readUInt32BE(20),size);
  assert.equal(png[25],6); // RGBA, preserves transparent background.
 }
 const master=fs.readFileSync(new URL('ui/assets/app/mark.svg',base),'utf8');
 const plugin=JSON.parse(fs.readFileSync(new URL('plugins/chathand/.codex-plugin/plugin.json',base)));
 const composer=fs.readFileSync(new URL('plugins/chathand/'+plugin.interface.composerIcon,base),'utf8');
 assert.equal(composer.match(/<path[^>]+>/)[0],master.match(/<path[^>]+>/)[0]);
 assert.equal(composer.match(/viewBox="[^"]+"/)[0],master.match(/viewBox="[^"]+"/)[0]);
 assert.deepEqual(fs.readFileSync(new URL('plugins/chathand/'+plugin.interface.logo,base)),fs.readFileSync(new URL('browser-extension/icons/chathand-128.png',base)));
});

test('existing upload path fills only the fake optional icon file input; no trust/create clicks',async()=>{
 const calls=[];const driver=new BrowserDriver({});
 driver.page=async()=>({id:1,url:'https://example.test/fake-connector'});driver.attach=async()=>{};
 driver.target=async()=>({backend:42,frameId:'fake',attrs:{type:'file'},name:'图标（可选）'});
 driver.sendFrame=async(...args)=>calls.push(args);driver.invalidate=()=>{};
 const result=await driver.execute('upload',{page_id:'1',ref:'fake-icon',paths:['/fake/chathand-128.png']});
 assert.equal(result.performed,'upload');assert.equal(calls.length,1);
 assert.equal(calls[0][2],'DOM.setFileInputFiles');assert.deepEqual(calls[0][3],{backendNodeId:42,files:['/fake/chathand-128.png']});
});
