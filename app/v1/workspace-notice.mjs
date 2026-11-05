import {AsyncLocalStorage} from 'node:async_hooks';

// A notice belongs to the operation that observed the recreation, not to a
// session or to the next unrelated request.
const notices=new AsyncLocalStorage();
export const workspaceNoticeContext=()=>notices.getStore();
export const withWorkspaceNotice=(context,run)=>notices.run(context,run);
export function noteWorkspaceRecreated(){const context=notices.getStore();if(context)context.recreated=true;}
export function noteWorkspaceCommandsStopped(){const context=notices.getStore();if(context)context.commandsStopped=true;}
