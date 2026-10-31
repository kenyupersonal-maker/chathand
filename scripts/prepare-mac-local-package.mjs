// Assemble an explicitly selected private build. This never installs or labels
// the build accepted; acceptance reports remain separate immutable evidence.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {payloadInventory,verifyPayload} from '../app/v09/payload-integrity.mjs';
const candidate=path.resolve(process.argv[2]||''),out=path.resolve(process.argv[3]||'');
if(process.platform!=='darwin'||process.argv.length!==4)throw Error('USE_EXPLICIT_APP_AND_NEW_OUTPUT_DIRECTORY');
if(fs.existsSync(out))throw Error('PACKAGE_ALREADY_EXISTS');
const run=(program,args)=>{const r=spawnSync(program,args,{encoding:'utf8',timeout:30000});if(r.status!==0)throw Error(r.stderr||r.error?.message||'LOCAL_STEP_FAILED');return r.stdout.trim();};
run('/usr/bin/codesign',['--verify','--deep','--strict',candidate]);
const self=JSON.parse(run(path.join(candidate,'Contents/MacOS/KenBridge'),['--self-check']));
if(self.bundle_id!=='com.kenyu.chathand'||self.version!==JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url))).version)throw Error('UNEXPECTED_CANDIDATE');
payloadInventory(candidate); // Reject external/broken links before copying.
fs.mkdirSync(out,{recursive:true,mode:0o700});
const app=path.join(out,'ChatHand.app');
fs.cpSync(candidate,app,{recursive:true,dereference:false,verbatimSymlinks:true});
run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
const manifest={version:self.version,files:payloadInventory(app)};
verifyPayload(app,manifest.files);
const json=JSON.stringify(manifest,null,2)+'\n';fs.writeFileSync(path.join(out,'payload-manifest.json'),json);
const receipt={status:'PREPARED_NOT_INSTALLED',scope:'private local macOS candidate; not a public signed/notarized release',source_app:candidate,app,version:self.version,
  build_provenance:JSON.parse(fs.readFileSync(path.join(app,'Contents/Resources/runtime/build-provenance.json'),'utf8')),
  manifest_sha256:crypto.createHash('sha256').update(json).digest('hex'),payload_entries:manifest.files.length,signature:'fixed-self-signed',time:new Date().toISOString()};
fs.writeFileSync(path.join(out,'package-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
fs.writeFileSync(path.join(out,'README.md'),'# ChatHand 本地候选包\n\n此包由明确指定的构建复制，未执行安装，未据此宣布验收通过。它不包含个人凭据或开发 SDK。验收报告保留在开发目录 reports/handoff。\n\n验收通过后，使用包内 Node 运行 runtime/scripts/upgrade.mjs --install 并指定此目录。升级事务会保留旧 App 与私有状态；此清单只提供本地完整性验证，不替代发布者身份签名。\n');
console.log(JSON.stringify(receipt));
