import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {readDesktopDataSnapshot} from './data-compatibility.mjs';

// Ordinary corrupt contents only. Linked or replaced paths remain errors.
// The app's existing data lock is already held when this function is called.
export function preserveCorruptSettings(dir){
 const snapshot=readDesktopDataSnapshot(dir,{allowCorrupt:true,requireShape:true});
 if(snapshot.kind!=='corrupt')return null;
 const source=path.join(dir,'desktop.json'),now=fs.lstatSync(source),before=snapshot.stat;
 if(!now.isFile()||now.isSymbolicLink()||now.nlink!==1||now.dev!==before.dev||now.ino!==before.ino||now.size!==before.size||now.mtimeMs!==before.mtimeMs||now.ctimeMs!==before.ctimeMs)throw Object.assign(Error('SETTINGS_RECOVERY_UNSAFE'),{code:'SETTINGS_RECOVERY_UNSAFE'});
 const name='desktop.unreadable-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID()+'.json';
 fs.renameSync(source,path.join(dir,name));
 return name;
}
export function preservedCorruptSettings(dir){
 return fs.readdirSync(dir).some(name=>/^desktop\.unreadable-\d{4}-\d\d-\d\dT[\d-]+Z-[0-9a-f-]{36}\.json$/.test(name));
}
