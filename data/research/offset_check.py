# -*- coding: utf-8 -*-
"""Third-party arbitration of the reported 30-45 m vector-vs-DEM offset.

Uses EOX Sentinel-2 cloudless tiles (WGS84-orthorectified, ~10 m geolocation)
to independently locate river channels, then compares their positions with
(a) the OSM vector river lines and (b) the DEM valley minima.
"""
import json
import math
import os
import re
import urllib.request

import numpy as np
from PIL import Image

ROOT = r"C:\Data\Code\Kanas"
CACHE = os.path.join(ROOT, "data", "research", "s2_tiles")
OUT = os.path.join(ROOT, "data", "research", "offset_check.json")
os.makedirs(CACHE, exist_ok=True)

Z = 16
MPLAT, MPLON = 111203.9, 73610.1
LAT0, LON0 = 48.70, 87.10
UA = "kanas-elevation-map/1.0 (research)"

# ---------- load vector rivers + meta ----------
raw = open(os.path.join(ROOT, "web", "data", "kanas_data.js"), encoding="utf-8").read()
data = json.loads(raw[raw.index("=") + 1: raw.rindex(";")])
meta = data["meta"]


def to_ll(x, y):
    return (meta["lat0"] + y * 1000.0 / meta["mPerDegLat"],
            meta["lon0"] + x * 1000.0 / meta["mPerDegLon"])


rivers = [r for r in data["rivers"] if r["cls"] == "river" and len(r["geom"]) > 6]
print(f"river features: {len(rivers)}")

# ---------- DEM ----------
demz = np.load(os.path.join(ROOT, "data", "dem", "dem_z13.npz"))
ELEV = demz["elev"]
NORTH, SOUTH = float(demz["north"]), float(demz["south"])
WEST, EAST = float(demz["west"]), float(demz["east"])


def dem_sample(lat, lon):
    r = (NORTH - lat) / (NORTH - SOUTH) * ELEV.shape[0] - 0.5
    c = (lon - WEST) / (EAST - WEST) * ELEV.shape[1] - 0.5
    if r < 0 or c < 0 or r > ELEV.shape[0] - 1 or c > ELEV.shape[1] - 1:
        return None
    r0, c0 = int(r), int(c)
    r1, c1 = min(r0 + 1, ELEV.shape[0] - 1), min(c0 + 1, ELEV.shape[1] - 1)
    fr, fc = r - r0, c - c0
    return float((ELEV[r0, c0] * (1 - fc) + ELEV[r0, c1] * fc) * (1 - fr) +
                 (ELEV[r1, c0] * (1 - fc) + ELEV[r1, c1] * fc) * fr)


# ---------- S2 tiles ----------
def deg2num(lat, lon, z):
    n = 2.0 ** z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return x, y


def get_tile(x, y):
    path = os.path.join(CACHE, f"{Z}_{x}_{y}.jpg")
    if not os.path.exists(path):
        url = f"https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{Z}/{y}/{x}.jpg"
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        for _ in range(3):
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    open(path, "wb").write(resp.read())
                break
            except Exception as e:  # noqa: BLE001
                print("  tile fail", x, y, e)
        else:
            return None
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)


TILE_CACHE = {}


def tile_for(lat, lon):
    x, y = deg2num(lat, lon, Z)
    if (x, y) not in TILE_CACHE:
        TILE_CACHE[(x, y)] = get_tile(x, y)
    return x, y, TILE_CACHE[(x, y)]


