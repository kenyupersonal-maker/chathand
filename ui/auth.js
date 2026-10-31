'use strict';
// Loaded before every authenticated UI consumer. Secrets stay in this closure;
// consumers receive a same-origin API fetch capability, never raw credentials.
(()=>{
 const bootstrap=window.__CHATHAND_AUTH__;
 const [token,key='']=bootstrap?[bootstrap.token,bootstrap.uiKey]:location.hash.slice(1).split('.');
 if(bootstrap)delete window.__CHATHAND_AUTH__;
 if(location.hostname==='127.0.0.1'&&/^[a-f0-9]{64}(?:\.[a-f0-9]{64})?$/.test(location.hash.slice(1)))history.replaceState(history.state,'',location.pathname+location.search);
 const authenticatedFetch=(route,options={})=>{
  const url=new URL(route,location.href);
  if(url.origin!==location.origin||!url.pathname.startsWith('/api/'))return Promise.reject(Error('LOCAL_API_ONLY'));
  const headers={...(options.headers||{}),Authorization:'Bearer '+token,...(key?{'X-ChatHand-UI':key}:{})};
  return fetch(url.pathname+url.search,{...options,headers,credentials:'omit',redirect:'error'});
 };
 Object.defineProperty(window,'ChatHandAuth',{value:Object.freeze({fetch:authenticatedFetch}),writable:false,configurable:false});
})();
