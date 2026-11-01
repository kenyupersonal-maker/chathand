import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {discoverNodeTests, readTestLayout, sourceRoot} from '../../scripts/test-layout.mjs';

function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-test-entrypoints-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const put=file=>{const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'');};
 const inherited=[{suite:'v1',path:'tests/development/installation-docs.test.mjs',optional_distribution_root:'tests/development'}];
 const layout={schema_version:1,root_aliases:{'test-v1':'tests/v1'},separate_ui_suite:'tests/ui',node_suites:[
  {id:'v1',path:'tests/v1',additional_files:['legacy.mjs']},
  {id:'relay',path:'tests/v1/relay'},
  {id:'development',path:'tests/development',optional_distribution_root:'tests/development'}
 ],entry_points:{
  test:{suites:['v1','relay'],inherited_files:inherited},
  v1:{suites:['v1'],inherited_files:inherited},
  trial:{suites:['v1'],module_suites:['v1'],inherited_files:inherited}
 }};
 for(const file of ['tests/v1/first.test.mjs','tests/v1/legacy.mjs','tests/v1/helper.mjs','tests/v1/relay/relay.test.mjs'])put(file);
 const save=()=>fs.writeFileSync(path.join(root,'tests/layout.json'),JSON.stringify(layout));save();
 return {root,put,layout,save};
}

test('historical entry points keep distinct file sets and trial module coverage',t=>{
 const f=fixture(t),list=name=>discoverNodeTests(f.root,{entryPoint:name}).files;
 assert.deepEqual(list('test'),['tests/v1/first.test.mjs','tests/v1/relay/relay.test.mjs']);
 assert.deepEqual(list('v1'),['tests/v1/first.test.mjs']);
 assert.deepEqual(list('trial'),['tests/v1/first.test.mjs','tests/v1/helper.mjs','tests/v1/legacy.mjs']);
 assert.deepEqual(discoverNodeTests(f.root).files,['tests/v1/first.test.mjs','tests/v1/legacy.mjs','tests/v1/relay/relay.test.mjs']);
});

test('split internal assertions remain required in each historical v1 entry point',t=>{
 const f=fixture(t),file='tests/development/installation-docs.test.mjs';
 for(const entryPoint of ['test','v1','trial'])assert.deepEqual(discoverNodeTests(f.root,{entryPoint}).unavailable,[file]);
 f.put('tests/development/unrelated.test.mjs');
 for(const entryPoint of ['test','v1','trial'])assert.throws(()=>discoverNodeTests(f.root,{entryPoint}),/TEST_FILE_MISSING/);
 f.put(file);
 for(const entryPoint of ['test','v1','trial']) {
  const found=discoverNodeTests(f.root,{entryPoint});
  assert.equal(found.files.filter(name=>name===file).length,1);
  assert.equal(found.files.includes('tests/development/unrelated.test.mjs'),false);
 }
});

test('entry-point configuration and explicit absent suites fail clearly',t=>{
 const f=fixture(t);
 assert.throws(()=>discoverNodeTests(f.root,{entryPoint:'typo'}),/UNKNOWN_TEST_ENTRY_POINT/);
 assert.throws(()=>discoverNodeTests(f.root,{entryPoint:'test',suiteIds:['development']}),/TEST_SUITE_NOT_IN_DISTRIBUTION/);
 f.layout.entry_points.trial.module_suites=['relay'];f.save();
 assert.throws(()=>readTestLayout(f.root),/TEST_ENTRY_POINT_INVALID/);
});

test('repository commands preserve legacy boundaries and expose added checks separately',()=>{
 const pkg=JSON.parse(fs.readFileSync(path.join(sourceRoot,'package.json'),'utf8'));
 assert.equal(pkg.scripts['test:v1'],'node scripts/test-node.mjs --entry-point=v1');
 assert.equal(pkg.scripts['test:all'],'node scripts/test-node.mjs --entry-point=all');
 assert.equal(pkg.scripts['test:layout'],'node scripts/test-node.mjs --entry-point=layout');
 const sets=Object.fromEntries(['test','v1','trial','layout'].map(entryPoint=>[entryPoint,discoverNodeTests(sourceRoot,{entryPoint}).files]));
 for(const file of ['tests/v1/setup-test.mjs','tests/v1/support.mjs']) {
  assert.equal(sets.test.includes(file),false);assert.equal(sets.v1.includes(file),false);assert.equal(sets.trial.includes(file),true);
 }
 assert.ok(sets.test.some(file=>file.startsWith('tests/v1/relay-v412/')));
 assert.equal(sets.v1.some(file=>file.startsWith('tests/v1/relay-v412/')),false);
 for(const prefix of ['native/tests/','scripts/','tests/v1/relay-v412/','tools/skin-studio/','tests/layout/'])
  assert.equal(sets.trial.some(file=>file.startsWith(prefix)),false);
 assert.ok(sets.layout.includes('tests/layout/discovery.test.mjs'));
 assert.ok(sets.layout.includes('tests/layout/entrypoints.test.mjs'));
 const internal='tests/development/installation-docs.test.mjs';
 if(fs.existsSync(path.join(sourceRoot,'tests/development')))
  for(const entryPoint of ['test','v1','trial'])assert.ok(sets[entryPoint].includes(internal));
});
