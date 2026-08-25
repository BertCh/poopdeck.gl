/**
 * Dataset ↔ archive reconciliation test.
 *
 * The showcase registry (`src/datasets.ts`) hand-authors the playback framing of
 * every demo — `timeRange`, `timeWindow`, `wakeLength` — as literals that MUST
 * track the archive they animate. Several of those literals are governed only by
 * a source comment ("MUST bracket the simulation window baked into the archive",
 * "timeWindow is set to 2× that", …). This test turns that class of comment-only
 * invariant into a real, hard-failing check by reconciling each dataset against
 * the archive characteristics that are available LOCALLY in the repo.
 *
 * Fixture sources (in priority order), both read from disk, never the network:
 *   1. The build-time density sidecar `public/density/<stem>.json`
 *      (emitted by crates/stt-core/examples/density-profile.rs; carries
 *      `timeRange`, `bucketMs`, `featureCount`). These are git-TRACKED, so they
 *      run in CI. `<stem>` is the archive segment of the dataset url, resolved
 *      by the same `profileIdFromUrl` the UnderTheHood panel uses.
 *   2. Fallback: the packed `manifest.json` the dataset url points at
 *      (`metadata.time_range` / `metadata.temporal_bucket_ms`). The packed
 *      dataset dirs are git-IGNORED, so these are present in local dev only —
 *      absent in CI, where the dataset is simply skipped. This fallback is what
 *      reconciles the AV / composite demos whose nested url
 *      (`/data/<id>/lidar/manifest.json`) has no density sidecar.
 *
 * COVERAGE HONESTY: a dataset with no local fixture is never silently passed —
 * the final "coverage summary" case logs it by id with an explicit reason and
 * counts it. That case enumerates: N reconciled, M skipped (no fixture), every
 * skip reason, and every inconsistency the run caught.
 *
 * Assertions per reconciled dataset (each names demo / expected-archive /
 * actual-dataset value):
 *   (a) dataset.timeRange reconciled against fixture.timeRange within
 *       tol = max(bucketMs, 1% of span, 1000ms). Classified, not blindly
 *       diffed:
 *         · authored pokes OUTSIDE the archive extent (start < archive.start−tol
 *           OR end > archive.end+tol) → dead-air / renders-blank HAZARD → HARD
 *           FAIL (av-synthetic, satellites, ecco-currents drift class).
 *         · authored is a strict IN-BOUNDS subset (trims inside the archive,
 *           without poking out) → a deliberate editorial sub-window → recorded
 *           as an informational note, NOT a failure. This preserves intentional
 *           trims (nyc-rideshare's ~2h Jan-1 window inside a full-January
 *           archive; osm-nyc-changesets' 2007→2026 view inside a 2005→2026
 *           archive).
 *         · within tol on both ends → silent pass.
 *   (b) dataset.timeWindow is a positive finite number. (A sub-bucket window —
 *       legitimate for trip-heads demos like gtfs-nl — is reported as an
 *       informational note, not a failure.)
 *   (c) when wakeLength is set: wakeLength·2 ≤ timeWindow, so the tile loader
 *       still covers the trailing half of the comet wake (see
 *       TimeFilterExtension.wakeLength). A HARD failure — it catches real drift
 *       (e.g. an earlier ship-traffic wake that outran its authored window).
 *
 * ── the CAMERA / ORDERING half (second describe) ───────────────────────────
 *
 * Checks (a)–(c) only ever opened the PRIMARY `d.url`, so the nine storm4d
 * overlay archives were never read at all, and nothing in the file could catch
 * a zoom, bbox, blob-ordering or pitch mismatch. The second describe closes
 * both gaps: it walks EVERY archive-bearing url on the dataset (`url` plus every
 * `*Url` field pointing at a `manifest.json` — the `.json` telemetry/camera
 * sidecars are excluded by that same filter) and asserts:
 *   (d) the demo's opening camera zoom, floored the way
 *       SpatioTemporalLayer.getZoomLevel floors it, is inside each archive's
 *       [min_zoom, max_zoom]. Above max_zoom is the benign, deliberate case
 *       (deep-dive framings over-zoom the deepest tier on purpose), so it is an
 *       informational note; BELOW min_zoom is the hazard and fails — the layer
 *       clamps up to min_zoom and the loader then enumerates a whole-world box
 *       at a zoom the camera never asked for.
 *   (e) the camera centre lies inside `metadata.bounds`. A centre outside the
 *       archive extent is the "renders blank / camera parked over the previous
 *       scene" class, so it is a HARD failure. Whole-world archives and globe
 *       demos pass trivially.
 *   (f) `blobOrdering === 'time-major'` on every multi-bucket archive of a
 *       dataset that authors `targetPlaybackSeconds` — i.e. anything that
 *       PLAYS. Any other layout (`spatial`, `hilbert3`, …) interleaves one
 *       bucket's tiles with every other bucket's bytes, so a time-ordered
 *       range read becomes a scatter-gather / over-read, the buffered ranges
 *       come back empty and the playhead stalls with no error anywhere. Hard
 *       failure; see the `--blob-ordering time-major` rule in
 *       docs/roadmap/tile-loading-3d-2026-07.md §5 wave 4. (It used to reject
 *       only the literal `'spatial'`, which let `nwm-rivers-2019`'s `hilbert3`
 *       through — tile-loading audit 2026-08 F5.) A single-bucket archive is
 *       exempt: there is nothing to interleave.
 *   (g) every authored `maxPitch` (view-state or `timeHeight`) is ≤ 70. Past
 *       71.57° at deck's default `altitude: 1.5` the top screen ray clears the
 *       horizon, `unproject` returns a point behind the camera, and the viewport
 *       lon/lat box the tile loader selects against inverts — zero tiles on the
 *       latitude axis, a near-whole-world column span on the longitude axis.
 *       docs/roadmap/tile-loading-3d-2026-07.md §1/§4 is the account.
 *   (g′) the terrain (`MapboxOverlay`) map path in DemoViewer falls back to
 *       `MAX_SAFE_PITCH` for `maxPitch` — (g) reads the registry, so a
 *       map-level default of 85 (which shipped, latent, audit F10) was
 *       invisible to it. Source-level contract on DemoViewer.tsx.
 *
 * ── the HORIZON-FEASIBILITY half (third describe) ─────────────────────────
 *
 *   (h) for every archive a playing demo mounts, the prefetch horizon the
 *       loader will PLAN at the shipped camera fits the per-archive tile cap,
 *       and the steady-state byte rate the playhead consumes fits the link
 *       budget. Both are measured against the REAL directory (local dev only —
 *       the packed dirs are git-ignored, so CI records skips). Tile-loading
 *       audit 2026-08 A2 / F1 / F2 / F3: four demos shipped speeds whose gate
 *       floor exceeded their cache (`nyc-taxi-paths` 3,600 tiles vs 2,000,
 *       11.4 MB/s; `rain-flood-2019` 1,079 vs a 1,000 split; `satellites`
 *       12 MB/s; `ocean-drifters` 8.5 MB/s) and the gate could not fail on any
 *       of them.
 *
 * (d)–(f) need `min_zoom` / `max_zoom` / `bounds` / `blobOrdering`, which only
 * the packed `manifest.json` carries; the git-tracked density sidecar supplies
 * `bounds` and the profiled (deepest) zoom, so CI still runs (e) and half of (d)
 * even though the packed dirs are git-ignored. (g) reads the registry alone and
 * therefore ALWAYS runs, in CI included.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebMercatorViewport } from '@deck.gl/core';
import { STTArchive } from '@poopdeck.gl/core';
import { resolvePlaybackParams } from '@poopdeck.gl/playback';
import { datasets } from '../src/datasets';
import { profileIdFromUrl } from '../src/lib/densityProfile';
import { tileLoadingProps } from '../src/types';
import type { Dataset } from '../src/types';
import { MAX_SAFE_PITCH } from '../src/components/demo/cameraLimits';
import { perArchiveTileCap } from '../src/components/demo/compositeCacheBudget';

/** Normalized archive characteristics, unified across sidecar & manifest. */
interface Fixture {
  source: 'density' | 'manifest';
  path: string;
  timeRange: { start: number; end: number };
  bucketMs?: number;
  featureCount?: number;
}

