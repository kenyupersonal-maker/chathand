/* ChatHand 右上角背景（1014）：「柔光」，四团软光，2D 画布，1/3 分辨率。
   ctx 是 app.js 给的：ctx.params() 当前参数（CSS 变量，皮肤里写；aReach 面积、aSize 团块大小、aX/aY 位置）；ctx.phase() 颜色相位；
   ctx.arc() 色相范围；ctx.oklch(L,C,h) 转成 [r,g,b]；ctx.reduce() 是否「减少动态效果」。
   循环由 app.js 的动效循环统一驱动（约 30 帧/秒）；窗口最小化、被完全挡住时浏览器自己停。 */
(() => {
  'use strict';
  if (window.ChatHandBackdrops) return;
  let ctx = null, inst = null, host = null;
  const TAU = Math.PI * 2;
  const SOFT = [{x:.05,y:.03,r:.2,ex:1.75,ey:.68,rot:.5,o:0,T:[23,29,31,37,41]},{x:.23,y:.02,r:.17,ex:1.95,ey:.58,rot:-.3,o:1.7,T:[27,33,43,47,31]},
    {x:.09,y:.18,r:.16,ex:1.45,ey:.78,rot:1.15,o:3.1,T:[35,41,29,23,53]},{x:.31,y:.11,r:.12,ex:1.6,ey:.72,rot:.25,o:4.4,T:[39,47,31,29,43]}];
  function soft(host, ctx) {
    const cv = document.createElement('canvas'); cv.className = 'bd-full'; host.append(cv);
    const g2 = cv.getContext('2d'); if (!g2) return null;
    const AS = 1 / 3; let W = 0, H = 0;
    function resize() { const nw = Math.max(2, Math.round(innerWidth * AS)), nh = Math.max(2, Math.round(innerHeight * AS)); if (nw !== W || nh !== H) { W = nw; H = nh; cv.width = W; cv.height = H; } if (ctx.reduce()) frame(performance.now()); }
    function frame(now) {
      const P = ctx.params(), t = now / 1000 * P.aSpeed, D = Math.hypot(W, H) * P.aReach / .46, [ha, hb, ck] = ctx.arc(), X0 = W + (P.aX || 0) * AS, Y0 = (P.aY || 0) * AS;
      g2.setTransform(1, 0, 0, 1, 0, 0); g2.globalCompositeOperation = 'source-over'; g2.clearRect(0, 0, W, H);
      g2.globalCompositeOperation = P.dark ? 'lighter' : 'source-over';
      for (let i = 0; i < SOFT.length; i++) {
        const b = SOFT[i], s = k => Math.sin(TAU * t / b.T[k] + b.o + k * 1.3);
        const cx = X0 - (b.x + .045 * s(0)) * D, cy = Y0 + (b.y + .035 * s(1)) * D, r = b.r * D * P.aSize * (1 + .1 * s(2)), rot = b.rot + .55 * s(3), ex = b.ex * (1 + .16 * s(4)), ey = b.ey * (1 - .1 * s(4));
        const hue = ha + (hb - ha) * (.5 - .5 * Math.cos(ctx.phase() + (i === 3 ? 0 : i * TAU / 3))), [R, G, B] = ctx.oklch(P.aL, P.aC * ck, hue), a = P.aAlpha * (.82 + .18 * s(2)), c = R + ',' + G + ',' + B;
        const cs = Math.cos(rot), sn = Math.sin(rot); g2.setTransform(ex * cs, ex * sn, -ey * sn, ey * cs, cx, cy);
        const gr = g2.createRadialGradient(0, 0, 0, 0, 0, r); gr.addColorStop(0, `rgba(${c},${a.toFixed(3)})`); gr.addColorStop(.36, `rgba(${c},${(a * .62).toFixed(3)})`); gr.addColorStop(.68, `rgba(${c},${(a * .2).toFixed(3)})`); gr.addColorStop(1, `rgba(${c},0)`);
        g2.fillStyle = gr; g2.fillRect(-r, -r, 2 * r, 2 * r);
      }
      g2.setTransform(1, 0, 0, 1, 0, 0); g2.globalCompositeOperation = 'destination-in';
      const dx = W * P.aReach * 1.1, dy = H * P.aReach * 1.4, len = Math.hypot(dx, dy), nx = dy / len, ny = -dx / len, dist = dx * nx, fx = X0 - nx * dist, fy = Y0 - ny * dist;
      const lg = g2.createLinearGradient(fx - nx * dist * .3, fy - ny * dist * .3, fx + nx * dist * .6, fy + ny * dist * .6);
      lg.addColorStop(0, 'rgba(0,0,0,0)'); lg.addColorStop(.3, 'rgba(0,0,0,.18)'); lg.addColorStop(.55, 'rgba(0,0,0,.55)'); lg.addColorStop(.8, 'rgba(0,0,0,.88)'); lg.addColorStop(1, '#000');
      g2.fillStyle = lg; g2.fillRect(0, 0, W, H);
      const rg = g2.createRadialGradient(X0, Y0, 0, X0, Y0, dist * 2.3); rg.addColorStop(0, '#000'); rg.addColorStop(.45, 'rgba(0,0,0,.85)'); rg.addColorStop(.75, 'rgba(0,0,0,.35)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
      g2.fillStyle = rg; g2.fillRect(0, 0, W, H); g2.globalCompositeOperation = 'source-over';
    }
    return { frame, resize, refresh: () => { if (ctx.reduce()) frame(performance.now()); }, destroy: () => cv.remove() };
  }
  function mount() {
    unmount();
    if (!ctx) return;
    host = document.createElement('div'); host.className = 'fx-backdrop'; host.setAttribute('aria-hidden', 'true');
    document.body.prepend(host);
    try { inst = soft(host, ctx); } catch (e) { inst = null; console.warn('backdrop', e); }
    if (inst) inst.resize?.(); else host.replaceChildren();
  }
  function unmount() { try { inst?.destroy?.(); } catch {} inst = null; host?.remove(); host = null; }
  window.ChatHandBackdrops = Object.freeze({
    /* app.js 调：attach 开始画（网点加光团模式），detach 停 */
    attach(c) { ctx = c; if (!host) mount(); },
    detach() { ctx = null; unmount(); },
    attached: () => !!inst,
    frame(now) { if (inst) try { inst.frame(now); } catch (e) { console.warn('backdrop frame', e); unmount(); } },
    resize() { inst?.resize?.(); },
    refresh() { inst?.refresh?.(); },
  });
})();
