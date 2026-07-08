#!/usr/bin/env node
/**
 * Estimate the local ground ELLIPSOIDAL height (metres) at each AV scene's anchor
 * by probing Google's Photorealistic 3D Tiles — the value baked into
 * `examples/showcase/src/datasets.ts` `AV_TILES3D_CONFIG[id].ground` to seat the
 * 3D-tiles overlay on the cockpit's LIDAR cloud (which sits at local z≈0).
 *
 * Why this exists: Google's mesh uses true WGS84 ellipsoidal heights, so the
 * cockpit must lower it by the local ground height to land it on the streets.
 * Rather than hand-tune every scene, we descend the tileset to the finest tiles
 * at the anchor and read the ground off their bounding volumes.
 *
 * Method (what made it accurate):
 *   • Descend by point-to-OBB distance toward the anchor, threading Google's
 *     `session` token (required, or deep subtree fetches 401) + `X-GOOG-API-KEY`.
 *   • For each fine tile near the anchor, take the bounding box BOTTOM
 *     (center height − vertical extent), NOT the center — the center sits ~half a
 *     building above ground; the bottom tracks the street.
 *   • Ground ≈ min bottom over the ~6 closest fine tiles, + a ~2 m correction
 *     (empirically the bottom reads ~1.5 m low vs the visually-aligned value).
 *
 * Accuracy: validated against three hand-tuned scenes — Miami −1.3 m, Detroit
 * −1.7 m (flat → spot on after the +2), Pittsburgh −9.8 m (HILLY: the sample spans
 * a slope, so hilly/complex scenes still want a small manual slider trim). nuScenes
 * Singapore high-rises are noisier still. Treat the output as a strong starting
 * point, then fine-tune in the cockpit ("3D tiles height" slider) and bake the
 * confirmed value.
 *
 * Usage:
 *   node scripts/estimate-3d-tiles-ground.mjs            # all known scenes
 *   node scripts/estimate-3d-tiles-ground.mjs <lon> <lat>  # an ad-hoc point
 * Needs VITE_GOOGLE_MAPS_API_KEY in examples/showcase/.env.local (Map Tiles API).
 */
import fs from 'node:fs';

