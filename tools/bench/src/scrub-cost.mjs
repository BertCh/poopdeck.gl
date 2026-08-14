#!/usr/bin/env node
/**
 * Scrub-cost benchmark — the §11.6 keep-vs-delete evidence for `scrubLod`.
 *
 * ── WHAT QUESTION THIS ANSWERS ─────────────────────────────────────────────
 * `scrubLod` (the tileset's scrub-time LOD "motion tier") is a complete,
 * end-to-end tested capability with **zero call sites**: nothing anywhere under
 * the `examples` tree passes it, across all three renderers. The roadmap calls
 * it *counted out* rather than open, and records a standing clause: if the revival
 * triggers do not fire by the next format revision, **delete the wiring rather
 * than carry a dark feature** (docs/roadmap/playback-and-loading.md §7).
 *
 * The decision hinges on a measurement nobody has taken. This harness takes it.
 * It drags the real timeline scrubber, at fixed replayable velocities, with the
 * motion tier **absent** (today's shipped state — the baseline) and with it
 * **enabled**, and reports the five recorded criteria:
 *
 *   1. scrub time-to-first-pixel    target < one 60 Hz frame (16.7 ms)
 *   2. fresh-frame fraction         % of drag previews on current-instant data
 *   3. bytes-during-scrub           MUST drop vs baseline (hard — see below)
 *   4. settle-to-full-detail        endScrub → fine tier resident
 *   5. pop / oscillation count      tier switches per drag, target ~1–2
 *
 * plus the rollback drill (`scrubLod` off is byte- and behavior-identical).
 *
 * ── THE HARD BYTE CONSTRAINT ───────────────────────────────────────────────
 * "Bytes fetched during the drag ≤ the no-policy baseline — a motion tier that
 * fetches MORE than full detail is worse than nothing." That is the one
 * criterion that can single-handedly condemn the feature, so it is evaluated
 * as a hard PASS/FAIL and never averaged away.
 *
 * ── WHAT THIS HARNESS DOES NOT DO ──────────────────────────────────────────
 * It does not TUNE anything. Two contracts are in the standing do-not-touch
 * register and are **observed, never altered**:
 *
 *   G7 (preview-never-gates, hard)  the coarse tier must not enter readiness
 *       reporting, and NO GATE MAY START THE CLOCK WHILE THE THUMB IS HELD.
 *   Restore invariant               q(T_d⁺) = q_0 — the fine tier is restored
 *       BEFORE the commit's readiness is measured.
 *
 * Both are asserted on every drag. A violation is a **HARD FAILURE of the run**
 * (exit 4), not a metric: it means the observation itself is unsound, because
 * the thing being measured is no longer the thing that shipped.
 *
 * It also builds no controller. Velocity-scaled degrade, scrub-velocity
 * prefetch (ATLAS), and the Funkhouser–Séquin predictive LOD budget are all
 * explicitly counted out; this file produces the evidence a decision is made
 * from, and nothing else.
 *
 * And it judges no pixels. Per the project's browser-verify protocol boundary,
 * automated evaluation reads counters, bytes and frame timings; whether a demo
 * LOOKS right is the user's own in-browser pass. There is no screenshot
 * judgment here — the one screenshot per run exists solely to prove the canvas
 * was not blank, exactly as in `frame-cost.mjs`.
 *
 * ── HOW "TIME TO FIRST PIXEL" IS MEASURED (read before quoting it) ─────────
 * The metric of record is the governor's `ScrubQoeStats.timeToFirstPixelMs`: a
 * DATA-READINESS proxy — first `scrubTo` → the previewed instant being covered
 * by the required sources' buffered ranges. The governor sees the clock and the
 * buffered ranges, not the compositor, so this is a LOWER BOUND on the true
 * presented-frame latency. This harness adds the render-side companion it can
 * honestly measure — `firstFrameAfterGrabMs`, the wall gap from the grab to the
 * next rAF callback — and reports both. That companion bounds how long the user
 * waited for *a* frame; it says nothing about what the frame contained. A true
 * presented-frame oracle would need pixel judgment, which this project
 * deliberately does not automate.
 *
 * ── ENABLING THE MOTION TIER WITHOUT SHIPPING IT ───────────────────────────
 * `scrubLod` stays DEFAULT OFF and this harness adds **zero showcase call
 * sites**. The enabled variant is produced entirely inside the page context, by
 * reaching the live `SpatioTemporalTileset` through the React fiber tree and
 * calling its public `setOptions({ scrubLod })`. Nothing is written to any
 * source file, and closing the browser reverts everything. The consuming layer
 * re-syncs its own props onto the tileset on every update pass (which would
 * clobber the override), so the instance's `setOptions` is wrapped for the
 * duration of the enabled variant and unwrapped after — an in-page shim, not a
 * package change.
 *
 * If the handle cannot be found, the enabled variant is reported as
 * NOT-ACHIEVED. It is never silently replaced by a second baseline run.
 *
 * ── FAIRNESS OF THE COMPARISON ─────────────────────────────────────────────
 * Cache warmth is the obvious confound: a second variant measured on a page
 * already warmed by the first would look cheaper for free. So each variant gets
 * its **own page load**, an identical warmup, and the same fixed drag order.
 * Playback is paused before the drag series (the clock is frozen under a held
 * thumb anyway) so bytes-during-scrub attributes to the drag rather than to
 * background playback. Pass `--keep-playing` to opt out.
 *
 * The drag trajectories are pure functions of the scrubber's bounding box and
 * the recorded velocity constants below, so the same pixels are traversed in
 * the same order in every variant. The box is recorded per variant and a
 * mismatch is flagged as `geometryDrift` rather than quietly averaged in.
 *
 * Usage:
 *   node src/scrub-cost.mjs <demo-id> [port] [options]
 *   ROUTE=/drive node src/scrub-cost.mjs drive 3000
 *   WARMUP_MS=30000 node src/scrub-cost.mjs nyc-taxi 3000 --repeat 3
 *
 * The heavy routes the revival trigger names: NYC taxi (~10 M vertices), the AV
 * cockpit (`ROUTE=/drive`), BIXI. §11.6's standing clause requires failure on
 * ALL THREE before the wiring is slated for deletion — one route cannot decide
 * it, and the printed verdict says so.
 *
 * Options:
 *   --variants a,b        subset of baseline,scrublod,baseline-after
 *   --zoom-drop N         scrubLod.spatialZoomDrop for the enabled variant (2)
 *   --velocities a,b      subset of the recorded velocities (all)
 *   --repeat N            drags per (variant, velocity) — the median is reported (3)
 *   --settle-ms N         budget to wait for settle-to-full-detail to close (6000)
 *   --quiesce-ms N        idle gap between drags so fetches do not bleed (2000)
 *   --keep-playing        do not pause the transport before the drag series
 *   --out <path>          JSON destination (default OUT_DIR/scrub-cost-<slug>.json)
 *   --json                print the JSON report to stdout as well
 *   --help
 *
 * Env: WARMUP_MS (20000), ROUTE (/demo/<demo-id>), OUT_DIR (tools/bench/out).
 *
 * Exit codes — a run that wrote a file is not automatically a result:
 *   0  measured
 *   3  nothing measured: no drags, or no drag produced a scrubstart/scrubend
 *      bracket (no governor was wired — commonly, no archive opened)
 *   4  HARD FAILURE: preview-never-gates or the restore invariant did not hold
 *   5  the enabled state was requested but the motion tier was never applied,
 *      so the "scrublod" column is a second baseline
 *
 * Start the showcase first (`pnpm --filter @poopdeck.gl/showcase dev`) and pass
 * the port it printed; Vite walks forward from 3000 when the port is taken.
 *
 * ── STANDING BLOCKER AS OF 2026-08-10 (why this may exit 3) ────────────────
 * The working tree carries an UNCOMMITTED bump of `PACKED_FORMAT_VERSION` from
 * 2 to 3 in `packages/core/src/archive.ts`, and the reader gates on strict
 * equality. Every archive that exists — all 64 under
 * `examples/showcase/public/data`, and the whole live 68-archive fleet — is
 * `formatVersion: 2`, so a working-tree showcase build opens NOTHING:
 *
 *   [STL] Archive init failed: /data/<id>/manifest.json
 *         Error: STT manifest: unsupported formatVersion 2 (expected 3)
 *
 * With no archive there is no tileset, no governor, no `requests` samples, and
 * therefore no §11.6 metrics — the driver still runs the drag and still reports,
 * but it reports UNOBSERVED and exits 3. Run this against a build of
 * `@poopdeck.gl/core` whose format version matches the data (a HEAD-committed
 * v2 build today, or the whole tree once the v3 rebuild window lands). Do NOT
 * "fix" it by editing `PACKED_FORMAT_VERSION` in either direction, and do not
 * spoof the manifest's version at the fetch boundary: v3 is a payload break, so
 * a spoofed run would decode v2 bytes with v3 logic and produce numbers that
 * look plausible and are not.
 *
 * Playwright is a devDependency of the workspace ROOT, not of this package, so
 * it is required by absolute path rather than by bare specifier — same as
 * `frame-cost.mjs` and `policy-record.mjs`.
 *
 * Committed results, method and caveats live in
 * `docs/roadmap/measurements-2026-08.md`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

/** Bumped when the recorded trajectories or the metric definitions change. */
export const HARNESS_VERSION = 1;