/** Resolve an origin-relative "/…"" url to its on-disk path under public/. */
function publicPath(rel: string): string {
  return fileURLToPath(new URL(`../public${rel}`, import.meta.url));
}

function isRange(v: unknown): v is { start: number; end: number } {
  return (
    !!v &&
    typeof (v as { start?: unknown }).start === 'number' &&
    typeof (v as { end?: unknown }).end === 'number'
  );
}

/** Density sidecar for a dataset's archive stem, if present on disk. */
function loadDensityFixture(url: string): Fixture | null {
  const id = profileIdFromUrl(url);
  if (!id) return null;
  const path = publicPath(`/density/${id}.json`);
  if (!existsSync(path)) return null;
  const j = JSON.parse(readFileSync(path, 'utf8')) as {
    timeRange?: unknown;
    bucketMs?: number;
    featureCount?: number;
  };
  if (!isRange(j.timeRange)) return null;
  return {
    source: 'density',
    path,
    timeRange: j.timeRange,
    bucketMs: j.bucketMs,
    featureCount: j.featureCount,
  };
}

/** Packed manifest.json the dataset url points at (local dev only). */
function loadManifestFixture(url: string): Fixture | null {
  if (!url.startsWith('/data/') || !url.endsWith('/manifest.json')) return null;
  const path = publicPath(url);
  if (!existsSync(path)) return null;
  const md = (
    JSON.parse(readFileSync(path, 'utf8')) as {
      metadata?: Record<string, unknown>;
    }
  ).metadata;
  if (!md || !isRange(md.time_range)) return null;
  return {
    source: 'manifest',
    path,
    timeRange: md.time_range,
    bucketMs:
      typeof md.temporal_bucket_ms === 'number'
        ? md.temporal_bucket_ms
        : undefined,
    featureCount:
      typeof md.feature_count === 'number' ? md.feature_count : undefined,
  };
}

function resolveFixture(url: string): Fixture | null {
  return loadDensityFixture(url) ?? loadManifestFixture(url);
}

// ── camera / ordering half ───────────────────────────────────────────────────

