# -*- coding: utf-8 -*-
"""Fetch OSM data (highways, water, POIs, routes) for the Kanas scenic area."""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "data", "osm")

# S, W, N, E -- covers Baihaba (W), Hemu (E), Kanas Lake (N), Jiadengyu (S)
BBOX = (48.38, 86.63, 49.02, 87.67)

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
]
UA = "kanas-elevation-map/1.0 (personal hiking map project)"

QUERIES = {
    "highways": """
[out:json][timeout:180];
(
  way["highway"]({bbox});
);
(._;>;);
out body;
""",
    "water": """
[out:json][timeout:180];
(
  way["waterway"]({bbox});
  way["natural"="water"]({bbox});
  way["natural"="wetland"]({bbox});
  way["water"]({bbox});
  relation["natural"="water"]({bbox});
);
(._;>;);
out body;
""",
    "pois": """
[out:json][timeout:180];
(
  node["tourism"]({bbox});
  way["tourism"]({bbox});
  node["place"]({bbox});
  node["amenity"]({bbox});
  way["amenity"]({bbox});
  node["highway"="bus_stop"]({bbox});
  node["public_transport"]({bbox});
  node["information"]({bbox});
  node["barrier"="gate"]({bbox});
  node["natural"="peak"]({bbox});
  node["natural"="saddle"]({bbox});
);
(._;>;);
out body;
""",
    "routes": """
[out:json][timeout:180];
(
  relation["route"]({bbox});
);
(._;>;);
out body;
""",
}


def fetch(query: str) -> dict:
    bbox = ",".join(str(v) for v in BBOX)
    data = query.format(bbox=bbox).encode("utf-8")
    last_err = None
    for ep in ENDPOINTS:
        for attempt in range(3):
            req = urllib.request.Request(
                ep, data=data, headers={"User-Agent": UA}
            )
            try:
                with urllib.request.urlopen(req, timeout=240) as resp:
                    raw = resp.read()
                obj = json.loads(raw)
                if "elements" not in obj:
                    raise ValueError("no elements in response")
                print(f"  ok: {ep} -> {len(obj['elements'])} elements")
                return obj
            except Exception as e:  # noqa: BLE001
                last_err = e
                print(f"  fail ({ep} attempt {attempt + 1}): {e}")
                time.sleep(3 + attempt * 4)
    raise RuntimeError(f"all endpoints failed: {last_err}")


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    only = sys.argv[1:] or list(QUERIES)
    for name in only:
        out_path = os.path.join(OUT_DIR, f"{name}.json")
        if os.path.exists(out_path) and os.path.getsize(out_path) > 1000:
            print(f"[{name}] already present, skip")
            continue
        print(f"[{name}] fetching ...")
        obj = fetch(QUERIES[name])
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
        print(f"[{name}] saved -> {out_path} ({os.path.getsize(out_path) // 1024} KB)")


if __name__ == "__main__":
    main()
