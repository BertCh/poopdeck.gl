// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * STT packed-format reader over HTTP Range Requests.
 *
 * Layout (see the Rust `stt-core::pack` module and
 * `docs/spec/stt-packed-format.md`):
 *
 * ```text
 * data/<dataset>/
 *   manifest.json            metadata + directory pointer + pack table (mutable)
 *   index/<blake3>.sttd       v6 directory blob          (immutable)
 *   packs/<blake3>.sttp       per-blob zstd tile data    (immutable)
 *   packs/<blake3>.sttp
 * ```
 *
 * The reader's `url` points at the `manifest.json`. A cold load is one
 * manifest GET + one directory GET + N pack range requests. The directory
 * decodes to entries each carrying `(packId, offset, length)`; a tile read
 * selects `manifest.packs[packId]` and issues a Range request against it.
 * Coalescing is per-pack — a range can never bridge two pack objects.
 *
 * Only compressed bytes are cached here; decoded tiles are owned by the
 * tileset. There is NO shared zstd dictionary (each blob is independently
 * zstd-compressed), so the fzstd browser path can decode every tile.
 */

import {
  decodeDirectory,
  decodePagedRoot,
  DIRECTORY_VERSION,
  type PageDescriptor,
} from './directory.js';
import {
  type ArchiveMetadata,
  type ArchiveIndex,
  type ArchiveOptions,
  type SttLoadOptions,
  type Tile,
  type TileId,
  type TileEntry,
  type BoundingBox,
  type TemporalLodLevel,
  type TimeRange,
  type TileRequestOptions,
  type SelectionCost,
  type SummaryTier,
  type SummaryColumn,
  type HeatmapDomain,
  type HeatmapClassDomain,
  type StyleHints,
  type PropertyStyleHint,
  Compression,
} from './types.js';
import {
  tileKey,
  tileEntryKey,
  tileCellKey,
  type TileKey,
  type TileEntryKey,
  type TileCellKey,
} from './tile-key.js';
import { createDefaultTileDecoder, type TileDecoder } from './tile-decoder.js';
import { OpfsTileCache } from './opfs-cache.js';
import { decompress, unzstdSync } from './compression.js';
import { blake3Hex128 } from './blake3.js';
import type { TemplateRegistry } from './tile.js';
import { createSttTileSource, type SttTileSource } from './tile-source.js';
import {
  LatencyEstimator,
  ThroughputEstimator,
  type ThroughputEstimate,
} from './throughput.js';
import { forEachBufferView } from './tile-transferables.js';
import {
  getSharedScheduler,
  setSharedSchedulerSourceWeight,
} from './shared-scheduler.js';
import {
  createCancellationError,
  isCancellationError,
} from './request-scheduler.js';
import { MAX_SEAM_SPAN_DEG } from './geo/viewport-bounds.js';
import { MAX_MERCATOR_LAT } from './geo/mercator.js';
import { isProbeEnabled } from './telemetry.js';

/** `format` discriminator written into every packed manifest. */
const PACKED_FORMAT = 'stt-packed';
/**
 * The packed format this reader understands (packed spec §5.2 / design doc
 * `stt-packed-format-decisions.md`): `STTP`/`STTD` object magic with
 * object-absolute blob offsets, manifest-embedded `schemas` templates, and the
 * sectioned, template-referencing layer frame.
 *
 * A closed enum in the manifest schema — conformance requires rejecting
 * anything else at open, mirroring the Rust reader. The transitional 0.3.x
 * format (formatVersion 1) was removed after the published fleet was migrated.
 */
const PACKED_FORMAT_VERSION = 3;
/**
 * Oldest manifest `formatVersion` this reader OPENS.
 *
 * v2 differs from v3 in the container only — no `variants` registry (the variant
 * axis did not exist, so every payload is raw) and directory codec v5 (no
 * per-entry `variantId`). Tile payloads share the same layer-frame version, so
 * nothing below the container forks.
 *
 * Read-only: every writer emits `PACKED_FORMAT_VERSION`. This exists because a
 * published archive is a durable artifact and several have no reproducible
 * source, so a read-side cutover would strand them rather than migrate them.
 */
const MIN_PACKED_FORMAT_VERSION = 2;
/**
 * Oldest directory codec this reader decodes: v5, the codec every packed v2
 * archive carries. NOT 4 — v4 is the retired SINGLE-FILE directory that the
 * packed client never read, and widening to it here would claim support this
 * reader has never had.
 */
const MIN_DIRECTORY_VERSION = 5;
/** Oldest `.sttd` / `.sttp` object prelude version this reader accepts. */
const MIN_OBJECT_MAGIC_VERSION = 2;
/**
 * Byte length of the v2 object magic prelude (`"STTD"`/`"STTP"` + u8
 * version(2) + 3 zero bytes). v2 directory reads skip it (blob offsets in
 * the directory are already object-absolute, so pack reads need no shift).
 */
const OBJECT_MAGIC_LEN = 8;

/**
 * `manifest.capabilities` values this reader implements — the
 * required-to-understand feature registry (docs/spec/stt-packed-format.md
 * §3.1). Each capability RE-TYPES existing tile columns (quantized geometry,
 * quantized numeric properties, elevation-folded 3-component points, compact
 * `UInt32` feature times, `UInt16` per-vertex values), so a reader that lacks
 * one wouldn't fail downstream — it would silently misdecode (e.g. Int32 grid
 * indices read as microscopic lon/lat degrees, millisecond offsets read as
 * absolute Unix times, or 0..65534 value indices read as physical units).
 * Conformance requires refusing, at open, a dataset declaring anything outside
 * this set, mirroring the Rust reader (`pack.rs`'s `KNOWN_CAPABILITIES`).
 */
export const KNOWN_MANIFEST_CAPABILITIES: readonly string[] = [
  'coord-quant',
  'attr-quant',
  'elevation-fold',
  'time-delta',
  'vertex-value-quant',
  // TB-12. Supported unconditionally, and it is the decoder — not any one
  // backend — that supports it: `decodeTile` completes a partially-baked
  // triangle buffer by earcutting each provably single-ring feature whose baked
  // list is empty. Every consumer therefore sees a full buffer and needs no
  // change, which is what makes this one safe to declare here (unlike
  // `additive-partition` below, whose support is conditional on a render mode).
  'triangles-partial',
  // TB-11 extension 2. `TILE_META.vtf` anchors per-vertex time deltas to each
  // feature's own start_time; `extractVertexTimes` branches on it. Supported
  // unconditionally, like `triangles-partial` and unlike `additive-partition`:
  // the decoder resolves it and every downstream consumer sees absolute times.
  'vertex-time-feature-anchor',
  // ⚠️ DT-2's `additive-partition` is deliberately NOT here yet, and the reason
  // is the whole point of the capability. This reader CAN union across zooms
  // (`lodMode: 'additive'`), but that mode is an explicit option whose default
  // is `'parent-fallback'`. Declaring support before the tileset DEFAULTS
  // `lodMode` from `metadata.partition` would mean opening a home-zoom archive
  // and then rendering a sparse per-zoom slice as if it were complete — exactly
  // the silent misdecode this registry exists to prevent, reintroduced one
  // layer up. Add it in the same change that lands the defaulting, not before.
];

/**
 * The variant registry to validate a manifest's tiles against.
 *
 * A pre-v3 manifest carries no `variants` key, because the variant axis did not
 * exist when it was written — so every payload in such an archive is raw, and
 * its directory decodes every entry to variant 0. The absent registry is not
 * missing information; it is the IMPLICIT raw-only registry. Returned here
 * rather than written back onto the parsed manifest, so parsing stays a faithful
 * record of the bytes on disk (mirrors Rust `pack::effective_variants`).
 *
 * A v3 manifest is returned unchanged: `variants` is required there, and an
 * empty one stays the hard error it should be.
 */
function effectiveVariants(manifest: {
  formatVersion?: number;
  variants?: ManifestVariant[];
  metadata?: { summary_tier?: { variant_id?: number } };
}): ManifestVariant[] {
  const declared = manifest.variants;
  if (
    (manifest.formatVersion ?? PACKED_FORMAT_VERSION) >=
      PACKED_FORMAT_VERSION ||
    (Array.isArray(declared) && declared.length > 0)
  ) {
    return declared ?? [];
  }
  const implied: ManifestVariant[] = [{ id: 0, kind: 'raw' }];
  // A legacy summary tier named its variant in `metadata.summary_tier` — the
  // only place it could — so honour that, or every summary tile in the archive
  // reads as an undeclared variant.
  const summaryId = manifest.metadata?.summary_tier?.variant_id;
  if (typeof summaryId === 'number' && summaryId !== 0) {
    implied.push({ id: summaryId, kind: 'summary' });
  }
  return implied;
}

/** `directory.layout` value for the paged container. */
const DIRECTORY_LAYOUT_PAGED = 'paged';
/**
 * A paged directory whose whole at-rest size is ≤ this is fetched in one GET and
 * fully decoded (no paging benefit, but no extra request + no incremental
 * bookkeeping) — small/wildfires-shaped datasets behave exactly as a single
 * whole-load directory. Above it, only the root page is fetched up front and
 * leaves stream in on demand. ~256 KiB ≈ a few thousand entries.
 */
const SMALL_DIR_THRESHOLD = 256 * 1024;

const DEFAULT_MAX_CACHE_TILES = 500;
const MOBILE_MAX_CACHE_TILES = 100;
/**
 * Default max gap (bytes) between two tile ranges still worth coalescing into
 * one HTTP range request. On free-egress object storage one saved ~60 ms RTT
 * is worth multiple MB of over-fetch, so the old 32 KB was far too tight.
 *
 * Raised 512 KB → 2 MB: on a free-egress store (R2) the over-fetched gap bytes
 * cost nothing, while each saved request is both a billed GET and a round-trip.
 * A wider gap bridges across the byte-space between different cells' time-runs,
 * which is what collapses a globe view's many small per-cell requests into far
 * fewer ones. The downside (larger single requests) is bounded separately by
 * the per-fetch size cap; the gap only controls how aggressively neighbours
 * fuse. Overridable per-archive via `ArchiveOptions.coalesceGapBytes`.
 *
 * ── The build/reader divergence (CO-7) ─────────────────────────────────────
 * This constant is MIRRORED build-side by `stt_core::ordering_sim::
 * DEFAULT_COALESCE_GAP_BYTES`, which is what the writer's `measured` ordering
 * simulation prices layouts at. Since CO-7 the *session* gap is fitted
 * ({@link adaptiveCoalesceGapBytes}) while the simulator deliberately stays on
 * this build-assumed constant: build-time layout decisions must stay correct
 * and reproducible, and a layout chosen under a moving reader constant would
 * be neither. The divergence is intentional and is closed — not by making the
 * simulator adaptive, but by co-versioning the assumption in the manifest
 * (`metadata.ordering_workload.coalesce_gap_bytes`, SH-3 / M7) so
 * `stt-optimize order-audit` can see reader-vs-layout drift. That declared gap
 * is ALSO what licenses the reader to adapt at all; see
 * {@link manifestBuildAssumedGapBytes} and {@link adaptiveCoalesceGapBand}.
 *
 * This value is also the permanent FALLBACK: a pinned
 * `ArchiveOptions.coalesceGapBytes`, a cold estimator, or an archive that
 * declares no build-assumed gap all resolve here, so absent measurement the
 * reader behaves exactly as it did before CO-7.
 */
export const DEFAULT_RANGE_COALESCE_GAP = 2 * 1024 * 1024;
/**
 * Absolute floor of the adaptive coalesce band (CO-7). Below ~256 KiB a saved
 * request stops paying for itself on any realistic link, and the estimator's
 * own noise dominates; it is also the width that keeps a leaf-page run fused on
 * the cold-start path. A zero/near-zero `L̂` (a same-process or cache-warm
 * transport) therefore lands on a floor rather than collapsing the fuse rule to
 * "never coalesce".
 *
 * The archive's declared build-assumed gap can raise this floor but never lower
 * it — the effective band is the INTERSECTION of the two (see
 * {@link adaptiveCoalesceGapBand}).
 */
export const MIN_ADAPTIVE_COALESCE_GAP = 256 * 1024;
/**
 * Ceiling of the adaptive coalesce band (CO-7). The estimator feeds back on
 * itself — a larger gap means fewer, longer transfers, which changes the
 * samples that set the gap — so the band, not the formula, is what bounds the
 * loop. 4 MiB is 2× the historic default: enough to express a genuinely
 * high-latency origin, not enough for one mis-estimate to turn a viewport into
 * a multi-megabyte over-fetch.
 */
export const MAX_ADAPTIVE_COALESCE_GAP = 4 * 1024 * 1024;
/**
 * Half-width (as a multiplicative factor) of the band the session gap may move
 * inside, around the gap the WRITER's layout cost model assumed — the CO-7
 * co-versioning guard / hazard D6.
 *
 * A layout the writer chose by simulation was priced at one specific gap
 * (`stt_core::ordering_sim::DEFAULT_COALESCE_GAP_BYTES`), and the archive is
 * content-addressed, so it cannot be re-fitted in place. Reading it under an
 * arbitrarily different gap silently invalidates the fit. Reading it under a
 * gap within ×2 of the declared one does not: the fuse decisions that flip
 * inside that band are the marginal ones the simulation itself priced as
 * near-ties. So the reader adapts *inside the declared band* and reports the
 * drift ({@link CoalesceGapEstimate.driftsFromBuildAssumption}) for
 * `stt-optimize order-audit` to adjudicate.
 *
 * NOT gated on `blobOrdering`. The manifest's ordering string names the WINNER
 * of the selection (`"spatial"`, `"time-major"`, `"hilbert3"`, `"morton3"` —
 * `stt_core::curve::BlobOrdering::as_str`), never the selection MODE, so
 * `measured` never appears in it and a string allow-list cannot tell a fitted
 * layout from a declared one. The build-assumed gap can, because the writer
 * emits it exactly when (and only when) the ordering was resolved by
 * simulation.
 */
export const ADAPTIVE_GAP_BAND_FACTOR = 2;

/**
 * The gap the writer's layout cost model assumed, in bytes, or `null` when the
 * archive does not declare one (CO-7 / SH-3).
 *
 * The field is `metadata.ordering_workload.coalesce_gap_bytes` — snake_case,
 * inside the verbatim stt-core metadata block, written by `PackWriter::
 * finalize` and typed by `stt_core::metadata::OrderingWorkload`. It is present
 * on exactly the archives whose blob ordering was resolved by SIMULATION (the
 * `measured` selection mode) and absent everywhere else, which is precisely
 * the distinction the co-versioning guard needs.
 *
 * Absent ⇒ `null` ⇒ the layout's provenance is unknown, and unknown is never
 * guessed at. Every legacy and every explicitly-ordered archive lands here.
 */
export function manifestBuildAssumedGapBytes(
  manifest: PackedManifest | undefined,
): number | null {
  const declared = (manifest?.metadata as ManifestMetadataShape | undefined)
    ?.ordering_workload?.coalesce_gap_bytes;
  return typeof declared === 'number' &&
    Number.isFinite(declared) &&
    declared >= 0
    ? declared
    : null;
}

/**
 * The fitted coalesce gap: `L̂ × θ̂`, clamped into the band the archive's own
 * build-assumed gap declares (CO-7).
 *
 * `L̂ × θ̂` — one round trip's latency times the link's byte rate — is the
 * BYTE VALUE OF ONE REQUEST: the number of bytes the link would have moved in
 * the time the extra round trip costs. Over-fetching fewer bytes than that to
 * avoid a request is a win; over-fetching more is a loss. That is exactly the
 * quantity the fuse rule already compares gaps against, so the RULE is
 * untouched (register: extend, never replace) — only its constant becomes
 * fitted.
 *
 * Two honesty contracts, both resolving to {@link DEFAULT_RANGE_COALESCE_GAP}:
 *
 *  - Either estimator COLD (`null`), or a non-finite / negative reading. A
 *    cold estimator is never read as "zero latency" or "infinite bandwidth";
 *    it means *unmeasured*, and unmeasured falls back to the incumbent.
 *  - No `buildAssumedGapBytes`. Without it the reader cannot know what the
 *    layout was priced at, so it does not move off the constant the layout was
 *    (at worst) priced at — see {@link manifestBuildAssumedGapBytes}. This is
 *    the co-versioning guard, and it lives in this pure function so no caller
 *    can forget it.
 *
 * The band is `[G/2, G×2]` ({@link ADAPTIVE_GAP_BAND_FACTOR}) intersected with
 * the reader's own safety band `[256 KiB, 4 MiB]`. A declared gap so far
 * outside that safety band that the intersection is EMPTY (e.g. a 64 MiB build
 * assumption) also falls back to the incumbent constant: the reader will not
 * adapt toward an assumption it is unwilling to honor.
 *
 * Pure: no clock, no state, no I/O. Fixed inputs are a fixed gap, which is what
 * makes the request plan reproducible under injected estimator state.
 */
export function adaptiveCoalesceGapBytes(
  latencyMs: number | null | undefined,
  bytesPerMs: number | null | undefined,
  buildAssumedGapBytes: number | null | undefined,
): number {
  // The co-versioning guard: no usable declared band ⇒ no adaptation at all.
  const band = adaptiveCoalesceGapBand(buildAssumedGapBytes);
  if (band === null) {
    return DEFAULT_RANGE_COALESCE_GAP;
  }
  if (
    typeof latencyMs !== 'number' ||
    typeof bytesPerMs !== 'number' ||
    !Number.isFinite(latencyMs) ||
    !Number.isFinite(bytesPerMs) ||
    latencyMs < 0 ||
    bytesPerMs < 0
  ) {
    return DEFAULT_RANGE_COALESCE_GAP;
  }
  const requestValueBytes = latencyMs * bytesPerMs;
  return Math.min(
    band.ceilingBytes,
    Math.max(band.floorBytes, requestValueBytes),
  );
}

/**
 * The band the session gap may move inside, given the archive's declared
 * build-assumed gap: `[G/2, G×2]` ({@link ADAPTIVE_GAP_BAND_FACTOR})
 * intersected with the reader's own safety band
 * `[{@link MIN_ADAPTIVE_COALESCE_GAP}, {@link MAX_ADAPTIVE_COALESCE_GAP}]`.
 *
 * `null` — meaning "do not adapt" — in exactly two cases:
 *  - no declared build gap (`null`, absent, non-finite, ≤ 0): the layout's
 *    provenance is unknown, which is the whole published fleet today;
 *  - the intersection is EMPTY (e.g. a 64 MiB build assumption): the reader
 *    will not adapt toward an assumption it is unwilling to honor.
 */
export function adaptiveCoalesceGapBand(
  buildAssumedGapBytes: number | null | undefined,
): { floorBytes: number; ceilingBytes: number } | null {
  if (
    typeof buildAssumedGapBytes !== 'number' ||
    !Number.isFinite(buildAssumedGapBytes) ||
    buildAssumedGapBytes <= 0
  ) {
    return null;
  }
  const floorBytes = Math.max(
    MIN_ADAPTIVE_COALESCE_GAP,
    buildAssumedGapBytes / ADAPTIVE_GAP_BAND_FACTOR,
  );
  const ceilingBytes = Math.min(
    MAX_ADAPTIVE_COALESCE_GAP,
    buildAssumedGapBytes * ADAPTIVE_GAP_BAND_FACTOR,
  );
  return floorBytes > ceilingBytes ? null : { floorBytes, ceilingBytes };
}

/** Why {@link STTArchive.effectiveCoalesceGap} returned the value it did. */
export type CoalesceGapSource =
  /** Fitted from `L̂ × θ̂` — adaptation is live. */
  | 'adaptive'
  /** `ArchiveOptions.coalesceGapBytes` was supplied; adaptation is disabled. */
  | 'pinned'
  /** One or both estimators have no samples yet. */
  | 'cold'
  /**
   * The manifest declares no build-assumed gap
   * ({@link manifestBuildAssumedGapBytes}), so the layout's provenance is
   * unknown and the incumbent constant stands. Every legacy and every
   * explicitly-ordered archive reports this.
   */
  | 'no-build-gap';

/**
 * The active coalesce gap plus the evidence behind it. The honesty flags ride
 * in the return type so a caller cannot mistake the incumbent 2 MiB constant
 * for a measured value — `source` says which one it is, and `latencyMs` /
 * `bytesPerMs` are `null` exactly when the corresponding estimator is cold.
 */
export interface CoalesceGapEstimate {
  /** Gap in bytes that both fuse sites will use right now. */
  gapBytes: number;
  /** Where {@link gapBytes} came from. */
  source: CoalesceGapSource;
  /** `L̂` in ms, or `null` when the latency estimator is cold. */
  latencyMs: number | null;
  /** `θ̂` in bytes/ms, or `null` when the throughput estimator is cold. */
  bytesPerMs: number | null;
  /** `manifest.blobOrdering`, or `null` when absent / manifest not yet open. */
  blobOrdering: string | null;
  /**
   * The gap the writer's layout cost model assumed
   * (`metadata.ordering_workload.coalesce_gap_bytes`), else `null`. This is the
   * co-versioning gate: `null` means no adaptation, whatever the estimators
   * say.
   */
  buildAssumedGapBytes: number | null;
  /**
   * True when the archive declares a build-assumed gap and the active session
   * gap differs from it: the layout was priced at one exchange rate and is
   * being read under another. Bounded by {@link ADAPTIVE_GAP_BAND_FACTOR} —
   * reported here, adjudicated by `stt-optimize order-audit`.
   */
  driftsFromBuildAssumption: boolean;
}

// ── CO-5: the temporal-tier pick as a 1-D argmin ────────────────────────────
//
// Losslessness (§7.5 constraint (i)) makes EVERY addressable temporal tier a
// correct answer: a coarse-bucket tile holds the same features as the base
// tiles it aggregates, just addressed by a wider bucket. So the choice between
// tiers is not a correctness question at all — it is pure cost, and the reader
// already knows both terms of it exactly (CO-1 prices the bytes; CO-7 prices
// the request). What lived here before was a ZOOM THRESHOLD, which knows
// neither: a window far narrower than the coarse bucket over-fetches (one
// 24 h tile to show 10 minutes), and a wide window at a zoom just above a
// cutoff under-aggregates (720 hourly tiles where one daily tile would do).
//
// This prices EXISTING tiers only. It is emphatically NOT the feature-reducing
// tier of §11.6 / G5 — nothing here drops, samples or aggregates anything, and
// the temporal scrub axis stays counted out of that trigger (M8/DT-3 owns it).

/**
 * One priced candidate tier in {@link temporalTierArgmin}.
 */
export interface TemporalTierCost {
  /** The tier's bucket width in ms (the archive base bucket, or a LOD level). */
  bucketMs: number;
  /** CO-1's answer for this tier's selection, honesty flag and all. */
  selection: SelectionCost;
  /**
   * The objective: `bytes + tiles × requestOverheadBytes`. Meaningful only
   * when `selection.unknownTiles === 0` — a lower-bound byte sum makes a
   * lower-bound cost, which is exactly the thing that must not be compared.
   */
  cost: number;
  /**
   * Whether this tier is allowed to WIN the argmin.
   *
   * A declared tier that holds NOTHING for this (bbox, zoom, window) prices at
   * `bytes = 0, tiles = 0` — so on the raw objective it costs 0, and sorted
   * coarsest-first it beats the tier that actually holds the data on a strict
   * `<`. What it buys is a BLANK FRAME. Zero coverage is not a cheap tier, it
   * is an unusable one, so `tiles === 0` (or a nonsense tile count) is
   * INELIGIBLE rather than free. Ineligible candidates are still priced and
   * still reported — they are audit trail, never answers.
   */
  eligible: boolean;
}

/** Why {@link temporalTierArgmin} declined to answer (`'none'` ⇒ it did). */
export type TemporalTierAbstention =
  /** A comparison was made; `pick` is its argmin. */
  | 'none'
  /** Some candidate priced with `unknownTiles > 0` — lower bounds, not costs. */
  | 'unpriced-tiles'
  /** `L̂` or `θ̂` is cold: the request term has no measured value. */
  | 'unmeasured-request-price'
  /** Nothing addressable, or no addressable tier had any coverage here. */
  | 'no-eligible-tier';

/** The outcome of {@link temporalTierArgmin}. */
export interface TemporalTierArgmin {
  /**
   * The cheapest ELIGIBLE tier, or `null` when the comparison could not be
   * made honestly — see {@link reason}. `null` is the caller's signal to fall
   * back to the zoom-threshold pick; it is never a signal to guess.
   */
  pick: TemporalTierCost | null;
  /** Every candidate, COARSEST FIRST — the audit trail behind `pick`. */
  candidates: TemporalTierCost[];
  /**
   * The bytes-equivalent request price the objective was evaluated at; `0`
   * when the price was unmeasured (in which case `pick` is `null` and the
   * reported costs are bytes-only, for the audit trail alone).
   */
  requestOverheadBytes: number;
  /** `false` when any candidate's BYTES were a lower bound. */
  exact: boolean;
  /** `'none'` iff {@link pick} is non-null; otherwise why it is not. */
  reason: TemporalTierAbstention;
}

/**
 * The ADDRESSABLE tier set at `zoom`: `{base} ∪ {levels with zoom ≤
 * maxZoomLevel}`, deduplicated and returned COARSEST FIRST.
 *
 * The membership rule is deliberately identical to
 * `STTArchive.pickTemporalLodForZoom`'s applicability test, so the incumbent's
 * answer is always a member of this set — which is what makes
 * "argmin cost ≤ zoom-threshold cost" true by construction rather than by
 * measurement.
 *
 * A returned length of 1 means only the base tier is addressable: there is
 * nothing to choose, and the caller must take the incumbent path unchanged.
 */
export function addressableTemporalTiers(
  levels: readonly TemporalLodLevel[] | null | undefined,
  baseBucketMs: number,
  zoom: number,
): number[] {
  const tiers = new Set<number>();
  if (Number.isFinite(baseBucketMs) && baseBucketMs > 0) {
    tiers.add(baseBucketMs);
  }
  for (const level of levels ?? []) {
    if (!Number.isFinite(level.bucketMs) || level.bucketMs <= 0) continue;
    if (zoom <= level.maxZoomLevel) tiers.add(level.bucketMs);
  }
  // Descending bucket width: coarsest first, which is also the tie-break
  // order (see temporalTierArgmin).
  return [...tiers].sort((a, b) => b - a);
}

/**
 * The bytes-equivalent price of ONE REQUEST: `L̂ × θ̂`, the bytes this link
 * would move during the round trip an extra request costs. `null` means
 * UNMEASURED — either estimator cold, or a nonsense reading.
 *
 * `null` is not a small price, not a large one, and emphatically not 2 MiB.
 * {@link DEFAULT_RANGE_COALESCE_GAP} is a safe FUSE THRESHOLD and an unsafe
 * PRICE: at 2 MiB the `tiles × price` term dwarfs the byte term on essentially
 * every real selection (a 500 KB byte term against a 10.5 MB request term in
 * the CO-5 probe), so an argmin fed the constant ranks candidates by REQUEST
 * COUNT and not by cost. Ranking by request count alone is exactly the family
 * of mistake the do-not-touch register records (the 669 MiB incident), which
 * is why the honest answer to a cold estimator is to abstain, not to
 * substitute.
 *
 * Deliberately NOT clamped into CO-7's `[MIN_ADAPTIVE_COALESCE_GAP,
 * MAX_ADAPTIVE_COALESCE_GAP]` band: that band bounds how much OVER-FETCH one
 * estimate may authorize on the fuse path. Here the product is an exchange
 * rate between two measured quantities, and clamping it would distort a
 * comparison rather than bound a risk.
 */
export function requestPriceBytes(
  latencyMs: number | null | undefined,
  bytesPerMs: number | null | undefined,
): number | null {
  if (
    typeof latencyMs !== 'number' ||
    typeof bytesPerMs !== 'number' ||
    !Number.isFinite(latencyMs) ||
    !Number.isFinite(bytesPerMs) ||
    latencyMs < 0 ||
    bytesPerMs < 0
  ) {
    return null;
  }
  return latencyMs * bytesPerMs;
}

/**
 * Argmin of `cost(b) = bytes(b) + tiles(b) × requestOverheadBytes` over the
 * priced candidates.
 *
 * `requestOverheadBytes` is the BYTES-EQUIVALENT PRICE OF ONE REQUEST, `L̂ × θ̂`
 * as {@link requestPriceBytes} computes it from the latency and throughput
 * estimators. It converts a tile COUNT into bytes so the two terms of the
 * objective are commensurable — which is the whole reason a coarse tier can
 * win despite fetching bytes it does not strictly need. Pass `null` when it is
 * unmeasured.
 *
 * Determinism: candidates are sorted by bucket width descending (a total order
 * on a numeric key) and a challenger replaces the incumbent only on a STRICT
 * improvement, so ties resolve to the COARSER tier, always, regardless of the
 * order the caller priced them in.
 *
 * Honesty — three ways this refuses to answer, all reported in `reason` and
 * all routing the caller back to the incumbent zoom threshold:
 *  - `unpriced-tiles`: some candidate reports `unknownTiles > 0`. A selection
 *    the reader cannot see is COUNTED, never estimated, so the cheapest of a
 *    set of lower bounds is not a cheapest tier — it is a guess.
 *  - `unmeasured-request-price`: `requestOverheadBytes` is `null` (or
 *    nonsense). Half a priced objective is not an objective; substituting a
 *    constant for the missing half decides the argmin by that constant.
 *  - `no-eligible-tier`: nothing addressable, or every addressable tier has
 *    ZERO coverage here. A zero-coverage tier costs 0 and would otherwise win
 *    outright, delivering a blank frame (see {@link TemporalTierCost.eligible}).
 */
