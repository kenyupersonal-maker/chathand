import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {nativeFixture} from '../../test-support/native-fixtures.mjs';

test('precompiled exact-process suite covers exit races, PID reuse and refusal to escalate',{skip:process.platform!=='darwin'},()=>{
 const r=spawnSync(nativeFixture('exact_app_process_tests'),[],{encoding:'utf8',timeout:15000});
 assert.equal(r.status,0,r.stderr);
 const result=JSON.parse(r.stdout);
 assert.equal(result.passed,16);
 assert.equal(new Set(result.cases).size,16);
});
