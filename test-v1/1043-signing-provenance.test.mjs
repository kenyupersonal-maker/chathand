import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {signApplication,SIGNING_IDENTITY,BUNDLE_ID} from '../scripts/signing.mjs';

test('binary provenance freezes signed inner bytes before outer resource seal',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-signing-provenance-'));
 try{
  const app=path.join(root,'Fixture.app'),bin=path.join(app,'Contents/Resources/runtime/bin/ken-artifact-io'),record=path.join(app,'Contents/Resources/runtime/build-provenance.json');
  fs.mkdirSync(path.dirname(bin),{recursive:true});fs.writeFileSync(bin,Buffer.from('cffaedfe00000000','hex'));
  const sha=()=>crypto.createHash('sha256').update(fs.readFileSync(bin)).digest('hex'),before=sha();let sealed=false,hookCalls=0;
  const run=(program,args)=>{
   if(program.endsWith('/security'))return SIGNING_IDENTITY;
   if(program.endsWith('/PlistBuddy'))return BUNDLE_ID;
   if(args[0]==='--force'&&args.at(-1)===bin){assert.equal(sealed,false);fs.appendFileSync(bin,'signed-inner');}
   if(args[0]==='--force'&&args.at(-1)===app){assert.equal(hookCalls,1);assert.equal(JSON.parse(fs.readFileSync(record)).artifact_io_sha256,sha());assert.notEqual(sha(),before);sealed=true;}
   if(args[0]==='-dr')return `identifier "${BUNDLE_ID}" and certificate leaf = H"${SIGNING_IDENTITY}"`;
   return '';
  };
  const result=signApplication(app,run,{beforeSeal:()=>{hookCalls++;assert.equal(sealed,false);fs.writeFileSync(record,JSON.stringify({artifact_io_sha256:sha()}));}});
  assert.equal(sealed,true);assert.equal(result.verification,'deep_strict_pass');assert.equal(JSON.parse(fs.readFileSync(record)).artifact_io_sha256,sha());
  sealed=false;let sealAfterFailure=false;
  assert.throws(()=>signApplication(app,(program,args)=>{if(args[0]==='--force'&&args.at(-1)===app)sealAfterFailure=true;return run(program,args);},{beforeSeal:()=>{throw Error('PROVENANCE_WRITE_FAILED');}}),/PROVENANCE_WRITE_FAILED/);
  assert.equal(sealAfterFailure,false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
