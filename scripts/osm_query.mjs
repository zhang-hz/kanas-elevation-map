// OSM query helper for link verification.
//   node scripts/osm_query.mjs ways-near <lat> <lon> <radius_m>
//   node scripts/osm_query.mjs way <osmWayId>
// Reads data/osm/highways.json + water.json (Overpass JSON, node refs).
import fs from "node:fs";

const ROOT = "C:/Data/Code/Kanas";
const LAT0 = 48.70, LON0 = 87.10, MPD_LAT = 111203.9, MPD_LON = 73610.1;
const toKM = (lat, lon) => [(lon - LON0) * MPD_LON / 1000, (lat - LAT0) * MPD_LAT / 1000];

const nodeLL = new Map();
const ways = [];
for (const f of ["highways.json", "water.json"]) {
  const raw = JSON.parse(fs.readFileSync(`${ROOT}/data/osm/${f}`, "utf8"));
  for (const e of raw.elements) if (e.type === "node") nodeLL.set(e.id, [e.lat, e.lon]);
  for (const e of raw.elements) {
    if (e.type !== "way" || !e.nodes) continue;
    const pts = [];
    for (const n of e.nodes) {
      const ll = nodeLL.get(n);
      if (ll) pts.push({ id: n, lat: ll[0], lon: ll[1], km: toKM(ll[0], ll[1]) });
    }
    ways.push({ id: e.id, tags: e.tags || {}, pts, src: f });
  }
}

function segDist2(a, b, p) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1e-12;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "ways-near") {
  const [lat, lon, rad] = args.map(Number);
  const p = toKM(lat, lon);
  const out = [];
  for (const w of ways) {
    let d = 1e9;
    for (let i = 0; i + 1 < w.pts.length; i++) {
      d = Math.min(d, segDist2(w.pts[i].km, w.pts[i + 1].km, p));
    }
    if (d * 1000 <= rad) out.push({ id: w.id, distM: +(d * 1000).toFixed(0), tags: w.tags, src: w.src });
  }
  out.sort((a, b) => a.distM - b.distM);
  for (const o of out) {
    console.log(`${o.distM}m  way/${o.id}  ${JSON.stringify(o.tags)}`);
  }
  console.log(`(${out.length} ways within ${rad} m)`);
} else if (cmd === "way") {
  const id = Number(args[0]);
  const w = ways.find(x => x.id === id);
  if (!w) { console.log("not found"); process.exit(1); }
  console.log(`way/${w.id}  ${JSON.stringify(w.tags)}`);
  for (const p of w.pts) console.log(`  ${p.lat.toFixed(6)} ${p.lon.toFixed(6)}  (node ${p.id})`);
} else {
  console.log("usage: ways-near <lat> <lon> <radius_m> | way <osmWayId>");
}
