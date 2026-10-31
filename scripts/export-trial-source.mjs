/** Legacy private trial snapshot. Use export-public-source.mjs for public candidates. */
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),dest=path.resolve(process.argv[2]||'');
if(!process.argv[2]||fs.existsSync(dest)||dest.startsWith(root+path.sep))throw Error('PASS_NEW_EXTERNAL_DESTINATION');
const top=new Set(['.gitignore','.gitleaks.toml','.dockerignore','AGENTS.md','README.md','LICENSE','THIRD_PARTY_NOTICES.md','CHANGELOG.md','package.json','package-lock.json']);
const dirs=new Set(['app','browser-extension','cloud','connectors','contracts','codex','native','plugins','prompts','scripts','skills','ui','vendor','licenses','.github']);
const tracked=execFileSync('git',['ls-files','--cached','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean).filter(f=>!f.startsWith('test-support/node-known-results/')&&(top.has(f)||dirs.has(f.split('/')[0])||/^test(?:-|\/)/.test(f)||/^docs\/(INSTALL\.md|release-notes-[^/]+\.md|images\/)/.test(f)||/^engine\/(src\/|test\/|scripts\/|examples\/|public\/|docs\/[^/]+\.json$|package\.json$|LICENSE$)/.test(f)));
const files=tracked.filter(file=>fs.existsSync(path.join(root,file)));
for(const file of files){const src=path.join(root,file),st=fs.lstatSync(src);if(!st.isFile())throw Error('NON_REGULAR_SOURCE: '+file);const bytes=fs.readFileSync(src);if(!bytes.includes(0)&&bytes.toString().includes(os.homedir()+'/'))throw Error('PERSONAL_PATH_IN_SOURCE: '+file);}
console.error('PRIVATE_TRIAL_SNAPSHOT_NOT_FOR_PUBLIC: use export-public-source.mjs for a public candidate');
fs.mkdirSync(dest,{recursive:true,mode:0o700});for(const file of files){const out=path.join(dest,file);fs.mkdirSync(path.dirname(out),{recursive:true});fs.copyFileSync(path.join(root,file),out);fs.chmodSync(out,fs.statSync(path.join(root,file)).mode&0o777);}
console.log(JSON.stringify({status:'EXPORTED_WITHOUT_HISTORY',files:files.length,destination:dest}));
