import test from 'node:test';
import assert from 'node:assert/strict';
import {projectNativeState} from '../../app/v1/native-state.mjs';

test('1070 native activity projection carries command/route and keeps its bounded shape',()=>{
 const setup_activity={active:true,last_at:123,last_command:'site-start',route:'site',finished_at:null,private_payload:'excluded'};
 assert.deepEqual(projectNativeState({setup_activity}).setup_activity,{active:true,last_at:123,last_command:'site-start',route:'site',finished_at:null});
 assert.deepEqual(projectNativeState({setup_activity:{active:false,last_at:null}}).setup_activity,{active:false,last_at:null});
});
