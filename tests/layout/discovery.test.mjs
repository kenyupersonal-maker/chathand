import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {canonicalTestPath, discoverNodeTests, readTestLayout, sourceRoot} from '../../scripts/test-layout.mjs';

function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-test-layout-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const put=(file,body='')=>{const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,body);};
 const layout={schema_version:1,root_aliases:{'test-v1':'tests/v1'},node_suites:[
  {id:'core',path:'tests/core'},
  {id:'studio',path:'tools/studio/test',optional_distribution_root:'tools/studio'}
 ],separate_ui_suite:'tests/ui'};
 put('tests/layout.json',JSON.stringify(layout));put('tests/core/example.test.mjs');
 return {root,put,layout};
}

test('required source suites fail closed when a directory or all test files disappear',t=>{
 const f=fixture(t);
 assert.deepEqual(discoverNodeTests(f.root).files,['tests/core/example.test.mjs']);
 fs.unlinkSync(path.join(f.root,'tests/core/example.test.mjs'));
 assert.throws(()=>discoverNodeTests(f.root),/TEST_SUITE_EMPTY/);
 fs.rmdirSync(path.join(f.root,'tests/core'));
 assert.throws(()=>discoverNodeTests(f.root),/TEST_SUITE_DIRECTORY_MISSING/);
});

test('an optional development distribution is explicit, and a present but broken suite fails',t=>{
 const f=fixture(t);
 assert.deepEqual(discoverNodeTests(f.root).unavailable,['studio']);
 assert.throws(()=>discoverNodeTests(f.root,{suiteIds:['studio']}),/TEST_SUITE_NOT_IN_DISTRIBUTION/);
 f.put('tools/studio/README.md');
 assert.throws(()=>discoverNodeTests(f.root),/TEST_SUITE_DIRECTORY_MISSING/);
 fs.mkdirSync(path.join(f.root,'tools/studio/test'));
 assert.throws(()=>discoverNodeTests(f.root),/TEST_SUITE_EMPTY/);
 f.put('tools/studio/test/studio.test.mjs');
 assert.deepEqual(discoverNodeTests(f.root).files,['tests/core/example.test.mjs','tools/studio/test/studio.test.mjs']);
 assert.throws(()=>discoverNodeTests(f.root,{suiteIds:['typo']}),/UNKNOWN_TEST_SUITE/);
});

test('historical path identities map one root only and cannot collapse two suites',t=>{
 const layout=readTestLayout();
 for(const [oldRoot,newRoot] of Object.entries(layout.root_aliases))
  assert.equal(canonicalTestPath(oldRoot+'/sample.test.mjs',layout),newRoot+'/sample.test.mjs');
 for(const file of ['tools/skin-studio/test/studio.test.mjs','engine/test/core.test.mjs','tests/v1/example.test.mjs'])
  assert.equal(canonicalTestPath(file,layout),file);
 const f=fixture(t);f.layout.root_aliases.other='tests/v1';f.put('tests/layout.json',JSON.stringify(f.layout));
 assert.throws(()=>readTestLayout(f.root),/TEST_PATH_ALIAS_INVALID/);
});

test('nonstandard historical test files are explicit, required, and never duplicated',t=>{
 const f=fixture(t);
 f.layout.node_suites[0].additional_files=['legacy.mjs'];
 f.put('tests/layout.json',JSON.stringify(f.layout));
 assert.throws(()=>discoverNodeTests(f.root),/TEST_FILE_MISSING/);
 f.put('tests/core/legacy.mjs');
 assert.deepEqual(discoverNodeTests(f.root).files,['tests/core/example.test.mjs','tests/core/legacy.mjs']);
 f.layout.node_suites[0].additional_files=['example.test.mjs'];
 f.put('tests/layout.json',JSON.stringify(f.layout));
 assert.throws(()=>readTestLayout(f.root),/TEST_ADDITIONAL_FILES_INVALID/);
 const actual=discoverNodeTests().files;
 for(const file of ['tests/v1/setup-test.mjs','tests/v1/support.mjs'])
  assert.equal(actual.filter(item=>item===file).length,1);
});

test('declared Node discovery covers every source test file exactly once',()=>{
 const layout=readTestLayout(),files=[];
 function walk(directory) {
  for(const entry of fs.readdirSync(path.join(sourceRoot,directory),{withFileTypes:true})) {
   const relative=path.posix.join(directory,entry.name);
   if(entry.isSymbolicLink()||['.git','node_modules'].includes(entry.name)||relative===layout.separate_ui_suite)continue;
   if(entry.isDirectory())walk(relative);
   else if(entry.name.endsWith('.test.mjs') ||
     ['tests/v1/setup-test.mjs','tests/v1/support.mjs'].includes(relative))files.push(relative);
  }
 }
 walk('');
 assert.deepEqual(discoverNodeTests().files,files.sort());
});