interface Bounds {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/**
 * The archive facts the camera/ordering checks need, none of which the (a)–(c)
 * `Fixture` carries. Sourced from the packed manifest when the (git-ignored)
 * dataset dir is present, else from the git-tracked density sidecar — which
 * knows `bounds` and the profiled deepest zoom but neither `min_zoom` nor the
 * ordering the build actually resolved (its `autoChoice` is what `--blob-ordering
 * auto` WOULD pick, not what shipped: `drifters` records `spatial` there while
 * its manifest says `time-major`).
 */
interface ArchiveFacts {
  source: 'manifest' | 'density';
  path: string;
  minZoom?: number;
  maxZoom?: number;
  bounds?: Bounds;
  blobOrdering?: string;
  /** Manifest only — (f) needs the bucket COUNT to exempt single-bucket archives. */
  bucketMs?: number;
  timeRange?: { start: number; end: number };
}

/** Temporal buckets the archive spans; `undefined` when the manifest lacks either fact. */
function archiveBucketCount(facts: ArchiveFacts): number | undefined {
  if (!facts.bucketMs || !facts.timeRange) return undefined;
  return Math.ceil(
    (facts.timeRange.end - facts.timeRange.start) / facts.bucketMs,
  );
}

function isBounds(v: unknown): v is Bounds {
  const b = v as Partial<Bounds> | undefined;
  return (
    !!b &&
    typeof b.minLon === 'number' &&
    typeof b.minLat === 'number' &&
    typeof b.maxLon === 'number' &&
    typeof b.maxLat === 'number'
  );
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function factsFromManifest(url: string): ArchiveFacts | null {
  if (!url.startsWith('/data/') || !url.endsWith('/manifest.json')) return null;
  const path = publicPath(url);
  if (!existsSync(path)) return null;
  const j = JSON.parse(readFileSync(path, 'utf8')) as {
    blobOrdering?: unknown;
    metadata?: Record<string, unknown>;
  };
  const md = j.metadata ?? {};
  const b = md.bounds as Record<string, unknown> | undefined;
  return {
    source: 'manifest',
    path,
    minZoom: num(md.min_zoom),
    maxZoom: num(md.max_zoom),
    bounds: b
      ? {
          minLon: num(b.min_lon) ?? NaN,
          minLat: num(b.min_lat) ?? NaN,
          maxLon: num(b.max_lon) ?? NaN,
          maxLat: num(b.max_lat) ?? NaN,
        }
      : undefined,
    blobOrdering:
      typeof j.blobOrdering === 'string' ? j.blobOrdering : undefined,
    bucketMs: num(md.temporal_bucket_ms),
    timeRange: isRange(md.time_range) ? md.time_range : undefined,
  };
}

function factsFromDensity(url: string): ArchiveFacts | null {
  const id = profileIdFromUrl(url);
  if (!id) return null;
  const path = publicPath(`/density/${id}.json`);
  if (!existsSync(path)) return null;
  const j = JSON.parse(readFileSync(path, 'utf8')) as {
    bounds?: unknown;
    zoom?: number;
  };
  return {
    source: 'density',
    path,
    // The profile is emitted at the archive's deepest zoom; min_zoom is not
    // recorded there, so (d)'s below-min_zoom half simply doesn't run in CI.
    maxZoom: num(j.zoom),
    bounds: isBounds(j.bounds) ? j.bounds : undefined,
  };
}

function loadArchiveFacts(url: string): ArchiveFacts | null {
  return factsFromManifest(url) ?? factsFromDensity(url);
}

/**
 * Every url on a dataset that addresses a packed archive: the primary `url`
 * plus every `*Url` field. The `manifest.json` suffix is the discriminator —
 * it keeps the AV `telemetry.json` / `cameras.json` / `scene.json` sidecars out
 * without a hand-maintained field list that would silently miss the next
 * overlay someone adds (which is exactly how the nine storm4d overlays went
 * unchecked).
 */
function archiveUrls(d: Dataset): { field: string; url: string }[] {
  const out: { field: string; url: string }[] = [];
  const fields = Object.entries(d as unknown as Record<string, unknown>);
  for (const [field, value] of fields) {
    if (field !== 'url' && !field.endsWith('Url')) continue;
    if (typeof value !== 'string' || !value.endsWith('manifest.json')) continue;
    if (out.some((e) => e.url === value)) continue; // shared archives (GLM)
    out.push({ field, url: value });
  }
  return out;
}

/** Every maxPitch the demo can put on the camera, with where it came from. */
function authoredMaxPitches(d: Dataset): { where: string; value: number }[] {
  const out: { where: string; value: number }[] = [];
  const vs = d.initialViewState?.maxPitch;
  if (typeof vs === 'number')
    out.push({ where: 'initialViewState', value: vs });
  const th = d.timeHeight?.maxPitch;
  if (typeof th === 'number') out.push({ where: 'timeHeight', value: th });
  return out;
}

// `MAX_SAFE_PITCH` (70; the 71.57° above-horizon band explained at its
// definition) is imported from src/components/demo/cameraLimits.ts so (g) and
// the viewers' map-level defaults share ONE number.

/**
 * Floor on each axis of an archive extent before the camera-centre test, in
 * degrees (~1.1 km). Absorbs the point-extent case described at the test site;
 * far below any framing drift worth catching (the one this gate did catch is
 * ~830 m of it).
 */
const BBOX_MIN_SPAN_DEG = 0.01;

/**
 * Sub-second authoring-precision floor for the (a) timeRange tolerance.
 *
 * `timeRange` literals are hand-authored to whole-second precision, whereas an
 * archive's exact first/last-vertex timestamp routinely lands a few hundred ms
 * off a rounded literal — seen across the AV drives, where the authored end sits
 * ~0.3 s past the last object sweep (a harmless over-bracket: the loader still
 * covers every frame). This floor absorbs that sub-frame rounding. Every drift
 * that can actually render a demo blank or truncate its story (hours → years)
 * exceeds it by many orders of magnitude, so it never masks real drift.
 */
const AUTHORING_PRECISION_MS = 1_000;

/** Why a dataset can't be reconciled locally (for honest skip accounting). */
function skipReason(d: Dataset): string {
  const stem = profileIdFromUrl(d.url);
  if (stem) {
    return `no local fixture — density/${stem}.json absent (git-tracked) and ${d.url} absent (git-ignored packed dir)`;
  }
  // profileIdFromUrl rejects nested (AV) & non-local urls; only the manifest
  // fallback could have covered it, and it didn't.
  return `no local fixture — ${d.url} is a nested/composite/remote url with no density sidecar, and its manifest.json is absent (git-ignored)`;
}

// Classify at module load so the reconciled/skipped partition (and the skip
// reasons) are known before any test body runs.
const classified = datasets.map((d) => ({ d, fx: resolveFixture(d.url) }));

// Filled during per-dataset test runs; read by the final coverage-summary case
// (registered last, so it observes every reconciled result).
const inconsistencies: string[] = [];
const notes: string[] = [];
// Deliberate in-bounds editorial sub-windows caught by assertion (a): authored
// timeRange trims inside the archive extent without poking out. Informational,
// counted separately from failures — see RECON SPEC.
const subWindows: string[] = [];
const reconciledSources: Record<string, number> = { density: 0, manifest: 0 };

// Partition up front so no `it` is declared behind a conditional. Reconciled
// datasets each get a hard-failing case; skipped ones (no local fixture) are
// enumerated with their reason in the coverage-summary console output — never
// silently passed, but not emitted as skipped test cases (which the lint gate
// forbids).
type ReconciledEntry = { d: Dataset; fx: Fixture };
const reconciledEntries: ReconciledEntry[] = classified.filter(
  (c): c is ReconciledEntry => c.fx !== null,
);
const skippedEntries = classified
  .filter((c) => c.fx === null)
  .map((c) => ({ id: c.d.id, reason: skipReason(c.d) }));

describe('dataset ↔ archive reconciliation', () => {
  for (const { d, fx } of reconciledEntries) {
    it(`${d.id} ← ${fx.source} fixture`, () => {
      reconciledSources[fx.source] += 1;
      const problems: string[] = [];
      const span = Math.abs(fx.timeRange.end - fx.timeRange.start);
      const tol = Math.max(
        fx.bucketMs ?? 0,
        0.01 * span,
        AUTHORING_PRECISION_MS,
      );

      // (a) timeRange reconciliation, classified per the RECON SPEC. Only an
      // authored range that pokes OUTSIDE the archive extent is a hazard (leading
      // or trailing dead air / blank frames). An authored range that trims INSIDE
      // the archive is a deliberate editorial sub-window — respected, recorded as
      // an informational note, never a failure.
      const dStart = d.timeRange.start;
      const dEnd = d.timeRange.end;
      const aStart = fx.timeRange.start;
      const aEnd = fx.timeRange.end;
      const startOOB = dStart < aStart - tol; // authored begins before any data
      const endOOB = dEnd > aEnd + tol; // authored ends after the last data
      const startSubset = dStart > aStart + tol; // authored begins after first data
      const endSubset = dEnd < aEnd - tol; // authored ends before last data
      if (startOOB || endOOB) {
        const parts: string[] = [];
        if (startOOB) {
          parts.push(
            `start: authored=${dStart} < archive=${aStart} − tol=${tol} (begins ${aStart - dStart}ms before any data → leading blank)`,
          );
        }
        if (endOOB) {
          parts.push(
            `end: authored=${dEnd} > archive=${aEnd} + tol=${tol} (ends ${dEnd - aEnd}ms after the last data → trailing blank)`,
          );
        }
        problems.push(`timeRange out of bounds — ${parts.join('; ')}`);
      } else if (startSubset || endSubset) {
        // Strict in-bounds subset: a deliberate editorial trim (e.g.
        // nyc-rideshare's ~2h Jan-1 window inside a full-January archive).
        subWindows.push(
          `${d.id}: deliberate sub-window authored=[${dStart}, ${dEnd}] inside archive=[${aStart}, ${aEnd}] (tol=${tol}, ${fx.source}) — editorial trim, respected`,
        );
      }

      // (b) timeWindow is a positive finite number.
      if (!(Number.isFinite(d.timeWindow) && d.timeWindow > 0)) {
        problems.push(
          `timeWindow must be a positive finite number; got ${d.timeWindow}`,
        );
      } else if (fx.bucketMs && d.timeWindow < fx.bucketMs) {
        // Sub-bucket window — legitimate for trip-heads-style demos; report as
        // an informational note, never a failure (matches the conditional
        // nature of the "window matches the temporal bucket" comment class).
        notes.push(
          `${d.id}: sub-bucket timeWindow=${d.timeWindow} < bucketMs=${fx.bucketMs} (${fx.source}) — fine for point/trip-heads demos, flagged for review`,
        );
      }

      // (c) wake invariant: the loader window must cover the past half of the
      // comet wake, i.e. wakeLength·2 ≤ timeWindow.
      if (typeof d.wakeLength === 'number' && d.wakeLength > 0) {
        if (d.wakeLength * 2 > d.timeWindow) {
          problems.push(
            `wake invariant violated: wakeLength·2=${d.wakeLength * 2} > timeWindow=${d.timeWindow} — the tile loader can't cover the trailing half of the wake (comment claims "timeWindow is set to 2× wakeLength")`,
          );
        }
      }

      for (const p of problems) inconsistencies.push(`${d.id}: ${p}`);

      expect(
        problems,
        `\n[reconcile] ${d.id} vs ${fx.source} fixture ${fx.path}\n  - ${problems.join('\n  - ')}\n`,
      ).toEqual([]);
    });
  }

  // Registered after the loop → runs last → observes every reconciled result.
  it('coverage summary (reconciled vs skipped, all inconsistencies)', () => {
    const reconciled = reconciledEntries.length;
    const lines: string[] = [];
    lines.push(
      `[reconcile] ${reconciled} reconciled ` +
        `(${reconciledSources.density} via density sidecar, ${reconciledSources.manifest} via manifest fallback), ` +
        `${skippedEntries.length} skipped (no local fixture) of ${classified.length} datasets`,
    );
    if (skippedEntries.length) {
      lines.push(`[reconcile] ${skippedEntries.length} skipped (no fixture):`);
      for (const s of skippedEntries) lines.push(`    ⊘ ${s.id} — ${s.reason}`);
    }
    const infoCount = subWindows.length + notes.length;
    if (infoCount) {
      lines.push(
        `[reconcile] ${infoCount} informational note(s) ` +
          `(${subWindows.length} deliberate sub-window(s), ${notes.length} sub-bucket window note(s)):`,
      );
      for (const s of subWindows) lines.push(`    · ${s}`);
      for (const n of notes) lines.push(`    · ${n}`);
    }
    lines.push(
      inconsistencies.length
        ? `[reconcile] ${inconsistencies.length} INCONSISTENCY(IES) caught:`
        : `[reconcile] 0 inconsistencies — every reconciled demo agrees with its archive`,
    );
    for (const bad of inconsistencies) lines.push(`    ✗ ${bad}`);
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));

    // Coverage floor: the git-tracked density sidecars guarantee a non-trivial
    // reconciled set even in CI. If this ever drops to zero the fixtures moved
    // or the url→stem mapping broke — which would silently gut the test.
    expect(
      reconciled,
      'expected at least the density-sidecar-backed demos to reconcile; got zero — fixtures or url→stem mapping likely broke',
    ).toBeGreaterThan(0);
  });
});

