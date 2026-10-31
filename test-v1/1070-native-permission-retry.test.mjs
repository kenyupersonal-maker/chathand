import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {nativePermissionRequests} from './1070-native-permission-retry-fixture.mjs';

test('only explicit native permission recovery requests the denied-latch retry; normal manual preparation retains its ordinary request',
 {skip:process.platform!=='darwin',timeout:150000},()=>{
 const [recovery,ordinary]=nativePermissionRequests();
 assert.deepEqual(recovery,{route:'/api/browser/extension/prepare',body:{retry_after_permission:true}});
 assert.deepEqual(ordinary,{route:'/api/browser/extension/prepare',body:{}});
 const main=fs.readFileSync('native/main.swift','utf8');
 assert.equal((main.match(/"retry_after_permission"/g)||[]).length,1,'retry marker has only the user recovery entry');
 const entry=main.slice(main.indexOf('        case "openChromeDataAccessSettings":'),main.indexOf('        case "extensionCancel":'));
 assert.match(entry,/guard ownsService,interfaceKeyShared,!shuttingDown/);
 assert.ok(entry.indexOf('permission["observe_allowed"] as? Bool == true')<entry.indexOf('"retry_after_permission"'));
 });
