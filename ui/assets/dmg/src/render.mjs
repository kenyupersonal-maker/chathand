import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright-core';
import {generateDmgSources} from './generate.mjs';
import {readCatalogs,createDmgText,escapeHTML,catalogFingerprint,sourceFiles} from './localize.mjs';

const assets=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),repo=path.resolve(assets,'../../..');
const chrome=process.env.CHATHAND_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sizes={'icon_16x16.png':16,'icon_16x16@2x.png':32,'icon_32x32.png':32,'icon_32x32@2x.png':64,'icon_128x128.png':128,'icon_128x128@2x.png':256,'icon_256x256.png':256,'icon_256x256@2x.png':512,'icon_512x512.png':512,'icon_512x512@2x.png':1024};
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const artworkFiles=['background.html','background.png','background@2x.png','background.tiff'];
export async function renderDmgAssets({outputDir=assets,catalogs=readCatalogs()}={}){
 // Refresh localized HTML from the same catalog snapshot before binding rendered bytes.
 generateDmgSources({outputDir,catalogs});
 const b=await chromium.launch({executablePath:chrome,headless:true});
 try{
  for(const locale of ['zh','en']){
   const target=path.join(outputDir,locale),text=createDmgText({locale,catalogs});
   for(const scale of [1,2]){
    const context=await b.newContext({viewport:{width:698,height:718},deviceScaleFactor:scale,colorScheme:'light'}),p=await context.newPage();
    await p.goto(pathToFileURL(path.join(target,'background.html')).href);
    const file=path.join(target,scale===1?'background.png':'background@2x.png');
    await p.screenshot({path:file});await context.close();
    execFileSync('/usr/bin/sips',['-s','dpiWidth',String(scale*72),'-s','dpiHeight',String(scale*72),file],{stdio:'ignore'});
   }
   execFileSync('/usr/bin/tiffutil',['-cathidpicheck',path.join(target,'background.png'),path.join(target,'background@2x.png'),'-out',path.join(target,'background.tiff')],{stdio:'ignore'});
   const pkg=JSON.parse(fs.readFileSync(path.join(repo,'package.json'),'utf8'));
   for(const kind of ['codexdoc','helpdoc']){
    const set=path.join(target,kind+'.iconset');fs.mkdirSync(set,{recursive:true});
    const template=fs.readFileSync(path.join(assets,'src',kind+'.svg'),'utf8');
    for(const [name,size] of Object.entries(sizes)){
     const p=await b.newPage({viewport:{width:size,height:size},deviceScaleFactor:1});
     const svg=template.replace('@FOOTER@',size<64?'':`<text x="256" y="416" text-anchor="middle" font-family="-apple-system,\'PingFang SC\',sans-serif" font-size="52" font-weight="600" fill="#5F6661">${escapeHTML(text.text(kind==='codexdoc'?'dmg.icon.install':'dmg.icon.open'))}</text>`);
     await p.setContent(`<html><style>*{margin:0}html,body{width:${size}px;height:${size}px;background:transparent}svg{display:block;width:100%;height:100%}</style><body>${svg}</body></html>`);
     await p.screenshot({path:path.join(set,name),omitBackground:true});await p.close();
    }
    execFileSync('/usr/bin/iconutil',['-c','icns',set,'-o',path.join(target,kind+'.icns')]);
   }
   const stamp={format:1,width:698,height:718,version:pkg.version,locale,catalog_sha256:catalogFingerprint(catalogs),template_sha256:sha(path.join(assets,'src/background.template.html')),source_sha256:Object.fromEntries(sourceFiles.map(name=>[name,sha(path.join(repo,name))])),assets:Object.fromEntries([...artworkFiles,'让 ChatGPT 来装.html','第一次打开.html','codexdoc.icns','helpdoc.icns'].map(name=>[name,{sha256:sha(path.join(target,name)),...(name.endsWith('.png')?{width:name.includes('@2x')?1396:698,height:name.includes('@2x')?1436:718}:{})}]))};
   fs.writeFileSync(path.join(target,'background.stamp.json'),JSON.stringify(stamp,null,2)+'\n');
   if(locale==='zh'){
    for(const name of [...artworkFiles,'background.stamp.json','codexdoc.icns','helpdoc.icns'])fs.copyFileSync(path.join(target,name),path.join(outputDir,name));
    for(const kind of ['codexdoc','helpdoc'])fs.cpSync(path.join(target,kind+'.iconset'),path.join(outputDir,kind+'.iconset'),{recursive:true});
   }
  }
 }finally{await b.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2);
 if(args.length&&!(args.length===2&&args[0]==='--output-dir'))throw Error('DMG_RENDER_ARGS_INVALID');
 await renderDmgAssets({outputDir:args.length?path.resolve(args[1]):assets});
 console.log('Rendered zh/en bitmap, retina TIFF, and document icons; default paths retain Chinese.');
}
