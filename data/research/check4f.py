# -*- coding: utf-8 -*-
"""Check 4f: lake shoreline registration test, corrected gradient sign.
Model: ring vertex elev z_i = a_lake + grad_i . D, where D = displacement of the
VECTOR ring relative to the true (DEM) shoreline contour.
Calibration: inject synthetic shifts; recovery must match injection.
"""
import json
import numpy as np
import qa_lib as Q

d = Q.load_data()
meta = d['meta']
dem = Q.Dem()
z = dem.elev
gz_y, gz_x = np.gradient(z.astype(np.float64), dem.dlat, dem.dlon)
# rows run north->south: np.gradient(...,dlat) is dz/d(southward m) => flip for north
GX = gz_x / meta['mPerDegLon']     # dz/d(east m)
GY = -gz_y / meta['mPerDegLat']    # dz/d(north m)


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
            zs.append(float(ze)); gx.append(float(GX[r, c])); gy.append(float(GY[r, c]))
            yk.append(float(py) / 1000.0)
        if not ok or len(zs) < 10:
            continue
        zs = np.array(zs); gx = np.array(gx); gy = np.array(gy)
        if np.median(np.hypot(gx, gy)) < 0.005:
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
    return float(sol[-2]), float(sol[-1]), float(np.sqrt(((b - A @ sol) ** 2).mean()))


base = rows_for()
dx, dy, rms = fit(base)
print('lakes used: %d   ring spread median %.1f m' % (len(base), np.median([r[5] for r in base])))
print('baseline D (vector ring relative to DEM shoreline) = (E %+.1f, N %+.1f) m | %.1f m  az %.0f deg  rms %.2f' % (
    dx, dy, np.hypot(dx, dy), np.degrees(np.arctan2(dx, dy)) % 360, rms))
for sh in [(0, 25), (0, -25), (25, 0), (0, 50), (30, -30)]:
    a, b_, r_ = fit(rows_for(sh))
    print('  inject (%+d,%+d) -> recovered (%+.1f,%+.1f)  [delta=(%+.1f,%+.1f)]' % (
        sh[0], sh[1], a, b_, a - dx, b_ - dy))

rng = np.random.default_rng(11)
n = len(base)
ds = []
for _ in range(600):
    sel = rng.integers(0, n, n)
    a, b_, _ = fit([base[i] for i in sel])
    ds.append((a, b_))
ds = np.array(ds)
print('bootstrap 95%% CI: E [%.1f, %.1f]  N [%.1f, %.1f]' % (
    np.percentile(ds[:, 0], 2.5), np.percentile(ds[:, 0], 97.5),
    np.percentile(ds[:, 1], 2.5), np.percentile(ds[:, 1], 97.5)))

sel_rows = [r for r in base if r[5] <= 60]
a, b_, r_ = fit(sel_rows)
print('subset spread<=60m n=%d: D=(E %+.1f, N %+.1f) rms %.2f' % (len(sel_rows), a, b_, r_))
sel_rows2 = [r for r in base if r[5] <= 30]
a2, b2, r2 = fit(sel_rows2)
print('subset spread<=30m n=%d: D=(E %+.1f, N %+.1f) rms %.2f' % (len(sel_rows2), a2, b2, r2))

# per-lake median delta & y dependence
pts = []
for zs, gx, gy, yk, nm, sp in base:
    A = np.stack([gx, gy], 1)
    Y = zs - zs.mean()
    s2, *_ = np.linalg.lstsq(A, Y, rcond=None)
    pts.append((float(np.mean(yk)), s2[0], s2[1], sp))
P = np.array(pts)
print('per-lake D median (E %+.1f, N %+.1f)' % (np.median(P[:, 1]), np.median(P[:, 2])))
A = np.stack([P[:, 0], np.ones(len(P))], 1)
for j, lab in ((1, 'D_E'), (2, 'D_N')):
    sol, *_ = np.linalg.lstsq(A, P[:, j], rcond=None)
    pred = A @ sol
    ss = 1 - ((P[:, j] - pred) ** 2).sum() / max(((P[:, j] - P[:, j].mean()) ** 2).sum(), 1e-9)
    print('  %s = %+.3f m/km * y_km + %+.1f m (R2 %.2f)' % (lab, sol[0], sol[1], ss))
json.dump(dict(D=[dx, dy], n=len(base), subset60=[a, b_], subset30=[a2, b2],
               ci=[np.percentile(ds[:, 0], [2.5, 97.5]).tolist(), np.percentile(ds[:, 1], [2.5, 97.5]).tolist()]),
          open('res_check4f.json', 'w', encoding='utf-8'))
