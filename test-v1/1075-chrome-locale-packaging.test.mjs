import {alignLegacyFixtureManifest} from '../test-support/legacy-chrome-install-source.mjs';
import {legacyChromeDistribution} from '../app/v1/chrome-distribution.mjs';
const publishHelper=options=>productionPublishHelper({...options,distribution:legacyChromeDistribution()});
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {copyLocaleResources} from '../scripts/locale-resources.mjs';
import {packageChromeLocales} from '../scripts/package-chrome-locales.mjs';
import {publishHelper as productionPublishHelper} from '../app/v1/chrome-helper-source.mjs';
import {installSource, helperFingerprint} from '../app/v1/chrome-install-probe.mjs';
import {text} from '../browser-extension/locale.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = file => fs.readFileSync(file, 'utf8');
const tables = folder => {
  const source = read(path.join(folder, 'locale-catalogs.js'));
  return JSON.parse(source.slice(source.indexOf('export const catalogs =') + 'export const catalogs ='.length).replace(/;\s*$/, ''));
};
function stage(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chathand-1075-chrome-locales-')));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const contents = path.join(dir, 'Temporary.app/Contents'), runtime = path.join(contents, 'Resources/runtime');
  const sourceCatalog = fs.readFileSync(path.join(root, 'browser-extension/locale-catalogs.js'));
  copyLocaleResources(root, contents);
  // Run the actual build's resource-copy/localization phase, without invoking
  // compilers, signing or unrelated resource copies. All outputs are temporary.
  const build = read(path.join(root, 'scripts/build-v09.mjs'));
  const start = build.indexOf(" for(const f of ['app','ui'");
  const end = build.indexOf(' const screenshotAdapter=', start);
  assert.ok(start >= 0 && end > start, 'production staging phase is present');
  vm.runInNewContext(build.slice(start, end), {root, runtime, path, packageChromeLocales,
    copy(source, destination) {
      if (source === path.join(root, 'browser-extension')) fs.cpSync(source, destination, {recursive: true});
    }});
  // The real publisher also checks these fixed package identity resources.
  fs.copyFileSync(path.join(root, 'package.json'), path.join(runtime, 'package.json'));
  fs.mkdirSync(path.join(runtime, 'app/v09'), {recursive: true});
  fs.copyFileSync(path.join(root, 'app/v09/extension-host.mjs'), path.join(runtime, 'app/v09/extension-host.mjs'));
  assert.deepEqual(fs.readFileSync(path.join(root, 'browser-extension/locale-catalogs.js')), sourceCatalog, 'staging never generates into source');
  return {dir, runtime, extension: path.join(runtime, 'browser-extension')};
}

test('1075 actual build staging fills Chrome English from authoritative locales before publication', t => {
  const {extension} = stage(t), generated = tables(extension);
  const source = Object.fromEntries(['zh', 'en'].map(language => [language, JSON.parse(read(path.join(root, 'locales', language + '.json')))]));
  assert.equal(text('chrome.connected', {}, 'en', generated), 'Connected to Mac');
  for (const language of ['zh', 'en']) {
    for (const key of Object.keys(generated.zh)) assert.equal(generated[language][key], source[language][key], language + ':' + key);
    const messages = JSON.parse(read(path.join(extension, '_locales', language === 'zh' ? 'zh_CN' : language, 'messages.json')));
    assert.equal(messages.helperName.message, text('chrome.helperName', {}, language, generated));
    assert.equal(messages.helperDescription.message, text('chrome.helperDescription', {}, language, generated));
  }
  assert.equal(Object.values(generated.en).filter(value => !value.trim()).length, 0);
  assert.deepEqual(fs.readFileSync(path.join(extension, 'background.js')), fs.readFileSync(path.join(root, 'browser-extension/background.js')), 'unrelated extension code stays byte-identical');
});

test('1075 production publishHelper copies staged bilingual catalogs into only a temporary home', t => {
  const {dir, runtime, extension} = stage(t), home = path.join(dir, 'home');
  fs.mkdirSync(home);
  alignLegacyFixtureManifest(runtime);
  const result = publishHelper({root: runtime, home});
  assert.equal(result.fingerprint, installSource(runtime).fingerprint);
  assert.equal(helperFingerprint(result.folder), result.fingerprint);
  assert.deepEqual(fs.readFileSync(path.join(result.folder, 'locale-catalogs.js')), fs.readFileSync(path.join(extension, 'locale-catalogs.js')));
  const published = tables(result.folder);
  assert.equal(text('chrome.connected', {}, 'en', published), 'Connected to Mac');
  assert.equal(text('chrome.connected', {}, 'zh', published), '已连接本机');
  assert.equal(publishHelper({root: runtime, home}).changed, false);
});
