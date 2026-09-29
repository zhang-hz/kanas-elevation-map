// probe_pdf.mjs — verify PDF report build + strolling pace
import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9347;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const proc = spawn(EDGE, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`,
  "--user-data-dir=C:/Temp/kanas-edge-pdf-" + Date.now(), "--window-size=1280,720", "about:blank",
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
await evalJs(`window.__hs = new Image(); window.__hs.src = 'data/hillshade.png'; true`);
for (let i = 0; i < 30; i++) {
  await sleep(500);
  if (await evalJs(`window.__hs && window.__hs.naturalWidth > 0`)) break;
}

const out = await evalJs(`(() => {
 try {
  const K = window.KANAS, D = window.KANAS_DATA;
  const res = { hasReport: !!K.report, hasBtn: !!document.getElementById('btn-pdf'), hsW: window.__hs ? window.__hs.naturalWidth : 0 };
  // 用两个相距较远的真实路网点构建路线
  const nds = K.router.nodes;
  let a = 0, b = 0, best = -1;
  for (let i = 0; i < nds.length; i += 200) {
    for (let j = i + 200; j < nds.length; j += 200) {
      const d = Math.hypot(nds[i][0]-nds[j][0], nds[i][1]-nds[j][1]);
      if (d > best && d < 8) { best = d; a = i; b = j; }
    }
  }
  const pa = [nds[a][0], nds[a][1]], pb = [nds[b][0], nds[b][1]];
  const r = K.router.routeVia([pa, pb], [null, null]);
  if (!r || r.error) { res.routeErr = r && r.error; return res; }
  res.routeKm = Math.round(r.stats.len);
  res.hours = +r.stats.hours.toFixed(2);
  res.effSpeed = +(r.stats.len/1000/r.stats.hours).toFixed(2);
  const ll0 = K.geo.toLatLon(pa[0], pa[1]), ll1 = K.geo.toLatLon(pb[0], pb[1]);
  const raw = {
    label: '探针测试线路', stats: r.stats, prof: r.prof, line: r.line,
    pts: [
      { x: pa[0], y: pa[1], lat: ll0[0], lon: ll0[1], e: K.geo.elevAtKm(pa[0], pa[1]), hint: '' },
      { x: pb[0], y: pb[1], lat: ll1[0], lon: ll1[1], e: K.geo.elevAtKm(pb[0], pb[1]), hint: '' },
    ],
    eOff: 0, zeroName: D.meta.datum.name, zeroAbs: D.meta.datum.elevAbs,
    hillshadeImg: window.__hs,
  };
  const t0 = performance.now();
  const pdf = K.report.buildPdf(raw);
  res.buildMs = Math.round(performance.now() - t0);
  res.pages = pdf.pages;
  res.bytes = pdf.bytes.length;
  let head = '';
  for (let i = 0; i < 8; i++) head += String.fromCharCode(pdf.bytes[i]);
  res.header = head;
  // 页数统计：/Type /Page 出现次数
  let tail = '';
  for (let i = Math.max(0, pdf.bytes.length - 400); i < pdf.bytes.length; i++) tail += String.fromCharCode(pdf.bytes[i]);
  res.hasEof = tail.indexOf('%%EOF') >= 0 && tail.indexOf('startxref') >= 0;
  res.pageData = K.report.previewPages(raw).map((s) => s.split(',')[1]);
  return res;
 } catch (e) { return { err: String(e) }; }
})()`);

console.log(JSON.stringify({ ...out, pageData: (out.pageData || []).map((d) => d.length) }, null, 1));
if (out.pageData) {
  const fs = await import("node:fs");
  out.pageData.forEach((d, i) =>
    fs.writeFileSync(`C:/Temp/kanas_qa/report_p${i + 1}.png`, Buffer.from(d, "base64")));
  console.log("pages written to C:/Temp/kanas_qa/report_p1..5.png");
}
ws.close(); proc.kill();
process.exit(out && out.header === "%PDF-1.4" && out.pages === 5 && out.hasEof && !out.err ? 0 : 1);