/**
 * Registered-but-never-built detection.
 *
 * Every other case here reconciles a dataset AGAINST an archive, so a dataset
 * with no archive at all is invisible to them — it lands in the "skipped, no
 * local fixture" bucket, indistinguishable from a CI run where the whole
 * git-ignored `public/data` tree is absent. Two scenes lived in the registry
 * that way for months (`argoverse-02678d04-scan`'s Miami sibling and
 * `waymo-sf-day-world`): both would 404 the moment their render-mode toggle was
 * shown, and nothing failed.
 *
 * The discriminator is the tree itself. When enough archives resolve to prove
 * we are in a populated dev checkout, EVERY registered dataset must resolve;
 * when almost none do (CI), the case reports and passes. `PRESENT_FLOOR` is
 * deliberately well above the handful a broken url→path mapping could still
 * hit by accident, and well below the ~600 a real tree carries.
 */
const PRESENT_FLOOR = 25;

/**
 * Archive urls a registered dataset declares that are KNOWN not to be built,
 * each with the reason it is acceptable. Same contract as
 * `CATALOG_EXCLUDED_IDS`: the list must be both exhaustive (anything absent and
 * unlisted FAILS) and non-stale (anything listed that now resolves also FAILS,
 * so a fixed gap cannot rot here unnoticed).
 *
 * The nuScenes adapter never emitted the `tracks/` archive the Hägerstrand
 * space-time cube reads. That is invisible today only because the cockpit holds
 * the Spacetime toggle back (`AvCockpitImpl`: "the toggle is not offered"), so
 * `avTracksUrl` is never dereferenced — it becomes a 404 the moment cube mode
 * ships. Argoverse and Waymo bundles do carry `tracks/`; only these do not.
 *
 * Closing it is NOT a rebuild: no nuScenes dataroot survives under
 * `scripts/data-generation/`, and re-fetching one needs a nuscenes.org account
 * (see the licence register in docs/roadmap/demos-and-datasets.md). So this is
 * blocked on source data, not on effort — which is exactly the kind of thing
 * that should be written down rather than rediscovered.
 */
const CUBE_TRACKS_UNBUILT =
  'nuScenes adapter never emitted tracks/; unreachable while Spacetime (cube) is held back; rebuild blocked — no local dataroot, re-fetch needs a nuscenes.org account';
const KNOWN_UNBUILT = new Map<string, string>([
  ['/data/nuscenes-0061/tracks/manifest.json', CUBE_TRACKS_UNBUILT],
  ['/data/nuscenes-0103/tracks/manifest.json', CUBE_TRACKS_UNBUILT],
  ['/data/nuscenes-0553/tracks/manifest.json', CUBE_TRACKS_UNBUILT],
  ['/data/nuscenes-0655/tracks/manifest.json', CUBE_TRACKS_UNBUILT],
  ['/data/nuscenes-0757/tracks/manifest.json', CUBE_TRACKS_UNBUILT],
  ['/data/nuscenes-0796/tracks/manifest.json', CUBE_TRACKS_UNBUILT],
  ['/data/nuscenes-0916/tracks/manifest.json', CUBE_TRACKS_UNBUILT],
  ['/data/nuscenes-1077/tracks/manifest.json', CUBE_TRACKS_UNBUILT],
  ['/data/nuscenes-1094/tracks/manifest.json', CUBE_TRACKS_UNBUILT],
  ['/data/nuscenes-1100/tracks/manifest.json', CUBE_TRACKS_UNBUILT],
  [
    '/data/waymo-sf-day-surfel-adaptive/tracks/manifest.json',
    CUBE_TRACKS_UNBUILT,
  ],
]);

const archivePresence = datasets.flatMap((d) =>
  archiveUrls(d).map(({ field, url }) => ({
    id: d.id,
    field,
    url,
    present: existsSync(publicPath(url)),
  })),
);

describe('registered datasets resolve to built archives', () => {
  it('every registered dataset has its archives on disk (populated tree only)', () => {
    const present = archivePresence.filter((a) => a.present);
    const missing = archivePresence.filter((a) => !a.present);
    const populated = present.length >= PRESENT_FLOOR;

    // eslint-disable-next-line no-console
    console.log(
      `[archives] ${present.length}/${archivePresence.length} archive urls resolve on disk` +
        (populated
          ? ` — tree is populated, missing archives are FAILURES`
          : ` — below the ${PRESENT_FLOOR} floor, treating this as CI (no local data tree); reporting only`),
    );
    if (missing.length) {
      // eslint-disable-next-line no-console
      console.log(
        `[archives] ${missing.length} unresolved:\n` +
          missing
            .map((m) => `    ⊘ ${m.id} · ${m.field} → ${m.url}`)
            .join('\n'),
      );
    }
    if (!populated) return;

    // A registered scene with no tiles 404s the moment its route or its
    // render-mode toggle becomes reachable. Fix by building the bundle,
    // unregistering the scene, or adding the url to KNOWN_UNBUILT with a reason.
    const unbuiltButRegistered = missing
      .filter((m) => !KNOWN_UNBUILT.has(m.url))
      .map((m) => `${m.id} · ${m.field} → ${m.url}`);

    // Non-staleness: a KNOWN_UNBUILT entry that now resolves means the gap was
    // closed and the acknowledgement outlived it. Same rule the catalog
    // exclusions carry — a stale entry fails rather than rots.
    const acknowledgedButPresent = present
      .filter((p) => KNOWN_UNBUILT.has(p.url))
      .map((p) => `${p.id} · ${p.url} (delete the KNOWN_UNBUILT entry)`);

    // Asserted as one labelled object so a failure names WHICH rule broke, and
    // the diff lists the offending urls instead of a bare length mismatch.
    expect({ unbuiltButRegistered, acknowledgedButPresent }).toEqual({
      unbuiltButRegistered: [],
      acknowledgedButPresent: [],
    });
  });
});

