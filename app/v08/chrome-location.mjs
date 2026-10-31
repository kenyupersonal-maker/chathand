import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// Locate only: never start Chrome, copy a profile, or change browser permissions.
export function createChromeLocator({home=os.homedir(),exists=fs.existsSync,run=spawnSync,platform=process.platform,now=Date.now}={}){
 let cached=null,lastSearch=-Infinity;
 return function locate(){
  if(cached&&exists(cached))return cached;
  if(cached){cached=null;lastSearch=-Infinity;}
  for(const app of ['/Applications/Google Chrome.app',path.join(home,'Applications/Google Chrome.app')])if(exists(app)){cached=app;return app;}
  // Missing installations are checked again after one minute; repeated state polls do not launch mdfind.
  if(platform!=='darwin'||now()-lastSearch<60000)return null;
  lastSearch=now();
  try{
   const result=run('/usr/bin/mdfind',["kMDItemCFBundleIdentifier == 'com.google.Chrome'"],{encoding:'utf8',timeout:2000,maxBuffer:65536});
   if(result?.status===0)for(const raw of String(result.stdout||'').split(/\r?\n/)){
    const app=raw.trim();if(path.isAbsolute(app)&&app.endsWith('.app')&&!app.includes('\0')&&exists(app)){cached=app;return app;}
   }
  }catch{/* Keep the existing not-installed result when Spotlight is unavailable. */}
  return null;
 };
}
const sharedLocator=createChromeLocator();
export function findChromeApp(options){
 if(!options||Object.entries(options).every(([key,value])=>value===undefined||value===({home:os.homedir(),exists:fs.existsSync,run:spawnSync,platform:process.platform,now:Date.now})[key]))return sharedLocator();
 return createChromeLocator(options)();
}
