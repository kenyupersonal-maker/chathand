#!/usr/bin/env node
/** Run the declared source suites with explicit nonempty discovery. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {discoverNodeTests, sourceRoot} from './test-layout.mjs';

export function runNodeTests(args = process.argv.slice(2)) {
  const suiteIds = [], nodeOptions = [];
  let list = false, entryPoint = 'test';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') continue;
    if (arg === '--list') { list = true; continue; }
    if (arg === '--entry-point' || arg.startsWith('--entry-point=')) {
      entryPoint = arg === '--entry-point' ? args[++i] : arg.slice('--entry-point='.length);
      if (!entryPoint || entryPoint.startsWith('-')) throw Error('TEST_ENTRY_POINT_VALUE_REQUIRED');
      continue;
    }
    if (arg === '--suite' || arg.startsWith('--suite=')) {
      const value = arg === '--suite' ? args[++i] : arg.slice('--suite='.length);
      if (!value || value.startsWith('-')) throw Error('TEST_SUITE_VALUE_REQUIRED');
      suiteIds.push(...value.split(','));
      continue;
    }
    nodeOptions.push(arg);
  }
  const discovery = discoverNodeTests(sourceRoot, {suiteIds, entryPoint: entryPoint === 'all' ? null : entryPoint});
  if (list) { console.log(JSON.stringify(discovery, null, 2)); return 0; }
  console.error(`Node tests: ${discovery.files.length} files in ${discovery.suites.length} suites.`);
  if (discovery.unavailable.length)
    console.error('Optional development suites absent from this source distribution: ' + discovery.unavailable.join(', '));
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...nodeOptions, ...discovery.files],
    {cwd: sourceRoot, stdio: 'inherit'});
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runNodeTests(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