export function temporalTierArgmin(
  priced: ReadonlyArray<{ bucketMs: number; selection: SelectionCost }>,
  requestOverheadBytes: number | null,
): TemporalTierArgmin {
  // A measured price of exactly 0 is a real reading ("this link says a round
  // trip is worth nothing") and stays a price. `null`/NaN/negative is the
  // ABSENCE of a reading and is handled below by abstaining outright.
  const measured =
    typeof requestOverheadBytes === 'number' &&
    Number.isFinite(requestOverheadBytes) &&
    requestOverheadBytes >= 0;
  const overhead = measured ? requestOverheadBytes : 0;
  const candidates: TemporalTierCost[] = [...priced]
    .sort((a, b) => b.bucketMs - a.bucketMs)
    .map((c) => ({
      bucketMs: c.bucketMs,
      selection: c.selection,
      cost: c.selection.bytes + c.selection.tiles * overhead,
      eligible: Number.isFinite(c.selection.tiles) && c.selection.tiles > 0,
    }));
  const exact = candidates.every((c) => c.selection.unknownTiles === 0);
  const abstain = (reason: TemporalTierAbstention): TemporalTierArgmin => ({
    pick: null,
    candidates,
    requestOverheadBytes: overhead,
    exact,
    reason,
  });
  if (!exact) return abstain('unpriced-tiles');
  if (!measured) return abstain('unmeasured-request-price');
  // Coarsest-first + strict `<` ⇒ ties resolve to the coarser tier.
  let pick: TemporalTierCost | null = null;
  for (const candidate of candidates) {
    if (!candidate.eligible) continue;
    if (pick === null || candidate.cost < pick.cost) pick = candidate;
  }
  if (pick === null) return abstain('no-eligible-tier');
  return {
    pick,
    candidates,
    requestOverheadBytes: overhead,
    exact,
    reason: 'none',
  };
}

/**
 * What {@link STTArchive.pickTemporalLodByCost} answers: which temporal tier
 * to address, what it costs, and — critically — HOW the answer was reached.
 */
export interface TemporalTierPick {
  /**
   * The tier to request. Equal to the archive's base `temporalBucketMs` when
   * the base tier won, in which case the caller should use
   * {@link STTArchive.getTileIdsInBounds} rather than the LOD query.
   */
  bucketMs: number;
  /** Σ compressed bytes for {@link bucketMs}'s selection; `0` if unpriced. */
  bytes: number;
  /** Tiles in {@link bucketMs}'s selection; `0` if unpriced. */
  tiles: number;
  /** `bytes + tiles × requestOverheadBytes`; `Infinity` if unpriced. */
  cost: number;
  /**
   * The measured `L̂·θ̂` exchange rate the objective used, or `0` when it was
   * unmeasured — in which case {@link policy} is `'zoom-threshold'`. It is
   * NEVER the 2 MiB coalesce-gap constant standing in for a measurement.
   */
  requestOverheadBytes: number;
  /**
   * `'cost-argmin'` when the tiers were compared; `'zoom-threshold'` when the
   * comparison could not be made honestly and the incumbent rule answered.
   */
  policy: 'cost-argmin' | 'zoom-threshold';
  /**
   * `true` iff a complete cost comparison produced this answer. `false` means
   * {@link bytes} / {@link tiles} / {@link cost} are NOT authoritative and
   * {@link policy} is `'zoom-threshold'`; {@link abstainReason} says why.
   */
  exact: boolean;
  /** `'none'` when {@link policy} is `'cost-argmin'`; otherwise why it is not. */
  abstainReason?: TemporalTierAbstention;
}

/** Default ceiling on concurrent range requests per coalesced batch. */
const DEFAULT_MAX_CONCURRENT_REQUESTS = 24;
/**
 * Base backoff delays for transient range-request failures (WS-E loader
 * hardening): 2 retries before a request is considered failed. Each delay is
 * jittered ±50% (full jitter) so a fleet of throttled clients doesn't
 * re-stampede the host in lockstep. Aborts are NEVER retried.
 */
const DEFAULT_RANGE_RETRY_DELAYS_MS = [250, 1000];
/** Default fair-share weight for an archive in the process-shared scheduler. */
const DEFAULT_SCHEDULER_WEIGHT = 1;
/**
 * Tier base for the shared scheduler's cross-source EDF priority. A `'low'`
 * (prefetch/lookahead) range-group is offset by this large constant so it ALWAYS
 * ranks below any need-now (`'auto'`/`'high'`) group GLOBALLY across sources —
 * the bandwidth analog of required-vs-optional (§2.7). Need-now groups start at
 * base 0; within a tier, the EDF distance-to-playhead term orders them. The
 * constant exceeds any realistic distance-to-playhead in sim-ms so the tiers
 * never interleave.
 */
const SCHEDULER_PREFETCH_TIER_BASE = 1e15;
/**
 * Weight applied to the spatial tie-break's squared normalized-mercator
 * distance (range [0, 2]) before it's added into
 * {@link ArchiveReader.groupSchedulerPriority}'s returned priority. Kept
 * comfortably under 1 (max contribution 2 × 0.4 = 0.8) so it can only ever
 * flip an ordering between requests whose EDF/enqueue term already differ by
 * less than a whole unit — i.e. a genuine near-tie in time — and never
 * overrides a real temporal or tier distinction (`SCHEDULER_PREFETCH_TIER_BASE`
 * and typical distance-to-playhead terms are both orders of magnitude larger).
 */
const SPATIAL_TIEBREAK_WEIGHT = 0.4;
/**
 * Default per-transfer stall timeout. hls.js ships 20 s (`fragLoadingTimeOut`)
 * and Shaka ~30 s; without one, a TCP-stalled response hangs its tile forever
 * — the batch member stays in flight and is never re-requested. A timeout is
 * a TRANSIENT failure (retried), unlike a caller abort (propagated).
 * Overridable per-archive via `ArchiveOptions.transferTimeoutMs`; `0` disables.
 */
const DEFAULT_TRANSFER_TIMEOUT_MS = 20_000;
/**
 * Threshold at which a bounds query stops enumerating theoretical `(x, y)`
 * cells and switches to the per-zoom occupied-cell index.
 *
 * The scan runs on the selection path, and the tileset's selection key folds in
 * the time range — so during playback it re-runs at display refresh, not at
 * 10 Hz. It is bounded by the viewport in principle, but two things break that:
 * the camera zoom is CLAMPED up into the archive's `[minZoom, maxZoom]`, so a
 * whole-world camera over a `min_zoom: 10` archive covers 2^10 × 2^10 cells; and
 * a degenerate box (see {@link orderLonRange}) can claim nearly the whole world
 * at any zoom. Materializing those grids used to allocate ~5e5 two-element
 * arrays per pass, almost all of which missed `tileEntryIndex`.
 *
 * Crossing it selects from the occupied-cell index and WARNS; it never
 * truncates results. Narrowing the query to `metadata.bounds` is unsound for
 * the reason recorded above `lonToTileX`. The warning still matters because a
 * world-sized box at high zoom usually identifies an upstream camera/zoom
 * defect even when the sparse query makes it cheap. The threshold is FAR above
 * any legitimate
 * footprint on purpose — the corrected pitched-frustum footprint is ~750 cells
 * at z8/pitch 80 (docs/roadmap/tile-loading-3d-2026-07.md §4.4: tile counts
 * legitimately RISE under pitch and must not be tuned back down), so 8192 is an
 * order of magnitude of headroom and only ever fires on a defect.
 */
const MAX_QUERY_SCAN_CELLS = 8192;

/** Whether an error is a fetch cancellation (must propagate, never retry). */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Compose independent cancellation owners without dropping either one.
 * Used to combine a per-query signal with the archive lifetime. The caller
 * must run `cleanup` when the operation settles so listeners do not accumulate
 * on long-lived query/archive signals.
 */
function composeAbortSignals(...signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal | undefined;
  cleanup: () => void;
} {
  const present = [
    ...new Set(signals.filter((s): s is AbortSignal => s !== undefined)),
  ];
  if (present.length === 0) return { signal: undefined, cleanup: () => {} };
  if (present.length === 1) return { signal: present[0], cleanup: () => {} };

  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; fn: () => void }> = [];
  for (const signal of present) {
    const fn = (): void => {
      if (!controller.signal.aborted) {
        controller.abort(
          signal.reason ??
            new DOMException('The operation was aborted.', 'AbortError'),
        );
      }
    };
    if (signal.aborted) {
      fn();
      break;
    }
    signal.addEventListener('abort', fn, { once: true });
    listeners.push({ signal, fn });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const { signal, fn } of listeners) {
        signal.removeEventListener('abort', fn);
      }
    },
  };
}

/**
 * Compose the caller's abort signal with a stall timeout. The returned signal
 * aborts with a `TimeoutError` reason when `timeoutMs` elapses, or mirrors the
 * caller's abort (reason and all) — so retry logic can tell the two apart
 * (timeout → retryable transient, caller abort → propagate). `cleanup` MUST
 * run when the transfer settles: it clears the timer and detaches the
 * caller-signal listener so neither outlives the request.
 */
function withTransferTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (!(timeoutMs > 0)) return { signal, cleanup: () => {} };
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort(
      signal?.reason ??
        new DOMException('The operation was aborted.', 'AbortError'),
    );
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException(
        `STT transfer stalled for ${timeoutMs} ms`,
        'TimeoutError',
      ),
    );
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Race a transport promise against an abort signal. Spec-conformant `fetch`
 * rejects on its own when its signal aborts, but custom transports
 * (`ArchiveOptions.fetch`, `loadOptions.fetch`) may ignore the signal
 * entirely — the race guarantees the stall timeout still fires through them.
 * Rejects with the signal's abort reason (`TimeoutError` / `AbortError`).
 */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  const reasonOf = (): unknown =>
    signal.reason ??
    new DOMException('The operation was aborted.', 'AbortError');
  if (signal.aborted) {
    // The transport promise already exists (the call raced the abort) and
    // will reject on its own — swallow that rejection so it can't surface
    // as an unhandled-rejection pageerror. The caller still gets the abort
    // reason through the rejection below.
    promise.catch(() => {});
    return Promise.reject(reasonOf());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(reasonOf());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Validate a 206's `Content-Range` against the requested offsets. A proxy or
 * truncating origin that rewrites the range would silently corrupt every
 * member sliced out of a coalesced buffer, so a mismatch is an error (and a
 * retryable one — the byte-length check downstream backstops transports that
 * don't surface headers at all, e.g. test shims).
 */
function validateContentRange(
  response: Response,
  start: number,
  end: number,
): void {
  const header =
    typeof response.headers?.get === 'function'
      ? response.headers.get('content-range')
      : null;
  if (!header) return;
  const m = /^bytes (\d+)-(\d+)\//.exec(header);
  if (!m || Number(m[1]) !== start || Number(m[2]) !== end) {
    throw new Error(
      `STT pack server returned mismatched Content-Range ${JSON.stringify(header)} ` +
        `for bytes=${start}-${end}`,
    );
  }
}

/**
 * Resolve after `ms`, rejecting immediately with an `AbortError` if `signal`
 * fires first — so a retry backoff never outlives its request's cancellation.
 */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Monotonic-ish wall clock for throughput samples. */
function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function getDeviceAwareCacheSize(): number {
  if (typeof navigator !== 'undefined' && 'deviceMemory' in navigator) {
    const gb = (navigator as any).deviceMemory as number;
    if (gb <= 2) return MOBILE_MAX_CACHE_TILES;
    if (gb <= 4) return Math.floor(DEFAULT_MAX_CACHE_TILES / 2);
  }
  if (
    typeof navigator !== 'undefined' &&
    /mobile|android|iphone|ipad/i.test(navigator.userAgent)
  ) {
    return MOBILE_MAX_CACHE_TILES;
  }
  return DEFAULT_MAX_CACHE_TILES;
}

function getDeviceAwareCacheByteSize(): number {
  return getDeviceAwareCacheSize() <= MOBILE_MAX_CACHE_TILES
    ? 256 * 1024 * 1024
    : 512 * 1024 * 1024;
}

/**
 * Compressed tile caches are per archive, but memory pressure is per process.
 * This insertion-ordered map is a shared O(1) LRU across every live archive,
 * preventing a ten-source composite from multiplying the nominal 512 MiB
 * budget tenfold.
 */
interface SharedByteCacheEntry {
  byteSize: number;
  evict: () => void;
  /**
   * Playhead-aware eviction score (BH-8), supplied by the owning archive.
   * HIGHER = evict sooner. Reads the owner's LIVE playhead/loop fields on
   * every call — it must never capture archive state that a later eviction
   * could invalidate. Absent (or a non-finite return) scores 0, which is
   * exactly the pre-BH-8 pure-LRU behavior.
   */
  score?: () => number;
}
const sharedByteCacheLru = new Map<string, SharedByteCacheEntry>();
let sharedByteCacheBytes = 0;
let nextArchiveCacheId = 1;
const SHARED_BYTE_CACHE_MAX_BYTES = getDeviceAwareCacheByteSize();

function unregisterSharedCacheEntry(token: string): void {
  const existing = sharedByteCacheLru.get(token);
  if (!existing) return;
  sharedByteCacheLru.delete(token);
  sharedByteCacheBytes -= existing.byteSize;
}

function touchSharedCacheEntry(token: string): void {
  const existing = sharedByteCacheLru.get(token);
  if (!existing) return;
  sharedByteCacheLru.delete(token);
  sharedByteCacheLru.set(token, existing);
}

/**
 * How many of the LRU-oldest entries an eviction pass may consider (BH-8).
 *
 * The victim is the highest-scoring entry among the K oldest, so eviction
 * stays O(1)-amortized (a constant scan, no sort, no heap) and a
 * recently-touched entry can NEVER be chosen — the playhead only ever
 * REORDERS the tail of the LRU, it never overrides recency.
 *
 * `1` is exactly the pre-BH-8 evict-the-single-oldest LRU and is the
 * documented rollback. `8` was chosen because it is wide enough to hold a
 * loop's sacrificial slot (see {@link byteCacheEvictionScore}) and narrow
 * enough that the scan is free next to the eviction itself.
 */
export const EVICT_SCAN_LIMIT = 8;

/**
 * Pick an eviction victim from an insertion-ordered LRU map: the entry
 * MAXIMIZING `score` among the `scanLimit` oldest, ties going to the oldest.
 * Shared by the per-archive byte cache and the process-shared byte LRU so the
 * two can never drift apart (BH-8).
 *
 * Two degeneracies are load-bearing and pinned by tests:
 *  - `scanLimit = 1` → the first (oldest) entry, i.e. today's exact LRU;
 *  - every score equal (e.g. no playhead was ever threaded in, so every
 *    entry scores 0) → the first entry wins on the ties-to-oldest rule, so
 *    the eviction ORDER is byte-identical to today's.
 */
export function selectLruVictim<K, V>(
  lru: Map<K, V>,
  score: (key: K, value: V) => number,
  scanLimit: number = EVICT_SCAN_LIMIT,
): [K, V] | undefined {
  let best: [K, V] | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  let scanned = 0;
  for (const pair of lru) {
    if (scanned++ >= scanLimit) break;
    const raw = score(pair[0], pair[1]);
    const s = Number.isFinite(raw) ? raw : 0;
    // STRICTLY greater: the first (oldest) entry of a tie keeps the slot.
    if (s > bestScore) {
      bestScore = s;
      best = pair;
    }
  }
  return best;
}

function registerSharedCacheEntry(
  token: string,
  entry: SharedByteCacheEntry,
): void {
  unregisterSharedCacheEntry(token);
  sharedByteCacheLru.set(token, entry);
  sharedByteCacheBytes += entry.byteSize;
  while (
    sharedByteCacheBytes > SHARED_BYTE_CACHE_MAX_BYTES &&
    sharedByteCacheLru.size > 0
  ) {
    // Same K-oldest scan as the per-archive cache (BH-8): under shared-budget
    // pressure a looping archive's imminent tiles outrank another archive's
    // just-passed ones, instead of the oldest insertion always losing.
    const victim = selectLruVictim(
      sharedByteCacheLru,
      (_token, e) => e.score?.() ?? 0,
    );
    if (!victim) break;
    sharedByteCacheLru.delete(victim[0]);
    sharedByteCacheBytes -= victim[1].byteSize;
    victim[1].evict();
  }
}

interface ByteCacheEntry {
  bytes: ArrayBuffer;
  lastAccess: number;
  byteSize: number;
  /**
   * The tile's directory `timeStart` (BH-8) — where this payload sits on the
   * timeline, which is what makes a playhead-aware victim choice possible.
   * `NaN` for a payload with no timeline position; such an entry always
   * scores 0 and is therefore only ever evicted on the ties-to-oldest rule.
   */
  timeStart: number;
}

/**
 * The playhead/loop state threaded into the archive by playback callers.
 * `direction` is the committed travel direction (+1 forward, −1 reverse).
 */
interface PlayheadState {
  time: number;
  direction: 1 | -1;
}

/**
 * Loop-aware directional distance from the play-head to a cached tile, in
 * sim-ms (BH-8). HIGHER = wanted later = evict sooner.
 *
 * This is BH-7's tileset metric, evaluated over one entry instead of a tier:
 *
 *  - `ahead` is the signed distance along the committed travel direction,
 *    carrying the same bucket-end correction for reverse playback, so with no
 *    loop declared this is exactly the archive's own
 *    `minDistanceToPlayhead` distance (data already passed is pushed behind a
 *    large constant offset, so it is evicted before anything still upcoming);
 *  - under a declared LOOP the distance is taken MODULO the loop span
 *    (`aheadMod`), because "behind the play-head" stops meaning "done with" —
 *    the head comes back round. A tile just past the loop start, seen from a
 *    head near the loop end, is the most imminent thing in the cache and
 *    scores near 0; a tile the head has just passed scores near the full span
 *    and is spent first. That inverts LRU's cyclic-scan worst case, where the
 *    oldest entry is precisely the one wanted soonest on the next lap;
 *  - a tile whose whole bucket lies OUTSIDE the declared loop is never
 *    replayed at all, so it scores above every in-loop tile (`span + bucket`,
 *    matching BH-7's "head of tier B" placement).
 *
 * With NO playhead ever threaded in (`playhead === null`) every entry scores
 * 0, which is what makes non-playback consumers byte-identical to the
 * pre-BH-8 LRU.
 */
export function byteCacheEvictionScore(
  timeStart: number,
  bucketMs: number,
  playhead: PlayheadState | null,
  loop: { start: number; end: number } | null,
): number {
  if (!playhead || !Number.isFinite(timeStart)) return 0;
  const dir = playhead.direction === -1 ? -1 : 1;
  const bucket = Number.isFinite(bucketMs) && bucketMs > 0 ? bucketMs : 0;
  const ahead =
    dir > 0 ? timeStart - playhead.time : playhead.time - (timeStart + bucket);
  const span = loop ? loop.end - loop.start : 0;
  if (!loop || !(span > 0)) {
    // No loop: the incumbent one-directional metric — furthest behind the
    // head is furthest from being wanted again.
    return ahead >= 0 ? ahead : SCHEDULER_PREFETCH_TIER_BASE / 2 - ahead;
  }
  if (timeStart + bucket < loop.start || timeStart > loop.end) {
    return span + bucket;
  }
  return ((ahead % span) + span) % span;
}

/**
 * Pointer to the encoded directory object in a packed manifest.
 *
 * Part of the published cross-language wire contract — see
 * `docs/spec/manifest.schema.json` and the Rust `pack::DirectoryRef`.
 */
export interface ManifestDirectoryRef {
  /** Object key relative to the dataset root (e.g. `index/<hash>.sttd`). */
  key: string;
  /**
   * Directory object length in bytes — the at-rest object, i.e. the
   * compressed length when `encoding` is set. The fetched body is
   * validated against it before any decode.
   */
  length: number;
  /**
   * Directory (leaf) codec version (6 for the packed format). Unchanged by the
   * paged container — `layout`, not this, discriminates the container shape.
   */
  directoryVersion: number;
  /**
   * At-rest encoding of the directory object. `'zstd'` = a zstd frame wrapping
   * the codec bytes (for a paged directory: EACH page — root + every leaf — is
   * its own zstd frame); absent means raw codec bytes.
   */
  encoding?: string;
  /**
   * Container layout. `'paged'` = a root page + leaf pages (the reader fetches
   * only the leaves a query touches); absent or `'single'` = the whole-load
   * object. The `rootLength`/`pageCount`/`pageEntries` fields below are present
   * iff `'paged'`.
   */
  layout?: string;
  /**
   * Paged only: at-rest byte length of the root page (a prefix of the object).
   * The reader range-GETs `bytes=0-(rootLength-1)` for the root, then leaf
   * ranges; leaf offsets are relative (absolute = `rootLength + rel_offset`).
   */
  rootLength?: number;
  /** Paged only: number of leaf pages (informational / validation). */
  pageCount?: number;
  /** Paged only: nominal entries-per-leaf-page used at build (informational). */
  pageEntries?: number;
  /**
   * Paged only: blake3-128 of the exact at-rest root frame bytes (excluding
   * the STTD magic). Required with `pageHashes` for paged v3 directories.
   */
  rootHash?: string;
  /**
   * Paged only: one blake3-128 hash per exact at-rest leaf frame, in page
   * descriptor order. Enables authenticated on-demand range loading.
   */
  pageHashes?: string[];
}

/**
 * Pointer to one pack object. Its position in `packs` IS the `packId`.
 *
 * Part of the published cross-language wire contract — see
 * `docs/spec/manifest.schema.json` and the Rust `pack::PackRef`.
 */
export interface ManifestPackRef {
  /** Object key relative to the dataset root (e.g. `packs/<hash>.sttp`). */
  key: string;
  /** Pack object length in bytes. */
  length: number;
}

/**
 * One schema-template entry of a formatVersion-3 manifest's `schemas` table
 * (packed spec §3.2): the blake3-128 content hash of the raw template bytes
 * (32 lowercase hex chars — the hex form of the 16-byte reference v2 layer
 * frames embed) and the raw template bytes, base64-encoded (standard
 * alphabet, padded). Mirrors the Rust `pack::SchemaTemplateRef`.
 */
export interface ManifestSchemaTemplate {
  /** blake3-128 of the RAW (decoded) template bytes, lowercase hex. */
  hash: string;
  /** The raw template bytes, base64. */
  data: string;
}

export interface ManifestVariant {
  /** Numeric id stored in the directory and carried by TileId. */
  id: number;
  /** Stable semantic role of the representation. */
  kind: 'raw' | 'summary';
  /** Canonical layer name, when the representation has one. */
  layerName?: string;
}

/**
 * The packed-format `manifest.json` — metadata + directory pointer + pack
 * table folded into one tiny object. Mirrors the Rust `pack::Manifest`.
 *
 * This is the canonical cross-language wire contract. The authoritative schema
 * is `docs/spec/manifest.schema.json` (validated against this type and the
 * golden fixture in `test/manifest-schema.test.ts`); the prose spec is
 * `docs/spec/stt-packed-format.md`.
 */
export interface PackedManifest {
  /** Format discriminator. Always {@link PACKED_FORMAT} (`"stt-packed"`). */
  format: string;
  /** Manifest schema version. Only the current clean-cutover value is read. */
  formatVersion: number;
  /**
   * formatVersion 3 ONLY (v1 manifests MUST NOT carry the key): the
   * dataset's Arrow IPC schema templates, embedded (spec §3.2). Sorted by
   * `hash` and deduped by the writer. The reader validates
   * `blake3_128(data) == hash` for every entry at open — a corrupt manifest
   * fails loudly, dataset-level, before any tile fetch — then builds the
   * hash → bytes template registry v2 layer frames resolve against.
   */
  schemas?: ManifestSchemaTemplate[];
  /** Required registry of independently addressable tile representations. */
  variants: ManifestVariant[];
  /**
   * OPTIONAL required-to-understand feature declarations (spec §3.1). Each
   * entry names a feature the writer used that RE-TYPES existing tile columns
   * (registry: {@link KNOWN_MANIFEST_CAPABILITIES}); a reader MUST refuse a
   * dataset declaring a capability it does not implement. Absent = none used
   * (the shape of every pre-capabilities manifest). Additive columns never
   * need a capability.
   */
  capabilities?: string[];
  /**
   * Per-blob compression codec: `"zstd"` or `"none"` — the enum in
   * `docs/spec/manifest.schema.json` is the contract. Typed `string` rather
   * than a union so parsing a manifest never throws on a codec name this
   * reader does not know; the open path decides what to do with one.
   * `"gzip"` is not a packed codec (see `compression.ts`).
   */
  compression: string;
  /**
   * OPTIONAL: the concrete blob byte-ordering the writer laid down
   * (`"spatial" | "time-major" | "hilbert3" | "morton3"`). Informational —
   * the reader indexes by `(z, x, y, t)` regardless. Absent on pre-2026-07
   * archives (the order is then inferable only from the pack layout).
   */
  blobOrdering?: string;
  /** Pointer to the immutable, content-addressed directory object. */
  directory: ManifestDirectoryRef;
  /** Ordered pack table; a pack's array index IS its `packId`. */
  packs: ManifestPackRef[];
  /** The verbatim stt-core Metadata JSON (snake_case keys). */
  metadata: any;
}

/**
 * The (few) fields this reader consults inside {@link PackedManifest.metadata},
 * which is otherwise the writer's metadata block verbatim and untyped.
 *
 * Mirrors `stt_core::metadata::Metadata` — snake_case, unlike the manifest's
 * own camelCase top-level keys.
 */
interface ManifestMetadataShape {
  /**
   * The workload model the `measured` blob-ordering picker ran under
   * (`stt_core::metadata::OrderingWorkload`), written by `PackWriter::finalize`
   * ONLY when the ordering was resolved by simulation. Absent on `auto` and
   * explicit orderings, and on every archive built before the field existed.
   */
  ordering_workload?: {
    /**
     * The range-read coalescing gap the layout simulation was priced at, in
     * bytes — the reader-mirroring constant, and the co-versioning gate for
     * CO-7's adaptive gap. See {@link manifestBuildAssumedGapBytes}.
     */
    coalesce_gap_bytes?: number;
  };
}

/**
 * Extract the blake3-128 content address embedded in a content-addressed
 * directory object key (`.../<32-hex>.sttd`, the writer's
 * `index/{blake3_128_hex}.sttd`), or `null` when the key is not
 * content-addressed (e.g. a synthetic-test directory name). The address covers
 * the ENTIRE at-rest object, magic prelude + framing included (packed spec §9.2
 * / the Rust `blake3_128_hex(&index_bytes)`).
 */
function directoryContentAddress(key: string): string | null {
  const m = /^index\/([0-9a-f]{32})\.sttd$/.exec(key);
  return m ? m[1].toLowerCase() : null;
}

const DIRECTORY_KEY_PATTERN = /^index\/[0-9a-f]{32}\.sttd$/;
const PACK_KEY_PATTERN = /^packs\/[0-9a-f]{32}\.sttp$/;

function requireSafeInteger(
  value: unknown,
  field: string,
  minimum = 0,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new Error(
      `STT manifest: ${field} must be a safe integer >= ${minimum}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Runtime semantic validation for the parts of manifest.schema.json that
 * TypeScript types cannot enforce on untrusted JSON. This runs before deriving
 * or fetching any manifest-relative URL, making the content-addressed object
 * key grammar the path-traversal/cross-prefix guard it is intended to be.
 */
function validateManifestSemantics(manifest: PackedManifest): void {
  if (!manifest.directory || typeof manifest.directory !== 'object') {
    throw new Error('STT manifest: missing directory pointer');
  }
  if (!Array.isArray(manifest.packs) || manifest.packs.length === 0) {
    throw new Error('STT manifest: packs must be a non-empty array');
  }
  const declaredVariants = effectiveVariants(manifest);
  if (!Array.isArray(declaredVariants) || declaredVariants.length === 0) {
    throw new Error('STT manifest: variants must be a non-empty array');
  }
  const variantIds = new Set<number>();
  for (const [i, variant] of declaredVariants.entries()) {
    const id = requireSafeInteger(variant?.id, `variants[${i}].id`, 0);
    if (variant.kind !== 'raw' && variant.kind !== 'summary') {
      throw new Error(
        `STT manifest: variants[${i}].kind must be 'raw' or 'summary'`,
      );
    }
    if (variantIds.has(id)) {
      throw new Error(`STT manifest: duplicate variant id ${id}`);
    }
    variantIds.add(id);
  }
  if (
    !declaredVariants.some(
      (variant) => variant.id === 0 && variant.kind === 'raw',
    )
  ) {
    throw new Error("STT manifest: variant 0 must be declared with kind 'raw'");
  }
  if (
    typeof manifest.directory.key !== 'string' ||
    !DIRECTORY_KEY_PATTERN.test(manifest.directory.key)
  ) {
    throw new Error(
      `STT manifest: directory.key must match index/<32 lowercase hex>.sttd; got ${JSON.stringify(manifest.directory.key)}`,
    );
  }
  const directoryLength = requireSafeInteger(
    manifest.directory.length,
    'directory.length',
    OBJECT_MAGIC_LEN + 1,
  );
  if (
    typeof manifest.directory.directoryVersion !== 'number' ||
    !Number.isInteger(manifest.directory.directoryVersion) ||
    manifest.directory.directoryVersion < MIN_DIRECTORY_VERSION ||
    manifest.directory.directoryVersion > DIRECTORY_VERSION
  ) {
    throw new Error(
      `STT manifest: unsupported directoryVersion ` +
        `${JSON.stringify(manifest.directory.directoryVersion)} ` +
        `(expected ${MIN_DIRECTORY_VERSION}..${DIRECTORY_VERSION})`,
    );
  }
  if (
    manifest.directory.encoding !== undefined &&
    manifest.directory.encoding !== 'zstd'
  ) {
    throw new Error(
      `STT manifest: unknown directory encoding ${JSON.stringify(manifest.directory.encoding)} ` +
        "(this reader supports absent or 'zstd')",
    );
  }
  const layout = manifest.directory.layout;
  if (
    layout !== undefined &&
    layout !== 'single' &&
    layout !== DIRECTORY_LAYOUT_PAGED
  ) {
    throw new Error(
      `STT manifest: unsupported directory.layout ${JSON.stringify(layout)}`,
    );
  }
  const pagedFields = ['rootLength', 'pageCount', 'pageEntries'] as const;
  if (layout === DIRECTORY_LAYOUT_PAGED) {
    const rootLength = requireSafeInteger(
      manifest.directory.rootLength,
      'directory.rootLength',
      1,
    );
    requireSafeInteger(manifest.directory.pageCount, 'directory.pageCount', 0);
    requireSafeInteger(
      manifest.directory.pageEntries,
      'directory.pageEntries',
      1,
    );
    if (OBJECT_MAGIC_LEN + rootLength > directoryLength) {
      throw new Error(
        `STT manifest: directory.rootLength ${rootLength} exceeds ` +
          `directory payload length ${directoryLength - OBJECT_MAGIC_LEN}`,
      );
    }
    const hasRootHash = manifest.directory.rootHash !== undefined;
    const hasPageHashes = manifest.directory.pageHashes !== undefined;
    // Per-frame hashes arrived with directory v6. A pre-v6 container never wrote
    // them, so requiring them would report "corrupt" for an archive that is
    // merely older. Every other paged field above (rootLength, pageCount,
    // pageEntries and their bounds) is still enforced, and a v6 directory
    // missing its hashes remains an error.
    const legacyUnhashed =
      manifest.directory.directoryVersion < DIRECTORY_VERSION &&
      !hasRootHash &&
      !hasPageHashes;
    if (!legacyUnhashed && (!hasRootHash || !hasPageHashes)) {
      throw new Error(
        'STT manifest: paged directory requires rootHash and pageHashes',
      );
    }
    if (hasRootHash && hasPageHashes) {
      if (
        typeof manifest.directory.rootHash !== 'string' ||
        !/^[0-9a-f]{32}$/.test(manifest.directory.rootHash)
      ) {
        throw new Error(
          'STT manifest: directory.rootHash must be 32 lowercase hex characters',
        );
      }
      if (
        !Array.isArray(manifest.directory.pageHashes) ||
        manifest.directory.pageHashes.length !== manifest.directory.pageCount
      ) {
        throw new Error(
          'STT manifest: directory.pageHashes length must equal pageCount',
        );
      }
      for (let i = 0; i < manifest.directory.pageHashes.length; i++) {
        if (!/^[0-9a-f]{32}$/.test(manifest.directory.pageHashes[i])) {
          throw new Error(
            `STT manifest: directory.pageHashes[${i}] must be 32 lowercase hex characters`,
          );
        }
      }
    }
  } else {
    for (const field of [...pagedFields, 'rootHash', 'pageHashes'] as const) {
      if (manifest.directory[field] !== undefined) {
        throw new Error(
          `STT manifest: directory.${field} is only valid when layout is 'paged'`,
        );
      }
    }
  }

  const packKeys = new Set<string>();
  for (let i = 0; i < manifest.packs.length; i++) {
    const pack = manifest.packs[i];
    if (!pack || typeof pack !== 'object') {
      throw new Error(`STT manifest: packs[${i}] must be an object`);
    }
    if (typeof pack.key !== 'string' || !PACK_KEY_PATTERN.test(pack.key)) {
      throw new Error(
        `STT manifest: packs[${i}].key must match packs/<32 lowercase hex>.sttp; ` +
          `got ${JSON.stringify(pack.key)}`,
      );
    }
    if (packKeys.has(pack.key)) {
      throw new Error(`STT manifest: duplicate pack key ${pack.key}`);
    }
    packKeys.add(pack.key);
    requireSafeInteger(pack.length, `packs[${i}].length`, OBJECT_MAGIC_LEN);
  }

  if (manifest.capabilities !== undefined) {
    if (!Array.isArray(manifest.capabilities)) {
      throw new Error('STT manifest: capabilities must be an array of strings');
    }
    const capabilities = new Set<string>();
    for (let i = 0; i < manifest.capabilities.length; i++) {
      if (typeof manifest.capabilities[i] !== 'string') {
        throw new Error(`STT manifest: capabilities[${i}] must be a string`);
      }
      if (capabilities.has(manifest.capabilities[i])) {
        throw new Error(
          `STT manifest: duplicate capability ${manifest.capabilities[i]}`,
        );
      }
      capabilities.add(manifest.capabilities[i]);
    }
  }
}

/** Standard-alphabet base64 → bytes (`atob` exists in browsers and Node ≥ 16). */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Decode + hash-validate a v2 manifest's `schemas` table into the decode-side
 * {@link TemplateRegistry} (packed spec §3.2). Every entry must base64-decode
 * to NON-EMPTY bytes whose blake3-128 equals its declared `hash` — the loud,
 * dataset-level failure mode for corrupt manifests, surfaced at open before
 * any tile fetch. Mirrors the Rust `pack::build_template_registry`.
 */
function buildTemplateRegistry(
  schemas: ManifestSchemaTemplate[],
): TemplateRegistry {
  const registry: TemplateRegistry = new Map();
  for (let i = 0; i < schemas.length; i++) {
    const entry = schemas[i];
    if (
      !entry ||
      typeof entry.hash !== 'string' ||
      typeof entry.data !== 'string'
    ) {
      throw new Error(
        `STT manifest: schemas[${i}] is malformed (need {hash, data} strings)`,
      );
    }
    let data: Uint8Array;
    try {
      data = base64ToBytes(entry.data);
    } catch (e) {
      throw new Error(
        `STT manifest: schemas[${i}] (${entry.hash}): base64 decode failed: ${(e as Error).message}`,
      );
    }
    if (data.length === 0) {
      throw new Error(
        `STT manifest: schemas[${i}] (${entry.hash}): template bytes are empty`,
      );
    }
    const actual = blake3Hex128(data);
    if (actual !== entry.hash) {
      throw new Error(
        `STT manifest: schemas[${i}]: template bytes hash to ${actual}, declared ${entry.hash}`,
      );
    }
    registry.set(entry.hash, data);
  }
  return registry;
}

/** Normalize any HeadersInit into a plain record, preserving plain-object key casing. */
function headersToRecord(h: HeadersInit | undefined): Record<string, string> {
  if (!h) return {};
  if (typeof Headers !== 'undefined' && h instanceof Headers) {
    const out: Record<string, string> = {};
    h.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(h)) return Object.fromEntries(h);
  return { ...(h as Record<string, string>) };
}

/**
 * Merge a caller-level `RequestInit` (from `loadOptions.fetch`, object form)
 * UNDER a per-request one. Per-request fields win — they carry the `Range`
 * header, abort signal and fetch-priority hint the reader's offset math and
 * cancellation depend on, so the caller's init can never clobber them.
 * Plain-object header keys are kept verbatim (no `Headers` round-trip, which
 * would lowercase them).
 */
function mergeRequestInit(
  base: RequestInit,
  override?: RequestInit,
): RequestInit {
  if (!override) {
    return base.headers
      ? { ...base, headers: headersToRecord(base.headers) }
      : { ...base };
  }
  const merged: RequestInit = { ...base, ...override };
  if (base.headers) {
    merged.headers = {
      ...headersToRecord(base.headers),
      ...headersToRecord(override.headers),
    };
  }
  return merged;
}

/**
 * Estimate a decoded tile's in-memory size (bytes). Exported so the tileset
 * uses one consistent accounting implementation.
 *
 * Counts each BACKING ArrayBuffer once, at its full `byteLength` — the same
 * Set-of-buffers dedup `collectTransferables` uses. Zero-copy tiles alias
 * many views (positions, numericProps, vectorProps, arrowIpc) onto the one
 * decoded Arrow IPC buffer; summing per-view byteLengths double-counted such
 * tiles ~2×, overstating the cache and evicting them early. Full buffer
 * length (not the view's) is what the tile actually retains: a subarray
 * keeps its whole backing buffer alive.
 */
export function estimateTileSize(tile: Tile): number {
  let size = 1000; // base overhead
  if (!tile?.layers) return size;
  const seen = new Set<ArrayBufferLike>();
  const add = (view: ArrayBufferView | undefined | null): void => {
    if (!view || !ArrayBuffer.isView(view) || seen.has(view.buffer)) return;
    seen.add(view.buffer);
    size += view.buffer.byteLength;
  };
  for (const layer of tile.layers) {
    // The retained raw IPC bytes (GeoArrow hand-off; see STTTileLayer.arrowIpc and
    // the v2 spliced-props sibling) keep the decoded payload buffers alive
    // for the tile's lifetime, so they count toward the byte budget like
    // any other buffer.
    add(layer?.arrowIpc);
    add(layer?.arrowIpcProps);
    const f = layer?.features;
    if (!f) continue;
    // Every BinaryFeatures buffer field, via the shared enumeration (same
    // list collectTransferables transfers — the two can't drift).
    forEachBufferView(f, add);
    // Category-string tables aren't buffers; account them separately.
    for (const { categories } of Object.values(f.categoricalProps)) {
      for (const c of categories) size += c.length * 2 + 16;
    }
  }
  return size;
}

/** STT archive reader. */
export class STTArchive {
  private readonly cacheOwnerId = nextArchiveCacheId++;
  public url: string;
  /** Cancels every transport/decode operation owned by this archive. */
  private readonly lifetimeController = new AbortController();
  private disposed = false;
  /**
   * The transport every request actually goes through: {@link baseFetchFn}
   * with the current `loadOptions.fetch` applied (see {@link applyLoadOptions}).
   */
  private fetchFn: typeof fetch;
  /**
   * The UNDECORATED transport — `ArchiveOptions.fetch` or the global `fetch`.
   * Kept separate so {@link setLoadOptions} can re-derive `fetchFn` from a
   * clean base instead of stacking a second RequestInit wrapper on top of the
   * previous one (which would make an auth-header rotation additive: the stale
   * header would survive under the new one).
   */
  private baseFetchFn: typeof fetch;
  /**
   * True when the caller passed an explicitly-typed `ArchiveOptions.fetch`,
   * which outranks the `loadOptions.fetch` FUNCTION form — permanently, so a
   * later {@link setLoadOptions} can't smuggle a transport past it.
   */
  private hasExplicitTransport = false;
  /** Parsed manifest.json (one whole-object GET, cached). */
  private manifestCache?: PackedManifest;
  /** Promise guard so concurrent callers share one manifest fetch. */
  private manifestPromise?: Promise<PackedManifest>;
  /**
   * Base URL with the manifest's final path segment removed. `directory.key`
   * and each `pack.key` are resolved relative to this.
   */
  private baseUrl?: string;
  /** Pack compression codec parsed from the manifest (per-blob, no dict). */
  private packCompression = Compression.Zstd;
  /**
   * `manifest.formatVersion` (3), the AUTHORITATIVE discriminator (spec
   * §5.2). Set by `fetchManifest`; forwarded to every decode so a
   * mixed-version dataset fails loudly instead of misparsing.
   */
  private formatVersion = PACKED_FORMAT_VERSION;
  /**
   * v2 only: the schema-template registry built (and blake3-validated) from
   * `manifest.schemas` at open. ONE object shared by the inline decoder, the
   * worker pool (which re-sends it on every spawn/respawn) and the OPFS warm
   * path — the §4.4 distribution contract.
   */
  private templateRegistry?: TemplateRegistry;
  /** The decoder instance {@link templateRegistry} was last installed on. */
  private templatesInstalledOn?: TileDecoder;
  /**
   * Byte offset of directory codec data inside the `.sttd` object: 8 under
   * formatVersion 3 (the `STTD` magic prelude), 0 under v1. Pack reads need
   * no equivalent — v2 blob offsets are already object-absolute.
   */
  private directoryDataStart = 0;
  private metadataCache?: ArchiveMetadata;
  private indexCache?: ArchiveIndex;
  /** Promise guard so concurrent callers share one directory fetch+decode. */
  private indexPromise?: Promise<ArchiveIndex>;

  private byteCache = new Map<TileKey, ByteCacheEntry>();
  private maxCacheTiles: number;
  private currentCacheBytes = 0;
  private maxCacheBytes: number;

  /**
   * Last play-head threaded through {@link getTiles} via
   * `TileRequestOptions.playheadTime` (BH-8), or `null` when no caller has
   * ever declared one. Read LIVE by the byte cache's victim scan — including
   * from the process-shared LRU's score callback — so the eviction policy
   * always reflects where playback actually is, not where it was when an
   * entry was stored.
   */
  private lastPlayhead: PlayheadState | null = null;
  /**
   * Declared playback loop window in sim-time (BH-7/BH-8), or `null` (the
   * default, and the byte-identical-to-before state). See
   * {@link setLoopWindow}.
   */
  private loopWindow: { start: number; end: number } | null = null;

  /**
   * STATIC max byte gap bridged when coalescing adjacent tile ranges: the
   * historic default, or the caller's `ArchiveOptions.coalesceGapBytes` pin.
   * This is the FALLBACK, not necessarily the gap in force — read
   * {@link effectiveCoalesceGap} on the fuse path, never this field.
   */
  private coalesceGapBytes: number = DEFAULT_RANGE_COALESCE_GAP;
  /**
   * True when {@link coalesceGapBytes} came from an explicit option. A pinned
   * gap disables adaptation entirely — the CO-7 kill switch.
   */
  private coalesceGapPinned = false;
  /** Ceiling on concurrent range requests per coalesced batch (see options). */
  private maxConcurrentRequests: number = DEFAULT_MAX_CONCURRENT_REQUESTS;
  /** Backoff schedule for transient range failures (see options). */
  private retryDelaysMs: number[] = DEFAULT_RANGE_RETRY_DELAYS_MS;
  /** Per-transfer stall timeout; `0` disables (see options). */
  private transferTimeoutMs: number = DEFAULT_TRANSFER_TIMEOUT_MS;
  /** Fair-share weight in the process-shared scheduler (see options). */
  private schedulerWeight: number = DEFAULT_SCHEDULER_WEIGHT;
  /** Zooms already reported by {@link warnOversizedScan} (warn once each). */
  private warnedOversizedScans = new Set<number>();

  /**
   * Dual-EWMA throughput estimator fed by completed coalesced range
   * responses in {@link getTiles}. See {@link getThroughputEstimate}.
   */
  private throughput = new ThroughputEstimator();
  /**
   * EWMA of per-request time-to-first-byte, fed where the range path already
   * stamps response timing ({@link fetchObjectRange}). Together with
   * {@link throughput} it prices one request in bytes (`L̂ × θ̂`), which is the
   * exchange rate {@link effectiveCoalesceGap} fuses on. Cold (`null`) until
   * the first range response's headers arrive.
   */
  private latency = new LatencyEstimator();
  /**
   * Aggregate-window sampling state (Chromium NQE style). Per-request samples
   * under the {@link maxConcurrentRequests}-way pool each see ~link/N and
   * systematically underestimate the link by the concurrency factor — so
   * bytes are accumulated across ALL in-flight range requests and ONE sample
   * is recorded per busy window (first transfer starts → last one settles).
   */
  private activeTransferCount = 0;
  private transferWindowBytes = 0;
  private transferWindowStart = 0;

  /** {@link tileCellKey} -> temporal entries at that spatial cell. */
  private tileEntryIndex = new Map<TileCellKey, TileEntry[]>();
  /**
   * Per-zoom references to the occupied-cell lists in {@link tileEntryIndex}.
   * Oversized viewport queries filter this sparse index instead of allocating
   * and probing every theoretical `(x, y)` cell in a potentially million-cell
   * world grid. Lists are shared, so the memory cost is one reference per
   * occupied cell rather than a second copy of the entries.
   */
  private occupiedCellListsByZoom = new Map<number, TileEntry[][]>();
  /** {@link tileEntryKey} -> the one entry at that address and tier. */
  private tileEntryByKey = new Map<TileEntryKey, TileEntry>();
  /**
   * The dataset's base temporal bucket width (manifest
   * `metadata.temporal_bucket_ms`, same 1 h default as {@link getMetadata}).
   * Cached at manifest fetch so the SYNCHRONOUS {@link findTileEntry} can
   * resolve tier-qualified keys without awaiting metadata.
   */
  private baseTemporalBucketMs = 3600 * 1000;
  /** Variant ids declared by the current manifest. */
  private declaredVariantIds = new Set<number>([0]);
  /**
   * True when the manifest declares a temporal-LOD pyramid
   * (`metadata.temporal_lod` non-empty) — only then can two directory entries
   * share one `z/x/y/timeStart` across tiers, so only then does the default
   * (base-tier) selection have to filter LOD tiles out. Cached at manifest
   * fetch alongside {@link baseTemporalBucketMs} so the SYNCHRONOUS
   * {@link estimateSelectionCost} can apply exactly the filter
   * {@link getTileIdsInBounds} applies without awaiting metadata.
   */
  private hasTemporalLod = false;
  /**
   * The manifest's summary tier, cached at fetch for the same reason as
   * {@link hasTemporalLod}: {@link estimateSelectionCost} is synchronous and
   * must reproduce {@link getSummaryTileIdsInBounds}'s zoom gate exactly.
   * `undefined` when the dataset ships no summary tier.
   */
  private summaryTierSync?: SummaryTier;

  // --- Paged directory ------------------------------------------------------
  /**
   * True when the manifest's `directory.layout === "paged"` AND the directory
   * is large enough to actually page (above {@link SMALL_DIR_THRESHOLD}). When
   * paged, `tileEntryIndex`/`tileEntryByKey` are **incrementally populated** —
   * only leaves whose pages have been fetched are resident — and queries call
   * {@link ensurePagesForBounds}/{@link ensurePagesForTiles} first. A single
   * (or small-paged) directory loads the whole entry set up front as before.
   */
  private paged = false;
  /** The root page's leaf descriptors (paged mode only). */
  private pageTable?: PageDescriptor[];
  /** Indices into {@link pageTable} whose leaves are resident in the maps. */
  private residentPages = new Set<number>();
  /** Promise guards so concurrent queries share one in-flight page fetch. */
  private pageFetchPromises = new Map<number, Promise<void>>();
  /** Resolved URL of the `.sttd` directory object (paged range fetches). */
  private directoryUrl?: string;
  /** `directory.rootLength` (paged): leaf offsets are relative to this. */
  private rootLength = 0;
  /** Whether the directory object's pages are zstd-framed (`encoding === "zstd"`). */
  private directoryZstd = false;
  /** Paged-directory whole-load cutoff (see options); below it, fetch the lot. */
  private directoryPageThresholdBytes: number = SMALL_DIR_THRESHOLD;

  private cacheStats = { hits: 0, misses: 0, evictions: 0 };
  /**
   * OPFS hit/miss counters. Tracked separately from the in-memory byte
   * cache so the HUD can show the two layers independently — a low OPFS
   * hit rate on a returning visitor usually means the dataset was redeployed
   * (the content-addressed directory hash, i.e. the OPFS fingerprint, changed).
   */
  private opfsStats = { hits: 0, misses: 0 };

  // The decoder runs decompress + Arrow IPC parse + binary-feature extraction
  // off the main thread (worker pool) in browsers, inline elsewhere. Lazily
  // constructed so node tests that never call getTile() don't spin a pool.
  private decoder?: TileDecoder;
  private decoderOption?: TileDecoder;

  /** Raw-IPC retention policy for decoded layers (see options). */
  private retainArrowIpc: boolean | 'auto' = 'auto';

  /**
   * Persistent OPFS cache for decompressed tile payloads. `undefined` when
   * the caller opted out or OPFS isn't reachable; null after construction
   * means "explicitly disabled, do not auto-enable later".
   */
  private opfsCache?: OpfsTileCache;
  /**
   * Stable archive fingerprint, derived from the manifest's content-addressed
   * directory hash (the `index/<hash>.sttd` key). The directory hash changes
   * iff the dataset's tiles change, so it's the natural cache-busting key —
   * and it's stable across the dataset's many immutable packs (unlike a
   * per-pack ETag). Filled by `fetchManifest`.
   */
  private archiveFingerprint?: string;

  constructor(options: ArchiveOptions | string) {
    if (typeof options === 'string') {
      this.url = options;
      this.baseFetchFn = fetch.bind(globalThis);
      this.fetchFn = this.baseFetchFn;
    } else {
      this.url = options.url;
      this.baseFetchFn = options.fetch || fetch.bind(globalThis);
      this.fetchFn = this.baseFetchFn;
      this.hasExplicitTransport = !!options.fetch;
      this.applyLoadOptions(options.loadOptions);
      this.decoderOption = options.decoder;
      if (options.retainArrowIpc !== undefined) {
        this.retainArrowIpc = options.retainArrowIpc;
      }
      if (
        typeof options.coalesceGapBytes === 'number' &&
        options.coalesceGapBytes >= 0
      ) {
        this.coalesceGapBytes = options.coalesceGapBytes;
        // An explicit gap is a PIN: the caller has taken responsibility for
        // the request plan, so the adaptive band never overrides it (CO-7's
        // back-compat kill switch).
        this.coalesceGapPinned = true;
      }
      if (
        typeof options.maxConcurrentRequests === 'number' &&
        options.maxConcurrentRequests >= 1
      ) {
        this.maxConcurrentRequests = Math.floor(options.maxConcurrentRequests);
      }
      if (Array.isArray(options.retryDelaysMs)) {
        this.retryDelaysMs = options.retryDelaysMs.filter(
          (d) => typeof d === 'number' && d >= 0,
        );
      }
      if (
        typeof options.transferTimeoutMs === 'number' &&
        options.transferTimeoutMs >= 0
      ) {
        this.transferTimeoutMs = options.transferTimeoutMs;
      }
      if (
        typeof options.schedulerWeight === 'number' &&
        Number.isFinite(options.schedulerWeight) &&
        options.schedulerWeight > 0
      ) {
        this.schedulerWeight = options.schedulerWeight;
      }
      if (
        typeof options.directoryPageThresholdBytes === 'number' &&
        options.directoryPageThresholdBytes >= 0
      ) {
        this.directoryPageThresholdBytes = options.directoryPageThresholdBytes;
      }
      // OPFS defaults to OFF. The cache's warm-reload win only materializes
      // when the archive fits in `opfsCacheMaxBytes` AND users revisit the
      // same viewport across reloads. On the cold path it costs a duplicate
      // main-thread zstd decompress per tile (see `writeOpfsAsync`), which
      // hurts initial pan/zoom — the dominant experience for showcase users
      // and for any dataset bigger than the cache budget (e.g. the multi-GB
      // nyc-taxi-paths packs vs the 512 MB default). Apps that genuinely
      // benefit opt in explicitly.
      const opfsRequested = options.opfsCache === true;
      if (options.opfsCacheImpl) {
        this.opfsCache = options.opfsCacheImpl;
      } else if (opfsRequested) {
        this.opfsCache = new OpfsTileCache({
          directory: options.opfsCacheDirectory,
          maxBytes: options.opfsCacheMaxBytes,
          // BH-9. The archive-OWNED cache opts into the admission filter and
          // prices its GreedyDual-Size hit value off this archive's own link
          // estimate. A caller-supplied `opfsCacheImpl` is left exactly as
          // its owner constructed it — we never reconfigure someone else's
          // cache, so a BYO instance keeps the incumbent admit-all policy.
          admissionFilter: true,
          getThroughput: () => this.throughput.getConservativeRate(),
        });
      }
    }
    this.maxCacheTiles = getDeviceAwareCacheSize();
    this.maxCacheBytes = getDeviceAwareCacheByteSize();
    if (typeof options !== 'string') {
      if (
        typeof options.maxCacheTiles === 'number' &&
        Number.isFinite(options.maxCacheTiles) &&
        options.maxCacheTiles >= 0
      ) {
        this.maxCacheTiles = Math.floor(options.maxCacheTiles);
      }
      if (
        typeof options.maxCacheBytes === 'number' &&
        Number.isFinite(options.maxCacheBytes) &&
        options.maxCacheBytes >= 0
      ) {
        this.maxCacheBytes = Math.floor(options.maxCacheBytes);
      }
    }
  }

  /**
   * (Re)derive {@link fetchFn} from {@link baseFetchFn} + `loadOptions.fetch`
   * (loaders.gl convention, see {@link SttLoadOptions}):
   *
   * - FUNCTION form — a drop-in transport. An explicitly-typed
   *   `ArchiveOptions.fetch` outranks it (see {@link hasExplicitTransport}).
   * - OBJECT form — a `RequestInit` merged into EVERY request this archive
   *   makes (manifest, directory, pack ranges), so auth headers / credentials
   *   reach the wire without a custom fetch function.
   *
   * Always rebuilds from the base transport, never from the current `fetchFn`,
   * so repeated application can't stack wrappers.
   */
  private applyLoadOptions(loadOptions: SttLoadOptions | undefined): void {
    const loadFetch = loadOptions?.fetch;
    if (typeof loadFetch === 'function' && !this.hasExplicitTransport) {
      this.fetchFn = loadFetch as typeof fetch;
      return;
    }
    if (loadFetch && typeof loadFetch === 'object') {
      const transport = this.baseFetchFn;
      this.fetchFn = ((input: RequestInfo | URL, init?: RequestInit) =>
        transport(input, mergeRequestInit(loadFetch, init))) as typeof fetch;
      return;
    }
    this.fetchFn = this.baseFetchFn;
  }

  /**
   * Replace the archive's `loadOptions` AFTER construction — the live analog
   * of `ArchiveOptions.loadOptions`, for a consumer whose `loadOptions` prop
   * changed (a rotated bearer token, a credentials-mode flip).
   *
   * Applies from the next request onward: in-flight requests keep the
   * transport they started with, and ALREADY-CACHED bytes (manifest,
   * directory, the byte/OPFS caches) are NOT re-fetched — the new options
   * govern what still has to go to the wire, exactly like a fresh archive
   * would for its cold reads. Pass `undefined` to drop back to the bare
   * transport.
   *
   * This exists because `loadOptions` is an ARCHIVE option, not a
   * {@link SpatioTemporalTilesetOptions} one: `SpatioTemporalTileset.setOptions`
   * cannot reach it, so the layer that owns the archive calls this directly.
   */
  setLoadOptions(loadOptions: SttLoadOptions | undefined): void {
    this.applyLoadOptions(loadOptions);
  }

  /**
   * Re-cap concurrent range requests per coalesced batch after construction
   * (the live analog of `ArchiveOptions.maxConcurrentRequests`).
   *
   * The cap is read per dispatch pass in {@link runGroupFetches}, so a change
   * takes effect on the next batch — already-running requests are never
   * cancelled to meet a lowered cap (that would waste bytes already on the
   * wire; the cap's job is to bound what starts NEXT). Values below 1 are
   * ignored, which would deadlock the pool.
   */
  setMaxConcurrentRequests(maxConcurrentRequests: number): void {
    if (
      typeof maxConcurrentRequests !== 'number' ||
      !Number.isFinite(maxConcurrentRequests) ||
      maxConcurrentRequests < 1
    ) {
      return;
    }
    this.maxConcurrentRequests = Math.floor(maxConcurrentRequests);
  }

  /** Current per-batch concurrent-range-request cap (see {@link setMaxConcurrentRequests}). */
  getMaxConcurrentRequests(): number {
    return this.maxConcurrentRequests;
  }

  private getDecoder(): TileDecoder {
    this.throwIfDisposed();
    if (this.decoder) return this.decoder;
    this.decoder = this.decoderOption ?? createDefaultTileDecoder();
    return this.decoder;
  }

  /**
   * The decoder with the dataset's v2 template registry installed (§4.4).
   * Idempotent per decoder instance; a v1 dataset (no registry) is a no-op.
   * Every decode call site goes through here so the registry can never be
   * missing when a v2 frame reaches `decodeTile` — and a custom decoder
   * that doesn't implement `setTemplates` still fails DESCRIPTIVELY there
   * (never a silently-empty tile).
   */
  private getPreparedDecoder(): TileDecoder {
    const decoder = this.getDecoder();
    if (
      this.templateRegistry &&
      decoder.setTemplates &&
      this.templatesInstalledOn !== decoder
    ) {
      decoder.setTemplates(this.templateRegistry);
      this.templatesInstalledOn = decoder;
    }
    return decoder;
  }

  private throwIfDisposed(): void {
    if (this.disposed) {
      throw new DOMException('STTArchive has been finalized', 'AbortError');
    }
  }

  /** Abort archive-owned work and release worker resources. Idempotent. */
  finalize(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetimeController.abort(
      new DOMException('STTArchive finalized', 'AbortError'),
    );
    this.decoder?.finalize();
    this.decoder = undefined;
    this.clearByteCache();
  }

  /**
   * Resolve a manifest-relative key (e.g. `index/<hash>.sttd`) against the
   * base URL (the manifest URL with its final path segment removed).
   */
  private resolveKey(key: string): string {
    if (this.baseUrl === undefined) {
      throw new Error(
        'STT archive: manifest not loaded (resolveKey before fetchManifest)',
      );
    }
    return this.baseUrl + key;
  }

  /**
   * GET the whole `manifest.json` (NOT a range request) and parse it. Cached;
   * concurrent callers share one in-flight fetch. Also derives the base URL,
   * the pack compression codec and the stable OPFS fingerprint.
   */
  private async fetchManifest(): Promise<PackedManifest> {
    this.throwIfDisposed();
    if (this.manifestCache) return this.manifestCache;
    if (this.manifestPromise) return this.manifestPromise;
    this.manifestPromise = (async () => {
      // The manifest GET is the cold-start single point of failure — one
      // transient blip used to fail the whole dataset load. It rides the
      // same jittered backoff + stall timeout as pack range requests.
      const buffer = await this.fetchWholeObjectWithRetry(this.url, 'manifest');
      let manifest: PackedManifest;
      try {
        manifest = JSON.parse(new TextDecoder().decode(buffer));
      } catch (e) {
        throw new Error(`STT manifest: invalid JSON (${(e as Error).message})`);
      }
      if (manifest.format !== PACKED_FORMAT) {
        throw new Error(
          `STT manifest: not a packed manifest (format=${JSON.stringify(manifest.format)}, ` +
            `expected ${JSON.stringify(PACKED_FORMAT)})`,
        );
      }
      // Conformance reader-MUST: reject unrecognized formatVersion /
      // directoryVersion, not just format — both are closed enums/consts in
      // the manifest schema, and the Rust reader rejects them too.
      if (
        typeof manifest.formatVersion !== 'number' ||
        !Number.isInteger(manifest.formatVersion) ||
        manifest.formatVersion < MIN_PACKED_FORMAT_VERSION ||
        manifest.formatVersion > PACKED_FORMAT_VERSION
      ) {
        throw new Error(
          `STT manifest: unsupported formatVersion ${JSON.stringify(manifest.formatVersion)} ` +
            `(expected ${MIN_PACKED_FORMAT_VERSION}..${PACKED_FORMAT_VERSION})`,
        );
      }
      validateManifestSemantics(manifest);
      // Build the schema-template registry from the embedded `schemas` table,
      // hash-validating EVERY entry at open (spec §3.2) — a corrupt manifest
      // fails loudly, dataset-level, before any tile fetch. An absent table is
      // legal (self-contained inline-schema frames).
      if (manifest.schemas !== undefined && !Array.isArray(manifest.schemas)) {
        throw new Error(
          'STT manifest: schemas must be an array of {hash, data} entries',
        );
      }
      this.templateRegistry = buildTemplateRegistry(manifest.schemas ?? []);
      this.formatVersion = manifest.formatVersion;
      // Conformance reader-MUST: refuse a dataset declaring a capability this
      // reader does not implement (spec §3.1). A capability re-types EXISTING
      // columns, so skipping this check wouldn't fail later — it would
      // silently misdecode, mid-session, per tile.
      const unknown = (manifest.capabilities ?? []).filter(
        (c) => !KNOWN_MANIFEST_CAPABILITIES.includes(c),
      );
      if (unknown.length > 0) {
        throw new Error(
          `STT manifest: dataset requires capabilities this reader does not implement: ` +
            `${unknown.join(', ')} (implemented: ${KNOWN_MANIFEST_CAPABILITIES.join(', ')})`,
        );
      }
      // Base = manifest URL with the final path segment stripped (keep the
      // trailing slash). `index/...` and `packs/...` keys resolve against it.
      const slash = this.url.lastIndexOf('/');
      this.baseUrl = slash >= 0 ? this.url.slice(0, slash + 1) : '';
      switch (manifest.compression) {
        case 'none':
          this.packCompression = Compression.None;
          break;
        case 'gzip':
          // Named codec that is definitely NOT zstd: DEFLATE frames handed to
          // fzstd would fail deep in the decoder on the first tile. Fail here
          // instead, at open, with the cause named. See `compression.ts`.
          throw new Error(
            "STT manifest: 'gzip' is a retired codec — packed archives are zstd-only",
          );
        case 'zstd':
          this.packCompression = Compression.Zstd;
          break;
        default:
          throw new Error(
            `STT manifest: unsupported compression ${JSON.stringify(manifest.compression)} ` +
              "(expected 'zstd' or 'none')",
          );
      }
      // Temporal-tier facts for the synchronous directory lookups
      // (findTileEntry): the base bucket width and whether a temporal-LOD
      // pyramid exists at all. Defaults mirror getMetadata's.
      const metaJson = manifest.metadata ?? {};
      this.baseTemporalBucketMs = metaJson.temporal_bucket_ms ?? 3600 * 1000;
      this.hasTemporalLod =
        Array.isArray(metaJson.temporal_lod) &&
        metaJson.temporal_lod.length > 0;
      this.summaryTierSync = parseSummaryTier(metaJson.summary_tier);
      // Legacy-aware: a pre-v3 manifest declares no registry, and its implicit
      // one is raw-only (plus any summary tier its metadata names).
      this.declaredVariantIds = new Set(
        effectiveVariants(manifest).map((variant) => variant.id),
      );
      // OPFS fingerprint = the content-addressed directory hash. It changes iff
      // the dataset's tiles change, and is stable across the dataset's packs.
      this.archiveFingerprint = manifest.directory.key;
      this.manifestCache = manifest;
      return manifest;
    })();
    try {
      return await this.manifestPromise;
    } finally {
      this.manifestPromise = undefined;
    }
  }

  /**
   * GET a whole (non-range) object — manifest or directory — under the same
   * stall timeout as range requests, validating the body length when the
   * expected size is known (the manifest carries `directory.length`, so a
   * truncated directory is caught here instead of corrupting the decode).
   */
  private async fetchWholeObject(
    url: string,
    what: string,
    expectedLength?: number,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    const lifetime = composeAbortSignals(
      signal,
      this.lifetimeController.signal,
    );
    const transfer = withTransferTimeout(
      lifetime.signal,
      this.transferTimeoutMs,
    );
    try {
      const response = await raceAbort(
        this.fetchFn(url, { signal: transfer.signal }),
        transfer.signal,
      );
      if (!response.ok) {
        throw new Error(
          `STT ${what} fetch failed: ${response.status} ${response.statusText}`,
        );
      }
      const buffer = await raceAbort(response.arrayBuffer(), transfer.signal);
      if (
        expectedLength !== undefined &&
        buffer.byteLength !== expectedLength
      ) {
        throw new Error(
          `STT ${what} truncated: got ${buffer.byteLength} bytes, expected ${expectedLength}`,
        );
      }
      return buffer;
    } finally {
      transfer.cleanup();
      lifetime.cleanup();
    }
  }

  /**
   * {@link fetchWholeObject} with the same jittered backoff as
   * {@link fetchRangeWithRetry}. The manifest and directory GETs need retry at
   * least as badly as any tile range does: nothing else in the archive can
   * proceed until those two objects land, so fetching them single-attempt
   * turns one transient failure into a dead archive.
   */
  private async fetchWholeObjectWithRetry(
    url: string,
    what: string,
    expectedLength?: number,
  ): Promise<ArrayBuffer> {
    const signal = this.lifetimeController.signal;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      if (attempt > 0) {
        const base = this.retryDelaysMs[attempt - 1];
        await abortableDelay(base * (0.5 + Math.random()), signal);
      }
      try {
        return await this.fetchWholeObject(url, what, expectedLength);
      } catch (error) {
        if (isAbortError(error)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  /**
   * Fetch a byte range from pack `packIndex`, validating that the server
   * honoured it. A 200 (server ignored Range) would silently corrupt every
   * offset-based read, so it's rejected — as is a 206 whose `Content-Range`
   * or body length disagrees with the request (a truncated body would
   * corrupt every member sliced from a coalesced buffer). The transfer runs
   * under the stall timeout so a TCP-stalled response can't hang forever.
   */
  private async fetchRange(
    packIndex: number,
    start: number,
    end: number,
    signal?: AbortSignal,
    fetchPriority?: 'high' | 'low' | 'auto',
  ): Promise<ArrayBuffer> {
    const manifest = await this.fetchManifest();
    const pack = manifest.packs[packIndex];
    if (!pack) {
      throw new Error(
        `STT archive: tile references pack ${packIndex} but only ${manifest.packs.length} packs exist`,
      );
    }
    return this.fetchObjectRange(
      this.resolveKey(pack.key),
      start,
      end,
      signal,
      fetchPriority,
    );
  }

  /**
   * Fetch a byte range from an arbitrary object URL (a pack or the `.sttd`
   * directory), validating that the server honoured it. A 200 (Range ignored)
   * would silently corrupt every offset-based read, so it's rejected — as is a
   * 206 whose `Content-Range` or body length disagrees with the request. The
   * transfer runs under the stall timeout. This is the shared primitive behind
   * both per-pack tile reads and paged-directory leaf reads.
   *
   * Also the LATENCY sample point (CO-7): the interval between issuing the
   * request and its response HEADERS resolving is this link's time-to-first-
   * byte — the only part of a transfer that coalescing actually saves, and so
   * the right `L̂` for {@link effectiveCoalesceGap}. It is stamped here rather
   * than around {@link beginTransferSample}/{@link endTransferSample} because
   * those bracket the whole busy WINDOW (retries and backoff included), which
   * is the right weight for `θ̂` and the wrong one for a round trip.
   */
  private async fetchObjectRange(
    url: string,
    start: number,
    end: number,
    signal?: AbortSignal,
    fetchPriority?: 'high' | 'low' | 'auto',
  ): Promise<ArrayBuffer> {
    const lifetime = composeAbortSignals(
      signal,
      this.lifetimeController.signal,
    );
    const transfer = withTransferTimeout(
      lifetime.signal,
      this.transferTimeoutMs,
    );
    try {
      const init: RequestInit = {
        headers: { Range: `bytes=${start}-${end}` },
        signal: transfer.signal,
      };
      // `RequestInit.priority` is a hint; browsers without it ignore the field.
      if (fetchPriority)
        (init as RequestInit & { priority?: string }).priority = fetchPriority;
      const requestStart = nowMs();
      const response = await raceAbort(
        this.fetchFn(url, init),
        transfer.signal,
      );
      // Headers are back: that elapsed time IS the round trip, whatever the
      // response then says. A 4xx/5xx still cost a round trip, so the sample
      // is taken before the status checks below — an error path that skipped
      // it would bias `L̂` toward whichever requests happened to succeed.
      this.latency.addSample(nowMs() - requestStart);
      if (!response.ok) {
        throw new Error(
          `STT range fetch failed: ${response.status} ${response.statusText}`,
        );
      }
      if (response.status !== 206) {
        throw new Error(
          `STT server ignored Range request (status ${response.status}); ` +
            'HTTP range requests are required.',
        );
      }
      validateContentRange(response, start, end);
      const buffer = await raceAbort(response.arrayBuffer(), transfer.signal);
      const expected = end - start + 1;
      if (buffer.byteLength !== expected) {
        throw new Error(
          `STT range truncated: got ${buffer.byteLength} bytes, ` +
            `expected ${expected} (bytes=${start}-${end})`,
        );
      }
      return buffer;
    } finally {
      transfer.cleanup();
      lifetime.cleanup();
    }
  }

  /**
   * {@link fetchRange} with exponential backoff + full jitter on transient
   * failures (WS-E loader hardening). One transient 5xx / network blip used
   * to silently drop every tile in the affected batch; now the request is
   * retried per {@link ArchiveOptions.retryDelaysMs} (default 250 ms then
   * 1000 ms, each jittered ±50%) before the failure surfaces. A transfer
   * stall timeout counts as a transient failure and is retried the same way.
   *
   * An `AbortError` is NEVER retried — cancellation propagates immediately,
   * including out of a pending backoff delay.
   */
  private async fetchRangeWithRetry(
    packIndex: number,
    start: number,
    end: number,
    signal?: AbortSignal,
    fetchPriority?: 'high' | 'low' | 'auto',
  ): Promise<ArrayBuffer> {
    const manifest = await this.fetchManifest();
    const pack = manifest.packs[packIndex];
    if (!pack) {
      throw new Error(
        `STT archive: tile references pack ${packIndex} but only ${manifest.packs.length} packs exist`,
      );
    }
    return this.fetchObjectRangeWithRetry(
      this.resolveKey(pack.key),
      start,
      end,
      signal,
      fetchPriority,
    );
  }

  /** {@link fetchObjectRange} with the same jittered backoff + failure-aware
   *  throughput sampling as the per-pack path. Shared by tile and directory
   *  range reads. An `AbortError` is never retried. */
  private async fetchObjectRangeWithRetry(
    url: string,
    start: number,
    end: number,
    signal?: AbortSignal,
    fetchPriority?: 'high' | 'low' | 'auto',
  ): Promise<ArrayBuffer> {
    const lifetime = composeAbortSignals(
      signal,
      this.lifetimeController.signal,
    );
    let lastError: unknown;
    try {
      for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
        if (attempt > 0) {
          const base = this.retryDelaysMs[attempt - 1];
          await abortableDelay(base * (0.5 + Math.random()), lifetime.signal);
        }
        const attemptStart = nowMs();
        try {
          return await this.fetchObjectRange(
            url,
            start,
            end,
            lifetime.signal,
            fetchPriority,
          );
        } catch (error) {
          if (isAbortError(error)) throw error;
          // Failure-aware estimation: the estimator is otherwise fed only by
          // COMPLETED responses, so on a dead network `getEstimate()` holds
          // the last healthy rate forever and every ETA built from it lies.
          // A failed attempt burned its wall-clock for ~zero delivered bytes
          // — feed that as a 1-byte sample weighted by the attempt duration,
          // dragging the fast EWMA toward zero (a 20 s stall outweighs a
          // quick 5xx, which is the right proportionality).
          this.throughput.addSample(1, nowMs() - attemptStart);
          lastError = error;
        }
      }
      throw lastError;
    } finally {
      lifetime.cleanup();
    }
  }

  /**
   * Current network throughput estimate, fed by completed coalesced range
   * responses in {@link getTiles}: dual EWMA (3 s fast / 9 s slow half-life,
   * duration-weighted), published as `min(fast, slow)` — reacts fast to
   * drops, rises cautiously. `bytesPerMs` is `null` until the first sample.
   *
   * Wire into `SpatioTemporalTileset`'s `getThroughput` option so the
   * tileset can convert pending-byte counts into honest time-to-ready ETAs.
   */
  getThroughputEstimate(): ThroughputEstimate {
    return this.throughput.getEstimate();
  }

  /**
   * Current time-to-first-byte estimate in ms (EWMA over range responses), or
   * `null` before the first one. `null` means UNMEASURED, never "instant".
   */
  getLatencyEstimateMs(): number | null {
    return this.latency.getLatencyMs();
  }

  /**
   * The MEASURED bytes-equivalent price of one request, `L̂ × θ̂`, or `null`
   * while either estimator is cold (CO-5's request term).
   *
   * This is deliberately NOT {@link effectiveCoalesceGap}. The gap is a fuse
   * THRESHOLD and carries a pinned mode, a co-versioning gate, a
   * `[256 KiB, 4 MiB]` band and a 2 MiB cold default — fallbacks that exist so
   * an un-measured session still plans exactly the requests it always did.
   * They make it a safe threshold and an unsafe price: an argmin fed 2 MiB per
   * request ranks candidates by tile count, not by cost. Anything trading
   * requests against bytes must read the estimators here and ABSTAIN on
   * `null`. See {@link requestPriceBytes}.
   */
  getRequestPriceBytes(): number | null {
    return requestPriceBytes(
      this.latency.getLatencyMs(),
      this.throughput.getEstimate().bytesPerMs,
    );
  }

  /**
   * The byte gap both fuse sites bridge right now (CO-7).
   *
   * Precedence, most authoritative first:
   *  1. an explicit `ArchiveOptions.coalesceGapBytes` — pinned, no adaptation;
   *  2. the co-versioning guard — the manifest declares NO build-assumed gap
   *     ({@link manifestBuildAssumedGapBytes}), so the layout's provenance is
   *     unknown and {@link DEFAULT_RANGE_COALESCE_GAP} stands;
   *  3. either estimator cold — {@link DEFAULT_RANGE_COALESCE_GAP};
   *  4. otherwise `L̂ × θ̂`, clamped into the declared band around the
   *     build-assumed gap ({@link ADAPTIVE_GAP_BAND_FACTOR}).
   *
   * Cases 1–3 are byte-for-byte today's behavior, so an archive that is never
   * measured (or is explicitly pinned, or — like the whole published fleet
   * today — carries no build-assumed gap) plans exactly the requests it always
   * did. See {@link getCoalesceGapEstimate} for which case applied.
   */
  effectiveCoalesceGap(): number {
    return this.getCoalesceGapEstimate().gapBytes;
  }

  /**
   * {@link effectiveCoalesceGap} plus the evidence behind it — which of the
   * four cases applied, the two estimator readings (`null` = cold), and any
   * drift from the layout's build-assumed gap.
   */
  getCoalesceGapEstimate(): CoalesceGapEstimate {
    // Always reported, even where they are not consulted: `latencyMs` /
    // `bytesPerMs` describe the ESTIMATORS (null ⇔ cold), while `source` says
    // whether the gap was derived from them.
    const latencyMs = this.latency.getLatencyMs();
    const bytesPerMs = this.throughput.getEstimate().bytesPerMs;
    const blobOrdering = this.manifestCache?.blobOrdering ?? null;
    const buildAssumedGapBytes = manifestBuildAssumedGapBytes(
      this.manifestCache,
    );
    const report = (
      gapBytes: number,
      source: CoalesceGapSource,
    ): CoalesceGapEstimate => ({
      gapBytes,
      source,
      latencyMs,
      bytesPerMs,
      blobOrdering,
      buildAssumedGapBytes,
      driftsFromBuildAssumption:
        buildAssumedGapBytes !== null && gapBytes !== buildAssumedGapBytes,
    });

    // (1) Explicit pin wins over every measurement.
    if (this.coalesceGapPinned) {
      return report(this.coalesceGapBytes, 'pinned');
    }
    // (2) Co-versioning guard: a layout is only safe to read under a moved gap
    // when the archive says which gap it was priced at. `blobOrdering` cannot
    // answer that — it names the WINNING curve, never the selection mode, so
    // `measured` builds (the CLI default) publish as "spatial"/"time-major"
    // like everything else. The declared gap can, and its absence means
    // unknown provenance, which is never guessed at.
    if (adaptiveCoalesceGapBand(buildAssumedGapBytes) === null) {
      return report(this.coalesceGapBytes, 'no-build-gap');
    }
    // (3)/(4) Fitted, or the incumbent constant while either estimator is cold.
    if (latencyMs === null || bytesPerMs === null) {
      return report(this.coalesceGapBytes, 'cold');
    }
    return report(
      adaptiveCoalesceGapBytes(latencyMs, bytesPerMs, buildAssumedGapBytes),
      'adaptive',
    );
  }

  /**
   * Update this archive's fair-share weight in the process-shared request
   * scheduler (see `ArchiveOptions.schedulerWeight`). Future range-group
   * fetches enqueue with the new weight, AND work already queued under this
   * archive's `sourceId` is re-shared immediately (the scheduler deliberately
   * overrides its first-weight-wins pin), so a governor can re-balance
   * bandwidth mid-playback without waiting for the queue to drain.
   * Non-finite / non-positive weights are ignored (same guard as the option).
   */
  setSchedulerWeight(weight: number): void {
    if (
      !(typeof weight === 'number' && Number.isFinite(weight) && weight > 0)
    ) {
      return;
    }
    this.schedulerWeight = weight;
    setSharedSchedulerSourceWeight(this.url, weight);
  }

  /**
   * Mark one range transfer in flight for aggregate-window sampling. The
   * first transfer of a busy window anchors the window's wall clock; see
   * {@link endTransferSample} for where the sample lands.
   */
  private beginTransferSample(): void {
    if (this.activeTransferCount === 0) {
      this.transferWindowStart = nowMs();
      this.transferWindowBytes = 0;
    }
    this.activeTransferCount++;
  }

  /**
   * Settle one range transfer (`bytes` = 0 for a failed one). When the LAST
   * in-flight transfer settles, the whole busy window becomes one
   * `(totalBytes, wallClockMs)` sample — the link's aggregate rate, immune
   * to the ~N× per-request underestimate the concurrent pool would cause.
   * Retry backoff inside the window stays counted: time the link spent NOT
   * delivering bytes is honest pessimism.
   */
  private endTransferSample(bytes: number): void {
    this.transferWindowBytes += bytes;
    this.activeTransferCount--;
    if (this.activeTransferCount === 0 && this.transferWindowBytes > 0) {
      this.throughput.addSample(
        this.transferWindowBytes,
        nowMs() - this.transferWindowStart,
      );
    }
  }

  /** Archive metadata, folded into the manifest (no separate fetch). */
  async getMetadata(): Promise<ArchiveMetadata> {
    this.throwIfDisposed();
    if (this.metadataCache) return this.metadataCache;
    const manifest = await this.fetchManifest();
    const json = manifest.metadata ?? {};
    this.metadataCache = {
      // The packed format folds metadata into the manifest; surface the
      // manifest schema version (formatVersion) here for callers that branch
      // on it (the legacy single-file `version` is gone).
      version: manifest.formatVersion,
      name: json.name,
      description: json.description,
      attribution: json.attribution,
      bounds: json.bounds
        ? {
            minLon: json.bounds.min_lon,
            minLat: json.bounds.min_lat,
            maxLon: json.bounds.max_lon,
            maxLat: json.bounds.max_lat,
          }
        : { minLon: -180, minLat: -90, maxLon: 180, maxLat: 90 },
      timeRange: json.time_range
        ? { start: json.time_range.start, end: json.time_range.end }
        : { start: 0, end: Date.now() },
      minZoom: json.min_zoom ?? 0,
      maxZoom: json.max_zoom ?? 14,
      layers: (json.layers ?? []).map((name: string) => ({
        name,
        properties: [],
        geometryTypes: [],
      })),
      temporalBucketMs: json.temporal_bucket_ms ?? 3600 * 1000,
      summaryTier: parseSummaryTier(json.summary_tier),
      // The serialized `temporal_lod` field is omitted when unset; readers
      // that don't know about LOD can still parse the metadata blob.
      temporalLod: Array.isArray(json.temporal_lod)
        ? json.temporal_lod.map((l: any) => ({
            bucketMs: Number(l.bucket_ms),
            maxZoomLevel: Number(l.max_zoom_level),
          }))
        : undefined,
      heatmapDomain: parseHeatmapDomain(json.heatmap_domain),
      styleHints: parseStyleHints(json.style_hints),
    };
    return this.metadataCache;
  }

  /** Archive directory (the v5 tile index). One whole-object GET, cached. */
  async getIndex(): Promise<ArchiveIndex> {
    this.throwIfDisposed();
    if (this.indexCache) return this.indexCache;
    if (this.indexPromise) return this.indexPromise;
    this.indexPromise = this.fetchAndBuildIndex();
    try {
      return await this.indexPromise;
    } finally {
      this.indexPromise = undefined;
    }
  }

  private async fetchAndBuildIndex(): Promise<ArchiveIndex> {
    const manifest = await this.fetchManifest();
    const dref = manifest.directory;
    this.directoryUrl = this.resolveKey(dref.key);
    this.directoryZstd = dref.encoding === 'zstd';
    if (dref.encoding !== undefined && !this.directoryZstd) {
      throw new Error(
        `STT manifest: unknown directory encoding ${JSON.stringify(dref.encoding)} ` +
          "(this reader supports absent or 'zstd')",
      );
    }
    // v3 `.sttd` objects open with the 8-byte `STTD` magic prelude; the codec
    // bytes (root frame + leaves) follow it, and `rootLength` keeps meaning
    // the root frame's at-rest length (spec §2.1) — so all paged math below
    // is unchanged once offsets are shifted by the prelude.
    this.directoryDataStart = OBJECT_MAGIC_LEN;

    // Paged + large: fetch ONLY the root page (a prefix range GET), build the
    // page table, and leave the entry maps empty — leaves stream in on demand
    // via ensurePages*. Small/single directories take the whole-load path below.
    //
    // Every paged v3 manifest carries the root + one hash per leaf, so every
    // independently-fetched at-rest frame is authenticated before decompression.
    if (
      dref.layout === DIRECTORY_LAYOUT_PAGED &&
      dref.length > this.directoryPageThresholdBytes &&
      typeof dref.rootLength === 'number' &&
      typeof dref.rootHash === 'string' &&
      Array.isArray(dref.pageHashes)
    ) {
      const rootBuf = await this.fetchObjectRangeWithRetry(
        this.directoryUrl,
        0,
        this.directoryDataStart + dref.rootLength - 1,
      );
      const rootFrame = this.stripDirectoryMagic(new Uint8Array(rootBuf));
      this.verifyPagedFrameHash('root', rootFrame, dref.rootHash);
      const root = decodePagedRoot(this.unframeDirectory(rootFrame), {
        payloadLength: dref.length - OBJECT_MAGIC_LEN,
        rootLength: dref.rootLength,
        pageCount: dref.pageCount,
        pageEntries: dref.pageEntries,
      });
      this.paged = true;
      this.rootLength = dref.rootLength;
      this.pageTable = root.pages;
      this.residentPages.clear();
      this.pageFetchPromises.clear();
      this.tileEntryIndex.clear();
      this.occupiedCellListsByZoom.clear();
      this.tileEntryByKey.clear();
      this.indexCache = { tiles: [] }; // incremental — filled as pages stream in
      return this.indexCache;
    }

    // Whole-load path (single, or a paged directory small enough to grab in one
    // GET). One whole-object fetch, validated against `directory.length` (which
    // covers the ENTIRE object including the v3 magic — spec §2.1).
    this.paged = false;
    const buffer = await this.fetchWholeObjectWithRetry(
      this.directoryUrl,
      'directory',
      dref.length,
    );
    const objectBytes = new Uint8Array(buffer);
    // Enforce the directory's content address (spec §9.2): the object key
    // embeds the blake3-128 of its ENTIRE at-rest bytes. Verifying it here is
    // the dataset's root of trust — every tile offset/CRC the reader later
    // relies on comes from this object, so a tampered or corrupt directory must
    // fail loudly at open rather than be silently trusted. (Non-content-
    // addressed keys — synthetic test archives — carry no declared address to
    // check against, so verification is skipped for them.)
    this.verifyDirectoryContentAddress(dref.key, objectBytes);
    const bytes = this.stripDirectoryMagic(objectBytes);
    const raw =
      dref.layout === DIRECTORY_LAYOUT_PAGED
        ? this.decodePagedWhole(bytes, dref.rootLength ?? 0)
        : decodeDirectory(this.unframeDirectory(bytes));

    const tiles: TileEntry[] = raw.map((e) => this.toTileEntry(e));
    this.indexCache = { tiles };
    this.tileEntryIndex.clear();
    this.occupiedCellListsByZoom.clear();
    this.tileEntryByKey.clear();
    this.mergeEntries(tiles);
    return this.indexCache;
  }

  /** Unwrap the directory object's at-rest framing (one page or the whole). */
  private unframeDirectory(bytes: Uint8Array): Uint8Array {
    return this.directoryZstd ? unzstdSync(bytes) : bytes;
  }

  /**
   * Verify a fetched directory object against the blake3-128 content address
   * embedded in its key (packed spec §9.2). Enforced on every WHOLE-OBJECT
   * directory load — the directory is the reader's root of trust; a mismatch
   * means tampered or transport-corrupt bytes and MUST abort the open rather
   * than be silently trusted. The paged-on-demand path never fetches the whole
   * object; it instead verifies the manifest's root/page hashes for every
   * independently fetched frame before decompression.
   */
  private verifyDirectoryContentAddress(
    key: string,
    objectBytes: Uint8Array,
  ): void {
    const expected = directoryContentAddress(key);
    if (!expected) return;
    const actual = blake3Hex128(objectBytes);
    if (actual !== expected) {
      throw new Error(
        `STT directory object ${key}: content hash ${actual} does not match ` +
          `its declared address ${expected} — tampered or corrupt directory`,
      );
    }
  }

  /** Verify one independently-fetchable paged-directory frame before decode. */
  private verifyPagedFrameHash(
    label: string,
    frame: Uint8Array,
    expected: string,
  ): void {
    const actual = blake3Hex128(frame);
    if (actual !== expected) {
      throw new Error(
        `STT paged directory ${label}: content hash ${actual} does not match ` +
          `manifest ${expected} — tampered or corrupt page`,
      );
    }
  }

  /**
   * Validate + strip the `STTD` object magic prelude (`"STTD"` + version 3 +
   * 3 zero bytes) off directory bytes. Mirrors the Rust
   * `pack::directory_codec_bytes`.
   */
  private stripDirectoryMagic(bytes: Uint8Array): Uint8Array {
    if (
      bytes.byteLength < OBJECT_MAGIC_LEN ||
      bytes[0] !== 0x53 || // 'S'
      bytes[1] !== 0x54 || // 'T'
      bytes[2] !== 0x54 || // 'T'
      bytes[3] !== 0x44 // 'D'
    ) {
      throw new Error(
        'STT directory object: missing STTD magic (formatVersion 3)',
      );
    }
    // The prelude is a pure envelope (kind tag, version, three reserved zeros),
    // so an older version changes nothing about the codec bytes after it.
    if (bytes[4] < MIN_OBJECT_MAGIC_VERSION || bytes[4] > 3) {
      throw new Error(
        `STT directory object: unsupported object version ${bytes[4]} ` +
          `(this reader knows ${MIN_OBJECT_MAGIC_VERSION}..3)`,
      );
    }
    if (bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0) {
      throw new Error(
        'STT directory object: reserved magic bytes must be zero',
      );
    }
    return bytes.subarray(OBJECT_MAGIC_LEN);
  }

  /** Map a decoded `DirectoryEntry` to the reader's internal `TileEntry`. */
  private toTileEntry(
    e: ReturnType<typeof decodeDirectory>[number],
  ): TileEntry {
    return {
      zoom: e.zoom,
      x: e.x,
      y: e.y,
      timeStart: e.timeStart,
      timeEnd: e.timeEnd,
      variantId: e.variantId,
      packId: e.packId,
      offset: e.offset,
      length: e.length,
      featureCount: e.featureCount,
      compression: this.packCompression,
      uncompressedSize: e.uncompressedSize,
      crc32c: e.crc32c,
      temporalBucketMs: e.temporalBucketMs,
      coverTMin: e.coverTMin,
    };
  }

  /** Insert entries into the (z/x/y → list) and tier-qualified key maps. */
  private mergeEntries(entries: TileEntry[]): void {
    for (const entry of entries) {
      if (!this.declaredVariantIds.has(entry.variantId)) {
        throw new Error(
          `STT directory: variant ${entry.variantId} is not declared by manifest.variants`,
        );
      }
      const spatialKey = tileCellKey(entry.zoom, entry.x, entry.y);
      let list = this.tileEntryIndex.get(spatialKey);
      if (!list) {
        list = [];
        this.tileEntryIndex.set(spatialKey, list);
        let zoomLists = this.occupiedCellListsByZoom.get(entry.zoom);
        if (!zoomLists) {
          zoomLists = [];
          this.occupiedCellListsByZoom.set(entry.zoom, zoomLists);
        }
        zoomLists.push(list);
      }
      list.push(entry);
      this.tileEntryByKey.set(
        tileEntryKey(
          entry.zoom,
          entry.x,
          entry.y,
          entry.timeStart,
          entry.variantId,
          entry.temporalBucketMs,
        ),
        entry,
      );
    }
  }

  /** Decode a whole paged `.sttd` (root + every leaf) — the small-paged load-all
   *  path, mirroring the Rust `decode_paged_directory`. */
  private decodePagedWhole(
    bytes: Uint8Array,
    rootLength: number,
  ): ReturnType<typeof decodeDirectory> {
    const root = decodePagedRoot(
      this.unframeDirectory(bytes.subarray(0, rootLength)),
      {
        payloadLength: bytes.length,
        rootLength,
        pageCount: this.manifestCache?.directory.pageCount,
        pageEntries: this.manifestCache?.directory.pageEntries,
      },
    );
    const out: ReturnType<typeof decodeDirectory> = [];
    for (let i = 0; i < root.pages.length; i++) {
      const d = root.pages[i];
      const start = rootLength + d.relOffset;
      if (start + d.length > bytes.length) {
        throw new Error(
          `STT paged directory: page ${i} range exceeds directory object`,
        );
      }
      const frame = bytes.subarray(start, start + d.length);
      const page = decodeDirectory(this.unframeDirectory(frame));
      if (page.length !== d.entryCount) {
        throw new Error(
          `STT paged directory: page ${i} decoded ${page.length} entries, ` +
            `root declares ${d.entryCount}`,
        );
      }
      for (const e of page) out.push(e);
    }
    return out;
  }

  /**
   * Fetch, decode and merge the given leaf pages (by `pageTable` index) if not
   * already resident. Adjacent page byte-ranges coalesce into one request (the
   * leaves are contiguous in the object), bounded by `maxConcurrentRequests`.
   * Concurrent callers share one in-flight fetch per page via `pageFetchPromises`.
   */
  private async fetchAndMergePages(
    indices: number[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.paged || !this.pageTable || !this.directoryUrl) return;
    for (const i of indices) {
      if (!Number.isSafeInteger(i) || i < 0 || i >= this.pageTable.length) {
        throw new Error(`STT paged directory: invalid page index ${i}`);
      }
    }
    const pending = indices
      .filter(
        (i) => !this.residentPages.has(i) && !this.pageFetchPromises.has(i),
      )
      .sort((a, b) => a - b);
    // Wait on any pages already in flight for this query, plus the new ones.
    const inflight = indices
      .filter((i) => this.pageFetchPromises.has(i))
      .map((i) => this.pageFetchPromises.get(i)!);

    // Coalesce contiguous/nearby page ranges into groups.
    interface Group {
      start: number;
      end: number;
      members: number[];
    }
    // One reading for the whole pass: the fuse decisions in this plan are then
    // all taken against the SAME G, which is what makes the plan a pure
    // function of (pending pages, gap) and keeps it monotone in G.
    const coalesceGap = this.effectiveCoalesceGap();
    const groups: Group[] = [];
    for (const i of pending) {
      const d = this.pageTable[i];
      // Leaf offsets are relative to the end of the root frame; the object
      // itself additionally opens with the v2 magic prelude when present.
      const start = this.directoryDataStart + this.rootLength + d.relOffset;
      const end = start + d.length - 1;
      const cur = groups[groups.length - 1];
      if (cur && start - (cur.end + 1) <= coalesceGap) {
        cur.end = Math.max(cur.end, end);
        cur.members.push(i);
      } else {
        groups.push({ start, end, members: [i] });
      }
    }

    // `grpSignal` is the per-group signal: the caller's `signal` on the legacy
    // path, or the scheduler-provided signal on the shared-scheduler path.
    const fetchGroup = async (
      g: Group,
      grpSignal: AbortSignal | undefined,
    ): Promise<void> => {
      const buf = await this.fetchObjectRangeWithRetry(
        this.directoryUrl!,
        g.start,
        g.end,
        grpSignal,
      );
      for (const i of g.members) {
        const d = this.pageTable![i];
        const rel =
          this.directoryDataStart + this.rootLength + d.relOffset - g.start;
        const frame = new Uint8Array(buf, rel, d.length);
        const expectedHash = this.manifestCache!.directory.pageHashes![i];
        this.verifyPagedFrameHash(`page ${i}`, frame, expectedHash);
        const entries = decodeDirectory(this.unframeDirectory(frame)).map((e) =>
          this.toTileEntry(e),
        );
        if (entries.length !== d.entryCount) {
          throw new Error(
            `STT paged directory: page ${i} decoded ${entries.length} entries, ` +
              `root declares ${d.entryCount}`,
          );
        }
        if (!this.residentPages.has(i)) {
          this.mergeEntries(entries);
          this.residentPages.add(i);
          // Append to the incremental index.tiles so getIndex() reflects what's
          // resident (no external consumer relies on it being complete).
          if (this.indexCache) this.indexCache.tiles.push(...entries);
        }
      }
    };

    // Page fetches don't carry a play-head, so the scheduler falls back to a
    // per-archive byte-order / enqueue-order sequence (pages are already sorted
    // by index = byte order). Directory paging happens at viewport-settle time,
    // ahead of the tile range fetches the EDF term actually orders, so this is
    // fine.
    const groupMinDistance = (): number | null => null;
    // Page fetches have no natural per-tile spatial entry to compare (a page
    // covers many tiles across a bbox) — spatial ordering has no obvious
    // meaning here, so this mirrors groupMinDistance's null.
    const groupSpatialDistance = (): number | null => null;

    // Register a shared promise per pending page so concurrent queries dedupe,
    // then dispatch all groups through runGroupFetches (shared scheduler when
    // enabled, legacy cursor runner otherwise). We pre-create a per-group
    // deferred so the registry can point at the eventual settlement BEFORE
    // runGroupFetches starts the (possibly scheduler-deferred) fetch — so a
    // concurrent query that arrives while a group is merely queued still dedups
    // onto it. The registered promise is `.catch`-guarded so a later caller's
    // abort can't surface as an unhandled rejection on a different caller.
    const groupSettled = new Map<
      Group,
      { resolve: () => void; reject: (e: unknown) => void }
    >();
    // Groups whose deferred has already been settled by `executeGroup`. On the
    // shared-scheduler path a group cancelled while still QUEUED is dropped by
    // the scheduler WITHOUT ever invoking `execute` (see request-scheduler
    // abortEntry), so its `executeGroup` wrapper never runs and never settles
    // the deferred. We therefore reject any leftover deferred in the `finally`
    // below — otherwise its `reg.finally` never prunes `pageFetchPromises` and
    // dedup waiters (`await Promise.all(inflight)`) hang forever.
    const settledGroups = new Set<Group>();
    for (const g of groups) {
      let resolve!: () => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      groupSettled.set(g, { resolve, reject });
      const reg = promise.finally(() => {
        for (const i of g.members) {
          if (this.pageFetchPromises.get(i) === reg)
            this.pageFetchPromises.delete(i);
        }
      });
      // Guard against an unhandled rejection: dedup waiters that DO care await
      // it (and re-observe the rejection); the registry copy must not crash.
      reg.catch(() => {});
      for (const i of g.members) this.pageFetchPromises.set(i, reg);
    }

    // Drive the fetches; resolve/reject each group's deferred as it settles so
    // dedup waiters unblock. An abort propagates to THIS caller (matching the
    // pre-Phase-2 `await Promise.all(groupPromises)` semantics).
    let runError: unknown;
    let threw = false;
    try {
      await this.runGroupFetches(
        groups,
        async (g, grpSignal) => {
          const d = groupSettled.get(g)!;
          settledGroups.add(g);
          try {
            await fetchGroup(g, grpSignal);
            d.resolve();
          } catch (e) {
            d.reject(e);
            throw e;
          }
        },
        groupMinDistance,
        groupSpatialDistance,
        { signal },
        // Probe label: directory leaf pages, keyed by the group's lead page
        // index. Cold-start byte accounting (K10) prices the leaf share, so
        // page fetches must be visible on the channel alongside tile fetches.
        (g) => ({
          key: `dir/page/${g.members[0]}`,
          bytes: g.end - g.start + 1,
        }),
        // BH-1 cost: the coalesced leaf-page range's exact size. Directory
        // pages are as real a byte draw as tile blobs, so they are metered the
        // same way rather than billing a flat quantum.
        (g) => g.end - g.start + 1,
      );
    } catch (e) {
      runError = e;
      threw = true;
    } finally {
      // Settle any group whose `executeGroup` was never invoked (scheduler
      // dropped it while queued on caller-abort). Without this the deferred —
      // and its `reg.finally` that prunes `pageFetchPromises` — never fire,
      // leaking the registry entry and deadlocking later dedup waiters.
      for (const [g, d] of groupSettled) {
        if (settledGroups.has(g)) continue;
        d.reject(runError ?? createCancellationError('Superseded'));
      }
    }
    if (threw) throw runError;
    await Promise.all(inflight);
  }

  /**
   * Ensure every leaf page whose descriptor overlaps `(bounds, zoom, timeRange)`
   * is resident. No-op for single / small-paged archives (maps already full).
   * Geo-bbox ∩ viewport ∧ zoom membership ∧ temporal overlap — exactly the Rust
   * `PageDescriptor::overlaps` predicate.
   *
   * The longitude test runs against the WRAPPED query intervals (see
   * {@link lonQueryIntervals}) so a seam-crossing viewport pages in the leaves
   * on BOTH sides of the antimeridian. Without that, the wrapped half of the
   * query selected tile columns (`boundsToTiles` is wrap-aware) whose leaf
   * pages were never fetched, so the entry index came back empty for them.
   */
  private async ensurePagesForBounds(
    bounds: BoundingBox,
    zoom: number,
    timeRange: TimeRange,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.paged || !this.pageTable) return;
    const lonSpans = lonQueryIntervals(bounds.minLon, bounds.maxLon);
    // Order the latitude band for the same reason `boundsToTiles` orders its
    // row span: an inverted box turns the overlap test below into a REJECT-ALL
    // (`p.maxLat < 10 || -10 < p.minLat` is true for essentially every page),
    // so every leaf gets pruned and the columns the scan then selects resolve
    // against an empty entry index.
    const latLo = Math.min(bounds.minLat, bounds.maxLat);
    const latHi = Math.max(bounds.minLat, bounds.maxLat);
    const needed: number[] = [];
    for (let i = 0; i < this.pageTable.length; i++) {
      if (this.residentPages.has(i)) continue;
      if (
        !pageOverlapsQuery(
          this.pageTable[i],
          lonSpans,
          latLo,
          latHi,
          zoom,
          timeRange,
        )
      ) {
        continue;
      }
      needed.push(i);
    }
    if (needed.length > 0 || this.pageFetchPromises.size > 0) {
      await this.fetchAndMergePages(needed, signal);
    }
  }

  /**
   * {@link ensurePagesForBounds} for an explicit CELL LIST — the paging half of
   * {@link getAvailableTilesForCells}.
   *
   * Same descriptor predicate ({@link pageOverlapsQuery}, shared so the two can
   * never drift), applied per cell against that cell's own geographic box and
   * its own zoom. That per-cell zoom is the whole point: a frustum cut is
   * MIXED-ZOOM, so the single `zoom` argument the bounds form takes cannot
   * express it, and using the cut's deepest zoom for the whole list would prune
   * every leaf that only covers the far field.
   *
   * A cell's box is in-world by construction (`x` arrives wrapped into
   * `[0, 2^z)`), so its `lonQueryIntervals` is the single-interval fast path —
   * the seam is already handled, once, by the wrap at emit.
   *
   * Pages are the outer loop with an early exit per page: a cut is hundreds of
   * cells and a paged directory is hundreds of leaves, and almost every leaf is
   * decided by its first overlapping cell.
   */
  private async ensurePagesForCells(
    cells: readonly TileId[],
    timeRange: TimeRange,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.paged || !this.pageTable) return;
    // Hoisted per cell, exactly as the bounds form hoists them per query.
    const boxes = cells.map((cell) => {
      const [minLon, minLat, maxLon, maxLat] = tileToLonLatBounds(
        cell.z,
        cell.x,
        cell.y,
      );
      return {
        zoom: cell.z,
        lonSpans: lonQueryIntervals(minLon, maxLon),
        latLo: Math.min(minLat, maxLat),
        latHi: Math.max(minLat, maxLat),
      };
    });
    const needed: number[] = [];
    for (let i = 0; i < this.pageTable.length; i++) {
      if (this.residentPages.has(i)) continue;
      const page = this.pageTable[i];
      for (const box of boxes) {
        if (
          pageOverlapsQuery(
            page,
            box.lonSpans,
            box.latLo,
            box.latHi,
            box.zoom,
            timeRange,
          )
        ) {
          needed.push(i);
          break;
        }
      }
    }
    if (needed.length > 0 || this.pageFetchPromises.size > 0) {
      await this.fetchAndMergePages(needed, signal);
    }
  }

  /**
   * Directory entries a query CANNOT see because their leaf page isn't
   * resident — the honesty channel behind {@link SelectionCost.unknownTiles}.
   *
   * Runs exactly the {@link ensurePagesForBounds} descriptor predicate (shared
   * code, so the two can't drift) but *counts* instead of fetching: a leaf that
   * `ensurePagesForBounds` would fault in is precisely a leaf whose entries the
   * synchronous walk is blind to. `entryCount` is the descriptor's own number,
   * so this is a count the root page actually states — never an extrapolation
   * from the priced entries.
   */
  private unknownEntriesInBounds(
    bounds: BoundingBox,
    zoom: number,
    timeRange: TimeRange,
  ): number {
    if (!this.paged || !this.pageTable) return 0;
    const lonSpans = lonQueryIntervals(bounds.minLon, bounds.maxLon);
    const latLo = Math.min(bounds.minLat, bounds.maxLat);
    const latHi = Math.max(bounds.minLat, bounds.maxLat);
    let unknown = 0;
    for (let i = 0; i < this.pageTable.length; i++) {
      if (this.residentPages.has(i)) continue;
      const p = this.pageTable[i];
      if (!pageOverlapsQuery(p, lonSpans, latLo, latHi, zoom, timeRange)) {
        continue;
      }
      unknown += p.entryCount;
    }
    return unknown;
  }

  /**
   * Ensure the leaf pages covering the given tile IDs are resident — for the
   * direct `getTile`/`getTiles` paths (the tileset's `getTileIdsInBounds`
   * already ensured its pages, so its follow-up `getTiles` is usually a no-op).
   */
  private async ensurePagesForTiles(
    ids: TileId[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.paged || !this.pageTable || ids.length === 0) return;
    // Upper prune bound (see below): the widest bucket any tile in this
    // archive can have — the base bucket or any declared temporal-LOD tier.
    // getMetadata() is a pure cache read here (the manifest was fetched by
    // the getIndex() that made the archive paged in the first place).
    const meta = await this.getMetadata();
    const maxBucketMs = Math.max(
      meta.temporalBucketMs ?? 3600 * 1000,
      ...(meta.temporalLod ?? []).map((l) => l.bucketMs),
    );
    const needed = new Set<number>();
    for (const id of ids) {
      const [minLon, minLat, maxLon, maxLat] = tileToLonLatBounds(
        id.z,
        id.x,
        id.y,
      );
      for (let i = 0; i < this.pageTable.length; i++) {
        if (this.residentPages.has(i)) continue;
        const p = this.pageTable[i];
        if (id.z < p.minZoom || id.z > p.maxZoom) continue;
        if (p.maxLon < minLon || maxLon < p.minLon) continue;
        if (p.maxLat < minLat || maxLat < p.minLat) continue;
        // Point query by bucket key: `tMax` = max(timeEnd) bounds every
        // contained bucket's end, so `tMax < t` is a sound prune. `tMin` is
        // NOT a bound on bucket starts — it derives from
        // min(coverTMin ?? timeStart) (spec §4.1) and a tile's coverTMin (its
        // earliest feature start) can EXCEED its bucket's timeStart, so
        // pruning on `tMin > t` missed tiles whose bucket starts before the
        // leaf's covering bound (getTile({t: timeStart}) returned null).
        if (p.tMax < id.t) continue;
        // Sound UPPER prune. For the leaf holding the queried tile:
        //   tMin = min over the leaf of (coverTMin ?? timeStart)   (spec §4.1)
        //        <= (coverTMin ?? timeStart) of the queried tile.
        // The queried tile is addressed by its bucket start, timeStart = id.t.
        //   - coverTMin absent  → the contribution is timeStart = id.t.
        //   - coverTMin present → coverTMin is the earliest feature
        //     start_time in the tile (time-model §5), and every feature is
        //     assigned to the bucket CONTAINING its start (time-model §3.1),
        //     so every start < timeStart + bucketMs(tile); writers may only
        //     move starts EARLIER (the covering delta is signed for clip
        //     continuity), never past the bucket end. Hence
        //     coverTMin < id.t + bucketMs(tile) <= id.t + maxBucketMs.
        // Either way tMin <= id.t + maxBucketMs, so a leaf with
        // tMin > id.t + maxBucketMs cannot hold the tile — without this
        // bound, a point query near the dataset start faulted in EVERY
        // spatially-matching later leaf.
        if (p.tMin > id.t + maxBucketMs) continue;
        needed.add(i);
      }
    }
    if (needed.size > 0) await this.fetchAndMergePages([...needed], signal);
  }

  /**
   * Resolve a TileId to its directory entry. An id carrying `bucketMs`
   * (from {@link getTileIdsInBoundsForTemporalLod}) addresses that
   * temporal-LOD tier; a plain id addresses the base tier — the two can
   * share a `z/x/y/t`, so the lookup is tier-qualified end to end.
   */
  private findTileEntry(id: TileId): TileEntry | undefined {
    const base = this.baseTemporalBucketMs;
    const want = id.bucketMs ?? base;
    const variantId = id.variantId ?? 0;
    const exact =
      this.tileEntryByKey.get(
        tileEntryKey(id.z, id.x, id.y, id.t, variantId, want),
      ) ??
      (want === base
        ? this.tileEntryByKey.get(
            tileEntryKey(id.z, id.x, id.y, id.t, variantId, undefined),
          )
        : undefined);
    if (exact) return exact;
    const entries = this.tileEntryIndex.get(tileCellKey(id.z, id.x, id.y));
    if (!entries) return undefined;
    return entries.find(
      (e) =>
        e.variantId === variantId &&
        (e.temporalBucketMs ?? base) === want &&
        e.timeStart <= id.t &&
        e.timeEnd >= id.t,
    );
  }

  /**
   * Compressed byte size of a tile from the already-decoded directory, or
   * `undefined` if the tile isn't indexed (or its leaf page isn't resident yet
   * on a paged archive). Synchronous, no I/O — the tileset's giant-parent skip
   * guard calls it without awaiting; on a paged archive a not-yet-resident
   * page returns `undefined` (the guard then degrades to "don't skip"), and the
   * page becomes resident the moment the tile is actually requested.
   */
  getTileByteSize(id: TileId): number | undefined {
    return this.findTileEntry(id)?.length;
  }

  /**
   * Price a whole SELECTION — every tile a `(bounds, zoom, timeRange)` query
   * at one tier would address — in exact compressed bytes, synchronously and
   * with zero network.
   *
   * This is the general form of a primitive the reader already had in pieces:
   * {@link getTileByteSize} prices one tile, and the tileset's coverage index
   * prices one viewport at the primary zoom. Here the same directory entries
   * are summed for ANY (cell set × window × tier) triple, which is what the
   * client's controllers need to stop guessing: how many bytes is this
   * prefetch horizon / this gate window / this speed / this temporal tier?
   *
   * The walk is {@link entryListsInBounds} — the same occupied-cell scan
   * {@link getTileIdsInBounds} uses — with the same variant, tier and
   * `coverTMin` filters, summing `entry.length` instead of materializing a
   * `TileId[]`. `opts` selects which of the three sibling selections is being
   * priced:
   *
   *   - default (`{}`) → {@link getTileIdsInBounds}: variant 0, and when the
   *     archive declares a temporal-LOD pyramid, base-bucket tiles only.
   *   - `{ bucketMs }` → {@link getTileIdsInBoundsForTemporalLod}: the tier
   *     whose tagged bucket equals `bucketMs` (untagged legacy entries count
   *     as the base tier).
   *   - `{ variantId }` → {@link getSummaryTileIdsInBounds}: that variant,
   *     with the declared summary tier's zoom gate applied so an out-of-range
   *     zoom prices at zero exactly as the id query returns `[]`.
   *
   * SYNCHRONOUS BY CONTRACT, hence the {@link SelectionCost.unknownTiles}
   * honesty channel: it prices what the reader can see and *counts* what it
   * cannot (non-resident leaves of a paged directory, or a directory that has
   * not been opened at all — `Infinity` there). It never faults a page in and
   * never invents a byte count. Callers that need a fully-priced answer should
   * await {@link getTileIdsInBounds} for the same box first, which pages the
   * needed leaves in, then ask again.
   */
  estimateSelectionCost(
    bounds: BoundingBox,
    zoom: number,
    timeRange: TimeRange,
    opts?: { bucketMs?: number; variantId?: number },
  ): SelectionCost {
    const variantId = opts?.variantId ?? 0;
    const wantBucketMs = opts?.bucketMs;
    // The directory has not been opened, so neither the priced set nor the
    // unpriced one is known. Report the unknown as unbounded rather than
    // letting a zero read as "this selection is free".
    if (!this.indexCache) {
      return { bytes: 0, tiles: 0, unknownTiles: Number.POSITIVE_INFINITY };
    }
    // Summary-tier zoom gate, mirroring getSummaryTileIdsInBounds: outside the
    // declared range the tier is not addressable, so it costs nothing.
    const summary = this.summaryTierSync;
    if (
      summary !== undefined &&
      variantId === summary.variantId &&
      (zoom < summary.minZoom || zoom > summary.maxZoom)
    ) {
      return { bytes: 0, tiles: 0, unknownTiles: 0 };
    }
    const base = this.baseTemporalBucketMs;
    // Only the DEFAULT base-tier selection filters LOD tiles out, and only
    // when the archive declares a pyramid — exactly getTileIdsInBounds's rule.
    const filterToBase =
      wantBucketMs === undefined && variantId === 0 && this.hasTemporalLod;
    let bytes = 0;
    let tiles = 0;
    for (const entries of this.entryListsInBounds(bounds, zoom)) {
      for (const e of entries) {
        if (e.variantId !== variantId) continue;
        if (wantBucketMs !== undefined) {
          if ((e.temporalBucketMs ?? base) !== wantBucketMs) continue;
        } else if (filterToBase) {
          const tagged = e.temporalBucketMs;
          if (tagged !== undefined && tagged !== base) continue;
        }
        // Window overlap, byte-identical to the id queries': tight `timeEnd`
        // above, tight covering `coverTMin` (falling back to the bucket edge
        // `timeStart`) below — a tile whose data lies entirely after the
        // window is not selected, so it must not be priced either.
        if (
          e.timeEnd >= timeRange.start &&
          (e.coverTMin ?? e.timeStart) <= timeRange.end
        ) {
          bytes += e.length;
          tiles++;
        }
      }
    }
    return {
      bytes,
      tiles,
      unknownTiles: this.unknownEntriesInBounds(bounds, zoom, timeRange),
    };
  }

  /**
   * Build the OPFS cache key for a tile. Includes the archive URL and a
   * stable fingerprint so a redeployed archive (different ETag) doesn't
   * silently serve stale tiles. Returns `null` when the fingerprint isn't
   * known yet — in that case we just skip OPFS for this call; the next one
   * (post-header) will have a fingerprint and start hitting.
   *
   * This string reaches disk, so {@link tileKey}'s format is a persistence
   * contract: altering it orphans every tile cached under the old spelling.
   */
  private opfsKey(id: TileId): string | null {
    if (!this.archiveFingerprint) return null;
    return `${this.url}::${tileKey(id)}::${this.archiveFingerprint}`;
  }

  /**
   * Persist the decoder's own decompressed payload to OPFS in the
   * background — the zero-extra-work path: the default decoders hand their
   * decompressed bytes back with the tile (`DecodeArgs.onPayload`), so
   * nothing is re-decompressed on the main thread. On every subsequent
   * reload that same key skips both the HTTP fetch and the zstd decompress.
   */
  private async writeOpfsPayload(
    key: string,
    payload: Uint8Array,
    zoom: number,
  ): Promise<void> {
    const cache = this.opfsCache;
    if (!cache) return;
    try {
      // The zoom rides along so the cache's admission filter (BH-9) can keep
      // overview tiles unconditionally and make tiny leaf tiles earn their
      // slot. A cache with the filter off ignores it.
      await cache.set(key, payload, { zoom });
    } catch {
      // Best-effort: an OPFS error must never break the data path.
    }
  }

  /**
   * FALLBACK OPFS write for decoders that don't hand their decompressed
   * payload back (a custom `ArchiveOptions.decoder` ignoring `onPayload`):
   * re-decompress on the main thread. Wasted CPU on the cold path, but it
   * runs AFTER the tile has been delivered to the caller — so it doesn't
   * block any user-visible work.
   */
  private async writeOpfsAsync(
    id: TileId,
    entry: TileEntry,
    compressed: ArrayBuffer,
  ): Promise<void> {
    const cache = this.opfsCache;
    if (!cache) return;
    const key = this.opfsKey(id);
    if (!key) return;
    try {
      const decompressed = await decompress(
        new Uint8Array(compressed),
        entry.compression,
        // Bound the fallback re-decompress by the directory's declared size
        // (spec §11) — a lying/oversized frame can't blow up this cold path.
        entry.uncompressedSize || undefined,
      );
      await cache.set(key, decompressed, { zoom: id.z });
    } catch {
      // Best-effort: an OPFS error must never break the data path.
    }
  }

  /**
   * Decode compressed tile bytes into a Tile via the configured decoder.
   * `signal`, when given, cancels the decode itself (not just the fetch that
   * produced `compressed`) — a tile that scrolls off-screen while its decode
   * is still queued/running on a worker is dropped there instead of wasting
   * pool time on it. Optional: callers with no natural per-tile signal (rare)
   * simply get the pre-existing uncancellable behavior.
   *
   * `writeToOpfs` marks the network-miss call sites (fresh bytes worth
   * persisting): after a successful decode the payload is written to OPFS in
   * the background, reusing the decoder's own decompressed bytes when the
   * decoder hands them back (`onPayload`) and falling back to a main-thread
   * re-decompress for custom decoders that don't.
   *
   * `priority` (M6 / BH-5) carries the fetch stage's already-computed scheduler
   * priority (lower = more urgent) into the decode pool, so a saturated pool
   * serves the play-head's next tile before a prefetch-tier one instead of
   * serving whatever arrived first. Omitted by the warm paths (byte-cache and
   * OPFS hits), which are already the interactive class and default to the most
   * urgent value.
   */
  private async decodeBytes(
    id: TileId,
    entry: TileEntry,
    compressed: ArrayBuffer,
    signal?: AbortSignal,
    writeToOpfs = false,
    priority?: number,
  ): Promise<Tile> {
    // The packed format has NO shared zstd dictionary: every blob is
    // independently zstd-compressed (`compress_zstd_with_dict(_, None)` on the
    // writer), so the fzstd browser path decodes every tile. There's nothing
    // to guard against here.
    const opfsKey = writeToOpfs && this.opfsCache ? this.opfsKey(id) : null;
    let opfsPayload: Uint8Array | undefined;
    const tile = await this.getPreparedDecoder().decode({
      id,
      timeRange: { start: entry.timeStart, end: entry.timeEnd },
      compressed,
      compression: entry.compression,
      expectedUncompressedSize: entry.uncompressedSize,
      // Integrity (T1.4): the directory CRC-32C covers the compressed bytes;
      // verified in the decoder (off main thread on the worker path) before
      // decompression. `0` = "no checksum recorded" (see TileEntry.crc32c).
      expectedCrc32c: entry.crc32c ? entry.crc32c : undefined,
      // Authority rule (spec §5.2): the manifest's declared version rides
      // every decode so a mixed-version dataset fails loudly by name.
      formatVersion: this.formatVersion,
      onPayload: opfsKey
        ? (payload) => {
            opfsPayload = payload;
          }
        : undefined,
      signal,
      priority,
    });
    if (opfsKey) {
      if (opfsPayload) {
        void this.writeOpfsPayload(opfsKey, opfsPayload, id.z);
      } else {
        void this.writeOpfsAsync(id, entry, compressed.slice(0));
      }
    }
    return this.applyIpcRetention(tile);
  }

  /**
   * Decode an already-decompressed payload. Reused for OPFS warm hits — the
   * decoder still has to run the Arrow IPC parse + binary extraction, but
   * it skips the (often zstd) decompression step entirely. See
   * {@link decodeBytes} for `signal`.
   */
  private async decodeDecompressed(
    id: TileId,
    entry: TileEntry,
    decompressed: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Tile> {
    // Copy into a fresh ArrayBuffer — the worker decoder transfers ownership
    // of the buffer, and we may have other consumers (or the OPFS view)
    // still holding the original. The explicit `new ArrayBuffer(...)` is
    // belt-and-braces against a SharedArrayBuffer-backed input slipping in
    // (the decoder protocol requires a transferable buffer).
    const buf = new ArrayBuffer(decompressed.byteLength);
    new Uint8Array(buf).set(decompressed);
    // No CRC verification here: the directory CRC covers COMPRESSED bytes,
    // and this path starts from an already-decompressed OPFS payload. The
    // OPFS fingerprint (content-addressed directory hash) covaries with the
    // blob bytes, so a stale v1 payload MISSES rather than misparses; warm
    // v2 payloads decode via the same registry as network payloads (§4.4).
    const tile = await this.getPreparedDecoder().decode({
      id,
      timeRange: { start: entry.timeStart, end: entry.timeEnd },
      compressed: buf,
      compression: Compression.None,
      expectedUncompressedSize: entry.uncompressedSize,
      formatVersion: this.formatVersion,
      signal,
    });
    return this.applyIpcRetention(tile);
  }

  /**
   * Cheap validity check on an OPFS-cached (already-decompressed) payload: its
   * length must equal the directory's declared `uncompressedSize`. A truncated
   * or oversized entry — a partial write, disk-bit-rot, an unrelated blob — is
   * caught here before it can silently blank the tile, letting the caller
   * evict + self-heal. `uncompressedSize === 0` means the directory recorded no
   * size (synthetic archives), so there is nothing to check.
   */
  private opfsPayloadValid(entry: TileEntry, payload: Uint8Array): boolean {
    return (
      entry.uncompressedSize === 0 ||
      payload.byteLength === entry.uncompressedSize
    );
  }

  /**
   * Fetch a tile's compressed bytes from origin and decode them, persisting the
   * fresh decompressed payload back to OPFS (`writeToOpfs`). Used by the cold
   * network path AND by OPFS self-heal: re-decoding overwrites the poisoned
   * OPFS entry at the same key with correct bytes, so a corrupt cache entry
   * heals on the next request instead of blanking the tile forever.
   */
  private async fetchAndDecodeTile(
    id: TileId,
    entry: TileEntry,
    signal?: AbortSignal,
    fetchPriority?: 'high' | 'low' | 'auto',
  ): Promise<Tile> {
    const compressed = await this.fetchRangeWithRetry(
      entry.packId,
      entry.offset,
      entry.offset + entry.length - 1,
      signal,
      fetchPriority,
    );
    this.storeBytes(tileKey(id), compressed, entry.timeStart);
    return this.decodeBytes(id, entry, compressed, signal, true);
  }

  /**
   * Apply the {@link ArchiveOptions.retainArrowIpc} policy to a freshly
   * decoded tile. `'auto'` drops a layer's raw IPC reference (and any
   * inline-decoded `arrowTable`, which pins the same buffers) only when NO
   * extracted column is a view into the IPC buffer — for such layers
   * (quantized/converted tiles) retention is pure memory overhead; for
   * zero-copy layers dropping frees nothing, so the GeoArrow hand-off is
   * kept. `true` keeps everything (pre-option behavior); `false` always
   * drops. Dropped layers are flagged so `toGeoArrowTable()` can name the
   * option in its error.
   */
  private applyIpcRetention(tile: Tile): Tile {
    const mode = this.retainArrowIpc;
    if (mode === true) return tile;
    for (const layer of tile.layers) {
      if (!layer.arrowIpc && !layer.arrowTable) continue;
      // 'auto' is SEMANTIC, not aliasing-based: drop only for
      // coordinate-quantized layers, whose tables are not literal GeoArrow
      // (a generic consumer misreads Int32 grid indices as lon/lat — the
      // hand-off was never spec-valid there), and keep everything else so
      // `toGeoArrowTable()` stays available exactly where it is valid —
      // including legacy unaligned frames whose columns are copies.
      if (mode === 'auto' && !layer.coordinatesQuantized) {
        continue;
      }
      layer.arrowIpc = undefined;
      layer.arrowIpcProps = undefined;
      layer.arrowTable = undefined;
      layer.arrowIpcDropped = true;
    }
    return tile;
  }

  /** Fetch and decode a single tile. */
  async getTile(
    id: TileId,
    options?: TileRequestOptions,
  ): Promise<Tile | null> {
    await this.getIndex();
    await this.ensurePagesForTiles([id], options?.signal);
    const entry = this.findTileEntry(id);
    if (!entry) return null;

    const key = tileKey(id);
    const cached = this.byteCache.get(key);
    if (cached) {
      this.touchCachedBytes(key, cached);
      this.cacheStats.hits++;
      try {
        return await this.decodeBytes(id, entry, cached.bytes, options?.signal);
      } catch (err) {
        if (isAbortError(err)) throw err;
        // Poisoned cache entry (CRC mismatch / corrupt bytes): evict it and
        // fall through ONCE to the network path — otherwise the poison would
        // rethrow on every retry with no way to self-heal.
        this.dropCachedBytes(key);
      }
    }

    // OPFS lookup BEFORE the network. A hit returns decompressed bytes that
    // we can feed straight into the decoder, skipping zstd entirely. Note
    // we also skip storing the bytes back into the in-memory byteCache —
    // they're decompressed, while the in-memory cache holds compressed
    // payloads. Re-fetches inside the same tab will hit OPFS again, which
    // is still very fast.
    const opfsK = this.opfsCache ? this.opfsKey(id) : null;
    if (this.opfsCache && opfsK) {
      const fromOpfs = await this.opfsCache.get(opfsK);
      if (fromOpfs && this.opfsPayloadValid(entry, fromOpfs)) {
        try {
          const tile = await this.decodeDecompressed(
            id,
            entry,
            fromOpfs,
            options?.signal,
          );
          this.opfsStats.hits++;
          return tile;
        } catch (err) {
          if (isAbortError(err)) throw err;
          // Corrupt OPFS payload (right length, wrong bytes): fall through to
          // the network path below, which overwrites the poisoned entry with
          // fresh bytes (self-heal) instead of returning a broken tile.
          this.opfsStats.misses++;
        }
      } else {
        // Absent, or truncated/oversized entry (evicted-by-overwrite via the
        // refetch below).
        this.opfsStats.misses++;
      }
    }

    this.cacheStats.misses++;
    // Network miss (or OPFS self-heal) → fetch + decode + fire-and-forget OPFS
    // write (the decoder hands its decompressed payload back, so nothing is
    // re-decompressed here; the write overwrites any poisoned entry).
    return this.fetchAndDecodeTile(
      id,
      entry,
      options?.signal,
      options?.fetchPriority,
    );
  }

  /**
   * Compute the cross-source EDF priority for a coalesced range-group
   * (docs/roadmap/playback-and-loading.md §5). LOWER value = higher priority
   * (Cesium/scheduler semantics).
   *
   *   priority = tierBase + distance-to-playhead-in-sim-ms
   *
   * - `tierBase` is 0 for need-now (`'auto'`/`'high'`) groups and a large
   *   constant for `'low'` (prefetch) groups, so prefetch ALWAYS ranks below
   *   need-now work globally across archives (the required-vs-optional analog).
   * - The distance term is the group's MINIMUM distance-to-playhead in sim-ms
   *   across its members — comparable across archives because they share one
   *   playhead. Data already passed by the play-head (behind it in the travel
   *   direction) is pushed far back (a large positive offset) so it never beats
   *   imminent data; the play-head doesn't need it now.
   *
   * When no playhead is threaded in (`options.playheadTime` unset) the distance
   * term is a per-archive monotonic byte-order / enqueue-order sequence number
   * instead — tier-correct, but not true cross-source EDF within a tier (see
   * `TileRequestOptions.playheadTime`). Returns a finite number ≥ 0; this is the
   * `getPriority` callback the scheduler re-evaluates at dispatch time. It never
   * returns `< 0` — supersession cancellation is wired via the caller's abort
   * signal (→ `ScheduledRequest.abort()`), not via negative priority, so the two
   * mechanisms can't double-cancel.
   */
  private groupSchedulerPriority(
    minDistanceMs: number | null,
    fallbackSeq: number,
    fetchPriority: 'high' | 'low' | 'auto' | undefined,
    spatialDistSq: number | null,
  ): number {
    const tierBase = fetchPriority === 'low' ? SCHEDULER_PREFETCH_TIER_BASE : 0;
    // Within a tier: EDF distance-to-playhead when known, else byte-order /
    // enqueue-order seq.
    const term =
      minDistanceMs !== null && Number.isFinite(minDistanceMs)
        ? Math.max(0, minDistanceMs)
        : Math.max(0, fallbackSeq);
    // Sub-unit spatial tie-break — see SPATIAL_TIEBREAK_WEIGHT. `null` (no
    // viewportCenter threaded in) contributes nothing, so priority is
    // unaffected unless a caller opts in.
    const spatialTieBreak =
      spatialDistSq !== null && Number.isFinite(spatialDistSq)
        ? Math.min(spatialDistSq, 2) * SPATIAL_TIEBREAK_WEIGHT
        : 0;
    return tierBase + term + spatialTieBreak;
  }

  /**
   * Minimum distance-to-playhead in sim-ms across a set of tile entries, given
   * the threaded play-head time + direction. Data BEHIND the play-head in the
   * travel direction is offset by a large constant so it sorts after all data
   * ahead of (or at) the play-head — it's already been passed. Returns `null`
   * when no play-head was threaded in (the caller then falls back to a
   * per-archive byte-order / enqueue-order sequence). See
   * {@link groupSchedulerPriority}.
   */
  private minDistanceToPlayhead(
    entries: TileEntry[],
    options: TileRequestOptions | undefined,
  ): number | null {
    const t = options?.playheadTime;
    if (typeof t !== 'number' || !Number.isFinite(t)) return null;
    const dir = options?.playheadDirection === -1 ? -1 : 1;
    // Anything more than this far behind the play-head is "already passed".
    const BEHIND_OFFSET = SCHEDULER_PREFETCH_TIER_BASE / 2;
    let best = Infinity;
    for (const e of entries) {
      // Signed distance in the travel direction (positive = ahead of playhead).
      const ahead = dir > 0 ? e.timeStart - t : t - e.timeStart;
      // Distance metric: |t - timeStart|, but penalize data behind the playhead
      // so imminent-ahead data always wins.
      const dist = ahead >= 0 ? ahead : BEHIND_OFFSET + Math.abs(ahead);
      if (dist < best) best = dist;
    }
    return Number.isFinite(best) ? best : null;
  }

  /**
   * Minimum squared normalized-mercator distance from a coalesced group's
   * member tile centers to the viewport center — the spatial analog of
   * {@link minDistanceToPlayhead}'s "closest member wins" semantics, but in
   * space rather than time. Normalized to a zoom-independent [0,1)×[0,1)
   * world square (not each tile's own zoom-scale pixels) so a mixed
   * parent-fallback group spanning several zooms still compares fairly.
   * Squared rather than sqrt'd since only relative ordering matters for a
   * tie-break and it's cheaper. Returns `null` when no viewport center was
   * threaded in (`options.viewportCenter` unset) — the caller then
   * contributes zero spatial term, unchanged from before this existed. See
   * {@link groupSchedulerPriority}.
   */
  private minDistanceToViewportCenter(
    entries: TileEntry[],
    options: TileRequestOptions | undefined,
  ): number | null {
    const center = options?.viewportCenter;
    if (!center) return null;
    const [cx, cy] = lonLatToNormalizedMercator(center.lon, center.lat);
    let best = Infinity;
    for (const e of entries) {
      const scale = 1 << e.zoom;
      const dx = (e.x + 0.5) / scale - cx;
      const dy = (e.y + 0.5) / scale - cy;
      const distSq = dx * dx + dy * dy;
      if (distSq < best) best = distSq;
    }
    return Number.isFinite(best) ? best : null;
  }

  /**
   * Dispatch a set of coalesced range-group fetches with bounded concurrency,
   * the unit of work both {@link getTiles} and {@link fetchAndMergePages} hand
   * off (multi-source coordination, Phase 2 — integration; see
   * docs/roadmap/playback-and-loading.md §5).
   *
   * Each group is `scheduler.schedule(...)`'d on the process-shared
   * {@link getSharedScheduler} under THIS archive's `sourceId` (its url) +
   * `schedulerWeight`, with a cross-source EDF `getPriority`
   * ({@link groupSchedulerPriority}). The global budget is shared across all
   * archives; a single archive still draws the whole budget (DRR is
   * work-conserving) so there is no single-source regression.
   *
   * Supersession: the caller's `options.signal` (the tileset's per-batch
   * AbortController) is honored — the caller-abort fires the scheduled request's `abort()` — cancelling it whether
   * queued (dropped, frees nothing) or running (its scheduler signal fires) —
   * and that scheduler signal is the one passed into `executeGroup`, so retry /
   * timeout / raceAbort inside it stop promptly. Retry happens INSIDE
   * `executeGroup` (one slot per logical group across all its retries); the slot
   * frees on terminal success OR failure via the scheduler's done() handshake.
   *
   * `executeGroup` must NEVER reject for a non-abort reason: each call site
   * already swallows per-group failures into per-tile `null`s, so a rejection
   * here is only ever an abort (which the scheduler treats as a settled slot).
   *
   * `groupProbeMeta` (optional, P0-2) labels each group on the `requests` probe
   * channel. It is consulted ONLY when `globalThis.__sttProbe` is installed —
   * with the probe off it is never called and nothing here allocates.
   *
   * `groupCostBytes` (optional, M6 / BH-1) prices each group in the scheduler's
   * DRR currency. UNLIKE `groupProbeMeta` it is a DECISION input and is always
   * consulted: a coalesced range's size is known exactly at enqueue
   * (`end - start + 1`), so byte-metered fair share needs no estimate. Omitted
   * (or returning `null`) ⇒ the group bills one quantum, i.e. the pre-BH-1 slot
   * behaviour.
   *
   * `executeGroup` receives the group's dispatch-time scheduler priority
   * (M6 / BH-5) so the DECODE stage can inherit what the network stage already
   * decided instead of re-randomizing it into a FIFO.
   */
  private async runGroupFetches<G>(
    groups: G[],
    executeGroup: (
      group: G,
      signal: AbortSignal | undefined,
      priority: number,
    ) => Promise<void>,
    groupMinDistanceMs: (group: G) => number | null,
    groupSpatialDistSq: (group: G) => number | null,
    options: TileRequestOptions | undefined,
    groupProbeMeta?: (group: G) => { key: string; bytes: number },
    groupCostBytes?: (group: G) => number | null,
  ): Promise<void> {
    if (groups.length === 0) return;

    const scheduler = getSharedScheduler();
    const callerSignal = options?.signal;
    // OBSERVATION ONLY: resolved once per dispatch pass, not per group.
    const probeOn = groupProbeMeta !== undefined && isProbeEnabled();
    const fetchPriority = options?.fetchPriority;

    // Each group is scheduled independently; we must observe EVERY group's
    // settlement (success or rejection) so a caller-abort — which rejects all of
    // them, possibly at different times — never leaves an unhandled rejection
    // when Promise.all settles on the first one. We therefore record the first
    // non-abort error ourselves and surface a single AbortError on caller abort.
    let firstError: unknown;
    let aborted = false;
    const removers: Array<() => void> = [];

    // RANK THE GROUPS BEFORE DISPATCHING THEM. Above `perArchiveCap` the runner
    // loop below schedules in pull order and waits for each group to settle, so
    // only a sliding window of `perArchiveCap` groups is ever queued at once —
    // and the scheduler can only rank what is queued. That truncates the
    // cross-source EDF term ITSELF (not just the spatial tie-break) to pack/byte
    // order: the tile the play-head reaches next waits behind every group that
    // happens to sit earlier in the pack. Byte adjacency is exploited INSIDE a
    // group — that is what coalescing is — so the ORDER of the groups carries no
    // coalescing benefit and ranking them costs nothing.
    //
    // The sort is stable and `fallbackSeq` stays each group's ORIGINAL index, so
    // when no play-head is threaded in (priority === seq, e.g. every directory
    // page fetch) the order is byte order exactly as before.
    const ranked = groups.map((group, seq) => {
      const minDist = groupMinDistanceMs(group);
      const spatialDistSq = groupSpatialDistSq(group);
      return {
        group,
        seq,
        minDist,
        spatialDistSq,
        priority: this.groupSchedulerPriority(
          minDist,
          seq,
          fetchPriority,
          spatialDistSq,
        ),
      };
    });
    ranked.sort((a, b) => a.priority - b.priority);

    // Schedule ONE group on the shared scheduler and return a promise for its
    // settlement (already error-observed so it never surfaces as an unhandled
    // rejection). Caller supersession → scheduled-request abort, detached when
    // the request settles so neither outlives the other.
    const scheduleOne = (r: (typeof ranked)[number]): Promise<void> => {
      const { group, seq: fallbackSeq, minDist, spatialDistSq } = r;
      const meta = probeOn ? groupProbeMeta!(group) : undefined;
      // BH-1: the coalesced range's exact size, known at enqueue. `null` /
      // omitted ⇒ the scheduler bills one quantum (pre-BH-1 slot behaviour).
      const costBytes = groupCostBytes?.(group) ?? undefined;
      const priorityOf = (): number =>
        this.groupSchedulerPriority(
          minDist,
          fallbackSeq,
          fetchPriority,
          spatialDistSq,
        );
      const req = scheduler.scheduleRequest<void>({
        sourceId: this.url,
        weight: this.schedulerWeight,
        key: meta?.key,
        bytes: meta?.bytes,
        costBytes,
        getPriority: priorityOf,
        // The scheduler's signal fires on cancel/abort; pass it to the fetch
        // so retry/timeout/raceAbort inside executeGroup stop promptly.
        // BH-5: the same priority expression the scheduler just selected on is
        // handed to the group so its decodes inherit it.
        execute: (schedulerSignal) =>
          executeGroup(group, schedulerSignal, priorityOf()),
      });
      // Wire caller supersession → scheduled-request abort. One-shot; detached
      // when the request settles so neither outlives the other (idempotent
      // abort, slot freed exactly once via the scheduler's done() handshake).
      if (callerSignal) {
        if (callerSignal.aborted) {
          req.abort('Superseded (caller aborted before dispatch)');
        } else {
          const onAbort = (): void => req.abort('Superseded (caller aborted)');
          callerSignal.addEventListener('abort', onAbort, { once: true });
          removers.push(() =>
            callerSignal.removeEventListener('abort', onAbort),
          );
        }
      }
      // Observe every settlement. A scheduler cancellation or a fetch abort is a
      // supersession (record `aborted`); any OTHER rejection is a real error
      // (executeGroup already swallows per-group fetch failures into per-tile
      // nulls, so this is rare — a programming error or an unexpected throw).
      return req.promise.then(
        () => {},
        (err) => {
          if (isCancellationError(err) || isAbortError(err)) {
            aborted = true;
          } else if (firstError === undefined) {
            firstError = err;
          }
        },
      );
    };

    // PER-ARCHIVE CEILING: the shared scheduler's GLOBAL budget bounds the
    // aggregate in-flight across ALL archives, but a consumer that lowers this
    // archive's `maxConcurrentRequests` (e.g. the showcase's 12) wants to
    // throttle THIS dataset's own range concurrency too. So cap how many of THIS
    // archive's groups are concurrently scheduled (queued+running on the shared
    // scheduler) at `min(group count, maxConcurrentRequests)`. When the cap is
    // ≥ the group count (the default 24 ≥ the global budget) every group is
    // scheduled at once and the global budget alone is binding — no regression
    // to the work-conserving "single source draws the whole budget" guarantee.
    const perArchiveCap = Math.max(1, this.maxConcurrentRequests);
    try {
      if (ranked.length <= perArchiveCap) {
        await Promise.all(ranked.map((r) => scheduleOne(r)));
      } else {
        // `perArchiveCap` runners pull from a shared cursor: each schedules one
        // group, awaits its settlement, then pulls the next — so at most
        // `perArchiveCap` of this archive's groups are scheduled at any instant.
        // The cursor walks `ranked`, so the window slides in PRIORITY order.
        let next = 0;
        const runner = async (): Promise<void> => {
          for (;;) {
            // Stop pulling new work once the caller superseded this batch: the
            // already-scheduled groups get aborted via their `onAbort`; the
            // not-yet-scheduled ones simply never enqueue.
            if (callerSignal?.aborted) {
              aborted = true;
              return;
            }
            const i = next++;
            if (i >= ranked.length) return;
            await scheduleOne(ranked[i]);
          }
        };
        await Promise.all(
          Array.from({ length: perArchiveCap }, () => runner()),
        );
      }
    } finally {
      for (const remove of removers) remove();
    }
    // Surface a real error first, then an abort (matching the legacy path, where
    // an in-flight abort rejects the batch with an AbortError).
    if (firstError !== undefined) throw firstError;
    if (aborted)
      throw new DOMException('The operation was aborted.', 'AbortError');
  }

  /**
   * Fetch many tiles, coalescing contiguous byte ranges into single requests.
   * Returns tiles in the same order as `ids`; missing tiles are `null`.
   */
  async getTiles(
    ids: TileId[],
    options?: TileRequestOptions,
  ): Promise<(Tile | null)[]> {
    // BH-8: remember where playback is before anything can store or evict
    // bytes on this call. No-op for callers that declare no play-head.
    this.notePlayhead(options);
    await this.getIndex();
    // Paged archives: ensure the ids' leaf pages are resident so findTileEntry
    // resolves them (usually a no-op — the caller's getTileIdsInBounds already
    // paged them in; this covers callers that pass ids from elsewhere).
    await this.ensurePagesForTiles(ids, options?.signal);
    const results: (Tile | null)[] = new Array(ids.length).fill(null);

    // Incremental delivery: store + announce a decoded tile in one place so
    // every fill path (byte cache, OPFS, coalesced group, per-member
    // fallback) reaches the caller the moment ITS bytes are decoded — not
    // when the slowest range request of the whole batch settles.
    const deliver = (index: number, tile: Tile | null): void => {
      results[index] = tile;
      if (tile) options?.onTileReady?.(index, tile);
    };

    interface Pending {
      index: number;
      id: TileId;
      entry: TileEntry;
    }
    let pending: Pending[] = [];
    const jobs: Promise<void>[] = [];

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const entry = this.findTileEntry(id);
      if (!entry) continue;
      const key = tileKey(id);
      const cached = this.byteCache.get(key);
      if (cached) {
        this.touchCachedBytes(key, cached);
        this.cacheStats.hits++;
        const idx = i;
        const cacheKey = key;
        jobs.push(
          this.decodeBytes(id, entry, cached.bytes, options?.signal).then(
            (t) => {
              deliver(idx, t);
            },
            (err) => {
              // Same per-tile semantics as the network group path: one bad
              // tile must not fail the whole batch. Evict the poisoned
              // entry so the next request re-fetches instead of replaying
              // the same corrupt bytes forever.
              if (isAbortError(err)) throw err;
              this.dropCachedBytes(cacheKey);
              deliver(idx, null);
            },
          ),
        );
      } else {
        this.cacheStats.misses++;
        pending.push({ index: i, id, entry });
      }
    }

    // OPFS lookup phase: every miss against the in-memory cache gets one
    // chance to come from OPFS first. The lookups run concurrently so the
    // batch isn't serialized behind OPFS I/O. A hit on OPFS removes the
    // tile from `pending` so it doesn't get scheduled into a coalesced
    // HTTP range group.
    if (this.opfsCache && pending.length > 0 && this.archiveFingerprint) {
      const opfsResults = await Promise.all(
        pending.map(async (p) => {
          const k = this.opfsKey(p.id);
          if (!k) return null;
          const bytes = await this.opfsCache!.get(k);
          return bytes;
        }),
      );
      const stillPending: Pending[] = [];
      for (let i = 0; i < pending.length; i++) {
        const bytes = opfsResults[i];
        const p = pending[i];
        // A truncated/oversized entry can't be trusted — route it to the
        // network phase, which overwrites the poisoned OPFS entry with fresh
        // bytes (self-heal) instead of blanking the tile.
        if (bytes && this.opfsPayloadValid(p.entry, bytes)) {
          this.opfsStats.hits++;
          jobs.push(
            this.decodeDecompressed(p.id, p.entry, bytes, options?.signal).then(
              (t) => {
                deliver(p.index, t);
              },
              async (err) => {
                if (isAbortError(err)) throw err;
                // Disk-corrupted OPFS payload (right length, wrong bytes):
                // self-heal by refetching from origin, which also overwrites
                // the poisoned entry — otherwise it would blank this tile on
                // every future batch. A refetch that also fails leaves the
                // per-tile `null` contract intact.
                try {
                  const healed = await this.fetchAndDecodeTile(
                    p.id,
                    p.entry,
                    options?.signal,
                    options?.fetchPriority,
                  );
                  deliver(p.index, healed);
                } catch (healErr) {
                  if (isAbortError(healErr)) throw healErr;
                  deliver(p.index, null);
                }
              },
            ),
          );
        } else {
          this.opfsStats.misses++;
          stillPending.push(p);
        }
      }
      pending = stillPending;
    }

    if (pending.length > 0) {
      interface Group {
        packId: number;
        start: number;
        end: number;
        members: Pending[];
      }
      // Coalescing is PER-PACK: a single HTTP range request addresses exactly
      // one pack object, so a range may never bridge two packs — no value of
      // the gap, adaptive or pinned, can bridge an object boundary. Group the
      // pending tiles by pack first, then within each pack sort by offset and
      // coalesce neighbours within the effective gap.
      const byPack = new Map<number, Pending[]>();
      for (const p of pending) {
        let list = byPack.get(p.entry.packId);
        if (!list) {
          list = [];
          byPack.set(p.entry.packId, list);
        }
        list.push(p);
      }
      // One reading for the whole batch (see fetchAndMergePages): every fuse
      // decision in this plan is taken against the same G.
      const coalesceGap = this.effectiveCoalesceGap();
      const groups: Group[] = [];
      for (const [packId, members] of byPack) {
        members.sort((a, b) => a.entry.offset - b.entry.offset);
        let current: Group | undefined;
        for (const p of members) {
          const pStart = p.entry.offset;
          const pEnd = p.entry.offset + p.entry.length - 1;
          if (current && pStart - (current.end + 1) <= coalesceGap) {
            current.end = Math.max(current.end, pEnd);
            current.members.push(p);
          } else {
            current = { packId, start: pStart, end: pEnd, members: [p] };
            groups.push(current);
          }
        }
      }
      // Fire one HTTP range request per coalesced group. Decode all members of
      // a group concurrently (a previous serial decode made `getTiles()` slower
      // than per-tile `getTile()` calls). After coalescing a viewport×window
      // usually collapses to a few groups; the concurrency pool below bounds
      // in-flight requests across the groups of ALL packs so a pathological
      // sparse batch can't exceed an object store's per-connection stream cap.
      //
      // WS-E hardening: the group fetch retries transient failures with
      // backoff (see fetchRangeWithRetry); if the WHOLE coalesced range still
      // fails, fall back to fetching its member tiles individually (single
      // attempt each) so one bad range can't drop an entire batch — only the
      // tiles that still fail stay `null` in the results. Every completed
      // range response also feeds the throughput estimator, at busy-window
      // granularity (see beginTransferSample / endTransferSample) so the
      // concurrent pool can't make each request look like 1/Nth of the link.
      // `signal` is the per-group signal: the caller's `options.signal` on the
      // legacy path, or the scheduler-provided signal on the shared-scheduler
      // path (so retry / timeout / raceAbort inside stop the moment the
      // scheduled request is cancelled — see runGroupFetches).
      const fetchGroup = async (
        group: Group,
        signal: AbortSignal | undefined,
        // BH-5: the scheduler priority this group won its slot with, forwarded
        // into every member decode so the decode pool orders by the same scale
        // the network stage used instead of by arrival.
        priority: number,
      ): Promise<void> => {
        let buffer: ArrayBuffer;
        this.beginTransferSample();
        try {
          buffer = await this.fetchRangeWithRetry(
            group.packId,
            group.start,
            group.end,
            signal,
            options?.fetchPriority,
          );
          this.endTransferSample(buffer.byteLength);
        } catch (error) {
          this.endTransferSample(0);
          if (isAbortError(error)) throw error;
          // Coalesced range failed after retries → per-member fallback.
          await Promise.all(
            group.members.map(async (m) => {
              let single: ArrayBuffer;
              this.beginTransferSample();
              try {
                single = await this.fetchRange(
                  m.entry.packId,
                  m.entry.offset,
                  m.entry.offset + m.entry.length - 1,
                  signal,
                  options?.fetchPriority,
                );
                this.endTransferSample(single.byteLength);
              } catch (memberError) {
                this.endTransferSample(0);
                if (isAbortError(memberError)) throw memberError;
                // Tile-level failure: leave `null`. Callers that know the
                // tile exists in the directory surface this per-tile (the
                // tileset reports it through `onTileError`).
                return;
              }
              try {
                this.storeBytes(tileKey(m.id), single, m.entry.timeStart);
                deliver(
                  m.index,
                  await this.decodeBytes(
                    m.id,
                    m.entry,
                    single,
                    signal,
                    true,
                    priority,
                  ),
                );
              } catch (decodeError) {
                if (isAbortError(decodeError)) throw decodeError;
                // Decode failure: same per-tile `null` semantics as a fetch
                // failure (the bytes arrived but the payload is unusable).
                // Evict what we just cached — a poisoned entry would reject
                // every later batch from the cache-hit path.
                this.dropCachedBytes(tileKey(m.id));
              }
            }),
          );
          return;
        }
        await Promise.all(
          group.members.map(async (m) => {
            const rel = m.entry.offset - group.start;
            const slice = buffer.slice(rel, rel + m.entry.length);
            this.storeBytes(tileKey(m.id), slice, m.entry.timeStart);
            try {
              deliver(
                m.index,
                await this.decodeBytes(
                  m.id,
                  m.entry,
                  slice,
                  signal,
                  true,
                  priority,
                ),
              );
            } catch (decodeError) {
              if (isAbortError(decodeError)) throw decodeError;
              // Decode failure (e.g. a crc32c mismatch on one corrupt blob):
              // per-tile `null`, same as the per-member fallback path — one
              // bad tile must not fail its whole coalesced group. Evict what
              // we just cached so the poison can't replay from cache hits.
              this.dropCachedBytes(tileKey(m.id));
            }
          }),
        );
      };

      // Dispatch the coalesced groups through the process-shared scheduler (one
      // slot per group, cross-source EDF + weighted-fair share). See
      // runGroupFetches. The EDF distance term uses each group's members' tile
      // timeStarts vs the threaded play-head.
      jobs.push(
        this.runGroupFetches(
          groups,
          (group, signal, priority) => fetchGroup(group, signal, priority),
          (group) =>
            this.minDistanceToPlayhead(
              group.members.map((m) => m.entry),
              options,
            ),
          (group) =>
            this.minDistanceToViewportCenter(
              group.members.map((m) => m.entry),
              options,
            ),
          options,
          // Probe label: a coalesced range covers N tiles in ONE request, so
          // the sample is keyed by the group's LEAD tile and carries the whole
          // range's bytes. (The tileKey string format is an OPFS persistence
          // contract — read here, never reshaped.)
          (group) => ({
            key: tileKey(group.members[0].id),
            bytes: group.end - group.start + 1,
          }),
          // BH-1 cost: the coalesced range's EXACT size — this is the number
          // the wire will actually carry, known here without any estimate.
          (group) => group.end - group.start + 1,
        ),
      );
    }

    await Promise.all(jobs);
    return results;
  }

  /**
   * Declare the playback LOOP window in sim-time (BH-7/BH-8); `null` clears
   * it. The `SpatioTemporalTileset` holds the same value for its own tier
   * eviction and forwards it here (via the optional `setLoopWindow` on its
   * loader) so the compressed-byte cache below it rotates on the same metric.
   *
   * Storage only: no fetch, no eviction pass, no decode is triggered by this
   * call. A degenerate range (non-finite, or `end <= start`) is treated as
   * `null`, and with no range declared eviction is byte-identical to its
   * pre-BH-8 behavior — which is both the kill switch and the regression pin.
   */
  setLoopWindow(range: { start: number; end: number } | null): void {
    if (
      !range ||
      !Number.isFinite(range.start) ||
      !Number.isFinite(range.end) ||
      range.end <= range.start
    ) {
      this.loopWindow = null;
      return;
    }
    this.loopWindow = { start: range.start, end: range.end };
  }

  /**
   * Record the play-head a batch request declared (BH-8). Cached rather than
   * passed down because eviction is triggered from write paths that have no
   * access to the originating options — and because the process-shared LRU
   * scores entries long after the call that stored them returned.
   */
  private notePlayhead(options: TileRequestOptions | undefined): void {
    const t = options?.playheadTime;
    if (typeof t !== 'number' || !Number.isFinite(t)) return;
    this.lastPlayhead = {
      time: t,
      direction: options?.playheadDirection === -1 ? -1 : 1,
    };
  }

  /**
   * {@link byteCacheEvictionScore} bound to this archive's LIVE playhead,
   * loop window and temporal bucket. Deliberately a method (not a captured
   * closure): the shared-LRU score callbacks call through it, so they read
   * current state and never pin a stale playhead.
   */
  private evictionScore(timeStart: number): number {
    return byteCacheEvictionScore(
      timeStart,
      this.baseTemporalBucketMs,
      this.lastPlayhead,
      this.loopWindow,
    );
  }

  private storeBytes(
    key: TileKey,
    bytes: ArrayBuffer,
    timeStart: number,
  ): void {
    if (this.maxCacheTiles === 0 || this.maxCacheBytes === 0) return;
    const existing = this.byteCache.get(key);
    if (existing) {
      this.currentCacheBytes -= existing.byteSize;
      this.byteCache.delete(key);
      unregisterSharedCacheEntry(this.sharedCacheToken(key));
    }
    this.byteCache.set(key, {
      bytes,
      lastAccess: Date.now(),
      byteSize: bytes.byteLength,
      timeStart,
    });
    this.currentCacheBytes += bytes.byteLength;
    registerSharedCacheEntry(this.sharedCacheToken(key), {
      byteSize: bytes.byteLength,
      evict: () => {
        if (!this.byteCache.has(key)) return;
        this.dropCachedBytes(key);
        this.cacheStats.evictions++;
      },
      // Closes over the tile's OWN timeline position (immutable for this key)
      // and reads the archive's playhead live — never over cache state that
      // an eviction could invalidate underneath it.
      score: () => this.evictionScore(timeStart),
    });
    this.evictIfNeeded();
  }

  private sharedCacheToken(key: TileKey): string {
    return `${this.cacheOwnerId}:${key}`;
  }

  /** Refresh insertion order in both the local and process-wide LRUs. */
  private touchCachedBytes(key: TileKey, entry: ByteCacheEntry): void {
    entry.lastAccess = Date.now();
    this.byteCache.delete(key);
    this.byteCache.set(key, entry);
    touchSharedCacheEntry(this.sharedCacheToken(key));
  }

  /**
   * Evict one cached compressed payload (poisoned-entry recovery). Bytes are
   * cached BEFORE decode/CRC verification, so a corrupt blob would otherwise
   * sit in the cache rejecting every future decode of that tile — dropping
   * it lets the next request re-fetch and self-heal after transient
   * corruption.
   */
  private dropCachedBytes(key: TileKey): void {
    const existing = this.byteCache.get(key);
    if (!existing) return;
    this.byteCache.delete(key);
    this.currentCacheBytes -= existing.byteSize;
    unregisterSharedCacheEntry(this.sharedCacheToken(key));
  }

  private clearByteCache(): void {
    for (const key of this.byteCache.keys()) {
      unregisterSharedCacheEntry(this.sharedCacheToken(key));
    }
    this.byteCache.clear();
    this.currentCacheBytes = 0;
  }

  /**
   * Enforce the per-archive count and byte caps.
   *
   * BH-8: the victim is no longer unconditionally the oldest entry but the
   * one furthest (in loop-aware, direction-aware sim-time) from the play-head
   * among the {@link EVICT_SCAN_LIMIT} oldest — see
   * {@link byteCacheEvictionScore}. The caps themselves, the poisoned-entry
   * drop path and the device-derived constants are untouched, and with no
   * play-head ever threaded in every candidate scores 0, so the eviction
   * order is byte-identical to the pre-BH-8 LRU.
   */
  private evictIfNeeded(): void {
    if (
      this.byteCache.size <= this.maxCacheTiles &&
      this.currentCacheBytes <= this.maxCacheBytes
    ) {
      return;
    }
    while (
      this.byteCache.size > this.maxCacheTiles ||
      this.currentCacheBytes > this.maxCacheBytes
    ) {
      const victim = selectLruVictim(this.byteCache, (_key, entry) =>
        this.evictionScore(entry.timeStart),
      );
      if (!victim) break;
      this.dropCachedBytes(victim[0]);
      this.cacheStats.evictions++;
    }
  }

  /**
   * Report — once per zoom, so a stuck camera can't spam the console — that a
   * bounds grid blew past {@link MAX_QUERY_SCAN_CELLS}. The query switches to
   * the occupied-cell index and still returns every matching tile; this is a
   * producer/camera diagnostic, not a correctness warning.
   *
   * This is deliberately loud and deliberately specific. A scan this size has
   * exactly three causes, and the numbers below separate them: a degenerate
   * viewport box (inverted by bearing or above-horizon pitch), a camera zoom
   * clamped up into a regional archive's `[minZoom, maxZoom]`, or a declared
   * extent that doesn't match the tiles. The 21-agent audit that produced
   * docs/roadmap/tile-loading-3d-2026-07.md found all three shipping at once,
   * silently — this one line would have surfaced every one of them.
   */
  private warnOversizedScan(
    zoom: number,
    cells: number,
    cap: number,
    strategy: 'occupied-index' | 'dense-grid',
  ): void {
    if (this.warnedOversizedScans.has(zoom)) return;
    this.warnedOversizedScans.add(zoom);
    const selection =
      strategy === 'occupied-index'
        ? 'Querying the occupied-cell index instead'
        : 'The grid is densely occupied, so scanning it directly without materializing coordinate tuples';
    console.warn(
      `[stt] ${this.url}: tile grid at z${zoom} covers ${cells} cells ` +
        `(expected under ${cap}). ${selection}; ` +
        `no tiles are dropped. Check for an inverted/degenerate viewport box, ` +
        `or a camera zoom clamped up into this archive's [minZoom, maxZoom].`,
    );
  }

  /**
   * Temporal-entry lists for occupied cells inside a viewport.
   *
   * Ordinary viewports retain the direct grid walk: a few dozen `Map.get`
   * calls are cheaper than filtering the archive index. Once the theoretical
   * grid exceeds {@link MAX_QUERY_SCAN_CELLS}, walk only occupied cells at the
   * requested zoom. The result is sorted by wrapped x scan position then y,
   * exactly matching {@link boundsToTiles}; callers therefore keep stable
   * request ordering without allocating up to `2^zoom × 2^zoom` coordinate
   * tuples. Completeness is unchanged: paged archives call
   * {@link ensurePagesForBounds} before this method, so every overlapping leaf
   * is already represented in the resident occupied-cell index.
   */
  private entryListsInBounds(bounds: BoundingBox, zoom: number): TileEntry[][] {
    const window = tileScanWindow(bounds, zoom);
    const occupied = this.occupiedCellListsByZoom.get(zoom);
    const useDirectGrid =
      window.cells <= MAX_QUERY_SCAN_CELLS ||
      (occupied !== undefined && occupied.length * 2 >= window.cells);

    // Direct lookup wins for ordinary viewports and genuinely dense grids.
    // Iterate in-place instead of first allocating `[x, y][]`; even the dense
    // oversized fallback therefore pays for results/map probes, not a second
    // million-element coordinate object graph.
    if (useDirectGrid) {
      if (window.cells > MAX_QUERY_SCAN_CELLS) {
        this.warnOversizedScan(
          zoom,
          window.cells,
          MAX_QUERY_SCAN_CELLS,
          'dense-grid',
        );
      }
      const lists: TileEntry[][] = [];
      for (let i = 0; i < window.xCount; i++) {
        const x =
          (((window.startX + i) % window.worldSize) + window.worldSize) %
          window.worldSize;
        for (let y = window.minY; y <= window.maxY; y++) {
          const entries = this.tileEntryIndex.get(tileCellKey(zoom, x, y));
          if (entries) lists.push(entries);
        }
      }
      return lists;
    }

    this.warnOversizedScan(
      zoom,
      window.cells,
      MAX_QUERY_SCAN_CELLS,
      'occupied-index',
    );
    if (!occupied || occupied.length === 0) return [];

    const selected: Array<{
      entries: TileEntry[];
      relativeX: number;
      y: number;
    }> = [];
    for (const entries of occupied) {
      const cell = entries[0];
      if (!cell || cell.y < window.minY || cell.y > window.maxY) continue;
      const relativeX =
        (((cell.x - window.startX) % window.worldSize) + window.worldSize) %
        window.worldSize;
      if (relativeX >= window.xCount) continue;
      selected.push({ entries, relativeX, y: cell.y });
    }
    selected.sort((a, b) => a.relativeX - b.relativeX || a.y - b.y);
    return selected.map((cell) => cell.entries);
  }

  /**
   * Tile IDs whose interval overlaps `timeRange` within `bounds` at `zoom`.
   *
   * For archives that ship a temporal LOD pyramid, this returns ONLY the
   * base-bucket tiles — i.e. tiles whose `temporalBucketMs` matches the
   * archive's base bucket (or is unset, for legacy archives). Use
   * {@link getTileIdsInBoundsForTemporalLod} to request a coarser LOD
   * level's tiles.
   *
   * `bounds` is honoured AS GIVEN — deliberately not narrowed to the archive's
   * declared extent, which does not bound the data (see the note above
   * `lonToTileX`). An oversized grid warns via
   * {@link MAX_QUERY_SCAN_CELLS}, switches to the occupied-cell index, and
   * still returns every matching tile.
   */
  async getTileIdsInBounds(
    bounds: BoundingBox,
    zoom: number,
    timeRange: TimeRange,
  ): Promise<TileId[]> {
    await this.getIndex();
    // The query box is used AS GIVEN. It is deliberately NOT narrowed to
    // `meta.bounds` — see the note on `MAX_QUERY_SCAN_CELLS` for why that
    // intersection is unsound.
    const meta = await this.getMetadata();
    const clipped = bounds;
    await this.ensurePagesForBounds(clipped, zoom, timeRange);
    const baseBucket = meta.temporalBucketMs;
    const filterToBase =
      meta.temporalLod !== undefined && meta.temporalLod.length > 0;
    const ids: TileId[] = [];
    for (const entries of this.entryListsInBounds(clipped, zoom)) {
      for (const e of entries) {
        if (e.variantId !== 0) continue;
        if (filterToBase) {
          // The archive carries LOD tiers; exclude anything that isn't a
          // base-bucket tile so the existing renderer behaviour is
          // preserved (only base tiles flow into the default path).
          const tagged = e.temporalBucketMs;
          if (tagged !== undefined && tagged !== baseBucket) continue;
        }
        // Window overlap. Upper bound uses the tight `timeEnd`; lower bound uses
        // the tight covering `coverTMin` when present (falling back to the
        // bucket-edge `timeStart`), so a tile whose data is entirely AFTER the
        // window is skipped without a fetch. The pushed TileId still addresses
        // by `timeStart` (the bucket boundary) — covering tightens the *filter*,
        // not the *address*.
        if (
          e.timeEnd >= timeRange.start &&
          (e.coverTMin ?? e.timeStart) <= timeRange.end
        ) {
          ids.push({
            z: e.zoom,
            x: e.x,
            y: e.y,
            t: e.timeStart,
            variantId: 0,
          });
        }
      }
    }
    return ids;
  }

  /**
   * Tile IDs for a specific temporal LOD level.
   *
   * `bucketMs` selects which tier of the temporal pyramid to read; pass the
   * value from {@link ArchiveMetadata.temporalLod} (or its
   * `bucketMs` field) — or the archive's base `temporalBucketMs` to get the
   * base tier explicitly.
   *
   * Returns an empty array if the archive has no tiles tagged with that
   * bucket size (i.e. the level was not built into this archive).
   */
  async getTileIdsInBoundsForTemporalLod(
    bounds: BoundingBox,
    zoom: number,
    timeRange: TimeRange,
    bucketMs: number,
  ): Promise<TileId[]> {
    await this.getIndex();
    // Box used as given, same as getTileIdsInBounds — see there.
    const meta = await this.getMetadata();
    const clipped = bounds;
    await this.ensurePagesForBounds(clipped, zoom, timeRange);
    const baseBucket = meta.temporalBucketMs;
    const ids: TileId[] = [];
    for (const entries of this.entryListsInBounds(clipped, zoom)) {
      for (const e of entries) {
        if (e.variantId !== 0) continue;
        // The tile matches iff its tagged bucket equals the requested one.
        // Legacy tiles (column absent) are treated as base-bucket tiles —
        // they only match a request for `bucketMs === baseBucket`.
        const tagged = e.temporalBucketMs ?? baseBucket;
        if (tagged !== bucketMs) continue;
        // Window overlap. Upper bound uses the tight `timeEnd`; lower bound uses
        // the tight covering `coverTMin` when present (falling back to the
        // bucket-edge `timeStart`), so a tile whose data is entirely AFTER the
        // window is skipped without a fetch. The pushed TileId still addresses
        // by `timeStart` (the bucket boundary) — covering tightens the *filter*,
        // not the *address*. `bucketMs` stamps the id with its tier so every
        // downstream key (directory lookup, byte/OPFS caches, tileset
        // registries) stays distinct from the base tile sharing its z/x/y/t.
        if (
          e.timeEnd >= timeRange.start &&
          (e.coverTMin ?? e.timeStart) <= timeRange.end
        ) {
          ids.push({
            z: e.zoom,
            x: e.x,
            y: e.y,
            t: e.timeStart,
            variantId: 0,
            bucketMs,
          });
        }
      }
    }
    return ids;
  }

  /**
   * Tile IDs whose interval overlaps `timeRange`, addressed by an explicit
   * **cell list** rather than by a box at one zoom — the directory half of the
   * frustum-quadtree selection path (FS-2).
   *
   * The incumbent selection enumerates `[minZoom..z]` boxes, one zoom at a
   * time, because a camera was only ever reduced to ONE integer zoom. A frustum
   * cut is a mixed-zoom antichain: near-field cells deep, far-field cells
   * shallow. There is no box-and-zoom pair that describes it, so this walks
   * exactly the named cells — the same cell-addressed directory probe
   * {@link findTileEntry} and the occupied-cell scan already use.
   *
   * The three tier dispatches are the ones that already exist, selected by
   * `opts` on the {@link estimateSelectionCost} pattern so nothing about the
   * incumbent trio moves:
   *
   *   - default (`{}`) → {@link getTileIdsInBounds}'s filter: variant 0, and
   *     base-bucket tiles only when the archive declares a pyramid.
   *   - `{ bucketMs }` → {@link getTileIdsInBoundsForTemporalLod}'s: the tier
   *     whose tagged bucket equals `bucketMs` (untagged legacy entries are the
   *     base tier), with `bucketMs` stamped onto every returned id.
   *   - `{ tier: 'summary' }` → {@link getSummaryTileIdsInBounds}'s: the
   *     declared summary variant, with its zoom gate applied PER CELL. Per
   *     cell, not per query, because under a cut some cells are inside the
   *     summary range and some are not; the gate drops only the cells it
   *     applies to, and an archive with no summary tier returns `[]` exactly as
   *     the bounds form does.
   *
   * Cells are read as SPATIAL addresses: `t` is ignored (the time filter is
   * `timeRange`), `x` must already be wrapped into `[0, 2^z)` — which is what
   * `coverFrustumQuadtree` emits — and any cell that is not a finite in-range
   * address is skipped rather than trusted. Duplicate cells collapse, so no id
   * can be returned twice.
   *
   * Output order is the input cell order, then each cell's directory-entry
   * order: deterministic, and stable under repeated calls.
   */
  async getAvailableTilesForCells(
    cells: readonly TileId[],
    timeRange: TimeRange,
    opts?: { tier?: 'raw' | 'summary'; bucketMs?: number },
  ): Promise<TileId[]> {
    if (!cells || cells.length === 0) return [];
    await this.getIndex();
    const meta = await this.getMetadata();

    const wantSummary = opts?.tier === 'summary';
    const summary = wantSummary ? meta.summaryTier : undefined;
    // No summary tier ⇒ nothing to address, same as getSummaryTileIdsInBounds.
    if (wantSummary && !summary) return [];
    const variantId = summary?.variantId ?? 0;
    const wantBucketMs = opts?.bucketMs;
    const baseBucket = meta.temporalBucketMs;
    // Only the DEFAULT base-tier selection filters LOD tiles out, and only when
    // the archive declares a pyramid — exactly getTileIdsInBounds's rule.
    const filterToBase =
      wantBucketMs === undefined &&
      variantId === 0 &&
      meta.temporalLod !== undefined &&
      meta.temporalLod.length > 0;

    // Normalize + de-duplicate first: the paging pass and the entry walk must
    // agree cell for cell, and a malformed address must be dropped by both.
    const cellKeys = new Set<string>();
    const wanted: TileId[] = [];
    for (const cell of cells) {
      if (!cell) continue;
      const z = cell.z;
      if (!Number.isInteger(z) || z < 0 || z > 30) continue;
      const world = 2 ** z;
      const x = cell.x;
      const y = cell.y;
      if (!Number.isInteger(x) || x < 0 || x >= world) continue;
      if (!Number.isInteger(y) || y < 0 || y >= world) continue;
      // The summary zoom gate, per cell (see the doc comment).
      if (summary && (z < summary.minZoom || z > summary.maxZoom)) continue;
      const key = `${z}/${x}/${y}`;
      if (cellKeys.has(key)) continue;
      cellKeys.add(key);
      wanted.push({ z, x, y, t: 0 });
    }
    if (wanted.length === 0) return [];

    await this.ensurePagesForCells(wanted, timeRange);

    const ids: TileId[] = [];
    for (const cell of wanted) {
      const entries = this.tileEntryIndex.get(
        tileCellKey(cell.z, cell.x, cell.y),
      );
      if (!entries) continue;
      for (const e of entries) {
        if (e.variantId !== variantId) continue;
        if (wantBucketMs !== undefined) {
          if ((e.temporalBucketMs ?? baseBucket) !== wantBucketMs) continue;
        } else if (filterToBase) {
          const tagged = e.temporalBucketMs;
          if (tagged !== undefined && tagged !== baseBucket) continue;
        }
        // Window overlap, byte-identical to the bounds queries': tight
        // `timeEnd` above, tight covering `coverTMin` (falling back to the
        // bucket-edge `timeStart`) below.
        if (
          e.timeEnd >= timeRange.start &&
          (e.coverTMin ?? e.timeStart) <= timeRange.end
        ) {
          ids.push(
            wantBucketMs === undefined
              ? { z: e.zoom, x: e.x, y: e.y, t: e.timeStart, variantId }
              : {
                  z: e.zoom,
                  x: e.x,
                  y: e.y,
                  t: e.timeStart,
                  variantId,
                  bucketMs: wantBucketMs,
                },
          );
        }
      }
    }
    return ids;
  }

  /** All tiles within a bounding box and time range. */
  async getTilesInBounds(
    bounds: BoundingBox,
    zoom: number,
    timeRange: TimeRange,
    options?: TileRequestOptions,
  ): Promise<Tile[]> {
    const ids = await this.getTileIdsInBounds(bounds, zoom, timeRange);
    const tiles = await this.getTiles(ids, options);
    return tiles.filter((t): t is Tile => t !== null);
  }

  /**
   * Tile IDs whose interval overlaps `timeRange` within `bounds` at `zoom`,
   * filtered to the SUMMARY tier when the archive carries one and the
   * requested zoom is inside the summary range.
   *
   * The directory keys are identical to the raw tier (a summary tile shares
   * its (zoom, x, y, t) coordinates with the raw tile that covers the same
   * area at the same zoom). The TS reader distinguishes them only by the
   * layer name carried in the decoded tile payload — so this helper is
   * essentially a convenience wrapper that:
   *
   *   1. Returns an empty list if the archive has no summary tier.
   *   2. Returns an empty list if `zoom` is outside the summary range.
   *   3. Otherwise delegates to `getTileIdsInBounds`.
   *
   * Callers fetch the tiles with the standard `getTiles()` and then keep
   * only the `summary`-named layer (see `isSummaryTile`).
   */
  async getSummaryTileIdsInBounds(
    bounds: BoundingBox,
    zoom: number,
    timeRange: TimeRange,
  ): Promise<TileId[]> {
    const metadata = await this.getMetadata();
    const tier = metadata.summaryTier;
    if (!tier) return [];
    if (zoom < tier.minZoom || zoom > tier.maxZoom) return [];
    await this.getIndex();
    await this.ensurePagesForBounds(bounds, zoom, timeRange);
    const ids: TileId[] = [];
    for (const entries of this.entryListsInBounds(bounds, zoom)) {
      for (const entry of entries) {
        if (entry.variantId !== tier.variantId) continue;
        if (
          entry.timeEnd >= timeRange.start &&
          (entry.coverTMin ?? entry.timeStart) <= timeRange.end
        ) {
          ids.push({
            z: entry.zoom,
            x: entry.x,
            y: entry.y,
            t: entry.timeStart,
            variantId: tier.variantId,
          });
        }
      }
    }
    return ids;
  }

  /**
   * All summary-tier tiles within a bounding box and time range. Returns
   * `[]` if the archive has no summary tier or the zoom is outside the
   * summary range.
   */
  async getSummaryTilesInBounds(
    bounds: BoundingBox,
    zoom: number,
    timeRange: TimeRange,
    options?: TileRequestOptions,
  ): Promise<Tile[]> {
    const ids = await this.getSummaryTileIdsInBounds(bounds, zoom, timeRange);
    if (ids.length === 0) return [];
    const tiles = await this.getTiles(ids, options);
    const metadata = await this.getMetadata();
    const layerName = metadata.summaryTier?.layerName ?? 'summary';
    // Drop tiles that don't actually carry a summary layer. The raw and
    // summary tiers share spatial coordinates but raw tiles are NOT
    // expected at the summary zooms when the build wrote both tiers —
    // however we still defend against tiles that mix layers.
    const out: Tile[] = [];
    for (const t of tiles) {
      if (!t) continue;
      const summaryLayers = t.layers.filter((l) => l.name === layerName);
      if (summaryLayers.length === 0) continue;
      out.push({ ...t, layers: summaryLayers });
    }
    return out;
  }

  /**
   * Fetch tiles from a specific temporal LOD level.
   *
   * Convenience wrapper over {@link getTileIdsInBoundsForTemporalLod}.
   */
  async getTilesInBoundsForTemporalLod(
    bounds: BoundingBox,
    zoom: number,
    timeRange: TimeRange,
    bucketMs: number,
    options?: TileRequestOptions,
  ): Promise<Tile[]> {
    const ids = await this.getTileIdsInBoundsForTemporalLod(
      bounds,
      zoom,
      timeRange,
      bucketMs,
    );
    const tiles = await this.getTiles(ids, options);
    return tiles.filter((t): t is Tile => t !== null);
  }

  /**
   * Pick the LOD level (`bucketMs`) the reader should request at `zoom`.
   *
   * Returns the coarsest level whose `maxZoomLevel >= zoom`. If no level
   * applies, returns `undefined` — the caller should fall back to base
   * tiles via {@link getTileIdsInBounds}.
   */
  async pickTemporalLodForZoom(
    zoom: number,
  ): Promise<TemporalLodLevel | undefined> {
    const meta = await this.getMetadata();
    const levels = meta.temporalLod;
    if (!levels || levels.length === 0) return undefined;
    let pick: TemporalLodLevel | undefined;
    for (const l of levels) {
      if (zoom <= l.maxZoomLevel) {
        if (!pick || l.bucketMs > pick.bucketMs) pick = l;
      }
    }
    return pick;
  }

  /**
   * Pick the temporal tier by COST rather than by zoom (CO-5) — the 1-D argmin
   * that sits BESIDE {@link pickTemporalLodForZoom}, never replacing it.
   *
   * Enumerates the addressable set `{base} ∪ {levels with zoom ≤
   * maxZoomLevel}` ({@link addressableTemporalTiers}), prices each tier with
   * CO-1's {@link estimateSelectionCost}, and minimizes
   *
   * ```text
   *   cost(b) = bytes(b) + tiles(b) × requestOverheadBytes
   * ```
   *
   * where `requestOverheadBytes` is {@link getRequestPriceBytes} — the
   * MEASURED `L̂ × θ̂`, read from the same two estimators CO-7's fuse rule is
   * fitted from. It is not {@link effectiveCoalesceGap}: that method's job is
   * to keep an un-measured session fusing exactly as it always did, so it
   * answers 2 MiB when cold, when pinned, and whenever the ordering gate
   * holds — and 2 MiB per request would swamp the byte term and turn this
   * argmin into a ranking by tile count.
   *
   * Returns:
   *  - `undefined` when the archive declares no temporal-LOD pyramid — there
   *    is nothing to choose and nothing changes for such archives, which is
   *    every archive in the fleet built without `--temporal-lod`;
   *  - otherwise a {@link TemporalTierPick} whose `bucketMs` may be the base
   *    bucket (⇒ address the base tier via {@link getTileIdsInBounds}).
   *
   * FALLBACK, and it is not optional. Three ways the comparison is declined,
   * each reported in `abstainReason` and each answering from
   * {@link pickTemporalLodForZoom} — byte-for-byte the incumbent — flagged
   * `policy: 'zoom-threshold'`, `exact: false`:
   *  - `unpriced-tiles`: an addressable tier reports `unknownTiles > 0` (a
   *    non-resident leaf page of a paged directory, or a directory that is not
   *    open), so the comparison would be between lower bounds;
   *  - `unmeasured-request-price`: `L̂` or `θ̂` is still cold, so the request
   *    term has no value. A cold link is abstained from, never assigned the
   *    2 MiB constant;
   *  - `no-eligible-tier`: no addressable tier holds anything here, so there
   *    is nothing to choose between.
   *
   * The oracle never invents a byte count and never invents a request price.
   *
   * Resolves the directory root ({@link getIndex}) but deliberately does NOT
   * fault leaf pages in: paging in directory bytes merely to PRICE a tier
   * would spend the very resource the pick is trying to save. The needed
   * leaves become resident as a side effect of the selection query that
   * follows, so a paged archive answers from the zoom threshold on the first
   * pass and from measured cost thereafter.
   */
  async pickTemporalLodByCost(
    bounds: BoundingBox,
    zoom: number,
    timeRange: TimeRange,
  ): Promise<TemporalTierPick | undefined> {
    const meta = await this.getMetadata();
    const levels = meta.temporalLod;
    // No pyramid ⇒ no addressable set beyond the base tier. Identical to
    // pickTemporalLodForZoom's `undefined`, and the reason archives without
    // tiers see exactly zero behavioural change from this item.
    if (!levels || levels.length === 0) return undefined;
    await this.getIndex();
    // The SAME base the synchronous walk filters on (manifest-cached), so the
    // "base tier" candidate prices exactly the set getTileIdsInBounds returns.
    const base = this.baseTemporalBucketMs;
    // The MEASURED exchange rate, or null while either estimator is cold. A
    // null here abstains inside temporalTierArgmin — it is never widened into
    // a constant on the way in.
    const requestOverheadBytes = this.getRequestPriceBytes();
    const argmin = temporalTierArgmin(
      addressableTemporalTiers(levels, base, zoom).map((bucketMs) => ({
        bucketMs,
        selection: this.estimateSelectionCost(bounds, zoom, timeRange, {
          bucketMs,
        }),
      })),
      requestOverheadBytes,
    );
    if (argmin.pick) {
      return {
        bucketMs: argmin.pick.bucketMs,
        bytes: argmin.pick.selection.bytes,
        tiles: argmin.pick.selection.tiles,
        cost: argmin.pick.cost,
        requestOverheadBytes: argmin.requestOverheadBytes,
        policy: 'cost-argmin',
        exact: true,
        abstainReason: 'none',
      };
    }
    // Unpriceable ⇒ the incumbent rule answers, and says so.
    const zoomPick = await this.pickTemporalLodForZoom(zoom);
    const bucketMs = zoomPick?.bucketMs ?? base;
    // Report the LOWER-BOUND numbers we do have for the tier we returned
    // rather than zeroes that could read as "free"; `exact: false` is what
    // says they are not authoritative.
    const priced = argmin.candidates.find((c) => c.bucketMs === bucketMs);
    return {
      bucketMs,
      bytes: priced?.selection.bytes ?? 0,
      tiles: priced?.selection.tiles ?? 0,
      cost: priced?.cost ?? Number.POSITIVE_INFINITY,
      requestOverheadBytes: argmin.requestOverheadBytes,
      policy: 'zoom-threshold',
      exact: false,
      abstainReason: argmin.reason,
    };
  }

  /** Clear the in-memory compressed-byte cache (does NOT touch OPFS). */
  clearCache(): void {
    this.byteCache.clear();
    this.currentCacheBytes = 0;
  }

  /**
   * Clear the persistent OPFS cache. Use this when the user wants to
   * reclaim disk, or as part of a forced refresh. The in-memory byte cache
   * is left alone — clear that separately with {@link clearCache}.
   */
  async clearOpfsCache(): Promise<void> {
    await this.opfsCache?.clear();
    this.opfsStats = { hits: 0, misses: 0 };
  }

  /** Cache statistics. */
  getCacheStats() {
    const total = this.cacheStats.hits + this.cacheStats.misses;
    const opfsTotal = this.opfsStats.hits + this.opfsStats.misses;
    const opfs = this.opfsCache?.getStats();
    return {
      size: this.byteCache.size,
      maxSize: this.maxCacheTiles,
      bytes: this.currentCacheBytes,
      maxBytes: this.maxCacheBytes,
      hits: this.cacheStats.hits,
      misses: this.cacheStats.misses,
      evictions: this.cacheStats.evictions,
      hitRate: total > 0 ? this.cacheStats.hits / total : 0,
      // OPFS layer stats. Fields are zero / undefined when OPFS isn't
      // enabled, so HUD code can read them unconditionally.
      opfs: opfs
        ? {
            available: opfs.available,
            bytes: opfs.bytes,
            entries: opfs.entries,
            maxBytes: opfs.maxBytes,
            hits: this.opfsStats.hits,
            misses: this.opfsStats.misses,
            hitRate: opfsTotal > 0 ? this.opfsStats.hits / opfsTotal : 0,
          }
        : undefined,
    };
  }

  /**
   * Direct handle to the OPFS cache. Returns `undefined` when OPFS is
   * disabled. Useful for `clear()` from a "wipe cache" UI button.
   */
  getOpfsCache(): OpfsTileCache | undefined {
    return this.opfsCache;
  }

  /**
   * View this archive through the loaders.gl `TileSource` interface so it
   * can be passed to deck.gl `TileLayer` / `MVTLayer`-style consumers. STT
   * is 4D (z, x, y, t); the adapter picks the archive-midpoint time by
   * default — pass `userData.t` in `getTileData()` for explicit control.
   * See {@link createSttTileSource} for details.
   */
  asTileSource(): SttTileSource {
    return createSttTileSource(this);
  }
}

/**
 * Tile-x column span covering `[minLon, maxLon]` at `zoom`, WRAP-AWARE.
 *
 * Longitude is cyclic but tile x is not, and viewport bounds reach this
 * function in two shapes that both leave the `[-180, 180]` world:
 *
 *  - UNWRAPPED (`WebMercatorViewport.unproject`, the common one): a camera
 *    centred at lon 179 reports `{minLon: 174, maxLon: 184}`. The `[180, 184]`
 *    slice is the right half of the screen and lives at tile columns `x ∈ [0…]`.
 *  - CROSSING (`minLon > maxLon`): the explicit "this span runs east across the
 *    antimeridian" encoding, e.g. `{minLon: 170, maxLon: -170}`.
 *
 * Clamping either shape into `[0, 2^z − 1]` silently DISCARDS the wrapped
 * half, leaving a permanently blank eastern viewport on seam-crossing
 * datasets (`ais-all-us`, `drifters`).
 *
 * The span is returned as a wrapped `start` column plus a `count`; column `i`
 * is `(start + i) % n`. `count` is capped at one world width (`n`), so a
 * >360°-wide span (a low-zoom unproject can produce one) covers every column
 * exactly ONCE instead of emitting duplicate ids.
 *
 * The ordinary in-world case (`-180 ≤ minLon ≤ maxLon ≤ 180`) takes a fast
 * path identical to a plain clamped scan — including the `maxLon === 180`
 * edge, where `lonToTileX` returns the out-of-world column `n` and the clamp
 * (not a wrap) is the right answer.
 *
 * A `minLon > maxLon` pair is read as a crossing only while the width it
 * implies stays believable — see {@link orderLonRange}.
 *
 * Exported for the wrap-aware selection tests; not part of the public API.
 */
export function tileXSpanForLonRange(
  minLon: number,
  maxLon: number,
  zoom: number,
): { start: number; count: number } {
  const n = 1 << zoom;
  const [west, east] = orderLonRange(minLon, maxLon);
  // Fast path: an ordinary in-world bbox — byte-identical to the historical
  // clamped scan, and the overwhelmingly common case (no wrap arithmetic).
  if (west <= east && west >= -180 && east <= 180) {
    const start = Math.max(0, lonToTileX(west, zoom));
    const end = Math.min(lonToTileX(east, zoom), n - 1);
    return { start, count: Math.max(0, end - start + 1) };
  }
  // Seam-crossing or unwrapped: walk the span in UNWRAPPED column space
  // (which is always contiguous), then wrap each column at emit time.
  const first = lonToTileX(west, zoom);
  // `west > east` is the crossing encoding: the span runs east through
  // +180, so its end column sits one world further along.
  const last = lonToTileX(east, zoom) + (west > east ? n : 0);
  const count = Math.min(n, Math.max(0, last - first + 1));
  return { start: ((first % n) + n) % n, count };
}

/**
 * Order a longitude pair for the scans below, deciding whether `minLon > maxLon`
 * means "this span crosses the antimeridian" or "someone handed us an inverted
 * box".
 *
 * The crossing encoding is load-bearing here — a viewport parked on the seam
 * legitimately arrives as `{minLon: 170, maxLon: -170}` and both scans below
 * depend on reading it that way. But it is also EXACTLY what a pitch-inverted
 * viewport looks like: past `pitch + fovy/2 > 90` (71.57° at deck's default
 * altitude) the above-horizon unproject returns a point BEHIND the camera and
 * the longitude pair swaps. The pair alone cannot tell the two apart — only the
 * width it implies can. A crossing viewport is a viewport: a few degrees, maybe
 * a few tens. A box claiming to cross the seam AND wrap 350°+ of the planet
 * selected 510 of 512 columns at z9 while the camera was looking at two of them.
 *
 * Same threshold and same reasoning as `normalizeViewportBounds`
 * (docs/roadmap/tile-loading-3d-2026-07.md §4.1); `MAX_SEAM_SPAN_DEG` is
 * imported rather than re-spelled so the producer-side repair and this
 * last-line-of-defence can never drift apart.
 *
 * Note what this deliberately does NOT do: it never wraps or clamps longitude
 * into `[-180, 180]`. The UNWRAPPED contract (`unproject` reporting lon 184 for
 * a camera at lon 179) is what lets the scans walk unwrapped column space and
 * wrap at emit; re-clamping here would silently drop the far side of the seam —
 * the regression `ais-all-us` and `drifters` were fixed for.
 */
function orderLonRange(minLon: number, maxLon: number): [number, number] {
  if (minLon > maxLon && maxLon - minLon + 360 >= MAX_SEAM_SPAN_DEG) {
    return [maxLon, minLon];
  }
  return [minLon, maxLon];
}

/**
 * Web-Mercator scan window covering a bounding box at a zoom.
 *
 * x iteration is wrap-aware (see {@link tileXSpanForLonRange}) so a viewport
 * straddling the antimeridian yields columns from BOTH edges of the world;
 * y stays clamped (there is nothing to wrap around at the poles).
 *
 * An earlier revision truncated the scan to a centred window at that threshold.
 * That traded a frame-rate problem for a correctness one: the tiles outside the
 * kept window are on screen and simply never load, which is the same blank-region
 * symptom this whole module was fixed to remove. The sparse occupied-cell path
 * above makes a huge grid cheap without narrowing it.
 */
interface TileScanWindow {
  worldSize: number;
  startX: number;
  xCount: number;
  minY: number;
  maxY: number;
  cells: number;
}

/** Compute a bounds scan once so dense and sparse query paths share geometry. */
function tileScanWindow(bounds: BoundingBox, zoom: number): TileScanWindow {
  const n = 1 << zoom;
  const { start, count } = tileXSpanForLonRange(
    bounds.minLon,
    bounds.maxLon,
    zoom,
  );
  // ORDER the row span before clamping it. `y` runs the other way from
  // latitude, so the natural reading (`minY` from `maxLat`) silently assumes
  // `minLat <= maxLat`; the historical `Math.max(0, …)` / `Math.min(…, n - 1)`
  // clamped to the WORLD, never to `minY <= maxY`. Under bearing rotation or
  // above-horizon pitch the producer's box inverts, `minY > maxY`, and the loop
  // body below NEVER RUNS — zero tiles, while `getBufferedRunway` reports
  // `complete: true` and every readiness signal says settled. Ordering makes an
  // inverted box degrade to the band it brackets instead of to nothing.
  const yTop = latToTileY(bounds.maxLat, zoom);
  const yBottom = latToTileY(bounds.minLat, zoom);
  const minY = Math.max(0, Math.min(yTop, yBottom));
  const maxY = Math.min(Math.max(yTop, yBottom), n - 1);
  const rows = maxY - minY + 1;
  return {
    worldSize: n,
    startX: start,
    xCount: count,
    minY,
    maxY,
    cells: count * Math.max(0, rows),
  };
}

/**
 * DELIBERATELY ABSENT: an intersection of the query box with the archive's
 * declared `metadata.bounds`.
 *
 * It was added as a cheap fix for the enumeration blow-up described on
 * {@link MAX_QUERY_SCAN_CELLS}, on the reasoning that a tile holding data must
 * intersect the archive's extent, so any tile the intersection drops was
 * already empty. That reasoning is WRONG, because `metadata.bounds` does not
 * bound the data:
 *
 * - `stt-build.rs` fills the manifest bounds from `input::calculate_bounds`.
 * - `calculate_bounds` takes the min/max of `ParsedFeature.lon` / `.lat`.
 * - `ParsedFeature.lon`/`.lat` is the geometry's **CENTROID** (`input.rs`,
 *   "Parse a WKB/EWKB blob into a GeoJSON geometry and its centroid").
 * - but the tiler addresses tiles by **VERTEX** — `tiler.rs` places each point
 *   of a multi-point/line geometry with `lonlat_to_tile(p[0], p[1], zoom)`, and
 *   polygons are clipped across every tile they cross.
 *
 * So the declared bounds are the bbox of CENTROIDS while the tiles are laid out
 * by VERTICES, and on any line / polygon / multi-point archive the occupied
 * tiles provably extend PAST the declared extent. Intersecting against it
 * silently drops real, non-empty tiles at the edges of the data — the same
 * blank-region symptom the 3-D tile-loading work exists to remove.
 * (`calculate_bounds` separately skips the `(0, 0)` null-island sentinel, so
 * even a pure-point archive can have data outside its declared bounds.)
 *
 * The under-reporting is an upstream bug worth fixing on its own — it also
 * mis-frames the showcase's opening camera and understates the bbox that
 * `stt-validate` and the MCP `describe_dataset` report — but it must be fixed
 * in the builder, and it only takes effect on a rebuild. Until then a query box
 * is honoured as given. See `docs/roadmap/tile-loading-3d-2026-07.md`.
 */

function lonToTileX(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * (1 << zoom));
}

