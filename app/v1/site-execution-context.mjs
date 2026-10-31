import {AsyncLocalStorage} from 'node:async_hooks';
const execution=new AsyncLocalStorage();const manualApproval=new AsyncLocalStorage();
export const runManualSiteApproval=fn=>manualApproval.run(true,fn);
// This capability never enters arguments, credentials, receipts or public JSON.
export const currentSiteExecution=()=>execution.getStore()||null;
export const runSiteExecution=(capability,fn)=>execution.run(capability,fn);
export function assertSiteExecution(capability=currentSiteExecution()){if(!capability)return;if(manualApproval.getStore()===true){if(typeof capability.assertManual!=='function')throw Object.assign(Error('B_MANUAL_AUTHORITY_REQUIRED'),{code:'B_MANUAL_AUTHORITY_REQUIRED'});capability.assertManual();}else capability.assert();}
export async function beforeSiteExecution(capability=currentSiteExecution()){
 if(!capability)return;
 capability.assert();await capability.beforeStart();capability.assert();
}
// Synchronous native/extension polling must not hand out a delayed action until
// the asynchronous start check has settled. The same capability survives the queue.
// The extension host polls every 400ms (native desktop every 300ms). A 100ms
// ready window expires before the next poll when authorization completes fast,
// repeatedly reauthorizing until the browser request times out. Retain readiness
// for one poll with bounded scheduling headroom, below the 1000ms start-receipt
// limit; every delivery still asserts the current capability and caller guards.
const SITE_DELIVERY_READY_MS=500;
export function siteDeliveryReady(holder){
 const capability=holder.siteExecution;if(!capability)return true;
 capability.assert();if(holder.siteExecutionError)throw holder.siteExecutionError;
 if(holder.siteExecutionReadyAt&&performance.now()-holder.siteExecutionReadyAt<=SITE_DELIVERY_READY_MS)return true;
 if(!holder.siteExecutionChecking){holder.siteExecutionChecking=true;
  Promise.resolve().then(()=>beforeSiteExecution(capability)).then(()=>{holder.siteExecutionReadyAt=performance.now();holder.siteExecutionChecking=false;},error=>{holder.siteExecutionError=error;holder.siteExecutionChecking=false;});
 }
 return false;
}
