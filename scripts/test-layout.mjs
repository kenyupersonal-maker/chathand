/** Source test discovery and historical path identities; no tests run on import. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const relativePath = value => typeof value === 'string' && value && !path.isAbsolute(value) &&
  !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..');

export function readTestLayout(root = sourceRoot) {
  const layout = JSON.parse(fs.readFileSync(path.join(root, 'tests/layout.json'), 'utf8'));
  if (layout.schema_version !== 1 || !Array.isArray(layout.node_suites) || !layout.node_suites.length ||
      !layout.root_aliases || typeof layout.root_aliases !== 'object' || Array.isArray(layout.root_aliases))
    throw Error('TEST_LAYOUT_INVALID');
  const ids = new Set(), paths = new Set(), aliases = new Set();
  for (const suite of layout.node_suites) {
    if (!/^[a-z0-9-]+$/.test(suite.id) || ids.has(suite.id) || !relativePath(suite.path) || paths.has(suite.path) ||
        suite.optional_distribution_root !== undefined && (!relativePath(suite.optional_distribution_root) || suite.path !== suite.optional_distribution_root && !suite.path.startsWith(suite.optional_distribution_root + '/')))
      throw Error('TEST_SUITE_INVALID');
    ids.add(suite.id); paths.add(suite.path);
    if (suite.additional_files !== undefined && (!Array.isArray(suite.additional_files) ||
        new Set(suite.additional_files).size !== suite.additional_files.length ||
        suite.additional_files.some(file => !relativePath(file) || file.includes('/') ||
          !file.endsWith('.mjs') || file.endsWith('.test.mjs'))))
      throw Error('TEST_ADDITIONAL_FILES_INVALID');
  }
  for (const [oldPath, newPath] of Object.entries(layout.root_aliases)) {
    if (!relativePath(oldPath) || oldPath.includes('/') || !relativePath(newPath) ||
        !newPath.startsWith('tests/') || aliases.has(newPath)) throw Error('TEST_PATH_ALIAS_INVALID');
    aliases.add(newPath);
  }
  if (!relativePath(layout.separate_ui_suite)) throw Error('TEST_UI_SUITE_INVALID');
  return layout;
}

export function canonicalTestPath(file, layout = readTestLayout()) {
  const slash = file.indexOf('/'), first = slash < 0 ? file : file.slice(0, slash);
  const replacement = Object.hasOwn(layout.root_aliases, first) ? layout.root_aliases[first] : null;
  return replacement ? replacement + (slash < 0 ? '' : file.slice(slash)) : file;
}

export function discoverNodeTests(root = sourceRoot, {suiteIds = [], layout = readTestLayout(root)} = {}) {
  const wanted = new Set(suiteIds), known = new Set(layout.node_suites.map(suite => suite.id));
  for (const id of wanted) if (!known.has(id)) throw Error('UNKNOWN_TEST_SUITE: ' + id);
  const suites = [], unavailable = [], files = new Set();
  for (const suite of layout.node_suites) {
    if (wanted.size && !wanted.has(suite.id)) continue;
    if (suite.optional_distribution_root && !fs.existsSync(path.join(root, suite.optional_distribution_root))) {
      if (wanted.has(suite.id)) throw Error('TEST_SUITE_NOT_IN_DISTRIBUTION: ' + suite.id);
      unavailable.push(suite.id);
      continue;
    }
    const directory = path.join(root, suite.path);
    if (!fs.existsSync(directory) || !fs.lstatSync(directory).isDirectory())
      throw Error('TEST_SUITE_DIRECTORY_MISSING: ' + suite.path);
    const members = [...fs.readdirSync(directory).filter(name => name.endsWith('.test.mjs')),
      ...(suite.additional_files || [])].sort();
    if (!members.length) throw Error('TEST_SUITE_EMPTY: ' + suite.path);
    for (const member of members) {
      const file = path.posix.join(suite.path, member);
      if (!fs.existsSync(path.join(root, file))) throw Error('TEST_FILE_MISSING: ' + file);
      if (!fs.lstatSync(path.join(root, file)).isFile()) throw Error('TEST_FILE_NOT_REGULAR: ' + file);
      if (files.has(file)) throw Error('DUPLICATE_TEST_FILE: ' + file);
      files.add(file);
    }
    suites.push({id: suite.id, path: suite.path, files: members.length});
  }
  if (!files.size) throw Error('NO_TEST_FILES');
  return {schema_version: 1, files: [...files].sort(), suites, unavailable};
}
