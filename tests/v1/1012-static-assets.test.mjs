import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {createDesktop} from '../../app/server.mjs';
import {skinFile,isSkinAvailable,clientSettings,validateClientSettings} from '../../app/v1/client-features.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const output=process.env.CHATHAND_STATIC_SKIN_OUTPUT;
test('anonymous real main service serves local references in index, skin core and registry, tutorial and icon; rejects other paths',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1012-assets-'));let app;
 t.after(async()=>{await app?.close();fs.rmSync(root,{recursive:true,force:true});});
 app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:path.join(root,'work'),adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{computerName:()=> 'Isolated Mac',tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),updaterFactory:()=>({snapshot:()=>({status:'unknown',install:{state:'idle'}}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})}});
 const sources=['ui/index.html','ui/skin.js','ui/skins/registry.js'],references=new Set();
 // Extract resource filenames, including parser-written src and registry css values.
 // API route strings and the dynamic /skins/ prefix are not resource filenames.
 for(const source of sources)for(const row of fs.readFileSync(path.join(repo,source),'utf8').matchAll(/["'](\/[A-Za-z0-9_./-]+\.(?:js|css|json|webp|png|svg|woff2?))["']/g))references.add(row[1]);
 for(const route of ['/skin.js','/stream.js','/morph.js','/skins/registry.js','/skins/quiet-titanium.css'])assert.ok(references.has(route),route);
 references.add('/assets/tutorial/tutorial.json');references.add('/assets/app/AppIcon-rounded-512.png');
 const origin=`http://127.0.0.1:${app.apiPort}`,results=[];
 const html=await (await fetch(origin+'/?skin=quiet-titanium')).text();assert.match(html,/<html\b[^>]*data-skin-saved="default"/);assert.doesNotMatch(html,/<html\b[^>]*data-skin=/);
 app.state.data.skin='qinglu';app.state.save();assert.match(await (await fetch(origin+'/')).text(),/<html\b[^>]*data-skin-saved="qinglu"/);
 app.state.data.skin='quiet-titanium';app.state.save();assert.match(await (await fetch(origin+'/')).text(),/<html\b[^>]*data-skin-saved="quiet-titanium"/);
 const mimes={'.js':'text/javascript','.css':'text/css','.json':'application/json','.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2'};
 for(const route of references){const response=await fetch(origin+route),type=response.headers.get('content-type');assert.equal(response.status,200,route);const expected=mimes[path.extname(route)];assert.ok(type?.startsWith(expected),route+': '+type);assert.equal(response.headers.get('x-content-type-options'),'nosniff');if(/\.(js|css)$/.test(route)){assert.equal(type,expected+'; charset=utf-8');assert.match(response.headers.get('content-security-policy'),/script-src 'self'/);}await response.arrayBuffer();results.push({path:route,status:200,mime:type});}
 const denied=['/skins/../app.js','/skins/x.js','/skins/Default.css','/package.json','/app/server.mjs','/ui/app.js','/backdrops/no-such.js','/backdrops/Bad.js','/backdrops/../app.js'];
 for(const route of denied){const status=await new Promise((resolve,reject)=>{const request=http.get({hostname:'127.0.0.1',port:app.apiPort,path:route},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);});assert.equal(status,404,route);}
 if(output){fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'static-assets.json'),JSON.stringify({sources,resources:results,anonymous:true,denied,skin_saved_injected:true},null,2));}
});

test('skin filename rule and settings validation cover defaults, present files, absent ids and invalid characters',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1012-skins-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 for(const id of ['new-skin','1','a'.repeat(32)])fs.writeFileSync(path.join(directory,id+'.css'),'/* isolated rule fixture */');
 fs.mkdirSync(path.join(directory,'directory.css'));fs.symlinkSync(path.join(directory,'new-skin.css'),path.join(directory,'link.css'));
 for(const [id,expected] of [['default',true],['new-skin',true],['1',true],['a'.repeat(32),true],['a'.repeat(33),false],['absent',false],['Default',false],['../new-skin',false],['new_skin',false],['a.css',false],['directory',false],['link',false],[null,false],[{},false]])assert.equal(isSkinAvailable(id,directory),expected,String(id));
 assert.equal(skinFile('default',directory),null);assert.equal(clientSettings().skin,'default');assert.equal(clientSettings({skin:'default'}).skin,'default');assert.equal(clientSettings({skin:'absent'}).skin,'default');
 for(const [skin,valid] of [['default',true],['quiet-titanium',true],['absent',false],['Default',false],['../app',false],['quiet_titanium',false],['a'.repeat(33),false],[null,false],[{},false],[1,false]]){if(valid)assert.deepEqual(validateClientSettings({skin}),{skin});else assert.throws(()=>validateClientSettings({skin}),{code:'ARG_INVALID'});}
 const source=fs.readFileSync(path.join(repo,'ui/skin.js'),'utf8');assert.doesNotMatch(source,/localStorage|sessionStorage|chathand-skin-session/);assert.match(source,/dataset\.skinSaved/);
});
