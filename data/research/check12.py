# -*- coding: utf-8 -*-
"""Check 1: connectivity.  Check 2: suspected breaks (15-60m gaps)."""
import json
import numpy as np
import qa_lib as Q

d = Q.load_data()
meta = d['meta']
ways = d['ways']
nodes = d['graph']['nodes']
edges = d['graph']['edges']
N = len(nodes)

# ---------- union-find over graph ----------
parent = list(range(N))
def find(a):
    while parent[a] != a:
        parent[a] = parent[parent[a]]
        a = parent[a]
    return a
def union(a, b):
    ra, rb = find(a), find(b)
    if ra != rb:
        parent[ra] = rb

deg = np.zeros(N, dtype=np.int32)
for u, v, wi, *_ in edges:
    union(u, v)
    deg[u] += 1
    deg[v] += 1

comp = {}
for i in range(N):
    comp.setdefault(find(i), []).append(i)
sizes = sorted(((len(v), k) for k, v in comp.items()), reverse=True)
print('=== connectivity ===')
print('nodes', N, 'edges', len(edges), 'components', len(comp))
print('top component sizes:', [s for s, _ in sizes[:10]])
main_root = sizes[0][1]
main_nodes = set(comp[main_root])

# isolated edges: edges whose endpoints are both outside the main component
isolated_edges = [e for e in edges if e[0] not in main_nodes and e[1] not in main_nodes]
print('edges outside main component:', len(isolated_edges))
# group isolated edges by component, and summarize per way
iso_by_comp = {}
for e in isolated_edges:
    iso_by_comp.setdefault(find(e[0]), []).append(e)

iso_report = []
for root, es in sorted(iso_by_comp.items(), key=lambda kv: -len(kv[1])):
    waylen = {}
    for e in es:
        waylen.setdefault(e[2], 0.0)
        waylen[e[2]] += e[5]
    ns = comp[root]
    pts = np.array([[nodes[i][0], nodes[i][1]] for i in ns])
    lat, lon = Q.xy_to_latlon(meta, pts[:, 0], pts[:, 1])
    for wi, L in sorted(waylen.items(), key=lambda kv: -kv[1]):
        w = ways[wi]
        g = np.asarray(w['geom'])
        glat, glon = Q.xy_to_latlon(meta, g[:, 0], g[:, 1])
        iso_report.append(dict(
            comp_size=len(ns), n_edges=len(es), way_id=w['id'], name=w['name'], cls=w['cls'],
            way_len=w['len'], len_in_comp=round(L, 1),
            n_comp_nodes=len(ns),
            lat=round(float(np.mean(glat)), 5), lon=round(float(np.mean(glon)), 5),
            start=[round(float(glat[0]), 5), round(float(glon[0]), 5)],
            end=[round(float(glat[-1]), 5), round(float(glon[-1]), 5)],
        ))
