/* report.js — 导出 PDF 线路报告（多页 A4）
 * 用法：K.report.exportPdf(data)
 * 页面在 canvas 上绘制（中文无需嵌字体），再自组装为多页 PDF（JPEG 页，DCTDecode）。
 */
(function () {
  "use strict";
  const K = (window.KANAS = window.KANAS || {});
  const D = window.KANAS_DATA;

  const PW = 1240, PH = 1754;      // A4 @ ~150 dpi
  const M = 64;                    // 页边距
  const FONT = '"Microsoft YaHei","PingFang SC",sans-serif';

  // ---------------- canvas 基础 ----------------
  function page() {
    const c = document.createElement("canvas");
    c.width = PW; c.height = PH;
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, PW, PH);
    return { c, g };
  }
  function T(g, s, x, y, o) {
    o = o || {};
    g.fillStyle = o.color || "#22313f";
    g.font = (o.bold ? "bold " : "") + (o.size || 22) + "px " + FONT;
    g.textAlign = o.align || "left";
    g.textBaseline = "alphabetic";
    g.fillText(s, x, y);
    return (o.size || 22) + (o.gap === undefined ? 8 : o.gap);
  }
  function line(g, x1, y1, x2, y2, color, w) {
    g.strokeStyle = color || "#d8dee4"; g.lineWidth = w || 1;
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
  }
  function box(g, x, y, w, h, fill, stroke, r) {
    g.beginPath();
    const rr = r === undefined ? 10 : r;
    g.moveTo(x + rr, y); g.arcTo(x + w, y, x + w, y + h, rr); g.arcTo(x + w, y + h, x, y + h, rr);
    g.arcTo(x, y + h, x, y, rr); g.arcTo(x, y, x + w, y, rr); g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); }
  }
  function fmtD(m) {
    return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 1 : 2) + " km" : Math.round(m) + " m";
  }
  function fmtT(h) {
    if (!h) return "—";
    const mins = Math.round(h * 60);
    return mins < 60 ? mins + " 分钟" : Math.floor(mins / 60) + " 小时 " + (mins % 60) + " 分";
  }
  function fmtE(v, eOff) { return Math.round(v - (eOff || 0)) + " m"; }

  // ---------------- 页眉页脚 ----------------
  function chrome(g, pageNo, title) {
    line(g, M, 84, PW - M, 84, "#2c6e8f", 3);
    T(g, title, M, 72, { size: 20, color: "#2c6e8f" });
    line(g, M, PH - 78, PW - M, PH - 78, "#d8dee4", 1);
    T(g, "喀纳斯景区步道高程互动地图 · 离线生成", M, PH - 50, { size: 17, color: "#8aa0ae" });
    T(g, "第 " + pageNo + " / 5 页", PW - M, PH - 50, { size: 17, color: "#8aa0ae", align: "right" });
  }

  // ---------------- 第 1 页：摘要 ----------------
  function pageSummary(data) {
    const { c, g: ctx } = page();
    T(ctx, "喀纳斯景区徒步线路报告", M, 150, { size: 52, bold: true, color: "#173a4f" });
    T(ctx, data.label, M, 200, { size: 28, color: "#2c6e8f" });
    T(ctx, "生成日期：" + new Date().toLocaleDateString("zh-CN") +
      "　·　高程基准：" + data.zeroName + " = 0 m（绝对 " + data.zeroAbs + " m）",
      M, 244, { size: 20, color: "#7d8f9c" });

    // 数据卡
    const s = data.stats;
    const cards = [
      [fmtD(s.len), "总距离"], [fmtT(s.hours), "预计用时（当前配速）"],
      [Math.round(s.ascent) + " m", "累计爬升"], [Math.round(s.descent) + " m", "累计下降"],
      [fmtE(s.maxE, data.eOff), "最高点"], [fmtE(s.minE, data.eOff), "最低点"],
      [(s.len ? (100 * (s.ascent + s.descent) / s.len).toFixed(1) : "0") + " %", "平均起伏率"],
      [null, "路面构成"],
    ];
    const cw = (PW - 2 * M - 3 * 16) / 4, ch = 108;
    cards.forEach((cd, i) => {
      const x = M + (i % 4) * (cw + 16), y = 284 + Math.floor(i / 4) * (ch + 16);
      box(ctx, x, y, cw, ch, "#f2f7fa", "#d3e2ea");
      if (cd[0] === null) {
        const items = data.surfaceMix || [];
        const lines = [];
        let cur = "";
        items.forEach((it) => {
          if ((cur + " · " + it).length > 18 && cur) { lines.push(cur); cur = it; }
          else cur = cur ? cur + " · " + it : it;
        });
        if (cur) lines.push(cur);
        lines.slice(0, 3).forEach((ln, j) =>
          T(ctx, ln, x + cw / 2, y + 22 + j * 18, { size: 14, bold: true, align: "center", color: "#173a4f" }));
      } else {
        T(ctx, cd[0], x + cw / 2, y + 52, { size: 30, bold: true, align: "center", color: "#173a4f" });
      }
      T(ctx, cd[1], x + cw / 2, y + 86, { size: 18, align: "center", color: "#6b8494" });
    });

    // 点位表
    let y = 556;
    y += T(ctx, "点位", M, y, { size: 28, bold: true, color: "#173a4f", gap: 18 });
    const cols = [M, M + 90, M + 560, M + 800, M + 1010];
    ["", "名称", "纬度 / 经度", "相对高程", "所属路网"].forEach((hd, i) =>
      T(ctx, hd, cols[i], y, { size: 19, color: "#8aa0ae" }));
    y += 10; line(ctx, M, y, PW - M, y, "#c9d6de"); y += 34;
    data.pts.forEach((p) => {
      T(ctx, p.tag, cols[0] + 18, y, { size: 21, bold: true, color: p.tagColor });
      T(ctx, p.name, cols[1], y, { size: 21 });
      T(ctx, p.latlon, cols[2], y, { size: 20, color: "#4a5f6d" });
      T(ctx, p.elev, cols[3], y, { size: 20, color: "#4a5f6d" });
      T(ctx, p.hint, cols[4], y, { size: 18, color: "#8aa0ae" });
      y += 36;
    });

    // 提示
    y += 24;
    y += T(ctx, "出行提示", M, y, { size: 28, bold: true, color: "#173a4f", gap: 18 });
    (data.notices || []).forEach((n) => {
      box(ctx, M, y - 22, PW - 2 * M, 40, "#fdf6e8", null, 8);
      T(ctx, "· " + n, M + 18, y + 2, { size: 19, color: "#8a6d2f" });
      y += 46;
    });

    chrome(ctx, 1, "线路摘要");
    return c;
  }

  // ---------------- 第 2 页：高程剖面 ----------------
  function pageProfile(data) {
    const { c, g } = page();
    T(g, "高程剖面", M, 150, { size: 44, bold: true, color: "#173a4f" });
    T(g, "横轴为沿线路距离，纵轴为相对高程（m）；填色按高程分带",
      M, 192, { size: 20, color: "#7d8f9c" });

    const chartW = PW - 2 * M, chartH = 560;
    const off = document.createElement("canvas");
    (K.chart.render || K.profile.render)(off, data.prof, {
      eOff: data.eOff, dpr: 2, width: chartW, height: chartH,
    });
    box(g, M - 8, 216, chartW + 16, chartH + 16, "#fbfcfd", "#d3e2ea");
    g.drawImage(off, M, 224, chartW, chartH);

    // 途经标注
    let y = 850;
    y += T(g, "关键点", M, y, { size: 28, bold: true, color: "#173a4f", gap: 18 });
    const cols = [M, M + 320, M + 620, M + 900];
    ["项目", "位置（距起点）", "高程", "说明"].forEach((hd, i) =>
      T(g, hd, cols[i], y, { size: 19, color: "#8aa0ae" }));
    y += 10; line(g, M, y, PW - M, y, "#c9d6de"); y += 34;
    data.keyPoints.forEach((r) => {
      T(g, r[0], cols[0], y, { size: 21 });
      T(g, r[1], cols[1], y, { size: 20, color: "#4a5f6d" });
      T(g, r[2], cols[2], y, { size: 20, color: "#4a5f6d" });
      T(g, r[3], cols[3], y, { size: 19, color: "#8aa0ae" });
      y += 36;
    });

    y += 20;
    y += T(g, "坡度分布", M, y, { size: 28, bold: true, color: "#173a4f", gap: 18 });
    data.gradeBands.forEach((bd, i) => {
      const x = M + i * ((PW - 2 * M) / data.gradeBands.length);
      box(g, x, y, (PW - 2 * M) / data.gradeBands.length - 14, 92, "#f2f7fa", "#d3e2ea");
      T(g, bd[1], x + ((PW - 2 * M) / data.gradeBands.length - 14) / 2, y + 42,
        { size: 26, bold: true, align: "center", color: "#173a4f" });
      T(g, bd[0], x + ((PW - 2 * M) / data.gradeBands.length - 14) / 2, y + 74,
        { size: 17, align: "center", color: "#6b8494" });
    });

    chrome(g, 2, "高程剖面");
    return c;
  }

  // ---------------- 第 3 页：线路地图 ----------------
  function pageMap(data) {
    const { c, g } = page();
    T(g, "线路示意图", M, 150, { size: 44, bold: true, color: "#173a4f" });
    T(g, "底图为山体阴影（自绘，12.6 m/像素）；蓝线为规划线路",
      M, 192, { size: 20, color: "#7d8f9c" });

    const X = M, Y = 224, W = PW - 2 * M, H = 1020;
    box(g, X - 6, Y - 6, W + 12, H + 12, "#eef3f6", "#c9d6de");
    g.save();
    g.beginPath(); g.rect(X, Y, W, H); g.clip();

    // 范围（km 平面）
    const line0 = data.line;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    line0.forEach((p) => {
      x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
    });
    const pad = 0.12;
    const spanX = (x1 - x0) * (1 + 2 * pad) || 0.5, spanY = (y1 - y0) * (1 + 2 * pad) || 0.5;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const sc = Math.min(W / spanX, H / spanY);
    const px = (x) => X + W / 2 + (x - cx) * sc;
    const py = (y) => Y + H / 2 - (y - cy) * sc;

    // 山体阴影
    const hs = D.hillshade;
    const tl = K.geo.toKm(hs.n, hs.w), br = K.geo.toKm(hs.s, hs.e);
    const img = data.hillshadeImg;
    if (img && img.complete && img.naturalWidth) {
      g.drawImage(img, px(tl[0]), py(tl[1]), (br[0] - tl[0]) * sc, (tl[1] - br[1]) * sc);
    } else {
      g.fillStyle = "#dce6da"; g.fillRect(X, Y, W, H);
    }

    // 水体
    (D.lakes || []).forEach((lk) => {
      (lk.geom || []).forEach((ring) => {
        g.beginPath();
        ring.forEach((p, i) => (i ? g.lineTo(px(p[0]), py(p[1])) : g.moveTo(px(p[0]), py(p[1]))));
        g.closePath(); g.fillStyle = "rgba(96,176,214,0.55)"; g.fill();
      });
    });
    (D.rivers || []).forEach((rv) => {
      g.beginPath();
      rv.geom.forEach((p, i) => (i ? g.lineTo(px(p[0]), py(p[1])) : g.moveTo(px(p[0]), py(p[1]))));
      g.strokeStyle = rv.cls === "river" ? "rgba(70,150,200,0.75)" : "rgba(110,180,215,0.55)";
      g.lineWidth = rv.cls === "river" ? 3 : 1.5; g.stroke();
    });

    // 线路
    g.beginPath();
    line0.forEach((p, i) => (i ? g.lineTo(px(p[0]), py(p[1])) : g.moveTo(px(p[0]), py(p[1]))));
    g.strokeStyle = "rgba(255,255,255,0.9)"; g.lineWidth = 8; g.stroke();
    g.strokeStyle = "#e8542f"; g.lineWidth = 5; g.stroke();

    // 点位
    data.pts.forEach((p) => {
      const X0 = px(p.x), Y0 = py(p.y);
      g.beginPath(); g.arc(X0, Y0, 13, 0, Math.PI * 2);
      g.fillStyle = "#fff"; g.fill();
      g.beginPath(); g.arc(X0, Y0, 10, 0, Math.PI * 2);
      g.fillStyle = p.tagColor; g.fill();
      T(g, p.tag, X0, Y0 - 20, { size: 20, bold: true, align: "center", color: "#173a4f" });
    });

    // 比例尺
    const mpp = 1000 / sc;
    const cand = [50, 100, 200, 500, 1000, 2000, 5000];
    let bar = cand[0];
    for (const v of cand) { if (v / mpp < 260) bar = v; }
    const bw = bar / mpp;
    g.fillStyle = "rgba(255,255,255,0.85)"; g.fillRect(X + 24, Y + H - 78, bw + 28, 52);
    g.fillStyle = "#22313f"; g.fillRect(X + 38, Y + H - 52, bw, 6);
    g.fillRect(X + 38, Y + H - 62, 3, 16); g.fillRect(X + 38 + bw - 3, Y + H - 62, 3, 16);
    T(g, bar >= 1000 ? (bar / 1000) + " km" : bar + " m", X + 38 + bw / 2, Y + H - 60,
      { size: 18, align: "center", color: "#22313f" });

    // 指北针
    const nx = X + W - 66, ny = Y + 62;
    g.fillStyle = "rgba(255,255,255,0.85)"; g.fillRect(nx - 34, ny - 40, 68, 88);
    g.beginPath(); g.moveTo(nx, ny - 26); g.lineTo(nx - 13, ny + 16); g.lineTo(nx, ny + 4);
    g.lineTo(nx + 13, ny + 16); g.closePath();
    g.fillStyle = "#22313f"; g.fill();
    T(g, "N", nx, ny + 36, { size: 18, bold: true, align: "center", color: "#22313f" });

    g.restore();

    // 图例
    let ly = Y + H + 44;
    const items = [["#e8542f", "规划线路"], ["#60b0d6", "河流 / 湖泊"],
      ["#22313f", "起点 / 途径点 / 终点"], ["#c9d6de", "山体阴影底图"]];
    items.forEach((it, i) => {
      const x = M + i * 300;
      g.fillStyle = it[0]; g.fillRect(x, ly - 14, 28, 12);
      T(g, it[1], x + 40, ly, { size: 19, color: "#4a5f6d" });
    });

    chrome(g, 3, "线路示意图");
    return c;
  }

  // ---------------- 第 4 页：分段明细 ----------------
  function pageSegments(data) {
    const { c, g } = page();
    T(g, "分段明细", M, 150, { size: 44, bold: true, color: "#173a4f" });
    T(g, "沿线按最近道路归属估算分段（长度 30 m 级采样归并）",
      M, 192, { size: 20, color: "#7d8f9c" });

    const cols = [M, M + 300, M + 480, M + 660, M + 830, M + 990];
    let y = 250;
    ["路段", "类型", "长度", "爬升", "下降", "预计用时"].forEach((hd, i) =>
      T(g, hd, cols[i], y, { size: 19, color: "#8aa0ae" }));
    y += 10; line(g, M, y, PW - M, y, "#c9d6de"); y += 36;
    data.segments.forEach((sg, i) => {
      if (i % 2 === 0) { g.fillStyle = "#f7fafc"; g.fillRect(M - 10, y - 26, PW - 2 * M + 20, 36); }
      T(g, sg.name, cols[0], y, { size: 20 });
      T(g, sg.cls, cols[1], y, { size: 19, color: "#6b8494" });
      T(g, fmtD(sg.len), cols[2], y, { size: 20, color: "#4a5f6d" });
      T(g, Math.round(sg.asc) + " m", cols[3], y, { size: 20, color: "#4a5f6d" });
      T(g, Math.round(sg.desc) + " m", cols[4], y, { size: 20, color: "#4a5f6d" });
      T(g, fmtT(sg.hours), cols[5], y, { size: 20, color: "#4a5f6d" });
      y += 38;
      if (y > PH - 220) return;
    });
    y += 10; line(g, M, y, PW - M, y, "#c9d6de"); y += 40;
    T(g, "合计", cols[0], y, { size: 22, bold: true });
    T(g, fmtD(data.stats.len), cols[2], y, { size: 22, bold: true });
    T(g, Math.round(data.stats.ascent) + " m", cols[3], y, { size: 22, bold: true });
    T(g, Math.round(data.stats.descent) + " m", cols[4], y, { size: 22, bold: true });
    T(g, fmtT(data.stats.hours), cols[5], y, { size: 22, bold: true });

    chrome(g, 4, "分段明细");
    return c;
  }

  // ---------------- 第 5 页：逐公里 + 说明 ----------------
  function pageTable(data) {
    const { c, g } = page();
    T(g, "逐公里高程表", M, 150, { size: 44, bold: true, color: "#173a4f" });
    T(g, "以起点为 0 km，每公里记录高程与区间起伏", M, 192, { size: 20, color: "#7d8f9c" });

    const rows = data.kmRows;
    const half = Math.ceil(rows.length / 2);
    const colW = (PW - 2 * M - 40) / 2;
    [0, 1].forEach((side) => {
      const bx = M + side * (colW + 40);
      let y = 250;
      ["里程", "高程", "区间爬升", "区间下降"].forEach((hd, i) =>
        T(g, hd, bx + i * (colW / 4), y, { size: 18, color: "#8aa0ae" }));
      y += 8; line(g, bx, y, bx + colW, y, "#c9d6de"); y += 32;
      rows.slice(side * half, (side + 1) * half).forEach((r, i) => {
        if (i % 2 === 0) { g.fillStyle = "#f7fafc"; g.fillRect(bx - 8, y - 24, colW + 16, 32); }
        [r[0], r[1], r[2], r[3]].forEach((v, j) =>
          T(g, v, bx + j * (colW / 4), y, { size: 19, color: "#4a5f6d" }));
        y += 32;
      });
    });

    let y = 250 + half * 32 + 120;
    y += T(g, "数据说明", M, y, { size: 28, bold: true, color: "#173a4f", gap: 20 });
    data.notes.forEach((n) => {
      y += T(g, "· " + n, M, y, { size: 19, color: "#4a5f6d", gap: 12 });
    });

    chrome(g, 5, "逐公里高程表");
    return c;
  }

  // ---------------- 数据加工 ----------------
  function nearestWay(x, y) {
    let best = { d: Infinity, w: null };
    for (const w of D.ways) {
      for (let i = 0; i + 1 < w.geom.length; i++) {
        const a = w.geom[i], b = w.geom[i + 1];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const l2 = dx * dx + dy * dy || 1e-12;
        let t = ((x - a[0]) * dx + (y - a[1]) * dy) / l2;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
        if (d < best.d) best = { d, w };
      }
    }
    return best.w;
  }

  const CLS_CN = { road: "公路", track: "土路", path: "步道", boardwalk: "栈道", steps: "台阶", link: "连接线" };

  function buildSegments(line, prof) {
    const pace = (K.router && K.router.getPace) ? K.router.getPace() : 3.6;
    const segs = [];
    let cur = null, curD = 0;
    const step = 30; // m
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i], b = line[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) * 1000;
      const n = Math.max(1, Math.round(len / step));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const w = nearestWay(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
        const nm = w ? (w.name || "（未归属）") : "（未归属）";
        const key = nm + "|" + (w ? w.cls : "");
        if (!cur || cur.key !== key) {
          if (cur) segs.push(cur);
          cur = { key, name: nm, cls: CLS_CN[(w || {}).cls] || "其他", len: 0, asc: 0, desc: 0, e0: null, e1: null };
        }
        cur.len += len / n;
        curD += len / n;
        const e = K.geo.elevAtKm ? K.geo.elevAtKm(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) : null;
        if (e !== null && e !== undefined) {
          if (cur.e0 === null) cur.e0 = e;
          if (cur.e1 !== null) { const d = e - cur.e1; if (d > 0) cur.asc += d; else cur.desc -= d; }
          cur.e1 = e;
        }
      }
    }
    if (cur) segs.push(cur);
    segs.forEach((sg) => {
      const grade = sg.len ? (sg.asc + sg.desc) / sg.len : 0;
      sg.hours = (sg.len / 1000) / (pace * Math.exp(-2.5 * grade)) * (sg.cls === "台阶" ? 1.35 : 1);
    });
    return segs;
  }

  function buildData(raw) {
    const s = raw.stats;
    const pts = raw.pts.map((p, i) => ({
      tag: i === 0 ? "A" : (i === raw.pts.length - 1 ? "B" : "W" + i),
      tagColor: i === 0 ? "#d64545" : (i === raw.pts.length - 1 ? "#2e8b57" : "#e08a2e"),
      name: p.name || (i === 0 ? "起点" : (i === raw.pts.length - 1 ? "终点" : "途径点 " + i)),
      x: p.x, y: p.y,
      latlon: p.lat.toFixed(5) + " / " + p.lon.toFixed(5),
      elev: fmtE(p.e, raw.eOff),
      hint: p.hint || "—",
    }));

    // 关键点
    const prof = raw.prof;
    let hiP = prof[0], loP = prof[0];
    prof.forEach((p) => { if (p[1] > hiP[1]) hiP = p; if (p[1] < loP[1]) loP = p; });
    let steep = [0, 0]; // [坡度, 距离]
    for (let i = 1; i < prof.length; i++) {
      const dd = prof[i][0] - prof[i - 1][0];
      if (dd < 20) continue;
      const g0 = Math.abs(prof[i][1] - prof[i - 1][1]) / dd;
      if (g0 > steep[0]) steep = [g0, prof[i][0]];
    }
    const keyPoints = [
      ["起点", "0 m", fmtE(prof[0][1], raw.eOff), "A 点"],
      ["终点", fmtD(prof[prof.length - 1][0]), fmtE(prof[prof.length - 1][1], raw.eOff), "B 点"],
      ["最高点", fmtD(hiP[0]), fmtE(hiP[1], raw.eOff), "线路最高处"],
      ["最低点", fmtD(loP[0]), fmtE(loP[1], raw.eOff), "线路最低处"],
      ["最陡段", fmtD(steep[1]), "坡度 " + (steep[0] * 100).toFixed(1) + " %", "100 m 滑动窗口最大值"],
    ];

    // 坡度分布
    const bands = [["< 5%", 0], ["5–10%", 0], ["10–20%", 0], ["> 20%", 0]];
    let tot = 0;
    for (let i = 1; i < prof.length; i++) {
      const dd = prof[i][0] - prof[i - 1][0];
      if (dd < 5) continue;
      const g0 = Math.abs(prof[i][1] - prof[i - 1][1]) / dd * 100;
      tot += dd;
      if (g0 < 5) bands[0][1] += dd;
      else if (g0 < 10) bands[1][1] += dd;
      else if (g0 < 20) bands[2][1] += dd;
      else bands[3][1] += dd;
    }
    const gradeBands = bands.map((b) => [b[0], tot ? (100 * b[1] / tot).toFixed(0) + "%" : "—"]);

    // 逐公里
    const kmRows = [];
    const total = prof[prof.length - 1][0];
    let prevE = prof[0][1], j = 0;
    for (let km = 0; km * 1000 < total; km++) {
      const dEnd = Math.min((km + 1) * 1000, total);
      let eAt = prof[prof.length - 1][1];
      while (j < prof.length && prof[j][0] <= dEnd) { eAt = prof[j][1]; j++; }
      const d = eAt - prevE;
      kmRows.push([
        (km) + "–" + (km + 1) + " km",
        fmtE(eAt, raw.eOff),
        (d > 0 ? "+" + Math.round(d) : "0") + " m",
        (d < 0 ? Math.round(-d) : "0") + " m",
      ]);
      prevE = eAt;
    }

    const segments = buildSegments(raw.line, prof);
    const surfaceMix = (() => {
      const m = {};
      segments.forEach((sg) => { m[sg.cls] = (m[sg.cls] || 0) + sg.len; });
      return Object.keys(m).map((k) => k + " " + fmtD(m[k]));
    })();

    const notes = [
      "路网与地名：OpenStreetMap（ODbL）；高程：AWS elevation-tiles-prod（Terrarium DEM，z13 约 12.6 m/格，纵向误差约 ±10 m）。",
      "高程基准：" + raw.zeroName + " 为 0 m（绝对高程约 " + raw.zeroAbs + " m），报告中除注明外均为相对高程。",
      "用时按当前配速估算：平地约 " + ((K.router && K.router.getPace) ? K.router.getPace().toFixed(1) : "3.6") + " km/h（可在网页中调整），并按坡度与路面（台阶 ×1.35、土路 ×1.18、公路 ×1.22、缺口连接 ×2.4）修正；实际请按体力与停留调整。",
      "分段归属为沿线路取最近道路的估算值，与实际走线可能略有出入；「缺口连接」段为地图数据未覆盖的推断连接，谨慎通行。",
      "本报告由离线网页自动生成，仅供徒步规划参考，不替代实地判断与官方公告。",
    ];

    return {
      label: raw.label, stats: s, prof: raw.prof, line: raw.line, pts,
      eOff: raw.eOff, zeroName: raw.zeroName, zeroAbs: raw.zeroAbs,
      keyPoints, gradeBands, kmRows, segments, surfaceMix, notes,
      notices: (D.notices || []).slice(0, 4),
      hillshadeImg: raw.hillshadeImg,
    };
  }

  // ---------------- PDF 组装 ----------------
  function pdfFromPages(canvases) {
    const jpegs = canvases.map((c) => ({
      w: c.width, h: c.height,
      data: atob(c.toDataURL("image/jpeg", 0.9).split(",")[1]),
    }));
    let out = "%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n";
    const offs = [];
    const pushObj = (s) => { offs.push(out.length); out += s; };
    let kids = "";
    const body = [];
    jpegs.forEach((jp, i) => {
      const pO = 3 + i * 3, cO = pO + 1, iO = pO + 2;
      kids += pO + " 0 R ";
      const content = "q 595.28 0 0 841.89 0 0 cm /Im0 Do Q\n";
      body.push(pO + " 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89]" +
        " /Resources << /XObject << /Im0 " + iO + " 0 R >> >> /Contents " + cO + " 0 R >>\nendobj\n");
      body.push(cO + " 0 obj\n<< /Length " + content.length + " >>\nstream\n" + content + "endstream\nendobj\n");
      body.push(iO + " 0 obj\n<< /Type /XObject /Subtype /Image /Width " + jp.w + " /Height " + jp.h +
        " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + jp.data.length +
        " >>\nstream\n" + jp.data + "\nendstream\nendobj\n");
    });
    pushObj("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    pushObj("2 0 obj\n<< /Type /Pages /Kids [" + kids + "] /Count " + jpegs.length + " >>\nendobj\n");
    body.forEach((b) => pushObj(b));
    const xrefPos = out.length;
    const nObj = 2 + body.length;
    out += "xref\n0 " + (nObj + 1) + "\n0000000000 65535 f \n";
    offs.forEach((o) => { out += String(o).padStart(10, "0") + " 00000 n \n"; });
    out += "trailer\n<< /Size " + (nObj + 1) + " /Root 1 0 R >>\nstartxref\n" + xrefPos + "\n%%EOF";
    const u8 = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) u8[i] = out.charCodeAt(i) & 0xff;
    return u8;
  }

  function buildPdf(raw) {
    const data = buildData(raw);
    const pages = [
      pageSummary(data), pageProfile(data), pageMap(data),
      pageSegments(data), pageTable(data),
    ];
    return { bytes: pdfFromPages(pages), pages: pages.length };
  }

  function previewPages(raw) {
    const data = buildData(raw);
    return [
      pageSummary(data), pageProfile(data), pageMap(data),
      pageSegments(data), pageTable(data),
    ].map((c) => c.toDataURL("image/png"));
  }

  function exportPdf(raw) {
    const { bytes, pages } = buildPdf(raw);
    const blob = new Blob([bytes], { type: "application/pdf" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "kanas-route-report.pdf";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return { pages, size: bytes.length };
  }

  K.report = { buildPdf, exportPdf, previewPages };
})();
