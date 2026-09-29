# -*- coding: utf-8 -*-
"""Check 4b: refined river cross-profile offset analysis.

- two-stage argmin (25 m coarse + 5 m fine within +/-40 m)
- offset vector = river point -> profile minimum (2D, m, east/north)
- stats: mean/median vector, magnitude distribution, direction consistency,
  sub-analysis on 'confident' samples (well-defined channel), regional split
"""
import json
import numpy as np
import qa_lib as Q

d = Q.load_data()
meta = d['meta']
dem = Q.Dem()
rivers = d['rivers']

COARSE = np.arange(-250, 250 + 1e-9, 25.0)
FINE = np.arange(-40, 40 + 1e-9, 5.0)


def collect(cls_name, n_target):
    pts = []
    for r in rivers:
        if r['cls'] != cls_name:
            continue
        g = np.asarray(r['geom'], dtype=np.float64)
        for i in range(len(g)):
            pts.append((g, i))
    idx = np.linspace(0, len(pts) - 1, min(n_target, len(pts))).astype(int)
    return [pts[k] for k in idx]


def profile_min(p, perp, offs):
    xs = p[0] + perp[0] * (offs / 1000.0)
    ys = p[1] + perp[1] * (offs / 1000.0)
    lat, lon = Q.xy_to_latlon(meta, xs, ys)
    return dem.sample(lat, lon), offs


def analyse(cls_name, n_target):
    recs = []
    for g, i in collect(cls_name, n_target):
        p = g[i]
        prev = g[i - 1] if i > 0 else g[i] - (g[i + 1] - g[i])
        nxt = g[i + 1] if i < len(g) - 1 else g[i] + (g[i] - g[i - 1])
        dirv = nxt - prev
        nn = np.hypot(dirv[0], dirv[1])
        if nn < 1e-9:
            continue
        dirv = dirv / nn
        perp = np.array([-dirv[1], dirv[0]])
        prof_c, off_c = profile_min(p, perp, COARSE)
        if np.isnan(prof_c).any():
            continue
        kc = int(np.argmin(prof_c))
        center = off_c[kc]
        fine_offs = center + FINE
        prof_f, off_f = profile_min(p, perp, fine_offs)
        if np.isnan(prof_f).any():
            continue
        kf = int(np.argmin(prof_f))
        off_best = float(off_f[kf])
        e_min = float(prof_f[kf])
        rlat, rlon = Q.xy_to_latlon(meta, p[0], p[1])
        e_river = float(dem.sample(np.array([rlat]), np.array([rlon]))[0])
        vec = perp * (off_best / 1000.0)
        # ambiguity: how flat is the profile around the min (within 2 m)
        near = np.abs(off_f - off_best) <= 40.0
        amb = float((prof_f[near] <= e_min + 2.0).sum()) * 5.0  # width of flat-min zone
        recs.append(dict(lat=float(rlat), lon=float(rlon), x=float(p[0]), y=float(p[1]),
                         off=off_best, vx=float(vec[0]) * 1000.0, vy=float(vec[1]) * 1000.0,
                         diff=e_river - e_min, e_river=e_river, e_min=e_min,
                         relief=float(prof_c.max() - prof_c.min()),
                         flat=amb))
    return recs


