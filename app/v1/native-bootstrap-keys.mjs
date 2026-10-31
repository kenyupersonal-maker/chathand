const HEX_UI = /^[a-f0-9]{32,128}$/;
const HEX_OWNER = /^[a-f0-9]{64}$/;
const empty = () => ({uiKey: null, nativeOwnerKey: null});

export function parseNativeBootstrap(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 512) return empty();
  const line = text.trim();
  if (HEX_UI.test(line)) return {uiKey: line, nativeOwnerKey: null};
  let value;
  try { value = JSON.parse(line); } catch { return empty(); }
  if (!value || value.v !== 2 || !HEX_UI.test(value.ui_key || '') || !HEX_OWNER.test(value.owner_key || '') || value.ui_key === value.owner_key) return empty();
  return {uiKey: value.ui_key, nativeOwnerKey: value.owner_key};
}

export function readNativeBootstrap(stream = process.stdin, {timeoutMs = 5000} = {}) {
  return new Promise(resolve => {
    let text = '', finished = false;
    const finish = invalid => {
      if (finished) return;
      finished = true; clearTimeout(timer); stream.pause();
      stream.removeListener('data', onData); stream.removeListener('end', onEnd); stream.removeListener('error', onError);
      resolve(invalid ? empty() : parseNativeBootstrap(text));
    };
    const onData = chunk => { text += chunk; if (Buffer.byteLength(text, 'utf8') > 512) finish(true); else if (text.includes('\n')) finish(false); };
    const onEnd = () => finish(false);
    const onError = () => finish(true);
    const timer = setTimeout(() => finish(true), timeoutMs);
    stream.setEncoding('utf8'); stream.on('data', onData); stream.on('end', onEnd); stream.on('error', onError);
  });
}
