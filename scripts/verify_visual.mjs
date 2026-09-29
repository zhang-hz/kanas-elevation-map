// verify_visual.mjs — drive the map page in headless Edge via CDP,
// real mouse input + screenshots, for visual evidence of interactive states.
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = "http://127.0.0.1:8823/";
const PORT = 9333;
const OUT = "C:\\Data\\Code\\Kanas\\gui-test-screenshots";
mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const proc = spawn(EDGE, [
    "--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`,
    "--user-data-dir=C:/Temp/kanas-edge-" + Date.now() + "", "--window-size=1280,720",
    "about:blank",
  ], { stdio: "ignore" });

  // wait for devtools endpoint
  let listUrl = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const tabs = await r.json();
      if (tabs.length) { listUrl = tabs; break; }
    } catch { /* not ready */ }
  }
  if (!listUrl) throw new Error("devtools not ready");

  // open the page in a target
  let target;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL)}`, { method: "PUT" });
    target = await r.json();
  } catch {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL)}`);
    target = await r.json();
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0;
  const pending = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
  });
  await send("Page.navigate", { url: URL });

  // wait until app JS has built the route list (heavy data file, slow first build)
  const waitFor = async (expr, ms = 20000) => {
    const t0 = Date.now();
    for (;;) {
      const { result } = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
      if (result && result.value) return true;
      if (Date.now() - t0 > ms) return false;
      await sleep(400);
    }
  };
  const ready = await waitFor(`document.querySelectorAll('.route-item').length > 0`);
  console.log("app ready:", ready);
  await sleep(800);

  const shot = async name => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, name), Buffer.from(data, "base64"));
    console.log("saved", name);
  };

  const rectOf = async expr => {
    const { result } = await send("Runtime.evaluate", {
      expression: `(() => { const el = ${expr}; if (!el) return null;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      returnByValue: true,
    });
    return result.value;
  };

  const click = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sleep(120);
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(200);
  };

  // 1) initial view
  await shot("v1_initial.png");

  // 2) recommended route: 换乘中心 → 观鱼台
  const routeItem = await rectOf(
    `Array.from(document.querySelectorAll('.route-item')).find(d => d.textContent.includes('观鱼台') && d.textContent.includes('换乘中心'))`);
  if (routeItem) {
    await click(routeItem.x, routeItem.y);
    await sleep(2600);
    await shot("v2_route_guanyutai.png");
  } else {
    console.log("route item not found");
  }

  // 3) chart hover
  const chart = await rectOf(`document.getElementById('profile-chart')`);
  if (chart) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: chart.x - 60, y: chart.y });
    await sleep(700);
    await shot("v3_chart_hover.png");
  }

  // 4) straight-line mode with two map clicks
  const straightBtn = await rectOf(
    `Array.from(document.querySelectorAll('.mode-btn')).find(b => b.textContent === '直线剖面')`);
  if (straightBtn) {
    await click(straightBtn.x, straightBtn.y);
    await sleep(300);
    await click(760, 260);
    await sleep(400);
    await click(980, 520);
    await sleep(1500);
    await shot("v4_straight_profile.png");
  }

  // 5) re-zero datum
  const rezero = await rectOf(
    `Array.from(document.querySelectorAll('.btn')).find(b => b.textContent === '设终点为 0 基准')`);
  if (rezero) {
    await click(rezero.x, rezero.y);
    await sleep(800);
    await shot("v5_rezero.png");
  }

  // 6) layer toggle off lakes
  const lakeBox = await rectOf(`document.querySelector('input[data-layer="lakes"]')`);
  if (lakeBox) {
    await click(lakeBox.x, lakeBox.y);
    await sleep(700);
    await shot("v6_lakes_off.png");
    await click(lakeBox.x, lakeBox.y);
    await sleep(400);
  }

  // 7) search box
  const sb = await rectOf(`document.getElementById('search-box')`);
  if (sb) {
    await click(sb.x, sb.y);
    await send("Input.insertText", { text: "月亮湾" });
    await sleep(700);
    await shot("v7_search.png");
  }

  ws.close();
  proc.kill();
  console.log("done");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
