// probe_moonbay.mjs — reproduce 月亮湾→卧龙湾 riverside-trail corridor issues
import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9344;
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
await sleep(600);

const out = await evalJs(`(() => {
 try {
  const D = window.KANAS_DATA, R = window.KANAS.router, geo = window.KANAS.geo;
  const res = {};
  // ---- corridor inventory: ways between the two stations ----
  const A = { name: '月亮湾站', lat: 48.63344, lon: 87.04704 };
  const B = { name: '卧龙湾站', lat: 48.62061, lon: 87.05113 };
  const aKm = geo.toKm(A.lat, A.lon), bKm = geo.toKm(B.lat, B.lon);
  const minX = Math.min(aKm[0], bKm[0]) - 1.2, maxX = Math.max(aKm[0], bKm[0]) + 1.2;
  const minY = Math.min(aKm[1], bKm[1]) - 1.2, maxY = Math.max(aKm[1], bKm[1]) + 1.2;
  const near = [];
  D.ways.forEach((w, idx) => {
    let inside = 0;
    for (const p of w.geom) if (p[0] > minX && p[0] < maxX && p[1] > minY && p[1] < maxY) inside++;
    if (inside > 0) near.push({ idx, name: w.name, cls: w.cls, len: +w.len.toFixed(0), verts: w.geom.length, inside });
  });
  res.corridorWays = near.map(w => ({...w}));

  // ---- connectivity components of the graph ----
  const n = R.nodes.length;
  const parent = new Int32Array(n).fill(-1);
  const find = (i) => { while (parent[i] >= 0) i = parent[i]; return i; };
  for (const e of R.edges) { const a = find(e[0]), b = find(e[1]); if (a !== b) parent[a] = b; }
  const compOf = (x, y) => {
    let best = -1, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const dx = R.nodes[i][0] - x, dy = R.nodes[i][1] - y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return { comp: find(best), snapDist: Math.sqrt(bd) * 1000, node: best };
  };
  res.A = compOf(aKm[0], aKm[1]);
  res.B = compOf(bKm[0], bKm[1]);
  res.ABsameComponent = res.A.comp === res.B.comp;

  // ---- riverside ways: same component as A? ----
  const compInfo = near.map(w => {
    const wg = D.ways[w.idx].geom;
    const mid = wg[Math.floor(wg.length / 2)];
    const c = compOf(mid[0], mid[1]);
    return { name: w.name || ('#' + w.idx), cls: w.cls, len: w.len,
      comp: c.comp, sameAsA: c.comp === res.A.comp, sameAsB: c.comp === res.B.comp };
  });
  res.corridorComponents = compInfo;

  // ---- the user's exact route: A -> riverside waypoint -> B ----
  const riverWays = near.filter(w => w.cls === 'boardwalk' || w.cls === 'path');
  res.riverWayIdxs = riverWays.map(w => w.idx);
  if (riverWays.length) {
    // pick the longest riverside way, midpoint vertex as the waypoint
    // user scenario: a riverside-trail point BETWEEN the two stations
    const midAB = [(aKm[0] + bKm[0]) / 2, (aKm[1] + bKm[1]) / 2];
    let bestW = null;
    riverWays.forEach(w => {
      const g2 = D.ways[w.idx].geom;
      g2.forEach(pt => {
        const d = geo.distM(pt[0], pt[1], midAB[0], midAB[1]);
        if (!bestW || d < bestW.d) bestW = { d, idx: w.idx, cls: w.cls, name: w.name, at: pt };
      });
    });
    const rw = { idx: bestW.idx, cls: bestW.cls, name: bestW.name, len: bestW.d };
    const W = bestW.at;
    res.Wpick = { wayIdx: rw.idx, cls: rw.cls, name: rw.name, distToABmid: Math.round(bestW.d) };
    res.waypoint = { wayIdx: rw.idx, cls: rw.cls, name: rw.name, at: W };
    const r = R.routeVia([[aKm[0], aKm[1]], [W[0], W[1]], [bKm[0], bKm[1]]], [null, rw.idx, null]);
    if (r.ok) {
      // spur detection: how much of the route overlaps itself near the waypoint?
      // walk the route line and count total length vs unique coverage (10 m grid)
      const seen = new Set();
      let total = 0, unique = 0;
      for (let i = 0; i < r.line.length - 1; i++) {
        const p = r.line[i], q = r.line[i + 1];
        const seg = geo.distM(p[0], p[1], q[0], q[1]);
        total += seg;
        const steps = Math.max(1, Math.round(seg / 15));
        for (let s = 0; s < steps; s++) {
          const x = p[0] + (q[0] - p[0]) * s / steps, y = p[1] + (q[1] - p[1]) * s / steps;
          const key = Math.round(x * 100) + ':' + Math.round(y * 100); // 10 m cells
          if (!seen.has(key)) { seen.add(key); unique += seg / steps; }
        }
      }
      res.route = {
        len: +r.stats.len.toFixed(0), hours: +r.stats.hours.toFixed(2),
        backtrackRatio: +(total / unique).toFixed(3),
        directAB: +geo.distM(aKm[0], aKm[1], bKm[0], bKm[1]).toFixed(0),
        legs: r.legs,
      };
      // where does the route actually go? walk the assembled line and bucket by 500m cells
      const buckets = {};
      let acc = 0;
      for (let i = 0; i < r.line.length - 1; i++) {
        const p = r.line[i], q = r.line[i + 1];
        const seg = geo.distM(p[0], p[1], q[0], q[1]);
        const key = Math.round(q[0] * 2) + ':' + Math.round(q[1] * 2); // 500 m cells
        buckets[key] = (buckets[key] || 0) + seg;
        acc += seg;
      }
      res.routeCells = Object.entries(buckets).sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([k, v]) => k + ':' + Math.round(v));
      res.totalWalked = Math.round(acc);
      // leg-by-leg
      const legsInfo = [];
      const snapA0 = R.snapCandidates(aKm[0], aKm[1], null, 3);
      const snapW0 = R.snapCandidates(W[0], W[1], rw.idx, 5);
      const snapB0 = R.snapCandidates(bKm[0], bKm[1], null, 3);
      res.snapSets = {
        A: snapA0.map(c => +c.dist.toFixed(1)),
        W: snapW0.map(c => +c.dist.toFixed(1)),
        B: snapB0.map(c => +c.dist.toFixed(1)),
      };
      for (const sw of snapW0) {
        const l1 = R.dijkstraLeg(snapA0[0], sw), l2 = R.dijkstraLeg(sw, snapB0[0]);
        legsInfo.push({ wDist: +sw.dist.toFixed(1),
          inKm: l1 ? +(l1.hours * 6).toFixed(2) : null,
          outKm: l2 ? +(l2.hours * 6).toFixed(2) : null });
      }
      res.wpCandidateCosts = legsInfo;
      // dump the raw leg path: every edge's endpoints + length + way
      const sA = snapA0[0], sW = snapW0[0], sB = snapB0[0];
      const leg1 = R.dijkstraLeg(sA, sW);
      if (leg1 && leg1.pathEdges) {
        const rows = leg1.pathEdges.slice(0, 12).map(pr => {
          const e = R.edges[pr[0]];
          const a = R.nodes[e[0]], b = R.nodes[e[1]];
          return { way: (D.ways[e[2]] || {}).name, cls: (D.ways[e[2]] || {}).cls,
            len: +e[5].toFixed(0),
            a: [+a[0].toFixed(2), +a[1].toFixed(2)], b: [+b[0].toFixed(2), +b[1].toFixed(2)] };
        });
        res.leg1Head = rows;
        res.leg1Edges = leg1.pathEdges.length;
        const lastE = R.edges[leg1.pathEdges[leg1.pathEdges.length - 1][0]];
        const lastN = R.nodes[leg1.endNode];
        res.leg1EndNode = [+lastN[0].toFixed(2), +lastN[1].toFixed(2)];
        res.leg1EndWay = (D.ways[lastE[2]] || {}).name;
      }
      // edge sanity: any edge longer than 3 km (node pairs far apart)?
      let longEdges = [];
      for (let i = 0; i < R.edges.length; i++) {
        const e = R.edges[i];
        const d = geo.distM(R.nodes[e[0]][0], R.nodes[e[0]][1], R.nodes[e[1]][0], R.nodes[e[1]][1]);
        if (d > 1500) longEdges.push({ i, way: (D.ways[e[2]] || {}).name, d: Math.round(d), e5: e[5] });
      }
      res.longEdges = longEdges.slice(0, 10);
      res.longEdgeCount = longEdges.length;
      // detailed leg analysis: which ways are used; through vs spur at the waypoint
      const legWays = [];
      // reconstruct via the public dijkstraLeg for each leg with same snaps
      const snapW = R.snapCandidates(W[0], W[1], rw.idx, 5);
      res.wpCandidates = snapW.map(c => ({ dist: +c.dist.toFixed(1), wayIdx: c.ei, t: +c.t.toFixed(2) }));
      // walk the assembled line: check if it passes the waypoint area once or twice
      let nearW = 0;
      for (let i = 0; i < r.line.length - 1; i++) {
        const p = r.line[i], q = r.line[i + 1];
        for (let s = 0; s < 4; s++) {
          const x = p[0] + (q[0] - p[0]) * s / 4, y = p[1] + (q[1] - p[1]) * s / 4;
          if (geo.distM(x, y, W[0], W[1]) < 120) { nearW++; break; }
        }
      }
      res.nearWaypointSegments = nearW;
      // boardwalk fragment endpoint analysis: distance from each fragment end to nearest other fragment end
      const frag = [];
      riverWays.forEach(w => {
        const g2 = D.ways[w.idx].geom;
        const e0 = g2[0], e1 = g2[g2.length - 1];
        const nearestOther = (pt, myIdx) => {
          let best = Infinity;
          riverWays.forEach(o => {
            if (o.idx === myIdx) return;
            const og = D.ways[o.idx].geom;
            og.forEach(op => {
              const d = geo.distM(pt[0], pt[1], op[0], op[1]);
              if (d < best) best = d;
            });
          });
          return best;
        };
        frag.push({ idx: w.idx, len: w.len,
          gapStart: +nearestOther(e0, w.idx).toFixed(0),
          gapEnd: +nearestOther(e1, w.idx).toFixed(0) });
      });
      res.fragmentGaps = frag;
    } else res.route = { error: r.error };
  }

  // ---- straight A->B without waypoint (for comparison) ----
  const r0 = R.routeVia([[aKm[0], aKm[1]], [bKm[0], bKm[1]]], [null, null]);
  res.direct = r0.ok ? { len: +r0.stats.len.toFixed(0), backtrack: 0 } : { error: r0.error };
  return JSON.stringify(res);
 } catch (e) { return JSON.stringify({ fatal: String(e && e.stack || e) }); }
})()`);
console.log(out);
ws.close(); proc.kill(); process.exit(0);
