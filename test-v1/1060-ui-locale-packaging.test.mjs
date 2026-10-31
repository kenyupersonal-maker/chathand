import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {fillEmptyEnglish,generatedUILocaleFiles,writeUILocaleResources} from '../scripts/ui-locale-resources.mjs';

test('Claude English fills only empty values and preserves prior translations byte for byte',()=>{
 const tables={zh:{'ui.a.text':'你好 {name}','ui.a.existing':'完成','ui.a.empty':'空'},en:{'ui.a.text':'','ui.a.existing':' Done  ','ui.a.empty':''}};
 const result=fillEmptyEnglish(tables,{'ui.a.text':'Hello {name}','ui.a.existing':'Do not overwrite','ui.a.empty':''});
 assert.equal(result.filled,1);assert.equal(result.en['ui.a.existing'],' Done  ');assert.equal(result.en['ui.a.text'],'Hello {name}');assert.equal(tables.en['ui.a.text'],'');
 assert.throws(()=>fillEmptyEnglish(tables,{'ui.a.text':'Hello {wrong}'}),/I18N_PLACEHOLDER_MISMATCH ui.a.text/);
 assert.throws(()=>fillEmptyEnglish(tables,{'ui.a.unknown':'new'}),/I18N_CHINESE_MISSING/);
});
test('generated catalogs and inline cards share the authoritative tables without script breakout or remote resources',t=>{
 const repo=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-ui-locale-packaging-'));t.after(()=>fs.rmSync(repo,{recursive:true,force:true}));
 fs.mkdirSync(path.join(repo,'ui'));fs.mkdirSync(path.join(repo,'locales'));
 const tables={zh:{'ui.taskWidget.title':'任务 </script><script>bad()</script>','ui.imageBatch.title':'图片','ui.window.title':'窗口','native.title':'系统'},en:{'ui.taskWidget.title':'','ui.imageBatch.title':'','ui.window.title':'','native.title':''}};
 for(const lang of ['zh','en'])fs.writeFileSync(path.join(repo,'locales',lang+'.json'),JSON.stringify(tables[lang]));
 fs.writeFileSync(path.join(repo,'ui/local-text.js'),'globalThis.ChatHandText={t:key=>globalThis.__CHATHAND_TEXT_CATALOGS__.zh[key]};');
 for(const name of ['task-widget.html','image-batch-widget.html'])fs.writeFileSync(path.join(repo,'ui',name),'<!doctype html><!-- CHATHAND_LOCAL_TEXT_INLINE --><body>original</body>');
 const files=generatedUILocaleFiles(repo,tables),html=files['ui/task-widget.html'];
 assert.equal((html.match(/<script>/g)||[]).length,1);assert.ok(html.includes('<body>original</body>'));assert.ok(!html.includes('ui.window.title'));assert.ok(!html.includes('native.title'));assert.doesNotMatch(html,/<script\b[^>]+src=/);
 const context={};vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);assert.equal(context.ChatHandText.t('ui.taskWidget.title'),tables.zh['ui.taskWidget.title']);
 writeUILocaleResources(repo);assert.deepEqual(writeUILocaleResources(repo,{check:true}).sort(),Object.keys(files).sort());
 fs.appendFileSync(path.join(repo,'ui/local-text-catalogs.js'),'stale');assert.throws(()=>writeUILocaleResources(repo,{check:true}),/I18N_GENERATED_STALE/);
});
