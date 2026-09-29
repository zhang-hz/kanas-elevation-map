# -*- coding: utf-8 -*-
"""Process OSM + DEM into the interactive web map dataset (kanas_data.js).

Outputs:
  web/data/kanas_data.js   - all vector data, network graph, profiles, DEM grid
  web/data/hillshade.png   - shaded-relief background (hypsometric + hillshade)
"""
import base64
import heapq
import json
import math
import os
import re
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OSM_DIR = os.path.join(ROOT, "data", "osm")
DEM_NPZ = os.path.join(ROOT, "data", "dem", "dem_z13.npz")
CURATED = os.path.join(ROOT, "data", "curated.json")
WEB_DATA = os.path.join(ROOT, "web", "data")
OUT_JS = os.path.join(WEB_DATA, "kanas_data.js")
OUT_HS = os.path.join(WEB_DATA, "hillshade.png")

# ---- local equirectangular projection (km), scale-uniform = map scale is true
LAT0, LON0 = 48.70, 87.10
M_PER_DEG_LAT = 111203.9
M_PER_DEG_LON = 73610.1
R_EARTH = 6371008.8

SAMPLE_STEP = 6.0  # m between elevation samples along ways


def clean_name(n):
    """strip invisible chars and non-Chinese/Latin script tails (Kazakh/Mongolian etc.)"""
    if not n:
        return ""
    n = re.sub(r"[​-‏‪-‮﻿]", "", n)
    n = re.split(r"[؀-ۿݐ-ݿ᠀-᢯Ѐ-ӿ]"
                 r"[؀-ۿݐ-ݿ᠀-᢯Ѐ-ӿ\s​-‏]*", n)[0]
    return n.strip(" 	·,-—、")


def to_km(lat, lon):
    return ((lon - LON0) * M_PER_DEG_LON / 1000.0,
            (lat - LAT0) * M_PER_DEG_LAT / 1000.0)


