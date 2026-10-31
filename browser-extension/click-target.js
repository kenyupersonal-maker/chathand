// Read-only hit testing runs in an isolated world, not the page's JS realm.
// This is a conservative guard for the current driver, not a full locator
// engine. It never retries after dispatching an input event.
import {
  frameChain,
  frameDocumentId,
  frameSupport,
  readFrameTree,
  resolveNodeInFrame
} from './frame-tree.js';

const inspectTarget = `function() {
 if (!this.isConnected) return {reason:'ELEMENT_CHANGED'};
 if (this.ownerDocument !== document) return {reason:'ELEMENT_FRAME_UNSUPPORTED'};
 if (!(this instanceof Element)) return {reason:'ELEMENT_INVALID'};
 if (this.matches(':disabled') || this.getAttribute('aria-disabled') === 'true') return {reason:'ELEMENT_DISABLED'};
 const style = getComputedStyle(this), rect = this.getBoundingClientRect();
 if (style.visibility !== 'visible' || rect.width <= 0 || rect.height <= 0) return {reason:'ELEMENT_HIDDEN'};
 const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
 if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return {reason:'ELEMENT_OUTSIDE_VIEWPORT'};
 const hit = document.elementFromPoint(x, y);
 if (!hit || !(hit === this || this.contains(hit))) return {reason:'ELEMENT_OBSCURED'};
 return {x,y,width:rect.width,height:rect.height};
}`;

const inspectFrameOwner = `function(childPoint) {
 if (!this.isConnected || !(this instanceof Element)) return {reason:'ELEMENT_FRAME_UNSUPPORTED'};
 const unsafeLayout = (node) => {
  for (let current = node; current;) {
   const style = getComputedStyle(current);
   if (style.transform && style.transform !== 'none') return true;
   const zoom = style.zoom;
   if (zoom && zoom !== 'normal') {
    const value = Number.parseFloat(zoom);
    if (!Number.isFinite(value) || Math.abs(value - 1) > 0.0001) return true;
   }
   const root = current.getRootNode?.();
   current = current.parentElement || root?.host || null;
  }
  return false;
 };
 if (unsafeLayout(this)) return {reason:'ELEMENT_FRAME_UNSUPPORTED'};
 const rect = this.getBoundingClientRect();
 const x = rect.x + this.clientLeft + childPoint.x;
 const y = rect.y + this.clientTop + childPoint.y;
 if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return {reason:'ELEMENT_OUTSIDE_VIEWPORT'};
 const hit = document.elementFromPoint(x, y);
 if (hit !== this) return {reason:'ELEMENT_OBSCURED'};
 return {x, y};
}`;

const fault = code => Object.assign(new Error(code), {code});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function stable(a, b) {
  return ['x', 'y', 'width', 'height', 'mainX', 'mainY', 'inputX', 'inputY'].every(key => Math.abs(a[key] - b[key]) < 0.5);
}

async function projectToMainViewport(driver, id, chain, point, generation) {
  let current = {x: point.x, y: point.y};
  const targetSession = chain[chain.length - 1].sessionId || null;
  let input = {...current};
  for (let index = chain.length - 1; index > 0; index -= 1) {
    const child = chain[index];
    const parent = chain[index - 1];
    const owner = await driver.sendFrame(id, parent.id, 'DOM.getFrameOwner', {frameId: child.id}, generation);
    if (!owner?.backendNodeId) throw fault('ELEMENT_FRAME_UNSUPPORTED');
    const {objectId} = await resolveNodeInFrame(driver, id, parent.id, owner.backendNodeId, generation, 'KenBridge.FrameBoundary');
    try {
      const result = await driver.sendFrame(id, parent.id, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: inspectFrameOwner,
        arguments: [{value: current}],
        returnByValue: true
      }, generation);
      if (result.exceptionDetails) throw fault('ELEMENT_FRAME_UNSUPPORTED');
      const projected = result.result?.value;
      if (!projected || projected.reason) throw fault(projected?.reason || 'ELEMENT_FRAME_UNSUPPORTED');
      current = {x: projected.x, y: projected.y};
      // Same-process descendants share the OOPIF session's root viewport.
      if ((parent.sessionId || null) === targetSession) input = {...current};
    } finally {
      if (generation === driver.generation) await driver.sendFrame(id, parent.id, 'Runtime.releaseObject', {objectId}, generation).catch(() => {});
    }
  }
  return {...current, input_x: input.x, input_y: input.y};
}

export async function clickPoint(driver, id, target, generation, {timeoutMs = 3000, pollMs = 50} = {}) {
  const send = (method, params = {}) => driver.sendFrame(id, target.frameId, method, params, generation);
  const frameId = target.frameId;
  const frameInfo = await readFrameTree(driver, id, generation, target.frameUrl || target.url || '');
  const targetFrame = frameInfo.frames.find(frame => frame.id === frameId);
  const support = frameSupport(frameInfo, targetFrame);
  if (!support.supported) throw fault(support.reason);
  if (target.documentId !== undefined && target.documentId !== frameDocumentId(targetFrame)) throw fault('ELEMENT_CHANGED');
  const {objectId} = await resolveNodeInFrame(driver, id, frameId, target.backend, generation);
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let reason = 'ELEMENT_MOVING';
  try {
    do {
      driver.assertCurrent(generation);
      const currentInfo = await readFrameTree(driver, id, generation, target.frameUrl || target.url || '');
      const currentFrame = currentInfo.frames.find(frame => frame.id === frameId);
      const currentSupport = frameSupport(currentInfo, currentFrame);
      if (!currentSupport.supported) throw fault(currentSupport.reason);
      if (target.documentId !== undefined && target.documentId !== frameDocumentId(currentFrame)) throw fault('ELEMENT_CHANGED');
      const chain = frameChain(currentInfo, frameId);
      const result = await send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: inspectTarget,
        returnByValue: true
      });
      if (result.exceptionDetails) throw fault('ELEMENT_INSPECTION_FAILED');
      const point = result.result?.value;
      if (!point || (!point.reason && !['x', 'y', 'width', 'height'].every(key => Number.isFinite(point[key])))) throw fault('ELEMENT_GEOMETRY');
      if (point.reason) {
        reason = point.reason;
        previous = null;
        if (['ELEMENT_CHANGED', 'ELEMENT_DISABLED', 'ELEMENT_INVALID', 'ELEMENT_FRAME_UNSUPPORTED'].includes(reason)) throw fault(reason);
      } else {
        const main = await projectToMainViewport(driver, id, chain, point, generation);
        const candidate = {...point, mainX: main.x, mainY: main.y, inputX: main.input_x, inputY: main.input_y};
        if (previous && stable(candidate, previous)) return {x: main.x, y: main.y, frame_x: point.x, frame_y: point.y, input_x: main.input_x, input_y: main.input_y, width: point.width, height: point.height};
        previous = candidate;
        reason = 'ELEMENT_MOVING';
      }
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);
    throw fault(reason);
  } finally {
    if (generation === driver.generation) await send('Runtime.releaseObject', {objectId}).catch(() => {});
  }
}
