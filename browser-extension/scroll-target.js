// Fixed scrolling only: no caller-provided script and no input replay.
import {createFrameWorld, readFrameTree, resolveNodeInFrame} from './frame-tree.js';

const fault = code => Object.assign(new Error(code), {code});
const scrollAtTarget = `function(amount, point) {
 const start = point ? document.elementFromPoint(point.x, point.y) : this;
 if (!(start instanceof Element) || !start.isConnected || start.ownerDocument !== document) return {reason:'ELEMENT_CHANGED'};
 const root = document.scrollingElement;
 for (let current = start; current;) {
  const style = getComputedStyle(current);
  if (current.scrollHeight > current.clientHeight && (current === root || /^(auto|scroll|overlay)$/.test(style.overflowY))) {
   current.scrollBy({top:amount,left:0,behavior:'instant'});
   return {scrolled:true};
  }
  const tree = current.getRootNode();
  current = current.parentElement || tree.host || null;
 }
 return {scrolled:false};
}`;

/** Hidden widgets do not supply the compositor acknowledgement wheel input needs. */
export async function scrollPage(driver, id, amount, target, point, generation) {
 if (!Number.isFinite(amount) || Math.abs(amount) > 2000) throw fault('ARG_INVALID');
 const tab = await driver.page(id, generation);
 const info = await readFrameTree(driver, id, generation, tab.url);
 const rootContext = await createFrameWorld(driver, id, info.root.id, generation, 'KenBridge.Scroll');
 if (!point) {
  const center = await driver.sendFrame(id, info.root.id, 'Runtime.evaluate', {
   expression:'({x:innerWidth/2,y:innerHeight/2})',contextId:rootContext,returnByValue:true
  }, generation);
  if (center.exceptionDetails) throw fault('PAGE_HELPER_FAILED');
  point = center.result?.value;
 }
 if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw fault('ELEMENT_GEOMETRY');
 const visibility = await driver.sendFrame(id, info.root.id, 'Runtime.evaluate', {
  expression:'document.visibilityState',contextId:rootContext,returnByValue:true
 }, generation);
 if (visibility.exceptionDetails || !['hidden','visible'].includes(visibility.result?.value)) throw fault('PAGE_HELPER_FAILED');
 // Choose before dispatch. A timed-out wheel may already have run; never retry it as DOM scroll.
 if (visibility.result?.value !== 'hidden') {
  await driver.send(id, 'Input.dispatchMouseEvent', {type:'mouseWheel',x:point.x,y:point.y,deltaX:0,deltaY:amount}, generation);
  return;
 }
 const frameId = target?.frameId || info.root.id;
 let objectId;
 if (target) ({objectId} = await resolveNodeInFrame(driver, id, frameId, target.backend, generation, 'KenBridge.Scroll'));
 else {
  const result = await driver.sendFrame(id, frameId, 'Runtime.evaluate', {
   expression:'document.documentElement',contextId:rootContext
  }, generation);
  objectId = result.result?.objectId;
 }
 if (!objectId) throw fault('ELEMENT_CHANGED');
 try {
  const result = await driver.sendFrame(id, frameId, 'Runtime.callFunctionOn', {
   objectId,functionDeclaration:scrollAtTarget,
   arguments:[{value:amount},{value:target ? null : point}],returnByValue:true
  }, generation);
  if (result.exceptionDetails) throw fault('PAGE_HELPER_FAILED');
  if (result.result?.value?.reason) throw fault(result.result.value.reason);
  if (typeof result.result?.value?.scrolled !== 'boolean') throw fault('PAGE_HELPER_FAILED');
 } finally {
  if (generation === driver.generation) await driver.sendFrame(id, frameId, 'Runtime.releaseObject', {objectId}, generation).catch(() => {});
 }
}
