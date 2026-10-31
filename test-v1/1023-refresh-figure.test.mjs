import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
test('updated bubble shows where 刷新工具 is: a 16:9 redrawn figure with the button ringed',()=>{
 const app=fs.readFileSync(new URL('../ui/app.js',import.meta.url),'utf8'),css=fs.readFileSync(new URL('../ui/style.css',import.meta.url),'utf8');
 assert.ok(app.includes('function refreshToolsFigure()'));assert.ok(app.includes('viewBox=\\"0 0 320 180\\"'));assert.ok(app.includes('${refreshToolsFigure()}'));
 const zh=JSON.parse(fs.readFileSync(new URL('../locales/zh.json',import.meta.url),'utf8')),en=JSON.parse(fs.readFileSync(new URL('../locales/en.json',import.meta.url),'utf8'));
 for(const key of ['ui.window.refreshToolsFigure.text4','ui.window.refreshToolsFigure.text6','ui.window.refreshToolsFigure.text7','ui.window.refreshToolsFigure.label']){assert.ok(app.includes(key),key);assert.ok(zh[key]&&en[key],`${key} has both locales`);}
 assert.match(zh['ui.window.refreshToolsFigure.label'],/管理应用.*刷新工具/);assert.match(en['ui.window.refreshToolsFigure.label'],/Manage app.*Refresh tools/i);
 assert.match(css,/\.bubble \.rt-fig\{[^}]*aspect-ratio:16\/9/);
 const rules=css.slice(css.indexOf('.rt-bg{'),css.indexOf('.rt-cursor{')+200);assert.doesNotMatch(rules,/#[0-9a-f]{3,8}\b|rgba?\(/i);
});

test('current stable card URIs and legacy aliases serve the current card; no card at task start',async()=>{
 const {TASK_URI,LEGACY_TASK_URI,Features}=await import('../app/v06/features.mjs');const {IMAGE_BATCH_URI}=await import('../app/v1/image-batch.mjs');
 const {TOOLS}=await import('../app/tools.mjs');const {WORKFLOW_INSTRUCTIONS}=await import('../app/v1/workflow.mjs');
 assert.equal(TASK_URI,'ui://chathand/task.html');assert.equal(IMAGE_BATCH_URI,'ui://chathand/image-batch.html');
 const f=Object.create(Features.prototype),now=f.resource(TASK_URI).contents[0].text,old=f.resource(LEGACY_TASK_URI).contents[0].text;assert.equal(old,now);assert.ok(now.includes('你要做'));
 for(const n of ['show_task','finish_task'])assert.equal(TOOLS.find(x=>x.name===n)._meta['openai/outputTemplate'],TASK_URI);
 assert.ok(WORKFLOW_INSTRUCTIONS.includes('Do not call show_task at the start'));assert.ok(TOOLS.find(x=>x.name==='show_task').description.includes('普通任务开工不调它'));
});
