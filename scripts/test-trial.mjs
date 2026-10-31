/** Full source regression. */
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const dirs=['engine/test',...fs.readdirSync(root).filter(n=>/^test(?:-|$)/.test(n)&&fs.statSync(path.join(root,n)).isDirectory())];
const files=dirs.flatMap(dir=>fs.readdirSync(path.join(root,dir)).filter(n=>n.endsWith('.test.mjs')||(dir==='test-v1'&&n.endsWith('.mjs'))).map(n=>path.join(dir,n)));
const result=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-concurrency=1','--test-timeout=120000',...files],{cwd:root,stdio:'inherit'});process.exitCode=result.status??1;
