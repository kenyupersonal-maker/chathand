import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

if (process.platform !== 'darwin') throw Error('Native decision tests require macOS and Xcode Command Line Tools.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ken-native-guard-'));
try {
  const binary = path.join(temp, 'native-element-guard');
  const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library',
    '-framework', 'Cocoa', '-framework', 'ApplicationServices', '-framework', 'ScreenCaptureKit',
    'native/LocalText.swift','native/ComputerControl.swift', 'native/B2TargetClick.swift', 'test-v09/native-element-guard.swift', '-o', binary],
    {cwd: root, stdio: 'inherit', timeout: 60000});
  if (build.status !== 0) throw Error('Native guard compilation failed.');
  fs.cpSync(path.join(root,'locales'),path.join(temp,'locales'),{recursive:true});
  const run = spawnSync(binary, [], {cwd: root, stdio: 'inherit', timeout: 10000});
  if (run.status !== 0) throw Error('Native guard regression failed.');
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
