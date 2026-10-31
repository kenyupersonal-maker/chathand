import fs from 'node:fs';
import vm from 'node:vm';
import catalogs from '../ui/local-text-catalogs.mjs';

const localTextSource = fs.readFileSync(new URL('../ui/local-text.js', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
const productionTextBindings = ['const T=', 'const TH='].map((prefix) => {
  const line = appSource.split('\n').find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error(`Production UI text binding not found: ${prefix}`);
  return line;
}).join('\n');

export function installUiTextContext(box) {
  if (!vm.isContext(box)) throw new TypeError('UI text context must already be a VM context');
  box.__CHATHAND_TEXT_CATALOGS__ = catalogs;
  vm.runInContext(localTextSource, box, { filename: 'ui/local-text.js' });
  if (!box.window) box.window = box;
  box.window.ChatHandText = box.ChatHandText;
  vm.runInContext(productionTextBindings, box, { filename: 'ui/app.js production text bindings' });
  return box.ChatHandText;
}
