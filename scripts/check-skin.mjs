#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {cssRules,splitTop,stripComments} from './skin-css-parser.mjs';
const require=createRequire(import.meta.url),{ROOT}=require('../test-ui-port/harness/common.js');
const config=JSON.parse(fs.readFileSync(path.join(ROOT,'scripts/skin-allowed-props.json'),'utf8'));
function filesIn(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?filesIn(path.join(dir,e.name)):[path.join(dir,e.name)]);}
const remote=s=>/^(?:https?:)?\/\//i.test(s.trim());
export function checkSkin({skinSources=null,resourceSources=null}={}){
 const issues=[],skinDir=path.join(ROOT,'ui/skins'),skins=skinSources?Object.keys(skinSources):fs.existsSync(skinDir)?filesIn(skinDir).filter(f=>f.endsWith('.css')):[];let declarations=0,resources=0;
 const add=(file,rule,reason)=>issues.push({file:path.relative(ROOT,file),selector:rule?.selector||'',reason});
 for(const file of skins){const source=skinSources?skinSources[file]:fs.readFileSync(file,'utf8'),rules=cssRules(source);let important=0,animated=false,reduced=false;
  for(const rule of rules){const pseudo=splitTop(rule.selector,',').every(s=>/::(?:before|after)\s*$/.test(s)),reduce=rule.ancestors.some(a=>/prefers-reduced-motion\s*:\s*reduce/.test(a)),keyframes=rule.ancestors.some(a=>/@(?:-webkit-)?keyframes\b/.test(a));
   if(/^@import\b/i.test(rule.selector))add(file,rule,'禁止 @import');
   for(const d of rule.declarations){declarations++;if(/!important\b/.test(d.value))important++;
    if(d.prop.startsWith('--')){if(/^--(?:font|mono|ease|d)$/.test(d.prop))add(file,rule,'不能覆盖字体、几何或时序变量 '+d.prop);continue;}
    if(!config.existingElements.includes(d.prop)&&!(pseudo&&config.decorativePseudoElements.includes(d.prop)))add(file,rule,'属性不在白名单：'+d.prop);
    if(keyframes&&!config.animatedProperties.includes(d.prop))add(file,rule,'动画改变了几何或其他禁用属性：'+d.prop);
    if(pseudo&&d.prop==='position'&&d.value!=='fixed')add(file,rule,'装饰层只允许 position:fixed');
    if(pseudo&&d.prop==='pointer-events'&&d.value!=='none')add(file,rule,'装饰层不得接收点击');
    if(pseudo&&d.prop==='z-index'&&Number(d.value)>0)add(file,rule,'装饰层不能盖到内容前面');
    if(d.prop.startsWith('transition')||d.prop.startsWith('animation')){
     if(reduce&&/^none(?:\s*!important)?$/.test(d.value)){reduced=true;continue;}
     if(d.value==='none')continue;animated=true;
     if(/var\(/.test(d.value))add(file,rule,'动画时序必须是明确的安全属性和不超过240ms的时长');
     for(const m of d.value.matchAll(/(?:^|\s|,)([\d.]+)(ms|s)\b/g))if(Number(m[1])*(m[2]==='s'?1000:1)>config.maxDurationMs)add(file,rule,'动画或过渡超过 240ms');
     if(d.prop==='transition'||d.prop==='transition-property')for(const part of splitTop(d.value,',')){const name=part.trim().split(/\s+/)[0];if(!config.animatedProperties.includes(name))add(file,rule,'过渡属性被禁止：'+name);}
     if(d.prop==='animation-iteration-count'&&d.value!=='1')add(file,rule,'皮肤不能新增循环动画');
     if(d.prop==='animation'&&/\binfinite\b/.test(d.value))add(file,rule,'皮肤不能新增循环动画');
    }
   }
   if(pseudo&&rule.declarations.some(d=>d.prop==='content')&&!rule.declarations.some(d=>d.prop==='pointer-events'&&d.value==='none'))add(file,rule,'装饰层必须声明 pointer-events:none');
  }
  if(important>config.maxImportant)add(file,null,`!important ${important} 处，超过 ${config.maxImportant}`);
  if(animated&&!reduced)add(file,null,'动画未在 prefers-reduced-motion:reduce 中关闭');
 }
 const resourceFiles=resourceSources?Object.keys(resourceSources):filesIn(path.join(ROOT,'ui')).filter(f=>/\.(?:html?|css|js|svg)$/i.test(f));
 for(const file of resourceFiles){
  const source=resourceSources?resourceSources[file]:fs.readFileSync(file,'utf8'),clean=stripComments(source);
  if(file.endsWith('.css')&&/@import\b/i.test(clean))add(file,null,'禁止 CSS @import');
  for(const m of clean.matchAll(/url\(\s*(["']?)([^)'"\s]+)\1\s*\)/gi)){resources++;if(remote(m[2]))add(file,null,'外链 CSS 资源：'+m[2]);}
  // a[href]、placeholder、xmlns 和 action 打开官方网址是用户链接，不是自动加载的资源。
  for(const m of source.matchAll(/<(script|link|img|iframe|source|video|audio|object|embed|image|use)\b([^>]*?)>/gi))for(const a of m[2].matchAll(/\b(src|href|xlink:href|poster|data|srcset)\s*=\s*(["'])(.*?)\2/gi)){resources++;for(const u of a[3].split(',').map(s=>s.trim().split(/\s+/)[0]))if(remote(u))add(file,null,`外链 ${m[1]}[${a[1]}]：${u}`);}
  if(file.endsWith('.js')){
   for(const m of source.matchAll(/(?:\b(?:fetch|import|importScripts|Worker|WebSocket)\s*\(|\.src\s*=\s*)(["'`])(https?:\/\/[^"'`]+)\1/g))add(file,null,'脚本自动加载外链：'+m[2]);
  }
 }
 return {ok:!issues.length,skins:skins.length,declarations,resourceReferences:resources,issues};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const r=checkSkin();console.log(JSON.stringify(r,null,2));if(!r.ok)process.exitCode=1;}
