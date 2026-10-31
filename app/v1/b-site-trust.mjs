/** Site B trust anchors from a signed installed release, not an incoming claim.
 * Empty metadata explicitly means no trusted Site target exists yet. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {siteOrigin,decodeUrl64} from './b-site-wire.mjs';
import {fail} from '../../engine/src/core.mjs';
import {readPinnedSiteTemplate,matchPinnedSiteTemplate} from './site-template-pin.mjs';
const pkg=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export function bundledSiteTarget(siteId,{file=path.join(pkg,'connectors/site-b-targets.json')}={}){
 if(typeof siteId!=='string'||!/^[A-Za-z0-9_-]{4,128}$/.test(siteId))fail('B_SITE_ID_INVALID','Site ID 格式无效。');
 const st=fs.lstatSync(file);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>128*1024)fail('B_SITE_TRUST_UNSAFE','本机发布版 Site 配对锚不可信。');
 const data=JSON.parse(fs.readFileSync(file,'utf8'));
 if(data?.format!==1||!Array.isArray(data.deployments)||data.deployments.length>20)fail('B_SITE_TRUST_INVALID','本机 Site 绑定来源无效。');
 const matches=data.deployments.filter(v=>v?.site_id===siteId);
 if(matches.length!==1)return null;
 const target=matches[0];
 if(Object.keys(target).some(k=>!['site_id','site_origin','owner_subject','site_public_key'].includes(k))||
    typeof target.owner_subject!=='string'||!target.owner_subject||target.owner_subject.length>160)fail('B_SITE_TRUST_INVALID','本机 Site 身份缺少固定主体。');
 siteOrigin(target.site_origin);decodeUrl64(target.site_public_key,32);
 return {...target,verified:true,trust_origin:'bundled_release_metadata'};
}
export function pairedSiteTarget(siteId,{credentials,localStore,installationId,templatePin=readPinnedSiteTemplate}={}){
 if(typeof siteId!=='string'||!credentials||!localStore||typeof installationId!=='string'||localStore.siteCommit())return null;
 const saved=credentials.get('site_b'),route=localStore.route('site'),pin=templatePin();
 if(!saved||saved.trust!=='tofu-template-v1'||saved.installation_id!==installationId||
    saved.site_id!==siteId||route.configured!==1||route.site_id!==siteId||
    route.binding_id!==saved.binding_id||route.generation!==saved.generation||
    route.owner_subject!==saved.owner_subject||!pin?.verified_source)return null;
 try{siteOrigin(saved.site_origin);if(!new URL(saved.site_origin).hostname.endsWith('.chatgpt.site'))return null;
  decodeUrl64(saved.site_public_key,32);}
 catch{return null;}
 return {verified:true,trust_origin:'paired_template',site_id:siteId,site_origin:saved.site_origin,
  owner_subject:saved.owner_subject,site_public_key:saved.site_public_key,
  template_current:!!matchPinnedSiteTemplate(pin,saved)};
}
