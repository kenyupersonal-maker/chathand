import test from 'node:test';
import assert from 'node:assert/strict';
import {macSystemHttpsProxy,tunnelEnvironment} from '../../engine/src/tunnel.mjs';

const systemProxy=`<dictionary> {
  HTTPSEnable : 1
  HTTPSProxy : 127.0.0.1
  HTTPSPort : 7890
}`;

test('桌面启动无代理环境时，隧道使用 macOS 的 HTTPS 代理且本机 MCP 绕过代理',()=>{
  const env=tunnelEnvironment({platform:'darwin',parent:{},systemProxy:()=>systemProxy});
  assert.equal(env.HTTPS_PROXY,'http://127.0.0.1:7890');
  assert.equal(env.CONTROL_PLANE_HTTP_PROXY,'http://127.0.0.1:7890');
  assert.equal(env.NO_PROXY,'127.0.0.1,localhost');
  assert.equal(env.no_proxy,env.NO_PROXY);
});

test('显式代理优先，系统代理未启用或无效时不注入代理',()=>{
  let systemCalls=0;
  const explicit=tunnelEnvironment({platform:'darwin',parent:{HTTPS_PROXY:'http://127.0.0.1:8080'},systemProxy:()=>{systemCalls++;return systemProxy;}});
  assert.equal(explicit.CONTROL_PLANE_HTTP_PROXY,'http://127.0.0.1:8080');
  assert.equal(systemCalls,0);
  const allProxy=tunnelEnvironment({platform:'darwin',parent:{ALL_PROXY:'socks5://127.0.0.1:1080'},systemProxy:()=>{systemCalls++;return systemProxy;}});
  assert.equal(allProxy.ALL_PROXY,'socks5://127.0.0.1:1080');
  assert.equal(allProxy.HTTPS_PROXY,undefined);
  assert.equal(systemCalls,0);
  assert.equal(macSystemHttpsProxy(systemProxy.replace('HTTPSEnable : 1','HTTPSEnable : 0')),null);
  assert.equal(macSystemHttpsProxy(systemProxy.replace('HTTPSPort : 7890','HTTPSPort : 0')),null);
  const disabled=tunnelEnvironment({platform:'darwin',parent:{},systemProxy:()=>systemProxy.replace('HTTPSEnable : 1','HTTPSEnable : 0')});
  assert.equal(disabled.HTTPS_PROXY,undefined);
  assert.equal(disabled.CONTROL_PLANE_HTTP_PROXY,undefined);
});