/**
 * Fold a longitude into `[-180, 180)`. Exported so the tileset can normalize
 * an UNWRAPPED viewport centre (`unproject` happily reports lon 184) before
 * handing it to anything that treats longitude as a geographic coordinate.
 */
export function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * A query longitude range expressed as ONE or TWO in-world `[lo, hi]`
 * intervals — the shape an overlap test against in-world geometry (leaf-page
 * bboxes) needs.
 *
 * The ordinary in-world range returns a single interval identical to its
 * input (the hot path: one allocation, same comparisons as before). A range
 * that leaves the world — unwrapped (`maxLon > 180`) or crossing
 * (`minLon > maxLon`) — is split at the antimeridian into the eastern and
 * western halves; a range at least a full world wide collapses to `[-180, 180]`.
 *
 * The crossing/inversion split is {@link orderLonRange}'s, and must be: this
 * function decides which leaf pages get fetched while `tileXSpanForLonRange`
 * decides which columns get selected. If the two disagreed about an inverted
 * box, the columns one selected would resolve against leaves the other never
 * paged in — an empty entry index, which reads exactly like "no data here".
 *
 * Exported for the wrap-aware selection tests; not part of the public API.
 */
export function lonQueryIntervals(
  minLon: number,
  maxLon: number,
): Array<[number, number]> {
  const [west, east] = orderLonRange(minLon, maxLon);
  if (west <= east && west >= -180 && east <= 180) {
    return [[west, east]];
  }
  // A span of a full world (or more, e.g. a >360° unproject at low zoom)
  // covers everything — one interval, no duplicate work.
  const span = west > east ? east + 360 - west : east - west;
  if (!(span < 360)) return [[-180, 180]];
  const lo = wrapLon(west);
  const hi = wrapLon(east);
  // `lo <= hi` after wrapping means the span happened not to straddle the
  // seam after all (e.g. `[-190, -185]` → `[170, 175]`).
  return lo <= hi
    ? [[lo, hi]]
    : [
        [lo, 180],
        [-180, hi],
      ];
}

