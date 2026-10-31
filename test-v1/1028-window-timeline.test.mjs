// 1028：窗口外框（更新后顶上、右边的白边；全屏顶上的黑条）、时间线节点改样子、收尾回复不提「没有失败」。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('window: the page is in the window before the saved zoom resizes it, and full screen is re-filled after the system settles',()=>{
 const swift=read('native/main.swift');
 const add=swift.indexOf('window.contentView!.addSubview(web)'),zoom=swift.indexOf('ClientFeatures.setUIZoom(zoom: savedZoom, web: web, window: window, remember: false)'),fit=swift.indexOf('web.frame = window.contentView!.bounds');
 assert.ok(add>0&&zoom>add&&fit>zoom,'add the web view first, then zoom (which can grow the window), then fit the web view to the window');
 assert.equal(swift.includes('window.contentView!.addSubview(web);show()'),false);
 assert.match(swift,/func windowDidEnterFullScreen\(_ n: Notification\) \{\n\s+fillScreenIfFullScreen\(\)\n\s+for delay in \[0\.3, 1\.0\]/);
 assert.ok(swift.includes('if let webView = web, let content = w.contentView, webView.frame != content.bounds { webView.frame = content.bounds }'));
});

test('timeline: line and circles drawn the same way and the same width; running = arc spinner, no fill or dot; waiting = two equal light hands, no centre dot',()=>{
 const css=read('ui/style.css'),ui=read('ui/app.js');
 assert.ok(css.includes('.tl{--tl-w:1px;'));
 assert.ok(css.includes('.tl li:not(:last-child)::after{content:"";position:absolute;left:calc(10px - var(--tl-w) / 2);top:20px;bottom:0;width:0;border-left:var(--tl-w) solid var(--line-2)}'));
 assert.ok(css.includes('border:var(--tl-w,1px) solid var(--line-2)'));
 assert.equal(css.includes('.nd.run::before'),false,'the old outside arc is gone');assert.equal(css.includes('.nd.idle::after'),false,'no centre dot');
 assert.equal(/\.nd\.ok,\.nd\.run\{/.test(css),false,'the running node has no green fill');
 assert.ok(css.includes('@keyframes ndarc{0%{stroke-dasharray:1 200;stroke-dashoffset:0}50%{stroke-dasharray:42 200;stroke-dashoffset:-16}100%{stroke-dasharray:42 200;stroke-dashoffset:-59}}'));
 assert.ok(css.includes('.nd.idle i{position:absolute;left:50%;top:50%;width:1.2px;height:6.6px;margin:-6px 0 0 -.6px;border-radius:.6px;background:var(--line-2-solid);transform-origin:50% calc(100% - .6px)}'),'both hands use checkmark-like weight and overlap at the centre');
 assert.equal((css.match(/--line-2-solid:/g)||[]).length,3,'light, dark (system) and dark (chosen)');
 assert.ok(ui.includes('<span class="nd run" aria-hidden="true"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="9.5"/></svg></span>'));
 assert.equal(ui.includes('<span class="nd run"><i></i></span>'),false);
});

test('running task ring uses one continuous mask, not eight edge/corner masks',()=>{
 const css=read('ui/style.css'),a=css.indexOf('.tp-ring{inset:0;z-index:2;padding:var(--ring-w,1px)'),b=css.indexOf('.tp-glow{',a);assert.ok(a>0&&b>a);const ring=css.slice(a,b);
 assert.match(ring,/-webkit-mask:linear-gradient\(var\(--mask-cutout\) 0 0\) content-box/);assert.match(ring,/-webkit-mask-composite:xor/);assert.doesNotMatch(ring,/mask-position|radial-gradient|--s1|--s2/);
 assert.match(css,/\.tp\.swapping \.tp-ring,\.tp\.swapping \.tp-glow\{opacity:0\}/);
});

test('finish_task reply rule: no "there were no failures" line when everything passed',async()=>{
 const tools=read('app/tools.mjs');
 assert.ok(tools.includes('全都过了就不提失败，也不写「没有失败」这类话'));assert.equal(tools.includes('最多 5 行：没过的原话、成果位置、下一步'),false);
});