/** One 60 Hz frame, in ms — §11.6's time-to-first-pixel target. */
export const FRAME_MS_60HZ = 1000 / 60;

/** The scrubber, by its stable accessible name (packages/react PlaybackControls). */
export const SCRUBBER_SELECTOR =
  'input[type="range"][aria-label="Playback position"]';

/**
 * THE RECORDED DRAG TRAJECTORIES.
 *
 * Fixed, and replayed identically across variants — the stated mitigation for
 * "the drag synthesizer measures the harness rather than the policy". Nothing
 * here may depend on the variant, the run, the clock, or the data.
 *
 * `pxPerSec` is NOMINAL. Each synthesized pointer move is a CDP round-trip, so
 * the achieved velocity is always somewhat lower; every drag reports its
 * measured `pxPerSecActual` beside the nominal one, and the comparison across
 * variants is what carries the claim, not the absolute velocity.
 */
export const DRAG_VELOCITIES = [
  /** A deliberate, reading-the-data drag. Most previews, most chances to fetch. */
  { name: 'slow', pxPerSec: 200, spanFraction: 0.55 },
  /** The ordinary "take me over there" drag. */
  { name: 'medium', pxPerSec: 800, spanFraction: 0.7 },
  /** A flick. The case a motion tier is supposed to exist for. */
  { name: 'flick', pxPerSec: 2400, spanFraction: 0.85 },
];

/** One 60 Hz frame between synthesized pointer moves. */
export const DRAG_STEP_MS = 16;
/** Never fewer than this many moves, however fast the drag. */
export const DRAG_MIN_STEPS = 6;
/** Where on the bar the drag starts, as a fraction of its width. */
export const DRAG_START_FRACTION = 0.08;
/**
 * How long the thumb rests at the far end before release.
 *
 * Deliberately longer than the shipped settle debounce (`seekSettleMs` = 200
 * ms) so every drag exercises the mid-drag settle-commit — which is precisely
 * the path where G7's "no gate may start the clock while the thumb is held"
 * has to hold. It is also the window in which `timeToFirstPixelMs` can close
 * from arriving data under a resting thumb.
 */
export const DRAG_DWELL_MS = 300;

/** Variant ids, in execution order. Each gets its own page load. */
export const VARIANTS = ['baseline', 'scrublod', 'baseline-after'];

/** Probe channels this harness stamps at push time (exact order, exact clock). */
export const STAMPED_CHANNELS = ['scrub', 'playback', 'requests'];

// ───────────────────────────────────────────────────────────────────────────
// Arg parsing
// ───────────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const BOOLEAN = new Set(['json', 'help', 'keep-playing']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    if (BOOLEAN.has(name)) flags[name] = true;
    else flags[name] = argv[++i];
  }
  return { positional, flags };
}

