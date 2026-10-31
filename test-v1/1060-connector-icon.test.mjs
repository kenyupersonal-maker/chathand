import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {connectorIcon} from '../skills/chathand-setup/scripts/connector-icon.mjs';

test('canonical and plugin skills resolve the same bundled PNG, without runtime discovery',()=>{
 const a=connectorIcon(),b=connectorIcon(new URL('../plugins/chathand/skills/chathand-setup/scripts/connector-icon.mjs',import.meta.url));
 assert.notEqual(a.path,b.path);assert.equal(a.sha256,b.sha256);assert.equal(a.sha256,'309ccfc331bcc7b26ac249407199e71a53de8829bb2d0e4e5f2734a57ff1bc7d');assert.equal(a.width,256);assert.equal(a.height,256);assert.equal(a.mime_type,'image/png');
 const source=fs.readFileSync(new URL('../skills/chathand-setup/scripts/connector-icon.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/locateRuntime|Application Support|Keychain|execFile|fetch\(/);
});
test('missing or invalid public assets do not invent an icon path',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-connector-icon-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const url=pathToFileURL(path.join(root,'skills/chathand-setup/scripts/connector-icon.mjs'));
 assert.throws(()=>connectorIcon(url),/CONNECTOR_ICON_MISSING/);
 const assets=path.join(root,'skills/chathand-setup/assets');fs.mkdirSync(assets,{recursive:true});fs.writeFileSync(path.join(assets,'ChatHand-plugin-icon.png'),'not a PNG');
 assert.throws(()=>connectorIcon(url),/CONNECTOR_ICON_INVALID/);
});
