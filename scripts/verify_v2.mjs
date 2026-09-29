// verify_v2.mjs — regression checks for waypoints / exports / shuttle popups
import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = "http://127.0.0.1:8823/";
const PORT = 9336;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const proc = spawn(EDGE, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`,
  "--user-data-dir=C:\\Temp\\kanas-edge-v2", "--window-size=1280,720", "about:blank",
], { stdio: "ignore" });

let ok = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { ok++; console.log("PASS", name, extra ?? ""); }
  else { fail++; console.log("FAIL", name, extra ?? ""); }
};

let tabs;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  try { tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (tabs.length) break; } catch {}
}
let target;
try {
  target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL)}`, { method: "PUT" })).json();
} catch {
  target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL)}`)).json();
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
const evalJs = async (expression) => {
  const { result } = await send("Runtime.evaluate", { expression, returnByValue: true });
  return result.value;
};
const click = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(100);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(150);
};
const rectOf = async (expr) => evalJs(`(() => {
  const el = ${expr}; if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);

for (let i = 0; i < 80; i++) {
  await sleep(500);
  if (await evalJs(`document.querySelectorAll('.route-item').length > 0`)) break;
}

// 1) data spot checks
const dataCheck = await evalJs(`(() => {
  const D = window.KANAS_DATA;
  const p = D.pois.find(q => q.name.indexOf('观鱼台') >= 0 && q.cat === 'photo');
  const gridE = window.KANAS.geo.elevAt(p.lat, p.lon);
  const s = D.shuttles[0];
  return {
    pois: D.pois.length, stations: D.pois.filter(q => q.cat === 'station').length,
    shuttleStops: s.stops.length, shuttleSpots: s.spots.length, shuttleHasProf: s.d && s.d.dummy !== 1 && s.d.length > 100,
    gridRes: [D.demGrid.dLat * 111204, D.demGrid.dLon * 73610],
    poiE: p.e, gridE, diff: Math.abs(gridE - p.e),
  };
})()`);
check("data: POIs & stations", dataCheck.pois > 140 && dataCheck.stations >= 8, JSON.stringify({ pois: dataCheck.pois, stations: dataCheck.stations }));
check("data: shuttle stops/spots", dataCheck.shuttleStops > 3 && dataCheck.shuttleSpots >= 0, `stops=${dataCheck.shuttleStops} spots=${dataCheck.shuttleSpots}`);
check("data: shuttle profile", dataCheck.shuttleHasProf);
check("data: grid resolution < 100m", dataCheck.gridRes[0] < 100 && dataCheck.gridRes[1] < 100, dataCheck.gridRes.map(v => v.toFixed(1) + "m").join(" x "));
check("data: grid vs DEM elev diff < 15m", dataCheck.diff < 15, `poiE=${dataCheck.poiE} gridE=${dataCheck.gridE?.toFixed ? dataCheck.gridE.toFixed(1) : dataCheck.gridE}`);

// helper: screen coords of a network point far from any POI marker and inside the map viewport
const openNetPoints = async (count) => evalJs(`(() => {
  const map = window.KANAS.mapApi.map;
  const pts = [];
  const pois = window.KANAS_DATA.pois.map(p => map.latLngToContainerPoint([p.y, p.x]));
  const size = map.getSize();
  const isFree = (cp) => {
    if (cp.x < 60 || cp.y < 60 || cp.x > size.x - 60 || cp.y > size.y - 60) return false;
    for (const q of pois) {
      const dx = q.x - cp.x, dy = q.y - cp.y;
      if (dx * dx + dy * dy < 55 * 55) return false;
    }
    return true;
  };
  for (const w of window.KANAS_DATA.ways) {
    if (w.cls === 'path' || w.cls === 'boardwalk' || w.cls === 'road' || w.cls === 'track') {
      for (let i = 0; i < w.geom.length; i += 7) {
        const cp = map.latLngToContainerPoint([w.geom[i][1], w.geom[i][0]]);
        if (isFree(cp)) {
          const cand = { x: cp.x + 363, y: cp.y, wx: w.geom[i][0], wy: w.geom[i][1] };
          if (pts.every(p => (p.x - cand.x) ** 2 + (p.y - cand.y) ** 2 > 260 * 260)) pts.push(cand);
          if (pts.length >= ${count}) return pts;
        }
      }
    }
  }
  return pts;
})()`);

// zoom to the connected 换乘中心–月亮湾 corridor first so both points are on the main network
await evalJs(`(() => {
  const map = window.KANAS.mapApi.map;
  const find = n => window.KANAS_DATA.pois.find(p => p.name.indexOf(n) >= 0 && p.cat === 'station');
  const a = find('换乘中心'), b = find('月亮湾');
  map.fitBounds([[Math.min(a.y, b.y), Math.min(a.x, b.x)], [Math.max(a.y, b.y), Math.max(a.x, b.x)]], { padding: [80, 80] });
  return true;
})()`);
await sleep(1500);
const twoPts = await openNetPoints(2);
check("aim: found open network points", twoPts.length >= 2, JSON.stringify(twoPts));

const routeBtn = await rectOf(`Array.from(document.querySelectorAll('.mode-btn')).find(b => b.textContent === '两点测线')`);
await click(routeBtn.x, routeBtn.y);
await click(twoPts[0].x, twoPts[0].y);
await sleep(400);
const afterA = await evalJs(`({ n: document.getElementById('status-mode').textContent, popup: !!document.querySelector('.leaflet-popup') })`);
console.log("  [dbg] after A:", JSON.stringify(afterA));
await click(twoPts[1].x, twoPts[1].y);
await sleep(1800);
const routeState = await evalJs(`(() => ({
  title: document.getElementById('result-title').textContent,
  stats: document.getElementById('result-stats').textContent,
  hidden: document.getElementById('result-card').hidden,
  status: document.getElementById('status-mode').textContent,
  toast: document.getElementById('toast').hidden ? null : document.getElementById('toast').textContent,
}))()`);
console.log("  [dbg] after B:", JSON.stringify(routeState));
check("route: computed", !routeState.hidden && routeState.title.indexOf("A → B") === 0, routeState.title + " | " + routeState.stats.slice(0, 40));

// 3) waypoint insertion (click a third open point)
const wpPt = (await openNetPoints(3))[2];
const wpBtn = await rectOf(`document.getElementById('btn-waypoint')`);
await click(wpBtn.x, wpBtn.y);
await sleep(300);
const armed = await evalJs(`document.getElementById('status-mode').textContent`);
console.log("  [dbg] after waypoint btn:", armed);
if (wpPt) await click(wpPt.x, wpPt.y);
await sleep(1800);
const wpState = await evalJs(`(() => ({
  title: document.getElementById('result-title').textContent,
  chips: document.querySelectorAll('.wp-chip').length,
  chipText: (document.querySelector('.wp-chip') || {}).textContent || '',
  status: document.getElementById('status-mode').textContent,
}))()`);
console.log("  [dbg] after waypoint click:", JSON.stringify(wpState));
check("waypoint: inserted & recomputed", wpState.chips === 1 && wpState.title.indexOf("途径点") >= 0,
  JSON.stringify(wpState));

// 4) exports
const gpxBtn = await rectOf(`document.getElementById('btn-gpx')`);
const dl1 = (async () => { const p = send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: "C:\\Temp\\kanas-dl" }); await p; return true; })();
const gpxDownload = send("Page.downloadWillBegin").catch(() => null);
await click(gpxBtn.x, gpxBtn.y);
await sleep(600);
const expState = await evalJs(`(() => ({ toast: document.getElementById('toast').textContent, hidden: document.getElementById('toast').hidden }))()`);
check("export: GPX toast", !expState.hidden && expState.toast.indexOf("GPX") >= 0, expState.toast);

