import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {workspaceFixture} from '../support/workspace-recovery-fixture.mjs';

async function openScope(t,f){
 const browser=await chromium.launch({headless:true,...(process.env.CHATHAND_TEST_CHROME?{executablePath:process.env.CHATHAND_TEST_CHROME}:{})});
 t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:980,height:680}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(({folder})=>{window.webkit={messageHandlers:{native:{postMessage(message){const result=message.action==='chooseFolder'?{path:folder}:message.action==='getLocalTextCatalogs'?{locale:'zh',preference:'zh'}:{};queueMicrotask(()=>window.nativeReply?.({id:message.id,result}));}}}};},{folder:f.other});
 await page.goto(f.origin+'/#'+f.app.adminToken+'.'+f.uiKey,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>typeof S==='object'&&S&&ChatHandStream.status()==='live');
 if(await page.locator('#h10Host [data-action="dismiss"]').isVisible())await page.locator('#h10Host [data-action="dismiss"]').click();
 if(await page.locator('#drawer[open]').count())await page.evaluate(()=>closeDrawer());
 await page.waitForFunction(()=>!document.querySelector('#drawer').open);
 async function scope(){await page.locator('#rail [data-k="permission-scope"]').click();await page.waitForFunction(()=>!workspaceChecking&&S.project.workspace.status!=='unchecked');}
 await scope();
 return {page,scope,errors};
}

test('invalid path and a missing parent offer folder selection without an impossible recreate action',async t=>{
 for(const pathValue of [null,({root})=>path.join(root,'disconnected-volume','workspace')]){
  const f=await workspaceFixture(t,{missing:false,pathValue}),{page,errors}=await openScope(t,f);
  const notice=page.locator('#drawerBody [data-k="workspace-recovery"]');
  assert.equal(await notice.locator('[data-action="workspaceRecreate"]').count(),0);
  assert.equal(await notice.locator('[data-action="workspacePick"]').isVisible(),true);
  await notice.locator('[data-action="workspacePick"]').click();
  await page.waitForFunction(folder=>S.project.path===folder,f.other);
  assert.equal(f.app.store.read('other.txt').content,'OTHER_PROJECT');assert.deepEqual(errors,[]);
  await page.close();await f.close();
 }
});

test('an original folder that returns can be explicitly used without recreating it',async t=>{
 const f=await workspaceFixture(t,{missing:true}),{page,scope,errors}=await openScope(t,f);
 let notice=page.locator('#drawerBody [data-k="workspace-recovery"]');
 assert.equal(await notice.locator('[data-action="workspaceRecreate"]').textContent(),'重建此文件夹');
 fs.renameSync(f.preserved,f.work);
 await page.evaluate(()=>closeDrawer());await page.waitForFunction(()=>!document.querySelector('#drawer').open);
 await scope();notice=page.locator('#drawerBody [data-k="workspace-recovery"]');
 assert.equal(await notice.locator('[data-action="workspaceRecreate"]').textContent(),'继续使用');
 await notice.locator('[data-action="workspaceRecreate"]').click();
 await page.waitForFunction(()=>S.project.workspace.available===true);
 assert.equal(f.app.store.read('original.txt').content,'ORIGINAL_PROJECT');assert.deepEqual(errors,[]);
});
