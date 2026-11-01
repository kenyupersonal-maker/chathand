import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
test('1074 AX setter and Unicode fallback both use the production secure readback verifier', () => {
  const source = fs.readFileSync(path.join(root, 'native/ComputerControl.swift'), 'utf8');
  const setter = source.slice(source.indexOf('static func axTextResult('), source.indexOf('struct CaptureWindowFacts'));
  const fallback = source.slice(source.indexOf('if entry?.element != nil { try sendKey("Command+A"'), source.indexOf('method = "unicode_events"'));
  assert.match(setter, /verifyTextReadback\(sensitive: sensitive, read: read, expected: expected\)/);
  assert.match(source, /switch axTextResult\(settable: canSet, sensitive: entry\?\.sensitive == true \|\| isSensitive\(element, name: elementName\(element\)\)/);
  assert.match(fallback, /try await unicode\(text,session:session\)/);
  assert.match(fallback, /verifyTextReadback\(sensitive: entry\?\.sensitive == true \|\| isSensitive\(element, name: elementName\(element\)\)/);
  assert.match(fallback, /read: \{ rawStringAttr\(element,kAXValueAttribute as String\) \}, expected: text/);
});

test('1074 production pure verifier counts secure and ordinary readback without OS input', {skip: process.platform !== 'darwin', timeout: 120000}, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chathand-1074-readback-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const cache = process.env.CHATHAND_TEST_SWIFT_CACHE || path.join(dir, 'module-cache');
  fs.mkdirSync(cache, {recursive: true});
  const env = {...process.env, CHATHAND_STATE_DIR: path.join(dir, 'state'), CLANG_MODULE_CACHE_PATH: cache};
  const binary = path.join(dir, 'readback-checks');
  const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', '-module-cache-path', cache,
    '-framework', 'Cocoa', '-framework', 'ApplicationServices', '-framework', 'ScreenCaptureKit', '-framework', 'Vision',
    'native/LocalText.swift', 'native/ComputerControl.swift', 'native/B2TargetClick.swift', 'tests/v1/1074-secure-input-readback.swift', '-o', binary],
  {cwd: root, env, encoding: 'utf8', timeout: 90000});
  assert.equal(build.status, 0, (build.error?.code || '') + ' ' + build.stderr);
  fs.cpSync(path.join(root, 'locales'), path.join(dir, 'locales'), {recursive: true});
  const run = spawnSync(binary, [], {cwd: root, env, encoding: 'utf8', timeout: 5000});
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /PASS \d+ isolated secure readback checks; zero AX or input events/);
  console.log(run.stdout.trim());
});
