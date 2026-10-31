import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {resolveIsolatedUnsignedOptions,assertFreshIsolatedTarget,swiftIsolationArguments,swiftIsolationEnvironment,swiftCompilerCacheArguments} from '../scripts/build-v09-isolation.mjs';

const source='/work/ChatHand';
const task='/work/ChatHand-builds.noindex/OSS-PREP-ISOLATED-BUILD.noindex';
const valid=['--unsigned','--isolated-unsigned','--isolation-root',task,'--tunnel-cache',`${task}/tunnel-cache`,'--output',`${task}/ChatHand.app`];
const parse=(args,sourceRoot=source)=>resolveIsolatedUnsignedOptions(args,{root:sourceRoot,unsigned:args.includes('--unsigned')});

test('isolated unsigned mode resolves all outputs under its fresh task root',()=>{
 const value=parse(valid);
 assert.equal(value.root,task);
 assert.equal(value.app,path.join(task,'ChatHand.app'));
 assert.equal(value.tunnelCache,path.join(task,'tunnel-cache'));
 for(const key of ['reports','bin','swiftpmCache','swiftpmConfig','swiftpmSecurity','swiftpmScratch','swiftModuleCache','clangModuleCache'])assert.equal(path.dirname(value[key]),task);
 assert.deepEqual(swiftIsolationArguments(value),['--cache-path',value.swiftpmCache,'--config-path',value.swiftpmConfig,'--security-path',value.swiftpmSecurity,'--scratch-path',value.swiftpmScratch,'--disable-dependency-cache','--manifest-cache','none','--disable-netrc','--disable-keychain']);
 const env=swiftIsolationEnvironment(value,{HOME:'/user/home',CLANG_MODULE_CACHE_PATH:'/old/cache'});
 assert.equal(env.HOME,'/user/home');
 assert.equal(env.CLANG_MODULE_CACHE_PATH,value.clangModuleCache);
 assert.deepEqual(swiftCompilerCacheArguments(value),['-module-cache-path',value.swiftModuleCache]);
});

test('isolated mode is opt-in and rejects signed, incomplete, duplicate, and unknown inputs',()=>{
 assert.equal(resolveIsolatedUnsignedOptions(['--output','/tmp/ChatHand.app'],{root:source,unsigned:false}),null);
 const rejects=[
  [valid.filter(arg=>arg!=='--unsigned'),'ISOLATED_BUILD_UNSIGNED_REQUIRED'],
  [[...valid,'--isolated-unsigned'],'ISOLATED_BUILD_FLAG_DUPLICATE'],
  [[...valid,'--process-identity-baseline','baseline.json'],'ISOLATED_BUILD_BASELINE_FORBIDDEN'],
  [[...valid,'--self-check'],'ISOLATED_BUILD_ARGUMENT_UNSUPPORTED'],
  [valid.filter((arg,index)=>arg!=='--tunnel-cache'&&!(valid[index-1]==='--tunnel-cache')),'ISOLATED_BUILD_OPTION_REQUIRED'],
 ];
 for(const [args,code] of rejects)assert.throws(()=>parse(args),error=>error.code===code);
 assert.throws(()=>resolveIsolatedUnsignedOptions(['--unsigned','--isolation-root',task],{root:source,unsigned:true}),error=>error.code==='ISOLATED_BUILD_FLAG_REQUIRED');
 assert.throws(()=>resolveIsolatedUnsignedOptions(valid,{root:source,unsigned:false}),error=>error.code==='ISOLATED_BUILD_UNSIGNED_REQUIRED');
 assert.throws(()=>parse(valid.map(arg=>arg===task?'/work/ChatHand/nested':arg)),error=>error.code==='ISOLATED_BUILD_ROOT_NOT_SEPARATE_FROM_SOURCE');
 assert.throws(()=>parse(valid.map(arg=>arg===`${task}/ChatHand.app`?'/tmp/ChatHand.app':arg)),error=>error.code==='ISOLATED_BUILD_OUTPUT_OUTSIDE_TASK_ROOT');
 assert.throws(()=>parse(valid.map(arg=>arg===`${task}/tunnel-cache`?'/tmp/tunnel-cache':arg)),error=>error.code==='ISOLATED_BUILD_TUNNEL_CACHE_OUTSIDE_TASK_ROOT');
 assert.throws(()=>parse(valid.map(arg=>arg===`${task}/ChatHand.app`?'ChatHand.app':arg)),error=>error.code==='ISOLATED_BUILD_PATH_MUST_BE_ABSOLUTE');
 assert.throws(()=>parse(valid.map(arg=>arg===`${task}/tunnel-cache`?`${task}/swiftpm-cache`:arg)),error=>error.code==='ISOLATED_BUILD_PATH_COLLISION');
});

test('fresh-target preflight refuses existing work and symlink parents without creating files',()=>{
 const value=parse(valid);
 const existing=new Set([value.root]);
 const fake={existsSync:item=>existing.has(item)||item===path.dirname(value.root),realpathSync:item=>item,lstatSync:item=>({isDirectory:()=>true,isSymbolicLink:()=>false}),readdirSync:()=>['previous']};
 assert.throws(()=>assertFreshIsolatedTarget(value,{fsApi:fake}),error=>error.code==='ISOLATED_BUILD_ROOT_MUST_BE_EMPTY_DIRECTORY');
 const nonCanonical={...fake,existsSync:item=>item===path.dirname(value.root),realpathSync:item=>`${item}-alias`};
 assert.throws(()=>assertFreshIsolatedTarget(value,{fsApi:nonCanonical}),error=>error.code==='ISOLATED_BUILD_PARENT_MUST_BE_CANONICAL');
 assert.equal(fs.existsSync(value.root),false);
});

test('real source paths reject symlink aliases with overlap in either direction before writes',()=>{
 const aliased=parse(valid,'/work/ChatHand-link');
 const parent=path.dirname(aliased.root);
 const makeFs=realSource=>({existsSync:item=>item===parent,realpathSync:item=>item===aliased.sourceRoot?realSource:item});
 const sourceInsideTask={...makeFs(path.join(aliased.root,'checkout'))};
 assert.throws(()=>assertFreshIsolatedTarget(aliased,{fsApi:sourceInsideTask}),error=>error.code==='ISOLATED_BUILD_ROOT_REALPATH_OVERLAP');
 const taskInsideSource={...makeFs('/work')};
 assert.throws(()=>assertFreshIsolatedTarget(aliased,{fsApi:taskInsideSource}),error=>error.code==='ISOLATED_BUILD_ROOT_REALPATH_OVERLAP');
 assert.equal(fs.existsSync(aliased.root),false);
});

test('isolated builder retains its original gates and skips the permission query',()=>{
 const source=fs.readFileSync(new URL('../scripts/build-v09.mjs',import.meta.url),'utf8');
 assert.match(source,/\['--self-check'\]/);
 assert.match(source,/generate-version\.mjs','--check/);
 assert.match(source,/check-contract\.mjs/);
 assert.match(source,/SOURCE_NOT_FROZEN/);
 assert.match(source,/preflightSiteTemplate\(root\)/);
 assert.match(source,/stageProcessCompatibility\(app,\{root,run\}\)/);
 assert.match(source,/commandArgs\[0\]==='swiftc'\?swiftCompilerCacheArguments\(isolated\)/);
 assert.match(source,/isolated\?undefined:JSON\.parse\(run\(path\.join\(contents,'MacOS\/KenBridge'\),\['--computer-status'\]\)\)/);
 assert.match(source,/native_permissions_observed:'NOT_TESTED'/);
});
