#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../../..'),BASE=path.join(process.env.CHATHAND_BUILDS_ROOT||path.join(os.homedir(),'Developer','ChatHand-builds.noindex'),'1012-validation/sa6');
if(!process.env.CHATHAND_UI_OUTPUT)fs.mkdirSync(BASE,{recursive:true});const OUT=process.env.CHATHAND_UI_OUTPUT||fs.mkdtempSync(path.join(BASE,'run-'));
process.env.CHATHAND_UI_OUTPUT=OUT;fs.mkdirSync(OUT,{recursive:true});
const only=(process.argv.find(x=>x.startsWith('--only='))?.slice(7)||'').split(',').filter(Boolean),results=[];
async function run(name,args){if(only.length&&!only.includes(name))return;
 console.log('\n[1012] '+name);const log=fs.createWriteStream(path.join(OUT,name+'.log'));const before=Date.now();
 const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd:ROOT,env:process.env,stdio:['ignore','pipe','pipe']});for(const s of [child.stdout,child.stderr])s.on('data',chunk=>{log.write(chunk);process.stdout.write(chunk);});const timer=setTimeout(()=>child.kill('SIGTERM'),240000);child.on('error',reject);child.on('exit',(code,signal)=>{clearTimeout(timer);resolve(code??signal);});});
 log.end();results.push({name,code,ok:code===0,elapsed_ms:Date.now()-before});
}
(async()=>{const temp=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-ui-1012-'));process.env.CHATHAND_STATE_DIR=temp;const server=await require('./server').start();process.env.CHATHAND_UI_URL=server.url;
 try{
  await run('setup-1013',['tests/ui/1012/checks/setup-1013.cjs']);
  await run('static',['tests/ui/harness/check.js','--only=静态,皮肤']);
  for(const name of ['stream','continuity','clocks','actions','update-check','dialog-alignment','matrix','ui2-behavior','ui2-races','ui2-matrix','ui2-accessibility','ui2-boundaries','uiv-behavior','uiv-matrix','uiv-long','uiv-final','font-scale','grid-snap'])await run(name,['tests/ui/1012/checks/'+name+(name.startsWith('uiv-')?'.cjs':'.js')]);
  await run('skin-mechanism',['tests/ui/harness/skin-mechanism.js']);
  await run('install-pages',['ui/assets/dmg/src/verify.mjs']);
  await run('real-main',['--test','tests/v1/1012-main-service-ui.test.mjs','tests/v1/1012-static-assets.test.mjs']);
  await run('management-contract',['--test','--test-name-pattern=reset exposes','tests/v1/static-skin.test.mjs']);
 }finally{await server.close();fs.rmSync(temp,{recursive:true,force:true});fs.writeFileSync(path.join(OUT,'summary.json'),JSON.stringify({ok:results.every(r=>r.ok),results},null,2));}
 console.log('\n1012 groups: '+results.filter(r=>r.ok).length+'/'+results.length);if(results.some(r=>!r.ok))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
