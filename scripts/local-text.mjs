import {t,systemLocale} from '../app/i18n.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
let locale=systemLocale();
if(process.platform==='darwin'&&!process.env.CHATHAND_SYSTEM_LOCALE){
 try{const {stdout}=await promisify(execFile)('/usr/bin/defaults',['read','-g','AppleLanguages'],{timeout:1500});locale=stdout.match(/["(\s]([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)[",\s)]/)?.[1]||'zh';}catch{}
}
const [key,...assignments]=process.argv.slice(2);
if(!key)throw Error('I18N_KEY_REQUIRED');
const params=Object.fromEntries(assignments.map(value=>{const i=value.indexOf('=');return [value.slice(0,i),value.slice(i+1)];}));
process.stdout.write(t(key,params,locale)+'\n');
