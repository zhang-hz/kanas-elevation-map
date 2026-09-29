# -*- coding: utf-8 -*-
"""Check 4c: verdict on systematic horizontal offset.
(a) river/stream cross-profile offset: bootstrap CI of mean vector, sign test,
    well-defined-channel subset, profile-edge exclusions.
(b) independent lake-shoreline registration test:
    lake ring vertices should be a flat contour in DEM. If the vector data is
    shifted by (dx,dy) vs DEM, ring elevations vary with the outward normal as
    z_i - a_lake = g_i * (n_i . delta), with g_i = terrain gradient magnitude.
    Joint least squares over many lakes -> estimate of delta.
"""
import json
import numpy as np
import qa_lib as Q

d = Q.load_data()
meta = d['meta']
dem = Q.Dem()

# ---------------- (a) river offsets: stats on check4b recs ----------------
for tag in ('river', 'stream'):
    recs = json.load(open('res_check4_%s.json' % tag, encoding='utf-8'))
    vx = np.array([r['vx'] for r in recs])
    vy = np.array([r['vy'] for r in recs])
    off = np.array([r['lat_off'] for r in recs])  # from check4 (coarse); recompute mag
    diff = np.array([r['diff'] for r in recs])
    relief = np.array([r['relief'] for r in recs])
    mag = np.hypot(vx, vy)
    rng = np.random.default_rng(7)
    n = len(vx)
    boots = []
    for _ in range(2000):
        s = rng.integers(0, n, n)
        boots.append([vx[s].mean(), vy[s].mean()])
    boots = np.array(boots)
    ci = np.percentile(boots, [2.5, 97.5], axis=0)
    print('=== %s offset vector stats (n=%d) ===' % (tag, n))
    print('  mean (E,N) = (%+.1f, %+.1f) m ; 95%% CI E [%.1f, %.1f]  N [%.1f, %.1f]' % (
        vx.mean(), vy.mean(), ci[0, 0], ci[1, 0], ci[0, 1], ci[1, 1]))
    k_neg = int((vy < 0).sum())
    zsc = (k_neg - n * 0.5) / np.sqrt(n * 0.25)   # normal approx of binomial
    pval = float(np.math.erfc(abs(zsc) / np.sqrt(2))) if hasattr(np, 'math') else float(
        __import__('math').erfc(abs(zsc) / np.sqrt(2)))
    print('  sign test: frac(vy<0)=%.2f  frac(vx>0)=%.2f  z=%.2f  p=%.2e' % (
        (vy < 0).mean(), (vx > 0).mean(), zsc, pval))
    # well-defined channel subset: relief>=30m, interior min (|off|<245), min not at profile edge
    sub = (relief >= 30) & (np.abs(off) <= 200)
    print('  subset relief>=30m & interior min: n=%d' % sub.sum())
    if sub.sum() > 10:
        svx, svy = vx[sub], vy[sub]
        print('    mean (E,N) = (%+.1f, %+.1f)  median (E,N) = (%+.1f, %+.1f)  |off| med %.1f' % (
            svx.mean(), svy.mean(), np.median(svx), np.median(svy), np.median(mag[sub])))
        u = np.stack([svx, svy], 1) / np.maximum(mag[sub], 1e-9)[:, None]
        print('    R=%.2f  frac(vy<0)=%.2f' % (np.hypot(u[:, 0].mean(), u[:, 1].mean()), (svy < 0).mean()))
    print()

# ---------------- (b) lake shoreline registration test -------------------
print('=== lake shoreline registration test ===')
lakes = d['lakes']
# gradient magnitude helper from DEM
z = dem.elev
gz_y, gz_x = np.gradient(z.astype(np.float64), dem.dlat, dem.dlon)  # per degree
# convert to per-meter: dz/dx_m = gz_x / (mPerDegLon), dz/dy_m = gz_y / (mPerDegLat)
mpd_lon = meta['mPerDegLon']
mpd_lat = meta['mPerDegLat']

