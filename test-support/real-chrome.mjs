// 1029（H1）：用真的 Chrome/Chromium 跑浏览器助手的真代码，不装扩展。
// Chrome 用 --remote-debugging-pipe 起一个无头实例（临时资料夹，不碰用户自己的 Chrome），
// 再用 CDP 包出一个最小的 chrome.*（tabs、tabGroups、windows、runtime、debugger），交给 BrowserDriver。
// debugger 这一层照扩展里的样子做：每个标签页一个根会话，跨源 iframe 走平铺的子会话（{tabId, sessionId}），
// 事件经 debugger.onEvent 送回去。标签页的导航由另一条「浏览器自己的」会话来做，和扩展的会话分开。
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

/** 找 Chrome：CHATHAND_TEST_CHROME → Mac 上的 Google Chrome → 云端 /opt/pw-browsers 里的 chromium。找不到回 null。 */
export function findChrome() {
  const candidates = [process.env.CHATHAND_TEST_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  try {
    for (const name of fs.readdirSync('/opt/pw-browsers').sort().reverse())
      if (/^chromium-\d+$/.test(name)) candidates.push(path.join('/opt/pw-browsers', name, 'chrome-linux/chrome'), path.join('/opt/pw-browsers', name, 'chrome-linux64/chrome'));
  } catch {}
  return candidates.find(file => file && fs.existsSync(file)) || null;
}

/** CDP 走管道：Chrome 从 fd 3 读、往 fd 4 写，每条消息是一段 JSON，后面跟一个 \0。 */
export class PipeCDP {
  constructor(write, read) {
    this.write = write;this.nextId = 0;this.callbacks = new Map();this.listeners = new Set();this.closed = false;
    let pending = [];
    read.on('data', chunk => {
      let start = 0;
      for (let index = 0; index < chunk.length; index++) {
        if (chunk[index] !== 0) continue;
        pending.push(chunk.subarray(start, index));start = index + 1;
        const text = Buffer.concat(pending).toString('utf8');pending = [];
        let message;try {message = JSON.parse(text);} catch {continue;}
        this.dispatch(message);
      }
      if (start < chunk.length) pending.push(chunk.subarray(start));
    });
    read.on('close', () => this.fail('CDP 管道断了'));
  }
  dispatch(message) {
    if (message.id !== undefined) {
      const callback = this.callbacks.get(message.id);if (!callback) return;this.callbacks.delete(message.id);
      if (message.error) callback.reject(Object.assign(new Error(JSON.stringify(message.error)), {cdp: message.error, method: callback.method}));
      else callback.resolve(message.result || {});
      return;
    }
    for (const listener of [...this.listeners]) {try {listener(message);} catch {}}
  }
  fail(reason) {
    if (this.closed) return;this.closed = true;
    for (const callback of this.callbacks.values()) callback.reject(new Error(reason));
    this.callbacks.clear();
  }
  send(method, params = {}, sessionId = null) {
    if (this.closed) return Promise.reject(new Error('CDP 已关闭'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, {resolve, reject, method});
      try {this.write.write(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}) + '\0');}
      catch (error) {this.callbacks.delete(id);reject(error);}
    });
  }
  on(listener) {this.listeners.add(listener);return () => this.listeners.delete(listener);}
}

