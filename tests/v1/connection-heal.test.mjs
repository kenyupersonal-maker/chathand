// 连接自愈：看云端真实状态；本机进程好好的但云端连不上时先自己重连一次，还不行再说（只说一次）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TunnelManager, currentSystemProxy, CONTROL_PLANE_DOWN_AFTER_MS } from "../../engine/src/tunnel.mjs";
import { ConnectionController } from "../../app/connection.mjs";

function manager(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chathand-cp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const m = new TunnelManager(dir, "http://127.0.0.1:1/mcp", "token");
  m.child = { pid: 1 };
  m.runningProxy = "http://user:secret@127.0.0.1:7890";
  m.cp = { startedAt: 0, lastOkAt: 0, notOkSince: 1000, failures: 0, status: "starting", reason: null };
  return m;
}
const details = (status, reason) => ({ live: true, ready: true, components: { "control-plane": { status, ...(reason ? { reason_code: reason } : {}) } } });

test("云端状态：ok 是在线；不 ok 先算检查中，满 2 分钟才算连不上", (t) => {
  const m = manager(t);
  let cp = m.observeControlPlane(details("degraded", "UPSTREAM_TIMEOUT"), 1000 + 5000);
  assert.equal(cp.state, "checking");
  assert.equal(cp.reason_code, "UPSTREAM_TIMEOUT");
  assert.equal(cp.proxy, "http://127.0.0.1:7890", "代理地址不带账号密码");
  cp = m.observeControlPlane(details("degraded"), 1000 + CONTROL_PLANE_DOWN_AFTER_MS);
  assert.equal(cp.state, "down");
  assert.equal(cp.down_since, 1000);
  cp = m.observeControlPlane(details("ok"), 1000 + CONTROL_PLANE_DOWN_AFTER_MS + 10);
  assert.equal(cp.state, "up");
  assert.equal(cp.last_success_at, 1000 + CONTROL_PLANE_DOWN_AFTER_MS + 10);
  assert.equal(cp.down_since, null);
  // 健康接口读不到属于未知，不能当成云端明确故障
  cp = m.observeControlPlane(null, 500000);
  assert.equal(cp.status, "unreachable");
  cp = m.observeControlPlane(null, 500000 + CONTROL_PLANE_DOWN_AFTER_MS);
  assert.equal(cp.state, "unknown");
});

test("老版本 tunnel-client 没有详细健康接口：不乱判断，照旧看本机", (t) => {
  const m = manager(t);
  const cp = m.observeControlPlane({ unsupported: true }, 999999);
  assert.equal(cp.state, "unknown");
  assert.equal(cp.supported, false);
  m.child = null;
  assert.equal(m.observeControlPlane(details("ok")), null, "没在跑就没有云端状态");
});

test("系统代理：读得到就返回地址，读不到或不是 Mac 返回 null", () => {
  assert.equal(currentSystemProxy({ platform: "darwin", systemProxy: () => "HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7890\n" }), "http://127.0.0.1:7890");
  assert.equal(currentSystemProxy({ platform: "darwin", systemProxy: () => "HTTPSEnable : 0\n" }), null);
  assert.equal(currentSystemProxy({ platform: "linux", systemProxy: () => "HTTPSEnable : 1\nHTTPSProxy : x\nHTTPSPort : 1\n" }), null);
  assert.equal(currentSystemProxy({ platform: "darwin", systemProxy: () => { throw new Error("no scutil"); } }), null);
});

function controller() {
  const calls = { stop: 0, unavailable: 0, lost: [], back: 0 };
  const tunnel = { child: { pid: 1 }, doctorChild: null, stop() { calls.stop++; this.child = null; } };
  let now = 100000;
  const c = new ConnectionController({
    tunnel,
    state: { data: {}, save() {} },
    onUnavailable: () => calls.unavailable++,
    onCloudLost: (cp) => calls.lost.push(cp),
    onCloudBack: () => calls.back++,
    clock: () => now,
  });
  c.desired = true;
  c.phase = "ready";
  return { c, calls, tunnel, advance: (ms) => (now += ms) };
}

test("云端连不上：45 秒后重连；按 1/2/5 分钟梯子继续，第二次后只通知一次", () => {
  const { c, calls, tunnel, advance } = controller();
  c.watchCloud({ state: "checking" });
  c.watchCloud({ state: "down", proxy: "direct" });
  assert.equal(calls.stop, 0, "45 秒内保留原进程");
  advance(44999); c.watchCloud({ state: "down", proxy: "direct" });
  assert.equal(calls.stop, 0);
  advance(1); c.watchCloud({ state: "down", proxy: "direct" });
  assert.equal(calls.stop, 1);
  assert.equal(c.phase, "reconnecting");
  assert.equal(c.lastRestart.reason, "cloud_down");
  assert.equal(calls.lost.length, 0, "第一次不打扰用户");
  for (const [delay, count] of [[60000, 2], [120000, 3], [300000, 4]]) {
    tunnel.child = { pid: count }; c.phase = "ready";
    advance(delay - 1); c.watchCloud({ state: "down", proxy: "direct" });
    assert.equal(calls.stop, count - 1);
    advance(1); c.watchCloud({ state: "down", proxy: "direct" });
    assert.equal(calls.stop, count);
    c.watchCloud({ state: "down", proxy: "direct" });
    assert.equal(calls.lost.length, 1, "第二次后只通知一次");
    assert.equal(calls.lost[0].proxy, "direct");
  }
  c.watchCloud({ state: "up" });
  assert.equal(calls.back, 1);
  assert.equal(c.snapshot().cloud_lost, false);
  c.watchCloud({ state: "down" });
  assert.equal(calls.stop, 4, "恢复后重置 45 秒等待");
  advance(45000); c.watchCloud({ state: "down" });
  assert.equal(calls.stop, 5);
});

test("重连：网络问题被挡住时每次只多试一次；密钥问题不自动重试", () => {
  const { c, calls } = controller();
  c.phase = "needs_retry";
  c.blocked = true;
  c.errorCode = "CONNECTION_AUTH_FAILED";
  assert.equal(c.retryOnce(), false);
  c.errorCode = "CONNECTION_UNAVAILABLE";
  assert.equal(c.retryOnce(), true);
  assert.equal(c.blocked, false);
  assert.equal(c.attempts, 2, "失败一次就又停下，等下一次检查");
  assert.equal(c.phase, "reconnecting");
  assert.ok(calls.unavailable >= 1);
  c.desired = false;
  assert.equal(c.restart("proxy_changed"), false, "用户断开后不自己连");
});

test("用过的连接断了、重连三次都不行：通知一次；从没连上过的不通知", () => {
  const { c, calls } = controller();
  c.failed(false);
  c.failed(false);
  c.failed(false);
  assert.equal(c.blocked, true);
  assert.equal(calls.lost.length, 0, "没连上过（比如刚开机）不打扰");
  const second = controller();
  second.c.wasReady = true;
  for (let i = 0; i < 3; i++) second.c.failed(false);
  assert.equal(second.calls.lost.length, 1);
  second.c.failed(false);
  assert.equal(second.calls.lost.length, 1, "只说一次");
  const auth = controller();
  auth.c.wasReady = true;
  auth.c.failed(true);
  assert.equal(auth.calls.lost.length, 0, "密钥问题不算断网");
});
