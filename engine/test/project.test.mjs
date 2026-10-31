import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {FileStore} from '../src/core.mjs';import {CommandQueue,findExecutable} from '../src/commands.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('real npm build and git workflow in disposable project',async t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'ken-project-'));const root=path.join(base,'project');fs.mkdirSync(root);
 const q=new CommandQueue(new FileStore(root,path.join(base,'state')));t.after(async()=>{await q.close();fs.rmSync(base,{recursive:true,force:true});});
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'ken-offline-build-fixture',version:'1.0.0',private:true,scripts:{build:'node build.cjs',test:'node test.cjs'}}));
 fs.writeFileSync(path.join(root,'build.cjs'),'const fs=require("fs");fs.mkdirSync("dist",{recursive:true});fs.writeFileSync("dist/index.html","<!doctype html><title>Build test</title><h1>Ken build works</h1>");console.log("BUILD_DONE");');
 fs.writeFileSync(path.join(root,'test.cjs'),'require("assert").ok(require("fs").readFileSync("dist/index.html","utf8").includes("Ken build works"));console.log("PROJECT_TEST_DONE");');
 async function run(program,args,id){const j=q.propose({program,args,request_id:id});q.approve(j.job_id);const r=await q.result(j.job_id,10000);assert.equal(r.status,'completed',r.stderr);assert.equal(r.exit_code,0);return r;}
 await t.test('npm run build creates actual HTML artifact',async()=>{const r=await run(findExecutable('npm'),['run','build'],'npm_build_test01');assert.ok(r.stdout.includes('BUILD_DONE'));assert.ok(fs.existsSync(path.join(root,'dist/index.html')));});
 await t.test('npm test validates built file',async()=>{const r=await run(findExecutable('npm'),['test'],'npm_tests_test01');assert.ok(r.stdout.includes('PROJECT_TEST_DONE'));});
 await t.test('git init, status and diff work without network or commits',async()=>{
  await run(findExecutable('git'),['-c','init.defaultBranch=main','init'],'git_init_test01');
  const r=await run(findExecutable('git'),['status','--porcelain'],'git_status_test01');assert.ok(r.stdout.includes('package.json'));
  await run(findExecutable('git'),['diff','--no-ext-diff'],'git_diff_test01');
 });
});