/** Split a comma list into a validated subset of `allowed`, preserving its order. */
export function pickSubset(raw, allowed, label) {
  if (raw === undefined) return [...allowed];
  const want = new Set(
    String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const unknown = [...want].filter((w) => !allowed.includes(w));
  if (unknown.length) {
    throw new Error(
      `unknown ${label}: ${unknown.join(', ')} (have ${allowed.join(', ')})`,
    );
  }
  return allowed.filter((a) => want.has(a));
}

// ───────────────────────────────────────────────────────────────────────────
// The trajectory (pure)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build one recorded drag from the scrubber's box and a velocity entry.
 *
 * Pure and total: same box + same velocity ⇒ same steps, every time, in every
 * variant. `tMs` is the SCHEDULED offset from pointer-down; the driver waits
 * until that offset rather than sleeping a fixed amount per step, so CDP
 * round-trip cost does not accumulate into drift.
 */
export function buildTrajectory(box, velocity) {
  const y = Math.round(box.y + box.height / 2);
  const x0 = box.x + box.width * DRAG_START_FRACTION;
  const distancePx = box.width * velocity.spanFraction;
  const durationMs = Math.max(
    DRAG_STEP_MS,
    (distancePx / velocity.pxPerSec) * 1000,
  );
  const steps = Math.max(DRAG_MIN_STEPS, Math.round(durationMs / DRAG_STEP_MS));
  const moves = [];
  for (let i = 1; i <= steps; i++) {
    moves.push({
      x: Math.round(x0 + (distancePx * i) / steps),
      y,
      tMs: Math.round((durationMs * i) / steps),
    });
  }
  return {
    name: velocity.name,
    pxPerSecNominal: velocity.pxPerSec,
    startX: Math.round(x0),
    y,
    distancePx: Math.round(distancePx),
    durationMs: Math.round(durationMs),
    dwellMs: DRAG_DWELL_MS,
    steps: moves,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Page-side code
//
// Every function below is serialized into the browser by Playwright, so it may
// reference ONLY its own arguments and browser globals — never module scope.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Installed via `addInitScript`, i.e. BEFORE any app code runs.
 *
 * Two things matter about the ordering. First, the probe bag must exist before
 * the first layer initialises or the earliest samples are lost. Second — and
 * this is why the channels are PRE-CREATED here — `emit()` only allocates a
 * channel array when it is missing, so pre-creating the arrays with a wrapped
 * `push` gives us an exact, ordered, exactly-timestamped copy of every sample
 * at the moment it is emitted. Polling would blur channel interleaving, and the
 * G7 assertion is precisely a question about ordering.
 *
 * `_legacyEnabled` is set alongside `enabled`: the layers package's scoped
 * `acquireProbe()` consumers turn the bag OFF again when the last one releases
 * (an unmounting HUD would silently end the capture), and the legacy flag makes
 * this harness a durable consumer that no release can disable.
 *
 * The underlying arrays are never spliced. The playback governor attributes
 * `bytesDuringScrub` by windowing `__sttProbe.requests` itself, and a harness
 * that drained that channel would read its own zero back.
 */
function installScrubProbe(opts) {
  const bag = (globalThis.__sttProbe ??= {});
  bag.enabled = true;
  bag.captureSamples = true;
  bag._legacyEnabled = true;

  const S = (globalThis.__sttScrub = {
    version: opts.version,
    /** Ordered, push-time-stamped samples across every stamped channel. */
    events: [],
    /** Ordered `setInteractive` calls seen on the live tilesets. */
    interactive: [],
    /** rAF timestamps, collected only while a drag is armed. */
    frames: [],
    frameArmed: false,
    notes: [],
    handles: null,
  });

  // The sink is cleared per drag, so it only ever has to survive one warmup.
  // Cap it anyway: a heavy composite emits thousands of request samples a
  // second, and an operator who raises WARMUP_MS should not run the page out of
  // heap before the first drag.
  const SINK_CAP = 200000;

  for (const name of opts.channels) {
    const arr = bag[name] ?? [];
    const origPush = Array.prototype.push;
    arr.push = function (...items) {
      const t = performance.now();
      for (const it of items) S.events.push({ ch: name, t, sample: it });
      if (S.events.length > SINK_CAP) {
        S.events.splice(0, S.events.length - SINK_CAP);
        S.truncated = true;
      }
      return origPush.apply(this, items);
    };
    bag[name] = arr;
  }

  const tick = (t) => {
    if (S.frameArmed) S.frames.push(t);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * Find the live governor and tileset(s) by walking the React fiber tree.
 *
 * There is no debug global to read — deliberately, since adding one would be a
 * showcase call site, which this item may not create. React's DOM nodes carry a
 * `__reactFiber$…` back-pointer in development builds, and the fiber tree holds
 * both the `PlaybackGovernor` (a prop of the transport bar) and the deck.gl
 * layer instances (props of `<DeckGL layers={…}>`), whose `state.tileset` is
 * the live `SpatioTemporalTileset` after deck's layer matching transfers state
 * onto the incoming instance.
 *
 * Everything is duck-typed and every hit is verified before use, so a fiber
 * internal renamed by a React upgrade degrades to "handle not found" — reported
 * honestly — rather than to a wrong measurement.
 */
function installScrubHandles() {
  const S = globalThis.__sttScrub;
  if (!S) return { ok: false, reason: 'probe not installed' };

  const isGovernor = (o) =>
    !!o &&
    typeof o === 'object' &&
    typeof o.getScrubQoeStats === 'function' &&
    typeof o.beginScrub === 'function' &&
    typeof o.getQoeStats === 'function';

  const isTileset = (o) =>
    !!o &&
    typeof o === 'object' &&
    typeof o.setInteractive === 'function' &&
    typeof o.setOptions === 'function' &&
    !!o.options &&
    typeof o.options === 'object' &&
    'scrubLod' in o.options;

  const governors = new Set();
  const tilesets = new Set();
  const seen = new Set();

  const consider = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 3) return;
    if (seen.has(o)) return;
    seen.add(o);
    if (isGovernor(o)) governors.add(o);
    if (isTileset(o)) tilesets.add(o);
    // deck.gl layer instances hang off props as arrays (possibly nested); the
    // tileset lives on `layer.state`.
    if (Array.isArray(o)) {
      for (const v of o) consider(v, depth + 1);
      return;
    }
    if (o.state && typeof o.state === 'object' && isTileset(o.state.tileset)) {
      tilesets.add(o.state.tileset);
    }
    // Second route to the same tilesets: the live Deck's LayerManager. The
    // props array carries the instances deck matched state ONTO, which is
    // normally the same object — but it misses sublayers, and it goes stale if
    // React has re-rendered since. Asking deck directly is authoritative.
    const lm = o.layerManager;
    if (lm && typeof lm.getLayers === 'function') {
      let layers = null;
      try {
        layers = lm.getLayers();
      } catch {
        layers = null;
      }
      if (Array.isArray(layers)) {
        for (const l of layers) {
          if (l?.state && isTileset(l.state.tileset))
            tilesets.add(l.state.tileset);
        }
      }
    }
    // Plain carrier objects (`{ governor, timeController }` bundles and the
    // like) are common as a single prop; descend one level rather than miss
    // a handle that is one hop away.
    if (Object.getPrototypeOf(o) === Object.prototype) {
      for (const v of Object.values(o)) consider(v, depth + 1);
    }
  };

  const fiberKey = (el) =>
    Object.keys(el).find(
      (k) =>
        k.startsWith('__reactFiber$') ||
        k.startsWith('__reactInternalInstance$'),
    );

  let root = null;
  for (const el of document.querySelectorAll('canvas, input, body')) {
    const k = fiberKey(el);
    if (!k) continue;
    let f = el[k];
    while (f && f.return) f = f.return;
    root = f;
    if (root) break;
  }
  if (!root) return { ok: false, reason: 'no React fiber found on the page' };

  const stack = [root];
  let visited = 0;
  while (stack.length && visited < 200000) {
    const f = stack.pop();
    if (!f) continue;
    visited++;
    consider(f.stateNode, 0);
    const props = f.memoizedProps;
    if (props && typeof props === 'object') {
      for (const v of Object.values(props)) consider(v, 1);
    }
    // Hook chain: `useRef` stores `{current}`, `useState` stores the value.
    let hook = f.memoizedState;
    let guard = 0;
    while (hook && typeof hook === 'object' && guard++ < 64) {
      const ms = hook.memoizedState;
      consider(ms, 1);
      if (ms && typeof ms === 'object' && 'current' in ms)
        consider(ms.current, 1);
      hook = hook.next;
    }
    if (f.child) stack.push(f.child);
    if (f.sibling) stack.push(f.sibling);
  }

  const governor = [...governors][0] ?? null;
  const tilesetList = [...tilesets];

  // Observe the restore invariant: record every interactive-bit broadcast in
  // order, with a push-time stamp comparable to the probe channels'. Pure
  // observation — the original is always called, and the wrapper is idempotent.
  for (const ts of tilesetList) {
    if (ts.__sttScrubWrapped) continue;
    const orig = ts.setInteractive.bind(ts);
    ts.setInteractive = (v) => {
      S.interactive.push({ value: !!v, t: performance.now() });
      return orig(v);
    };
    ts.__sttScrubWrapped = true;
  }

  S.handles = { governor, tilesets: tilesetList };
  return {
    ok: true,
    governor: governor !== null,
    tilesets: tilesetList.length,
    fibersVisited: visited,
    scrubLodNow: tilesetList.map((t) => t.options.scrubLod ?? null),
    // `isInteractive` is a public getter; its presence is what makes the
    // rollback drill's behavioral half observable.
    interactiveGetter: tilesetList.every((t) => 'isInteractive' in t),
  };
}

/**
 * Apply (or clear) the motion tier on every live tileset, and keep it applied.
 *
 * The consuming layer re-syncs `scrubLod: this.props.scrubLod ?? undefined`
 * onto the tileset on every update pass, and `setOptions` treats a PRESENT
 * `undefined` as "reset this key to its default" — so a one-shot override is
 * clobbered by the next React render. The instance's `setOptions` is therefore
 * wrapped to re-assert the override, and unwrapped when the variant ends.
 *
 * `cfg === null` clears: the wrapper is removed and `{scrubLod: undefined}` is
 * pushed, which is the documented way to switch the motion tier back off. That
 * restoration is the behavioral half of the rollback drill.
 */
function applyScrubLod(cfg) {
  const S = globalThis.__sttScrub;
  if (!S?.handles) return { ok: false, reason: 'handles not installed' };
  const applied = [];
  for (const ts of S.handles.tilesets) {
    if (cfg === null) {
      if (ts.__sttScrubSetOptions) {
        ts.setOptions = ts.__sttScrubSetOptions;
        delete ts.__sttScrubSetOptions;
      }
      ts.setOptions({ scrubLod: undefined });
    } else {
      if (!ts.__sttScrubSetOptions) {
        ts.__sttScrubSetOptions = ts.setOptions.bind(ts);
        ts.setOptions = (opts) =>
          ts.__sttScrubSetOptions({ ...opts, scrubLod: cfg });
      }
      ts.setOptions({});
    }
    applied.push(ts.options.scrubLod ?? null);
  }
  return { ok: true, applied };
}

/**
 * Clear the per-drag sinks and arm the frame counter.
 *
 * `__sttProbe.requests` is truncated (not spliced away) so the governor's own
 * byte attribution for the coming bracket sees exactly this drag's requests —
 * the same window it would see in production, just without the warmup's
 * history in front of it.
 */
function armDrag() {
  const S = globalThis.__sttScrub;
  const bag = globalThis.__sttProbe ?? {};
  S.events.length = 0;
  S.interactive.length = 0;
  S.frames.length = 0;
  S.frameArmed = true;
  for (const ch of ['scrub', 'playback', 'requests']) {
    if (Array.isArray(bag[ch])) bag[ch].length = 0;
  }
  const g = S.handles?.governor ?? null;
  return {
    armedAt: performance.now(),
    qoeBefore: g ? g.getQoeStats() : null,
    stateBefore: g ? g.state : null,
  };
}

/** Snapshot the governor's live scrub counters (for settle-close polling). */
function readScrubStats() {
  const S = globalThis.__sttScrub;
  const g = S?.handles?.governor ?? null;
  if (!g) return null;
  return {
    scrub: g.getScrubQoeStats(),
    qoe: g.getQoeStats(),
    state: g.state,
    isScrubbing: g.isScrubbing,
  };
}

/** Drain everything the drag produced, plus the tilesets' post-drag state. */
function harvestDrag() {
  const S = globalThis.__sttScrub;
  S.frameArmed = false;
  const g = S.handles?.governor ?? null;
  const frames = S.frames.slice();
  const deltas = [];
  for (let i = 1; i < frames.length; i++)
    deltas.push(frames[i] - frames[i - 1]);
  deltas.sort((a, b) => a - b);
  const pct = (q) =>
    deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * q))] ?? null;
  const mean = deltas.length
    ? deltas.reduce((s, x) => s + x, 0) / deltas.length
    : null;
  return {
    events: S.events.slice(),
    interactive: S.interactive.slice(),
    // Raw rAF timestamps (performance.now() domain, same clock as the probe
    // channels) so the driver can find the first frame AFTER the first preview
    // rather than the first frame after arming.
    frames,
    frameCount: frames.length,
    dragFps: mean ? 1000 / mean : null,
    dragP95Ms: pct(0.95),
    qoeAfter: g ? g.getQoeStats() : null,
    scrubAfter: g ? g.getScrubQoeStats() : null,
    stateAfter: g ? g.state : null,
    // The rollback drill's behavioral half: what the tileset believes now.
    tilesets: (S.handles?.tilesets ?? []).map((t) => ({
      scrubLod: t.options.scrubLod ?? null,
      isInteractive: 'isInteractive' in t ? !!t.isInteractive : null,
    })),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Analysis (pure)
// ───────────────────────────────────────────────────────────────────────────

/** Nearest-rank median over numbers, ignoring null/NaN. `null` when empty. */
export function median(values) {
  const xs = values
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (xs.length === 0) return null;
  return xs[Math.floor((xs.length - 1) / 2)];
}

/** Round to `d` decimals, passing null through. */
export function round(v, d = 2) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

/**
 * Fold one drag's raw capture into the five recorded metrics plus the two
 * invariant assertions.
 *
 * `scrubEnd` is the governor's own bracket roll-up, emitted on the `scrub`
 * channel at release. `settleMs` is taken from the POST-drag polling instead,
 * because the channel sample is emitted the instant the bracket closes — when a
 * pending settle has by definition barely started.
 */
export function summarizeDrag(raw) {
  const events = raw.capture.events ?? [];
  const scrubStart = events.find(
    (e) => e.ch === 'scrub' && e.sample?.event === 'scrubstart',
  );
  const scrubEnd = events.find(
    (e) => e.ch === 'scrub' && e.sample?.event === 'scrubend',
  );
  const s = scrubEnd?.sample ?? null;

  // Bracket edges. The governor stamps `startedAtWall` / `endedAtWall` on its
  // own `performance.now()` clock — the same clock this harness stamps pushes
  // with — so the two are directly comparable. Prefer the governor's own edges
  // and fall back to the push stamps.
  const t0 = s?.startedAtWall ?? scrubStart?.t ?? null;
  const t1 = s?.endedAtWall ?? scrubEnd?.t ?? null;

  // Byte attribution, computed independently of the governor as a cross-check:
  // requests that COMPLETED inside the bracket and actually occupied a slot
  // (`dispatchedAt === 0` means superseded while queued — no bytes moved).
  let harnessBytes = 0;
  let harnessRequests = 0;
  if (t0 !== null && t1 !== null) {
    for (const e of events) {
      if (e.ch !== 'requests') continue;
      const r = e.sample ?? {};
      if (r.dispatchedAt === 0) continue;
      if (typeof r.bytes !== 'number' || typeof r.completedAt !== 'number') {
        continue;
      }
      if (r.completedAt < t0 || r.completedAt > t1) continue;
      harnessBytes += r.bytes;
      harnessRequests++;
    }
  }

  // ── The two do-not-touch invariants, observed ────────────────────────────
  const violations = [];
  const assertions = {};

  // G7: no gate may start the clock while the thumb is held. The escape hatch
  // is suppressed under a held thumb too, so a degraded resume inside the
  // bracket is the same violation by another route.
  if (t0 === null || t1 === null) {
    assertions.previewNeverGates = 'UNOBSERVED';
  } else {
    // The `playback` channel carries no timestamp of its own, so these are
    // windowed on the harness's push stamps — which is exact, because the
    // stamp is taken inside `push` at the moment `emit` calls it.
    const startedClock = events.filter(
      (e) =>
        e.ch === 'playback' &&
        e.t > (scrubStart?.t ?? t0) &&
        e.t < (scrubEnd?.t ?? t1) &&
        e.sample?.event === 'statechange' &&
        e.sample?.state === 'playing',
    );
    // The escape hatch (maxStartWaitMs) is suppressed under a held thumb too,
    // so a degraded resume inside the bracket is the same violation by another
    // route. Every `playback` sample carries the full PlaybackQoeStats, so the
    // counter is read AT BRACKET CLOSE rather than after the settle window —
    // a degraded resume AFTER release is the escape hatch doing its job, and
    // must not be charged to the drag.
    const resumeBefore = raw.armed?.qoeBefore?.degradedResumeCount ?? null;
    let resumeEnd = resumeBefore;
    for (const e of events) {
      if (e.ch !== 'playback') continue;
      if (e.t < (scrubStart?.t ?? t0) || e.t > (scrubEnd?.t ?? t1)) continue;
      const c = e.sample?.degradedResumeCount;
      if (typeof c === 'number') resumeEnd = c;
    }
    const escaped =
      resumeBefore !== null && resumeEnd !== null
        ? resumeEnd - resumeBefore
        : null;
    if (startedClock.length > 0) {
      violations.push(
        `G7 preview-never-gates: the clock entered 'playing' ${startedClock.length}× while the thumb was held`,
      );
    }
    if (escaped !== null && escaped > 0) {
      violations.push(
        `G7 preview-never-gates: degradedResumeCount rose by ${escaped} across the drag (the escape hatch must stay suppressed under a held thumb)`,
      );
    }
    assertions.previewNeverGates =
      startedClock.length === 0 && (escaped ?? 0) === 0 ? 'HELD' : 'VIOLATED';
  }

  // Restore invariant: the fine tier is restored BEFORE the commit's readiness
  // is measured — i.e. the last interactive broadcast of the bracket is
  // `false`, it lands no later than the bracket's close, and nothing re-asserts
  // it afterwards.
  const ib = raw.capture.interactive ?? [];
  if (ib.length === 0) {
    assertions.restoreInvariant = 'UNOBSERVED';
  } else {
    const last = ib[ib.length - 1];
    const lateTrue = ib.some(
      (x) => x.value === true && t1 !== null && x.t > t1,
    );
    const restoredInTime =
      last.value === false && (t1 === null || last.t <= t1 + 1);
    if (!restoredInTime || lateTrue) {
      violations.push(
        `restore invariant: the motion tier was not restored before the bracket closed (last bit ${last.value} at ${round(last.t)}ms, bracket close ${round(t1)}ms)`,
      );
    }
    assertions.restoreInvariant =
      restoredInTime && !lateTrue ? 'HELD' : 'VIOLATED';
  }

  // Did the governor wiring run at all? The interactive bit is broadcast on
  // EVERY drag, enabled or not — with no axis on it is stored state and
  // nothing else (the kill switch) — so this proves the governor→source wiring
  // fired, NOT that a tier changed.
  const sawInteractive = ib.some((x) => x.value === true);
  assertions.interactiveBitObserved =
    ib.length === 0 ? 'UNOBSERVED' : sawInteractive ? 'YES' : 'NO';

  // Whether a motion tier was actually configured on the tilesets at harvest —
  // the check that keeps an "enabled" run that silently measured the baseline
  // from being reported as a result.
  const tsAfter = raw.capture.tilesets ?? [];
  assertions.motionTierConfigured =
    tsAfter.length === 0
      ? 'UNOBSERVED'
      : tsAfter.every((t) => t.scrubLod && t.scrubLod.spatial === true)
        ? 'YES'
        : tsAfter.some((t) => t.scrubLod && t.scrubLod.spatial === true)
          ? 'PARTIAL'
          : 'NO';

  // The render-side companion to time-to-first-pixel: the first rAF callback
  // that ran AFTER the first preview. An upper bound on how long the user
  // waited for *a* frame; it says nothing about what that frame contained.
  const frames = raw.capture.frames ?? [];
  const firstAfter = t0 === null ? undefined : frames.find((f) => f >= t0);
  const firstFrameAfterGrabMs =
    firstAfter === undefined || t0 === null ? null : firstAfter - t0;

  return {
    variant: raw.variant,
    velocity: raw.velocity,
    repeat: raw.repeat,
    trajectory: {
      pxPerSecNominal: raw.trajectory.pxPerSecNominal,
      pxPerSecActual: round(raw.actualPxPerSec),
      distancePx: raw.trajectory.distancePx,
      durationMsNominal: raw.trajectory.durationMs,
      durationMsActual: round(raw.actualDurationMs),
      steps: raw.trajectory.steps.length,
      dwellMs: raw.trajectory.dwellMs,
    },
    metrics: {
      // 1. time-to-first-pixel (governor: data-readiness lower bound)
      timeToFirstPixelMs: round(s?.timeToFirstPixelMs ?? null),
      firstFrameAfterGrabMs: round(firstFrameAfterGrabMs),
      // 2. fresh-frame fraction
      freshFrameFraction: round(s?.freshFrameFraction ?? null, 4),
      // 3. bytes during scrub (governor attribution + harness cross-check)
      bytesDuringScrub: s?.bytesDuringScrub ?? null,
      bytesDuringScrubHarness: harnessBytes,
      requestsDuringScrub: harnessRequests,
      // 4. settle to full detail (post-drag polling, not the release snapshot)
      settleMs: round(raw.settle?.settleMs ?? null),
      settleClosed: raw.settle?.closed ?? null,
      // 5. pop / oscillation
      tierSwitchCount: s?.tierSwitchCount ?? null,
      interactiveBroadcasts: ib.length,
      // Render-side companion, honestly labelled as such.
      dragFps: round(raw.capture.dragFps),
      dragP95Ms: round(raw.capture.dragP95Ms),
      dragFrames: raw.capture.frameCount,
      // QoE deltas across the drag
      stallsDuringDrag:
        raw.armed?.qoeBefore && raw.capture.qoeAfter
          ? raw.capture.qoeAfter.stallCount - raw.armed.qoeBefore.stallCount
          : null,
    },
    assertions,
    violations,
    bracketMs: t0 !== null && t1 !== null ? round(t1 - t0) : null,
    tilesetsAfter: raw.capture.tilesets ?? [],
  };
}

/**
 * Fold the per-drag summaries into the keep-vs-delete matrix: one row per
 * velocity, one column per variant, medians over repeats.
 *
 * Medians (not means) because a single unlucky drag that caught a decode burst
 * should not carry the column.
 */
export function buildMatrix(drags) {
  const NUMERIC = [
    'timeToFirstPixelMs',
    'firstFrameAfterGrabMs',
    'freshFrameFraction',
    'bytesDuringScrub',
    'bytesDuringScrubHarness',
    'requestsDuringScrub',
    'settleMs',
    'tierSwitchCount',
    'dragFps',
    'dragP95Ms',
  ];
  const matrix = {};
  for (const d of drags) {
    const row = (matrix[d.velocity] ??= {});
    const cell = (row[d.variant] ??= { n: 0, samples: [] });
    cell.n++;
    cell.samples.push(d.metrics);
  }
  for (const row of Object.values(matrix)) {
    for (const variant of Object.keys(row)) {
      const cell = row[variant];
      const m = {};
      for (const k of NUMERIC) {
        m[k] = round(median(cell.samples.map((s) => s[k])), 4);
      }
      row[variant] = { n: cell.n, median: m };
    }
    const base = row.baseline?.median;
    const on = row.scrublod?.median;
    if (base && on) {
      row.delta = {
        bytesDuringScrub: numDelta(base.bytesDuringScrub, on.bytesDuringScrub),
        bytesRatio:
          typeof base.bytesDuringScrub === 'number' && base.bytesDuringScrub > 0
            ? round(on.bytesDuringScrub / base.bytesDuringScrub, 3)
            : null,
        timeToFirstPixelMs: numDelta(
          base.timeToFirstPixelMs,
          on.timeToFirstPixelMs,
        ),
        freshFrameFraction: numDelta(
          base.freshFrameFraction,
          on.freshFrameFraction,
          4,
        ),
        settleMs: numDelta(base.settleMs, on.settleMs),
        dragFps: numDelta(base.dragFps, on.dragFps),
      };
    }
  }
  return matrix;
}

function numDelta(a, b, d = 2) {
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  return round(b - a, d);
}

/**
 * Apply §11.6's recorded criteria to the matrix.
 *
 * Deliberately NOT a single score. Each criterion is reported separately with
 * its own verdict, because the byte-discipline one is hard (a motion tier that
 * fetches more than full detail is worse than nothing) while the others are
 * targets. `UNDETERMINED` is a first-class outcome — a criterion whose inputs
 * were never observed must not read as a pass.
 */
export function evaluateDecision(matrix, opts = {}) {
  const perVelocity = {};
  for (const [velocity, row] of Object.entries(matrix)) {
    const base = row.baseline?.median;
    const on = row.scrublod?.median;
    if (!base || !on) {
      perVelocity[velocity] = {
        byteDiscipline: 'UNDETERMINED',
        timeToFirstPixel: 'UNDETERMINED',
        freshFrame: 'UNDETERMINED',
        popCount: 'UNDETERMINED',
        reason: 'both variants are needed for a comparison',
      };
      continue;
    }
    const v = {};
    v.byteDiscipline =
      typeof base.bytesDuringScrub === 'number' &&
      typeof on.bytesDuringScrub === 'number'
        ? on.bytesDuringScrub <= base.bytesDuringScrub
          ? 'PASS'
          : 'FAIL'
        : 'UNDETERMINED';
    v.timeToFirstPixel =
      typeof on.timeToFirstPixelMs === 'number'
        ? on.timeToFirstPixelMs < FRAME_MS_60HZ
          ? 'PASS'
          : 'FAIL'
        : 'UNDETERMINED';
    v.freshFrame =
      typeof base.freshFrameFraction === 'number' &&
      typeof on.freshFrameFraction === 'number'
        ? on.freshFrameFraction >= base.freshFrameFraction
          ? 'PASS'
          : 'FAIL'
        : 'UNDETERMINED';
    v.popCount =
      typeof on.tierSwitchCount === 'number'
        ? on.tierSwitchCount >= 1 && on.tierSwitchCount <= 2
          ? 'PASS'
          : 'FAIL'
        : 'UNDETERMINED';
    perVelocity[velocity] = v;
  }

  const all = Object.values(perVelocity);
  const anyFail = (k) => all.some((v) => v[k] === 'FAIL');
  const anyPass = (k) => all.some((v) => v[k] === 'PASS');
  const allFail = (k) => all.length > 0 && all.every((v) => v[k] === 'FAIL');

  // Byte discipline is the hard one: ANY velocity fetching more with the motion
  // tier on condemns this route. Fresh-frame is a target, so it condemns only
  // when EVERY velocity fails it.
  let routeVerdict;
  if (all.length === 0) routeVerdict = 'UNDETERMINED';
  else if (anyFail('byteDiscipline')) routeVerdict = 'FAILS-BYTE-DISCIPLINE';
  else if (allFail('freshFrame')) routeVerdict = 'FAILS-FRESH-FRAME';
  else if (anyPass('byteDiscipline')) routeVerdict = 'KEEP-CANDIDATE';
  else routeVerdict = 'UNDETERMINED';

  return {
    perVelocity,
    routeVerdict,
    // The standing clause is a THREE-route conjunction. One route cannot
    // condemn the wiring, and this harness will not pretend otherwise.
    scope:
      'ONE ROUTE. §11.6 slates the wiring for deletion only if the enabled state ' +
      'fails byte-discipline or fresh-frame on ALL THREE heavy routes ' +
      '(NYC taxi, /drive, BIXI). Run all three and read the verdicts together.',
    route: opts.route ?? null,
  };
}

/** The rollback drill: `scrubLod` off must be byte- and behavior-identical. */
export function evaluateRollback(drags) {
  const before = drags.filter((d) => d.variant === 'baseline');
  const after = drags.filter((d) => d.variant === 'baseline-after');
  if (before.length === 0 || after.length === 0) {
    return {
      verdict: 'UNDETERMINED',
      reason: 'the baseline-after variant was not run',
    };
  }
  // Behavioral half: after clearing the override, no tileset may still carry a
  // motion tier, and none may be left holding the interactive bit.
  const dirty = after.flatMap((d) =>
    (d.tilesetsAfter ?? []).filter(
      (t) => t.scrubLod !== null || t.isInteractive === true,
    ),
  );
  const b = median(before.map((d) => d.metrics.bytesDuringScrub));
  const a = median(after.map((d) => d.metrics.bytesDuringScrub));
  return {
    verdict: dirty.length === 0 ? 'BEHAVIOR-IDENTICAL' : 'DIRTY',
    dirtyTilesets: dirty.length,
    bytesBefore: b,
    bytesAfter: a,
    bytesRatio:
      typeof b === 'number' && b > 0 && typeof a === 'number'
        ? round(a / b, 3)
        : null,
    note:
      'Bytes are a live-network measurement, so the two baselines are compared as ' +
      'a sanity ratio, never asserted equal. The behavioral half — scrubLod back ' +
      'to null and the interactive bit clear — is the assertable part.',
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Reporting
// ───────────────────────────────────────────────────────────────────────────

const pad = (s, n) => String(s ?? '-').padEnd(n);
const padS = (s, n) => String(s ?? '-').padStart(n);
const kib = (b) => (typeof b === 'number' ? `${(b / 1024).toFixed(1)}K` : '-');

export function formatReport(out) {
  const L = [];
  L.push(
    `scrub-cost  ${out.route}  (${out.demoId})   harness v${out.harnessVersion}`,
  );
  L.push(
    `  handles: governor ${out.handles.governor ? 'yes' : 'NO'}, ` +
      `tilesets ${out.handles.tilesets}, ` +
      `motion tier applied: ${out.handles.scrubLodApplied ? 'yes' : 'NO'}`,
  );
  if (out.notes.length) for (const n of out.notes) L.push(`  ! ${n}`);
  L.push('');
  L.push(
    `  ${pad('velocity', 9)}${pad('variant', 15)}${padS('n', 3)}` +
      `${padS('TTFP ms', 9)}${padS('fresh%', 8)}${padS('bytes', 9)}` +
      `${padS('settle ms', 10)}${padS('pops', 6)}${padS('fps', 7)}`,
  );
  for (const velocity of Object.keys(out.matrix)) {
    const row = out.matrix[velocity];
    for (const variant of VARIANTS) {
      const cell = row[variant];
      if (!cell) continue;
      const m = cell.median;
      L.push(
        `  ${pad(velocity, 9)}${pad(variant, 15)}${padS(cell.n, 3)}` +
          `${padS(m.timeToFirstPixelMs ?? '-', 9)}` +
          `${padS(m.freshFrameFraction === null ? '-' : (m.freshFrameFraction * 100).toFixed(1), 8)}` +
          `${padS(kib(m.bytesDuringScrub), 9)}` +
          `${padS(m.settleMs ?? '-', 10)}` +
          `${padS(m.tierSwitchCount ?? '-', 6)}` +
          `${padS(m.dragFps ?? '-', 7)}`,
      );
    }
    if (row.delta) {
      L.push(
        `  ${pad('', 9)}${pad('Δ (on−off)', 15)}${padS('', 3)}` +
          `${padS(row.delta.timeToFirstPixelMs ?? '-', 9)}` +
          `${padS(row.delta.freshFrameFraction === null ? '-' : (row.delta.freshFrameFraction * 100).toFixed(1), 8)}` +
          `${padS(row.delta.bytesRatio === null ? '-' : `×${row.delta.bytesRatio}`, 9)}` +
          `${padS(row.delta.settleMs ?? '-', 10)}${padS('', 6)}` +
          `${padS(row.delta.dragFps ?? '-', 7)}`,
      );
    }
  }
  L.push('');
  L.push('  §11.6 criteria (enabled state):');
  for (const [velocity, v] of Object.entries(out.decision.perVelocity)) {
    L.push(
      `    ${pad(velocity, 9)} bytes ${pad(v.byteDiscipline, 14)} ` +
        `TTFP<16.7ms ${pad(v.timeToFirstPixel, 14)} ` +
        `fresh ${pad(v.freshFrame, 14)} pops ${v.popCount}`,
    );
  }
  L.push(`  route verdict: ${out.decision.routeVerdict}`);
  L.push(`  scope: ${out.decision.scope}`);
  L.push(
    `  rollback drill: ${out.rollback.verdict}` +
      (out.rollback.reason ? ` (${out.rollback.reason})` : ''),
  );
  L.push('');
  L.push(
    `  invariants: preview-never-gates ${summarizeAssertion(out.drags, 'previewNeverGates')}, ` +
      `restore ${summarizeAssertion(out.drags, 'restoreInvariant')}, ` +
      `motion tier configured ${summarizeAssertion(out.drags, 'motionTierConfigured')}, ` +
      `interactive bit ${summarizeAssertion(out.drags, 'interactiveBitObserved')}`,
  );
  L.push(
    '  note: `pops` counts interactive-bit broadcasts, which happen on EVERY ' +
      'drag. With the motion tier off the bit is stored state and nothing else ' +
      '(the kill switch), so a baseline `pops` of 2 is not visible popping — ' +
      'only the scrublod row describes real tier changes.',
  );
  if (out.violations.length) {
    L.push('');
    L.push(
      '  ✖ HARD FAILURE — an observed contract did not hold. This run is not a measurement:',
    );
    for (const v of out.violations) L.push(`      ${v}`);
  }
  if (out.errors.length) {
    L.push(`  ⚠  ${out.errors.length} console error(s); see the JSON`);
  }
  return L.join('\n');
}

function summarizeAssertion(drags, key) {
  const counts = new Map();
  for (const d of drags) {
    const v = d.assertions?.[key] ?? 'UNOBSERVED';
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()].map(([k, n]) => `${k}×${n}`).join(' ');
}

// ───────────────────────────────────────────────────────────────────────────
// The driver
// ───────────────────────────────────────────────────────────────────────────

/** One page load: warm up, apply the variant, run the recorded drag series. */
async function runVariant(page, cfg, variant) {
  const notes = [];
  await page.goto(`http://localhost:${cfg.port}${cfg.route}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForSelector('canvas', { timeout: 120000 });
  await page.waitForTimeout(cfg.warmupMs);

  // Start playback so the scene actually streams during warmup. The bar labels
  // the button by what it WILL do, so an 'play' aria-label means it is paused.
  const clickTransport = async (want) => {
    await page.evaluate((w) => {
      const b = [...document.querySelectorAll('button')].find((x) =>
        /play|pause/i.test(x.getAttribute('aria-label') ?? x.title ?? ''),
      );
      if (b && new RegExp(w, 'i').test(b.getAttribute('aria-label') ?? ''))
        b.click();
    }, want);
  };
  await clickTransport('play');
  await page.waitForTimeout(3000);

  const handles = await page.evaluate(installScrubHandles);
  if (!handles.ok) notes.push(`handle discovery failed: ${handles.reason}`);
  if (handles.ok && !handles.governor) {
    notes.push(
      'no PlaybackGovernor handle — settle-to-full-detail cannot be polled to closure',
    );
  }
  if (handles.ok && handles.tilesets === 0) {
    notes.push(
      'no SpatioTemporalTileset handle — the motion tier cannot be applied or observed',
    );
  }

  // Pause before the drag series so bytes-during-scrub attributes to the drag
  // rather than to background playback. The clock is frozen under a held thumb
  // anyway, so this narrows the measurement rather than changing it.
  if (!cfg.keepPlaying) {
    await clickTransport('pause');
    await page.waitForTimeout(cfg.quiesceMs);
  }

  let scrubLodApplied = false;
  if (variant === 'scrublod') {
    const r = await page.evaluate(applyScrubLod, {
      spatial: true,
      spatialZoomDrop: cfg.zoomDrop,
    });
    scrubLodApplied =
      r.ok &&
      r.applied.length > 0 &&
      r.applied.every((a) => a && a.spatial === true);
    if (!scrubLodApplied) {
      notes.push(
        `motion tier NOT applied (${r.reason ?? JSON.stringify(r.applied)}) — this variant is NOT the enabled state`,
      );
    }
  } else {
    const r = await page.evaluate(applyScrubLod, null);
    if (r.ok && r.applied.some((a) => a !== null)) {
      notes.push('a tileset still carried a scrubLod config in an off variant');
    }
  }

  const box = await (
    await page.waitForSelector(SCRUBBER_SELECTOR, { timeout: 30000 })
  ).boundingBox();
  if (!box)
    throw new Error(
      'the timeline scrubber has no bounding box (is it visible?)',
    );

  const drags = [];
  for (const velocity of cfg.velocities) {
    const spec = DRAG_VELOCITIES.find((v) => v.name === velocity);
    const trajectory = buildTrajectory(box, spec);
    for (let repeat = 0; repeat < cfg.repeat; repeat++) {
      await page.waitForTimeout(cfg.quiesceMs);
      const armed = await page.evaluate(armDrag);

      // ── The recorded drag ────────────────────────────────────────────────
      const wall0 = Date.now();
      await page.mouse.move(trajectory.startX, trajectory.y);
      await page.mouse.down();
      for (const step of trajectory.steps) {
        const delay = wall0 + step.tMs - Date.now();
        if (delay > 0) await page.waitForTimeout(delay);
        await page.mouse.move(step.x, step.y);
      }
      const moveEnd = Date.now();
      await page.waitForTimeout(trajectory.dwellMs);
      await page.mouse.up();

      // ── Settle-to-full-detail ────────────────────────────────────────────
      // Poll the governor: a PENDING settle is reported as elapsed-so-far, so
      // it grows monotonically; two equal reads mean the post-release gate let
      // go and the span closed.
      let settle = { settleMs: null, closed: null };
      const deadline = Date.now() + cfg.settleMs;
      let last = null;
      while (Date.now() < deadline) {
        await page.waitForTimeout(50);
        const snap = await page.evaluate(readScrubStats);
        if (!snap) {
          settle = { settleMs: null, closed: null };
          break;
        }
        const v = snap.scrub.settleMs;
        if (typeof v === 'number' && last !== null && v === last) {
          settle = { settleMs: v, closed: true };
          break;
        }
        last = typeof v === 'number' ? v : null;
        settle = { settleMs: v, closed: false };
      }

      const capture = await page.evaluate(harvestDrag);
      const actualDurationMs = moveEnd - wall0;
      drags.push(
        summarizeDrag({
          variant,
          velocity,
          repeat,
          trajectory,
          armed,
          capture,
          settle,
          actualDurationMs,
          actualPxPerSec:
            actualDurationMs > 0
              ? (trajectory.distancePx / actualDurationMs) * 1000
              : null,
        }),
      );
    }
  }

  return { drags, notes, box, handles, scrubLodApplied };
}

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help) {
    process.stdout.write(
      'node src/scrub-cost.mjs <demo-id> [port] [--variants a,b] [--velocities a,b]\n' +
        '                        [--zoom-drop N] [--repeat N] [--settle-ms N]\n' +
        '                        [--quiesce-ms N] [--keep-playing] [--out p] [--json]\n' +
        'env: WARMUP_MS, ROUTE, OUT_DIR\n',
    );
    return 0;
  }

  const demoId = positional[0] ?? 'earthquakes-v2';
  const cfg = {
    port: Number(positional[1] ?? 3000),
    route: process.env.ROUTE ?? `/demo/${demoId}`,
    warmupMs: Number(process.env.WARMUP_MS ?? 20000),
    zoomDrop: Number(flags['zoom-drop'] ?? 2),
    repeat: Math.max(1, Number(flags.repeat ?? 3)),
    settleMs: Number(flags['settle-ms'] ?? 6000),
    quiesceMs: Number(flags['quiesce-ms'] ?? 2000),
    keepPlaying: flags['keep-playing'] === true,
    velocities: pickSubset(
      flags.velocities,
      DRAG_VELOCITIES.map((v) => v.name),
      'velocity',
    ),
    variants: pickSubset(flags.variants, VARIANTS, 'variant'),
  };

  const outDir = process.env.OUT_DIR ?? path.join(repoRoot, 'tools/bench/out');
  const slug = (process.env.ROUTE ? cfg.route : demoId)
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const require = createRequire(import.meta.url);
  // CommonJS: `playwright` has no named ESM exports.
  const { chromium } = require(
    require.resolve('playwright', { paths: [repoRoot] }),
  );

  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 300));
  });

  await page.addInitScript(installScrubProbe, {
    version: HARNESS_VERSION,
    channels: STAMPED_CHANNELS,
  });

  const drags = [];
  const notes = [];
  const boxes = {};
  let handles = { governor: false, tilesets: 0, scrubLodApplied: false };

  fs.mkdirSync(outDir, { recursive: true });

  try {
    for (const variant of cfg.variants) {
      const r = await runVariant(page, cfg, variant);
      drags.push(...r.drags);
      for (const n of r.notes) notes.push(`[${variant}] ${n}`);
      boxes[variant] = r.box;
      handles = {
        governor: handles.governor || !!r.handles.governor,
        tilesets: Math.max(handles.tilesets, r.handles.tilesets ?? 0),
        scrubLodApplied: handles.scrubLodApplied || r.scrubLodApplied,
      };
      // One screenshot per variant, so a "cheap" reading cannot come from a
      // blank canvas. Never judged automatically — see the header.
      await page.screenshot({
        path: path.join(outDir, `scrub-cost-${slug}-${variant}.png`),
      });
    }
  } finally {
    await browser.close();
  }

  // The trajectories are only comparable if the geometry was.
  const boxKeys = Object.values(boxes).map((b) =>
    b ? `${Math.round(b.x)},${Math.round(b.width)}` : 'none',
  );
  if (new Set(boxKeys).size > 1) {
    notes.push(
      `geometryDrift: the scrubber box moved between variants (${boxKeys.join(' | ')})`,
    );
  }

  const matrix = buildMatrix(drags);
  const violations = drags.flatMap((d) =>
    d.violations.map((v) => `${d.variant}/${d.velocity}#${d.repeat}: ${v}`),
  );

  // ── Hollow-run guard ──────────────────────────────────────────────────────
  // A run that navigated, dragged, and wrote a file is NOT a measurement if no
  // drag produced a scrub bracket (the page had no governor / no data) or if
  // the enabled state was never actually achieved. Those must not exit 0: the
  // next reader would take "no violations, file written" for a result.
  const bracketed = drags.filter((d) => d.bracketMs !== null);
  const wantedEnabled = cfg.variants.includes('scrublod');
  if (bracketed.length === 0 && drags.length > 0) {
    notes.push(
      'HOLLOW RUN: not one drag produced a scrubstart/scrubend bracket. The page ' +
        'had no PlaybackGovernor wired (commonly: every archive failed to open), ' +
        'so none of the five §11.6 metrics exist. Nothing here is a measurement.',
    );
  }
  if (wantedEnabled && !handles.scrubLodApplied) {
    notes.push(
      'ENABLED STATE NOT ACHIEVED: the scrublod variant ran without the motion ' +
        'tier applied, so its column is a second baseline. Do not read it as the ' +
        'enabled state.',
    );
  }

  const out = {
    harnessVersion: HARNESS_VERSION,
    demoId,
    route: cfg.route,
    port: cfg.port,
    recordedAt: new Date().toISOString(),
    config: cfg,
    handles,
    geometry: boxes,
    drags,
    matrix,
    decision: evaluateDecision(matrix, { route: cfg.route }),
    rollback: evaluateRollback(drags),
    violations,
    notes,
    errors: errors.slice(0, 20),
  };

  const jsonPath = flags.out
    ? path.resolve(flags.out)
    : path.join(outDir, `scrub-cost-${slug}.json`);
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(out, null, 2)}\n`);

  process.stdout.write(`${formatReport(out)}\n  wrote ${jsonPath}\n`);
  if (flags.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);

  // 4 = a do-not-touch contract did not hold (the loudest outcome).
  // 3 = nothing was measured (no drags, or no drag produced a bracket).
  // 5 = the enabled state was requested but never achieved.
  if (violations.length) return 4;
  if (drags.length === 0 || bracketed.length === 0) return 3;
  if (wantedEnabled && !handles.scrubLodApplied) return 5;
  return 0;
}

const invokedDirectly =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
