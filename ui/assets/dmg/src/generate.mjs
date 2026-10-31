import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {renderDmgArtwork} from '../../../h10/offline.mjs';
import {INSTALL_DEEP_LINK_PREFIX} from '../../../h10/prompts.mjs';
import {createDmgText,readCatalogs,escapeHTML,scriptJSON,localizeTemplate,assertSelfContained} from './localize.mjs';

// DMG templates only. H10/Site F1 and F5 retain their own renderer and guards.
const src=path.dirname(fileURLToPath(import.meta.url)),assets=path.dirname(src),repo=path.resolve(src,'../../../..');
const scriptString=value=>scriptJSON(value).slice(1,-1);
export const pageFiles=['让 ChatGPT 来装.html','第一次打开.html','background.html'];
export function generateDmgSources({outputDir=assets,catalogs=readCatalogs()}={}){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-dmg-page-icon-'));
 try{
  const icon=path.join(temp,'icon.png');
  execFileSync('/usr/bin/sips',['-Z','256',path.join(repo,'ui/assets/app/AppIcon-rounded-512.png'),'--out',icon],{stdio:'ignore'});
  const bytes=fs.readFileSync(icon);if(bytes.readUInt32BE(16)!==256||bytes.readUInt32BE(20)!==256)throw Error('DMG_ICON_DIMENSIONS');
  const appIcon='data:image/png;base64,'+bytes.toString('base64');
  const svg=fs.readFileSync(path.join(src,'chatgpt-logo.svg'),'utf8'),d=svg.match(/<path[^>]*\sd="([^"]+)"/)?.[1];
  if(!d)throw Error('DMG_CHATGPT_MARK_MISSING');
  const mark=`<svg viewBox="0 0 86 86" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>`;
  // The historical planning doc is absent; this source preserves the shipped command verbatim.
  const command=fs.readFileSync(path.join(src,'install-command.txt'),'utf8').trim();
  if(!command)throw Error('DMG_COMMAND_MISSING');
  const generated=[];
  for(const locale of ['zh','en']){
   const text=createDmgText({locale,catalogs});
   const values={
    '@THEME@':fs.readFileSync(path.join(src,'theme.css'),'utf8'),
    '@SYSTEM_GUIDE@':fs.readFileSync(path.join(src,'system-guide.html'),'utf8'),
    '@APP_ICON@':appIcon,'@CHATGPT_MARK@':mark,
    '@PROMPT_TEMPLATE@':scriptString(text.text('ui.h10.prompts.installPrompt',{location:text.text('ui.h10.prompts.downloadLocationPlaceholder')})),
    '@PROMPT_LOCATION_TOKEN@':scriptString(text.text('ui.h10.prompts.downloadLocationPlaceholder')),
    '@COMMAND@':escapeHTML(command),
    '@LOCAL_WORK_WEB_WARNING@':escapeHTML(text.text('dmg.localWorkWebWarning')),
    '@DEEP_LINK_PREFIX@':scriptString(INSTALL_DEEP_LINK_PREFIX)
   };
   const results=[['让 ChatGPT 来装.html','jump.template.html'],['第一次打开.html','first-open.template.html']].map(([name,template])=>{
    let html=fs.readFileSync(path.join(src,template),'utf8');
    // Insert structural snippets before text and media; translated text is never rescanned as source.
    html=html.replaceAll('@SYSTEM_GUIDE@',values['@SYSTEM_GUIDE@']);
    html=localizeTemplate(html,text,values);
    return [name,html];
   });
   results.push(['background.html',renderDmgArtwork({locale,catalogs})]);
   const target=path.join(outputDir,locale);fs.mkdirSync(target,{recursive:true});
   for(const [name,html] of results){
    assertSelfContained(html);
    fs.writeFileSync(path.join(target,name),html);
    // Preserve the existing Chinese paths used by the current build pipeline.
    if(locale==='zh'){fs.mkdirSync(outputDir,{recursive:true});fs.writeFileSync(path.join(outputDir,name),html);}
    generated.push(path.join(target,name));
   }
  }
  return generated;
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2);
 if(args.length&&!(args.length===2&&args[0]==='--output-dir'))throw Error('NO_UNVERIFIED_RELEASE_ARGS');
 for(const file of generateDmgSources({outputDir:args.length?path.resolve(args[1]):assets}))console.log('generated DMG source',file,'(no app launch or installed/paired claim)');
}
