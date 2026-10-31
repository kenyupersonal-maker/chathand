import fs from 'node:fs';
import path from 'node:path';
import {createTranslator,validateCatalogs} from '../app/i18n.mjs';
// Used before code signing. Native and standalone installer read Bundle resources;
// Node resolves ../locales from its own module, never from the launch directory.
export function copyLocaleResources(root,contents,{runtime=true,displayNameKey,infoPlistKeys={}}={}){
 const source=path.join(root,'locales');
 const tables=Object.fromEntries(['zh','en'].map(lang=>[lang,JSON.parse(fs.readFileSync(path.join(source,lang+'.json'),'utf8'))]));
 validateCatalogs(tables);
 const targets=[path.join(contents,'Resources/locales'),...(runtime?[path.join(contents,'Resources/runtime/locales')]:[])];
 for(const target of targets){fs.mkdirSync(target,{recursive:true});for(const lang of ['zh','en'])fs.copyFileSync(path.join(source,lang+'.json'),path.join(target,lang+'.json'));}
 const properties={...(displayNameKey?{CFBundleDisplayName:displayNameKey}:{}),...infoPlistKeys};
 if(Object.keys(properties).length){
  if(Object.keys(properties).some(key=>!['CFBundleDisplayName','NSAppleEventsUsageDescription'].includes(key)))throw Error('I18N_INFO_PLIST_KEY_INVALID');
  validateCatalogs(tables,Object.values(properties));const tr=createTranslator(tables);
  for(const language of ['zh','en']){const folder=path.join(contents,'Resources',language+'.lproj');fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'InfoPlist.strings'),Object.entries(properties).map(([name,key])=>JSON.stringify(name)+' = '+JSON.stringify(tr(key,{},language))+';\n').join(''));}
 }
 return targets;
}