/**
 * The leaf-page pruning predicate: does this descriptor's subtree intersect a
 * `(bounds, zoom, timeRange)` query? Geo-bbox ∩ viewport ∧ zoom membership ∧
 * temporal overlap — exactly the Rust `PageDescriptor::overlaps`.
 *
 * `lonSpans` are the WRAPPED query intervals ({@link lonQueryIntervals}) and
 * `latLo <= latHi` is the ordered latitude band; both are hoisted out of the
 * page loop by callers because they are per-query, not per-page.
 *
 * ONE definition, two callers: `ensurePagesForBounds` (which FETCHES what
 * overlaps) and `unknownEntriesInBounds` (which COUNTS what overlaps and is
 * not resident). Those two must agree exactly — "a leaf the query would have
 * faulted in" IS the definition of a leaf the synchronous cost walk is blind
 * to, so a divergence would silently turn an unpriced leaf into a reported-
 * exact answer.
 */
function pageOverlapsQuery(
  p: PageDescriptor,
  lonSpans: Array<[number, number]>,
  latLo: number,
  latHi: number,
  zoom: number,
  timeRange: TimeRange,
): boolean {
  if (zoom < p.minZoom || zoom > p.maxZoom) return false;
  let lonHit = false;
  for (const [lo, hi] of lonSpans) {
    if (p.maxLon >= lo && hi >= p.minLon) {
      lonHit = true;
      break;
    }
  }
  if (!lonHit) return false;
  if (p.maxLat < latLo || latHi < p.minLat) return false;
  if (p.tMax < timeRange.start || p.tMin > timeRange.end) return false;
  return true;
}