def report(recs, tag):
    vx = np.array([r['vx'] for r in recs])
    vy = np.array([r['vy'] for r in recs])
    off = np.array([r['off'] for r in recs])
    diff = np.array([r['diff'] for r in recs])
    relief = np.array([r['relief'] for r in recs])
    flat = np.array([r['flat'] for r in recs])
    mag = np.hypot(vx, vy)
    mean_v = np.array([vx.mean(), vy.mean()])
    med_v = np.array([np.median(vx), np.median(vy)])
    # direction consistency: unit vectors' mean resultant length
    u = np.stack([vx, vy], 1) / np.maximum(mag, 1e-9)[:, None]
    R = float(np.hypot(u[:, 0].mean(), u[:, 1].mean()))
    mean_dir = np.degrees(np.arctan2(mean_v[0], mean_v[1])) % 360 if np.hypot(*mean_v) > 0 else float('nan')
    print('--- %s (n=%d) ---' % (tag, len(recs)))
    print('  lateral offset |off| m : median %.1f  mean %.1f  p75 %.1f  p90 %.1f' % (
        np.median(np.abs(off)), np.abs(off).mean(), np.percentile(np.abs(off), 75), np.percentile(np.abs(off), 90)))
    print('  offset vector mean (E,N): (%+.1f, %+.1f) m |mean| %.1f m ; median (E,N): (%+.1f, %+.1f) |med| %.1f m' % (
        mean_v[0], mean_v[1], np.hypot(*mean_v), med_v[0], med_v[1], np.hypot(*med_v)))
    print('  mean direction azimuth: %.0f deg (0=N,90=E); direction consistency R=%.2f (0=random,1=aligned)' % (
        mean_dir, R))
    if np.hypot(*mean_v) > 0:
        cosang = u @ (mean_v / np.hypot(*mean_v))
        frac30 = 100 * np.mean(np.degrees(np.arccos(np.clip(cosang, -1, 1))) <= 30)
    else:
        frac30 = 0.0
    print('  fraction pointing within 30 deg of mean direction: %.1f%%' % frac30)
    print('  frac |off|<=25m: %.1f%%  <=50m: %.1f%%  >=100m: %.1f%%  >=200m: %.1f%%' % (
        100 * (np.abs(off) <= 25).mean(), 100 * (np.abs(off) <= 50).mean(),
        100 * (np.abs(off) >= 100).mean(), 100 * (np.abs(off) >= 200).mean()))
    print('  river_elev - min_elev: median %+.2f  mean %+.2f  p90 %+.2f ; within 3m: %.1f%%' % (
        np.median(diff), diff.mean(), np.percentile(diff, 90), 100 * (diff <= 3).mean()))
    # confident subset: well-defined channel
    conf = (relief >= 40) & (flat <= 20) & (np.abs(off) < 240)
    print('  confident subset (relief>=40m, sharp min): n=%d' % conf.sum())
    if conf.sum() >= 10:
        cvx, cvy = vx[conf], vy[conf]
        cmag = np.hypot(cvx, cvy)
        cu = np.stack([cvx, cvy], 1) / np.maximum(cmag, 1e-9)[:, None]
        cR = float(np.hypot(cu[:, 0].mean(), cu[:, 1].mean()))
        cm = np.array([cvx.mean(), cvy.mean()])
        print('    |off| median %.1f m ; mean vector (%+.1f,%+.1f) | %.1f m ; R=%.2f ; median vector (%+.1f,%+.1f)' % (
            np.median(np.abs(off[conf])), cm[0], cm[1], np.hypot(*cm), cR,
            np.median(cvx), np.median(cvy)))
        print('    diff median %+.2f m' % np.median(diff[conf]))
    # regional split
    regions = [('贾登峪', 48.45, 48.56, 87.05, 87.20), ('三湾', 48.58, 48.68, 87.00, 87.08),
               ('喀纳斯湖畔', 48.68, 48.76, 86.97, 87.06), ('白哈巴', 48.62, 48.74, 86.70, 86.85),
               ('禾木', 48.53, 48.62, 87.35, 87.60)]
    lats = np.array([r['lat'] for r in recs]); lons = np.array([r['lon'] for r in recs])
    for nm, s, n, w, e in regions:
        m = (lats >= s) & (lats <= n) & (lons >= w) & (lons <= e)
        if m.sum() < 5:
            continue
        print('    region %-8s n=%3d  |off| med %5.1f  mean vec (%+5.1f,%+5.1f) | %.1f m  diff med %+.2f' % (
            nm, m.sum(), np.median(np.abs(off[m])), vx[m].mean(), vy[m].mean(),
            np.hypot(vx[m].mean(), vy[m].mean()), np.median(diff[m])))
    return dict(recs=recs, mean_vec=[float(mean_v[0]), float(mean_v[1])],
                med_vec=[float(med_v[0]), float(med_v[1])], R=R, mean_dir=float(mean_dir))


r1 = report(analyse('river', 300), 'river')
print()
r2 = report(analyse('stream', 300), 'stream')
json.dump(dict(river=r1, stream=r2), open('res_check4b.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

# Fine-grid river of length? also test rivers against an ALTERNATIVE hypothesis:
# global shift search: find shift (dx,dy) minimizing mean (DEM at river+shift) over all river vertices
print()
print('=== global shift grid search on river+stream vertices (all, ~n) ===')
verts = []
for r in rivers:
    g = np.asarray(r['geom'], float)
    for i in range(len(g)):
        verts.append(g[i])
verts = np.array(verts)
sel = verts[np.linspace(0, len(verts) - 1, 2000).astype(int)]
best = None
for dx in range(-60, 61, 20):
    for dy in range(-60, 61, 20):
        lat, lon = Q.xy_to_latlon(meta, sel[:, 0] + dx / 1000.0, sel[:, 1] + dy / 1000.0)
        z = dem.sample(lat, lon)
        m = float(np.nanmean(z))
        if best is None or m < best[0]:
            best = (m, dx, dy)
        if dx == 0 and dy == 0:
            base = m
print('  mean DEM elev at river vertices (shift 0,0): %.2f m' % base)
print('  best shift on 20m grid: (%+d,%+d) m -> mean %.2f m  (delta %.2f m)' % (best[1], best[2], best[0], best[0] - base))
# refine around best
b2 = None
for dx in range(best[1] - 20, best[1] + 21, 5):
    for dy in range(best[2] - 20, best[2] + 21, 5):
        lat, lon = Q.xy_to_latlon(meta, sel[:, 0] + dx / 1000.0, sel[:, 1] + dy / 1000.0)
        z = dem.sample(lat, lon)
        m = float(np.nanmean(z))
        if b2 is None or m < b2[0]:
            b2 = (m, dx, dy)
print('  refined best shift: (%+d,%+d) m -> mean %.2f m (delta %.2f m vs 0,0)' % (b2[1], b2[2], b2[0], b2[0] - base))