/**
 * Non-time-major archives that PLAY but whose layout cannot matter, each with
 * the reason. Same contract as `KNOWN_UNBUILT`: exhaustive (anything else
 * fails) and non-stale (an entry that becomes time-major fails too).
 *
 * NOT listed — deliberately red until its archive is rebuilt with
 * `--blob-ordering time-major` (`stt-generate nwm …`, the recipe in its
 * registry entry): `nwm-rivers-2019` (`hilbert3`, 13 monthly buckets, 12 z4
 * tiles across the CONUS viewport). It is multi-cell playback, not a
 * single-cell scroll, so the rule applies; the standalone demo and the
 * `rain-flood-2019` rivers overlay both fail on it. Audit F5.
 */
const ORDERING_EXEMPT = new Map<string, string>([
  [
    '/data/comma-280-1641/ego/manifest.json',
    'one 60 s ego trajectory sliced into 1,569 one-second tiles (one feature each, z0–18); the whole archive is a fraction of one cache, so it is fully resident after the first plan and never range-streamed — the layout cannot stall the runway',
  ],
]);

// Filled during the camera/ordering runs; read by that describe's summary case.
const cameraNotes: string[] = [];
const cameraProblems: string[] = [];
const factsSources: Record<string, number> = { density: 0, manifest: 0 };
const unresolvedArchives: string[] = [];
let archiveUrlsSeen = 0;
/** Primaries a git-tracked density sidecar can resolve — the CI-stable floor. */
const densityBackedPrimaries = datasets.filter(
  (d) => factsFromDensity(d.url) !== null,
).length;

