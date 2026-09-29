// probe_chain.mjs — verify boardwalk chain naming + station bus info + shuttle notes
import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9351;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const proc = spawn(EDGE, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`,
  "--user-data-dir=C:/Temp/kanas-edge-q2-" + Date.now(), "about:blank",
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
await sleep(500);

const out = await evalJs(`(() => { try {
  const K = window.KANAS, D = window.KANAS_DATA;
  const res = {};
  const sb = document.getElementById('search-box');
  sb.value = '双桥';
  sb.dispatchEvent(new Event('input'));
  res.search = Array.from(document.querySelectorAll('#search-results .search-item')).map(d => d.textContent).slice(0, 6);
  const idx = D.pois.findIndex(p => p.name === '卧龙湾站');
  K.mapApi.openPoiPopup(idx, L.latLng(D.pois[idx].y, D.pois[idx].x));
  res.poiPopup = document.querySelector('.leaflet-popup-content').textContent.slice(0, 240);
  const sh = D.shuttles.find(s => /1路/.test(s.name));
  res.shuttleNote = (sh.note || '').slice(0, 60);
  res.chainWays = D.ways.filter(w => /卧龙湾—双桥/.test(w.name)).length;
  res.shuangqiaoPoi = D.pois.some(p => p.name === '喀纳斯双桥');
  return res;
} catch (e) { return { err: String(e) }; } })()`);
console.log(JSON.stringify(out, null, 1));
ws.close(); proc.kill();
const ok = out && !out.err && out.search && out.search.some(s => s.indexOf("双桥") >= 0) &&
  out.poiPopup && out.poiPopup.indexOf("停靠线路") >= 0 && out.shuttleNote &&
  out.chainWays > 50 && out.shuangqiaoPoi;
process.exit(ok ? 0 : 1);
