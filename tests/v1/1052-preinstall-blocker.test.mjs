import test from 'node:test';import assert from 'node:assert/strict';import {ResumeKeeper} from '../../app/v1/resume.mjs';
test('preinstall8 latest checkpoint alone determines blocked state, with no choice required',()=>{
 const r=new ResumeKeeper(),t=r.task('synthetic'),blocked={step:'synthetic',error:'synthetic',options:[{label:'skip'},{label:'other'}]};
 t.checkpoints.push({blocked,at:1,block:1,total:2});assert.deepEqual(r.blocker(t),{...blocked,at:1,block:1,total:2});
 t.checkpoints.push({done:'unblocked progress',at:2,block:2,total:2});assert.equal(r.blocker(t),null);
 t.checkpoints.push({blocked,at:3,choice:'skip'});assert.equal(r.blocker(t),null);
});
