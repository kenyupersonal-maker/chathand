/** Disposable UI harness. Real app/backend; offline tunnel child replaces only the external service. */
import fs from 'node:fs';import path from 'node:path';import readline from 'node:readline';
import {createDesktop} from '../app/server.mjs';import {makeBinary} from '../test-support/oneclick-helpers.mjs';
const dir=process.argv[2];if(!dir||!path.isAbsolute(dir))throw Error('TEMP_DIRECTORY_REQUIRED');
const stateDir=path.join(dir,'state'),defaultRoot=path.join(dir,'workspace');let b,generation=0,stopping=false;
const binary=makeBinary(dir);
async function boot(){b=await createDesktop({stateDir,defaultRoot,lock:false});generation++;
 fs.writeFileSync(path.join(dir,'ui-runtime.json'),JSON.stringify({origin:`http://127.0.0.1:${b.apiPort}`,url:b.ui,admin:b.adminToken,mcp:`http://127.0.0.1:${b.mcpPort}/mcp`,mcpToken:b.mcpToken,workspace:b.store.root,stateDir,binary,generation}),{mode:0o600});}
await boot();const lines=readline.createInterface({input:process.stdin});let commands=Promise.resolve();
lines.on('line',line=>{commands=commands.then(async()=>{const d=JSON.parse(line);if(d.command==='restart'){await b.close();await boot();}}).catch(e=>{console.error(e.message);process.exitCode=1;});});
async function stop(){if(stopping)return;stopping=true;lines.close();await b.close();}
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,stop);
