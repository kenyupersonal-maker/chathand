import fs from 'node:fs';
import path from 'node:path';
import {fail} from '../../engine/src/core.mjs';
export const validStoreProfile=id=>typeof id==='string'&&/^(?:Default|Profile (?:0|[1-9][0-9]{0,5}))$/u.exec(id)?.[0]===id;
/** Basic owner-requested chooser metadata only. Never inspect extension preferences or prove installation. */
export function chromeStoreProfiles({home,io=fs,profile_id}={}){
 if(profile_id!==undefined&&!validStoreProfile(profile_id))fail('CHROME_STORE_PROFILE_INVALID','Invalid Chrome profile selection.');
 const file=path.join(home,'Library/Application Support/Google/Chrome/Local State');
 let raw;
 try{const stat=io.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024||io.realpathSync(file)!==file)throw Error();raw=JSON.parse(io.readFileSync(file,'utf8'));}catch{fail('CHROME_STORE_PROFILES_UNAVAILABLE','Chrome profile choices are unavailable.');}
 const cache=raw?.profile?.info_cache;
 if(!cache||typeof cache!=='object'||Array.isArray(cache))fail('CHROME_STORE_PROFILES_UNAVAILABLE','Chrome profile choices are unavailable.');
 const profiles=Object.keys(cache).filter(validStoreProfile).slice(0,100).map(id=>({id,name:typeof cache[id]?.name==='string'?cache[id].name.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,64)||id:id}));
 if(!profiles.length||profile_id!==undefined&&!profiles.some(p=>p.id===profile_id))fail('CHROME_STORE_PROFILE_INVALID','Chrome profile selection is unavailable.');
 const lastUsed=raw.profile.last_used;
 const selected=validStoreProfile(lastUsed)&&Object.hasOwn(cache,lastUsed)?lastUsed:profiles.length===1?profiles[0].id:null;
 return {profiles,selected_profile:profile_id??selected};
}
