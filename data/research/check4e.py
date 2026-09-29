# -*- coding: utf-8 -*-
"""Check 4e: lake shoreline registration test with the true gradient model.

z_i = a_lake + grad_i . delta ;  grad_i = DEM gradient (per meter) at ring vertex.
Injecting a synthetic shift into the rings must be recovered ~exactly.
"""
import json
import numpy as np
import qa_lib as Q

d = Q.load_data()
meta = d['meta']
dem = Q.Dem()
z = dem.elev
gz_y, gz_x = np.gradient(z.astype(np.float64), dem.dlat, dem.dlon)
mpd_lon = meta['mPerDegLon']
mpd_lat = meta['mPerDegLat']


def rows_for(shift_m=(0.0, 0.0)):
    rows = []
    for lk in d['lakes']:
        geom = lk['geom']
        g = np.asarray(max(geom, key=len), dtype=np.float64) if isinstance(geom[0][0], (list, tuple)) \
            else np.asarray(geom, dtype=np.float64)
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
        zs, gx, gy, yk = [], [], [], []
        ok = True
        for i in idx:
            px, py = x[i], y[i]
            lat, lon = Q.xy_to_latlon(meta, px / 1000.0, py / 1000.0)
            ze = dem.sample(np.array([lat]), np.array([lon]))[0]
            if np.isnan(ze):
                ok = False
                break
            r = int((dem.north - lat) / dem.dlat)
            c = int((lon - dem.west) / dem.dlon)
            r = min(max(r, 1), z.shape[0] - 2)
            c = min(max(c, 1), z.shape[1] - 2)
            zs.append(float(ze))
            gx.append(float(gz_x[r, c] / mpd_lon))
            gy.append(float(gz_y[r, c] / mpd_lat))
            yk.append(float(py) / 1000.0)
        if not ok or len(zs) < 10:
            continue
        zs = np.array(zs); gx = np.array(gx); gy = np.array(gy)
        gm = np.hypot(gx, gy)
        if np.median(gm) < 0.005:
            continue
        rows.append((zs, gx, gy, np.array(yk), lk['name'], float(zs.max() - zs.min())))
    return rows


def fit(rows):
    n = len(rows)
    total = sum(len(r[0]) for r in rows)
    A = np.zeros((total, n + 2))
    b = np.zeros(total)
    k = 0
    for li, (zs, gx, gy, yk, nm, sp) in enumerate(rows):
        m = len(zs)
        A[k:k + m, li] = 1.0
        A[k:k + m, n] = gx
        A[k:k + m, n + 1] = gy
        b[k:k + m] = zs
        k += m
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    resid = b - A @ sol
    return sol[-2], sol[-1], float(np.sqrt((resid ** 2).mean()))


base_rows = rows_for()
dx, dy, rms = fit(base_rows)
print('lakes used: %d' % len(base_rows))
print('baseline: delta = (E %+.1f, N %+.1f) m | %.1f m  azimuth %.0f deg  rms %.2f m' % (
    dx, dy, np.hypot(dx, dy), np.degrees(np.arctan2(dx, dy)) % 360, rms))
for sh in [(0, 25), (0, -25), (25, 0), (0, 50)]:
    sdx, sdy, srms = fit(rows_for(sh))
    print('  synthetic shift (%+d,%+d) -> recovered (%+.1f, %+.1f)  rms %.2f' % (sh[0], sh[1], sdx, sdy, srms))

# bootstrap CI
rng = np.random.default_rng(11)
ds = []
n = len(base_rows)
for _ in range(600):
    sel = rng.integers(0, n, n)
    dxb, dyb, _ = fit([base_rows[i] for i in sel])
    ds.append((dxb, dyb))
ds = np.array(ds)
print('bootstrap 95%% CI: E [%.1f, %.1f]  N [%.1f, %.1f]' % (
    np.percentile(ds[:, 0], 2.5), np.percentile(ds[:, 0], 97.5),
    np.percentile(ds[:, 1], 2.5), np.percentile(ds[:, 1], 97.5)))

# per-lake deltas and y-dependence
pts = []
for zs, gx, gy, yk, nm, sp in base_rows:
    A = np.stack([gx, gy], 1)
    Y = zs - zs.mean()
    s2, *_ = np.linalg.lstsq(A, Y, rcond=None)
    pts.append((float(np.mean(yk)), s2[0], s2[1], sp, nm))
pts_a = np.array([p[:4] for p in pts])
print('per-lake delta: median (E %+.1f, N %+.1f); ring spread median %.1f m' % (
    np.median(pts_a[:, 1]), np.median(pts_a[:, 2]), np.median(pts_a[:, 3])))
A = np.stack([pts_a[:, 0], np.ones(len(pts_a))], 1)
for j, lab in ((1, 'dE'), (2, 'dN')):
    sol, *_ = np.linalg.lstsq(A, pts_a[:, j], rcond=None)
    pred = A @ sol
    ss = 1 - ((pts_a[:, j] - pred) ** 2).sum() / max(((pts_a[:, j] - pts_a[:, j].mean()) ** 2).sum(), 1e-9)
    print('  %s = %+.3f m/km * y_km + %+.1f m (R2 %.2f)' % (lab, sol[0], sol[1], ss))

# robust: drop lakes with huge spread (>60 m)
keep = [p for p in pts if p[3] <= 60]
sel_rows = [base_rows[i] for i in range(len(base_rows)) if base_rows[i][5] <= 60]
dx2, dy2, rms2 = fit(sel_rows)
print('subset spread<=60m: n=%d  delta=(E %+.1f, N %+.1f) rms %.2f' % (len(sel_rows), dx2, dy2, rms2))
json.dump(dict(baseline=[dx, dy], lakes=len(base_rows), ci=[ds[:, 0].tolist(), ds[:, 1].tolist()]),
          open('res_check4e.json', 'w', encoding='utf-8'))
