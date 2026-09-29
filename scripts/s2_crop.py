"""Crop + annotate S2 cloudless tiles around a link for visual QA.

Bypasses the image-display cache: every call writes a NEW uniquely-named file
(caller supplies the name), with the link drawn on top, so the viewer never
sees a stale frame for a different location.

usage: python s2_crop.py <lat0> <lon0> <lat1> <lon1> <out.png> [margin_m] [scale]
       (pass the same point twice for a dot-only view)
"""
import math
import os
import sys
import urllib.request

from PIL import Image, ImageDraw

ROOT = r"C:/Data/Code/Kanas"
CACHE = os.path.join(ROOT, "data", "research", "s2_tiles")
Z = 16
TILE = 256
UA = "kanas-elevation-map-research/1.0 (local offline map QA)"


def deg2px(lat, lon, z=Z):
    n = 2.0 ** z * TILE
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def get_tile(tx, ty):
    path = os.path.join(CACHE, f"{Z}_{tx}_{ty}.jpg")
    if not os.path.exists(path) or os.path.getsize(path) < 500:
        url = f"https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{Z}/{ty}/{tx}.jpg"
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        for _ in range(3):
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    open(path, "wb").write(resp.read())
                break
            except Exception as e:  # noqa: BLE001
                err = str(e)
        else:
            raise RuntimeError(f"tile fetch failed {tx} {ty}: {err}")
    return Image.open(path).convert("RGB")


def main():
    lat0, lon0, lat1, lon1 = map(float, sys.argv[1:5])
    out = sys.argv[5]
    margin_m = float(sys.argv[6]) if len(sys.argv) > 6 else 150.0
    scale = int(sys.argv[7]) if len(sys.argv) > 7 else 2

    x0, y0 = deg2px(lat0, lon0)
    x1, y1 = deg2px(lat1, lon1)
    # metres per pixel at this latitude (z16, 256px tiles)
    mpp = 156543.03392 * math.cos(math.radians((lat0 + lat1) / 2)) / (2 ** Z)
    mpx = margin_m / mpp

    minx, maxx = min(x0, x1) - mpx, max(x0, x1) + mpx
    miny, maxy = min(y0, y1) - mpx, max(y0, y1) + mpx
    tx0, tx1 = int(minx // TILE), int(maxx // TILE)
    ty0, ty1 = int(miny // TILE), int(maxy // TILE)

    W = (tx1 - tx0 + 1) * TILE
    H = (ty1 - ty0 + 1) * TILE
    canvas = Image.new("RGB", (W, H))
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            canvas.paste(get_tile(tx, ty), ((tx - tx0) * TILE, (ty - ty0) * TILE))

    def to_local(px, py):
        return px - tx0 * TILE, py - ty0 * TILE

    d = ImageDraw.Draw(canvas)
    lx0, ly0 = to_local(x0, y0)
    lx1, ly1 = to_local(x1, y1)
    if abs(lx0 - lx1) + abs(ly0 - ly1) > 4:
        d.line([lx0, ly0, lx1, ly1], fill=(255, 40, 40), width=4)
    for lx, ly in ((lx0, ly0), (lx1, ly1)):
        d.ellipse([lx - 7, ly - 7, lx + 7, ly + 7], outline=(255, 40, 40), width=3)
        d.ellipse([lx - 2, ly - 2, lx + 2, ly + 2], fill=(255, 255, 0))

    if scale != 1:
        canvas = canvas.resize((W * scale, H * scale), Image.LANCZOS)
    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    canvas.save(out)
    print(f"{out}  {canvas.size[0]}x{canvas.size[1]}  tiles x{tx0}..{tx1} y{ty0}..{ty1}  mpp={mpp:.2f}")


if __name__ == "__main__":
    main()
