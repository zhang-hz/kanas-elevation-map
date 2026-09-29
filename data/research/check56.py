# -*- coding: utf-8 -*-
"""Check 5: curated POI coverage (ways within 500 m).
Check 6: per-region statistics."""
import json
import numpy as np
import qa_lib as Q

d = Q.load_data()
meta = d['meta']
ways = d['ways']
cur = Q.load_curated()
ABS = meta['datum']['elevAbs']

# ---- index of way vertices in meters ----
wp = Q.WayPoints(d)
wp.build_grid(200.0)

# ---------- Check 5 ----------
print('=== check5: curated POI coverage (500 m) ===')
cov = []
for p in cur['pois']:
    x_km, y_km = Q.latlon_to_xy(meta, p['lat'], p['lon'])
    x_m, y_m = float(x_km) * 1000, float(y_km) * 1000
    idx = wp.query_radius(x_m, y_m, 500.0)
    way_ids = sorted({ways[int(wi)]['id'] for wi in wp.wid[idx]})
    near = []
    for wi in set(int(i) for i in wp.wid[idx]):
        w = ways[wi]
        g = np.asarray(w['geom']) * 1000
        dd = np.hypot(g[:, 0] - x_m, g[:, 1] - y_m).min()
        near.append((dd, w['id'], w['cls'], w['name']))
    near.sort()
    cov.append(dict(name=p['name'], cat=p['cat'], lat=p['lat'], lon=p['lon'],
                    n_ways=len(way_ids),
                    nearest=[dict(dist=round(n[0], 1), way_id=n[1], cls=n[2], name=n[3]) for n in near[:3]]))
sparse = [c for c in cov if c['n_ways'] < 2]
print('pois total: %d ; with <2 ways within 500m: %d' % (len(cov), len(sparse)))
for c in sorted(cov, key=lambda c: c['n_ways']):
    if c['n_ways'] < 2:
        near = c['nearest'][0] if c['nearest'] else None
        print('  %-14s cat=%-11s (%.5f,%.5f) ways=%d  nearest=%s' % (
            c['name'][:14], c['cat'], c['lat'], c['lon'], c['n_ways'],
            ('%.0fm way %s(%s)' % (near['dist'], near['way_id'], near['cls'])) if near else 'none'))
n0 = sum(1 for c in cov if c['n_ways'] == 0)
print('pois with 0 ways within 500m:', n0)
print('median ways within 500m:', int(np.median([c['n_ways'] for c in cov])))
# also data pois[]
print()
print('data pois[] coverage (same test, for reference):')
low = []
for p in d['pois']:
    x_km, y_km = Q.latlon_to_xy(meta, p['lat'], p['lon']) if 'lat' in p else (p['x'], p['y'])
    x_m, y_m = float(x_km) * 1000, float(y_km) * 1000
    idx = wp.query_radius(x_m, y_m, 500.0)
    way_ids = {int(wi) for wi in wp.wid[idx]}
    if len(way_ids) < 2:
        low.append((p['name'], p['cat'], p['lat'], p['lon'], len(way_ids)))
print('  pois[] total %d ; <2 ways within 500m: %d' % (len(d['pois']), len(low)))
for t in low[:25]:
    print('   %-16s %-11s (%.5f,%.5f) ways=%d' % (t[0][:16], t[1], t[2], t[3], t[4]))
json.dump(dict(curated=cov, data_pois_low=low), open('res_check5.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

# ---------- Check 6 ----------
print()
print('=== check6: regional statistics ===')
regions = [('贾登峪', 48.45, 48.56, 87.05, 87.20),
           ('三湾', 48.58, 48.68, 87.00, 87.08),
           ('喀纳斯湖畔', 48.68, 48.76, 86.97, 87.06),
           ('观鱼台', 48.71, 48.74, 86.97, 87.01),
           ('白哈巴', 48.62, 48.74, 86.70, 86.85),
           ('禾木', 48.53, 48.62, 87.35, 87.60)]
reg_rows = []
assigned = set()
for nm, s, n, w_, e_ in regions:
    sel = []
    for wi, w in enumerate(ways):
        g = np.asarray(w['geom'])
        mid = g[len(g) // 2]
        lat, lon = Q.xy_to_latlon(meta, mid[0], mid[1])
        if s <= lat <= n and w_ <= lon <= e_:
            sel.append(wi)
            assigned.add(wi)
    tot_len = sum(ways[i]['len'] for i in sel)
    if sel:
        mne = min(ways[i]['minE'] for i in sel)
        mxe = max(ways[i]['maxE'] for i in sel)
        from collections import Counter
        cls = Counter(ways[i]['cls'] for i in sel)
    else:
        mne = mxe = float('nan'); cls = {}
    reg_rows.append(dict(region=nm, n_ways=len(sel), total_len_km=round(tot_len / 1000, 1),
                         minE_rel=round(mne, 1), maxE_rel=round(mxe, 1),
                         minE_abs=round(mne + ABS, 1), maxE_abs=round(mxe + ABS, 1),
                         cls=dict(cls)))
    print('  %-8s ways=%3d  total=%7.1f km  elev(rel) %8.1f .. %8.1f  abs %6.0f..%6.0f m  cls=%s' % (
        nm, len(sel), tot_len / 1000, mne, mxe, mne + ABS, mxe + ABS, dict(cls)))
un = len(ways) - len(assigned)
print('  ways not in any region box (assigned by midpoint): %d' % un)
tot_all = sum(w['len'] for w in ways)
print('  ALL ways: %d, total %.1f km, elev(rel) %.1f .. %.1f (abs %.0f..%.0f)' % (
    len(ways), tot_all / 1000, min(w['minE'] for w in ways), max(w['maxE'] for w in ways),
    min(w['minE'] for w in ways) + ABS, max(w['maxE'] for w in ways) + ABS))
json.dump(dict(regions=reg_rows, unassigned=un, total=dict(n=len(ways), len_km=tot_all / 1000)),
          open('res_check6.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