/**
 * Row index of a latitude at a zoom — the y half of the tile grid, UNCLAMPED
 * (a latitude past the mercator limit returns a row outside `[0, 2^z)`, which
 * every caller clamps after ordering; see {@link boundsToTiles}).
 *
 * Exported so `tile-budget.ts` can PREDICT the cell count `boundsToTiles` is
 * about to enumerate using the identical arithmetic. Nothing moved: the y
 * duplication with `spatiotemporal-tileset.ts`'s `latToTileClamped` is left
 * alone deliberately, seam code that took real debugging being the last thing
 * to refactor for tidiness.
 */
export function latToTileY(lat: number, zoom: number): number {
  // Clamp to the Web Mercator edge BEFORE projecting. `tan(rad)` and
  // `1 / cos(rad)` both diverge with opposite signs as `|lat| → 90`, so their
  // sum is the difference of two enormous floats: in the sliver just inside a
  // pole, cancellation drives it NEGATIVE and `Math.log` returns `NaN`. A `NaN`
  // row bound makes the caller enumerate ZERO tiles — a blank render from a
  // camera that is showing the whole world (measured at z2 from
  // `minLat = -89.99999999998705`). Exactly ±90 happens to be safe, which is
  // why this hid: the failure window is a hair INSIDE the pole.
  //
  // Nothing is lost by clamping — no tile row exists above this latitude.
  // `normalizeViewportBounds` clamps to the same constant, so the viewport path
  // never reaches here out of range; this guard covers every other caller.
  const clamped =
    lat > MAX_MERCATOR_LAT
      ? MAX_MERCATOR_LAT
      : lat < -MAX_MERCATOR_LAT
        ? -MAX_MERCATOR_LAT
        : lat;
  const rad = (clamped * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) *
      (1 << zoom),
  );
}

