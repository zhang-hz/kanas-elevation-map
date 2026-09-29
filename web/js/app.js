/* app.js — UI: measurement modes, waypoints, layers, legend, search, exports */
(function () {
  "use strict";
  const D = window.KANAS_DATA;
  const K = window.KANAS;
  const api = K.mapApi, geo = K.geo, router = K.router;

  const state = {
    mode: "browse",     // browse | route | straight
    pts: [],            // [A, ...waypoints, B] as {x,y,lat,lon}
    insertMode: false,  // next map click inserts a waypoint before B
    eOff: 0,
    current: null,      // { prof, line, cum, stats, label }
  };

  const $ = s => document.querySelector(s);

  // ---------------- helpers ----------------
  let toastTimer = null;
  function toast(msg, ms) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 3200);
  }

  function fmtE(v) { return (v - state.eOff).toFixed(0); }

  function cumulate(line) {
    const cum = [0];
    for (let i = 1; i < line.length; i++) {
      cum.push(cum[i - 1] + geo.distM(line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]));
    }
    return cum;
  }

  function posAtDist(d) {
    const c = state.current;
    if (!c || !c.cum) return null;
    const cum = c.cum;
    if (d <= 0) return c.line[0];
    if (d >= cum[cum.length - 1]) return c.line[c.line.length - 1];
    let i = 1;
    while (i < cum.length && cum[i] < d) i++;
    const t = (d - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
    return [geo.lerp(c.line[i - 1][0], c.line[i][0], t),
            geo.lerp(c.line[i - 1][1], c.line[i][1], t)];
  }

  // ---------------- modes ----------------
  const MODE_TEXT = {
    browse: "浏览模式 · 点击路线/机位查看详情",
    route: "两点测线 · 点击地图设置 A 点",
    straight: "直线剖面 · 点击地图设置 A 点",
  };

  function updateStatusText() {
    let txt;
    const n = state.pts.length;
    if (state.mode === "browse") txt = MODE_TEXT.browse;
    else if (state.insertMode) txt = "途径点模式 · 点击地图插入途径点（在 B 点之前）";
    else if (state.current) txt = "已生成" + (state.mode === "straight" ? "直线剖面" : "线路") +
      " · 点击地图可重新设置 A 点" + (n > 2 ? "（含 " + (n - 2) + " 个途径点）" : "");
    else if (n === 1) txt = (state.mode === "straight" ? "直线剖面" : "两点测线") +
      " · A 已设置，点击设置 B 点";
    else txt = MODE_TEXT[state.mode];
    $("#status-mode").textContent = txt;
    $("#btn-waypoint").classList.toggle("active", state.insertMode);
  }

  function setMode(mode) {
    state.mode = mode;
    state.insertMode = false;
    document.querySelectorAll(".mode-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.mode === mode));
    updateStatusText();
    $("#map").style.cursor = mode === "browse" ? "" : "crosshair";
    $("#measure-help").textContent = mode === "browse"
      ? "点击地图上的任意路线可查看详情；选择“两点测线”后依次点击地图设置 A、B 两点，自动沿路网规划徒步线路。"
      : mode === "route"
        ? "沿现有路网自动规划步行线路（按步行难度择优）。点“＋途径点”可插入途经位置，支持多点规划。"
        : "各点之间按直线剖切地形（适合越野参考，不沿路网），支持多途径点。";
  }

  // ---------------- point management ----------------
  function renderPoints() {
    const pts = state.pts;
    if (pts.length >= 2) {
      api.placeAB("A", pts[0].x, pts[0].y);
      api.placeAB("B", pts[pts.length - 1].x, pts[pts.length - 1].y);
    } else if (pts.length === 1) {
      api.placeAB("A", pts[0].x, pts[0].y);
    }
    api.placeWaypoints(pts.slice(1, -1));
    renderPointList();
  }

  function renderPointList() {
    const box = $("#waypoint-list");
    const n = state.pts.length;
    if (n < 3) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    box.innerHTML = state.pts.slice(1, -1).map((p, i) =>
      '<span class="wp-chip"><b>W' + (i + 1) + '</b> ' +
      (p.lat.toFixed(4)) + ', ' + (p.lon.toFixed(4)) +
      '<button class="wp-del" data-i="' + (i + 1) + '">×</button></span>').join("");
    box.querySelectorAll(".wp-del").forEach(b => {
      b.addEventListener("click", () => {
        state.pts.splice(parseInt(b.dataset.i, 10), 1);
        renderPoints();
        if (state.pts.length >= 2) compute();
        else clearResult();
      });
    });
  }

  function handleMapClick(lat, lon, hintWay) {
    if (state.mode === "browse") return;
    const km = geo.toKm(lat, lon);
    const pt = { x: km[0], y: km[1], lat, lon, hint: hintWay };
    const n = state.pts.length;
    if (state.insertMode && n >= 2) {
      state.pts.splice(n - 1, 0, pt); // insert before B
      renderPoints();
      compute();
    } else if (n === 0 || (n >= 2 && !state.insertMode)) {
      clearResult();
      api.clearAB();
      state.pts = [pt];
      renderPoints();
      toast("已设置 A 点，请点击设置 B 点");
    } else {
      state.pts.push(pt);
      renderPoints();
      compute();
    }
    updateStatusText();
  }

  function setPoint(which, x, y) {
    const ll = geo.toLatLon(x, y);
    const pt = { x, y, lat: ll[0], lon: ll[1] };
    if (which === "A") {
      state.pts = [pt];
      api.clearAB();
    } else {
      if (state.pts.length === 0) state.pts = [pt];
      else state.pts.push(pt);
    }
    if (state.mode === "browse") setMode("route");
    renderPoints();
    if (state.pts.length >= 2) compute();
    updateStatusText();
  }

  function compute() {
    const pts = state.pts;
    if (pts.length < 2) return;
    let r;
    let fallback = false;
    if (state.mode === "straight") {
      r = router.straightVia(pts.map(p => [p.x, p.y]));
    } else {
      r = router.routeVia(pts.map(p => [p.x, p.y]), pts.map(p => p.hint));
      if (r.error) {
        r = router.straightVia(pts.map(p => [p.x, p.y]));
        fallback = true;
        toast("路网不连通，已切换直线参考剖面（不沿路网）", 5000);
      }
    }
    api.drawRoute(r.line);
    const nWp = pts.length - 2;
    const label = (fallback ? "A → B 直线参考（路网不连通）"
      : (state.mode === "straight" ? "直线剖面" : "A → B 线路")) +
      (nWp > 0 ? "（含 " + nWp + " 个途径点）" : "") +
      (state.mode === "straight" || fallback
        ? ""
        : "（步行约 " + router.fmtTime(r.stats.hours) + "）");
    state.current = {
      prof: r.prof,
      line: r.line,
      cum: cumulate(r.line),
      stats: r.stats,
      label,
    };
    renderResult();
    const bounds = r.line.map(p => [p[1], p[0]]);
    api.map.fitBounds(bounds, { padding: [90, 90], maxZoom: 13 });
  }

  function clearResult() {
    state.current = null;
    $("#result-card").hidden = true;
    api.clearRoute();
    api.hideProfileMarker();
  }

  function clearAll() {
    state.pts = [];
    state.insertMode = false;
    api.clearAB();
    clearResult();
    renderPointList();
    setMode("browse");
    toast("已清除测量结果");
  }

  // ---------------- result rendering ----------------
  function renderResult() {
    const c = state.current;
    if (!c) return;
    $("#result-card").hidden = false;
    $("#result-title").textContent = c.label;
    const s = c.stats;
    const cells = [
      [router.fmtDist(s.len), "距离"],
      [Math.round(s.ascent) + " m", "累计爬升"],
      [Math.round(s.descent) + " m", "累计下降"],
      [fmtE(s.maxE) + " m", "最高点"],
      [fmtE(s.minE) + " m", "最低点"],
      [s.hours ? router.fmtTime(s.hours) : "—", "预计步行"],
    ];
    $("#result-stats").innerHTML = cells.map(c0 =>
      '<div class="stat"><div class="v">' + c0[0] + '</div><div class="k">' + c0[1] + "</div></div>").join("");
    K.chart.render($("#profile-chart"), c.prof, { eOff: state.eOff });
  }

  // chart hover
  const canvas = $("#profile-chart");
  canvas.addEventListener("mousemove", ev => {
    const c = state.current;
    if (!c) return;
    const rect = canvas.getBoundingClientRect();
    const hit = K.chart.hitTest(ev.clientX - rect.left);
    if (!hit) return;
    K.chart.drawHover(canvas, hit);
    const tip = $("#chart-tip");
    tip.hidden = false;
    tip.style.left = hit.x + "px";
    tip.style.top = hit.y + "px";
    tip.textContent = (hit.dist / 1000).toFixed(2) + " km · 相对高程 " +
      hit.elev.toFixed(0) + " m";
    const pos = posAtDist(hit.dist);
    if (pos) api.showProfileMarker(pos[0], pos[1]);
  });
  canvas.addEventListener("mouseleave", () => {
    $("#chart-tip").hidden = true;
    api.hideProfileMarker();
    if (state.current) K.chart.drawHover(canvas, null);
  });

  // ---------------- measurement buttons ----------------
  $("#btn-clear").addEventListener("click", clearAll);
  $("#btn-waypoint").addEventListener("click", () => {
    if (state.pts.length < 1) {
      toast("请先设置 A 点（和 B 点）");
      return;
    }
    state.insertMode = !state.insertMode;
    updateStatusText();
    toast(state.insertMode
      ? "途径点模式：点击地图插入途经位置（可连续添加）"
      : "已退出途径点模式");
  });
  $("#btn-undo").addEventListener("click", () => {
    if (!state.pts.length) { toast("没有可撤销的点"); return; }
    state.pts.pop();
    api.clearAB();
    renderPoints();
    if (state.pts.length >= 2) compute();
    else clearResult();
    updateStatusText();
    toast("已撤销上一点");
  });
  $("#btn-swap").addEventListener("click", () => {
    if (state.pts.length < 2) { toast("请先设置 A、B 两点"); return; }
    state.pts.reverse();
    api.clearAB();
    renderPoints();
    compute();
  });
  $("#btn-rezero").addEventListener("click", () => {
    const c = state.current;
    if (!c) { toast("请先规划一条线路"); return; }
    setZero(c.stats.minE);
  });

  // ---------------- exports ----------------
  function download(filename, text, mime) {
    const blob = new Blob([text], { type: (mime || "text/plain") + ";charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function profileLatLngs() {
    const c = state.current;
    return c.prof.map(p => {
      const pos = posAtDist(p[0]);
      const ll = pos ? geo.toLatLon(pos[0], pos[1]) : [c.line[0][1], c.line[0][0]];
      return { d: p[0], rel: p[1], lat: ll[0], lon: ll[1] };
    });
  }

  $("#btn-csv").addEventListener("click", () => {
    const c = state.current;
    if (!c) { toast("请先规划一条线路"); return; }
    const rows = profileLatLngs();
    let csv = "distance_m,distance_km,elev_rel_m,elev_abs_m,lat,lon\n";
    for (const r of rows) {
      csv += r.d.toFixed(1) + "," + (r.d / 1000).toFixed(4) + "," +
        (r.rel - state.eOff).toFixed(1) + "," +
        (r.rel + D.meta.datum.elevAbs).toFixed(1) + "," +
        r.lat.toFixed(6) + "," + r.lon.toFixed(6) + "\n";
    }
    download("kanas-profile.csv", csv, "text/csv");
    toast("已导出 CSV 高程表（含坐标）");
  });

  $("#btn-gpx").addEventListener("click", () => {
    const c = state.current;
    if (!c) { toast("请先规划一条线路"); return; }
    const rows = profileLatLngs();
    const pts = state.pts;
    const wpNames = pts.map((p, i) =>
      i === 0 ? "A 起点" : (i === pts.length - 1 ? "B 终点" : "途径点 W" + i));
    let gpx = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<gpx version="1.1" creator="kanas-elevation-map" xmlns="http://www.topografix.com/GPX/1/1">\n' +
      '  <metadata><name>' + (c.label || "Kanas route") + '</name></metadata>\n';
    pts.forEach((p, i) => {
      const e = i === 0 ? c.prof[0][1] : (i === pts.length - 1 ? c.prof[c.prof.length - 1][1] : null);
      gpx += '  <wpt lat="' + p.lat.toFixed(6) + '" lon="' + p.lon.toFixed(6) + '">' +
        "<name>" + wpNames[i] + "</name>" +
        (e !== null ? "<ele>" + (e + D.meta.datum.elevAbs).toFixed(1) + "</ele>" : "") +
        "</wpt>\n";
    });
    gpx += "  <trk><name>" + (c.label || "Kanas route") + "</name><trkseg>\n";
    for (const r of rows) {
      gpx += '    <trkpt lat="' + r.lat.toFixed(6) + '" lon="' + r.lon.toFixed(6) +
        '"><ele>' + (r.rel + D.meta.datum.elevAbs).toFixed(1) + "</ele></trkpt>\n";
    }
    gpx += "  </trkseg></trk>\n</gpx>\n";
    download("kanas-route.gpx", gpx, "application/gpx+xml");
    toast("已导出 GPX 轨迹（绝对高程，可导入手表/奥维/两步路）");
  });

  $("#btn-geojson").addEventListener("click", () => {
    const c = state.current;
    if (!c) { toast("请先规划一条线路"); return; }
    const rows = profileLatLngs();
    const feats = [];
    feats.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: rows.map(r => [r.lon, r.lat, +(r.rel + D.meta.datum.elevAbs).toFixed(1)]),
      },
      properties: {
        name: c.label,
        distance_m: +c.stats.len.toFixed(1),
        ascent_m: +c.stats.ascent.toFixed(1),
        descent_m: +c.stats.descent.toFixed(1),
        min_elev_abs_m: +(c.stats.minE + D.meta.datum.elevAbs).toFixed(1),
        max_elev_abs_m: +(c.stats.maxE + D.meta.datum.elevAbs).toFixed(1),
        datum: D.meta.datum.name,
      },
    });
    state.pts.forEach((p, i) => {
      feats.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.lon, p.lat] },
        properties: { role: i === 0 ? "start" : (i === state.pts.length - 1 ? "end" : "waypoint"), index: i },
      });
    });
    download("kanas-route.geojson",
      JSON.stringify({ type: "FeatureCollection", features: feats }, null, 1),
      "application/geo+json");
    toast("已导出 GeoJSON");
  });

  $("#btn-png").addEventListener("click", () => {
    const c = state.current;
    if (!c) { toast("请先规划一条线路"); return; }
    const off = document.createElement("canvas");
    K.chart.render(off, c.prof, { eOff: state.eOff, dpr: 2, width: 640, height: 230 });
    const a = document.createElement("a");
    a.href = off.toDataURL("image/png");
    a.download = "kanas-profile.png";
    a.click();
    toast("已导出高程剖面图 PNG（2×）");
  });

  // ---------------- datum zero ----------------
  function setZero(relVal) {
    state.eOff = relVal;
    $("#datum-name").textContent = "自定义基准（地图点击处）";
    $("#datum-abs").textContent = "绝对高程 " +
      (D.meta.datum.elevAbs + relVal).toFixed(1) + " m · 原基准：" + D.meta.datum.name;
    toast("0 m 基准已移至该点（相对原基准 " + (relVal >= 0 ? "+" : "") +
      relVal.toFixed(0) + " m）");
    renderResult();
  }

  // ---------------- layers ----------------
  const LAYERS = [
    ["hill", "山体底图", "#8a9a7b", true],
    ["lakes", "湖泊", "#5b9bd0", true],
    ["rivers", "河流", "#4b93cf", true],
    ["roads", "公路 / 车道", "#c2762e", true],
    ["trails", "步道 / 栈道", "#b4552d", true],
    ["shuttles", "区间车线", "#c0392b", true],
    ["pois", "兴趣点", "#7a5a8a", true],
  ];
  $("#layer-toggles").innerHTML = LAYERS.map(([key, name, color, on]) =>
    '<label class="layer-toggle"><input type="checkbox" data-layer="' + key + '"' +
    (on ? " checked" : "") + '><span class="swatch" style="background:' + color +
    '"></span>' + name + "</label>").join("");
  $("#layer-toggles").addEventListener("change", ev => {
    const key = ev.target.getAttribute("data-layer");
    if (!key) return;
    const lg = api.layerGroups[key];
    if (ev.target.checked) lg.addTo(api.map);
    else api.map.removeLayer(lg);
  });

  // ---------------- legend ----------------
  function legendLine(label, css) {
    return '<div class="legend-item"><span class="swatch" style="' + css + '"></span>' + label + "</div>";
  }
  function legendPin(label, cls, icon) {
    return '<div class="legend-item"><span class="badge poi-pin ' + cls + '">' + icon + "</span>" + label + "</div>";
  }
  $("#legend").innerHTML = [
    legendLine("公路 / 车道", "border-top:5px solid #c2762e"),
    legendLine("土路 / 牧道", "border-top:3px dashed #9a6b3f"),
    legendLine("步道", "border-top:3px dashed #b4552d"),
    legendLine("木栈道", "border-top:4px dotted #2c6e8f"),
    legendLine("台阶", "border-top:3px dotted #7a3e2e"),
    legendLine("河流 / 溪流", "border-top:3px solid #4b93cf"),
    legendLine("湖泊", "border-top:9px solid #5b9bd0"),
    legendLine("景区区间车线", "border-top:4px dashed #c0392b"),
    legendPin("打卡机位", "photo", api.ICONS ? api.ICONS.photo : ""),
    legendPin("观景点", "view", api.ICONS ? api.ICONS.view : ""),
    legendPin("车站 / 停靠点", "station", api.ICONS ? api.ICONS.station : ""),
    legendPin("村落", "village", api.ICONS ? api.ICONS.village : ""),
    '<div class="legend-item" style="color:#5c6b78;font-size:11px">高程均为相对高程（游客中心 = 0 m）</div>',
  ].join("");

  // ---------------- recommended routes ----------------
  const routeList = $("#route-list");
  (D.curatedRoutes || []).forEach(r => {
    const div = document.createElement("div");
    div.className = "route-item";
    div.innerHTML = '<div class="r-name">' + r.name + '</div><div class="r-desc">' + r.desc + "</div>";
    div.addEventListener("click", () => {
      setMode("route");
      clearResult();
      api.clearAB();
      state.pts = [];
      const fa = geo.toKm(r.from.lat, r.from.lon);
      const fb = geo.toKm(r.to.lat, r.to.lon);
      setPoint("A", fa[0], fa[1]);
      setPoint("B", fb[0], fb[1]);
    });
    routeList.appendChild(div);
  });

  // ---------------- search ----------------
  const searchBox = $("#search-box");
  const searchResults = $("#search-results");
  searchBox.addEventListener("input", () => {
    const q = searchBox.value.trim();
    searchResults.innerHTML = "";
    if (!q) return;
    const hits = [];
    const seenNames = new Set();
    D.pois.forEach((p, i) => {
      if (p.name.indexOf(q) >= 0) {
        hits.push({ kind: "poi", i, name: p.name, cat: api.CAT_NAME[p.cat] || p.cat, x: p.x, y: p.y });
        seenNames.add(p.name);
      }
    });
    D.ways.forEach((w, i) => {
      if (w.name && w.name.indexOf(q) >= 0 && !seenNames.has(w.name)) {
        seenNames.add(w.name);
        hits.push({ kind: "way", i, name: w.name, cat: api.CLS_NAME[w.cls] || w.cls, x: w.geom[0][0], y: w.geom[0][1] });
      }
    });
    hits.slice(0, 14).forEach(h => {
      const div = document.createElement("div");
      div.className = "search-item";
      div.innerHTML = h.name + '<span class="si-type">' + h.cat + "</span>";
      div.addEventListener("click", () => {
        if (h.kind === "poi") {
          api.flyToKm(h.x, h.y, 13);
          api.openPoiPopup(h.i, L.latLng(h.y, h.x));
        } else {
          api.highlightWay(h.i);
          api.flyToKm(h.x, h.y, 13);
          api.openWayPopup(h.i, L.latLng(h.y, h.x));
        }
      });
      searchResults.appendChild(div);
    });
    if (!hits.length) searchResults.innerHTML = '<div class="search-item">未找到相关地点</div>';
  });

  // ---------------- mode buttons ----------------
  document.querySelectorAll(".mode-btn").forEach(b =>
    b.addEventListener("click", () => {
      setMode(b.dataset.mode);
    }));

  // ---------------- expose to map.js ----------------
  K.app = {
    handleMapClick,
    handleMapClickKm(x, y, hintWay) {
      const ll = geo.toLatLon(x, y);
      handleMapClick(ll[0], ll[1], hintWay);
    },
    isMeasure: () => state.mode !== "browse",
    setPoint,
    setZero,
    eOff: () => state.eOff,
    showWayProfile(idx) {
      const w = D.ways[idx];
      const prof = w.d.map((d, i) => [d, w.e[i]]);
      state.current = {
        prof,
        line: w.geom,
        cum: cumulate(w.geom),
        stats: {
          len: w.len, ascent: w.ascent, descent: w.descent,
          minE: w.minE, maxE: w.maxE,
          hours: router.toblerHours(w.len, w.maxE - w.minE + w.ascent * 0.2),
        },
        label: (w.name || "未命名路线") + " · 剖面",
      };
      api.map.closePopup();
      renderResult();
    },
    toast,
  };

  // ---------------- init ----------------
  const noticeBox = $("#notice-list");
  const notices = D.notices || [];
  noticeBox.innerHTML = notices.map(n => "<li>" + n + "</li>").join("");

  $("#datum-name").textContent = D.meta.datum.name;
  $("#datum-abs").textContent = "绝对高程 " + D.meta.datum.elevAbs.toFixed(1) +
    " m（DEM 推算）";
  setMode("browse");
  window.addEventListener("resize", () => {
    if (state.current) K.chart.render(canvas, state.current.prof, { eOff: state.eOff });
  });
})();
