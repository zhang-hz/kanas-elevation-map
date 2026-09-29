# -*- coding: utf-8 -*-
"""Check 3: geometry / elevation anomalies."""
import json
import numpy as np
import qa_lib as Q

d = Q.load_data()
meta = d['meta']
ways = d['ways']
dem = Q.Dem()
ABS = meta['datum']['elevAbs']


def pos_at(geom, darr, dist):
    """lat/lon at along-way distance `dist` (meters), via geom polyline."""
    g = np.asarray(geom, dtype=np.float64) * 1000.0  # meters
    seg = np.hypot(np.diff(g[:, 0]), np.diff(g[:, 1]))
    cum = np.concatenate([[0], np.cumsum(seg)])
    if dist <= 0:
        p = g[0]
    elif dist >= cum[-1]:
        p = g[-1]
    else:
        k = int(np.searchsorted(cum, dist) - 1)
        k = max(0, min(k, len(seg) - 1))
        t = (dist - cum[k]) / seg[k] if seg[k] > 0 else 0
        p = g[k] + (g[k + 1] - g[k]) * t
    lat, lon = Q.xy_to_latlon(meta, p[0] / 1000.0, p[1] / 1000.0)
    return float(lat), float(lon)


steep = []    # grade > 45%
spikes = []   # 2nd difference > 25 m
dem_dev = []  # sampled start/mid/end deviation > 8 m
dev_all = []  # all sampled deviations for stats

for w in ways:
    darr = np.asarray(w['d'], dtype=np.float64)
    earr = np.asarray(w['e'], dtype=np.float64)
    if len(darr) < 2:
        continue
    dd = np.diff(darr)
    de = np.diff(earr)
    with np.errstate(divide='ignore', invalid='ignore'):
        grade = np.abs(de) / np.where(dd > 0, dd, np.nan)
    bad = np.where(grade > 0.45)[0]
    for i in bad:
        lat, lon = pos_at(w['geom'], darr, float(darr[i]))
        steep.append(dict(way_id=w['id'], name=w['name'], cls=w['cls'],
                          lat=round(lat, 5), lon=round(lon, 5),
                          d=round(float(darr[i]), 1), grade=round(float(grade[i]) * 100, 1),
                          de=round(float(de[i]), 1), dd=round(float(dd[i]), 1),
                          e=round(float(earr[i]), 1)))
    if len(earr) >= 3:
        sd = earr[:-2] - 2 * earr[1:-1] + earr[2:]
        # equivalent: deviation of mid point from average of neighbours
        badi = np.where(np.abs(sd) > 25.0)[0]
        for i in badi:
            j = i + 1
            lat, lon = pos_at(w['geom'], darr, float(darr[j]))
            spikes.append(dict(way_id=w['id'], name=w['name'], cls=w['cls'],
                               lat=round(lat, 5), lon=round(lon, 5),
                               d=round(float(darr[j]), 1), e=round(float(earr[j]), 1),
                               e_prev=round(float(earr[j - 1]), 1), e_next=round(float(earr[j + 1]), 1),
                               second_diff=round(float(sd[i]), 1)))
    # DEM comparison at start / mid / end
    L = float(darr[-1])
    for label, dist in (('start', 0.0), ('mid', L / 2), ('end', L)):
        lat, lon = pos_at(w['geom'], darr, dist)
        de_abs = float(dem.sample(np.array([lat]), np.array([lon]))[0])
        # interpolate way e at dist
        ew = float(np.interp(dist, darr, earr))
        dev = (ew + ABS) - de_abs  # way abs elevation - DEM abs
        dev_all.append(dev)
        if abs(dev) > 8.0:
            dem_dev.append(dict(way_id=w['id'], name=w['name'], cls=w['cls'], where=label,
                                lat=round(lat, 5), lon=round(lon, 5), d=round(dist, 1),
                                e_way=round(ew + ABS, 1), e_dem=round(de_abs, 1),
                                dev=round(dev, 1)))

steep.sort(key=lambda r: -r['grade'])
spikes.sort(key=lambda r: -abs(r['second_diff']))
dem_dev.sort(key=lambda r: -abs(r['dev']))
print('=== check3 ===')
print('steep segments grade>45%%:', len(steep), ' distinct ways:', len({r["way_id"] for r in steep}))
for r in steep[:25]:
    print('  way %d (%s,%s) grade %.0f%% at (%.5f,%.5f) d=%.0fm de=%.1fm/%.1fm' % (
        r['way_id'], r['cls'], r['name'], r['grade'], r['lat'], r['lon'], r['d'], r['de'], r['dd']))
print()
print('elevation spikes |2nd diff|>25m:', len(spikes), ' distinct ways:', len({r["way_id"] for r in spikes}))
for r in spikes[:25]:
    print('  way %d (%s,%s) 2nd=%.1fm e=%.1f (%.1f/%.1f) at (%.5f,%.5f) d=%.0fm' % (
        r['way_id'], r['cls'], r['name'], r['second_diff'], r['e'], r['e_prev'], r['e_next'], r['lat'], r['lon'], r['d']))
print()
da = np.array(dev_all)
print('DEM deviation stats (way-DEM, start/mid/end of every way, n=%d):' % len(da))
print('  mean %.2f  median %.2f  p05 %.2f  p95 %.2f  min %.2f  max %.2f' % (
    da.mean(), np.median(da), np.percentile(da, 5), np.percentile(da, 95), da.min(), da.max()))
print('  |dev|>8m count:', len(dem_dev), ' >15m:', int((np.abs(da) > 15).sum()))
for r in dem_dev[:30]:
    print('  way %d (%s,%s) %s dev %+.1fm (way %.1f vs dem %.1f) at (%.5f,%.5f)' % (
        r['way_id'], r['cls'], r['name'], r['where'], r['dev'], r['e_way'], r['e_dem'], r['lat'], r['lon']))
json.dump(dict(steep=steep, spikes=spikes, dem_dev=dem_dev,
               dem_stats=dict(n=len(da), mean=float(da.mean()), median=float(np.median(da)),
                              p05=float(np.percentile(da, 5)), p95=float(np.percentile(da, 95)),
                              min=float(da.min()), max=float(da.max()))),
          open('res_check3.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
