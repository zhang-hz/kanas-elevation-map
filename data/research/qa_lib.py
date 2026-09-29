# -*- coding: utf-8 -*-
"""Shared helpers for Kanas road-network QA. Read-only w.r.t. project data."""
import json
import numpy as np

DATA_JS = r'C:\Data\Code\Kanas\web\data\kanas_data.js'
DEM_NPZ = r'C:\Data\Code\Kanas\data\dem\dem_z13.npz'
CURATED = r'C:\Data\Code\Kanas\data\curated.json'


def load_data():
    s = open(DATA_JS, encoding='utf-8').read().strip()
    s = s[len('window.KANAS_DATA = '):]
    if s.endswith(';'):
        s = s[:-1]
    return json.loads(s)


def load_curated():
    return json.load(open(CURATED, encoding='utf-8'))


class Dem:
    """Bilinear DEM sampler. lat/lon in degrees -> absolute elevation (m)."""

    def __init__(self):
        d = np.load(DEM_NPZ)
        self.elev = d['elev']            # rows north->south, cols west->east
        self.north = float(d['north'])
        self.south = float(d['south'])
        self.west = float(d['west'])
        self.east = float(d['east'])
        self.rows, self.cols = self.elev.shape
        self.dlat = (self.north - self.south) / (self.rows - 1)
        self.dlon = (self.east - self.west) / (self.cols - 1)

    def sample(self, lat, lon):
        """Bilinear sample; lat/lon may be scalars or arrays. NaN outside."""
        lat = np.asarray(lat, dtype=np.float64)
        lon = np.asarray(lon, dtype=np.float64)
        r = (self.north - lat) / self.dlat
        c = (lon - self.west) / self.dlon
        r0 = np.floor(r).astype(np.int64)
        c0 = np.floor(c).astype(np.int64)
        valid = (r0 >= 0) & (c0 >= 0) & (r0 < self.rows - 1) & (c0 < self.cols - 1)
        out = np.full(lat.shape, np.nan, dtype=np.float64)
        if not valid.any():
            return out if out.shape else np.nan
        r0v = np.clip(r0, 0, self.rows - 2)
        c0v = np.clip(c0, 0, self.cols - 2)
        fr = r - r0v
        fc = c - c0v
        e = self.elev
        v = (e[r0v, c0v] * (1 - fr) * (1 - fc)
             + e[r0v, c0v + 1] * (1 - fr) * fc
             + e[r0v + 1, c0v] * fr * (1 - fc)
             + e[r0v + 1, c0v + 1] * fr * fc)
        out = np.where(valid, v, np.nan)
        return out if out.shape else float(out)


# meta helpers -------------------------------------------------------------
def meta_of(d):
    return d['meta']


def xy_to_latlon(meta, x_km, y_km):
    lat = meta['lat0'] + np.asarray(y_km) * 1000.0 / meta['mPerDegLat']
    lon = meta['lon0'] + np.asarray(x_km) * 1000.0 / meta['mPerDegLon']
    return lat, lon


def latlon_to_xy(meta, lat, lon):
    x_km = (np.asarray(lon) - meta['lon0']) * meta['mPerDegLon'] / 1000.0
    y_km = (np.asarray(lat) - meta['lat0']) * meta['mPerDegLat'] / 1000.0
    return x_km, y_km


def xy_to_m(meta, x_km, y_km):
    """Local km coords -> local meters (x east, y north)."""
    return np.asarray(x_km) * 1000.0, np.asarray(y_km) * 1000.0


# Spatial index over way vertices (for distance queries) -------------------
class WayPoints:
    """Flat array of all way vertices in meters + mapping to (way, vertex)."""

    def __init__(self, d):
        meta = d['meta']
        pts = []
        wid = []
        vid = []
        for wi, w in enumerate(d['ways']):
            g = np.asarray(w['geom'], dtype=np.float64)
            for vi in range(len(g)):
                pts.append(g[vi])
                wid.append(wi)
                vid.append(vi)
        self.pts_km = np.asarray(pts)
        self.pts_m = self.pts_km * 1000.0
        self.wid = np.asarray(wid)
        self.vid = np.asarray(vid)
        self.meta = meta

    def build_grid(self, cell=200.0):
        """Grid hash in meters."""
        self.cell = cell
        self.grid = {}
        idx = np.floor(self.pts_m / cell).astype(np.int64)
        for i in range(len(self.pts_m)):
            key = (idx[i, 0], idx[i, 1])
            self.grid.setdefault(key, []).append(i)
        self._idx = idx

    def query_radius(self, x_m, y_m, r_m):
        """Return indices of way-vertices within r_m of (x_m, y_m)."""
        c = self.cell
        i0 = int(np.floor((x_m - r_m) / c)); i1 = int(np.floor((x_m + r_m) / c))
        j0 = int(np.floor((y_m - r_m) / c)); j1 = int(np.floor((y_m + r_m) / c))
        cand = []
        for i in range(i0, i1 + 1):
            for j in range(j0, j1 + 1):
                lst = self.grid.get((i, j))
                if lst:
                    cand.extend(lst)
        if not cand:
            return np.empty(0, dtype=np.int64)
        cand = np.asarray(cand, dtype=np.int64)
        dx = self.pts_m[cand, 0] - x_m
        dy = self.pts_m[cand, 1] - y_m
        keep = (dx * dx + dy * dy) <= r_m * r_m
        return cand[keep]


def dist_matrix(a, b):
    """pairwise distances between two (n,2)/(m,2) meter arrays."""
    return np.sqrt(((a[:, None, :] - b[None, :, :]) ** 2).sum(-1))
