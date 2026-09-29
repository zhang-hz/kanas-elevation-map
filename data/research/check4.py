# -*- coding: utf-8 -*-
"""Check 4: horizontal position vs DEM consistency via river cross-profiles.

For sampled river vertices: sample DEM along the perpendicular +/-250 m
(25 m step), find the profile minimum, and measure
  (a) river-point DEM elevation - profile minimum elevation
  (b) signed lateral offset of the profile minimum (and its 2D vector)
A systematic offset shows up as a consistent-sign median lateral shift.
"""
import json
import numpy as np
import qa_lib as Q

d = Q.load_data()
meta = d['meta']
dem = Q.Dem()
rivers = d['rivers']

HALF = 250.0
STEP = 25.0
offs = np.arange(-HALF, HALF + 1e-9, STEP)   # 21 samples


def sample_rivers(cls_name, n_target):
    pts = []   # (x_km, y_km) vertices
    for r in rivers:
        if r['cls'] != cls_name:
            continue
        g = np.asarray(r['geom'], dtype=np.float64)
        for i in range(len(g)):
            pts.append((g, i))
    if not pts:
        return []
    # even sampling across all vertices
    idx = np.linspace(0, len(pts) - 1, min(n_target, len(pts))).astype(int)
    out = []
    for k in idx:
        g, i = pts[k]
        out.append((g, i))
    return out


def analyse(samples, tag):
    recs = []
    for g, i in samples:
        p = g[i]
        if i > 0:
            prev = g[i - 1]
        else:
            prev = g[i] - (g[i + 1] - g[i])
        if i < len(g) - 1:
            nxt = g[i + 1]
        else:
            nxt = g[i] + (g[i] - g[i - 1])
        dirv = nxt - prev
        n = np.hypot(dirv[0], dirv[1])
        if n < 1e-9:
            continue
        dirv = dirv / n
        perp = np.array([-dirv[1], dirv[0]])   # km per km; orthonormal
        # perpendicular offsets in meters -> km
        xs = p[0] + perp[0] * (offs / 1000.0)
        ys = p[1] + perp[1] * (offs / 1000.0)
        lat, lon = Q.xy_to_latlon(meta, xs, ys)
        prof = dem.sample(lat, lon)
        if np.isnan(prof).any():
            continue
        k = int(np.argmin(prof))
        rlat, rlon = Q.xy_to_latlon(meta, p[0], p[1])
        e_river = float(dem.sample(np.array([rlat]), np.array([rlon]))[0])
        lat_off = float(offs[k])                    # signed, + = left of flow dir
        vec = perp * (lat_off / 1000.0)             # km
        recs.append(dict(x=float(p[0]), y=float(p[1]), lat=float(rlat), lon=float(rlon),
                         e_river=e_river, e_min=float(prof[k]),
                         diff=e_river - float(prof[k]),
                         lat_off=lat_off,
                         vx=float(vec[0]) * 1000.0, vy=float(vec[1]) * 1000.0,
                         relief=float(prof.max() - prof.min())))
    return recs


for tag, cls_name, n in (('river', 'river', 300), ('stream', 'stream', 300)):
    recs = analyse(sample_rivers(cls_name, n), tag)
    if not recs:
        continue
    diff = np.array([r['diff'] for r in recs])
    loff = np.array([r['lat_off'] for r in recs])
    vx = np.array([r['vx'] for r in recs])
    vy = np.array([r['vy'] for r in recs])
    relief = np.array([r['relief'] for r in recs])
    med_vx, med_vy = float(np.median(vx)), float(np.median(vy))
    mag = float(np.hypot(med_vx, med_vy))
    az = float(np.degrees(np.arctan2(med_vx, med_vy))) % 360.0   # from north, clockwise
    print('=== %s cross-profiles (n=%d) ===' % (tag, len(recs)))
    print('  river_elev - profile_min : mean %+.2f  median %+.2f  p25 %+.2f  p75 %+.2f  p90 %+.2f' % (
        diff.mean(), np.median(diff), np.percentile(diff, 25), np.percentile(diff, 75), np.percentile(diff, 90)))
    print('  fraction river point within 3 m of profile min: %.1f%%' % (100 * (diff <= 3).mean()))
    print('  signed lateral offset (m): mean %+.1f  median %+.1f  |median| of abs %.1f' % (
        loff.mean(), np.median(loff), np.median(np.abs(loff))))
    print('  offset vector (median vx,vy): (%+.1f, %+.1f) m  magnitude %.1f m  azimuth %.0f deg (from N)' % (
        med_vx, med_vy, mag, az))
    print('  fraction |lat_off| <= 25m: %.1f%%   <= 50m: %.1f%%   >=150m: %.1f%%' % (
        100 * (np.abs(loff) <= 25).mean(), 100 * (np.abs(loff) <= 50).mean(), 100 * (np.abs(loff) >= 150).mean()))
    print('  cross-profile relief: median %.1f m  p90 %.1f m' % (np.median(relief), np.percentile(relief, 90)))
    # component-wise (signed offsets projected on east/north already in vx,vy)
    print('  per-component: median vx(east) %+.1f m, vy(north) %+.1f m' % (med_vx, med_vy))
    worst = sorted(recs, key=lambda r: -abs(r['diff']))[:10]
    for r in worst:
        print('   worst diff %+.1f m at (%.5f,%.5f) lat_off %+.0f m relief %.0f m' % (
            r['diff'], r['lat'], r['lon'], r['lat_off'], r['relief']))
    json.dump(recs, open('res_check4_%s.json' % tag, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    # distribution by rough area: split by lon bands
    print()

# Supplementary: cross-profile test with a finer offset grid on 60 river points,
# to see whether the minimum is a broad flat area or a well-defined channel.
recs = json.load(open('res_check4_river.json', encoding='utf-8'))
sub = recs[::5][:60]
fine = []
offs2 = np.arange(-250, 250.1, 5.0)
for r in sub:
    # recompute direction from neighbors via nearest index in original data is complex;
    # approximate with local 3-point direction using recorded coords of consecutive recs is unreliable.
    fine.append(r)
print('n river recs:', len(recs))
