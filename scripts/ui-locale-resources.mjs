import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateCatalogs} from '../app/i18n.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const inlineStart='<!-- CHATHAND_LOCAL_TEXT_INLINE -->';
const inlineEnd='<!-- /CHATHAND_LOCAL_TEXT_INLINE -->';
const serialize=value=>JSON.stringify(value).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
export function fillEmptyEnglish(tables,incoming){
 if(!incoming||typeof incoming!=='object'||Array.isArray(incoming))throw Error('I18N_ENGLISH_INVALID incoming');
 const en={...tables.en};let filled=0;
 for(const [key,value] of Object.entries(incoming)){
  if(!Object.hasOwn(tables.zh,key))throw Error('I18N_CHINESE_MISSING '+key);
  if(typeof value!=='string')throw Error('I18N_ENGLISH_INVALID '+key);
  if(!en[key]?.trim()&&value.trim()){en[key]=value;filled++;}
 }
 // Validate the incoming text verbatim before writing either catalog. Never repair English.
 validateCatalogs({zh:tables.zh,en});
 return {en,filled};
}
export function generatedUILocaleFiles(repo,tables,{catalogsOnly=false}={}){
 validateCatalogs(tables);
 const select=prefixes=>Object.fromEntries(['zh','en'].map(lang=>[lang,Object.fromEntries(Object.entries(tables[lang]).filter(([key])=>prefixes.some(prefix=>key.startsWith(prefix))))]));
 const ui=select(['ui.','dmg.']);
 const files={
  'ui/local-text-catalogs.js':'// Generated from locales/zh.json and en.json. Do not edit.\nglobalThis.__CHATHAND_TEXT_CATALOGS__='+serialize(ui)+';\n',
  'ui/local-text-catalogs.mjs':'// Generated from locales/zh.json and en.json. Do not edit.\nexport default '+serialize(ui)+';\n'
 };
 const runtimeFile=path.join(repo,'ui/local-text.js');
 if(!catalogsOnly&&fs.existsSync(runtimeFile)){
  const runtime=fs.readFileSync(runtimeFile,'utf8');
  if(/<\/script/i.test(runtime))throw Error('I18N_INLINE_RUNTIME_INVALID');
  for(const [name,prefix] of [['task-widget.html','ui.taskWidget.'],['image-batch-widget.html','ui.imageBatch.']]){
   const relative='ui/'+name,source=fs.readFileSync(path.join(repo,relative),'utf8'),at=source.indexOf(inlineStart);
   if(at<0)throw Error('I18N_WIDGET_MARKER_MISSING '+name);
   const end=source.indexOf(inlineEnd,at+inlineStart.length);
   const block=inlineStart+'\n<script>\nglobalThis.__CHATHAND_TEXT_CATALOGS__='+serialize(select([prefix]))+';\n'+runtime+'\n</script>\n'+inlineEnd;
   files[relative]=source.slice(0,at)+block+source.slice(end<0?at+inlineStart.length:end+inlineEnd.length);
  }
 }
 return files;
}
export function writeUILocaleResources(repo=root,{check=false,catalogsOnly=false}={}){
 const tables=Object.fromEntries(['zh','en'].map(lang=>[lang,JSON.parse(fs.readFileSync(path.join(repo,'locales',lang+'.json'),'utf8'))]));
 const files=generatedUILocaleFiles(repo,tables,{catalogsOnly}),stale=[];
 for(const [relative,content] of Object.entries(files)){
  const target=path.join(repo,relative),current=fs.existsSync(target)?fs.readFileSync(target,'utf8'):null;
  if(current===content)continue;
  if(check)stale.push(relative);else fs.writeFileSync(target,content);
 }
 if(stale.length)throw Error('I18N_GENERATED_STALE '+stale.join(', '));
 return Object.keys(files);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),english=args.indexOf('--english');
 if(english>=0){
  const filename=args[english+1];if(!filename)throw Error('I18N_ENGLISH_FILE_REQUIRED');
  const tables=Object.fromEntries(['zh','en'].map(lang=>[lang,JSON.parse(fs.readFileSync(path.join(root,'locales',lang+'.json'),'utf8'))]));
  const result=fillEmptyEnglish(tables,JSON.parse(fs.readFileSync(filename,'utf8')));
  fs.writeFileSync(path.join(root,'locales/en.json'),JSON.stringify(result.en,null,2)+'\n');
  console.log(JSON.stringify({filledEnglish:result.filled}));
 }
 console.log(JSON.stringify({status:'PASS',files:writeUILocaleResources(root,{check:args.includes('--check'),catalogsOnly:args.includes('--catalogs-only')})}));
}
