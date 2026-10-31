import test from 'node:test';
import assert from 'node:assert/strict';
import {PROCESS_LAYOUT,validateProcessIdentityBaseline} from '../scripts/process-identity.mjs';
const certificate='13d3ef5eb9c743427123452cd966cbc8fd9ecf2d';
function baseline(){return {format:1,source:{build:1059,dmg_sha256:'a'.repeat(64),updater_sha256:'b'.repeat(64)},components:Object.fromEntries(PROCESS_LAYOUT.map(row=>{
 const identifier=row.key==='app'?'com.kenyu.chathand':row.key;
 return [row.key,{identifier,requirement:'identifier "'+identifier+'" and certificate leaf = H"'+certificate+'"',entitlements:null}];
}))};}
test('actual codesign quoted and unquoted identifier syntax retains identical public identities',()=>{
 const b=baseline();
 for(const key of ['node','cloudflared'])b.components[key].requirement='identifier '+key+' and certificate leaf = H"'+certificate+'"';
 assert.equal(validateProcessIdentityBaseline(b),b);
 b.components.node.requirement='designated => '+b.components.node.requirement;
 assert.equal(validateProcessIdentityBaseline(b),b);
});
test('unquoted identifier acceptance does not admit prefixes, altered identifiers, later clauses or cdhash identities',()=>{
 for(const requirement of [
  'identifier node2 and certificate leaf = H"'+certificate+'"',
  'identifier "node.foreign" and certificate leaf = H"'+certificate+'"',
  'identifier foreign or identifier node',
  'identifier node and cdhash H"1234"',
  'identifier "node"junk and certificate leaf = H"'+certificate+'"'
 ]){
  const b=baseline();b.components.node.requirement=requirement;
  assert.throws(()=>validateProcessIdentityBaseline(b),/BASELINE_INVALID_node/);
 }
});