def haversine(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_EARTH * math.asin(math.sqrt(a))


def cumdist(coords):
    ds = [0.0]
    for i in range(1, len(coords)):
        ds.append(ds[-1] + haversine(coords[i - 1][0], coords[i - 1][1],
                                     coords[i][0], coords[i][1]))
    return ds


def interp_at(coords, ds, d):
    """lat/lon at cumulative distance d along coords."""
    if d <= 0:
        return coords[0]
    if d >= ds[-1]:
        return coords[-1]
    lo, hi = 0, len(ds) - 1
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if ds[mid] <= d:
            lo = mid
        else:
            hi = mid
    seg = ds[hi] - ds[lo]
    t = 0.0 if seg == 0 else (d - ds[lo]) / seg
    return (coords[lo][0] + (coords[hi][0] - coords[lo][0]) * t,
            coords[lo][1] + (coords[hi][1] - coords[lo][1]) * t)


class Dem:
    def __init__(self, path):
        z = np.load(path)
        self.elev = z["elev"].astype(np.float32)
        self.north = float(z["north"])
        self.south = float(z["south"])
        self.west = float(z["west"])
        self.east = float(z["east"])
        self.h, self.w = self.elev.shape

    def rowcol(self, lat, lon):
        c = (lon - self.west) / (self.east - self.west) * self.w - 0.5
        r = (self.north - lat) / (self.north - self.south) * self.h - 0.5
        return r, c

    def sample(self, lat, lon):
        r, c = self.rowcol(lat, lon)
        if r < 0 or c < 0 or r > self.h - 1 or c > self.w - 1:
            return float("nan")
        r0, c0 = int(math.floor(r)), int(math.floor(c))
        r1, c1 = min(r0 + 1, self.h - 1), min(c0 + 1, self.w - 1)
        fr, fc = r - r0, c - c0
        e00, e01 = self.elev[r0, c0], self.elev[r0, c1]
        e10, e11 = self.elev[r1, c0], self.elev[r1, c1]
        top = e01 * fc + e00 * (1 - fc)
        bot = e11 * fc + e10 * (1 - fc)
        return float(top * fr + bot * (1 - fr))


# ---------------- OSM loading ----------------

def load_osm(name):
    path = os.path.join(OSM_DIR, f"{name}.json")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return json.load(f).get("elements", [])


def chain_rings(segments):
    """Chain line segments into closed rings (lat/lon lists)."""
    segs = [list(s) for s in segments if len(s) >= 2]
    rings = []
    while segs:
        ring = segs.pop(0)
        progress = True
        while progress and ring[0] != ring[-1]:
            progress = False
            for i, s in enumerate(segs):
                if s[0] == ring[-1]:
                    ring += s[1:]
                elif s[-1] == ring[-1]:
                    ring += list(reversed(s[:-1]))
                elif s[-1] == ring[0]:
                    ring = s[:-1] + ring
                elif s[0] == ring[0]:
                    ring = list(reversed(s[1:])) + ring
                else:
                    continue
                segs.pop(i)
                progress = True
                break
        if len(ring) >= 4:
            rings.append(ring)
    return rings


ROAD_TYPES = {"motorway", "trunk", "primary", "secondary", "tertiary",
              "unclassified", "residential", "living_street", "service",
              "motorway_link", "trunk_link", "primary_link",
              "secondary_link", "tertiary_link"}
PATH_TYPES = {"path", "footway", "pedestrian", "bridleway", "cycleway"}


def classify_highway(tags):
    hw = tags.get("highway")
    surface = tags.get("surface", "")
    material = tags.get("material", "")
    board = (surface in ("boardwalk", "wood") or material == "wood"
             or tags.get("boardwalk") == "yes" or tags.get("bridge") == "boardwalk")
    if hw == "steps":
        return "steps"
    if hw in PATH_TYPES:
        return "boardwalk" if board else "path"
    if hw == "track":
        return "track"
    if hw in ROAD_TYPES:
        return "road"
    return None


def smooth_profile(e, win=3):
    if len(e) < win:
        return list(e)
    arr = np.convolve(np.asarray(e, dtype=np.float64),
                      np.ones(win) / win, mode="same")
    arr[0], arr[-1] = e[0], e[-1]
    return [float(v) for v in arr]


def main():
    inspect = "--inspect" in sys.argv
    print("loading OSM ...")
    hw_els = load_osm("highways")
    wa_els = load_osm("water")
    po_els = load_osm("pois")
    rt_els = load_osm("routes")

    nodes = {}
    ways = {}
    rels = []
    for els in (hw_els, wa_els, po_els, rt_els):
        for e in els:
            if e["type"] == "node":
                nodes[e["id"]] = (e["lat"], e["lon"], e.get("tags", {}))
            elif e["type"] == "way":
                ways[e["id"]] = e
            elif e["type"] == "relation":
                rels.append(e)

    print(f"nodes={len(nodes)} ways={len(ways)} relations={len(rels)}")

    if inspect:
        named = []
        for e in list(nodes.values()):
            pass
        for els in (po_els,):
            for e in els:
                t = e.get("tags", {})
                nm = t.get("name") or t.get("name:zh")
                if not nm:
                    continue
                lat = e.get("lat") or e.get("center", {}).get("lat")
                lon = e.get("lon") or e.get("center", {}).get("lon")
                if lat is None and e.get("nodes"):
                    lat = nodes.get(e["nodes"][0], (None, None))[0]
                    lon = nodes.get(e["nodes"][0], (None, None))[1]
                if lat is not None:
                    named.append((nm, t.get("highway") or t.get("tourism") or
                                  t.get("amenity") or t.get("place") or
                                  t.get("natural") or "", float(lat), float(lon)))
        for nm, typ, lat, lon in sorted(named):
            print(f"POI  {lat:.5f} {lon:.5f}  {typ:12s}  {nm}")
        print("---- named highways ----")
        for w in ways.values():
            t = w.get("tags", {})
            if t.get("highway") and (t.get("name") or t.get("ref")):
                nds = w.get("nodes") or []
                c = nodes.get(nds[0], (None, None))
                print(f"WAY  {c[0]} {c[1]}  {t.get('highway'):10s}  "
                      f"{t.get('name') or t.get('ref')}")
        return

    curated = {}
    if os.path.exists(CURATED):
        with open(CURATED, encoding="utf-8") as f:
            curated = json.load(f)

    dem = Dem(DEM_NPZ)
    print(f"DEM {dem.h}x{dem.w}  {dem.south:.3f}..{dem.north:.3f}N  "
          f"{dem.west:.3f}..{dem.east:.3f}E")

    # ---- trim helpers: OSM route relations pull in ways far outside the area,
    #      keep only the part inside the DEM/map extent ----
    BB = (dem.south, dem.west, dem.north, dem.east)

    def node_in_bb(n):
        p = nodes.get(n)
        return p is not None and BB[0] <= p[0] <= BB[2] and BB[1] <= p[1] <= BB[3]

    def trim_way_nodes(nds):
        """first/last index of nodes inside bbox; None if no node inside."""
        inside = [i for i, n in enumerate(nds) if node_in_bb(n)]
        if not inside:
            return None
        return nds[inside[0]:inside[-1] + 1]

    def fill_nan(elevs):
        valid = [i for i, e in enumerate(elevs) if math.isfinite(e)]
        if not valid:
            return None
        out = list(elevs)
        for i in range(len(out)):
            if not math.isfinite(out[i]):
                lo = max((j for j in valid if j < i), default=valid[0])
                hi = min((j for j in valid if j > i), default=valid[-1])
                span = hi - lo
                t = 0.0 if span == 0 else (i - lo) / span
                out[i] = out[lo] + (out[hi] - out[lo]) * t
        return out

    # ---- datum (visitor center, 0 m) ----
    dat = curated.get("datum") or {}
    dlat = float(dat.get("lat", 48.5068))
    dlon = float(dat.get("lon", 87.1271))
    dname = dat.get("name", "喀纳斯游客中心")
    e0 = dem.sample(dlat, dlon)
    print(f"datum: {dname} at {dlat:.5f},{dlon:.5f}  abs elev {e0:.1f} m")
    if not math.isfinite(e0):
        raise SystemExit("datum elevation invalid")

    def rel(e):
        return e - e0

    # ---- highways: geometry + profile + graph ----
    print("building highway features ...")
    ways_out = []
    way_index_of = {}
    trimmed_nodes = {}
    for wid, w in sorted(ways.items()):
        t = w.get("tags", {})
        cls = classify_highway(t)
        if cls is None:
            continue
        nds = trim_way_nodes(w.get("nodes") or [])
        if not nds:
            continue
        trimmed_nodes[wid] = nds
        coords = [nodes[n][:2] for n in nds if n in nodes]
        if len(coords) < 2:
            continue
        ds = cumdist(coords)
        total = ds[-1]
        if total < 5:
            continue
        # sample profile
        targets = {0.0, total}
        n = max(1, int(total // SAMPLE_STEP))
        for i in range(n + 1):
            targets.add(min(total, i * total / n))
        targets.update(ds)
        tsorted = sorted(targets)
        samples = []
        for d in tsorted:
            la, lo = interp_at(coords, ds, d)
            samples.append((d, la, lo))
        elevs = fill_nan([dem.sample(la, lo) for _, la, lo in samples])
        if elevs is None:
            continue
        # roads cut into steep slopes make the raw DEM profile step; smooth harder
        win = 5 if cls in ("road", "track") else 3
        sm = smooth_profile([rel(e) for e in elevs], win=win)
        diffs = [sm[i + 1] - sm[i] for i in range(len(sm) - 1)]
        ascent = sum(d for d in diffs if d > 0)
        descent = -sum(d for d in diffs if d < 0)
        idx = len(ways_out)
        way_index_of[wid] = idx
        ways_out.append({
            "id": wid,
            "cls": cls,
            "name": t.get("name") or "",
            "ref": t.get("ref") or "",
            "surface": t.get("surface") or "",
            "len": round(total, 1),
            "ascent": round(ascent, 1),
            "descent": round(descent, 1),
            "minE": round(min(sm), 1),
            "maxE": round(max(sm), 1),
            # geometry: exact OSM vertices (no positional drift)
            "geom": [[round(x, 4), round(y, 4)] for x, y in
                     (to_km(la, lo) for la, lo in coords)],
            "geomLL": [[round(la, 6), round(lo, 6)] for la, lo in coords],
            "d": [round(d, 1) for d, _, _ in samples],
            "e": [round(v, 1) for v in sm],
        })

    # ---- network graph (over highway ways) ----
    print("building routing graph ...")
    nid2i = {}
    g_nodes = []
    g_edges = []

    def gnode(nid):
        if nid not in nid2i:
            la, lo = nodes[nid][:2]
            x, y = to_km(la, lo)
            nid2i[nid] = len(g_nodes)
            g_nodes.append([round(x, 4), round(y, 4), round(rel(dem.sample(la, lo)), 1)])
        return nid2i[nid]

    for wid, w in ways.items():
        if wid not in way_index_of:
            continue
        idx = way_index_of[wid]
        nds = trimmed_nodes.get(wid) or []
        nds = [n for n in nds if n in nodes]
        if len(nds) < 2:
            continue
        ds = cumdist([nodes[n][:2] for n in nds])
        for i in range(len(nds) - 1):
            u, v = gnode(nds[i]), gnode(nds[i + 1])
            length = ds[i + 1] - ds[i]
            if length <= 0:
                continue
            g_edges.append([u, v, idx, round(ds[i], 1), round(ds[i + 1], 1),
                            round(length, 1), 0, 0])

    # elevation at edge endpoints from node elevations
    for ed in g_edges:
        ed[6] = g_nodes[ed[0]][2]
        ed[7] = g_nodes[ed[1]][2]

    # ---- bridge unmapped gaps: connect dangling ends so trails read & route continuous ----
    deg = [0] * len(g_nodes)
    for ed in g_edges:
        deg[ed[0]] += 1
        deg[ed[1]] += 1

    def gdist(a, b):
        return math.hypot(g_nodes[a][0] - g_nodes[b][0],
                          g_nodes[a][1] - g_nodes[b][1]) * 1000.0

    def add_link(a, b, cls, name):
        idx = len(ways_out)
        dd = gdist(a, b)
        ways_out.append({
            "id": -1000 - idx,
            "cls": cls,
            "name": name or "连接线",
            "ref": "",
            "surface": "",
            "len": round(dd, 1),
            "ascent": 0.0,
            "descent": 0.0,
            "minE": round(min(g_nodes[a][2], g_nodes[b][2]), 1),
            "maxE": round(max(g_nodes[a][2], g_nodes[b][2]), 1),
            "geom": [[g_nodes[a][0], g_nodes[a][1]], [g_nodes[b][0], g_nodes[b][1]]],
            "geomLL": [],
            "d": [0.0, round(dd, 1)],
            "e": [g_nodes[a][2], g_nodes[b][2]],
        })
        g_edges.append([a, b, idx, 0.0, round(dd, 1), round(dd, 1),
                        g_nodes[a][2], g_nodes[b][2]])
        return idx

    orig_edges = len(g_edges)
    edge_geo = []
    for ed in g_edges[:orig_edges]:
        a, b = g_nodes[ed[0]], g_nodes[ed[1]]
        edge_geo.append((a[0], a[1], b[0], b[1]))

    def proj_on_edge(px, py, eidx):
        ax, ay, bx, by = edge_geo[eidx]
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
        qx, qy = ax + t * dx, ay + t * dy
        return t, math.hypot(px - qx, py - qy), qx, qy

    def free_end_dir(i):
        for k in range(orig_edges):
            ed = g_edges[k]
            if ed[2] == -1:
                continue
            if ed[0] == i or ed[1] == i:
                nb = ed[1] if ed[0] == i else ed[0]
                vx, vy = g_nodes[i][0] - g_nodes[nb][0], g_nodes[i][1] - g_nodes[nb][1]
                ln = math.hypot(vx, vy) or 1e-9
                return vx / ln, vy / ln
        return 1.0, 0.0

    def src_way_of(i):
        for k in range(orig_edges):
            ed = g_edges[k]
            if ed[2] != -1 and (ed[0] == i or ed[1] == i):
                return ed[2]
        return None

    # Tier 1: trail continuations (fills 1-150 m mapping gaps between fragments;
    # drawn in the source way's style so trails read as continuous)
    n_t1 = 0
    for i in range(len(g_nodes)):
        if deg[i] != 1:
            continue
        dirx, diry = free_end_dir(i)
        best = None
        px0, py0 = g_nodes[i][0], g_nodes[i][1]
        src_w0 = src_way_of(i)
        src_cls = ways_out[src_w0]["cls"] if src_w0 is not None else "path"
        TRAIL = {"path", "boardwalk", "steps"}
        for eidx in range(orig_edges):
            ed = g_edges[eidx]
            if ed[2] == -1 or ed[0] == i or ed[1] == i:
                continue
            if ways_out[ed[2]]["cls"] == "link":
                continue
            t, dd_km, qx, qy = proj_on_edge(px0, py0, eidx)
            dd = dd_km * 1000.0  # proj_on_edge works in km; thresholds are metres
            if dd > 220 or dd < 1:
                continue
            lx, ly = (qx - px0) / dd_km, (qy - py0) / dd_km
            if lx * dirx + ly * diry < 0.25:  # source side: >75 deg off = not a continuation
                continue
            tg = edge_geo[eidx]
            tx, ty = tg[2] - tg[0], tg[3] - tg[1]
            tln = math.hypot(tx, ty) or 1e-9
            align = abs((tx / tln) * lx + (ty / tln) * ly)
            if align < 0.35:  # target side: link must arrive roughly along the way
                continue
            tgt_cls = ways_out[ed[2]]["cls"]
            if src_cls == tgt_cls:
                pen = 0
            elif (src_cls in TRAIL) == (tgt_cls in TRAIL):
                pen = 150
            else:
                pen = 400
            score = dd + pen + 40 * (1 - align)
            if best is None or score < best[0]:
                best = (score, eidx, dd, t, qx, qy)
        if not best:
            continue
        score, eidx, dd, t, qx, qy = best
        ed = g_edges[eidx]
        way_i = ed[2]
        d0, d1 = ed[3], ed[4]
        new_node = len(g_nodes)
        e0n, e1n = g_nodes[ed[0]][2], g_nodes[ed[1]][2]
        g_nodes.append([round(qx, 5), round(qy, 5), round(e0n + (e1n - e0n) * t, 2)])
        g_edges.append([ed[0], new_node, way_i, d0, round(d0 + (d1 - d0) * t, 1),
                        round(ed[5] * t, 1), ed[6], g_nodes[new_node][2]])
        g_edges.append([new_node, ed[1], way_i, round(d0 + (d1 - d0) * t, 1), d1,
                        round(ed[5] * (1 - t), 1), g_nodes[new_node][2], ed[7]])
        ed[2] = -1  # retire the original
        src_w = src_way_of(i)
        link_cls = ways_out[src_w]["cls"] if src_w is not None else "path"
        link_name = ways_out[src_w]["name"] if src_w is not None else ""
        add_link(i, new_node, link_cls, link_name)
        n_t1 += 1
        if n_t1 >= 400:
            break
    g_edges = [e for e in g_edges if e[2] != -1]
    print(f"tier-1 trail-continuation links: {n_t1}")

    # Tier 2: bigger gaps between disconnected components (marked as inferred)
    parent = list(range(len(g_nodes)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for ed in g_edges:
        ra, rb = find(ed[0]), find(ed[1])
        if ra != rb:
            parent[ra] = rb
    comp_size = {}
    for i in range(len(g_nodes)):
        r = find(i)
        comp_size[r] = comp_size.get(r, 0) + 1
    deg2 = [0] * len(g_nodes)
    for ed in g_edges:
        deg2[ed[0]] += 1
        deg2[ed[1]] += 1
    ends = [i for i, d in enumerate(deg2) if d == 1]
    pairs = []
    for ii in range(len(ends)):
        for jj in range(ii + 1, len(ends)):
            a, b = ends[ii], ends[jj]
            if find(a) == find(b):
                continue
            dd = gdist(a, b)
            if 1 <= dd < 1200 and min(comp_size.get(find(a), 0), comp_size.get(find(b), 0)) >= 15:
                pairs.append((dd, a, b))
    pairs.sort()
    n_t2 = 0
    for dd, a, b in pairs:
        if find(a) == find(b) or n_t2 >= 25:
            continue
        add_link(a, b, "link", "数据缺口连接（地图数据未覆盖）")
        ra, rb = find(a), find(b)
        parent[ra] = rb
        n_t2 += 1
    print(f"tier-2 gap links: {n_t2}")

    # ---- curated shuttle lines: road-preferred shortest paths on the graph ----
    SHUTTLE_PAIRS = [
        ("1路：贾登峪游服中心 ↔ 喀纳斯游服中心（主线）",
         (48.50679, 87.12714), (48.69189, 87.02648)),
        ("观鱼台线：喀纳斯游服中心 ↔ 观鱼台换乘中心",
         (48.69189, 87.02648), (48.71901, 86.99140)),
        ("湖边线：喀纳斯游服中心 ↔ 湖边2号停车场（双湖码头）",
         (48.69189, 87.02648), (48.71496, 87.02532)),
        ("一道湾线：喀纳斯游服中心 ↔ 一道湾停车场",
         (48.69189, 87.02648), (48.73989, 87.01294)),
        ("新村线：喀纳斯游服中心 ↔ 喀纳斯新村",
         (48.69189, 87.02648), (48.69456, 87.00338)),
        ("喀纳斯 ↔ 白哈巴线",
         (48.69189, 87.02648), (48.69320, 86.78161)),
        ("铁热克提 ↔ 白哈巴线",
         (48.47493, 86.70095), (48.69320, 86.78161)),
        ("贾登峪 ↔ 禾木线",
         (48.50679, 87.12714), (48.57107, 87.52449)),
        ("禾木换乘线：禾木游服中心 ↔ 禾木入口服务区",
         (48.57107, 87.52449), (48.57502, 87.45894)),
        ("吉克普林接驳：禾木入口服务区 ↔ 吉克普林站",
         (48.57502, 87.45894), (48.56310, 87.53876)),
    ]
    CLS_ROAD_W = {"road": 1.0, "track": 2.2, "path": 5.0,
                  "boardwalk": 6.0, "steps": 7.0}

    def nearest_gnode(lat, lon):
        x, y = to_km(lat, lon)
        best, bd = -1, 1e18
        for i, g in enumerate(g_nodes):
            dd = (g[0] - x) ** 2 + (g[1] - y) ** 2
            if dd < bd:
                bd, best = dd, i
        return best, math.sqrt(bd) * 1000.0

    def road_shortest_path(lat1, lon1, lat2, lon2):
        s, _ = nearest_gnode(lat1, lon1)
        t, _ = nearest_gnode(lat2, lon2)
        if s < 0 or t < 0 or s == t:
            return None
        adj = {}
        for ei, ed in enumerate(g_edges):
            w = CLS_ROAD_W.get(ways_out[ed[2]]["cls"], 3.0) * ed[5]
            adj.setdefault(ed[0], []).append((ed[1], w, ei))
            adj.setdefault(ed[1], []).append((ed[0], w, ei))
        dist = {s: 0.0}
        prev = {}
        pq = [(0.0, s)]
        while pq:
            d, u = heapq.heappop(pq)
            if u == t:
                break
            if d > dist.get(u, 1e18):
                continue
            for v, w, ei in adj.get(u, ()):
                nd = d + w
                if nd < dist.get(v, 1e18):
                    dist[v] = nd
                    prev[v] = u
                    heapq.heappush(pq, (nd, v))
        if t not in dist:
            return None
        path = [t]
        while path[-1] != s:
            path.append(prev[path[-1]])
        path.reverse()
        return [(g_nodes[i][0], g_nodes[i][1]) for i in path]

    def to_latlon(x, y):
        return (y * 1000.0 / M_PER_DEG_LAT + LAT0,
                x * 1000.0 / M_PER_DEG_LON + LON0)

    def proj_on_seg(px, py, ax, ay, bx, by):
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
        qx, qy = ax + t * dx, ay + t * dy
        return t, math.hypot(px - qx, py - qy)

    def build_shuttles(pois):
        """shuttle lines with sampled elevation profile + ordered stop list"""
        out = []
        for name, (la1, lo1), (la2, lo2) in SHUTTLE_PAIRS:
            pts = road_shortest_path(la1, lo1, la2, lo2)
            if not pts:
                print(f"  shuttle not connected: {name}")
                continue
            seg = [0.0]
            for i in range(len(pts) - 1):
                seg.append(seg[-1] + math.hypot(pts[i + 1][0] - pts[i][0],
                                                pts[i + 1][1] - pts[i][1]) * 1000.0)
            total = seg[-1]
            targets = {0.0, total}
            n = max(1, int(total // SAMPLE_STEP))
            for i in range(n + 1):
                targets.add(min(total, i * total / n))
            targets.update(seg)
            d_arr, e_arr = [], []
            for d in sorted(targets):
                # position along path in km plane
                i = 0
                while i < len(seg) - 2 and seg[i + 1] < d:
                    i += 1
                span = seg[i + 1] - seg[i]
                t = 0.0 if span == 0 else (d - seg[i]) / span
                x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t
                y = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t
                la, lo = to_latlon(x, y)
                d_arr.append(round(d, 1))
                e_arr.append(round(rel(dem.sample(la, lo)), 1))
            stops, spots = [], []
            for p in pois:
                if p["cat"] not in ("station", "village", "attraction", "photo", "view"):
                    continue
                best = None
                for i in range(len(pts) - 1):
                    t, dd = proj_on_seg(p["x"], p["y"], pts[i][0], pts[i][1],
                                        pts[i + 1][0], pts[i + 1][1])
                    along = seg[i] + (seg[i + 1] - seg[i]) * t
                    if best is None or dd < best[1]:
                        best = (along, dd)
                if not best:
                    continue
                along_km, off_km = best
                if p["cat"] in ("station", "village") and off_km <= 0.15:
                    stops.append({
                        "name": p["name"],
                        "cat": p["cat"],
                        "dist": round(along_km, 0),
                        "off": round(off_km * 1000, 0),
                        "e": p["e"],
                        "x": p["x"], "y": p["y"],
                    })
                elif p["cat"] in ("photo", "view", "attraction") and off_km <= 0.35:
                    spots.append({
                        "name": p["name"],
                        "cat": p["cat"],
                        "dist": round(along_km, 0),
                        "off": round(off_km * 1000, 0),
                        "e": p["e"],
                        "x": p["x"], "y": p["y"],
                    })
            stops.sort(key=lambda s: s["dist"])
            spots.sort(key=lambda s: s["dist"])

            def dedupe(seq):
                out = []
                for s in seq:
                    if any(s["name"] == o["name"] and abs(s["dist"] - o["dist"]) < 250
                           for o in out):
                        continue
                    out.append(s)
                return out

            stops = dedupe(stops)
            spots = dedupe(spots)
            out.append({
                "name": name,
                "len": round(total, 0),
                "geom": [[round(x, 4), round(y, 4)] for x, y in pts],
                "d": d_arr,
                "e": e_arr,
                "stops": stops,
                "spots": spots,
            })
            print(f"  shuttle {name}: {total / 1000:.1f} km, "
                  f"{len(stops)} stops, {len(spots)} spots")
        return out

    # ---- water ----
    print("building water features ...")
    rivers = []
    lakes = []
    for wid, w in ways.items():
        t = w.get("tags", {})
        nds = trim_way_nodes(w.get("nodes") or []) or []
        coords = [nodes[n][:2] for n in nds if n in nodes]
        if len(coords) < 2:
            continue
        if t.get("waterway") in ("river", "stream", "ditch", "canal"):
            rivers.append({
                "cls": "river" if t.get("waterway") in ("river", "canal") else "stream",
                "name": t.get("name") or "",
                "geom": [[round(x, 4), round(y, 4)] for x, y in
                         (to_km(la, lo) for la, lo in coords)],
            })
        elif t.get("natural") == "water" or t.get("water"):
            if coords[0] == coords[-1] and len(coords) >= 4:
                lakes.append({
                    "name": t.get("name") or "",
                    "geom": [[[round(x, 4), round(y, 4)] for x, y in
                              (to_km(la, lo) for la, lo in coords)]],
                })
    for r in rels:
        t = r.get("tags", {})
        if t.get("natural") != "water" and not t.get("water"):
            continue
        outers, inners = [], []
        for m in r.get("members", []):
            if m["type"] != "way" or m["ref"] not in ways:
                continue
            w = ways[m["ref"]]
            nds = trim_way_nodes(w.get("nodes") or []) or []
            coords = [nodes[n][:2] for n in nds if n in nodes]
            if len(coords) < 2:
                continue
            (outers if m.get("role") != "inner" else inners).append(coords)
        rings = chain_rings(outers)
        rings += chain_rings(inners)
        for ring in rings:
            lakes.append({
                "name": t.get("name") or "",
                "geom": [[[round(x, 4), round(y, 4)] for x, y in
                          (to_km(la, lo) for la, lo in ring)]],
            })

    # ---- POIs ----
    print("building POIs ...")
    pois = []
    seen = set()

    def add_poi(name, cat, lat, lon, desc="", tip=""):
        name = clean_name(name) if name else ""
        key = (name or cat, round(lat, 4), round(lon, 4))
        if key in seen:
            return
        seen.add(key)
        x, y = to_km(lat, lon)
        pois.append({
            "name": name,
            "cat": cat,
            "x": round(x, 4),
            "y": round(y, 4),
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "e": round(rel(dem.sample(lat, lon)), 1),
            "desc": desc,
            "tip": tip,
        })

    # water coords (for boardwalk inference)
    water_pts = []
    for rv in rivers:
        water_pts.extend(rv["geom"])
    for lk in lakes:
        for ring in lk["geom"]:
            water_pts.extend(ring)
    # convert km coords back is unnecessary: use lat/lon from OSM instead
    water_ll = []
    for wid, w in ways.items():
        t = w.get("tags", {})
        if t.get("waterway") or t.get("natural") == "water" or t.get("water"):
            water_ll.extend(nodes[n][:2] for n in (w.get("nodes") or []) if n in nodes)
    if water_ll:
        water_arr = np.array(water_ll, dtype=np.float64)
    else:
        water_arr = np.zeros((0, 2))

    def near_water(lat, lon, limit_m=320.0):
        if not len(water_arr):
            return False
        dlat = (water_arr[:, 0] - lat) * 111204.0
        dlon = (water_arr[:, 1] - lon) * 73610.0
        d2 = dlat * dlat + dlon * dlon
        return bool(np.min(d2) < limit_m * limit_m)

    # boardwalk inference: tourist-corridor footpaths close to water
    # (OSM rarely tags surface=boardwalk here; lake/river-side walks are boardwalks)
    n_board = 0
    for info in ways_out:
        if info["cls"] not in ("path", "footway") or not info["geomLL"]:
            continue
        lat = sum(p[0] for p in info["geomLL"]) / len(info["geomLL"])
        lon = sum(p[1] for p in info["geomLL"]) / len(info["geomLL"])
        if (48.58 < lat < 48.76 and 86.96 < lon < 87.08
                and near_water(lat, lon)):
            info["cls"] = "boardwalk"
            n_board += 1
    print(f"boardwalk inferred: {n_board}")

    # curated POIs first (they carry descriptions/photo tips and override OSM)
    for p in curated.get("pois", []):
        add_poi(p.get("name", ""), p.get("cat", "photo"),
                float(p["lat"]), float(p["lon"]),
                p.get("desc", ""), p.get("tip", ""))

    for e in po_els:
        t = e.get("tags", {})
        lat = e.get("lat")
        lon = e.get("lon")
        if lat is None and e.get("nodes"):
            c = [nodes[n][:2] for n in e["nodes"] if n in nodes]
            if not c:
                continue
            lat = sum(p[0] for p in c) / len(c)
            lon = sum(p[1] for p in c) / len(c)
        if lat is None:
            continue
        name = t.get("name") or t.get("name:zh") or ""
        cat = None
        if t.get("tourism") == "viewpoint" or t.get("natural") in ("peak", "saddle"):
            cat = "view"
        elif t.get("highway") == "bus_stop" or t.get("amenity") == "bus_station" \
                or t.get("public_transport") in ("station", "platform", "stop_position"):
            cat = "station"
        elif t.get("place") in ("village", "hamlet", "town", "suburb"):
            cat = "village"
        elif t.get("tourism") in ("guest_house", "alpine_hut", "hotel", "hostel",
                                  "camp_site", "apartment", "chalet"):
            cat = "stay"
        elif t.get("tourism") in ("attraction", "artwork", "gallery", "museum"):
            cat = "attraction"
        elif t.get("tourism") == "information" or t.get("information"):
            cat = "info"
        elif t.get("amenity") in ("parking", "restaurant", "cafe", "toilets",
                                  "shelter", "drinking_water"):
            cat = "service"
        elif t.get("barrier") == "gate":
            cat = "gate"
        if cat is None:
            continue
        if cat in ("stay", "service", "gate") and not name:
            continue
        if cat == "stay" and not name:
            continue
        add_poi(name, cat, float(lat), float(lon))


    # ---- auto-naming: no unnamed / generic names may reach the UI ----
    JUNK = {"", "村庄", "地点", "地点1", "地点2", "居住点", "村", "locality", "view",
            "photo", "point", "poi", "unnamed", "未命名", "closed", "dock", "水体",
            "山", "山峰", "草原", "桥", "码头", "连接线", "连接路", "小路", "步道",
            "公路", "道路", "栈道", "trail", "path", "road", "track", "water walk"}
    CAT_CN = {"view": "观景点", "photo": "机位", "station": "停靠点", "village": "村落",
              "attraction": "景点", "info": "服务点", "service": "服务点",
              "stay": "住宿点", "gate": "出入口"}
    CLS_CN = {"road": "公路", "track": "土路", "path": "步道", "boardwalk": "栈道",
              "steps": "台阶", "link": "连接线"}
    PRIO = {"village": 0, "station": 1, "attraction": 2, "photo": 3, "view": 4,
            "info": 5, "service": 6, "stay": 7, "gate": 8}

    def junky(n):
        if not n or n.strip() in JUNK:
            return True
        low = n.strip().lower()
        return low.startswith("static") or low in ("view", "dock", "closed")

    def compass(dx, dy):
        names = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"]
        ang = math.degrees(math.atan2(dx, dy))
        return names[int((ang + 22.5) // 45) % 8]

    anchors = []
    for p in pois:
        p["name"] = clean_name(p["name"])
        if not junky(p["name"]):
            anchors.append((p["name"], p["x"], p["y"], PRIO.get(p["cat"], 5)))
    for lk in lakes:
        lk["name"] = clean_name(lk.get("name", ""))
        if lk.get("name") and not junky(lk["name"]) and lk["geom"] and lk["geom"][0]:
            ring = lk["geom"][0]
            cx = sum(q[0] for q in ring) / len(ring)
            cy = sum(q[1] for q in ring) / len(ring)
            anchors.append((lk["name"], cx, cy, 3))
    for rv in rivers:
        rv["name"] = clean_name(rv.get("name", ""))
        if rv.get("name") and not junky(rv["name"]) and rv["geom"]:
            mid = rv["geom"][len(rv["geom"]) // 2]
            anchors.append((rv["name"], mid[0], mid[1], 4))

    def nearest_anchors(x, y, k=2, max_km=6.0):
        scored = []
        seen = set()
        for nm, ax, ay, pr in anchors:
            d = math.hypot(ax - x, ay - y)
            if d > max_km or nm in seen:
                continue
            scored.append((d, pr, nm, ax, ay))
        scored.sort(key=lambda z: (z[1], z[0]))
        out = []
        for d, pr, nm, ax, ay in scored:
            if nm in seen:
                continue
            seen.add(nm)
            out.append((nm, ax, ay, d))
            if len(out) >= k:
                break
        return out

    n_named_poi = 0
    for p in pois:
        if not junky(p["name"]):
            continue
        near = nearest_anchors(p["x"], p["y"], 1)
        cat_cn = CAT_CN.get(p["cat"], "地点")
        if near:
            nm, ax, ay, d = near[0]
            if d < 0.15:
                p["name"] = f"{nm}旁{cat_cn}"
            else:
                p["name"] = f"{nm}{compass(p['x'] - ax, p['y'] - ay)}{cat_cn}"
        else:
            p["name"] = f"喀纳斯{cat_cn}·{abs(hash((p['x'], p['y']))) % 900 + 100}"
        n_named_poi += 1

    n_named_way = 0
    for info in ways_out:
        info["name"] = clean_name(info.get("name", ""))
        if not junky(info["name"]) and info["cls"] != "link":
            continue
        if info["cls"] == "link" and info["name"].startswith("数据缺口"):
            continue
        g2 = info["geom"]
        cx = sum(q[0] for q in g2) / len(g2)
        cy = sum(q[1] for q in g2) / len(g2)
        cls_cn = CLS_CN.get(info["cls"], "小路")
        if info.get("ref"):
            info["name"] = info["ref"]
            n_named_way += 1
            continue
        near = nearest_anchors(cx, cy, 2)
        if len(near) < 2:
            near = nearest_anchors(cx, cy, 2, max_km=1e9)
        if len(near) >= 2:
            info["name"] = f"{near[0][0]}—{near[1][0]}{cls_cn}"
        elif near:
            info["name"] = f"{near[0][0]}{cls_cn}"
        else:
            info["name"] = f"喀纳斯{cls_cn}·{abs(hash(info['id'])) % 900 + 100}"
        n_named_way += 1
    print(f"auto-named: {n_named_poi} POIs, {n_named_way} ways")

    # shuttle lines with stop lists (needs the final POI set)
    print("building shuttle lines ...")
    shuttles_out = build_shuttles(pois)

    # ---- routes (bus / shuttle relations) ----
    routes_out = []
    for r in rels:
        t = r.get("tags", {})
        if not t.get("route") or t.get("route") == "waterway":
            continue
        name = t.get("name") or t.get("ref") or t.get("route")
        for m in r.get("members", []):
            if m["type"] != "way" or m["ref"] not in ways:
                continue
            w = ways[m["ref"]]
            nds = trim_way_nodes(w.get("nodes") or []) or []
            coords = [nodes[n][:2] for n in nds if n in nodes]
            if len(coords) >= 2:
                routes_out.append({
                    "name": name,
                    "geom": [[round(x, 4), round(y, 4)] for x, y in
                             (to_km(la, lo) for la, lo in coords)],
                })

    # ---- hillshade + hypsometric background ----
    print("rendering hillshade ...")
    factor = 1
    small = dem.elev[::factor, ::factor].astype(np.float32)
    sh, sw = small.shape
    pix_m = (dem.east - dem.west) / dem.w * M_PER_DEG_LON / factor
    zy, zx = np.gradient(small, pix_m)
    slope = np.arctan(np.hypot(zx, zy))
    aspect = np.arctan2(-zx, zy)
    az = math.radians(315.0)
    alt = math.radians(45.0)
    illum = (math.cos(alt) * np.cos(slope) +
             math.sin(alt) * np.sin(slope) * np.cos(az - aspect))
    illum = np.clip(illum, 0, 1)

    rel_grid = small - e0
    # hypsometric palette on relative elevation
    stops = [(-250, (26, 78, 120)), (-60, (70, 140, 160)), (0, (96, 158, 110)),
             (60, (128, 176, 96)), (180, (188, 196, 112)), (320, (206, 176, 116)),
             (480, (186, 142, 96)), (650, (150, 118, 100)), (850, (168, 160, 156)),
             (1100, (232, 230, 228))]
    shade = (0.42 + 0.58 * illum)
    xs = [s[0] for s in stops]
    rgb = np.empty((sh, sw, 3), dtype=np.float32)
    step_rows = 512
    for r0 in range(0, sh, step_rows):
        r1 = min(sh, r0 + step_rows)
        elevs_c = np.clip(rel_grid[r0:r1], stops[0][0], stops[-1][0])
        sh_blk = shade[r0:r1]
        for ch in range(3):
            vals = np.interp(elevs_c, xs, [s[1][ch] for s in stops])
            rgb[r0:r1, :, ch] = vals * sh_blk
    img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB")
    img = img.quantize(colors=256, method=Image.MEDIANCUT)
    img.save(OUT_HS, optimize=True)
    print(f"hillshade {sw}x{sh} -> {os.path.getsize(OUT_HS) // 1024} KB")

    hs_north = dem.north
    hs_west = dem.west
    hs_south = dem.north - (dem.north - dem.south) * (sh * factor) / dem.h
    hs_east = dem.west + (dem.east - dem.west) * (sw * factor) / dem.w

    # ---- client DEM grid (cursor elevation + straight profiles) ----
    print("packing client DEM grid ...")
    step = 5
    g = dem.elev[::step, ::step].astype(np.float32) - e0
    g = np.clip(np.round(g), -32000, 32000).astype("<i2")
    rows, cols = g.shape
    gwest = dem.west
    gnorth = dem.north
    gpx_deg_lat = (dem.north - dem.south) / dem.h * step
    gpx_deg_lon = (dem.east - dem.west) / dem.w * step
    values_b64 = base64.b64encode(g.tobytes()).decode("ascii")
    print(f"client grid {rows}x{cols} step={step} "
          f"({gpx_deg_lat * M_PER_DEG_LAT:.0f} m/px)")

    # ---- assemble ----
    for info in ways_out:
        info.pop("geomLL", None)  # only needed at build time
    data = {
        "meta": {
            "lat0": LAT0, "lon0": LON0,
            "mPerDegLat": M_PER_DEG_LAT, "mPerDegLon": M_PER_DEG_LON,
            "datum": {"name": dname, "lat": dlat, "lon": dlon,
                      "elevAbs": round(e0, 1)},
            "bounds": {
                "n": dem.north, "s": dem.south, "w": dem.west, "e": dem.east,
            },
        },
        "ways": ways_out,
        "rivers": rivers,
        "lakes": lakes,
        "pois": pois,
        "shuttles": shuttles_out,
        "routes": routes_out,
        "graph": {"nodes": g_nodes, "edges": g_edges},
        "hillshade": {"n": hs_north, "s": hs_south, "w": hs_west, "e": hs_east},
        "demGrid": {
            "n": gnorth, "w": gwest,
            "dLat": gpx_deg_lat, "dLon": gpx_deg_lon,
            "rows": rows, "cols": cols,
            "values": values_b64,
        },
        "curatedRoutes": curated.get("routes", []),
        "notices": curated.get("notices", []),
    }

    os.makedirs(WEB_DATA, exist_ok=True)
    with open(OUT_JS, "w", encoding="utf-8") as f:
        f.write("window.KANAS_DATA = ")
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    # ---- summary ----
    by_cls = {}
    for w in ways_out:
        s = by_cls.setdefault(w["cls"], [0, 0.0])
        s[0] += 1
        s[1] += w["len"]
    print("\n===== SUMMARY =====")
    print(f"datum  {dname}: abs {e0:.1f} m  (all map elevations are relative to this)")
    for cls, (cnt, length) in sorted(by_cls.items()):
        print(f"  {cls:9s} {cnt:5d} ways  {length/1000:8.1f} km")
    print(f"  rivers   {len(rivers):5d}")
    print(f"  lakes    {len(lakes)}   pois {len(pois)}   "
          f"graph nodes {len(g_nodes)} edges {len(g_edges)}")
    print(f"output: {OUT_JS} ({os.path.getsize(OUT_JS)//1024} KB)")
    el = [p["e"] for p in pois]
    if el:
        print(f"POI rel elev range: {min(el):.0f} .. {max(el):.0f} m")
    elevs_all = [e for w in ways_out for e in (w["minE"], w["maxE"])]
    print(f"way rel elev range: {min(elevs_all):.0f} .. {max(elevs_all):.0f} m")


if __name__ == "__main__":
    main()
