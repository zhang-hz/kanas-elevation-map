// probe_route2.mjs — quantitative route-quality checks: waypoints must be ON the route
import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9343;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const proc = spawn(EDGE, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`,
  "--user-data-dir=C:/Temp/kanas-edge-" + Date.now() + "" + Date.now(), "--window-size=1280,720", "about:blank",
], { stdio: "ignore" });
let tabs;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  try { tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (tabs.length) break; } catch {}
}
let target;
try {
  target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent("http://127.0.0.1:8823/")}`, { method: "PUT" })).json();
} catch {
  target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent("http://127.0.0.1:8823/")}`)).json();
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
});
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;
for (let i = 0; i < 80; i++) {
  await sleep(500);
  if (await evalJs(`document.querySelectorAll('.route-item').length > 0`)) break;
}
await sleep(800);

const out = await evalJs(`(() => {
  const R = window.KANAS.router, D = window.KANAS_DATA;
  const distM = window.KANAS.geo.distM;

  function lineDist(line, x, y) { // min distance point->route line, metres
    let best = Infinity;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, distM(x, y, a[0] + dx * t, a[1] + dy * t));
    }
    return best;
  }
  function alongLen(pts) {
    let s = 0;
    for (let i = 1; i < pts.length; i++) s += distM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    return s;
  }

  // pick the longest road as the corridor
  const road = D.ways.filter(w => w.cls === 'road').sort((a, b) => b.len - a.len)[0];
  const g = road.geom;
  const n = g.length;
  const A = g[0], B = g[n - 1];
  const W = g[Math.floor(n / 2)];

  const res = {};
  res.corridor = { name: road.name, wayIdx: D.ways.indexOf(road), verts: n, len: road.len };

  // T1: waypoint exactly on the corridor
  let r1 = R.routeVia([[A[0], A[1]], [W[0], W[1]], [B[0], B[1]]], [null, res.corridor.wayIdx, null]);
  res.T1 = r1.ok ? {
    missW: +lineDist(r1.line, W[0], W[1]).toFixed(1),
    routeLen: +r1.stats.len.toFixed(0),
    refLen: road.len,
    detour: +(r1.stats.len / road.len).toFixed(3),
  } : { error: r1.error };

  // T2: waypoint 40 m off the corridor (perpendicular)
  const i = Math.floor(n / 2);
  const a2 = g[i - 1], b2 = g[i + 1];
  let nx = -(b2[1] - a2[1]), ny = (b2[0] - a2[0]);
  const nl = Math.hypot(nx, ny) || 1;
  nx = nx / nl * 0.04; ny = ny / nl * 0.04; // 40 m in km units
  const Woff = [W[0] + nx, W[1] + ny];
  let r2 = R.routeVia([[A[0], A[1]], [Woff[0], Woff[1]], [B[0], B[1]]], [null, null, null]);
  res.T2 = r2.ok ? {
    missWoff: +lineDist(r2.line, Woff[0], Woff[1]).toFixed(1),
    routeLen: +r2.stats.len.toFixed(0),
    detour: +(r2.stats.len / road.len).toFixed(3),
  } : { error: r2.error };

  // T3: two ordered waypoints
  const W1 = g[Math.floor(n / 3)], W2 = g[Math.floor(2 * n / 3)];
  let r3 = R.routeVia([[A[0], A[1]], [W1[0], W1[1]], [W2[0], W2[1]], [B[0], B[1]]], null);
  if (r3.ok) {
    // verify visit order: position along the route line of first closest approach
    const firstAt = (x, y) => {
      let best = Infinity, at = -1, acc = 0;
      for (let k = 0; k < r3.line.length - 1; k++) {
        const p = r3.line[k], q = r3.line[k + 1];
        const seg = distM(p[0], p[1], q[0], q[1]);
        const t = seg > 0 ? Math.max(0, Math.min(1, ((x - p[0]) * (q[0] - p[0]) + (y - p[1]) * (q[1] - p[1])) / (seg * seg))) : 0;
        const d = distM(x, y, p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t);
        if (d < best) { best = d; at = acc + seg * t; }
        acc += seg;
      }
      return at;
    };
    res.T3 = {
      missW1: +lineDist(r3.line, W1[0], W1[1]).toFixed(1),
      missW2: +lineDist(r3.line, W2[0], W2[1]).toFixed(1),
      orderOK: firstAt(W1[0], W1[1]) < firstAt(W2[0], W2[1]),
      detour: +(r3.stats.len / road.len).toFixed(3),
    };
  } else res.T3 = { error: r3.error };

  // T4: plain A->B sanity
  let r4 = R.routeVia([[A[0], A[1]], [B[0], B[1]]], [res.corridor.wayIdx, res.corridor.wayIdx]);
  res.T4 = r4.ok ? { detour: +(r4.stats.len / road.len).toFixed(3), len: +r4.stats.len.toFixed(0) } : { error: r4.error };

  // T5: hinted vs unhinted snap for an off-corridor click near parallel ways
  const cands = R.snapCandidates(Woff[0], Woff[1], res.corridor.wayIdx, 4);
  res.T5 = { firstCandidateOnHintedWay: cands.length ? (D.ways.indexOf(D.ways.find(w => w === D.ways[window.__hi = res.corridor.wayIdx])) >= 0) : false,
    candDists: cands.map(c => +c.dist.toFixed(1)) };
  return JSON.stringify(res);
})()`);
console.log(out);
ws.close(); proc.kill(); process.exit(0);
