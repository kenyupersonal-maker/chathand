import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const fail=code=>{throw Object.assign(Error(code),{code});};
function relativeName(value) {
  if(typeof value!=='string'||!value||value.includes('\\')||value.includes('\0')||path.posix.isAbsolute(value)||/^[A-Za-z]:/.test(value)||value.split('/').some(part=>!part||part==='.'||part==='..'))fail('BAD_MANIFEST_PATH');
  return value;
}
export function payloadInventory(directory,{omit=[]}={}) {
  if(fs.lstatSync(directory).isSymbolicLink()||!fs.statSync(directory).isDirectory())fail('PAYLOAD_ROOT_INVALID');
  const base=fs.realpathSync(directory),excluded=new Set(omit.map(relativeName)),files=[];
  function visit(parent) {
    for(const name of fs.readdirSync(parent).sort()) {
      const file=path.join(parent,name),rel=path.relative(base,file).split(path.sep).join('/');relativeName(rel);
      if(excluded.has(rel))continue;
      const stat=fs.lstatSync(file);
      if(stat.isSymbolicLink()) {
        const link=fs.readlinkSync(file);
        if(path.isAbsolute(link)||path.win32.isAbsolute(link)||link.includes('\0'))fail('PAYLOAD_LINK_ESCAPE');
        let target;try{target=fs.realpathSync(file);}catch{fail('PAYLOAD_LINK_BROKEN');}
        if(target!==base&&!target.startsWith(base+path.sep))fail('PAYLOAD_LINK_ESCAPE');
        files.push({path:rel,link});
      } else if(stat.isDirectory())visit(file);
      else if(stat.isFile())files.push({path:rel,bytes:stat.size,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
      else fail('PAYLOAD_FILE_TYPE');
    }
  }
  visit(base);return files;
}
export function verifyPayload(directory,entries,options) {
  if(!Array.isArray(entries)||entries.length===0)fail('PAYLOAD_MANIFEST_INVALID');
  const expected=new Map();
  for(const entry of entries) {
    if(!entry||typeof entry!=='object')fail('PAYLOAD_MANIFEST_INVALID');
    const name=relativeName(entry.path);
    if(expected.has(name))fail('PAYLOAD_DUPLICATE_ENTRY');
    if(entry.link!==undefined) {
      if(typeof entry.link!=='string'||entry.sha256!==undefined||entry.bytes!==undefined)fail('PAYLOAD_MANIFEST_INVALID');
    } else if(!/^[a-f0-9]{64}$/.test(entry.sha256)||!Number.isSafeInteger(entry.bytes)||entry.bytes<0)fail('PAYLOAD_MANIFEST_INVALID');
    expected.set(name,entry);
  }
  const actual=payloadInventory(directory,options);
  if(actual.length!==expected.size)fail('PAYLOAD_PATH_SET_MISMATCH');
  for(const entry of actual) {
    const wanted=expected.get(entry.path);
    if(!wanted)fail('PAYLOAD_PATH_SET_MISMATCH');
    if(entry.link!==wanted.link)fail('PAYLOAD_LINK_MISMATCH');
    if(entry.sha256!==wanted.sha256||entry.bytes!==wanted.bytes)fail('PAYLOAD_HASH_MISMATCH');
  }
  return {entries:actual.length,verified:true};
}