describe('dataset ↔ archive camera & ordering reconciliation', () => {
  for (const d of datasets) {
    it(`${d.id} camera & ordering`, () => {
      const problems: string[] = [];

      // (g) Registry-only, so this half runs everywhere including CI. Both
      // spellings are checked: the storm4d demos carry maxPitch on the view
      // state, the space-time cubes on `timeHeight` (DemoViewer reads that one
      // and defaults it). AvDeck's ceiling is a module constant in
      // components/av/AvDeck.tsx and is out of this file's reach.
      for (const { where, value } of authoredMaxPitches(d)) {
        if (!(value <= MAX_SAFE_PITCH)) {
          problems.push(
            `${where}.maxPitch=${value} > ${MAX_SAFE_PITCH} — the camera can reach the band (pitch > 71.57° at deck's default altitude 1.5) where the above-horizon unproject inverts the tile-selection box; see docs/roadmap/tile-loading-3d-2026-07.md §1/§4`,
          );
        }
      }

      const urls = archiveUrls(d);
      archiveUrlsSeen += urls.length;
      for (const { field, url } of urls) {
        const facts = loadArchiveFacts(url);
        if (!facts) {
          unresolvedArchives.push(`${d.id}.${field} → ${url}`);
          continue;
        }
        factsSources[facts.source] += 1;
        const at = `${field} (${url}, ${facts.source})`;
        // Only the PRIMARY `url` hard-fails on framing. An overlay legitimately
        // covers a different footprint from the camera (storm4d's OAX
        // radiosonde ascent sits ~150 km west of the Greenfield framing; the
        // shared GLM lightning archive is continental) and is frequently
        // zoom-GATED by its builder — buildWorldsLayers only mounts
        // cosmos-drive-dreams' `objects` at BOX_ZOOM 13.5, comfortably above
        // its min_zoom 13, so the gallery's opening zoom 11.6 never touches it.
        // The primary is the governor: if the opening camera can't see IT, the
        // demo opens blank with every readiness signal green.
        const primary = field === 'url';
        const record = (msg: string) => {
          if (primary) problems.push(msg);
          else
            cameraNotes.push(`${d.id}: ${msg} — overlay, flagged not failed`);
        };

        // (d) Opening zoom vs the archive's tiled range, floored the way
        // SpatioTemporalLayer.getZoomLevel floors it. `zoomOverride` replaces
        // the camera zoom outright, so it is what gets checked when set.
        const pinned = d.zoomOverride;
        const z =
          pinned !== undefined ? pinned : Math.floor(d.initialViewState.zoom);
        const zWhat =
          pinned !== undefined
            ? `zoomOverride=${pinned}`
            : `floor(camera)=${z}`;
        if (facts.minZoom !== undefined && z < facts.minZoom) {
          record(
            `zoom below the archive: ${zWhat} < min_zoom=${facts.minZoom} on ${at} — the layer clamps up to min_zoom, so the loader enumerates a box at a zoom the camera never asked for`,
          );
        }
        if (facts.maxZoom !== undefined && z > facts.maxZoom) {
          // Over-zoom is deliberate everywhere it appears (a deep-dive framing
          // stretches the deepest tier on purpose), so it never fails.
          cameraNotes.push(
            `${d.id}: ${zWhat} > max_zoom=${facts.maxZoom} on ${at} — deliberate over-zoom of the deepest tier, flagged not failed`,
          );
        }

        // (e) Camera centre inside the archive extent. Outside = the demo opens
        // on empty map with every readiness signal green.
        const b = facts.bounds;
        const { longitude, latitude } = d.initialViewState;
        if (b && Number.isFinite(b.minLon)) {
          // A single-trip archive's `metadata.bounds` collapses to a POINT:
          // whole-feature placement records the representative point, not the
          // vertex extent, and every AV `ego` archive is exactly one trip. A
          // zero-span box would then reject any camera not standing on that one
          // coordinate, so each axis gets a floor of BBOX_MIN_SPAN_DEG (~1.1 km
          // — a city block or two, well under the drift this is looking for).
          const pad = (min: number, max: number) => {
            const grow = Math.max(0, BBOX_MIN_SPAN_DEG - (max - min)) / 2;
            return [min - grow, max + grow] as const;
          };
          const [latLo, latHi] = pad(b.minLat, b.maxLat);
          const crossing = b.minLon > b.maxLon;
          const [lonLo, lonHi] = crossing
            ? ([b.minLon, b.maxLon] as const)
            : pad(b.minLon, b.maxLon);
          const lonIn = crossing
            ? // A seam-crossing extent is stored min > max; the interval is the
              // UNION of the two halves, not their (empty) intersection.
              longitude >= lonLo || longitude <= lonHi
            : longitude >= lonLo && longitude <= lonHi;
          const latIn = latitude >= latLo && latitude <= latHi;
          if (!lonIn || !latIn) {
            record(
              `camera centre outside the archive extent: (${longitude}, ${latitude}) vs [${b.minLon}, ${b.minLat}, ${b.maxLon}, ${b.maxLat}] on ${at} — opens on empty map`,
            );
          }
        }

        // (f) Blob ordering vs playback. Only the manifest records what the
        // build actually resolved (the density sidecar's `autoChoice` is a
        // recommendation, not the shipped value). Anything but time-major on
        // a multi-bucket archive fails — the old `!== 'spatial'` predicate
        // waved `hilbert3` through (audit F5). A single-bucket archive has
        // nothing to interleave, so it is exempt; so is anything in
        // ORDERING_EXEMPT, for the reason recorded there.
        const buckets = archiveBucketCount(facts);
        const exempt = ORDERING_EXEMPT.get(url);
        if (exempt && facts.blobOrdering === 'time-major') {
          problems.push(
            `ORDERING_EXEMPT lists ${url} but it is now time-major — delete the stale entry`,
          );
        }
        if (
          d.targetPlaybackSeconds !== undefined &&
          facts.blobOrdering !== undefined &&
          facts.blobOrdering !== 'time-major' &&
          (buckets === undefined || buckets > 1) &&
          !exempt
        ) {
          problems.push(
            `blobOrdering='${facts.blobOrdering}' on ${at} (${buckets ?? '?'} buckets) while the demo authors targetPlaybackSeconds=${d.targetPlaybackSeconds} — one bucket's tiles are interleaved with every other bucket's bytes, so a time-ordered range read becomes a scatter-gather / over-read and the playhead stalls silently; rebuild with --blob-ordering time-major`,
          );
        }
      }

      for (const p of problems) cameraProblems.push(`${d.id}: ${p}`);
      expect(
        problems,
        `\n[camera] ${d.id}\n  - ${problems.join('\n  - ')}\n`,
      ).toEqual([]);
    });
  }

  // Every packed dataset dir happens to be present in local dev, so the manifest
  // branch always wins here and the density branch — the ONLY one that runs in
  // CI, where those dirs are git-ignored — would otherwise ship unexercised.
  // Call it directly on a known git-tracked sidecar so a shape change in
  // density-profile.rs (or in profileIdFromUrl) fails loudly instead of quietly
  // turning the whole CI half into "unresolved".
  it('the density-sidecar fallback (the CI path) still resolves bounds + zoom', () => {
    const facts = factsFromDensity('/data/drifters/manifest.json');
    expect(facts, 'density/drifters.json missing or unreadable').not.toBeNull();
    expect(facts!.source).toBe('density');
    expect(typeof facts!.maxZoom).toBe('number');
    expect(isBounds(facts!.bounds)).toBe(true);
  });

  // (g′) The registry half above cannot see a MAP-level default. The terrain
  // (`MapboxOverlay`) path hands react-map-gl its own `maxPitch`, and that
  // fallback shipped as 85 — latent only because the one terrain demo authors
  // 70 itself (audit F10). Pin the fallback token to the shared constant.
  it('(g′) the terrain map path falls back to MAX_SAFE_PITCH, not a literal', () => {
    const src = readFileSync(
      fileURLToPath(
        new URL('../src/components/demo/DemoViewer.tsx', import.meta.url),
      ),
      'utf8',
    );
    const m =
      /maxPitch=\{\(initialViewState as any\)\?\.maxPitch \?\? ([^}]+)\}/.exec(
        src,
      );
    expect(
      m,
      'the terrain <Map maxPitch={(initialViewState as any)?.maxPitch ?? …}> site moved; update this contract',
    ).not.toBeNull();
    expect(
      m![1].trim(),
      `terrain map maxPitch fallback must be MAX_SAFE_PITCH (${MAX_SAFE_PITCH}); a literal above it re-opens the above-horizon selection band`,
    ).toBe('MAX_SAFE_PITCH');
    expect(src).toMatch(/import \{ MAX_SAFE_PITCH \} from '\.\/cameraLimits'/);
    expect(MAX_SAFE_PITCH).toBe(70);
  });

  it('coverage summary (archives opened, camera/ordering findings)', () => {
    const lines: string[] = [];
    lines.push(
      `[camera] ${archiveUrlsSeen} archive-bearing url(s) across ${datasets.length} datasets; ` +
        `${factsSources.manifest} resolved via manifest, ${factsSources.density} via density sidecar, ` +
        `${unresolvedArchives.length} unresolved (git-ignored packed dir, no sidecar)`,
    );
    if (unresolvedArchives.length) {
      for (const u of unresolvedArchives) lines.push(`    ⊘ ${u}`);
    }
    if (cameraNotes.length) {
      lines.push(`[camera] ${cameraNotes.length} informational note(s):`);
      for (const n of cameraNotes) lines.push(`    · ${n}`);
    }
    lines.push(
      cameraProblems.length
        ? `[camera] ${cameraProblems.length} FINDING(S):`
        : `[camera] 0 findings — every demo's camera agrees with every archive it mounts`,
    );
    for (const bad of cameraProblems) lines.push(`    ✗ ${bad}`);
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));

    // Resolution floor, pinned to the GIT-TRACKED sidecars so it holds in CI
    // too. Without it the whole half could silently degrade to "everything
    // unresolved" — e.g. if `resolveDataUrl`'s R2-origin rewrite ever fires in
    // the test environment, every url would stop starting with `/data/` and
    // both fixture lookups would miss.
    expect(
      factsSources.manifest + factsSources.density,
      `expected at least the ${densityBackedPrimaries} density-sidecar-backed primary archive(s) to resolve; the url→fixture lookup likely broke`,
    ).toBeGreaterThanOrEqual(densityBackedPrimaries);

    // Coverage floor. The nine storm4d overlay manifests are the reason this
    // half exists: the (a)–(c) half only ever opened `d.url`, so a whole demo
    // family's archives were never read. If the walk ever stops finding more
    // urls than there are datasets, the `*Url` discovery broke.
    expect(
      archiveUrlsSeen,
      'expected more archive-bearing urls than datasets (composites mount several); got fewer — the *Url discovery in archiveUrls() likely broke',
    ).toBeGreaterThan(datasets.length);
  });
});

// ── horizon-feasibility half ─────────────────────────────────────────────────

/**
 * `packages/core/src/prefetch-policy.ts` constants, mirrored (the package index
 * does not export them). Keep in lock-step: `PREFETCH_LOOKAHEAD_REAL_MS` :44,
 * `MAX_PREFETCH_BUCKETS` :63, `PREFETCH_CAP_FLOOR_REAL_MS` :75.
 */
const PREFETCH_LOOKAHEAD_REAL_MS = 8000;
const MAX_PREFETCH_BUCKETS = 64;
const PREFETCH_CAP_FLOOR_REAL_MS = 5000;

/** The link budget the audit judged every demo against: 4 MB/s (32 MB per 8 real s). */
const LINK_BUDGET_BYTES_PER_S = 4 * 2 ** 20;
/**
 * `prefetch-policy.ts:152` — the feasibility solve bounds a planned horizon to
 * this fraction of `maxCacheSize` (:964) so the resident window + the horizon
 * fit together. A horizon the solve would have to cut is exactly the A2
 * evict/refetch pathology, so the gate judges residency against the same bound.
 */
const PREFETCH_CACHE_FRACTION = 0.5;

/** The audit's probe viewport (a typical laptop canvas). */
const PROBE_VIEWPORT = { width: 1440, height: 900 };

/**
 * The horizon `prefetch-policy.ts:690-741` PLANS for one tileset, before the
 * pressure ladder — and the gate floor no shrinking path may cut below. The
 * planned horizon is what residency converges on (A2): every shrink path is
 * `Math.max(…, gateFloor)`, so `max(effectiveAhead, gateFloor)` is the honest
 * "what the loader will insist on holding".
 */