def s2_pixel(lat, lon):
    """RGB at WGS84 position from z16 tiles (256px per tile)."""
    x, y, arr = tile_for(lat, lon)
    if arr is None:
        return None
    n = 2.0 ** Z
    fx = (lon + 180.0) / 360.0 * n * 256.0 - x * 256.0
    fy = ((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n) * 256.0 - y * 256.0
    ix = int(min(255, max(0, fx)))
    iy = int(min(255, max(0, fy)))
    return arr[iy, ix]


# ---------- cross sections ----------
rng = np.random.default_rng(42)
sections = []
for rv in rivers:
    geom = rv["geom"]
    ll = [to_ll(p[0], p[1]) for p in geom]
    d = [0.0]
    for i in range(1, len(ll)):
        d.append(d[-1] + math.hypot((ll[i][0] - ll[i - 1][0]) * MPLAT,
                                    (ll[i][1] - ll[i - 1][1]) * MPLON))
    i = 2
    while i < len(ll) - 3:
        j = i
        while j < len(ll) - 1 and d[j] - d[i] < 250:
            j += 1
        if j >= len(ll) - 1:
            break
        # direction over the window
        dN = (ll[j][0] - ll[i][0]) * MPLAT
        dE = (ll[j][1] - ll[i][1]) * MPLON
        if abs(dN) + abs(dE) < 10:
            i = j
            continue
        mid = (ll[i][0] + ll[j][0]) / 2, (ll[i][1] + ll[j][1]) / 2
        sections.append((mid[0], mid[1], dE, dN))
        i = j + 3

print(f"candidate cross-sections: {len(sections)}")
sel = [sections[k] for k in rng.choice(len(sections), size=min(40, len(sections)), replace=False)]

results = []
for lat, lon, dE, dN in sel:
    px = s2_pixel(lat, lon)
    if px is None:
        continue
    L = math.hypot(dE, dN)
    ux, uy = dE / L, dN / L           # along-flow unit (x=E, y=N)
    nx, ny = -uy, ux                  # perpendicular
    if abs(dN) < abs(dE):             # prefer cross-sections on N-S flows -> perp ~ E-W
        pass
    ts = np.arange(-120, 121, 3.0)
    s2_score, dem_e, xs, ys = [], [], [], []
    for t in ts:
        la = lat + (ny * t) / MPLAT
        lo = lon + (nx * t) / MPLON
        rgb = s2_pixel(la, lo)
        if rgb is None:
            return_ok = False
            s2_score.append(None)
            dem_e.append(None)
        else:
            lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]
            s2_score.append((255.0 - lum) + 2.0 * (rgb[2] - rgb[0]))
            dem_e.append(dem_sample(la, lo))
        xs.append(lo)
        ys.append(la)
    if any(v is None for v in s2_score) or any(v is None for v in dem_e):
        continue
    s2_score = np.array(s2_score)
    dem_e = np.array(dem_e)
    # smooth
    k = np.ones(3) / 3
    s2s = np.convolve(s2_score, k, mode="same")
    i_s2 = int(np.argmax(s2s))
    i_dem = int(np.argmin(dem_e))
    if not (2 <= i_s2 <= len(ts) - 3) or not (2 <= i_dem <= len(ts) - 3):
        continue

    def subpix_min(arr, idx, mode="min"):
        y0, y1, y2 = arr[idx - 1], arr[idx], arr[idx + 1]
        den = (y0 - 2 * y1 + y2)
        if abs(den) < 1e-9:
            return 0.0
        return 0.5 * (y0 - y2) / den

    t_s2 = ts[i_s2] + 3.0 * subpix_min(s2s, i_s2)
    t_dem = ts[i_dem] + 3.0 * subpix_min(dem_e, i_dem, "min")
    # convert offsets to NE metres relative to vector point
    lat_s2 = lat + (ny * t_s2) / MPLAT
    lon_s2 = lon + (nx * t_s2) / MPLON
    lat_dm = lat + (ny * t_dem) / MPLAT
    lon_dm = lon + (nx * t_dem) / MPLON
    results.append({
        "lat": round(lat, 5), "lon": round(lon, 5),
        "s2_dN": round((lat_s2 - lat) * MPLAT, 1), "s2_dE": round((lon_s2 - lon) * MPLON, 1),
        "dem_dN": round((lat_dm - lat) * MPLAT, 1), "dem_dE": round((lon_dm - lon) * MPLON, 1),
    })

s2_dN = np.array([r["s2_dN"] for r in results])
s2_dE = np.array([r["s2_dE"] for r in results])
dem_dN = np.array([r["dem_dN"] for r in results])
dem_dE = np.array([r["dem_dE"] for r in results])
summary = {
    "n": len(results),
    "s2_vs_vector": {"median_dN": float(np.median(s2_dN)), "median_dE": float(np.median(s2_dE)),
                     "mean_dN": float(np.mean(s2_dN)), "mean_dE": float(np.mean(s2_dE))},
    "dem_vs_vector": {"median_dN": float(np.median(dem_dN)), "median_dE": float(np.median(dem_dE)),
                      "mean_dN": float(np.mean(dem_dN)), "mean_dE": float(np.mean(dem_dE))},
}
print(json.dumps(summary, indent=1))
json.dump({"summary": summary, "results": results}, open(OUT, "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
print("saved", OUT)
