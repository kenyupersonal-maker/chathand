import {BrowserController} from '../v07/browser.mjs';
import {PersonalChrome} from './personal-chrome.mjs';
import {ExtensionBrowser} from '../v09/extension-browser.mjs';
export class BrowserRouter {
 constructor(state,store,policy){Object.assign(this,{state,store,policy});this.managed=new BrowserController(state,store,policy);this.personal=new PersonalChrome(state,store,policy);this.extension=new ExtensionBrowser(state,store,policy);}
 get backend(){return this.state.data.browser_backend==='isolated'?this.managed:this.state.data.browser_backend==='personal'?this.personal:this.extension;}
 userStop(task,options){return this.backend.userStop(task,options);}
 userResume(task,options){return this.backend.userResume(task,options);}
 get sessions(){return this.backend.sessions||new Map(this.personal.phase==='connected'?[['personal',true]]:[]);}
 get headless(){return this.managed.headless;}set headless(v){this.managed.headless=v;}
 status(){return {...this.backend.status(),selected_backend:this.state.data.browser_backend||'extension',extension:this.extension.status(),personal:this.personal.status(),fallback_to_isolated:false};}
 async setBackend(mode){if(!['extension','personal','isolated'].includes(mode))throw Object.assign(new Error('浏览器选择无效。'),{code:'ARG_INVALID'});if((this.state.data.browser_backend||'extension')===mode)return this.status();await this.closeAll();this.state.data.browser_backend=mode;this.state.save();return this.status();}
 async closeAll(options){await Promise.allSettled([this.extension.closeAll(options),this.personal.closeAll(options),this.managed.closeAll()]);}
}
for(const name of ['open','tabs','snapshot','action','screenshot','upload','download','close'])BrowserRouter.prototype[name]=function(o,caller){return this.backend[name](o,caller);};
// Existing close(caller) is intentionally different from action option methods.
BrowserRouter.prototype.close=function(caller){return this.backend.close(caller);};