/**
 * Web-Mercator position normalized to [0,1)×[0,1), independent of zoom —
 * the zoom=0 fractional case of {@link lonToTileX}/{@link latToTileY} (no
 * floor, no `<< zoom`). Used by {@link ArchiveReader.minDistanceToViewportCenter}
 * to compare a viewport center against tile centers at whatever zoom each
 * tile happens to be.
 */
function lonLatToNormalizedMercator(
  lon: number,
  lat: number,
): [number, number] {
  const x = (lon + 180) / 360;
  const rad = (lat * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
  return [x, y];
}

/**
 * Geographic bbox `[minLon, minLat, maxLon, maxLat]` of a tile — the inverse
 * Web-Mercator projection of its NW corner `(x, y)` and SE corner `(x+1, y+1)`.
 * Mirrors the Rust `projection::tile_geo_bounds`; used to select a tile's leaf
 * page(s) on a paged archive (`ensurePagesForTiles`).
 */
function tileToLonLatBounds(
  z: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const n = 1 << z;
  const lon = (tx: number): number => (tx / n) * 360 - 180;
  const lat = (ty: number): number => {
    const m = Math.PI - (2 * Math.PI * ty) / n;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(m) - Math.exp(-m)));
  };
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

/**
 * Parse the `summary_tier` block from an archive's JSON metadata into the
 * camelCase TS shape. Returns `undefined` for archives that don't carry one.
 */