/** 起一个无头 Chrome。返回 {cdp, close, executable, version}。 */
export async function launchChrome(executable = findChrome(), {width = 1280, height = 900} = {}) {
  if (!executable) throw new Error('找不到 Chrome');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chathand-real-chrome-'));
  const args = [
    '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, `--window-size=${width},${height}`,
    '--no-first-run', '--no-default-browser-check', '--disable-default-apps', '--disable-extensions', '--disable-sync',
    '--disable-background-networking', '--disable-component-update', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-back-forward-cache',
    '--disable-features=Translate,MediaRouter,OptimizationHints,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable',
    '--site-per-process', '--password-store=basic', '--use-mock-keychain', '--mute-audio', '--force-color-profile=srgb',
    ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    'about:blank'
  ];
  const child = spawn(executable, args, {stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']});
  let stderr = '';child.stderr.on('data', chunk => {if (stderr.length < 8000) stderr += chunk;});
  const cdp = new PipeCDP(child.stdio[3], child.stdio[4]);
  const exited = new Promise(resolve => child.once('exit', resolve));
  let version;
  try {
    version = await Promise.race([cdp.send('Browser.getVersion'), new Promise((_, reject) => setTimeout(() => reject(new Error('Chrome 15 秒没起来：' + stderr.slice(-800))), 15000))]);
  } catch (error) {child.kill('SIGKILL');fs.rmSync(profile, {recursive: true, force: true});throw error;}
  await cdp.send('Target.setDiscoverTargets', {discover: true});
  async function close() {
    try {await Promise.race([cdp.send('Browser.close'), new Promise(resolve => setTimeout(resolve, 2000))]);} catch {}
    cdp.fail('Chrome 已关闭');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
    for (let attempt = 0; attempt < 5; attempt++) {try {fs.rmSync(profile, {recursive: true, force: true});break;} catch {await new Promise(resolve => setTimeout(resolve, 200));}}
  }
  return {cdp, close, executable, version: version.product, child};
}

const event = () => {const listeners = [];return {addListener: fn => listeners.push(fn), removeListener: fn => {const index = listeners.indexOf(fn);if (index >= 0) listeners.splice(index, 1);}, fire: (...args) => {for (const fn of [...listeners]) {try {fn(...args);} catch {}}}};};
const chromeError = message => new Error(message);

/**
 * 扩展看到的 chrome.*，用 CDP 做出来。只做 driver 用到的那些。
 * 标签页的 url 照真 Chrome：导航还没提交时 url 是空的，pendingUrl 是要去的地址。
 */
export class FakeChrome {
  constructor(cdp) {
    this.cdp = cdp;this.tabsById = new Map();this.nextTabId = 1000;this.activeTab = null;
    this.debugRoot = new Map();this.sessionTab = new Map();this.controlTab = new Map();
    this.groups = new Map();this.nextGroupId = 7;
    this.onEvent = event();this.onDetach = event();this.onRemoved = event();this.onUpdated = event();
    this.unsubscribe = cdp.on(message => this.route(message));
    const self = this;
    this.tabs = {
      get: async id => self.tabInfo(id),
      query: async () => Promise.all([...self.tabsById.keys()].map(id => self.tabInfo(id))),
      create: async ({url, active = true} = {}) => self.createTab(url, active),
      update: async (id, props = {}) => self.updateTab(id, props),
      remove: async id => self.closeTab(id),
      reload: async id => {const tab = self.requireTab(id);tab.pendingUrl = tab.url;self.onUpdated.fire(id, {status: 'loading'});await self.cdp.send('Page.reload', {}, tab.control);},
      group: async ({tabIds, groupId}) => {
        const id = groupId ?? self.nextGroupId++;if (!self.groups.has(id)) self.groups.set(id, {id, title: '', color: 'grey', collapsed: false});
        for (const tabId of [].concat(tabIds)) self.requireTab(tabId).groupId = id;
        return id;
      },
      onRemoved: this.onRemoved, onUpdated: this.onUpdated
    };
    this.tabGroups = {
      query: async ({title} = {}) => [...self.groups.values()].filter(group => title === undefined || group.title === title).map(group => ({...group})),
      update: async (id, props) => {const group = self.groups.get(id);if (!group) throw chromeError('No group with id: ' + id);Object.assign(group, props);return {...group};},
      get: async id => {const group = self.groups.get(id);if (!group) throw chromeError('No group with id: ' + id);return {...group};}
    };
    this.windows = {update: async () => ({id: 1})};
    this.runtime = {getPlatformInfo: async () => ({os: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'})};
    this.debugger = {
      attach: async ({tabId}) => self.attach(tabId),
      detach: async ({tabId}) => self.detach(tabId),
      sendCommand: async ({tabId, sessionId}, method, params = {}) => self.sendCommand(tabId, sessionId, method, params),
      onEvent: this.onEvent, onDetach: this.onDetach
    };
  }
  /** 照 background.js 那样把事件接到 driver 上。 */
  wire(driver) {
    this.onEvent.addListener((source, method, params) => {void driver.onEvent?.(source, method, params)?.catch?.(() => {});});
    this.onDetach.addListener(source => {driver.attached.delete(source.tabId);driver.invalidate(source.tabId);driver.noteDetached?.(source.tabId);});
    this.onRemoved.addListener(id => {driver.attached.delete(id);driver.invalidate(id);});
    this.onUpdated.addListener((id, change) => {if (change.url || change.status === 'loading') driver.invalidate(id);});
    return driver;
  }
  async dispose() {
    this.unsubscribe();
    for (const id of [...this.tabsById.keys()]) await this.closeTab(id).catch(() => {});
  }
  requireTab(id) {const tab = this.tabsById.get(Number(id));if (!tab) throw chromeError('No tab with id: ' + id + '.');return tab;}
  async tabInfo(id) {
    const tab = this.requireTab(id);let title = tab.title || '';
    try {const {targetInfo} = await this.cdp.send('Target.getTargetInfo', {targetId: tab.targetId});title = targetInfo.title;} catch {}
    return {id: tab.id, url: tab.url, ...(tab.pendingUrl ? {pendingUrl: tab.pendingUrl} : {}), title, status: tab.pendingUrl ? 'loading' : 'complete', incognito: false, groupId: tab.groupId, windowId: 1, active: this.activeTab === tab.id};
  }
  async createTab(url, active) {
    const {targetId} = await this.cdp.send('Target.createTarget', {url: 'about:blank', background: active === false});
    const {sessionId} = await this.cdp.send('Target.attachToTarget', {targetId, flatten: true});
    const tab = {id: this.nextTabId++, targetId, control: sessionId, url: '', pendingUrl: url || '', groupId: -1, title: ''};
    this.tabsById.set(tab.id, tab);this.controlTab.set(sessionId, tab.id);if (active) this.activeTab = tab.id;
    await this.cdp.send('Page.enable', {}, sessionId);
    await this.cdp.send('Runtime.enable', {}, sessionId);
    if (url) void this.cdp.send('Page.navigate', {url}, sessionId).catch(() => {});
    return this.tabInfo(tab.id);
  }
  async updateTab(id, props) {
    const tab = this.requireTab(id);
    if (props.url) {tab.pendingUrl = props.url;this.onUpdated.fire(tab.id, {status: 'loading'});void this.cdp.send('Page.navigate', {url: props.url}, tab.control).catch(() => {});}
    if (props.active) {this.activeTab = tab.id;await this.cdp.send('Target.activateTarget', {targetId: tab.targetId}).catch(() => {});}
    return this.tabInfo(tab.id);
  }
  async closeTab(id) {
    const tab = this.requireTab(id);this.tabsById.delete(tab.id);this.controlTab.delete(tab.control);
    if (this.debugRoot.has(tab.id)) this.dropDebugger(tab.id, 'target_closed');
    await this.cdp.send('Target.closeTarget', {targetId: tab.targetId}).catch(() => {});
    this.onRemoved.fire(tab.id, {windowId: 1, isWindowClosing: false});
  }
  async attach(tabId) {
    const tab = this.requireTab(tabId);
    if (this.debugRoot.has(tab.id)) throw chromeError('Another debugger is already attached to the tab with id: ' + tab.id + '.');
    const {sessionId} = await this.cdp.send('Target.attachToTarget', {targetId: tab.targetId, flatten: true});
    this.debugRoot.set(tab.id, sessionId);this.sessionTab.set(sessionId, tab.id);
  }
  dropDebugger(tabId, reason) {
    const root = this.debugRoot.get(tabId);if (!root) return;this.debugRoot.delete(tabId);
    for (const [sessionId, owner] of [...this.sessionTab]) if (owner === tabId) this.sessionTab.delete(sessionId);
    if (reason) this.onDetach.fire({tabId}, reason);
  }
  async detach(tabId) {
    const root = this.debugRoot.get(Number(tabId));if (!root) throw chromeError('Debugger is not attached to the tab with id: ' + tabId + '.');
    this.dropDebugger(Number(tabId), null);
    await this.cdp.send('Target.detachFromTarget', {sessionId: root}).catch(() => {});
  }
  async sendCommand(tabId, sessionId, method, params) {
    const root = this.debugRoot.get(Number(tabId));if (!root) throw chromeError('Debugger is not attached to the tab with id: ' + tabId + '.');
    if (sessionId && this.sessionTab.get(sessionId) !== Number(tabId)) throw chromeError('No session with given id');
    return this.cdp.send(method, params, sessionId || root);
  }
  /** 给测试用：在「浏览器自己的」会话里跑一段页面脚本（扩展看不到这条会话）。 */
  async evaluate(tabId, expression) {
    const tab = this.requireTab(tabId);
    const result = await this.cdp.send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}, tab.control);
    if (result.exceptionDetails) throw new Error('页面脚本出错：' + JSON.stringify(result.exceptionDetails).slice(0, 300));
    return result.result?.value;
  }
  /** 给测试用：像用户一样动一下鼠标（可信事件，不经扩展的会话）。 */
  async userMouseMove(tabId, x = 40, y = 40) {
    const tab = this.requireTab(tabId);
    await this.cdp.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y}, tab.control);
  }
  route({method, params = {}, sessionId}) {
    if (!sessionId) {
      if (method === 'Target.detachedFromTarget') {const tabId = this.sessionTab.get(params.sessionId);if (tabId !== undefined && this.debugRoot.get(tabId) === params.sessionId) this.dropDebugger(tabId, 'target_closed');}
      if (method === 'Target.targetInfoChanged') {for (const tab of this.tabsById.values()) if (tab.targetId === params.targetInfo?.targetId) tab.title = params.targetInfo.title;}
      return;
    }
    const controlOf = this.controlTab.get(sessionId);
    if (controlOf !== undefined) {
      const tab = this.tabsById.get(controlOf);if (!tab) return;
      if (method === 'Page.frameNavigated' && !params.frame?.parentId) {
        // about:blank 是新标签页起始的空白页，不算导航到了。
        if (params.frame.url === 'about:blank' && tab.pendingUrl && tab.pendingUrl !== 'about:blank') return;
        tab.url = params.frame.url + (params.frame.urlFragment || '');tab.pendingUrl = '';this.onUpdated.fire(tab.id, {url: tab.url});
      }
      if (method === 'Page.navigatedWithinDocument' && params.frameId === tab.targetId) {tab.url = params.url;this.onUpdated.fire(tab.id, {url: tab.url});}
      return;
    }
    const tabId = this.sessionTab.get(sessionId);if (tabId === undefined) return;
    if (method === 'Target.attachedToTarget') this.sessionTab.set(params.sessionId, tabId);
    if (method === 'Target.detachedFromTarget') this.sessionTab.delete(params.sessionId);
    const root = this.debugRoot.get(tabId);
    this.onEvent.fire(sessionId === root ? {tabId} : {tabId, sessionId}, method, params);
  }
}

/** 本机测试网页。routes：路径 → 字符串或 (req, res, url) => 字符串/void。127.0.0.1 和 localhost 是两个站点（跨源 iframe 用）。 */
export async function startServer(routes) {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));hits.push(url.pathname + url.search);
    const route = routes[url.pathname] ?? routes['*'];
    if (route === undefined) {res.statusCode = 404;res.end('not found');return;}
    try {
      const body = typeof route === 'function' ? await route(req, res, url, server.base) : route;
      if (res.writableEnded) return;
      if (!res.getHeader('content-type')) res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');res.end(body ?? '');
    } catch (error) {res.statusCode = 500;res.end(String(error));}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  server.base = `http://127.0.0.1:${port}`;server.cross = `http://localhost:${port}`;server.hits = hits;
  const close = () => new Promise(resolve => {server.closeAllConnections?.();server.close(() => resolve());});
  return {base: server.base, cross: server.cross, hits, close, server};
}