const ENV_PATH = 'examples/showcase/.env.local';
const KEY = (() => {
  const m = fs
    .readFileSync(ENV_PATH, 'utf8')
    .match(/^VITE_GOOGLE_MAPS_API_KEY=(.+)$/m);
  if (!m) throw new Error(`VITE_GOOGLE_MAPS_API_KEY not found in ${ENV_PATH}`);
  return m[1].trim().replace(/^["']|["']$/g, '');
})();

const BASE = 'https://tile.googleapis.com';
const HEADERS = { 'X-GOOG-API-KEY': KEY };
const ROOT = '/v1/3dtiles/root.json';
const GROUND_CORRECTION_M = 2; // bottom reads ~1.5 m low vs visually-aligned value

// Scene anchors — keep in sync with AV_TILES3D_CONFIG in datasets.ts.
const SCENES = [
  ['argoverse-02678d04', -79.9333411419541, 40.45610620281625],
  ['argoverse-02a00399', -80.19521021126853, 25.81266355087901],
  ['argoverse-0b5142c1', -76.97901441961996, 38.903158674858965],
  ['argoverse-0bae3b5e', -83.05092955863113, 42.33371685760447],
  ['argoverse-25e5c600', -122.12833142762317, 37.415846217190214],
  ['argoverse-92b900b1', -97.70213668235851, 30.255713070218487],
  ['nuscenes-0061', 103.788327, 1.298281],
  ['nuscenes-0103', -71.049976, 42.351321],
  ['nuscenes-0553', -71.041856, 42.346179],
  ['nuscenes-0655', -71.035317, 42.344646],
  ['nuscenes-0757', -71.054096, 42.342856],
  ['nuscenes-0796', 103.783511, 1.301422],
  ['nuscenes-0916', 103.773608, 1.294315],
  ['nuscenes-1077', 103.788308, 1.316754],
  ['nuscenes-1094', 103.795698, 1.310148],
  ['nuscenes-1100', 103.794048, 1.307483],
  // Waymo is intentionally omitted — its anchor is an approximate local frame, so
  // the georeferenced photoreal mesh would never align with the cloud's streets.
];

const D2R = Math.PI / 180;
const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);

function geo2ecef(lon, lat, h) {
  const sl = Math.sin(lat * D2R);
  const cl = Math.cos(lat * D2R);
  const N = A / Math.sqrt(1 - E2 * sl * sl);
  return [
    (N + h) * cl * Math.cos(lon * D2R),
    (N + h) * cl * Math.sin(lon * D2R),
    (N * (1 - E2) + h) * sl,
  ];
}
function ecef2geo(x, y, z) {
  const b = A * (1 - F);
  const ep2 = (A * A - b * b) / (b * b);
  const p = Math.hypot(x, y);
  const th = Math.atan2(A * z, b * p);
  const lat = Math.atan2(
    z + ep2 * b * Math.sin(th) ** 3,
    p - E2 * A * Math.cos(th) ** 3,
  );
  const N = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  return [Math.atan2(y, x) / D2R, lat / D2R, p / Math.cos(lat) - N];
}
/** Clamped point-to-oriented-box distance (0 inside); 0..2 = center, 3..11 = half-axes. */
function distOBB(P, box) {
  const d = [P[0] - box[0], P[1] - box[1], P[2] - box[2]];
  let s = 0;
  for (const o of [
    [3, 4, 5],
    [6, 7, 8],
    [9, 10, 11],
  ]) {
    const u = [box[o[0]], box[o[1]], box[o[2]]];
    const ul = Math.hypot(...u);
    const ex = Math.abs((d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / ul) - ul;
    if (ex > 0) s += ex * ex;
  }
  return Math.sqrt(s);
}
const horizM = (lo, la, lo2, la2) =>
  Math.hypot((lo2 - lo) * 111320 * Math.cos(la * D2R), (la2 - la) * 111320);

/** Ellipsoidal height of an OBB's bottom face (center − extent along geodetic up). */
function bottomOf(box) {
  const c = ecef2geo(box[0], box[1], box[2]);
  const la = c[1] * D2R;
  const lo = c[0] * D2R;
  const cl = Math.cos(la);
  const up = [cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la)];
  const ext =
    Math.abs(box[3] * up[0] + box[4] * up[1] + box[5] * up[2]) +
    Math.abs(box[6] * up[0] + box[7] * up[1] + box[8] * up[2]) +
    Math.abs(box[9] * up[0] + box[10] * up[1] + box[11] * up[2]);
  return { bottom: c[2] - ext, lon: c[0], lat: c[1] };
}

let session = null;
function withAuth(uri) {
  const u = new URL(uri, BASE);
  if (u.searchParams.get('session')) session = u.searchParams.get('session');
  else if (session) u.searchParams.set('session', session);
  return u.toString();
}
async function fetchJson(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url.slice(0, 60)}`);
  return r.json();
}
/** Children of a tile, fetching its JSON subtree (and threading the session) if needed. */
async function childrenOf(tile) {
  let kids = (tile.children || []).filter((k) => k.boundingVolume?.box);
  if (kids.length || !tile.content?.uri) return kids;
  const r = await fetch(withAuth(tile.content.uri), { headers: HEADERS });
  if ((r.headers.get('content-type') || '').includes('json')) {
    const sub = await r.json();
    const root = sub.root || sub;
    kids = (root.children || [root]).filter((k) => k.boundingVolume?.box);
  }
  return kids;
}

async function estimateGround(lon, lat) {
  session = null;
  const P = geo2ecef(lon, lat, 0);
  let frontier = [{ tile: (await fetchJson(withAuth(ROOT))).root, d: 0 }];
  const samples = [];
  let reqs = 0;
  let iters = 0;
  while (frontier.length && reqs < 300 && iters < 6000) {
    iters++;
    frontier.sort((a, b) => a.d - b.d);
    const { tile } = frontier.shift();
    const b = bottomOf(tile.boundingVolume.box);
    const hd = horizM(lon, lat, b.lon, b.lat);
    if (tile.content?.uri && hd < 90 && tile.geometricError < 120) {
      samples.push({ ...b, gE: tile.geometricError, hd });
    }
    if (tile.geometricError < 6) continue;
    let kids;
    try {
      kids = await childrenOf(tile);
      reqs++;
    } catch {
      continue;
    }
    for (const k of kids) {
      const dd = distOBB(P, k.boundingVolume.box);
      if (dd < 700) frontier.push({ tile: k, d: dd });
    }
  }
  const fine = samples.filter((s) => s.gE < 10);
  const near = (fine.length ? fine : samples)
    .sort((a, b) => a.hd - b.hd)
    .slice(0, 6);
  if (!near.length) return null;
  return Math.min(...near.map((s) => s.bottom)) + GROUND_CORRECTION_M;
}

const args = process.argv.slice(2);
const targets =
  args.length >= 2 ? [['(adhoc)', Number(args[0]), Number(args[1])]] : SCENES;
for (const [id, lon, lat] of targets) {
  try {
    const g = await estimateGround(lon, lat);
    console.log(
      `${id.padEnd(20)} ground ≈ ${g === null ? '  (no tiles)' : g.toFixed(1).padStart(7)} m`,
    );
  } catch (e) {
    console.log(`${id.padEnd(20)} ERROR ${e.message}`);
  }
}
