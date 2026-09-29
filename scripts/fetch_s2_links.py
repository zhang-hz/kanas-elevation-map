# Fetch EOX Sentinel-2 cloudless z16 tiles covering every auto-link endpoint
# and water crossing, into data/research/s2_tiles/ (shared cache with offset_check).
import json, math, os, urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = r"C:/Data/Code/Kanas"
CACHE = os.path.join(ROOT, "data", "research", "s2_tiles")
Z = 16
UA = "kanas-elevation-map-research/1.0 (local offline map QA)"

R = json.load(open(os.path.join(ROOT, "data", "research", "link_review.json"), encoding="utf-8"))


def deg2num(lat, lon, z):
    n = 2.0 ** z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return x, y


pts = []
for r in R:
    pts.append((r["p0"]["lat"], r["p0"]["lon"]))
    pts.append((r["p1"]["lat"], r["p1"]["lon"]))
    for c in r["crossings"]:
        # crossing stored in km plane -> back to lat/lon
        lat = 48.70 + c["pt"][1] * 1000.0 / 111203.9
        lon = 87.10 + c["pt"][0] * 1000.0 / 73610.1
        pts.append((lat, lon))
        # 3x3 tile block around each crossing for context
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                x, y = deg2num(lat, lon, Z)
                pts.append((lat, lon))

tiles = set()
for lat, lon in pts:
    tiles.add(deg2num(lat, lon, Z))
# also neighbourhood tiles around every tile (context margin)
tiles |= {(x + dx, y + dy) for x, y in list(tiles) for dx in (-1, 0, 1) for dy in (-1, 0, 1)}


def fetch(t):
    x, y = t
    path = os.path.join(CACHE, f"{Z}_{x}_{y}.jpg")
    if os.path.exists(path) and os.path.getsize(path) > 500:
        return "cached"
    url = f"https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{Z}/{y}/{x}.jpg"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for _ in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                open(path, "wb").write(resp.read())
            return "ok"
        except Exception as e:  # noqa: BLE001
            err = str(e)
    return f"FAIL {x} {y} {err}"


os.makedirs(CACHE, exist_ok=True)
print(f"tiles needed: {len(tiles)}")
done = {"ok": 0, "cached": 0, "fail": 0}
with ThreadPoolExecutor(max_workers=12) as ex:
    for i, res in enumerate(ex.map(fetch, sorted(tiles))):
        if res == "ok":
            done["ok"] += 1
        elif res == "cached":
            done["cached"] += 1
        else:
            done["fail"] += 1
            print(" ", res)
        if (i + 1) % 50 == 0:
            print(f"  {i + 1}/{len(tiles)}")
print(done)
