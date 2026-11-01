import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import zlib from 'node:zlib';
import {evidencePNG,archiveInstallEvidence} from '../../app/v1/chrome-install-evidence.mjs';
const signature=Buffer.from([137,80,78,71,13,10,26,10]);
function crc(bytes){let n=0xffffffff;for(const byte of bytes){n^=byte;for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;}return (n^0xffffffff)>>>0;}
function chunk(type,data){const size=Buffer.alloc(4),sum=Buffer.alloc(4),body=Buffer.concat([Buffer.from(type),data]);size.writeUInt32BE(data.length);sum.writeUInt32BE(crc(body));return Buffer.concat([size,body,sum]);}
function png({text=false,width=2,badLength=false}={}){const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(2,4);header[8]=8;header[9]=2;return Buffer.concat([signature,chunk('IHDR',header),...(text?[chunk('tEXt',Buffer.from('Secret\0not permitted'))]:[]),chunk('IDAT',zlib.deflateSync(Buffer.alloc(badLength?2:14))),chunk('IEND',Buffer.alloc(0))]);}
test('1042 accepts bounded RGB PNG and saves only a private generated filename',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1042-evidence-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const bytes=png();assert.deepEqual(evidencePNG(bytes.toString('base64')),bytes);
 const receipt=archiveInstallEvidence({stateDir:root,image_base64:bytes.toString('base64')});assert.match(receipt.file,/^chrome-install-evidence\/chrome-install-[a-f0-9-]+\.png$/);assert.equal(fs.statSync(path.join(root,receipt.file)).mode&0o777,0o600);assert.deepEqual(fs.readFileSync(path.join(root,receipt.file)),bytes);
});
test('1042 rejects metadata, oversize dimensions, invalid pixel length, CRC and trailing bytes',()=>{
 const corrupted=png();corrupted[corrupted.length-1]^=1;
 for(const data of [png({text:true}),png({width:1601}),png({badLength:true}),corrupted,Buffer.concat([png(),Buffer.from('trailing')])])assert.throws(()=>evidencePNG(data.toString('base64')),{code:'INSTALL_EVIDENCE_INVALID'});
});
test('1042 archive rejects linked destination without writing outside its own directory',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1042-evidence-link-')),other=path.join(root,'other');fs.mkdirSync(other);fs.symlinkSync(other,path.join(root,'chrome-install-evidence'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));assert.throws(()=>archiveInstallEvidence({stateDir:root,image_base64:png().toString('base64')}),{code:'INSTALL_EVIDENCE_INVALID'});assert.deepEqual(fs.readdirSync(other),[]);
});
