import fs from 'node:fs';
import path from 'node:path';
import {validStoreProfile} from './chrome-store-profiles.mjs';

const MAX_BYTES = 16 * 1024 * 1024;
const REFRESH_MS = 10_000;
const STALLED_MS = 40_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

function extensionState(document, extensionId) {
  if (!object(document)) return 'unknown';
  if (!Object.hasOwn(document, 'extensions')) return 'missing';
  if (!object(document.extensions)) return 'unknown';
  if (!Object.hasOwn(document.extensions, 'settings')) return 'missing';
  const settings = document.extensions.settings;
  if (!object(settings)) return 'unknown';
  if (!Object.hasOwn(settings, extensionId)) return 'missing';
  const record = settings[extensionId];
  if (!object(record)) return 'unknown';
  if (Object.hasOwn(record, 'disable_reasons')) {
    const reasons = record.disable_reasons;
    if (Array.isArray(reasons)) return reasons.length ? 'disabled' : 'enabled';
    if (Number.isSafeInteger(reasons) && reasons >= 0) return reasons === 0 ? 'enabled' : 'disabled';
    return 'unknown';
  }
  // Verified on the development Mac: enabled Chrome 1092 records omit both flags.
  if (!Object.hasOwn(record, 'state')) return 'enabled';
  return record.state === 1 ? 'enabled' : record.state === 0 ? 'disabled' : 'unknown';
}

/** Read-only, opt-in Chrome store extension presence. No Chrome contents are retained. */
export class ChromeExtensionPresence {
  #io;
  #now;
  #root;
  #extensionId;
  #files = new Map();
  #lastRefresh = null;
  #state = 'unknown';
  #waitingSince = null;

  constructor({home, extension_id, io = fs, now = Date.now}) {
    this.#root = path.join(home, 'Library/Application Support/Google/Chrome');
    this.#extensionId = extension_id;
    this.#io = io;
    this.#now = now;
  }

  resetStalled() {
    this.#waitingSince = null;
  }

  // Cache only the projection (profile IDs or this extension's state), never the JSON.
  #read(file, project) {
    const io = this.#io;
    let descriptor;
    try {
      const before = io.lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES || io.realpathSync(file) !== file) {
        this.#files.delete(file);
        return {ok: false};
      }
      const stamp = fingerprint(before);
      const cached = this.#files.get(file);
      if (cached?.stamp === stamp) return cached.result;
      let contents;
      if (typeof io.openSync === 'function' && typeof io.fstatSync === 'function' && typeof io.closeSync === 'function') {
        descriptor = io.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        const opened = io.fstatSync(descriptor);
        if (!opened.isFile() || opened.size > MAX_BYTES || fingerprint(opened) !== stamp || io.realpathSync(file) !== file) {
          this.#files.delete(file);
          return {ok: false};
        }
        contents = io.readFileSync(descriptor, 'utf8');
        if (fingerprint(io.fstatSync(descriptor)) !== stamp || fingerprint(io.lstatSync(file)) !== stamp || io.realpathSync(file) !== file) {
          this.#files.delete(file);
          return {ok: false};
        }
      } else {
        contents = io.readFileSync(file, 'utf8');
        if (fingerprint(io.lstatSync(file)) !== stamp || io.realpathSync(file) !== file) {
          this.#files.delete(file);
          return {ok: false};
        }
      }
      let result;
      try {
        result = {ok: true, value: project(JSON.parse(contents))};
      } catch {
        result = {ok: false};
      }
      this.#files.set(file, {stamp, result});
      return result;
    } catch (error) {
      this.#files.delete(file);
      return {ok: false, absent: error?.code === 'ENOENT'};
    } finally {
      if (descriptor !== undefined) {
        try { io.closeSync(descriptor); } catch { /* Read-only descriptor cleanup. */ }
      }
    }
  }

  #scan() {
    if (typeof this.#extensionId !== 'string' || this.#extensionId.length !== 32 || !/^[a-p]{32}$/u.test(this.#extensionId)) return 'unknown';
    const localFile = path.join(this.#root, 'Local State');
    const local = this.#read(localFile, document => {
      const info = document?.profile?.info_cache;
      if (!object(info)) throw new Error('Invalid profile list');
      const ids = Object.keys(info).filter(validStoreProfile);
      return {ids: ids.slice(0, 100), complete: ids.length <= 100 && ids.length > 0};
    });
    if (!local.ok) {
      for (const file of this.#files.keys()) if (file !== localFile) this.#files.delete(file);
      return 'unknown';
    }
    const activeFiles = new Set([localFile]);
    let incomplete = !local.value.complete;
    let disabled = false;
    let enabled = false;
    for (const id of local.value.ids) {
      const secureFile = path.join(this.#root, id, 'Secure Preferences');
      const preferencesFile = path.join(this.#root, id, 'Preferences');
      activeFiles.add(secureFile);
      const secure = this.#read(secureFile, document => extensionState(document, this.#extensionId));
      let state = secure.ok ? secure.value : 'unknown';
      if (!secure.ok || state === 'missing') {
        activeFiles.add(preferencesFile);
        const fallback = this.#read(preferencesFile, document => extensionState(document, this.#extensionId));
        state = fallback.ok ? fallback.value : secure.ok && secure.value === 'missing' && fallback.absent ? 'missing' : 'unknown';
      }
      enabled ||= state === 'enabled';
      disabled ||= state === 'disabled';
      incomplete ||= state === 'unknown';
    }
    for (const file of this.#files.keys()) if (!activeFiles.has(file)) this.#files.delete(file);
    return enabled ? 'enabled' : disabled ? 'disabled' : incomplete ? 'unknown' : 'missing';
  }

  refresh({optedIn = false, connected = false, chromeRunning = false, force = false} = {}) {
    if (!optedIn || connected) {
      this.resetStalled();
      return undefined;
    }
    const now = this.#now();
    if (force || this.#lastRefresh === null || now - this.#lastRefresh >= REFRESH_MS || now < this.#lastRefresh) {
      this.#state = this.#scan();
      this.#lastRefresh = now;
    }
    const running = Boolean(chromeRunning);
    if (running && this.#state === 'enabled') this.#waitingSince ??= now;
    else this.resetStalled();
    return {
      state: this.#state,
      chrome_running: running,
      stalled: this.#waitingSince !== null && now - this.#waitingSince >= STALLED_MS,
      checked_at: this.#lastRefresh,
    };
  }
}
