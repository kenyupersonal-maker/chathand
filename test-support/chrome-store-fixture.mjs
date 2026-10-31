// Unit-only ephemeral public identity. Never copied to product connectors/manifest or a release ZIP.
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import {chromeDistribution} from '../app/v1/chrome-distribution.mjs';
import {CHROME_STORE_ACTIONS,CHROME_STORE_REQUIRED_FEATURES} from '../app/v1/chrome-store-contract.mjs';
const {publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const der=publicKey.export({type:'spki',format:'der'});
const id=[...crypto.createHash('sha256').update(der).digest().subarray(0,16)].map(v=>String.fromCharCode(97+(v>>4),97+(v&15))).join('');
export const storeTestDistribution=()=>chromeDistribution({distribution:'chrome_web_store',extension_id:id,public_key:der.toString('base64'),store_url:`https://chromewebstore.google.com/detail/${id}`,published:false});
export const storeTestHelper=()=>({version:'0.0.1',actions:[...CHROME_STORE_ACTIONS],features:[...CHROME_STORE_REQUIRED_FEATURES]});
// A normal fake peer reports the same metadata as the bundled extension. Keep
// storeTestHelper's deliberately unrelated version for protocol-only tests.
const manifest=JSON.parse(fs.readFileSync(new URL('../browser-extension/manifest.json',import.meta.url),'utf8'));
const background=fs.readFileSync(new URL('../browser-extension/background.js',import.meta.url),'utf8');
const metadataLines=background.split('\n').filter(line=>/^const (HELPER_ACTIONS|HELPER_FEATURES|helperInfo)=/.test(line));
if(metadataLines.length!==3)throw Error('TEST_HELPER_METADATA_SOURCE_MISSING');
const manifestHelper=vm.runInNewContext('const MANIFEST=manifest;let lastReload=null;\n'+metadataLines.join('\n')+'\nhelperInfo()',{manifest});
export const manifestStoreTestHelper=()=>structuredClone(manifestHelper);
// Only explicit test callers add a ready distribution and a complete hello.
export const storeBrowserFixture=Production=>class extends Production{
 constructor(state,store,policy){super(state,store,policy,{distribution:storeTestDistribution()});this.noteHelper('fixture',storeTestHelper());}
 next(session,helper,...rest){return super.next(session,helper??storeTestHelper(),...rest);}
};
