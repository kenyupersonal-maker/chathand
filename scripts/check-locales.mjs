import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {catalogs,validateCatalogs} from '../app/i18n.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),required=[];
// A bounded walk of source consumers, including inline widget and window consumers.
function scan(folder){for(const item of fs.readdirSync(folder,{withFileTypes:true})){
 if(item.name.startsWith('.')||['node_modules','tests'].includes(item.name))continue;
 const target=path.join(folder,item.name);
 if(item.isDirectory())scan(target);
 else if(/\.(?:mjs|js|html|swift|py)$/.test(item.name)&&!item.name.startsWith('local-text-catalogs')){
  const source=fs.readFileSync(target,'utf8');
  for(const match of source.matchAll(/(?:LocalText\.text|localText|displayText|uiText|uiHTML|ChatHandText\.(?:t|html)|\b(?:t|T|TH))\(\s*['"]([a-z][A-Za-z0-9_]*\.[A-Za-z0-9_.]+)['"](?=\s*[,\)])/g))required.push(match[1]);
  // Include HTML data attributes and lazy getter key values as well as direct calls.
  for(const match of source.matchAll(/['"]((?:ui|dmg)\.[a-z][A-Za-z0-9_]*(?:\.[a-z][A-Za-z0-9_]*)+)['"]/g))required.push(match[1]);
 }
}}
for(const folder of ['app','native','scripts','ui'])scan(path.join(root,folder));
validateCatalogs(catalogs,required);
console.log(JSON.stringify({status:'PASS',keys:Object.keys(catalogs.zh).length,referencedKeys:new Set(required).size,emptyEnglish:Object.values(catalogs.en).filter(v=>!v.trim()).length}));
