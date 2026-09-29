// probe_info.mjs — verify search (lakes/rivers) + walking-pace setting
import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9349;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const proc = spawn(EDGE, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`,
  "--user-data-dir=C:/Temp/kanas-edge-info-" + Date.now(), "--window-size=1280,720", "about:blank",
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
  const K = window.KANAS;
  const res = {};
  // 1) 搜索“喀纳斯湖”
  const sb = document.getElementById('search-box');
  sb.value = '喀纳斯湖';
  sb.dispatchEvent(new Event('input'));
  res.searchHits = Array.from(document.querySelectorAll('#search-results .search-item')).map(d => d.textContent);
  // 2) 步速设置
  const sel = document.getElementById('pace-select');
  res.hasPaceUI = !!sel;
  res.paceDefault = +K.router.getPace().toFixed(2);
  sel.value = '5.5';
  sel.dispatchEvent(new Event('change'));
  res.paceAfter = +K.router.getPace().toFixed(2);
  res.stored = localStorage.getItem('kanas_pace');
  // 3) 配速对用时的影响（同一路线两个速度）
  const nds = K.router.nodes;
  let a = 0, b = 0, best = -1;
  for (let i = 0; i < nds.length; i += 400) {
    for (let j = i + 400; j < nds.length; j += 400) {
      const d = Math.hypot(nds[i][0]-nds[j][0], nds[i][1]-nds[j][1]);
      if (d > best && d < 6) { best = d; a = i; b = j; }
    }
  }
  const r1 = K.router.routeVia([[nds[a][0],nds[a][1]],[nds[b][0],nds[b][1]]], [null,null]);
  const h55 = r1.stats.hours;
  K.router.setPace(3.0);
  const r2 = K.router.routeVia([[nds[a][0],nds[a][1]],[nds[b][0],nds[b][1]]], [null,null]);
  res.h55 = +h55.toFixed(2); res.h30 = +r2.stats.hours.toFixed(2);
  res.ratio = +(r2.stats.hours / h55).toFixed(2);
  K.router.setPace(5.5);
  // 4) notices 与湖泊 POI 落库
  res.notices = (window.KANAS_DATA.notices || []).length;
  res.hasLakePoi = window.KANAS_DATA.pois.some(p => p.name === '喀纳斯湖');
  res.poiCount = window.KANAS_DATA.pois.length;
  return res;
 } catch (e) { return { err: String(e) }; }
})()`);
console.log(JSON.stringify(out, null, 1));
ws.close(); proc.kill();
const ok = out && out.searchHits && out.searchHits.some(t => t.indexOf("喀纳斯湖") === 0) &&
  out.hasPaceUI && Math.abs(out.paceAfter - 5.5) < 0.01 && out.ratio > 1.5 &&
  out.notices >= 6 && out.hasLakePoi;
process.exit(ok ? 0 : 1);
