import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {protocolIcons} from '../app/v1/protocol-icons.mjs';
import {Tools} from '../app/tools.mjs';

test('MCP2025-11-25 icon uses the compact bundled same-master image without network or local identity',()=>{
 const png=fs.readFileSync(new URL('../plugins/chathand/assets/server-icon-32.png',import.meta.url));
 const icons=protocolIcons('2025-11-25');
 assert.equal(icons.length,1);
 for(const icon of icons){
  assert.equal(icon.mimeType,'image/png');assert.deepEqual(icon.sizes,['32x32']);
  assert.match(icon.src,/^data:image\/png;base64,/);
  assert.deepEqual(Buffer.from(icon.src.split(',')[1],'base64'),png);
  assert.ok(JSON.stringify(icon).length<1500,'repeated protocol metadata must preserve the existing page budget');
 }
 const copy=protocolIcons('2026-07-28');copy[0].sizes.push('1x1');
 assert.deepEqual(protocolIcons('2025-11-25')[0].sizes,['32x32']);
});
test('pre-icon protocol versions do not gain unsupported server icon fields',()=>{
 for(const version of [undefined,null,'2024-11-05','2025-03-26','2025-06-18'])assert.deepEqual(protocolIcons(version),[]);
});
test('actual initialize and transparent Site metadata advertise the bundled icon, old protocol stays unchanged',async()=>{
 const tools=Object.create(Tools.prototype);
 const rpc=(method,params,context={})=>tools.rpcInternal({jsonrpc:'2.0',id:1,method,params},'fixture',context);
 const current=await rpc('initialize',{protocolVersion:'2025-11-25'});
 assert.deepEqual(current.result.serverInfo.icons,protocolIcons('2025-11-25'));
 const old=await rpc('initialize',{protocolVersion:'2025-06-18'});assert.equal(old.result.serverInfo.icons,undefined);
 const params={_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}};
 const site=await rpc('ping',params,{transport:'site_b'});
 assert.equal(site.result._meta['io.modelcontextprotocol/serverInfo'].icons,undefined);
 const siteInit=await rpc('initialize',{protocolVersion:'2025-11-25'},{transport:'site_b'});assert.deepEqual(siteInit.result.serverInfo.icons,current.result.serverInfo.icons);
 const a=await rpc('ping',params);assert.equal(a.result._meta['io.modelcontextprotocol/serverInfo'].icons,undefined);
});
