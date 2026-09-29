# -*- coding: utf-8 -*-
"""Check 4d: diagnostics on the vector-vs-DEM offset.
1) sign/scale sanity: synthetic shift of lake rings, does the estimator recover it?
2) translation vs scale: does the offset vary with y_km (distance from lat0)?
"""
import numpy as np
import qa_lib as Q

d = Q.load_data()
meta = d['meta']
dem = Q.Dem()
z = dem.elev
gz_y, gz_x = np.gradient(z.astype(np.float64), dem.dlat, dem.dlon)
mpd_lon = meta['mPerDegLon']
mpd_lat = meta['mPerDegLat']


def lake_rows(shift_m=(0.0, 0.0)):
    rows = []
    for lk in d['lakes']:
        geom = lk['geom']
        if isinstance(geom[0][0], (list, tuple)):
            g = np.asarray(max(geom, key=len), dtype=np.float64)
        else:
            g = np.asarray(geom, dtype=np.float64)
        if len(g) < 12:
            continue
        g = g.copy()
        g[:, 0] += shift_m[0] / 1000.0
        g[:, 1] += shift_m[1] / 1000.0
        x = g[:, 0] * 1000.0
        y = g[:, 1] * 1000.0
        area = 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))
        if area < 20000 or area > 5e7:
            continue
        idx = np.linspace(0, len(g) - 1, min(40, len(g))).astype(int)
        cx, cy = x.mean(), y.mean()
        zs, gs, nxs, nys, ys_km = [], [], [], [], []
        ok = True
        for i in idx:
            px, py = x[i], y[i]
            nx, ny = px - cx, py - cy
            nn = np.hypot(nx, ny)
            if nn < 1e-6:
                ok = False
                break
            nx, ny = nx / nn, ny / nn
            lat, lon = Q.xy_to_latlon(meta, px / 1000.0, py / 1000.0)
            ze = dem.sample(np.array([lat]), np.array([lon]))[0]
            if np.isnan(ze):
                ok = False
                break
            r = int((dem.north - lat) / dem.dlat)
            c = int((lon - dem.west) / dem.dlon)
            r = min(max(r, 1), z.shape[0] - 2)
            c = min(max(c, 1), z.shape[1] - 2)
            dxx = gz_x[r, c] / mpd_lon
            dyy = gz_y[r, c] / mpd_lat
            zs.append(float(ze)); gs.append(float(np.hypot(dxx, dyy)))
            nxs.append(nx); nys.append(ny); ys_km.append(float(py) / 1000.0)
        if not ok or len(zs) < 10:
            continue
        zs = np.array(zs); gs = np.array(gs)
        if np.median(gs) < 0.005:
            continue
        rows.append((zs, gs, np.array(nxs), np.array(nys), np.array(ys_km), lk['name']))
    return rows


def fit_delta(rows, n_lakes=None):
    n = len(rows)
    total = sum(len(r[0]) for r in rows)
    A = np.zeros((total, n + 2))
    b = np.zeros(total)
    k = 0
    for li, (zs, gs, nxs, nys, yk, nm) in enumerate(rows):
        m = len(zs)
        A[k:k + m, li] = 1.0
        A[k:k + m, n] = gs * nxs
        A[k:k + m, n + 1] = gs * nys
        b[k:k + m] = zs
        k += m
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    return sol[-2], sol[-1]


dx, dy = fit_delta(lake_rows())
print('baseline lake fit: delta = (E %+.1f, N %+.1f) m' % (dx, dy))
for sh in [(0, 25), (0, 50), (25, 0)]:
    sdx, sdy = fit_delta(lake_rows(sh))
    print('  synthetic shift (%+d,%+d) -> recovered (%+.1f, %+.1f)' % (sh[0], sh[1], sdx, sdy))

# 2) translation vs scale: regress per-lake delta_y on lake centroid y_km
rows = lake_rows()
print()
print('per-lake delta vs centroid y_km (slope test for scale error):')
pts = []
for zs, gs, nxs, nys, yk, nm in rows:
    X = np.stack([gs * nxs, gs * nys], 1)
    Y = zs - zs.mean()
    s2, *_ = np.linalg.lstsq(X, Y, rcond=None)
    pts.append((float(np.mean(yk)), s2[0], s2[1]))
pts = np.array(pts)
# weight by nothing; robust: use median split
lo = pts[pts[:, 0] < np.median(pts[:, 0])]
hi = pts[pts[:, 0] >= np.median(pts[:, 0])]
print('  y_km range: %.1f .. %.1f  n=%d' % (pts[:, 0].min(), pts[:, 0].max(), len(pts)))
print('  southern half (y<%.1f): mean delta (E %+.1f, N %+.1f) n=%d' % (np.median(pts[:, 0]), lo[:, 1].mean(), lo[:, 2].mean(), len(lo)))
print('  northern half (y>=%.1f): mean delta (E %+.1f, N %+.1f) n=%d' % (np.median(pts[:, 0]), hi[:, 1].mean(), hi[:, 2].mean(), len(hi)))
A = np.stack([pts[:, 0], np.ones(len(pts))], 1)
for j, lab in ((1, 'E'), (2, 'N')):
    sol, *_ = np.linalg.lstsq(A, pts[:, j], rcond=None)
    pred = A @ sol
    ss = 1 - ((pts[:, j] - pred) ** 2).sum() / max(((pts[:, j] - pts[:, j].mean()) ** 2).sum(), 1e-9)
    print('  delta_%s = %+.3f m per km * y_km + %+.1f m   (R2 %.2f)' % (lab, sol[0], sol[1], ss))

# same regression for river offsets
print()
for tag in ('river', 'stream'):
    recs = json.load(open('res_check4_%s.json' % tag, encoding='utf-8')) if False else None
import json
for tag in ('river', 'stream'):
    recs = json.load(open('res_check4_%s.json' % tag, encoding='utf-8'))
    yk = np.array([r['y'] for r in recs])
    vx = np.array([r['vx'] for r in recs])
    vy = np.array([r['vy'] for r in recs])
    A = np.stack([yk, np.ones(len(yk))], 1)
    for j, lab in ((0, 'vx(E)'), (1, 'vy(N)')):
        v = (vx if j == 0 else vy)
        sol, *_ = np.linalg.lstsq(A, v, rcond=None)
        pred = A @ sol
        ss = 1 - ((v - pred) ** 2).sum() / max(((v - v.mean()) ** 2).sum(), 1e-9)
        print('  %s %s = %+.3f m/km * y_km + %+.1f m (R2 %.2f)' % (tag, lab, sol[0], sol[1], ss))
