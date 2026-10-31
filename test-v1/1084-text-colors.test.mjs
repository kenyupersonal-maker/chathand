import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 1084（Ken 10/29）：文字颜色同一档只有一个色值，不按对比度调深。主窗口 ui/style.css 是准；
// 安装流程（H10 向导、安装盘两页和背景图）和 ChatGPT 里的两张卡都用这一套值。只比源文件里写的值。
const read=file=>fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
const TIERS=['--ink','--ink-2','--ink-3','--ink-4','--accent','--accent-ink','--g-ink','--o-ink'];

function block(source,marker){
 const at=source.indexOf(marker);assert.ok(at>=0,'missing block '+marker);
 const brace=marker.lastIndexOf('{'),open=brace>=0?at+brace:source.indexOf('{',at),close=source.indexOf('}',open);
 const body=source.slice(open+1,close);assert.ok(!body.includes('{'),'nested block after '+marker);
 return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)].map(m=>[m[1],m[2].trim()]));
}
const hex=value=>{let h=value.slice(1);if(h.length===3)h=[...h].map(c=>c+c).join('');assert.equal(h.length,6,value);return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16));};
function oklch(L,C,H){
 const h=H*Math.PI/180,a=C*Math.cos(h),b=C*Math.sin(h);
 const l=(L+.3963377774*a+.2158037573*b)**3,m=(L-.1055613458*a-.0638541728*b)**3,s=(L-.0894841775*a-1.291485548*b)**3;
 const enc=x=>{x=Math.max(0,Math.min(1,x));return Math.round((x<=.0031308?12.92*x:1.055*x**(1/2.4)-.055)*255);};
 return [4.0767416621*l-3.3077115913*m+.2309699292*s,-1.2684380046*l+2.6097574011*m-.3413193965*s,-.0041960863*l-.7034186147*m+1.707614701*s].map(enc);
}
// 解析到 sRGB：#hex，或主窗口那种 oklch(calc(L + var(--theme-l)) calc(C * var(--theme-c)) calc(var(--theme-h) ± H))。
function rgb(value,theme){
 if(/^#[\da-f]{3}([\da-f]{3})?$/i.test(value))return hex(value);
 const m=value.match(/^oklch\(calc\(([\d.]+) \+ var\(--theme-l\)\) calc\(([\d.]+) \* var\(--theme-c\)\) calc\(var\(--theme-h\) ([+-]) ([\d.]+)\)\)$/);
 assert.ok(m,'unexpected color value '+value);
 return oklch(Number(m[1])+Number(theme['--theme-l']),Number(m[2])*Number(theme['--theme-c']),Number(theme['--theme-h'])+(m[3]==='-'?-1:1)*Number(m[4]));
}
const same=(actual,expected,label)=>assert.ok(actual.every((v,i)=>Math.abs(v-expected[i])<=1),`${label}: ${actual} vs ${expected}`);

const style=read('ui/style.css'),mainLight=block(style,':root{');
const main={light:mainLight,dark:{...mainLight,...block(style,'  :root:not([data-theme="light"]){')},forced:{...mainLight,...block(style,':root[data-theme="dark"]{')}};
const app={light:Object.fromEntries(TIERS.map(t=>[t,rgb(main.light[t],main.light)])),dark:Object.fromEntries(TIERS.map(t=>[t,rgb(main.dark[t],main.dark)]))};

test('main window: both dark-theme blocks carry the same text tiers',()=>{
 for(const t of TIERS)same(rgb(main.forced[t],main.forced),app.dark[t],'forced dark '+t);
 assert.deepEqual(app.light['--g-ink'],[0,152,123]);assert.deepEqual(app.dark['--g-ink'],[0,226,184]);
});

test('offline H10 theme mirrors the main window text tiers',()=>{
 const css=read('ui/assets/dmg/src/h10-offline-theme.css'),light=block(css,':root {');
 const themes={light,dark:{...light,...block(css,'  :root:not([data-theme="light"]) {')},forced:{...light,...block(css,':root[data-theme="dark"] {')}};
 for(const [name,tokens] of Object.entries(themes))for(const t of TIERS.filter(t=>t!=='--ink-4'))same(rgb(tokens[t],tokens),app[name==='light'?'light':'dark'][t],`offline ${name} ${t}`);
});

test('H10 does not redefine text tiers; its mint text is the app green',()=>{
 const css=read('ui/h10/h10.css');
 for(const t of TIERS)assert.ok(!new RegExp('(^|[\\s;{])'+t+'\\s*:','m').test(css),'h10.css must not set '+t);
 assert.deepEqual([...css.matchAll(/--mint-ink\s*:\s*([^;}]+)/g)].map(m=>m[1].trim()),['var(--g-ink)']);
 assert.ok(!/--wizard-(green|orange)-text/.test(read('ui/wizard.css')),'wizard text mixes are gone');
});

