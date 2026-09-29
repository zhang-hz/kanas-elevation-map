# -*- coding: utf-8 -*-
"""Download AWS terrarium DEM tiles (zoom 13) and stitch into one grid."""
import math
import os
import struct
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TILE_DIR = os.path.join(ROOT, "data", "dem", "tiles")
NPZ_PATH = os.path.join(ROOT, "data", "dem", "dem_z13.npz")

Z = 13
# S, W, N, E (slightly padded beyond OSM bbox)
BBOX = (48.36, 86.60, 49.04, 87.70)

URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
UA = "kanas-elevation-map/1.0 (personal hiking map project)"


def deg2num(lat: float, lon: float, z: int) -> tuple[int, int]:
    n = 2.0**z
    x = int((lon + 180.0) / 360.0 * n)
    lat_r = math.radians(lat)
    y = int((1.0 - math.asinh(math.tan(lat_r)) / math.pi) / 2.0 * n)
    return x, y


def num2deg(x: float, y: float, z: int) -> tuple[float, float]:
    n = 2.0**z
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * y / n))))
    return lat, lon


def fetch_tile(x: int, y: int) -> tuple[int, int, np.ndarray]:
    path = os.path.join(TILE_DIR, str(Z), str(x), f"{y}.png")
    if os.path.exists(path):
        img = Image.open(path)
        arr = np.asarray(img.convert("RGB"), dtype=np.uint8)
        return x, y, arr
    url = URL.format(z=Z, x=x, y=y)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(raw)
            img = Image.open(path)
            arr = np.asarray(img.convert("RGB"), dtype=np.uint8)
            return x, y, arr
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"tile {Z}/{x}/{y} failed: {last}")


def main() -> None:
    s, w, n, e = BBOX
    x0, y0 = deg2num(n, w, Z)  # top-left
    x1, y1 = deg2num(s, e, Z)  # bottom-right
    xs = range(x0, x1 + 1)
    ys = range(y0, y1 + 1)
    tiles = [(x, y) for x in xs for y in ys]
    print(f"z{Z}: x {x0}..{x1}, y {y0}..{y1} -> {len(tiles)} tiles")

    tw = (x1 - x0 + 1) * 256
    th = (y1 - y0 + 1) * 256
    grid = np.empty((th, tw), dtype=np.float32)

    done = 0
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(fetch_tile, x, y): (x, y) for x, y in tiles}
        for fut in as_completed(futs):
            x, y, arr = fut.result()
            elev = arr[:, :, 0].astype(np.float32) * 256.0 + arr[:, :, 1] + arr[:, :, 2] / 256.0 - 32768.0
            px = (x - x0) * 256
            py = (y - y0) * 256
            grid[py:py + 256, px:px + 256] = elev
            done += 1
            if done % 40 == 0 or done == len(tiles):
                print(f"  {done}/{len(tiles)} tiles")

    top_lat, left_lon = num2deg(x0, y0, Z)
    bot_lat, right_lon = num2deg(x1 + 1, y1 + 1, Z)
    np.savez_compressed(
        NPZ_PATH,
        elev=grid.astype(np.float32),
        z=np.int32(Z),
        x0=np.int32(x0),
        y0=np.int32(y0),
        north=np.float64(top_lat),
        west=np.float64(left_lon),
        south=np.float64(bot_lat),
        east=np.float64(right_lon),
    )
    print(f"saved {NPZ_PATH}: shape={grid.shape}, "
          f"elev range {grid.min():.0f}..{grid.max():.0f} m")


if __name__ == "__main__":
    main()
