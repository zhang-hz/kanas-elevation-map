// shot_v2.mjs — screenshots of the new UI states (waypoint route, shuttle popup)
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9339;
const OUT = "C:\\Data\\Code\\Kanas\\gui-test-screenshots";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const proc = spawn(EDGE, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`,
  "--user-data-dir=C:\\Temp\\kanas-edge-shot2", "--window-size=1280,720", "about:blank",
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
const evalJs = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
const click = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(100);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(150);
};
const shot = async name => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}\\${name}`, Buffer.from(data, "base64"));
  console.log("saved", name);
};
for (let i = 0; i < 80; i++) {
  await sleep(500);
  if (await evalJs(`document.querySelectorAll('.route-item').length > 0`)) break;
}

// --- waypoint route via recommended route + one waypoint ---
const item = await evalJs(`(() => {
  const el = Array.from(document.querySelectorAll('.route-item')).find(d => d.textContent.includes('换乘中心') && d.textContent.includes('月亮湾'));
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`);
await click(item.x, item.y);
await sleep(2600);
const wpBtn = await evalJs(`(() => {
  const el = document.getElementById('btn-waypoint');
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`);
await click(wpBtn.x, wpBtn.y);
const wpPt = await evalJs(`(() => {
  const map = window.KANAS.mapApi.map;
  const a = window.KANAS_DATA.pois.find(p => p.name.indexOf('鸭泽湖') >= 0);
  const cp = map.latLngToContainerPoint([a.y, a.x]);
  return { x: cp.x + 363, y: cp.y - 14 };
})()`);
await click(wpPt.x, wpPt.y);
await sleep(2200);
await shot("v8_waypoint_route.png");

// --- shuttle popup (browse mode) ---
const browseBtn = await evalJs(`(() => {
  const el = Array.from(document.querySelectorAll('.mode-btn')).find(b => b.textContent === '浏览');
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`);
await click(browseBtn.x, browseBtn.y);
await evalJs(`(() => {
  const map = window.KANAS.mapApi.map;
  const g = window.KANAS_DATA.shuttles[0].geom;
  const mid = g[Math.floor(g.length / 2)];
  map.setView([mid[1], mid[0]], 12);
  return true;
})()`);
await sleep(1600);
const cands = await evalJs(`(() => {
  const map = window.KANAS.mapApi.map;
  const g = window.KANAS_DATA.shuttles[0].geom;
  const size = map.getSize();
  const out = [];
  for (let i = 0; i < g.length; i += 2) {
    const cp = map.latLngToContainerPoint([g[i][1], g[i][0]]);
    if (cp.x < 40 || cp.y < 40 || cp.x > size.x - 40 || cp.y > size.y - 40) continue;
    out.push({ x: cp.x + 363, y: cp.y });
    if (out.length >= 10) break;
  }
  return out;
})()`);
for (const sp of cands) {
  await click(sp.x, sp.y);
  await sleep(450);
  const txt = await evalJs(`(() => {
    const el = document.querySelector('.leaflet-popup-content');
    return el ? el.textContent : null;
  })()`);
  if (txt && txt.indexOf("区间车线路") >= 0) break;
}
await sleep(400);
await shot("v9_shuttle_popup.png");

// --- sidebar notices + legend ---
await evalJs(`(() => {
  const sb = document.getElementById('sidebar');
  sb.scrollTop = sb.scrollHeight;
  return true;
})()`);
await sleep(500);
await shot("v10_notices_legend.png");

ws.close(); proc.kill(); process.exit(0);
