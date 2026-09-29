// probe_click.mjs — diagnose browse-mode clicks (ways / POIs / lakes)
import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9341;
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
    exceptions.push((m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description) || m.params.exceptionDetails.text);
  }
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
});
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;
await send("Runtime.enable");
for (let i = 0; i < 80; i++) {
  await sleep(500);
  if (await evalJs(`document.querySelectorAll('.route-item').length > 0`)) break;
}
// wait until Leaflet's initial fitBounds zoom animation is over before sampling pixels
for (let i = 0; i < 30; i++) {
  await sleep(300);
  if (!(await evalJs(`!!(window.KANAS && window.KANAS.mapApi.map._animatingZoom)`))) break;
}
await sleep(600);
console.log("load exceptions:", JSON.stringify(exceptions.slice(0, 3)));

const click = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(120);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(600);
};

const popupText = async () => evalJs(`(() => {
  const el = document.querySelector('.leaflet-popup-content');
  return el ? el.textContent.slice(0, 60) : null;
})()`);

// 1) what element sits under a way vertex / a POI marker?
const mapLeft = await evalJs(`document.getElementById('map').getBoundingClientRect().x`);
console.log('map left edge:', mapLeft);
const spots = await evalJs(`(() => {
  const mapLeft = ${mapLeft};
  const map = window.KANAS.mapApi.map;
  // find pixels the browser itself certifies: stack top = hit-line / marker pin
  let wayPt = null, poiPt = null;
  const size = map.getSize();
  for (let y = 120; y < size.y - 120 && (!wayPt || !poiPt); y += 7) {
    for (let x = 120; x < size.x - 120; x += 7) {
      const stack = document.elementsFromPoint(x + mapLeft, y);
      const top = stack[0] ? String(stack[0].getAttribute('class') || '') : '';
      if (!wayPt && top.indexOf('hit-line') >= 0) wayPt = { x: x + mapLeft, y };
      if (!poiPt && top.indexOf('poi-pin') >= 0) poiPt = { x: x + mapLeft, y };
      if (wayPt && poiPt) break;
    }
  }
  return JSON.stringify({ wayPt, poiPt });
})()`);
console.log("certified spots:", spots);
const S = JSON.parse(spots);
S.way = S.wayPt; S.poi = S.poiPt;

console.log("--- click WAY ---");
if (!S.way) { console.log('no certified way pixel'); process.exit(1); }
await click(S.way.x, S.way.y);
console.log("popup:", await popupText());
console.log("exceptions:", JSON.stringify(exceptions.slice(-3)));

console.log("--- click POI ---");
// popup auto-pan moved the map: re-certify a marker pixel right before clicking
const poi2 = await evalJs(`(() => {
  const mapLeft = ${mapLeft};
  const map = window.KANAS.mapApi.map;
  const size = map.getSize();
  for (let y = 100; y < size.y - 100; y += 5) {
    for (let x = 100; x < size.x - 100; x += 5) {
      const stack = document.elementsFromPoint(x + mapLeft, y);
      const top = stack[0] ? String(stack[0].getAttribute('class') || '') : '';
      if (top.indexOf('poi-pin') >= 0) return JSON.stringify({ x: x + mapLeft, y });
    }
  }
  return 'null';
})()`);
console.log("re-certified poi pixel:", poi2);
if (poi2 && poi2 !== 'null') { const P = JSON.parse(poi2); await click(P.x, P.y); }
console.log("popup:", await popupText());
console.log("exceptions:", JSON.stringify(exceptions.slice(-3)));

ws.close(); proc.kill(); process.exit(0);
