// Evidence pack for auto-generated gap links (tier-1 continuation + tier-2 gap).
// For every link: endpoints in lat/lon, DEM profile along it, water crossings,
// bridge evidence, nearby OSM ways. Output: data/research/link_review.json
import fs from "node:fs";
import path from "node:path";

const ROOT = "C:/Data/Code/Kanas";
const LAT0 = 48.70, LON0 = 87.10, MPD_LAT = 111203.9, MPD_LON = 73610.1;

const txt = fs.readFileSync(`${ROOT}/web/data/kanas_data.js`, "utf8");
const D = JSON.parse(txt.replace(/^[^=]*=/, "").replace(/;\s*$/, ""));

const toLL = (x, y) => [y * 1000 / MPD_LAT + LAT0, x * 1000 / MPD_LON + LON0];

// ---- DEM grid (int16 base64, relative elevations, metres) ----
const G = D.demGrid;
const gv = Buffer.from(G.values, "base64");
const grid = new Int16Array(gv.buffer, gv.byteOffset, gv.byteLength / 2);
function demAt(lat, lon) {
  const r = (lat - G.n) / -G.dLat, c = (lon - G.w) / G.dLon;
  const r0 = Math.max(0, Math.min(G.rows - 2, Math.floor(r)));
  const c0 = Math.max(0, Math.min(G.cols - 2, Math.floor(c)));
  const fr = r - r0, fc = c - c0;
  const v = (rr, cc) => grid[rr * G.cols + cc];
  return v(r0, c0) * (1 - fr) * (1 - fc) + v(r0 + 1, c0) * fr * (1 - fc) +
         v(r0, c0 + 1) * (1 - fr) * fc + v(r0 + 1, c0 + 1) * fr * fc;
}