rows = []
used_lakes = 0
for lk in lakes:
    ring = lk['geom']
    if not ring:
        continue
    g = np.asarray(ring[0] if isinstance(ring[0][0], (list, tuple)) else ring, dtype=np.float64)
    # geom: [ring, ...] possibly multiple rings; take outer
    if isinstance(lk['geom'][0][0], (list, tuple)):
        g = np.asarray(max(lk['geom'], key=len), dtype=np.float64)
    else:
        g = np.asarray(lk['geom'], dtype=np.float64)
    if len(g) < 12:
        continue
    # area filter (km^2)
    x = g[:, 0] * 1000.0
    y = g[:, 1] * 1000.0
    area = 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))
    if area < 20000 or area > 5e7:      # 0.02 - 50 km^2
        continue
    idx = np.linspace(0, len(g) - 1, min(40, len(g))).astype(int)
    cx, cy = x.mean(), y.mean()
    zs = []
    gs = []
    nxs = []
    nys = []
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
        # gradient magnitude at this pixel
        r = int((dem.north - lat) / dem.dlat)
        c = int((lon - dem.west) / dem.dlon)
        r = min(max(r, 1), z.shape[0] - 2)
        c = min(max(c, 1), z.shape[1] - 2)
        dxx = gz_x[r, c] / mpd_lon
        dyy = gz_y[r, c] / mpd_lat
        gmag = np.hypot(dxx, dyy)
        zs.append(float(ze)); gs.append(float(gmag)); nxs.append(nx); nys.append(ny)
    if not ok or len(zs) < 10:
        continue
    zs = np.array(zs); gs = np.array(gs); nxs = np.array(nxs); nys = np.array(nys)
    if np.median(gs) < 0.005:   # nearly flat shore -> no leverage
        continue
    spread = float(zs.max() - zs.min())
    used_lakes += 1
    rows.append((zs, gs, nxs, nys, lk['name'], spread))

print('lakes used: %d' % used_lakes)
if rows:
    # joint least squares: z_i = a_lake + g_i*(nx_i*dx + ny_i*dy)
    n_lakes = len(rows)
    total = sum(len(r[0]) for r in rows)
    A = np.zeros((total, n_lakes + 2))
    b = np.zeros(total)
    k = 0
    for li, (zs, gs, nxs, nys, nm, sp) in enumerate(rows):
        m = len(zs)
        A[k:k + m, li] = 1.0
        A[k:k + m, n_lakes] = gs * nxs
        A[k:k + m, n_lakes + 1] = gs * nys
        b[k:k + m] = zs
        k += m
    sol, res, rank, sv = np.linalg.lstsq(A, b, rcond=None)
    dx, dy = sol[-2], sol[-1]
    resid = b - A @ sol
    print('joint LSQ shift delta = (E %+.1f m, N %+.1f m)  |delta| %.1f m  azimuth %.0f deg' % (
        dx, dy, np.hypot(dx, dy), np.degrees(np.arctan2(dx, dy)) % 360))
    print('rms residual %.2f m (per-vertex elevation spread around rings median %.1f m)' % (
        np.sqrt((resid ** 2).mean()), np.median([r[5] for r in rows])))
    # per-lake bootstrapped delta
    rng = np.random.default_rng(3)
    ds = []
    for _ in range(400):
        sel = rng.integers(0, n_lakes, n_lakes)
        A2 = np.zeros((total, 2)); b2 = np.zeros(total)
        k = 0
        # simpler: center each lake's z by its mean, stack
        zz = []
        XX = []
        for li in sel:
            zs, gs, nxs, nys, nm, sp = rows[li]
            zc = zs - zs.mean()
            XX.append(np.stack([gs * nxs, gs * nys], 1))
            zz.append(zc)
        X = np.concatenate(XX); Y = np.concatenate(zz)
        s2, *_ = np.linalg.lstsq(X, Y, rcond=None)
        ds.append(s2)
    ds = np.array(ds)
    print('bootstrap 95%% CI: E [%.1f, %.1f]  N [%.1f, %.1f]' % (
        np.percentile(ds[:, 0], 2.5), np.percentile(ds[:, 0], 97.5),
        np.percentile(ds[:, 1], 2.5), np.percentile(ds[:, 1], 97.5)))
    # per-lake individual delta for outliers
    print('per-lake ring elevation spread (m): median %.1f  p90 %.1f' % (
        np.median([r[5] for r in rows]), np.percentile([r[5] for r in rows], 90)))
    big = sorted(rows, key=lambda r: -r[5])[:10]
    for zs, gs, nxs, nys, nm, sp in big:
        X = np.stack([gs * nxs, gs * nys], 1)
        Y = zs - zs.mean()
        s2, *_ = np.linalg.lstsq(X, Y, rcond=None)
        print('  lake %-12s spread %5.1f m  individual delta (%+5.1f,%+5.1f)' % (nm[:12], sp, s2[0], s2[1]))
