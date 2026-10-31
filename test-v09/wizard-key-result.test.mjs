import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {t as translate} from '../app/i18n.mjs';

function loadPasteResultResolver(){
 const element=()=>({setAttribute(){},addEventListener(){}});
 const window={addEventListener(){}};
 const context={window:{...window,ChatHandText:{t:(key,params={})=>translate(key,params,'zh'),subscribe(){}}},document:{createElement:element,body:{append(){}}}};
 vm.createContext(context);
 vm.runInContext(fs.readFileSync('ui/wizard.js','utf8').replace(" const box=document.createElement"," window.__resolvePasteRuntimeKeyResponse=resolvePasteRuntimeKeyResponse; const box=document.createElement"),context,{filename:'ui/wizard.js'});
 return context.window.__resolvePasteRuntimeKeyResponse;
}

test('wizard only accepts last4 after an explicit successful save and safely maps failures',()=>{
 const resolve=loadPasteResultResolver();
 assert.deepEqual({...resolve({saved:true,last4:'aB9x'})},{saved:true,last4:'aB9x'});

 const knownFailure=resolve({saved:false,last4:'LEAK',error_code:'CREDENTIAL_WRITE_VERIFY_FAILED'});
 assert.equal(knownFailure.saved,false);
 assert.equal(Object.hasOwn(knownFailure,'last4'),false);
 assert.equal(knownFailure.error,translate('ui.wizard.keyWriteFailed',{},'zh'));
 assert.doesNotMatch(knownFailure.error,/CREDENTIAL_WRITE_VERIFY_FAILED|LEAK|钥匙串/);

 const unknownFailure=resolve({saved:false,error_code:'secret-value-must-not-appear'});
 assert.equal(unknownFailure.saved,false);
 assert.doesNotMatch(unknownFailure.error,/secret-value-must-not-appear/);

 const legacyError=resolve({error:{message:'现有原生错误信息'}});
 assert.equal(legacyError.error,'现有原生错误信息');
});
