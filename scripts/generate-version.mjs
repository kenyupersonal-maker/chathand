import {t as displayText} from '../app/i18n.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const xml=value=>String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
export function generatedFiles(pkg) {
 if(!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(pkg.version))throw Error('RELEASE_VERSION_INVALID');
 const k=pkg.kenBridge;
 if(!k||!Number.isInteger(k.runtime_api)||k.runtime_api<1||!Number.isInteger(k.build_number)||k.build_number<1)throw Error('BUILD_CONFIG_INVALID');
 const swift=`// Generated from package.json by scripts/generate-version.mjs.\nimport Foundation\nenum BuildVersion {\n    static let release = ${JSON.stringify(pkg.version)}\n    static let buildNumber = ${k.build_number}\n    static let runtimeAPI = ${k.runtime_api}\n    static let bundleID = ${JSON.stringify(k.bundle_id||"com.kenyu.chathand")}\n}\n`;
 const plist=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>CFBundleExecutable</key><string>ChatHand</string>\n<key>CFBundleIdentifier</key><string>${k.bundle_id||"com.kenyu.chathand"}</string>\n<key>CFBundleName</key><string>ChatHand</string>\n<key>CFBundleDisplayName</key><string>${k.release_channel==="development-preview"?"ChatHand 0.6 Preview":"ChatHand"}</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>com.kenyu.chathand.navigation</string><key>CFBundleURLSchemes</key><array><string>chathand</string></array></dict></array>\n<key>CFBundleShortVersionString</key><string>${pkg.version.split('-')[0]}</string>\n<key>CFBundleVersion</key><string>${k.build_number}</string>\n<key>LSMinimumSystemVersion</key><string>14.0</string>\n<key>CFBundleIconFile</key><string>AppIcon</string>\n<key>NSHighResolutionCapable</key><true/>\n<key>NSAppleEventsUsageDescription</key><string>${xml(displayText('native.permission.appleEventsUsage',{},'zh'))}</string>\n<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>\n</dict></plist>\n`;
 return {'native/BuildVersion.swift':swift,'native/Info.plist':plist};
}
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Disabled legacy version coupling; retained for explicit legacy fixtures.
export function extensionVersion(pkg){const build=pkg.kenBridge?.build_number;if(!Number.isInteger(build)||build<1||build>65535)throw Error('BUILD_CONFIG_INVALID');return {version:pkg.version.split('-')[0]+'.'+build,version_name:`${pkg.version} (${build})`};}
export function extensionManifestVersion(pkg,manifest,distribution){
 if(distribution?.distribution==='legacy_unpacked')return {...manifest,...extensionVersion(pkg)};
 const version=manifest.version,match=typeof version==='string'?/^(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*)){0,3}$/.exec(version):null;
 if(!match||match[0]!==version||version.split('.').some(v=>Number(v)>65535)||!version.split('.').some(v=>Number(v)>0))throw Error('STORE_EXTENSION_VERSION_REQUIRED');
 // Chrome Web Store owns extension updates. App releases preserve this independent version.
 return {...manifest};
}
export function generate(rootDir=root,check=false){
 const p=JSON.parse(fs.readFileSync(path.join(rootDir,'package.json'),'utf8')),outputs=generatedFiles(p);
 const configPath=path.join(rootDir,'connectors/browser-extension.json');
 const distribution=fs.existsSync(configPath)?JSON.parse(fs.readFileSync(configPath,'utf8')):null;
 for(const rel of ['browser-extension/manifest.json','plugins/chathand/.codex-plugin/plugin.json']){
  let item=JSON.parse(fs.readFileSync(path.join(rootDir,rel),'utf8'));
  if(rel.startsWith('browser-'))item=extensionManifestVersion(p,item,distribution);else item.version=p.version;
  outputs[rel]=JSON.stringify(item,null,2)+'\n';
 }
 for(const [rel,text]of Object.entries(outputs)){
  const f=path.join(rootDir,rel);
  if(check){if(!fs.existsSync(f)||fs.readFileSync(f,'utf8')!==text)throw Error('GENERATED_FILE_STALE: '+rel);}
  else{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,text);}
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{generate(root,process.argv.includes('--check'));console.log('VERSION_FILES_MATCH');}catch(e){console.error(e.message);process.exitCode=1;}}
