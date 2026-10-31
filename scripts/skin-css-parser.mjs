/* 不下载解析依赖。按引号、注释、括号和大括号分层，保留规则与声明顺序。 */
export const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g,' '));
export function splitTop(s, delimiter=';') {
  let q='',depth=0,start=0,out=[];
  for(let i=0;i<s.length;i++) {const c=s[i];if(q){if(c==='\\')i++;else if(c===q)q='';continue;}if(c==='"'||c==="'"){q=c;continue;}if(c==='('||c==='[')depth++;if(c===')'||c===']')depth--;if(c===delimiter&&depth===0){out.push(s.slice(start,i));start=i+1;}}
  out.push(s.slice(start));return out;
}
export function declarations(body) {return splitTop(body).flatMap(s=>{const p=s.indexOf(':');return p<0?[]:[{prop:s.slice(0,p).trim(),value:s.slice(p+1).trim()}]}).filter(d=>d.prop);}
export function cssRules(source,ancestors=[]) {
  const s=stripComments(source),out=[];let i=0;
  while(i<s.length){while(/\s|;/.test(s[i]||'')&&i<s.length)i++;if(i>=s.length)break;const begin=i;let q='',par=0;
    while(i<s.length){const c=s[i];if(q){if(c==='\\')i++;else if(c===q)q='';}else if(c==='"'||c==="'")q=c;else if(c==='('||c==='[')par++;else if(c===')'||c===']')par--;else if(!par&&(c==='{'||c===';'))break;i++;}
    const selector=s.slice(begin,i).trim();if(s[i]===';'||i===s.length){out.push({selector,ancestors,declarations:[],statement:true});i++;continue;}
    const start=++i;let depth=1;q='';for(;i<s.length&&depth;i++){const c=s[i];if(q){if(c==='\\')i++;else if(c===q)q='';}else if(c==='"'||c==="'")q=c;else if(c==='{')depth++;else if(c==='}')depth--;}
    if(depth)throw Error('CSS 大括号未闭合：'+selector);
    const body=s.slice(start,i-1);
    if(/^@(media|supports|layer|container|(?:-webkit-)?keyframes)\b/.test(selector))out.push(...cssRules(body,[...ancestors,selector]));
    else out.push({selector,ancestors,declarations:declarations(body),body});
  }return out;
}
export function htmlStyles(source) {
  const out=[];
  for(const m of source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))out.push(...cssRules(m[1]));
  for(const m of source.matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi))out.push({selector:'[inline style]',ancestors:[],declarations:declarations(m[2])});
  for(const m of source.matchAll(/\b(fill|stroke|stop-color|flood-color|lighting-color)\s*=\s*(["'])(.*?)\2/gi))out.push({selector:'[SVG color]',ancestors:[],declarations:[{prop:m[1],value:m[3]}]});
  return out;
}
export function valueWords(value) {
  // URL 中的 #片段、字体名字和文本都不是颜色；保留 var() 的 fallback。
  return stripComments(value).replace(/url\(\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^)]*)\s*\)/gi,'').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,'').match(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(|(?<![-\w])[a-z][a-z-]*(?![-\w])/gi)||[];
}
