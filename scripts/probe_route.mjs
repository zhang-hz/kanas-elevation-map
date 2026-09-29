// probe_route.mjs — call router.routeVia directly and capture the error
import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9337;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const proc = spawn(EDGE, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`,
  "--user-data-dir=C:\\Temp\\kanas-edge-pr", "--window-size=1280,720", "about:blank",
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
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true });
  return r;
};
for (let i = 0; i < 80; i++) {
  await sleep(500);
  const { result } = await evalJs(`document.querySelectorAll('.route-item').length > 0`);
  if (result.value) break;
}
const r = await evalJs(`(() => {
  try {
    const D = window.KANAS_DATA;
    const find = n => D.pois.find(p => p.name.indexOf(n) >= 0 && p.cat === 'station');
    const a = find('换乘中心'), b = find('月亮湾');
    const out = window.KANAS.router.routeVia([[a.x, a.y], [b.x, b.y]]);
    return JSON.stringify({ ok: !!out.ok, err: out.error, len: out.stats && out.stats.len, prof: out.prof && out.prof.length });
  } catch (e) {
    return JSON.stringify({ exception: String(e && e.stack || e) });
  }
})()`);
console.log("routeVia:", r.result.value, r.exceptionDetails ? r.exceptionDetails.text : "");
const r2 = await evalJs(`(() => {
  try {
    const D = window.KANAS_DATA;
    const find = n => D.pois.find(p => p.name.indexOf(n) >= 0 && p.cat === 'station');
    const a = find('换乘中心'), b = find('月亮湾');
    const s = window.KANAS.router.nearestOnNetwork(a.x, a.y);
    return JSON.stringify({ s: { ei: s.ei, t: s.t, dist: s.dist } });
  } catch (e) {
    return JSON.stringify({ exception: String(e && e.stack || e) });
  }
})()`);
console.log("snap:", r2.result.value);
ws.close(); proc.kill(); process.exit(0);
