import {AsyncLocalStorage} from 'node:async_hooks';
import {chatgptSelfAllowed} from './permissions.mjs';
import {highRiskError} from './high-risk.mjs';

const internalControl = new AsyncLocalStorage();
const internalMarker = Object.freeze({});
const CHATGPT_HOSTS = ['chatgpt.com', 'chat.openai.com', 'chat.com'];

export function isChatGPTTargetURL(raw) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return CHATGPT_HOSTS.some(domain => host === domain || host.endsWith('.' + domain));
  } catch { return false; }
}

export function requireChatGPTSelf(state, {task_id, url, command = 'browser', internal = isInternalBrowserControl()} = {}) {
  if (isChatGPTTargetURL(url) && !internal && !chatgptSelfAllowed(state, {task_id})) {
    throw highRiskError('chatgpt_self', {command});
  }
}

export function withInternalBrowserControl(fn) {
  if (typeof fn !== 'function') throw new TypeError('fn must be a function');
  return (...args) => internalControl.run(internalMarker, () => fn(...args));
}

export function isInternalBrowserControl() {
  return internalControl.getStore() === internalMarker;
}

const taskId = task => typeof task === 'string' ? task : task?.task_id || task?.id || '';
const pageKey = page => page == null || page === '' ? '*' : String(page);

export class BrowserTaskActivity {
  constructor() { this.stopped = new Map(); }
  userStop(task, {scope = 'browser', page_id} = {}) {
    const id = taskId(task);
    if (!id || scope !== 'browser') throw Object.assign(new Error('浏览器停止状态参数无效。'), {code: 'ARG_INVALID'});
    const pages = this.stopped.get(id) || new Set();pages.add(pageKey(page_id));this.stopped.set(id, pages);
    return {ok: true, stopped: true, scope: 'browser', next_action: 'browser_snapshot', ...(page_id == null ? {} : {page_id: String(page_id)})};
  }
  userResume(task, {scope = 'browser', page_id} = {}) {
    const id = taskId(task);
    if (!id || scope !== 'browser') throw Object.assign(new Error('浏览器恢复状态参数无效。'), {code: 'ARG_INVALID'});
    const pages = this.stopped.get(id);if (!pages) return {ok: true, resumed: true, scope: 'browser', next_action: 'browser_snapshot'};
    if (page_id == null || page_id === '') this.stopped.delete(id);
    else if (!pages.has('*')) {pages.delete(pageKey(page_id));if (!pages.size)this.stopped.delete(id);}
    return {ok: true, resumed: true, scope: 'browser', next_action: 'browser_snapshot', ...(page_id == null ? {} : {page_id: String(page_id)})};
  }
  isStopped(task, page_id) {
    const pages = this.stopped.get(taskId(task));
    return !!pages && (pages.has('*') || pages.has(pageKey(page_id)));
  }
  assertActive(task, page_id) {
    if (!this.isStopped(task, page_id)) return;
    const error = Object.assign(new Error('用户正在用这一页，这一步没做；先等用户恢复浏览器操作。'), {
      code: 'BROWSER_USER_ACTIVE',
      details: {user_stopped: true, scope: 'browser', ...(page_id == null ? {} : {page_id: String(page_id)}), replay_safe: false}
    });
    throw error;
  }
  clearTask(task) { this.stopped.delete(taskId(task)); }
}
