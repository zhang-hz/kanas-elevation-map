/* map.js — Leaflet map, self-drawn layers/icons, scale bar, popups */
(function () {
  "use strict";
  const D = window.KANAS_DATA;
  const K = (window.KANAS = window.KANAS || {});
  const geo = K.geo;

  // ---------------- styles ----------------
  const WAY_STYLE = {
    road:      { color: "#c2762e", weight: 3.2, opacity: 0.95 },
    track:     { color: "#9a6b3f", weight: 2.1, dashArray: "7 5", opacity: 0.9 },
    path:      { color: "#b4552d", weight: 1.9, dashArray: "5 4", opacity: 0.92 },
    boardwalk: { color: "#2c6e8f", weight: 3.4, dashArray: "1 6", lineCap: "round", opacity: 0.95 },
    steps:     { color: "#7a3e2e", weight: 2.3, dashArray: "2 3", opacity: 0.92 },
    link:      { color: "#8a8a8a", weight: 2.2, dashArray: "3 6", opacity: 0.85 },
  };
  const CLS_NAME = {
    road: "公路/车道", track: "土路/牧道", path: "步道",
    boardwalk: "木栈道", steps: "台阶", link: "数据缺口连接",
  };
  const CAT_NAME = {
    photo: "打卡机位", view: "观景点", station: "车站/停靠点", village: "村落",
    stay: "住宿", attraction: "景点", info: "服务信息", service: "服务设施", gate: "出入口",
  };

  const ICONS = {
    photo: '<svg viewBox="0 0 24 24"><rect x="3" y="7.5" width="18" height="12" rx="2.2"/><rect x="8.2" y="4.4" width="7.6" height="3.2" rx="1.1"/><circle cx="12" cy="13.4" r="3.5" fill="#b4552d"/></svg>',
    view: '<svg viewBox="0 0 24 24"><path d="M2 19 L9 6.5 L13.2 13 L15.6 9.2 L22 19 Z"/></svg>',
    station: '<svg viewBox="0 0 24 24"><rect x="4" y="3.5" width="16" height="12.5" rx="2.4"/><circle cx="8" cy="18.2" r="2.1"/><circle cx="16" cy="18.2" r="2.1"/><rect x="4" y="12" width="16" height="2.2" fill="#4f6f52"/></svg>',
    village: '<svg viewBox="0 0 24 24"><path d="M12 2.6 L21.4 10.4 L19.2 10.4 L19.2 20.6 L4.8 20.6 L4.8 10.4 L2.6 10.4 Z"/></svg>',
    stay: '<svg viewBox="0 0 24 24"><path d="M3 7 v12 h2 v-2 h14 v2 h2 v-8 a2.5 2.5 0 0 0 -2.5 -2.5 H13 v3.5 h-2 V8.5 H3 Z"/><circle cx="7.2" cy="12.2" r="1.9"/></svg>',
    attraction: '<svg viewBox="0 0 24 24"><path d="M12 1.8 l3.1 7.1 7.7 .6 -5.9 5 1.8 7.6 -6.7-4.1 -6.7 4.1 1.8-7.6 -5.9-5 7.7-.6 Z"/></svg>',
    info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.2"/><rect x="10.9" y="10.4" width="2.2" height="7" rx="1.1" fill="#5c6b78"/><circle cx="12" cy="7.2" r="1.5" fill="#5c6b78"/></svg>',
    service: '<svg viewBox="0 0 24 24"><path d="M6 3 h3 v8 a2.5 2.5 0 0 0 5 0 V3 h3 v8 a5.5 5.5 0 0 1 -4 5.2 V21 h-2 v-4.8 A5.5 5.5 0 0 1 6 11 Z"/></svg>',
    gate: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="3" height="15" rx="1"/><rect x="17.5" y="5" width="3" height="15" rx="1"/><rect x="3.5" y="8.4" width="17" height="2.4"/><rect x="3.5" y="13.6" width="17" height="2.4"/></svg>',
  };

  // ---------------- map ----------------
  const map = L.map("map", {
    crs: L.CRS.Simple,
    zoomControl: true,
    attributionControl: true,
    minZoom: 1,
    maxZoom: 14,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 90,
  });
  map.attributionControl.setPrefix("");
  map.attributionControl.addAttribution("© OpenStreetMap · DEM AWS Terrain Tiles");

  map.createPane("hill").style.zIndex = 250;
  map.createPane("vec").style.zIndex = 420;
  map.createPane("shuttle").style.zIndex = 430;   // above roads so it stays clickable

  /**
   * Interactive line = invisible fat hit line (easy to click, even in dash gaps)
   * + non-interactive visible line on top. Keeps the cursor honest: pointer only
   * appears near actual lines (a full-map canvas would show a hand everywhere and
   * swallow clicks meant for markers/layers below it).
   */
  function clickableLine(latlngs, style, pane, onClick, tooltipText) {
    const hit = L.polyline(latlngs, {
      pane, color: "#000", weight: 18, opacity: 0, interactive: true,
      className: "hit-line",
    });
    if (onClick) hit.on("click", onClick);
    if (tooltipText) hit.bindTooltip(tooltipText, { sticky: true });
    const vis = L.polyline(latlngs,
      Object.assign({ pane, interactive: false }, style));
    return [hit, vis];
  }

  const b = D.meta.bounds;
  const sw = geo.toKm(b.s, b.w), ne = geo.toKm(b.n, b.e);

  const hill = L.imageOverlay("data/hillshade.png",
    [[sw[1], sw[0]], [ne[1], ne[0]]],
    { pane: "hill", interactive: false, opacity: 1 });
  hill.addTo(map);

  // initial view: extent of actual content (POIs/ways), not the whole DEM box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function grow(x, y) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  for (const w of D.ways) for (const p of w.geom) grow(p[0], p[1]);
  for (const p of D.pois) grow(p.x, p.y);
  if (isFinite(minX)) {
    map.fitBounds([[minY, minX], [maxY, maxX]], { padding: [24, 24] });
  } else {
    map.fitBounds([[sw[1], sw[0]], [ne[1], ne[0]]], { padding: [10, 10] });
  }

  // ---------------- vector layers ----------------
  const layerGroups = {
    hill: L.layerGroup([hill]),
    lakes: L.layerGroup(),
    rivers: L.layerGroup(),
    roads: L.layerGroup(),
    trails: L.layerGroup(),
    shuttles: L.layerGroup(),
    pois: L.layerGroup(),
  };

  let suppressClick = 0;

  /** in measurement modes every click places a point; in browse mode it opens info */
  function measureOr(fn) {
    return e => {
      if (K.app && K.app.isMeasure && K.app.isMeasure()) {
        L.DomEvent.stopPropagation(e.originalEvent || e);
        suppressClick = Date.now() + 350;
        K.app.handleMapClickKm(e.latlng.lng, e.latlng.lat);
      } else {
        L.DomEvent.stopPropagation(e.originalEvent || e);
        suppressClick = Date.now() + 350;
        fn(e);
      }
    };
  }

  // lakes
  for (const lk of D.lakes) {
    const rings = (lk.geom || []).map(ring =>
      ring.map(p => [p[1], p[0]]));
    const poly = L.polygon(rings, {
      pane: "vec",
      color: "#2c6e8f", weight: 1.2,
      fillColor: "#5b9bd0", fillOpacity: 0.62,
      interactive: true,
    });
    if (lk.name) {
      poly.bindTooltip(lk.name, {
        permanent: true, direction: "center",
        className: "poi-label",
      });
    }
    poly.on("click", measureOr(e => openLakePopup(lk, e.latlng)));
    layerGroups.lakes.addLayer(poly);
  }

  // rivers
  for (const rv of D.rivers) {
    const line = rv.geom.map(p => [p[1], p[0]]);
    const style = rv.cls === "river"
      ? { color: "#3b86c6", weight: 2.6, opacity: 0.9 }
      : { color: "#4b93cf", weight: 1.5, opacity: 0.85 };
    if (rv.name) {
      const [hit, vis] = clickableLine(line, style, "vec", null, rv.name);
      layerGroups.rivers.addLayer(hit);
      layerGroups.rivers.addLayer(vis);
    } else {
      layerGroups.rivers.addLayer(L.polyline(line,
        Object.assign({ pane: "vec", interactive: false }, style)));
    }
  }

  // curated shuttle lines (computed along the road network)
  for (const rt of D.shuttles || []) {
    const [hit, vis] = clickableLine(
      rt.geom.map(p => [p[1], p[0]]),
      { color: "#c0392b", weight: 3.8, dashArray: "14 8", opacity: 0.9 },
      "shuttle",
      measureOr(e => openShuttlePopup(rt, e.latlng)),
      rt.name + "（约 " + (rt.len / 1000).toFixed(1) + " km）");
    layerGroups.shuttles.addLayer(hit);
    layerGroups.shuttles.addLayer(vis);
  }

  // ways: roads (casing + fill) and trails
  const wayLayers = [];
  const roadCasing = [];
  const roadFills = [];
  D.ways.forEach((w, idx) => {
    const latlngs = w.geom.map(p => [p[1], p[0]]);
    if (!latlngs.length) return;
    const isRoad = w.cls === "road";
    if (isRoad) {
      roadCasing.push(L.polyline(latlngs, {
        pane: "vec", color: "#7a4a20", weight: 6.2,
        opacity: 0.5, interactive: false, lineJoin: "round",
      }));
    }
    const [hit, vis] = clickableLine(
      latlngs, WAY_STYLE[w.cls] || WAY_STYLE.path, "vec",
      measureOr(e => openWayPopup(idx, e.latlng)),
      w.name || null);
    wayLayers[idx] = vis;
    if (isRoad) roadFills.push(hit, vis);
    else {
      layerGroups.trails.addLayer(hit);
      layerGroups.trails.addLayer(vis);
    }
  });
  // casings first so road fills draw above them
  for (const c of roadCasing) layerGroups.roads.addLayer(c);
  for (const f of roadFills) layerGroups.roads.addLayer(f);

  // POI markers
  const poiMarkers = [];
  D.pois.forEach((p, i) => {
    const icon = L.divIcon({
      className: "poi-icon",
      html: '<div class="poi-pin ' + (ICONS[p.cat] ? p.cat : "info") + '">' +
        (ICONS[p.cat] || ICONS.info) + "</div>",
      iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -26],
    });
    const m = L.marker([p.y, p.x], { icon, pane: "vec" });
    m.bindTooltip(p.name, { direction: "top", offset: [0, -20] });
    m.on("click", measureOr(e => openPoiPopup(i, e.latlng)));
    poiMarkers[i] = m;
    layerGroups.pois.addLayer(m);
  });

  for (const key of Object.keys(layerGroups)) {
    if (key !== "hill") layerGroups[key].addTo(map);
  }

  // ---------------- highlight ----------------
  let highlightLine = null;
  function highlightWay(idx) {
    if (highlightLine) map.removeLayer(highlightLine);
    const w = D.ways[idx];
    if (!w) return;
    highlightLine = L.polyline(w.geom.map(p => [p[1], p[0]]), {
      pane: "vec", color: "#d33", weight: 7, opacity: 0.55, interactive: false,
    }).addTo(map);
  }

  // ---------------- A/B + route drawing ----------------
  const abIcons = {
    A: L.divIcon({ className: "poi-icon", html: '<div class="ab-marker">A</div>', iconSize: [30, 30], iconAnchor: [15, 15] }),
    B: L.divIcon({ className: "poi-icon", html: '<div class="ab-marker b">B</div>', iconSize: [30, 30], iconAnchor: [15, 15] }),
  };
  let markerA = null, markerB = null, routeLine = null, hoverMarker = null;
  const wpMarkers = [];

  function waypointIcon(n) {
    return L.divIcon({
      className: "poi-icon",
      html: '<div class="ab-marker w">' + n + "</div>",
      iconSize: [30, 30], iconAnchor: [15, 15],
    });
  }

  function placeAB(which, x, y) {
    const ll = [y, x];
    if (which === "A") {
      if (markerA) map.removeLayer(markerA);
      markerA = L.marker(ll, { icon: abIcons.A, pane: "vec", zIndexOffset: 500 }).addTo(map);
    } else {
      if (markerB) map.removeLayer(markerB);
      markerB = L.marker(ll, { icon: abIcons.B, pane: "vec", zIndexOffset: 500 }).addTo(map);
    }
  }

  function placeWaypoints(list) {
    // list: [{x, y}, ...] numbered from 1
    wpMarkers.forEach(m => map.removeLayer(m));
    wpMarkers.length = 0;
    list.forEach((w, i) => {
      const m = L.marker([w.y, w.x], {
        icon: waypointIcon(i + 1), pane: "vec", zIndexOffset: 480,
      }).addTo(map);
      wpMarkers.push(m);
    });
  }

  function clearAB() {
    if (markerA) { map.removeLayer(markerA); markerA = null; }
    if (markerB) { map.removeLayer(markerB); markerB = null; }
    placeWaypoints([]);
    clearRoute();
  }
  function drawRoute(lineKm) {
    clearRoute();
    routeLine = L.polyline(lineKm.map(p => [p[1], p[0]]), {
      pane: "vec", color: "#d35400", weight: 6, opacity: 0.82, lineJoin: "round",
    }).addTo(map);
    routeLine.bringToFront();
  }
  function clearRoute() {
    if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
    hideProfileMarker();
  }
  function showProfileMarker(x, y) {
    if (!hoverMarker) {
      hoverMarker = L.circleMarker([y, x], {
        pane: "vec", radius: 7, color: "#fff", weight: 2.5,
        fillColor: "#b4552d", fillOpacity: 1,
      }).addTo(map);
    } else {
      hoverMarker.setLatLng([y, x]);
    }
  }
  function hideProfileMarker() {
    if (hoverMarker) { map.removeLayer(hoverMarker); hoverMarker = null; }
  }

  // ---------------- popups ----------------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g,
      c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  /** lake popup: water level + surface area (shoelace on the ring) */
  function openLakePopup(lk, latlng) {
    const ring = (lk.geom && lk.geom[0]) || [];
    let area2 = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      area2 += a[0] * b[1] - b[0] * a[1];
    }
    const areaKm2 = Math.abs(area2) / 2; // km units
    const eShore = ring.length ? geo.elevAtKm(ring[0][0], ring[0][1]) : 0;
    const el = document.createElement("div");
    el.innerHTML =
      '<div class="popup-title">' + esc(lk.name || "未命名湖泊") + "</div>" +
      '<span class="popup-tag blue">湖泊</span>' +
      '<div class="popup-row">' +
      '<span class="popup-metric">水面高程 <b>' + (eShore - K.app.eOff()).toFixed(0) + " m</b></span>" +
      '<span class="popup-metric">面积 <b>' +
      (areaKm2 >= 1 ? areaKm2.toFixed(2) + " km²" : (areaKm2 * 1e6).toFixed(0) + " m²") +
      "</b></span></div>";
    L.popup({ maxWidth: 280 }).setLatLng(latlng).setContent(el).openOn(map);
  }

  function openWayPopup(idx, latlng) {
    const w = D.ways[idx];
    highlightWay(idx);
    const el = document.createElement("div");
    el.innerHTML =
      '<div class="popup-title">' + esc(w.name || "未命名" + (CLS_NAME[w.cls] || "路线")) + "</div>" +
      '<span class="popup-tag">' + esc(CLS_NAME[w.cls] || w.cls) + "</span>" +
      '<div class="popup-row">' +
      '<span class="popup-metric">长度 <b>' + K.router.fmtDist(w.len) + "</b></span>" +
      '<span class="popup-metric">爬升 <b>' + Math.round(w.ascent) + " m</b></span>" +
      '<span class="popup-metric">下降 <b>' + Math.round(w.descent) + " m</b></span></div>" +
      '<div class="popup-row"><span class="popup-metric">高程范围 <b>' +
      (w.minE - K.app.eOff()).toFixed(0) + " ~ " + (w.maxE - K.app.eOff()).toFixed(0) + " m</b></span></div>" +
      '<canvas class="popup-mini-canvas"></canvas>' +
      '<div class="popup-btn-row">' +
      '<button class="popup-btn primary" data-act="profile">查看高程图</button>' +
      '<button class="popup-btn" data-act="a">设为 A</button>' +
      '<button class="popup-btn" data-act="b">设为 B</button></div>';
    const cv = el.querySelector("canvas");
    setTimeout(() => K.chart.mini(cv, w.d.map((d, i) => [d, w.e[i]]), K.app.eOff()), 30);
    el.addEventListener("click", ev => {
      const act = ev.target.getAttribute("data-act");
      if (act === "profile") K.app.showWayProfile(idx);
      else if (act === "a") K.app.setPoint("A", w.geom[0][0], w.geom[0][1], true);
      else if (act === "b") K.app.setPoint("B", w.geom[w.geom.length - 1][0], w.geom[w.geom.length - 1][1], true);
    });
    L.popup({ maxWidth: 320 }).setLatLng(latlng).setContent(el).openOn(map);
  }

  /** shuttle line popup: stop sequence + profile + photo spots along the line */
  function openShuttlePopup(rt, latlng) {
    const el = document.createElement("div");
    const stopsHtml = (rt.stops || []).map(s =>
      '<li><span class="stop-name" data-x="' + s.x + '" data-y="' + s.y + '">' + esc(s.name) +
      '</span><span class="stop-meta">' + (s.dist / 1000).toFixed(1) + ' km · ' +
      (s.e - K.app.eOff()).toFixed(0) + ' m</span></li>').join("");
    const spotsHtml = (rt.spots || []).slice(0, 12).map(s =>
      '<li><span class="stop-name" data-x="' + s.x + '" data-y="' + s.y + '">📍 ' + esc(s.name) +
      '</span><span class="stop-meta">' + (s.dist / 1000).toFixed(1) + ' km · ' +
      (s.e - K.app.eOff()).toFixed(0) + ' m</span></li>').join("");
    el.innerHTML =
      '<div class="popup-title">' + esc(rt.name) + '</div>' +
      '<span class="popup-tag blue">景区区间车线路</span>' +
      '<div class="popup-row"><span class="popup-metric">全程 <b>' +
      K.router.fmtDist(rt.len) + '</b></span>' +
      '<span class="popup-metric">停靠站 <b>' + (rt.stops || []).length + '</b></span>' +
      '<span class="popup-metric">沿线机位 <b>' + (rt.spots || []).length + '</b></span></div>' +
      '<canvas class="popup-mini-canvas"></canvas>' +
      (stopsHtml ? '<div class="stop-head">停靠站序（点击定位）</div><ul class="stop-list">' + stopsHtml + '</ul>' : "") +
      (spotsHtml ? '<div class="stop-head">沿线机位</div><ul class="stop-list">' + spotsHtml + '</ul>' : "") +
      '<div class="popup-btn-row"><button class="popup-btn primary" data-act="plan">沿线规划步行</button></div>';
    const cv = el.querySelector("canvas");
    setTimeout(() => {
      if (rt.d && rt.d.length > 1) {
        K.chart.mini(cv, rt.d.map((d, i) => [d, rt.e[i]]), K.app.eOff());
      }
    }, 30);
    el.addEventListener("click", ev => {
      const act = ev.target.getAttribute("data-act");
      if (act === "plan") {
        const a = rt.geom[0], b = rt.geom[rt.geom.length - 1];
        K.app.setPoint("A", a[0], a[1]);
        K.app.setPoint("B", b[0], b[1]);
      }
      const sx = ev.target.getAttribute("data-x");
      if (sx !== null) {
        const x = parseFloat(sx), y = parseFloat(ev.target.getAttribute("data-y"));
        map.flyTo([y, x], 14);
      }
    });
    L.popup({ maxWidth: 360 }).setLatLng(latlng).setContent(el).openOn(map);
  }

  function openPoiPopup(i, latlng) {
    const p = D.pois[i];
    const el = document.createElement("div");
    el.innerHTML =
      '<div class="popup-title">' + esc(p.name) + "</div>" +
      '<span class="popup-tag ' + (p.cat === "photo" ? "" : "blue") + '">' +
      esc(CAT_NAME[p.cat] || p.cat) + "</span>" +
      '<div class="popup-row"><span class="popup-metric">相对高程 <b>' +
      (p.e - K.app.eOff()).toFixed(1) + " m</b></span>" +
      '<span class="popup-metric">坐标 <b>' + p.lat.toFixed(4) + ", " + p.lon.toFixed(4) + "</b></span></div>" +
      (p.desc ? '<div class="popup-desc">' + esc(p.desc) + "</div>" : "") +
      (p.tip ? '<div class="popup-tip">📷 ' + esc(p.tip) + "</div>" : "") +
      '<div class="popup-btn-row">' +
      '<button class="popup-btn primary" data-act="a">设为 A</button>' +
      '<button class="popup-btn" data-act="b">设为 B</button>' +
      '<button class="popup-btn" data-act="zero">设 0 基准</button></div>';
    el.addEventListener("click", ev => {
      const act = ev.target.getAttribute("data-act");
      if (act === "a") K.app.setPoint("A", p.x, p.y, true);
      else if (act === "b") K.app.setPoint("B", p.x, p.y, true);
      else if (act === "zero") K.app.setZero(p.e);
    });
    L.popup({ maxWidth: 320 }).setLatLng(latlng).setContent(el).openOn(map);
  }

  // ---------------- scale bar ----------------
  const SCALE_STEPS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
  function updateScaleBar() {
    const mPerPx = 1000 / Math.pow(2, map.getZoom());
    let chosen = SCALE_STEPS[0], px = 0;
    for (const s of SCALE_STEPS) {
      const p = s / mPerPx;
      if (p <= 130) { chosen = s; px = p; }
    }
    px = Math.max(28, px);
    document.getElementById("scale-fill").style.width = px + "px";
    document.getElementById("scale-label").textContent =
      chosen >= 1000 ? (chosen / 1000) + " km" : chosen + " m";
  }
  map.on("zoomend", updateScaleBar);
  updateScaleBar();

  // ---------------- status bar ----------------
  map.on("mousemove", e => {
    const ll = geo.toLatLon(e.latlng.lng, e.latlng.lat);
    const elev = geo.elevAt(ll[0], ll[1]);
    document.getElementById("status-coord").innerHTML =
      ll[0].toFixed(5) + "°N, " + ll[1].toFixed(5) + "°E";
    document.getElementById("status-elev").innerHTML =
      elev === null ? "高程 —" : "相对高程 <b>" + (elev - K.app.eOff()).toFixed(0) + " m</b>";
  });

  map.on("click", e => {
    if (Date.now() < suppressClick) return;
    if (K.app && K.app.handleMapClick) {
      const ll = geo.toLatLon(e.latlng.lng, e.latlng.lat);
      K.app.handleMapClick(ll[0], ll[1], e.latlng, e.originalEvent);
    }
  });

  // ---------------- API ----------------
  K.mapApi = {
    map,
    layerGroups,
    WAY_STYLE, CLS_NAME, CAT_NAME, ICONS,
    placeAB, placeWaypoints, clearAB, drawRoute, clearRoute,
    showProfileMarker, hideProfileMarker,
    highlightWay,
    openWayPopup, openPoiPopup,
    updateScaleBar,
    flyToKm(x, y, zoom) {
      map.flyTo([y, x], zoom === undefined ? Math.max(map.getZoom(), 12) : zoom);
    },
    flyToLL(lat, lon, zoom) {
      const km = geo.toKm(lat, lon);
      map.flyTo([km[1], km[0]], zoom === undefined ? Math.max(map.getZoom(), 12) : zoom);
    },
    poiMarker(i) { return poiMarkers[i]; },
  };
})();