const csvBtn = await rectOf(`document.getElementById('btn-csv')`);
await click(csvBtn.x, csvBtn.y);
await sleep(500);
const expState2 = await evalJs(`document.getElementById('toast').textContent`);
check("export: CSV toast", expState2.indexOf("CSV") >= 0, expState2);

const pngBtn = await rectOf(`document.getElementById('btn-png')`);
await click(pngBtn.x, pngBtn.y);
await sleep(800);
const expState3 = await evalJs(`document.getElementById('toast').textContent`);
check("export: PNG toast", expState3.indexOf("PNG") >= 0, expState3);

// 5) shuttle popup (back to browse mode, zoom to a sensible level, try several vertices)
const browseBtn2 = await rectOf(`Array.from(document.querySelectorAll('.mode-btn')).find(b => b.textContent === '浏览')`);
await click(browseBtn2.x, browseBtn2.y);
await sleep(300);
await evalJs(`(() => {
  const map = window.KANAS.mapApi.map;
  const g = window.KANAS_DATA.shuttles[0].geom;
  const mid = g[Math.floor(g.length / 2)];
  map.setView([mid[1], mid[0]], 12);
  return true;
})()`);
await sleep(1800);
const shuttleCandidates = await evalJs(`(() => {
  const map = window.KANAS.mapApi.map;
  const g = window.KANAS_DATA.shuttles[0].geom;
  const pois = window.KANAS_DATA.pois.map(p => map.latLngToContainerPoint([p.y, p.x]));
  const size = map.getSize();
  const out = [];
  for (let i = 0; i < g.length; i += 2) {
    const cp = map.latLngToContainerPoint([g[i][1], g[i][0]]);
    if (cp.x < 40 || cp.y < 40 || cp.x > size.x - 40 || cp.y > size.y - 40) continue;
    if (pois.some(q => (q.x - cp.x) ** 2 + (q.y - cp.y) ** 2 < 45 * 45)) continue;
    out.push({ x: cp.x + 363, y: cp.y });
    if (out.length >= 8) break;
  }
  return out;
})()`);
let shuttlePopup = null;
for (const sp of shuttleCandidates) {
  await click(sp.x, sp.y);
  await sleep(500);
  shuttlePopup = await evalJs(`(() => {
    const el = document.querySelector('.leaflet-popup-content');
    return el ? el.textContent.slice(0, 150) : null;
  })()`);
  if (shuttlePopup && shuttlePopup.indexOf("区间车") >= 0) break;
}
check("shuttle: popup with stops", !!shuttlePopup && shuttlePopup.indexOf("区间车线路") >= 0, shuttlePopup ? shuttlePopup.slice(0, 60) : "no popup");

console.log(`\nRESULT: ${ok} passed, ${fail} failed`);
ws.close(); proc.kill(); process.exit(fail ? 1 : 0);
