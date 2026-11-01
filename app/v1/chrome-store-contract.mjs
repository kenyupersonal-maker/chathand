/** Fixed v1 capabilities. Version/build equality never grants browser authority. */
// 1081（Claude，Ken 10/27）：上架应用店的第一版插件（b1078）就有的动作。插件连这些都缺，或者缺下面的必需能力，说明它旧到用不了：
// 浏览器控制停下，请用户更新插件（state 'incompatible'）。
export const CHROME_STORE_ACTIONS=Object.freeze('tabs new select close navigate snapshot screenshot click double_click fill select_value press scroll scroll_to wait_for read find batch back forward reload upload detach'.split(' '));
// 之后新加的浏览器动作写在这里，不往上面那行加。插件还没有的话，浏览器控制照常用，只有用到这个动作时告诉 ChatGPT 要等插件更新
// （state 'partial'）；「浏览器控制」页里一行小字说插件有新版，首页不提示。插件跟着 ChatHand 出新版时，先等插件在应用店上线，再出 ChatHand。
export const CHROME_STORE_LATER_ACTIONS=Object.freeze([]);
export const CHROME_STORE_REQUIRED_FEATURES=Object.freeze(['click_receipt','find_boxes']);
const knownFeatures=new Set([...CHROME_STORE_REQUIRED_FEATURES,'page_lang','system_language_v1','upload_payload_v1']);
function list(value,known){return Array.isArray(value)?[...new Set(value.slice(0,60).filter(v=>typeof v==='string'&&known.has(v)))]:[];}
// core、later 只给测试换。
export function chromeStoreCompatibility(helper,{core=CHROME_STORE_ACTIONS,later=CHROME_STORE_LATER_ACTIONS}={}){
 const actions=list(helper?.actions,new Set([...core,...later])),features=list(helper?.features,knownFeatures);
 const missing_actions=core.filter(v=>!actions.includes(v)),missing_later_actions=later.filter(v=>!actions.includes(v)),missing_features=CHROME_STORE_REQUIRED_FEATURES.filter(v=>!features.includes(v));
 return {protocol_version:1,state:!helper?'unknown':missing_actions.length||missing_features.length?'incompatible':missing_later_actions.length?'partial':'compatible',actions,features,missing_actions,missing_later_actions,missing_features};
}
// 能用浏览器控制：全有，或者只缺后来加的动作。
export const chromeStoreUsable=c=>c?.state==='compatible'||c?.state==='partial';
