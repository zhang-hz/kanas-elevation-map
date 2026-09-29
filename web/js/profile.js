/* profile.js — elevation profile chart (canvas) with hover support */
(function () {
  "use strict";
  const K = (window.KANAS = window.KANAS || {});

  const STOPS = [
    [-250, [26, 78, 120]], [-60, [70, 140, 160]], [0, [96, 158, 110]],
    [60, [128, 176, 96]], [180, [188, 196, 112]], [320, [206, 176, 116]],
    [480, [186, 142, 96]], [650, [150, 118, 100]], [850, [168, 160, 156]],
    [1100, [232, 230, 228]],
  ];

  function bandColor(e) {
    if (e <= STOPS[0][0]) return STOPS[0][1];
    for (let i = 1; i < STOPS.length; i++) {
      if (e <= STOPS[i][0]) {
        const t = (e - STOPS[i - 1][0]) / (STOPS[i][0] - STOPS[i - 1][0]);
        const a = STOPS[i - 1][1], b = STOPS[i][1];
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      }
    }
    return STOPS[STOPS.length - 1][1];
  }
  function rgb(c, alpha) {
    return alpha === undefined
      ? "rgb(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + ")"
      : "rgba(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + "," + alpha + ")";
  }

  function niceTicks(min, max, count) {
    const span = Math.max(1e-6, max - min);
    const raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return { lo, hi, ticks };
  }

  const state = {
    prof: null, eOff: 0, geom: null,
  };

  function render(canvas, prof, opts) {
    opts = opts || {};
    const eOff = opts.eOff || 0;
    if (!prof || prof.length < 2) return;
    const dpr = opts.dpr || window.devicePixelRatio || 1;
    const cssW = opts.width || canvas.clientWidth || 640;
    const cssH = opts.height || canvas.clientHeight || 200;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const L = 46, R = 12, T = 16, B = 26;
    const w = cssW - L - R, h = cssH - T - B;

    const d0 = prof[0][0], d1 = prof[prof.length - 1][0];
    let mn = Infinity, mx = -Infinity;
    for (const p of prof) {
      const v = p[1] - eOff;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const pad = Math.max(8, (mx - mn) * 0.12);
    const yt = niceTicks(mn - pad, mx + pad, 4);
    const xt = niceTicks(d0 / 1000, d1 / 1000, 5);

    const xOf = d => L + (d - d0) / Math.max(1, d1 - d0) * w;
    const yOf = e => T + h - ((e - eOff) - yt.lo) / (yt.hi - yt.lo) * h;

    // grid
    ctx.strokeStyle = "#e6e0d5";
    ctx.lineWidth = 1;
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillStyle = "#8a7f70";
    for (const v of yt.ticks) {
      const y = T + h - (v - yt.lo) / (yt.hi - yt.lo) * h;
      if (y < T - 1 || y > T + h + 1) continue;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + w, y); ctx.stroke();
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(String(Math.round(v)), L - 6, y);
    }
    for (const v of xt.ticks) {
      const x = L + (v * 1000 - d0) / Math.max(1, d1 - d0) * w;
      if (x < L - 1 || x > L + w + 1) continue;
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + h); ctx.stroke();
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillText((d1 - d0 > 9000 ? v.toFixed(1) : v.toFixed(2)) + " km", x, T + h + 6);
    }

    // area fill with hypsometric gradient
    const grad = ctx.createLinearGradient(0, T, 0, T + h);
    for (let i = 0; i <= 10; i++) {
      const frac = i / 10;
      const eVal = yt.hi - frac * (yt.hi - yt.lo);
      grad.addColorStop(frac, rgb(bandColor(eVal), 0.78));
    }
    ctx.beginPath();
    ctx.moveTo(xOf(prof[0][0]), yOf(prof[0][1]));
    for (const p of prof) ctx.lineTo(xOf(p[0]), yOf(p[1]));
    ctx.lineTo(xOf(prof[prof.length - 1][0]), T + h);
    ctx.lineTo(xOf(prof[0][0]), T + h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // line
    ctx.beginPath();
    prof.forEach((p, i) => {
      const x = xOf(p[0]), y = yOf(p[1]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#6b4226";
    ctx.lineWidth = 1.8;
    ctx.lineJoin = "round";
    ctx.stroke();

    // frame
    ctx.strokeStyle = "#cfc6b6";
    ctx.strokeRect(L, T, w, h);

    state.prof = prof;
    state.eOff = eOff;
    state.geom = { L, T, w, h, d0, d1, yt, xOf, yOf };
  }

  function hitTest(px) {
    const st = state;
    if (!st.prof || !st.geom) return null;
    const { L, w, d0, d1, xOf } = st.geom;
    const t = Math.min(1, Math.max(0, (px - L) / w));
    const d = d0 + t * (d1 - d0);
    const prof = st.prof;
    let best = 0, bestX = Infinity;
    for (let i = 0; i < prof.length; i++) {
      const dd = Math.abs(prof[i][0] - d);
      if (dd < bestX) { bestX = dd; best = i; }
    }
    return {
      idx: best,
      dist: prof[best][0],
      elev: prof[best][1] - st.eOff,
      x: xOf(prof[best][0]),
      y: st.geom.yOf(prof[best][1]),
    };
  }

  function drawHover(canvas, hit) {
    const st = state;
    if (!st.geom) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext("2d");
    // redraw base
    render(canvas, st.prof, { eOff: st.eOff });
    if (!hit) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { T, h, L, w } = st.geom;
    ctx.strokeStyle = "rgba(180,85,45,.75)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hit.x, T); ctx.lineTo(hit.x, T + h);
    ctx.stroke();
    ctx.fillStyle = "#b4552d";
    ctx.beginPath();
    ctx.arc(hit.x, hit.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  /** tiny sparkline for popups */
  function mini(canvas, prof, eOff) {
    eOff = eOff || 0;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 240, cssH = canvas.clientHeight || 64;
    canvas.width = cssW * dpr; canvas.height = cssH * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let mn = Infinity, mx = -Infinity;
    for (const p of prof) {
      const v = p[1] - eOff;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (mx - mn < 4) { mx = mn + 4; }
    const xOf = i => 4 + i / (prof.length - 1) * (cssW - 8);
    const yOf = v => 4 + (cssH - 8) - (v - mn) / (mx - mn) * (cssH - 8);
    const grad = ctx.createLinearGradient(0, 0, 0, cssH);
    grad.addColorStop(0, "rgba(186,142,96,.55)");
    grad.addColorStop(1, "rgba(128,176,96,.45)");
    ctx.beginPath();
    prof.forEach((p, i) => {
      const x = xOf(i), y = yOf(p[1] - eOff);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.lineTo(xOf(prof.length - 1), cssH - 2);
    ctx.lineTo(xOf(0), cssH - 2);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    prof.forEach((p, i) => {
      const x = xOf(i), y = yOf(p[1] - eOff);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#6b4226";
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.fillStyle = "#6b4226";
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(Math.round(mn) + " m", 5, cssH - 4);
    ctx.textAlign = "right";
    ctx.fillText(Math.round(mx) + " m", cssW - 5, cssH - 4);
  }

  K.chart = { render, hitTest, drawHover, mini, bandColor };
})();
