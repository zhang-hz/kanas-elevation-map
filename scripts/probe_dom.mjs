// probe_dom.mjs — detailed DOM diagnosis at a way vertex
import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9342;
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
const info = await evalJs(`(() => {
  const out = {};
  out.hitLines = document.querySelectorAll('path.hit-line').length;
  out.interactive = document.querySelectorAll('.leaflet-interactive').length;
  const mapLeft = document.getElementById('map').getBoundingClientRect().x;
  const map = window.KANAS.mapApi.map;
  const w = window.KANAS_DATA.ways.find(q => q.name === '喀东线');
  const i = 3;
  const cp = map.latLngToContainerPoint([w.geom[i][1], w.geom[i][0]]);
  const px = cp.x + mapLeft, py = cp.y;
  out.clickPt = { px, py };
  // what does elementFromPoint return in full
  let el = document.elementFromPoint(px, py);
  out.topEl = el ? { tag: el.tagName, cls: String(el.getAttribute('class') || ''), pe: getComputedStyle(el).pointerEvents } : null;
  // all elements at that point
  out.stack = document.elementsFromPoint(px, py).map(e => ({
    tag: e.tagName, cls: String(e.getAttribute('class') || '').slice(0, 60),
    pe: getComputedStyle(e).pointerEvents,
  })).slice(0, 8);
  // a hit-line sample's computed style + bbox
  const hl = document.querySelector('path.hit-line');
  if (hl) {
    const r = hl.getBoundingClientRect();
    out.hitSample = { cls: String(hl.getAttribute('class')), pe: getComputedStyle(hl).pointerEvents,
      bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      strokeOpacity: hl.getAttribute('stroke-opacity') };
  }
  return JSON.stringify(out);
})()`);
console.log(info);
ws.close(); proc.kill(); process.exit(0);
