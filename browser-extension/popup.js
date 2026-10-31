import {text, setSystemLanguage, languageState} from './locale.js';
async function render(){
 const s=await chrome.runtime.sendMessage({action:'status'}),failed=s.preference_error==='PREFERENCE_SAVE_FAILED',retryEnabled=failed&&s.preference_error_enabled===true;
 setSystemLanguage(s.language);document.documentElement.lang=languageState().locale;
 for(const node of document.querySelectorAll('[data-i18n]'))node.textContent=text(node.dataset.i18n);
 const status=document.querySelector('#status'),error=document.querySelector('#preference-error');
 status.textContent=s.connected?text('chrome.connected'):s.enabled?text('chrome.disconnected'):text('chrome.disabled');
 if(failed){error.hidden=false;error.textContent=retryEnabled?text('chrome.enableSaveFailed'):text('chrome.disableSaveFailed');}else{error.hidden=true;error.textContent='';}
 const b=document.querySelector('#toggle'),action=failed?(retryEnabled?'enable':'disable'):(s.enabled?'disable':'enable');
 b.textContent=failed?(retryEnabled?text('chrome.retryEnable'):text('chrome.retryDisable')):(s.enabled?text('chrome.disableControl'):text('chrome.enableControl'));b.disabled=false;b.onclick=async()=>{b.disabled=true;await chrome.runtime.sendMessage({action});await render();};
 const reconnect=document.querySelector('#reconnect');if(reconnect){reconnect.hidden=!s.enabled||s.connected;reconnect.onclick=async()=>{reconnect.disabled=true;await chrome.runtime.sendMessage({action:'reconnect'});await render();};reconnect.disabled=false;}
}
render();