function plannedHorizonMs(args: {
  bucketMs: number;
  loadWindow: number;
  prefetchAhead: number;
  prefetchSteps: number;
  speed: number;
}): { planned: number; gateFloor: number } {
  const { bucketMs, loadWindow, prefetchAhead, prefetchSteps, speed } = args;
  const windowAhead =
    (prefetchAhead > 0 ? prefetchAhead : loadWindow) * prefetchSteps;
  let effectiveAhead = Math.max(
    windowAhead,
    speed * PREFETCH_LOOKAHEAD_REAL_MS,
  );
  if (bucketMs > 0) {
    effectiveAhead = Math.min(
      effectiveAhead,
      Math.max(
        MAX_PREFETCH_BUCKETS * bucketMs,
        speed * PREFETCH_CAP_FLOOR_REAL_MS,
      ),
    );
  }
  const gateFloor = Math.max(
    bucketMs,
    loadWindow,
    speed * PREFETCH_CAP_FLOOR_REAL_MS,
  );
  return { planned: Math.max(effectiveAhead, gateFloor), gateFloor };
}

/**
 * The window the LAYER hands `tileset.update()` for one archive of a demo —
 * `buildDemoLayers`' authored window (cumulative points: 2× the span), raised
 * by `spatiotemporal-layer.ts:1823-1828` (`tileLoadTimeWindow`), by
 * `animated-trips-layer.ts:1143-1147` (2× trail) and by
 * `animated-point-layer.ts:1407-1428` (2× wake). Overlays of composite demos
 * carry their own trails the registry does not describe, so they get the
 * dataset window (the heads overlay its dedicated one) — approximate, which is
 * why overlays are flagged, not failed.
 */
function loadWindowFor(
  d: Dataset,
  field: string,
): { authored: number; loadWindow: number } {
  const span = d.timeRange.end - d.timeRange.start;
  const cumulative = d.type === 'point' && !!d.cumulative;
  let authored = cumulative ? span * 2 : d.timeWindow || 86400000;
  if (field === 'headsOverlayUrl' && d.headsOverlayTimeWindow)
    authored = d.headsOverlayTimeWindow;
  let loadWindow = Math.max(d.tileLoadTimeWindow ?? 0, authored);
  if (field === 'url') {
    if (d.type === 'trips' && typeof d.trailLength === 'number')
      loadWindow = Math.max(loadWindow, 2 * d.trailLength);
    if (d.type === 'point' && typeof d.wakeLength === 'number')
      loadWindow = Math.max(loadWindow, 2 * d.wakeLength);
  }
  return { authored, loadWindow };
}

/**
 * The lon/lat box + zoom the loader selects against at the shipped camera:
 * `viewport.getBounds()` of the opening view state (unioned with the top of
 * `zRange` for scenes with height, as `core/src/geo/viewport-bounds.ts` does),
 * or the whole world at `zoomOverride` for the global-bounds demos.
 */
function probeSelection(d: Dataset): {
  bounds: Bounds;
  zoom: number;
  how: string;
} {
  const vs = d.initialViewState;
  if (d.zoomOverride !== undefined || d.useGlobalBounds || d.useGlobe) {
    const zoom = d.zoomOverride ?? Math.floor(vs.zoom);
    return {
      bounds: { minLon: -180, minLat: -90, maxLon: 180, maxLat: 90 },
      zoom,
      how:
        d.zoomOverride !== undefined
          ? `world@zoomOverride=${zoom}`
          : `world@floor(zoom)=${zoom}`,
    };
  }
  const vp = new WebMercatorViewport({
    ...PROBE_VIEWPORT,
    longitude: vs.longitude,
    latitude: vs.latitude,
    zoom: vs.zoom,
    pitch: vs.pitch,
    bearing: vs.bearing,
  });
  let b = vp.getBounds();
  if (d.zRange && d.zRange[1] > 0) {
    const bz = vp.getBounds({ z: d.zRange[1] });
    b = [
      Math.min(b[0], bz[0]),
      Math.min(b[1], bz[1]),
      Math.max(b[2], bz[2]),
      Math.max(b[3], bz[3]),
    ];
  }
  return {
    bounds: { minLon: b[0], minLat: b[1], maxLon: b[2], maxLat: b[3] },
    zoom: Math.floor(vs.zoom),
    how: `viewport ${PROBE_VIEWPORT.width}×${PROBE_VIEWPORT.height} @ z${vs.zoom} p${vs.pitch} b${vs.bearing}`,
  };
}

/**
 * A Range-honouring `fetch` over `public/` so `STTArchive` reads the REAL
 * packed directory off disk — the same query path the loader uses, without a
 * dev server. 206 + `Content-Range` + exact body length are what
 * `archive.fetchObjectRange` validates.
 */
function fileFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  const path = publicPath(decodeURIComponent(url.pathname));
  if (!existsSync(path))
    return Promise.resolve(
      new Response(null, { status: 404, statusText: 'Not Found' }),
    );
  const size = statSync(path).size;
  const headers = new Headers(init?.headers);
  const range = headers.get('range');
  if (!range)
    return Promise.resolve(new Response(readFileSync(path), { status: 200 }));
  const m = /^bytes=(\d+)-(\d+)$/.exec(range);
  if (!m) return Promise.resolve(new Response(null, { status: 416 }));
  const start = Number(m[1]);
  const end = Math.min(Number(m[2]), size - 1);
  const body = readFileSync(path).subarray(start, end + 1);
  return Promise.resolve(
    new Response(body, {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${size}` },
    }),
  );
}

interface HorizonMeasure {
  bucketMs: number;
  speed: number;
  plannedBuckets: number;
  gateFloorBuckets: number;
  /** Distinct tiles the loader must hold for `[t − w/2, t + planned]`, worst of 3 samples. */
  residentMax: number;
  /** `PREFETCH_CACHE_FRACTION × perArchiveTileCap` — what the solve lets a horizon occupy. */
  /** Bytes the playhead consumes per real second once the horizon is full, mean of 3 samples. */
  steadyBytesPerS: number;
  tileCap: number;
  how: string;
}

/**
 * Measure one archive of a demo at the shipped camera. Residency is the UNION
 * of tile ids over the horizon (not `buckets × tiles/bucket`: on un-sliced
 * track archives successive buckets return mostly the same tiles — `animals`
 * is 7,531 naive vs 182 real). The steady-state rate is a differential —
 * bytes the SECOND horizon adds over the first, per real second the first one
 * takes to play — so the one-off fill of the opening window (a cold-start
 * matter, audit F9) is not charged to the link budget. Worst-of-3 for the hard
 * cap (overflow = evict/refetch loop); mean-of-3 for the soft link budget (the
 * governor absorbs a dense decade by stalling honestly).
 */
async function measureHorizon(
  d: Dataset,
  field: string,
  url: string,
  archiveCount: number,
): Promise<HorizonMeasure> {
  const archive = new STTArchive({
    url: `http://reconcile.local${url}`,
    fetch: fileFetch,
  });
  try {
    const meta = await archive.getMetadata();
    const bucketMs = meta.temporalBucketMs;
    const cumulative = d.type === 'point' && !!d.cumulative;
    const { authored, loadWindow } = loadWindowFor(d, field);
    const { baseSpeed: speed } = resolvePlaybackParams(undefined, {
      targetPlaybackSeconds: d.targetPlaybackSeconds || 60,
      timeWindow: authored,
      timeRange: d.timeRange,
    });
    const recipe = tileLoadingProps(authored, speed);
    const prefetchAhead =
      field === 'headsOverlayUrl' && d.headsOverlayTimeWindow
        ? d.headsOverlayTimeWindow
        : recipe.prefetchAhead;
    const { planned, gateFloor } = plannedHorizonMs({
      bucketMs,
      loadWindow,
      prefetchAhead,
      prefetchSteps: recipe.prefetchSteps,
      speed,
    });
    const sel = probeSelection(d);
    const zoom = Math.min(Math.max(sel.zoom, meta.minZoom), meta.maxZoom);
    const dStart = d.timeRange.start;
    const dSpan = d.timeRange.end - dStart;
    const samples = [0.25, 0.5, 0.75].map(
      (f) => dStart + Math.floor((f * dSpan) / bucketMs) * bucketMs,
    );
    const query = async (start: number, end: number) => {
      const ids = await archive.getTileIdsInBounds(sel.bounds, zoom, {
        start,
        end,
      });
      let bytes = 0;
      for (const id of ids) bytes += archive.getTileByteSize(id) ?? 0;
      return { tiles: ids.length, bytes };
    };
    let residentMax = 0;
    let rateSum = 0;
    let rateSamples = 0;
    for (const t of samples) {
      const lo = t - loadWindow / 2;
      const fill = await query(lo, t + planned);
      residentMax = Math.max(residentMax, fill.tiles);
      // The second horizon may run past the demo's end near the 75 % sample;
      // charge its bytes to the real seconds it actually covers.
      const secondEnd = Math.min(t + 2 * planned, d.timeRange.end);
      const realSeconds = (secondEnd - (t + planned)) / speed / 1000;
      if (realSeconds <= 0) continue;
      const next = await query(lo, secondEnd);
      rateSum += (next.bytes - fill.bytes) / realSeconds;
      rateSamples += 1;
    }
    return {
      bucketMs,
      speed,
      plannedBuckets: Math.ceil(planned / bucketMs),
      gateFloorBuckets: Math.ceil(gateFloor / bucketMs),
      residentMax,
      steadyBytesPerS: rateSamples ? rateSum / rateSamples : 0,
      // A cumulative (draw-and-persist) demo's window IS its whole history —
      // the gate floor is 2× the span by design and there is no horizon beyond
      // it to shrink — so its bound is simply "fits the cache"; every other
      // demo's window + horizon must leave the solve's headroom.
      tileCap: cumulative
        ? perArchiveTileCap(archiveCount)
        : Math.floor(perArchiveTileCap(archiveCount) * PREFETCH_CACHE_FRACTION),
      how: `${sel.how} → tile z${zoom}`,
    };
  } finally {
    archive.finalize();
  }
}

