/* router.js — geo helpers, DEM sampling, routing graph (Dijkstra), profiles */
(function () {
  "use strict";
  const D = window.KANAS_DATA;
  const K = (window.KANAS = window.KANAS || {});

  // ---------------- geo helpers (local equirect km plane) ----------------
  const LAT0 = D.meta.lat0, LON0 = D.meta.lon0;
  const MPLAT = D.meta.mPerDegLat, MPLON = D.meta.mPerDegLon;

  function toKm(lat, lon) {
    return [(lon - LON0) * MPLON / 1000, (lat - LAT0) * MPLAT / 1000];
  }
  function toLatLon(x, y) {
    return [LAT0 + y * 1000 / MPLAT, LON0 + x * 1000 / MPLON];
  }
  function distM(x1, y1, x2, y2) {
    const dx = (x2 - x1) * 1000, dy = (y2 - y1) * 1000;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // ---------------- client DEM grid ----------------
  const G = D.demGrid;
  const grid = (function decode() {
    const bin = atob(G.values);
    const buf = new ArrayBuffer(bin.length);
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Int16Array(buf);
  })();

  /** bilinear elevation (relative to datum) at WGS84 position */
  function elevAt(lat, lon) {
    let c = (lon - G.w) / G.dLon - 0.5;
    let r = (G.n - lat) / G.dLat - 0.5;
    if (r < 0 || c < 0 || r > G.rows - 1 || c > G.cols - 1) return null;
    const r0 = Math.floor(r), c0 = Math.floor(c);
    const r1 = Math.min(r0 + 1, G.rows - 1), c1 = Math.min(c0 + 1, G.cols - 1);
    const fr = r - r0, fc = c - c0;
    const e00 = grid[r0 * G.cols + c0], e01 = grid[r0 * G.cols + c1];
    const e10 = grid[r1 * G.cols + c0], e11 = grid[r1 * G.cols + c1];
    return lerp(lerp(e00, e01, fc), lerp(e10, e11, fc), fr);
  }
  function elevAtKm(x, y) {
    const ll = toLatLon(x, y);
    const e = elevAt(ll[0], ll[1]);
    return e === null ? 0 : e;
  }

  // ---------------- routing graph ----------------
  const nodes = D.graph.nodes;   // [x, y, elev]
  const edges = D.graph.edges;   // [u, v, wayIdx, dStart, dEnd, lenM, eU, eV]
  const adjF = new Array(nodes.length);
  const adjB = new Array(nodes.length);
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    (adjF[e[0]] || (adjF[e[0]] = [])).push(i);
    (adjB[e[1]] || (adjB[e[1]] = [])).push(i);
  }

  const CLS_MULT = { path: 1.0, boardwalk: 1.0, steps: 1.35, track: 1.18, road: 1.22, link: 2.4 };

  function toblerHours(lenM, dE) {
    let s = dE / Math.max(lenM, 1);
    if (s > 0.6) s = 0.6;           // clamp DEM step noise on steep cut slopes
    if (s < -0.6) s = -0.6;
    const vKmh = 6 * Math.exp(-3.5 * Math.abs(s + 0.05));
    return (lenM / 1000) / vKmh;
  }

  function edgeHours(ei, forward) {
    const e = edges[ei];
    const mult = CLS_MULT[(D.ways[e[2]] || {}).cls] || 1.15;
    const dE = forward ? e[7] - e[6] : e[6] - e[7];
    return toblerHours(e[5], dE) * mult;
  }

  /** hours for part of an edge: t0..t1 (fraction from u to v) */
  function partialEdgeHours(ei, t0, t1) {
    const e = edges[ei];
    const mult = CLS_MULT[(D.ways[e[2]] || {}).cls] || 1.15;
    const len = Math.abs(t1 - t0) * e[5];
    const dE = (e[7] - e[6]) * (t1 - t0);
    return toblerHours(len, dE) * mult;
  }

  // ---------------- binary heap ----------------
  function Heap() { this.a = []; }
  Heap.prototype.push = function (pri, val) {
    const a = this.a;
    a.push([pri, val]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      const t = a[p]; a[p] = a[i]; a[i] = t;
      i = p;
    }
  };
  Heap.prototype.pop = function () {
    const a = this.a;
    if (!a.length) return null;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        const t = a[m]; a[m] = a[i]; a[i] = t;
        i = m;
      }
    }
    return top;
  };
  Heap.prototype.size = function () { return this.a.length; };

  /** project (x,y) onto every edge; return nearest point ON the network */
  function nearestOnNetwork(x, y) {
    let best = null, bestD = Infinity;
    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      const a = nodes[e[0]], b = nodes[e[1]];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      let t = 0;
      if (l2 > 0) t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
      const qx = a[0] + dx * t, qy = a[1] + dy * t;
      const d = distM(x, y, qx, qy);
      if (d < bestD) {
        bestD = d;
        best = { ei, t, x: qx, y: qy, dist: d };
      }
    }
    return best;
  }

  function nearestNode(x, y) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const dx = nodes[i][0] - x, dy = nodes[i][1] - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return { idx: best, dist: Math.sqrt(bestD) * 1000 };
  }

  // ---------------- way profile slicing ----------------
  function lowerBound(arr, v) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < v) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function sampleElevAt(way, d) {
    const ds = way.d, es = way.e;
    if (d <= ds[0]) return es[0];
    if (d >= ds[ds.length - 1]) return es[es.length - 1];
    const i = lowerBound(ds, d);
    const i0 = Math.max(0, i - 1), i1 = Math.min(ds.length - 1, i);
    const seg = ds[i1] - ds[i0];
    return seg === 0 ? es[i0] : lerp(es[i0], es[i1], (d - ds[i0]) / seg);
  }

  /** points of way between d0..d1, ordered along travel direction */
  function sliceWayDir(way, d0, d1, reverse) {
    let a = Math.min(d0, d1), b = Math.max(d0, d1);
    const ds = way.d, es = way.e;
    const out = [[a, sampleElevAt(way, a)]];
    const i0 = lowerBound(ds, a), i1 = lowerBound(ds, b);
    for (let i = i0; i <= i1 && i < ds.length; i++) {
      if (ds[i] > a && ds[i] < b) out.push([ds[i], es[i]]);
    }
    out.push([b, sampleElevAt(way, b)]);
    return reverse ? out.slice().reverse() : out;
  }

  /** profile of edge part t0..t1 (fractions from u), rebased to cumulative m */
  function edgeProfile(ei, t0, t1) {
    const e = edges[ei];
    const way = D.ways[e[2]];
    const dA = e[3] + (e[4] - e[3]) * t0;
    const dB = e[3] + (e[4] - e[3]) * t1;
    const pts = sliceWayDir(way, dA, dB, t1 < t0);
    const out = [[0, pts[0][1]]];
    let cum = 0;
    for (let j = 1; j < pts.length; j++) {
      cum += Math.abs(pts[j][0] - pts[j - 1][0]);
      out.push([cum, pts[j][1]]);
    }
    return out;
  }

  function appendProf(prof, leg) {
    const base = prof.length ? prof[prof.length - 1][0] : 0;
    for (let j = 1; j < leg.length; j++) {
      prof.push([base + leg[j][0], leg[j][1]]);
    }
  }

  // ---------------- Dijkstra between two snapped network points ----------------
  function route(x1, y1, x2, y2) {
    const s = nearestOnNetwork(x1, y1);
    const t = nearestOnNetwork(x2, y2);
    if (!s || !t) return { error: "路网数据缺失" };

    // start candidates: both endpoints of the edge holding the projection
    const se = edges[s.ei], te = edges[t.ei];
    const starts = [
      { node: se[0], t: 0, extra: s.dist + partialEdgeHours(s.ei, s.t, 0) },
      { node: se[1], t: 1, extra: s.dist + partialEdgeHours(s.ei, s.t, 1) },
    ];
    // note: extra mixes meters and hours; use hours for dijkstra, meters separately
    const startCost = [
      toblerHours(s.dist, 0) + partialEdgeHours(s.ei, s.t, 0),
      toblerHours(s.dist, 0) + partialEdgeHours(s.ei, s.t, 1),
    ];

    const n = nodes.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const prevEdge = new Int32Array(n).fill(-1);
    const prevFwd = new Uint8Array(n);
    const heap = new Heap();
    for (let k = 0; k < 2; k++) {
      const nd = starts[k].node;
      if (startCost[k] < dist[nd]) {
        dist[nd] = startCost[k];
        heap.push(startCost[k], nd);
      }
    }
    const endCandidates = [te[0], te[1]];
    const endExtra = [
      toblerHours(t.dist, 0) + partialEdgeHours(t.ei, 1, t.t),
      toblerHours(t.dist, 0) + partialEdgeHours(t.ei, 0, t.t),
    ];
    let visited = 0;
    while (heap.size()) {
      const top = heap.pop();
      const cost = top[0], u = top[1];
      if (cost > dist[u]) continue;
      if (endCandidates.indexOf(u) >= 0 && cost > Math.min(...endCandidates.map((c, i) => dist[c] + endExtra[i]))) {
        // both ends reachable and current cost already beyond best complete cost
        break;
      }
      visited++;
      const fw = adjF[u], bw = adjB[u];
      if (fw) for (let k = 0; k < fw.length; k++) {
        const ei = fw[k], v = edges[ei][1];
        const nc = cost + edgeHours(ei, true);
        if (nc < dist[v]) {
          dist[v] = nc; prev[v] = u; prevEdge[v] = ei; prevFwd[v] = 1;
          heap.push(nc, v);
        }
      }
      if (bw) for (let k = 0; k < bw.length; k++) {
        const ei = bw[k], v = edges[ei][0];
        const nc = cost + edgeHours(ei, false);
        if (nc < dist[v]) {
          dist[v] = nc; prev[v] = u; prevEdge[v] = ei; prevFwd[v] = 0;
          heap.push(nc, v);
        }
      }
    }

    // best end node
    let endNode = -1, bestTotal = Infinity, bestEndExtra = 0, bestEndT = 1;
    for (let i = 0; i < 2; i++) {
      const nd = endCandidates[i];
      const total = dist[nd] + endExtra[i];
      if (isFinite(total) && total < bestTotal) {
        bestTotal = total;
        endNode = nd;
        bestEndExtra = endExtra[i];
        bestEndT = i === 0 ? 1 : 0; // which end of te the route arrives at
      }
    }
    if (endNode < 0 || !isFinite(bestTotal)) {
      return { error: "两点之间路网不连通，无法规划步行线路", snapA: s, snapB: t };
    }

    // start node actually used
    let startNode = -1;
    {
      const s0 = startCost[0], s1 = startCost[1];
      // whichever source reached this path: use predecessor chain end
      startNode = endNode;
      while (prev[startNode] >= 0) startNode = prev[startNode];
    }
    const startT = (startNode === se[0]) ? 0 : 1;

    // reconstruct middle edges
    const pathEdges = [];
    let cur = endNode;
    while (cur !== startNode && cur >= 0) {
      const ei = prevEdge[cur];
      if (ei < 0) break;
      pathEdges.push([ei, prevFwd[cur] === 1]);
      cur = prev[cur];
    }
    pathEdges.reverse();

    // -------- assemble profile + line --------
    const prof = [[0, elevAtKm(x1, y1)]];
    const line = [[x1, y1]];
    let dAcc = s.dist;
    if (s.dist > 0.5) prof.push([dAcc, elevAtKm(s.x, s.y)]);
    line.push([s.x, s.y]);

    // partial edge from projection to start node
    const legStart = edgeProfile(s.ei, s.t, startT);
    appendProf(prof, legStart.map(p => [p[0], p[1]]));
    if (legStart.length) dAcc += legStart[legStart.length - 1][0];
    line.push([nodes[startNode][0], nodes[startNode][1]]);

    for (let i = 0; i < pathEdges.length; i++) {
      const ei = pathEdges[i][0], fwd = pathEdges[i][1];
      const leg = edgeProfile(ei, fwd ? 0 : 1, fwd ? 1 : 0);
      appendProf(prof, leg);
      dAcc += leg[leg.length - 1][0];
      const vn = fwd ? edges[ei][1] : edges[ei][0];
      line.push([nodes[vn][0], nodes[vn][1]]);
    }

    // partial edge from end node to end projection
    const legEnd = edgeProfile(t.ei, bestEndT, t.t);
    appendProf(prof, legEnd);
    if (legEnd.length) dAcc += legEnd[legEnd.length - 1][0];
    line.push([t.x, t.y]);

    if (t.dist > 0.5) {
      dAcc += t.dist;
      prof.push([dAcc, elevAtKm(x2, y2)]);
    }
    line.push([x2, y2]);

    const hours = bestTotal;
    return {
      ok: true,
      snapA: s, snapB: t,
      line, prof, hours,
      stats: computeStats(prof, hours),
      visited,
    };
  }

  /** route through waypoints: [A, W1, ..., B] */
  function routeVia(points) {
    if (points.length < 2) return { error: "至少需要两个点" };
    const legs = [];
    for (let i = 0; i < points.length - 1; i++) {
      const r = route(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]);
      if (r.error) return r;
      legs.push(r);
    }
    const prof = [];
    const line = [];
    let hours = 0;
    let base = 0;
    legs.forEach((r, i) => {
      hours += r.hours;
      r.prof.forEach((p, j) => {
        if (i > 0 && j === 0) return; // avoid duplicate junction point
        prof.push([base + p[0], p[1]]);
      });
      base += r.prof[r.prof.length - 1][0];
      r.line.forEach((p, j) => {
        if (i > 0 && j === 0) return;
        line.push(p);
      });
    });
    return {
      ok: true,
      legs: legs.length,
      line, prof, hours,
      stats: computeStats(prof, hours),
    };
  }

  function computeStats(prof, hours) {
    if (prof.length < 2) return null;
    const e = prof.map(p => p[1]);
    const sm = e.map((v, i) => {
      if (i === 0 || i === e.length - 1) return v;
      return (e[i - 1] + v + e[i + 1]) / 3;
    });
    let asc = 0, desc = 0, mn = Infinity, mx = -Infinity;
    for (let i = 0; i < sm.length; i++) {
      mn = Math.min(mn, sm[i]); mx = Math.max(mx, sm[i]);
      if (i > 0) {
        const d = sm[i] - sm[i - 1];
        if (d > 0) asc += d; else desc -= d;
      }
    }
    return {
      len: prof[prof.length - 1][0] - prof[0][0],
      ascent: asc, descent: desc,
      minE: mn, maxE: mx,
      hours: hours || 0,
    };
  }

  // ---------------- straight-line profile (terrain reference) ----------------
  function straightProfile(x1, y1, x2, y2) {
    const len = distM(x1, y1, x2, y2);
    const n = Math.max(2, Math.min(1200, Math.round(len / 60)));
    const prof = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = lerp(x1, x2, t), y = lerp(y1, y2, t);
      const ll = toLatLon(x, y);
      const e = elevAt(ll[0], ll[1]);
      prof.push([len * t, e === null ? 0 : e]);
    }
    return { ok: true, prof, stats: computeStats(prof, 0), line: [[x1, y1], [x2, y2]] };
  }

  /** full multi-point straight profile through waypoints */
  function straightVia(points) {
    const prof = [];
    const line = [points[0]];
    let base = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const r = straightProfile(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]);
      r.prof.forEach((p, j) => {
        if (i > 0 && j === 0) return;
        prof.push([base + p[0], p[1]]);
      });
      base += r.prof[r.prof.length - 1][0];
      line.push(points[i + 1]);
    }
    return { ok: true, prof, line, stats: computeStats(prof, 0) };
  }

  // ---------------- formatting ----------------
  function fmtDist(m) {
    return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 1 : 2) + " km" : Math.round(m) + " m";
  }
  function fmtTime(h) {
    const mins = Math.round(h * 60);
    if (mins < 60) return mins + " 分钟";
    return Math.floor(mins / 60) + " 小时 " + (mins % 60) + " 分";
  }

  K.geo = { toKm, toLatLon, distM, lerp, elevAt, elevAtKm };
  K.router = {
    nearestNode, nearestOnNetwork, route, routeVia,
    straightProfile, straightVia,
    sliceWayDir, sampleElevAt, edgeProfile,
    computeStats, fmtDist, fmtTime, toblerHours, nodes, edges,
  };
})();