test('install pages and the Finder background use the same values',()=>{
 const theme=read('ui/assets/dmg/src/theme.css'),light=block(theme,':root{'),dark=block(theme,'@media (prefers-color-scheme:dark){:root{');
 const pairs=[['--ink','--ink'],['--ink-2','--ink-2'],['--ink-3','--ink-3'],['--accent','--accent'],['--accent-ink','--accent-ink'],['--o-ink','--o-ink'],['--mint-ink','--g-ink']];
 for(const [name,tokens] of [['light',light],['dark',dark]]){
  for(const [local,tier] of pairs)same(hex(tokens[local]),app[name][tier],`theme.css ${name} ${local}`);
  assert.equal(tokens['--chip-ink'],'var(--ink-3)');
 }
 const background=block(read('ui/assets/dmg/src/background.template.html'),':root{color-scheme:light;');
 for(const [local,tier] of [['--ink','--ink'],['--ink-2','--ink-2'],['--ink-3','--ink-3'],['--ink-4','--ink-4'],['--mint-ink','--g-ink']])same(hex(background[local]),app.light[tier],'background '+local);
 assert.equal(background['--chip-ink'],'var(--ink-3)');
});

test('the two ChatGPT cards use the same values',()=>{
 const widget=read('ui/task-widget.html'),batch=read('ui/image-batch-widget.html');
 const cards=[
  [widget,'--widget-ink',{'--widget-ink':'--ink','--widget-secondary':'--ink-2','--widget-note':'--ink-3','--widget-ok':'--g-ink','--widget-tl-ok':'--g-ink','--widget-warn':'--o-ink','--widget-primary':'--accent','--widget-on-primary':'--accent-ink'}],
  [batch,'--ink',{'--ink':'--ink','--sub':'--ink-2','--faint':'--ink-3','--ok':'--g-ink','--warn':'--o-ink'}]
 ];
 for(const [source,first,map] of cards)for(const [name,marker] of [['light',':root{'+first],['dark',':root:not([data-theme="light"]){'+first],['dark',':root[data-theme="dark"]{'+first]]){
  const tokens=block(source,marker);
  for(const [local,tier] of Object.entries(map))same(hex(tokens[local]),app[name][tier],`${marker.slice(0,24)} ${local}`);
 }
});

test('install-family text colors only use the tiers',()=>{
 const allowed=new Set([...TIERS,'--mint-ink','--chip-ink'].map(t=>`var(${t})`).concat(['inherit','currentColor','#fff']));
 for(const file of ['ui/h10/h10.css','ui/h10/host.css','ui/wizard.css','ui/assets/dmg/src/theme.css','ui/assets/dmg/src/jump.template.html','ui/assets/dmg/src/first-open.template.html','ui/assets/dmg/src/background.template.html']){
  const values=[...read(file).matchAll(/(?<![-\w])color\s*:\s*([^;}"]+)/g)].map(m=>m[1].replace(/!important/,'').trim());
  assert.deepEqual(values.filter(v=>!allowed.has(v)),[],file);
 }
});