const mb = (bytes: number) => (bytes / 2 ** 20).toFixed(2);

const horizonProblems: string[] = [];
const horizonNotes: string[] = [];
const horizonSkipped: string[] = [];
const horizonWatch: string[] = [];
let horizonMeasured = 0;
const playingDatasets = datasets.filter(
  (d) => d.targetPlaybackSeconds !== undefined,
);

describe('dataset ↔ archive horizon feasibility (tile-loading audit 2026-08 A2)', () => {
  for (const d of playingDatasets) {
    it(`${d.id} horizon fits its cache and the link`, async () => {
      const problems: string[] = [];
      const urls = archiveUrls(d);
      for (const { field, url } of urls) {
        if (!existsSync(publicPath(url))) {
          horizonSkipped.push(
            `${d.id}.${field} → ${url} (git-ignored packed dir absent)`,
          );
          continue;
        }
        const m = await measureHorizon(d, field, url, urls.length);
        horizonMeasured += 1;
        const at = `${field} (${url}; ${m.how}; bucket ${m.bucketMs} ms, speed ${m.speed.toFixed(1)}×, planned ${m.plannedBuckets} buckets / gate floor ${m.gateFloorBuckets})`;
        const primary = field === 'url';
        const record = (msg: string) => {
          if (primary) problems.push(msg);
          else
            horizonNotes.push(`${d.id}: ${msg} — overlay, flagged not failed`);
        };
        if (m.residentMax > m.tileCap) {
          record(
            `planned horizon needs ${m.residentMax} resident tiles > ${PREFETCH_CACHE_FRACTION} × per-archive cap = ${m.tileCap} on ${at} — the loader evicts the far end of the horizon it just planned and re-plans it (A2 evict/refetch loop); raise targetPlaybackSeconds, widen timeWindow, or pin refinementStrategy 'no-overlap'`,
          );
        }
        if (m.steadyBytesPerS > LINK_BUDGET_BYTES_PER_S) {
          const msg = `steady-state consumption ${mb(m.steadyBytesPerS)} MB/s > link budget ${mb(LINK_BUDGET_BYTES_PER_S)} MB/s on ${at} — the governor stalls on any ordinary link; raise targetPlaybackSeconds`;
          if (d.type === 'av') {
            // AV cockpits play at 1.0× by contract (camera frames and
            // telemetry are synced to the clock), and a LIDAR sweep every
            // 100 ms IS the data rate — the Waymo surfel scenes stream
            // 4.3–7.1 MB/s. The lever there is the density tier / perf mode,
            // not the speed, so this is reported, not failed.
            horizonNotes.push(
              `${d.id}: ${msg} — AV scene at real time, the density tier is the lever; flagged not failed`,
            );
          } else {
            record(msg);
          }
        }
        if (
          m.residentMax > m.tileCap / 2 ||
          m.steadyBytesPerS > LINK_BUDGET_BYTES_PER_S / 2
        ) {
          horizonWatch.push(
            `${d.id}.${field}: ${m.residentMax}/${m.tileCap} tiles, ${mb(m.steadyBytesPerS)} MB/s (${m.plannedBuckets} buckets planned)`,
          );
        }
      }
      for (const p of problems) horizonProblems.push(`${d.id}: ${p}`);
      expect(
        problems,
        `\n[horizon] ${d.id}\n  - ${problems.join('\n  - ')}\n`,
      ).toEqual([]);
    }, 60_000);
  }

  it('coverage summary (archives measured, horizon findings)', () => {
    const lines: string[] = [];
    lines.push(
      `[horizon] ${horizonMeasured} archive(s) measured across ${playingDatasets.length} playing datasets; ` +
        `${horizonSkipped.length} skipped (git-ignored packed dir absent)`,
    );
    if (horizonWatch.length) {
      lines.push(
        `[horizon] ${horizonWatch.length} above half a budget (watch list):`,
      );
      for (const w of horizonWatch) lines.push(`    · ${w}`);
    }
    if (horizonNotes.length) {
      lines.push(`[horizon] ${horizonNotes.length} overlay note(s):`);
      for (const n of horizonNotes) lines.push(`    · ${n}`);
    }
    lines.push(
      horizonProblems.length
        ? `[horizon] ${horizonProblems.length} FINDING(S):`
        : `[horizon] 0 findings — every measured primary fits its cache and the link`,
    );
    for (const bad of horizonProblems) lines.push(`    ✗ ${bad}`);
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    // Honest accounting only: with no packed dirs (CI) everything is skipped
    // and that is reported, not hidden — there is no git-tracked fixture that
    // knows tiles-per-bucket at a camera (the density sidecar bins time into
    // 64 slices, so the per-bucket overlap factor is not recoverable from it).
    expect(horizonMeasured + horizonSkipped.length).toBeGreaterThan(0);
  });
});
