#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { cssRules,htmlStyles,valueWords } from './skin-css-parser.mjs';
const require=createRequire(import.meta.url),{ROOT,launchBrowser}=require('../test-ui-port/harness/common.js');
const FILES=['ui/style.css','ui/wizard.css','ui/app.js','ui/index.html','ui/task-widget.html'];
const read=f=>fs.readFileSync(path.join(ROOT,f),'utf8');
export function extractRules(file,source=read(file)){
  if(file.endsWith('.css'))return cssRules(source);
  const r=htmlStyles(source);
  if(file.endsWith('.js'))for(const m of source.matchAll(/\.(fillStyle|strokeStyle|shadowColor)\s*=\s*([`"'])([\s\S]*?)\2/g))r.push({selector:'[canvas color]',ancestors:[],declarations:[{prop:m[1],value:m[3]}]});
  if(file.endsWith('.js')){
    for(const m of source.matchAll(/\.style\.(color|backgroundColor|background|borderColor|outlineColor|boxShadow|textShadow)\s*=\s*([`"'])([\s\S]*?)\2/g))r.push({selector:'[JS style]',ancestors:[],declarations:[{prop:m[1],value:m[3]}]});
    for(const m of source.matchAll(/(["'])(#[\da-f]{3,8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^"']*\)|[a-z]+)\1/gi))if(!/rgba\(\$\{/.test(m[2]))r.push({selector:'[JS literal]',ancestors:[],declarations:[{prop:'literal',value:m[2]}]});
  }
  return r;
}
export async function checkTokens({sources=null,includeSkins=true}={}){
  const exceptions=JSON.parse(read('scripts/skin-token-exceptions.json')),records=[],tokens=new Map();
  const inputFiles=sources?Object.keys(sources):FILES;
  for(const file of inputFiles)for(const rule of extractRules(file,sources?sources[file]:read(file)))for(const d of rule.declarations){
    if(d.prop.startsWith('--')){if(!tokens.has(d.prop))tokens.set(d.prop,{name:d.prop,value:d.value,file,uses:[]});continue;}
    records.push({file,selector:rule.selector,property:d.prop,value:d.value,words:valueWords(d.value)});
  }
  for(const rec of records)for(const m of rec.value.matchAll(/var\((--[\w-]+)/g))tokens.get(m[1])?.uses.push(`${rec.selector} 的 ${rec.property}`);
  const candidates=[...new Set(records.flatMap(r=>r.words))],browser=await launchBrowser();let colors;
  try {const page=await browser.newPage();colors=new Set(await page.evaluate(xs=>xs.filter(x=>/^#|^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i.test(x)||(!/^(transparent|currentcolor|inherit|initial|unset|revert|revert-layer)$/i.test(x)&&CSS.supports('color',x))),candidates));}finally{await browser.close();}
  const issues=[];let exempted=0;
  const systemColor=/^(?:menu|canvas|canvastext|linktext|visitedtext|activetext|buttonface|buttontext|buttonborder|field|fieldtext|highlight|highlighttext|selecteditem|selecteditemtext|mark|marktext|graytext|accentcolor|accentcolortext|activeborder|activecaption|appworkspace|background|buttonhighlight|buttonshadow|captiontext|inactiveborder|inactivecaption|inactivecaptiontext|infobackground|infotext|menutext|scrollbar|threeddarkshadow|threedface|threedhighlight|threedlightshadow|threedshadow|window|windowframe|windowtext)$/i;
  for(const r of records){const found=r.words.filter(w=>colors.has(w)&&!(r.selector==='[JS literal]'&&systemColor.test(w)));if(!found.length)continue;const exc=exceptions.find(e=>e.file===r.file&&e.selector===r.selector&&e.property===r.property&&e.value===r.value&&e.reason);if(exc){exempted++;continue;}issues.push({...r,words:found});}
  // 文档覆盖所有可写皮肤变量；皮肤文件内的色值本来就允许，故不进入产品漏色检查。
  const skinsDir=path.join(ROOT,'ui/skins');if(includeSkins&&fs.existsSync(skinsDir))for(const file of fs.readdirSync(skinsDir).filter(f=>f.endsWith('.css'))){for(const rule of cssRules(fs.readFileSync(path.join(skinsDir,file),'utf8')))for(const d of rule.declarations){if(d.prop.startsWith('--')&&!tokens.has(d.prop))tokens.set(d.prop,{name:d.prop,value:d.value,file:'ui/skins/'+file,uses:[]});for(const m of d.value.matchAll(/var\((--[\w-]+)/g))tokens.get(m[1])?.uses.push(`${rule.selector} 的 ${d.prop}`);}}
  const canvas=sources?(sources['ui/app.js']||''):read('ui/app.js');if(/COL\s*=\s*\[\s*\[\s*\d/.test(canvas))issues.push({file:'ui/app.js',property:'canvas RGB',value:'COL 中仍有写死 RGB 数组'});
  if(!sources&&/setProperty\('--d'/.test(canvas))tokens.set('--d',{name:'--d',value:'1200px（CSS 回退值，运行时按面板尺寸计算）',file:'ui/app.js',uses:['运行时流光尺寸；框架变量，皮肤不可覆盖']});
  return {ok:!issues.length,files:inputFiles.length,declarations:records.length,tokens:[...tokens.values()],exceptions:exempted,issues};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=await checkTokens();
  if(process.argv.includes('--docs')){console.log('| 变量 | 管哪里 | 默认例子 |\n| --- | --- | --- |');for(const t of result.tokens)console.log(`| \`${t.name}\` | ${(['--font','--mono','--ease'].includes(t.name)?'框架变量，皮肤不可覆盖；':'')+(t.uses[0]||'供其他变量、脚本或皮肤使用').replace(/\|/g,'\\|')} | \`${t.value}\` |`);}
  else console.log(JSON.stringify({...result,tokens:result.tokens.length},null,2));
  if(!result.ok)process.exitCode=1;
}
