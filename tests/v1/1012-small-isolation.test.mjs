import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createDesktop} from '../../app/server.mjs';
test('isolated service ignores inherited helper configuration and uses local encrypted credentials',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1012-isolation-')),previous=process.env.CHATHAND_CREDENTIAL_HELPER;let app;
 process.env.CHATHAND_CREDENTIAL_HELPER=path.join(root,'must-not-execute');
 t.after(async()=>{if(app)await app.close();if(previous===undefined)delete process.env.CHATHAND_CREDENTIAL_HELPER;else process.env.CHATHAND_CREDENTIAL_HELPER=previous;fs.rmSync(root,{recursive:true,force:true});});
 const tunnel={child:null,doctorChild:null,log:[],snapshot:async()=>({ready:false,healthy:false}),stop(){}};
 const updater={start(){},close(){},snapshot:()=>({status:'unknown',install:{state:'idle'}})};
 app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:path.join(root,'work'),adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{computerName:()=> 'Fixture Mac',tunnelFactory:()=>tunnel,updaterFactory:()=>updater}});
 const state=await app.snapshot();assert.equal(state.credentials.format,'local-encrypted-json');assert.equal(state.credentials.healthy,true);assert.equal(state.setup_skill.installed,false);
});