print('isolated way entries:', len(iso_report))
json.dump(dict(n_components=len(comp), comp_sizes=[s for s, _ in sizes],
               iso=iso_report), open('res_conn.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

# also: edges in non-main components but straddling (one end main) -> inconsistent graph
straddle = [e for e in edges if (e[0] in main_nodes) != (e[1] in main_nodes)]
print('straddling edges (one end in main comp):', len(straddle))

# ---------- dangling endpoints ----------
# map: way vertex list per way, in meters
wp = Q.WayPoints(d)
wp.build_grid(200.0)
# node -> ways touching (from edges)
node_ways = {}
for u, v, wi, *_ in edges:
    node_ways.setdefault(u, set()).add(wi)
    node_ways.setdefault(v, set()).add(wi)

dangle = []
for i in range(N):
    if deg[i] != 1:
        continue
    x_m, y_m = nodes[i][0] * 1000.0, nodes[i][1] * 1000.0
    cand = wp.query_radius(x_m, y_m, 80.0)
    own = node_ways.get(i, set())
    near_other = False
    for c in cand:
        if wp.wid[c] not in own:
            near_other = True
            break
    if near_other:
        continue
    # also compute true distance to nearest vertex of any other way (search wider)
    best = None
    for r in (80.0, 300.0):
        cand2 = wp.query_radius(x_m, y_m, r)
        if len(cand2):
            dm = np.sqrt(((wp.pts_m[cand2] - np.array([x_m, y_m])) ** 2).sum(1))
            mask = np.array([wp.wid[c] not in own for c in cand2])
            if mask.any():
                best = float(dm[mask].min())
                break
    wi = list(own)[0] if own else -1
    w = ways[wi] if wi >= 0 else None
    lat, lon = Q.xy_to_latlon(meta, nodes[i][0], nodes[i][1])
    dangle.append(dict(node=i, way_id=w['id'] if w else None, name=w['name'] if w else '',
                       cls=w['cls'] if w else '', lat=round(float(lat), 5), lon=round(float(lon), 5),
                       dist_other=best if best is not None else None))

print('degree-1 nodes total:', int((deg == 1).sum()), ' dangling (>80m to other ways):', len(dangle))

# cluster dangling ends within 500 m
used = [False] * len(dangle)
clusters = []
pts = np.array([[x['lon'], x['lat']] for x in dangle]) if dangle else np.zeros((0, 2))
for i in range(len(dangle)):
    if used[i]:
        continue
    stack = [i]; used[i] = True; cl = []
    while stack:
        k = stack.pop(); cl.append(dangle[k])
        for j in range(len(dangle)):
            if not used[j]:
                # ~meters
                dx = (pts[j, 0] - pts[k, 0]) * meta['mPerDegLon']
                dy = (pts[j, 1] - pts[k, 1]) * meta['mPerDegLat']
                if dx * dx + dy * dy <= 500.0 ** 2:
                    used[j] = True; stack.append(j)
    clusters.append(cl)
clusters.sort(key=len, reverse=True)
print('dangling clusters:', len(clusters))
top = []
for cl in clusters[:25]:
    lats = [c['lat'] for c in cl]; lons = [c['lon'] for c in cl]
    top.append(dict(n=len(cl), lat=round(float(np.mean(lats)), 5), lon=round(float(np.mean(lons)), 5),
                    ways=sorted({(c['way_id'], c['name']) for c in cl})[:6],
                    members=[{k: c[k] for k in ('way_id', 'name', 'cls', 'lat', 'lon', 'dist_other')} for c in cl[:8]]))
for t in top[:20]:
    print(' cluster n=%d at (%.5f, %.5f) ways=%s' % (t['n'], t['lat'], t['lon'], t['ways'][:3]))
json.dump(dict(dangle_n=len(dangle), clusters=top), open('res_dangle.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

# ---------- Check 2: suspected breaks ----------
# way endpoints in meters
ends = []  # (wayIdx, 0|1, x_m, y_m)
for wi, w in enumerate(ways):
    g = np.asarray(w['geom'], dtype=np.float64)
    ends.append((wi, 0, g[0, 0] * 1000, g[0, 1] * 1000))
    ends.append((wi, 1, g[-1, 0] * 1000, g[-1, 1] * 1000))
ends = np.array(ends)

# connectivity of ways through graph: build way adjacency via shared graph node
way_comp = list(range(len(ways)))
def find2(a):
    while way_comp[a] != a:
        way_comp[a] = way_comp[way_comp[a]]
        a = way_comp[a]
    return a
node_of_ways = {}
for u, v, wi, *_ in edges:
    node_of_ways.setdefault(u, []).append(wi)
    node_of_ways.setdefault(v, []).append(wi)
for n, wl in node_of_ways.items():
    for k in range(1, len(wl)):
        ra, rb = find2(wl[0]), find2(wl[k])
        if ra != rb:
            way_comp[ra] = rb

pairs = []
n = len(ends)
# brute force with grid
cell = 100.0
grid = {}
for i in range(n):
    key = (int(ends[i, 2] // cell), int(ends[i, 3] // cell))
    grid.setdefault(key, []).append(i)
seen = set()
for i in range(n):
    kx, ky = int(ends[i, 2] // cell), int(ends[i, 3] // cell)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for j in grid.get((kx + dx, ky + dy), []):
                if j <= i:
                    continue
                if ends[i, 0] == ends[j, 0]:
                    continue
                dist = float(np.hypot(ends[i, 2] - ends[j, 2], ends[i, 3] - ends[j, 3]))
                if 15.0 <= dist <= 60.0:
                    if find2(int(ends[i, 0])) == find2(int(ends[j, 0])):
                        continue  # already connected elsewhere in network
                    key = (int(ends[i, 0]), int(ends[j, 0]))
                    if key in seen:
                        continue
                    seen.add(key)
                    wi, wj = ways[int(ends[i, 0])], ways[int(ends[j, 0])]
                    lati, loni = Q.xy_to_latlon(meta, ends[i, 2] / 1000, ends[i, 3] / 1000)
                    latj, lonj = Q.xy_to_latlon(meta, ends[j, 2] / 1000, ends[j, 3] / 1000)
                    pairs.append(dict(dist=round(dist, 1),
                                      a=dict(way_id=wi['id'], name=wi['name'], cls=wi['cls'],
                                             lat=round(float(lati), 5), lon=round(float(loni), 5),
                                             end=('start' if ends[i, 1] == 0 else 'end')),
                                      b=dict(way_id=wj['id'], name=wj['name'], cls=wj['cls'],
                                             lat=round(float(latj), 5), lon=round(float(lonj), 5),
                                             end=('start' if ends[j, 1] == 0 else 'end'))))
pairs.sort(key=lambda p: p['dist'])
print('=== suspected breaks (15-60m, different network components) ===')
print('count:', len(pairs))
for p in pairs[:30]:
    print(' %5.1f m  way %d (%s) [%s] <-> way %d (%s) [%s]  at (%.5f,%.5f)' % (
        p['dist'], p['a']['way_id'], p['a']['cls'], p['a']['name'], p['b']['way_id'], p['b']['cls'], p['b']['name'],
        p['a']['lat'], p['a']['lon']))
json.dump(pairs, open('res_breaks.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
