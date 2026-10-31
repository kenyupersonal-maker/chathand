import path from 'node:path';
import fs from 'node:fs';
import {signApplication} from './signing.mjs';
const app=process.argv[2];
if(!app||!path.isAbsolute(app)||!app.endsWith('.app'))throw Error('Pass an absolute isolated .app path');
const baseline=process.argv[3];
console.log(JSON.stringify(signApplication(app,undefined,{processIdentityBaseline:baseline?JSON.parse(fs.readFileSync(baseline,'utf8')):null}),null,2));
