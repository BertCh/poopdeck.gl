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
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { datasets } from '../src/datasets';
import { profileIdFromUrl } from '../src/lib/densityProfile';
import type { Dataset } from '../src/types';

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