// ---- geometry helpers (km plane) ----
function segInt(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) {
    const t = d1 / (d1 - d2);
    return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
  }
  return null;
}
function segDist2(a, b, p) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1e-12;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const qx = a[0] + t * dx, qy = a[1] + t * dy;
  return Math.hypot(p[0] - qx, p[1] - qy);
}
function segSegDist(a, b, c, d) {
  if (segInt(a, b, c, d)) return 0;
  return Math.min(segDist2(a, b, c), segDist2(a, b, d), segDist2(c, d, a), segDist2(c, d, b));
}
function ptInPoly(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---- raw OSM ways (for bridge evidence + corridor check) ----
const raw = JSON.parse(fs.readFileSync(`${ROOT}/data/osm/highways.json`, "utf8"));
const rawWater = JSON.parse(fs.readFileSync(`${ROOT}/data/osm/water.json`, "utf8"));
const nodeLL = new Map();
for (const e of raw.elements) if (e.type === "node") nodeLL.set(e.id, [e.lat, e.lon]);
for (const e of rawWater.elements) if (e.type === "node" && !nodeLL.has(e.id)) nodeLL.set(e.id, [e.lat, e.lon]);
const toKM = (lat, lon) => [(lon - LON0) * MPD_LON / 1000, (lat - LAT0) * MPD_LAT / 1000];
const osmWays = [];
for (const e of [...raw.elements, ...rawWater.elements]) {
  if (e.type !== "way" || !e.nodes) continue;
  const pts = [];
  for (const n of e.nodes) {
    const ll = nodeLL.get(n);
    if (ll) pts.push(toKM(ll[0], ll[1]));
  }
  if (pts.length < 2) continue;
  osmWays.push({ id: e.id, tags: e.tags || {}, pts });
}
const clsOf = (t) => {
  if (t.railway) return "railway";
  if (t.waterway) return "waterway:" + t.waterway;
  if (t.highway) return t.highway;
  return t.natural ? "natural:" + t.natural : "other";
};

// ---- water features from the map data ----
const rivers = D.rivers.map(r => ({ ...r, kind: r.cls }));   // cls: river|stream
const lakes = D.lakes.map((l, i) => ({ ...l, i }));

const links = D.ways.filter(w => w.id < 0);

// nearest mapped (non-link) way to a point — endpoint ownership context
function nearestMapWay(p) {
  let best = { d: 1e9, w: null };
  for (const mw of D.ways) {
    if (mw.id < 0) continue;
    for (let i = 0; i + 1 < mw.geom.length; i++) {
      const d = segDist2(mw.geom[i], mw.geom[i + 1], p);
      if (d < best.d) best = { d, w: mw, seg: i };
    }
  }
  return { name: best.w ? best.w.name : "", cls: best.w ? best.w.cls : "", distM: +(best.d * 1000).toFixed(0) };
}

const report = [];
for (const w of links) {
  const [x0, y0] = w.geom[0], [x1, y1] = w.geom[1];
  const p0 = [x0, y0], p1 = [x1, y1];
  const [lat0, lon0] = toLL(x0, y0), [lat1, lon1] = toLL(x1, y1);
  const mid = [(x0 + x1) / 2, (y0 + y1) / 2];

  // DEM profile along the link (21 samples)
  const prof = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const [la, lo] = toLL(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
    prof.push(+demAt(la, lo).toFixed(1));
  }
  const demMin = Math.min(...prof), demMax = Math.max(...prof);

  // water crossings
  const crossings = [];
  for (const rv of rivers) {
    for (let i = 0; i + 1 < rv.geom.length; i++) {
      const hit = segInt(p0, p1, rv.geom[i], rv.geom[i + 1]);
      if (hit) {
        const t = Math.hypot(hit[0] - p0[0], hit[1] - p0[1]) / (Math.hypot(x1 - x0, y1 - y0) || 1);
        crossings.push({ type: rv.kind, name: rv.name || "", at: +t.toFixed(2), pt: [+hit[0].toFixed(3), +hit[1].toFixed(3)] });
      }
    }
  }
  for (const lk of lakes) {
    const ring = lk.geom[0];
    for (let i = 0; i + 1 < ring.length; i++) {
      const hit = segInt(p0, p1, ring[i], ring[i + 1]);
      if (hit) crossings.push({ type: "lake", name: lk.name || "", at: 0.5, pt: [+hit[0].toFixed(3), +hit[1].toFixed(3)] });
    }
    if (ptInPoly(mid, ring)) crossings.push({ type: "lake-inside", name: lk.name || "", at: 0.5, pt: [+mid[0].toFixed(3), +mid[1].toFixed(3)] });
  }

  // bridge evidence near each crossing + nearest OSM way to link midpoint
  const nearWays = [];
  for (const ow of osmWays) {
    let best = 1e9;
    for (let i = 0; i + 1 < ow.pts.length; i++) {
      const d = segSegDist(p0, p1, ow.pts[i], ow.pts[i + 1]);
      if (d < best) best = d;
      if (best === 0) break;
    }
    if (best < 0.08) {
      nearWays.push({
        osmId: ow.id, distM: +(best * 1000).toFixed(0), cls: clsOf(ow.tags),
        name: ow.tags.name || "", bridge: ow.tags.bridge || "", tunnel: ow.tags.tunnel || "",
        surface: ow.tags.surface || "", highway: ow.tags.highway || "",
      });
    }
  }
  nearWays.sort((a, b) => a.distM - b.distM);
  for (const c of crossings) {
    const cp = c.pt;
    const cands = [];
    for (const ow of osmWays) {
      let bmin = 1e9;
      for (let i = 0; i + 1 < ow.pts.length; i++) {
        const d = segDist2(ow.pts[i], ow.pts[i + 1], cp);
        if (d < bmin) bmin = d;
      }
      if (bmin < 0.05) cands.push({ osmId: ow.id, distM: +(bmin * 1000).toFixed(0), cls: clsOf(ow.tags), bridge: ow.tags.bridge || "", tunnel: ow.tags.tunnel || "", name: ow.tags.name || "" });
    }
    cands.sort((a, b) => a.distM - b.distM);
    c.nearestWays = cands.slice(0, 5);
    c.bridgeway = cands.find(x => x.bridge) || null;
    c.hasBridgeTag = cands.some(x => x.bridge && x.distM <= 40);
  }

  // S2 tile coverage for the endpoints (z16)
  const s2 = (lat, lon) => {
    const z = 16, n = 2 ** z;
    const x = Math.floor((lon + 180) / 360 * n);
    const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n);
    const f = `${ROOT}/data/research/s2_tiles/${z}_${x}_${y}.jpg`;
    return { tile: `${z}_${x}_${y}`, have: fs.existsSync(f) };
  };
  const s2p0 = s2(lat0, lon0), s2p1 = s2(lat1, lon1);

  report.push({
    id: w.id,
    tier: w.name === "数据缺口连接（地图数据未覆盖）" ? 2 : 1,
    cls: w.cls, name: w.name, lenM: w.len,
    e: w.e, gradePct: +((w.e[1] - w.e[0]) / (w.len || 1) * 100).toFixed(1),
    p0: { x: x0, y: y0, lat: +lat0.toFixed(6), lon: +lon0.toFixed(6), elev: w.e[0] },
    p1: { x: x1, y: y1, lat: +lat1.toFixed(6), lon: +lon1.toFixed(6), elev: w.e[1] },
    demProfile: prof, demMin, demMax,
    demSag: +(Math.min(w.e[0], w.e[1]) - demMin).toFixed(1),
    crossings,
    nearWays: nearWays.slice(0, 8),
    end0Way: nearestMapWay(p0),
    end1Way: nearestMapWay(p1),
    parallelDup: (() => {
      // a single mapped way passing near BOTH ends spans the gap -> link is redundant
      for (const mw of D.ways) {
        if (mw.id < 0) continue;
        let d0 = 1e9, d1 = 1e9;
        for (let i = 0; i + 1 < mw.geom.length; i++) {
          d0 = Math.min(d0, segDist2(mw.geom[i], mw.geom[i + 1], p0));
          d1 = Math.min(d1, segDist2(mw.geom[i], mw.geom[i + 1], p1));
        }
        if (d0 < 0.025 && d1 < 0.025) return { name: mw.name, cls: mw.cls, d0m: +(d0 * 1000).toFixed(0), d1m: +(d1 * 1000).toFixed(0) };
      }
      return null;
    })(),
    s2: [s2p0, s2p1],
  });
}

fs.writeFileSync(`${ROOT}/data/research/link_review.json`, JSON.stringify(report, null, 1));

// quick self-check summary
let nWater = 0, nBridge = 0;
for (const r of report) {
  if (r.crossings.length) {
    nWater++;
    const ok = r.crossings.every(c => c.hasBridgeTag);
    if (ok) nBridge++;
    else console.log(`WATER-NO-BRIDGE link ${r.id} [${r.tier === 2 ? "T2" : "T1"} ${r.cls}] ${r.name} len=${r.lenM}m  crossings=${JSON.stringify(r.crossings.map(c => ({ t: c.type, n: c.name, near: (c.nearestWays || []).slice(0, 2).map(w => w.cls + "/" + (w.bridge || "-") + "@" + w.distM + "m") })))}`);
  }
}
console.log(`links: ${report.length}, crossing water: ${nWater}, of which with mapped bridge: ${nBridge}`);
console.log(`written: ${ROOT}/data/research/link_review.json`);
