// probe_shuttle.mjs — diagnose the shuttle-line click
import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9338;
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
const exceptions = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") {
    exceptions.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
  }
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
});
const evalJs = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true }));
await send("Runtime.enable");
for (let i = 0; i < 80; i++) {
  await sleep(500);
  const { result } = await evalJs(`document.querySelectorAll('.route-item').length > 0`);
  if (result.value) break;
}
await evalJs(`(() => {
  const map = window.KANAS.mapApi.map;
  const g = window.KANAS_DATA.shuttles[0].geom;
  const mid = g[Math.floor(g.length / 2)];
  map.setView([mid[1], mid[0]], 12);
  return true;
})()`);
await sleep(1800);
const info = await evalJs(`(() => {
  const map = window.KANAS.mapApi.map;
  const g = window.KANAS_DATA.shuttles[0].geom;
  const out = [];
  for (let i = 0; i < g.length && out.length < 4; i += 3) {
    const cp = map.latLngToContainerPoint([g[i][1], g[i][0]]);
    if (cp.x < 40 || cp.y < 40 || cp.x > 880 || cp.y > 680) continue;
    const el = document.elementFromPoint(cp.x + 363, cp.y);
    out.push({ x: cp.x + 363, y: cp.y, tag: el && el.tagName, cls: el && (el.getAttribute('class') || '').slice(0, 40) });
  }
  return JSON.stringify({ n: out.length, out, shuttlePanes: document.querySelectorAll('.leaflet-shuttle-pane').length,
    svgInShuttle: (document.querySelector('.leaflet-shuttle-pane svg') || {}).childElementCount || 0 });
})()`);
console.log("hit-test:", info.result.value);
const cand = JSON.parse(info.result.value);
if (cand.out.length) {
  const c = cand.out[0];
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y });
  await sleep(120);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
  await sleep(800);
  const popup = await evalJs(`(() => {
    const el = document.querySelector('.leaflet-popup-content');
    return el ? el.textContent.slice(0, 100) : null;
  })()`);
  console.log("popup after click:", popup);
}
console.log("exceptions:", JSON.stringify(exceptions.slice(0, 5), null, 1));
ws.close(); proc.kill(); process.exit(0);
