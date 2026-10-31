// Child targets are routed only through Chrome's authenticated flat sessions.
// Missing child sessions fail closed, without falling back to the parent.
const fault = code => Object.assign(new Error(code), {code});
export const MAX_FRAME_COUNT = 32;

export function frameDocumentId(frame) {
  return frame?.loaderId || frame?.documentId || null;
}

function frameURL(frame, fallback = '') {
  return String(frame?.url || fallback || '');
}

function originOf(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function inheritedURL(url, parentURL) {
  const value = String(url || '');
  if (value === 'about:blank' || value === 'about:srcdoc' || value === '') return parentURL;
  return value;
}

function flatten(entry, parentId, path, output, limit, state) {
  if (output.length >= limit) {
    state.truncated = true;
    return;
  }
  const frame = entry?.frame;
  if (!frame?.id) throw fault('ELEMENT_FRAME_UNSUPPORTED');
  const current = {
    ...frame,
    parentId: frame.parentId || parentId || null,
    path: [...path, frame.id]
  };
  output.push(current);
  for (const child of entry.childFrames || []) {
    flatten(child, current.id, current.path, output, limit, state);
    if (state.truncated) return;
  }
}

export async function readFrameTree(driver, id, generation, rootURL = '') {
  const result = await driver.send(id, 'Page.getFrameTree', {}, generation);
  if (!result?.frameTree?.frame?.id) throw fault('ELEMENT_FRAME_UNSUPPORTED');
  const frames = [];
  const state = {truncated: false};
  flatten(result.frameTree, null, [], frames, MAX_FRAME_COUNT, state);
  if (!frames[0].url && rootURL) frames[0].url = rootURL;
  const sessionFrames = new Map();
  for (const entry of driver.childSessions?.get(id)?.values() || []) {
    const child = await driver.send(id, 'Page.getFrameTree', {}, generation, entry.sessionId);
    if (!child.frameTree?.frame) continue;
    entry.frameId = child.frameTree.frame.id;entry.frame = child.frameTree.frame;
    const parent = [...(driver.childSessions.get(id)?.values() || [])].find(candidate => candidate.sessionId === entry.parentSessionId);
    const childFrames = [];flatten(child.frameTree, null, [], childFrames, MAX_FRAME_COUNT, state);
    for (const childFrame of childFrames) {
      const existing = frames.find(frame => frame.id === childFrame.id);
      const frame = {...existing, ...childFrame, sessionId: entry.sessionId, parentId: childFrame.parentId || existing?.parentId || parent?.frameId || frames[0].id};
      sessionFrames.set(frame.id, entry.sessionId);
      if (existing) Object.assign(existing, frame);else if (frames.length < MAX_FRAME_COUNT) frames.push(frame);else state.truncated = true;
    }
  }
  driver.childFrameSessions?.set(id, sessionFrames);
  if(driver.experienceFramesTruncated?.has(id))state.truncated=true;
  for (const frame of frames) {
    frame.crossOrigin = originOf(inheritedURL(frame.url, frames[0].url)) !== originOf(frames[0].url);
  }
  return {tree: result.frameTree, root: frames[0], frames, truncated: state.truncated};
}

export function findFrame(frameInfo, frameId) {
  return frameInfo.frames.find(frame => frame.id === frameId) || null;
}

export function frameChain(frameInfo, frameId) {
  const byId = new Map(frameInfo.frames.map(frame => [frame.id, frame]));
  let current = byId.get(frameId);
  if (!current) throw fault('ELEMENT_FRAME_UNSUPPORTED');
  const chain = [];
  while (current) {
    chain.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : null;
  }
  if (!chain.length || chain[0].id !== frameInfo.root.id) throw fault('ELEMENT_FRAME_UNSUPPORTED');
  return chain;
}

export function frameSupport(frameInfo, frame) {
  if (!frame) return {supported: false, reason: 'ELEMENT_FRAME_UNSUPPORTED'};
  const chain = frameChain(frameInfo, frame.id);
  const rootURL = frameURL(frameInfo.root);
  const rootOrigin = originOf(rootURL);
  if (!rootOrigin) return {supported: false, reason: 'ELEMENT_FRAME_UNSUPPORTED'};
  let parentURL = rootURL;
  for (let index = 1; index < chain.length; index += 1) {
    const candidate = inheritedURL(frameURL(chain[index]), parentURL);
    if (originOf(candidate) !== rootOrigin && !chain[index].sessionId) {
      return {supported: false, reason: 'CROSS_ORIGIN_FRAME_UNSUPPORTED'};
    }
    parentURL = candidate;
  }
  return {supported: true, reason: null};
}

export async function createFrameWorld(driver, id, frameId, generation, worldName = 'KenBridge.Actionability') {
  const result = await driver.sendFrame(id, frameId, 'Page.createIsolatedWorld', {
    frameId,
    worldName,
    grantUniveralAccess: false
  }, generation);
  if (!Number.isSafeInteger(result?.executionContextId)) throw fault('ELEMENT_FRAME_UNSUPPORTED');
  return result.executionContextId;
}

export async function resolveNodeInFrame(driver, id, frameId, backendNodeId, generation, worldName = 'KenBridge.Actionability') {
  const executionContextId = await createFrameWorld(driver, id, frameId, generation, worldName);
  const result = await driver.sendFrame(id, frameId, 'DOM.resolveNode', {backendNodeId, executionContextId}, generation);
  if (!result?.object?.objectId) throw fault('ELEMENT_CHANGED');
  return {objectId: result.object.objectId, executionContextId};
}