function parseSummaryTier(raw: unknown): SummaryTier | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const scheme = r.scheme as string | undefined;
  if (scheme !== 'h3' && scheme !== 'quadbin') return undefined;
  const minZoom = Number(r.min_zoom ?? 0);
  const maxZoom = Number(r.max_zoom ?? minZoom);
  const cellResolutionPerZoom = Array.isArray(r.cell_resolution_per_zoom)
    ? (r.cell_resolution_per_zoom as unknown[]).map((v) => Number(v))
    : [];
  const layerName = typeof r.layer_name === 'string' ? r.layer_name : 'summary';
  const cols: SummaryColumn[] = Array.isArray(r.columns)
    ? (r.columns as unknown[])
        .map((c) => {
          if (!c || typeof c !== 'object') return null;
          const cc = c as Record<string, unknown>;
          const name = String(cc.name ?? '');
          const agg = String(cc.agg ?? '');
          if (
            agg !== 'count' &&
            agg !== 'sum' &&
            agg !== 'mean' &&
            agg !== 'min' &&
            agg !== 'max'
          ) {
            return null;
          }
          return { name, agg } as SummaryColumn;
        })
        .filter((c): c is SummaryColumn => c !== null)
    : [];
  const subBuckets = Math.max(1, Math.floor(Number(r.sub_buckets ?? 1)));
  const variantId = Number(r.variant_id);
  if (!Number.isSafeInteger(variantId) || variantId < 0) return undefined;
  return {
    variantId,
    scheme,
    minZoom,
    maxZoom,
    cellResolutionPerZoom,
    columns: cols,
    layerName,
    subBuckets,
  };
}

/**
 * Parse the `heatmap_domain` block from an archive's JSON metadata into the
 * camelCase TS shape. Returns `undefined` for archives that don't carry one.
 * Each class entry surfaces the bake-time `[min, max]` splat-intensity
 * domain that HeatmapLayer uses as its pinned `colorDomain` default.
 */
function parseHeatmapDomain(raw: unknown): HeatmapDomain | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.classes)) return undefined;
  const classes: HeatmapClassDomain[] = (r.classes as unknown[])
    .map((c) => {
      if (!c || typeof c !== 'object') return null;
      const cc = c as Record<string, unknown>;
      const id = typeof cc.id === 'string' ? cc.id : '';
      const min = Number(cc.min);
      const max = Number(cc.max);
      if (!id || !Number.isFinite(min) || !Number.isFinite(max)) return null;
      const out: HeatmapClassDomain = { id, min, max };
      if (typeof cc.property === 'string') out.property = cc.property;
      return out;
    })
    .filter((c): c is HeatmapClassDomain => c !== null);
  if (classes.length === 0) return undefined;
  return { classes };
}

/** The `layer_hint` values this reader recognizes (anything else is dropped). */
const LAYER_HINT_VALUES: ReadonlyArray<NonNullable<StyleHints['layerHint']>> = [
  'points',
  'paths',
  'trips',
  'polygons',
];

/** The numeric percentile fields of a `style_hints` property entry (wire and TS names coincide). */
const NUMERIC_HINT_FIELDS = [
  'min',
  'p50',
  'p90',
  'p95',
  'p97',
  'p99',
  'max',
] as const;

/**
 * Parse one `style_hints.properties[]` entry into a {@link PropertyStyleHint}.
 * Returns `null` for a malformed entry (missing name, or a known field with
 * the wrong type) so {@link parseStyleHints} can drop entries INDIVIDUALLY
 * instead of rejecting the whole block. `null` field values are treated as
 * absent (the Rust writer may null-fill instead of omitting); unknown extra
 * keys are ignored for forward compatibility.
 */
function parsePropertyStyleHint(raw: unknown): PropertyStyleHint | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.name !== 'string' || p.name.length === 0) return null;
  const out: PropertyStyleHint = { name: p.name };
  for (const key of NUMERIC_HINT_FIELDS) {
    const v = p[key];
    if (v == null) continue; // absent (or null-filled) → optional field stays unset
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[key] = v;
  }
  const domain = p.suggested_domain;
  if (domain != null) {
    if (
      !Array.isArray(domain) ||
      domain.length !== 2 ||
      typeof domain[0] !== 'number' ||
      !Number.isFinite(domain[0]) ||
      typeof domain[1] !== 'number' ||
      !Number.isFinite(domain[1])
    ) {
      return null;
    }
    out.suggestedDomain = [domain[0], domain[1]];
  }
  const cardinality = p.cardinality;
  if (cardinality != null) {
    if (typeof cardinality !== 'number' || !Number.isFinite(cardinality))
      return null;
    out.cardinality = cardinality;
  }
  return out;
}

/**
 * Parse the `style_hints` block from an archive's JSON metadata into the
 * camelCase TS shape ({@link StyleHints}). Returns `undefined` for archives
 * that don't carry one — and NEVER throws: a missing/malformed block degrades
 * to `undefined`, a malformed `properties[]` entry is dropped individually
 * (the rest of the block survives), a non-array `properties` degrades to an
 * empty list, and unknown extra keys are ignored for forward compatibility.
 *
 * This is the ONLY snake_case → camelCase hop for the whole `style_hints`
 * block, so every field the Rust writer emits needs a line here — a field this
 * function does not name is dropped silently, with no error, on every archive.
 *
 * The hints are build-time-measured DEFAULTS only — layer props / spec /
 * user config always override them.
 */
export function parseStyleHints(json: unknown): StyleHints | undefined {
  if (!json || typeof json !== 'object' || Array.isArray(json))
    return undefined;
  const r = json as Record<string, unknown>;
  if (typeof r.version !== 'number' || !Number.isFinite(r.version))
    return undefined;
  const properties = Array.isArray(r.properties)
    ? (r.properties as unknown[])
        .map(parsePropertyStyleHint)
        .filter((p): p is PropertyStyleHint => p !== null)
    : [];
  const out: StyleHints = { version: r.version, properties };
  const playback = r.suggested_playback_seconds;
  if (typeof playback === 'number' && Number.isFinite(playback)) {
    out.suggestedPlaybackSeconds = playback;
  }
  // The writer's companion to the duration hint: how much time to SHOW at once
  // (`suggested_time_window_ms`, emitted by `stt-build --derived-playback-params`).
  // This rename is the ONLY hop between the Rust field and the camelCase name
  // `@poopdeck.gl/playback`'s `resolvePlaybackParams` reads, so dropping it here
  // silently kills the feature end-to-end — nothing throws, the reader just
  // keeps its bucket-derived default forever. Same guard as the duration hint:
  // a non-finite value is dropped rather than propagated, and an absent field
  // leaves the key ABSENT so the reader's `?? bucket × 24` fallback runs
  // exactly as it did before the field existed.
  const timeWindowMs = r.suggested_time_window_ms;
  if (typeof timeWindowMs === 'number' && Number.isFinite(timeWindowMs)) {
    out.suggestedTimeWindowMs = timeWindowMs;
  }
  const layerHint = r.layer_hint;
  if (
    typeof layerHint === 'string' &&
    (LAYER_HINT_VALUES as readonly string[]).includes(layerHint)
  ) {
    out.layerHint = layerHint as NonNullable<StyleHints['layerHint']>;
  }
  return out;
}

/**
 * Look up the bake-time suggested color/size ramp domain for `property` in
 * an archive's {@link StyleHints}. Returns `undefined` when the archive
 * carries no hints, the property has no entry, or the entry carries no
 * domain (e.g. a categorical property). The domain is a build-time-measured
 * DEFAULT (`[min, ~p97]`, endpoints rounded outward) — callers should always
 * let layer/spec/user config override it.
 */
export function suggestedDomainFor(
  hints: StyleHints | undefined,
  property: string,
): [number, number] | undefined {
  if (!hints || !Array.isArray(hints.properties)) return undefined;
  return hints.properties.find((p) => p.name === property)?.suggestedDomain;
}
