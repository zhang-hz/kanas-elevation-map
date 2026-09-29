/* router.js — geo helpers, DEM sampling, routing graph (A*), profiles
 *
 * Routing design (v2):
 *  - snapping produces several CANDIDATE projections (diverse, one per way);
 *    when the user clicked a specific line, that way's projection is forced in.
 *  - a waypoint's snap is chosen by TOTAL cost (arrive + leave), so a point
 *    "on the way" wins over a nearby dead-end spur — routes truly pass through
 *    waypoints instead of detouring to them.
 *  - each leg is an A* search over the hiking-time cost (Tobler × surface).
 */
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
  const WALK_V0 = 4.3;   // 散步配速基准（平地约 3.6 km/h）
  const WALK_KMH = 4.5;  // A* 启发式速度上限（须 ≥ 最快可能速度，保证启发式可采纳）

  function toblerHours(lenM, dE) {
    let s = dE / Math.max(lenM, 1);
    if (s > 0.6) s = 0.6;
    if (s < -0.6) s = -0.6;
    const vKmh = WALK_V0 * Math.exp(-3.5 * Math.abs(s + 0.05));
    return (lenM / 1000) / vKmh;
  }

  function edgeHours(ei, forward) {
    const e = edges[ei];
    const mult = CLS_MULT[(D.ways[e[2]] || {}).cls] || 1.15;
    const dE = forward ? e[7] - e[6] : e[6] - e[7];
    return toblerHours(e[5], dE) * mult;
  }

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

  // ---------------- snapping ----------------
  function projectOnEdge(ei, x, y) {
    const e = edges[ei];
    const a = nodes[e[0]], b = nodes[e[1]];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    let t = 0;
    if (l2 > 0) t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
    const qx = a[0] + dx * t, qy = a[1] + dy * t;
    return { ei, t, x: qx, y: qy, dist: distM(x, y, qx, qy) };
  }

  /** top-k candidate snaps: one per distinct way (diverse), hint-way forced in */
  function snapCandidates(x, y, hint, k) {
    const all = [];
    for (let ei = 0; ei < edges.length; ei++) all.push(projectOnEdge(ei, x, y));
    all.sort((p, q) => p.dist - q.dist);
    const out = [];
    const seenWays = new Set();
    if (hint != null && hint >= 0 && D.ways[hint]) {
      let best = null;
      for (const p of all) {
        if (edges[p.ei][2] === hint && (!best || p.dist < best.dist)) best = p;
      }
      if (best) { out.push(best); seenWays.add(hint); }
    }
    for (const p of all) {
      if (p.dist > 400) break;
      const w = edges[p.ei][2];
      if (seenWays.has(w)) continue;
      seenWays.add(w);
      out.push(p);
      if (out.length >= k) break;
    }
    return out.length ? out : (all.length ? [all[0]] : []);
  }

  function nearestOnNetwork(x, y) {
    let best = null;
    for (let ei = 0; ei < edges.length; ei++) {
      const p = projectOnEdge(ei, x, y);
      if (!best || p.dist < best.dist) best = p;
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

  // ---------------- profile slicing ----------------
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

  // ---------------- one leg between two snapped points (A*) ----------------
  function dijkstraLeg(sa, sb) {
    if (!sa || !sb) return null;
    if (sa.ei === sb.ei) {
      return { ok: true, hours: partialEdgeHours(sa.ei, sa.t, sb.t), sameEdge: true };
    }
    const se = edges[sa.ei], te = edges[sb.ei];
    const startCost = [
      toblerHours(sa.dist, 0) + partialEdgeHours(sa.ei, sa.t, 0),
      toblerHours(sa.dist, 0) + partialEdgeHours(sa.ei, sa.t, 1),
    ];
    const endExtra = [
      toblerHours(sb.dist, 0) + partialEdgeHours(sb.ei, 0, sb.t),
      toblerHours(sb.dist, 0) + partialEdgeHours(sb.ei, 1, sb.t),
    ];
    const endNodes = [te[0], te[1]];
    const goal = { x: sb.x, y: sb.y, a: nodes[te[0]], b: nodes[te[1]] };

    const n = nodes.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const prevEdge = new Int32Array(n).fill(-1);
    const prevFwd = new Uint8Array(n);
    const heap = new Heap();
    const h = (i) => {
      const g = nodes[i];
      const d = Math.min(
        distM(g[0], g[1], goal.x, goal.y),
        distM(g[0], g[1], goal.a[0], goal.a[1]),
        distM(g[0], g[1], goal.b[0], goal.b[1]));
      return (d / 1000) / WALK_KMH;
    };
    for (let k = 0; k < 2; k++) {
      const nd = k === 0 ? se[0] : se[1];
      if (startCost[k] < dist[nd]) {
        dist[nd] = startCost[k];
        heap.push(startCost[k] + h(nd), nd);
      }
    }
    const done = new Uint8Array(n);
    let bestTotal = Infinity;
    while (heap.size()) {
      const top = heap.pop();
      const f = top[0], u = top[1];
      if (done[u]) continue;
      done[u] = 1;
      const cost = dist[u];
      if (cost + Math.min(endExtra[0], endExtra[1]) >= bestTotal) break;
      const ei0 = endNodes.indexOf(u);
      if (ei0 >= 0) {
        const total = cost + endExtra[ei0];
        if (total < bestTotal) bestTotal = total;
      }
      const fw = adjF[u], bw = adjB[u];
      if (fw) for (let k = 0; k < fw.length; k++) {
        const ei = fw[k], v = edges[ei][1];
        const nc = cost + edgeHours(ei, true);
        if (nc < dist[v]) {
          dist[v] = nc; prev[v] = u; prevEdge[v] = ei; prevFwd[v] = 1;
          heap.push(nc + h(v), v);
        }
      }
      if (bw) for (let k = 0; k < bw.length; k++) {
        const ei = bw[k], v = edges[ei][0];
        const nc = cost + edgeHours(ei, false);
        if (nc < dist[v]) {
          dist[v] = nc; prev[v] = u; prevEdge[v] = ei; prevFwd[v] = 0;
          heap.push(nc + h(v), v);
        }
      }
    }
    let endNode = -1, bestEnd = Infinity, endT = 1;
    for (let i = 0; i < 2; i++) {
      const total = dist[endNodes[i]] + endExtra[i];
      if (total < bestEnd) { bestEnd = total; endNode = endNodes[i]; endT = i === 0 ? 1 : 0; }
    }
    if (endNode < 0 || !isFinite(bestEnd)) return null;

    let startNode = endNode;
    while (prev[startNode] >= 0) startNode = prev[startNode];
    const startT = (startNode === se[0]) ? 0 : 1;

    const pathEdges = [];
    let cur = endNode;
    while (cur !== startNode && cur >= 0) {
      const ei = prevEdge[cur];
      if (ei < 0) break;
      pathEdges.push([ei, prevFwd[cur] === 1]);
      cur = prev[cur];
    }
    pathEdges.reverse();
    return {
      ok: true, hours: bestEnd, pathEdges,
      startNode, startT, endNode, endT,
    };
  }

  // ---------------- assemble a leg into line + profile ----------------
  function assembleLeg(sa, sb, leg, x1, y1, x2, y2) {
    const prof = [[0, elevAtKm(x1, y1)]];
    const line = [[x1, y1]];
    let dAcc = sa.dist;
    if (sa.dist > 0.5) prof.push([dAcc, elevAtKm(sa.x, sa.y)]);
    line.push([sa.x, sa.y]);

    if (leg.sameEdge) {
      const mid = edgeProfile(sa.ei, sa.t, sb.t);
      appendProf(prof, mid);
      dAcc += mid[mid.length - 1][0];
      line.push([sb.x, sb.y]);
    } else {
      const legStart = edgeProfile(sa.ei, sa.t, leg.startT);
      appendProf(prof, legStart);
      if (legStart.length) dAcc += legStart[legStart.length - 1][0];
      line.push([nodes[leg.startNode][0], nodes[leg.startNode][1]]);

      for (let i = 0; i < leg.pathEdges.length; i++) {
        const ei = leg.pathEdges[i][0], fwd = leg.pathEdges[i][1];
        const lp = edgeProfile(ei, fwd ? 0 : 1, fwd ? 1 : 0);
        appendProf(prof, lp);
        dAcc += lp[lp.length - 1][0];
        const vn = fwd ? edges[ei][1] : edges[ei][0];
        line.push([nodes[vn][0], nodes[vn][1]]);
      }
      const legEnd = edgeProfile(sb.ei, leg.endT, sb.t);
      appendProf(prof, legEnd);
      if (legEnd.length) dAcc += legEnd[legEnd.length - 1][0];
      line.push([sb.x, sb.y]);
    }

    if (sb.dist > 0.5) {
      dAcc += sb.dist;
      prof.push([dAcc, elevAtKm(x2, y2)]);
    }
    line.push([x2, y2]);
    return { line, prof, hours: leg.hours + toblerHours(sa.dist, 0) + toblerHours(sb.dist, 0) };
  }

  // ---------------- route through points ----------------
  function route(x1, y1, x2, y2, hintA, hintB) {
    return routeVia([[x1, y1], [x2, y2]], [hintA, hintB]);
  }

  function routeVia(points, hints) {
    if (points.length < 2) return { error: "至少需要两个点" };
    hints = hints || [];
    const n = points.length;

    // 1) pick interior waypoint snaps by total (arrive + leave) cost,
    //    so "on the way" positions beat nearby dead-end spurs
    const snaps = new Array(n).fill(null);
    for (let j = 1; j < n - 1; j++) {
      const cands = snapCandidates(points[j][0], points[j][1], hints[j], 5);
      if (!cands.length) return { error: "路网数据缺失" };
      const prevSnap = snaps[j - 1] ||
        snapCandidates(points[j - 1][0], points[j - 1][1], hints[j - 1], 1)[0];
      const nextSnap = snapCandidates(points[j + 1][0], points[j + 1][1], hints[j + 1], 1)[0];
      let best = cands[0], bestScore = Infinity;
      for (const c of cands) {
        const inL = dijkstraLeg(prevSnap, c);
        const outL = dijkstraLeg(c, nextSnap);
        if (!inL || !outL) continue;
        const score = inL.hours + outL.hours + 2 * toblerHours(c.dist, 0);
        if (score < bestScore) { bestScore = score; best = c; }
      }
      snaps[j] = best;
    }

    // 2) build legs; endpoints explore 3 candidates jointly with the leg cost
    const legs = [];
    for (let j = 0; j < n - 1; j++) {
      const candsA = j > 0 ? [snaps[j]]
        : snapCandidates(points[j][0], points[j][1], hints[j], 3);
      const candsB = j < n - 2 ? [snaps[j + 1]]
        : snapCandidates(points[j + 1][0], points[j + 1][1], hints[j + 1], 3);
      if (!candsA.length || !candsB.length) return { error: "路网数据缺失" };
      let best = null;
      for (const sa of candsA) {
        for (const sb of candsB) {
          const leg = dijkstraLeg(sa, sb);
          if (!leg) continue;
          const total = leg.hours + toblerHours(sa.dist, 0) + toblerHours(sb.dist, 0);
          if (!best || total < best.total) best = { leg, sa, sb, total };
        }
      }
      if (!best) {
        return { error: "两点之间路网不连通，无法规划步行线路" };
      }
      legs.push(assembleLeg(best.sa, best.sb, best.leg,
        points[j][0], points[j][1], points[j + 1][0], points[j + 1][1]));
    }

    // 3) stitch legs
    const prof = [];
    const line = [];
    let hours = 0, base = 0;
    legs.forEach((r, i) => {
      hours += r.hours;
      r.prof.forEach((p, j) => {
        if (i > 0 && j === 0) return;
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

  // ---------------- straight-line profiles ----------------
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
    nearestNode, nearestOnNetwork, snapCandidates,
    route, routeVia, dijkstraLeg,
    straightProfile, straightVia,
    sliceWayDir, sampleElevAt, edgeProfile,
    computeStats, fmtDist, fmtTime, toblerHours, nodes, edges,
  };
})();
