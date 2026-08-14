/**
 * Tests for the deterministic client-policy trace-replay harness (P0-3).
 *
 * FIDELITY BOUNDARY (restated, because it governs what these tests may
 * assert): the replayer models POLICY DECISIONS ONLY — demand, speculation,
 * residency, eviction order, decode-queue occupancy. It models no GPU or
 * render feedback and no transport latency. Nothing here asserts a frame
 * rate, a millisecond of wall time, or a byte on the wire; those belong to
 * `frame-cost.mjs` and `cold-start.mjs`.
 *
 * Run with:  pnpm --filter @poopdeck.gl/bench test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_READ_COST_BYTES,
  MockClock,
  TRACE_VERSION,
  VARIANTS,
  blendedCost,
  buildUniverseFromTrace,
  canonicalJson,
  checkConservation,
  fnv1a64Hex,
  formatReport,
  parseKey,
  parseTrace,
  replay,
  serializeTrace,
} from '../src/policy-replay.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(here, '..');
const FIXTURE = path.join(here, 'fixtures', 'micro-loop-boundary.jsonl');
const fixtureText = fs.readFileSync(FIXTURE, 'utf8');

// ───────────────────────────────────────────────────── unit: trace parser ──

test('trace parser round-trips the committed micro-trace byte-identically', () => {
  const trace = parseTrace(fixtureText);
  assert.equal(trace.header.traceVersion, TRACE_VERSION);
  assert.equal(serializeTrace(trace), fixtureText);

  // ...and the object survives a second pass unchanged.
  const again = parseTrace(serializeTrace(trace));
  assert.deepEqual(again, trace);
});

test('the micro-trace is the hand-written ~20-event loop-boundary fixture', () => {
  const trace = parseTrace(fixtureText);
  assert.equal(trace.events.length, 21, 'header + 21 events = 22 lines');
  const byChannel = new Map();
  for (const e of trace.events) {
    byChannel.set(e.ch, (byChannel.get(e.ch) ?? 0) + 1);
  }
  assert.deepEqual([...byChannel.entries()].sort(), [
    ['decode', 2],
    ['evict', 1],
    ['requests', 8],
    ['viewport', 10],
  ]);
  // The loop boundary itself: the playhead sweeps forward, then WRAPS.
  const playheads = trace.events
    .filter((e) => e.ch === 'viewport')
    .map((e) => e.playheadMs);
  assert.deepEqual(
    playheads,
    [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 0, 1000],
  );
});

test('trace parser rejects malformed traces instead of replaying them', () => {
  const cases = [
    ['', /no header record/],
    ['{"ch":"viewport","tMs":0}\n', /no header record/],
    ['not json\n', /not JSON/],
    ['[1,2,3]\n', /must be an object/],
    ['{"traceVersion":1}\n', /missing string field "ch"/],
    ['{"ch":"header","traceVersion":99}\n', /trace version 99/],
    [
      '{"ch":"header","traceVersion":1}\n{"ch":"nope"}\n',
      /unknown channel "nope"/,
    ],
    [
      '{"ch":"header","traceVersion":1}\n{"ch":"header","traceVersion":1}\n',
      /second header record/,
    ],
  ];
  for (const [text, re] of cases) {
    assert.throws(
      () => parseTrace(text),
      re,
      `should reject: ${JSON.stringify(text)}`,
    );
  }
});

test('tile keys are parsed, never re-spelled (OPFS persistence contract)', () => {
  assert.deepEqual(parseKey('2/1/1/7000#0'), {
    z: 2,
    x: 1,
    y: 1,
    t: 7000,
    variantId: 0,
    bucketMs: undefined,
  });
  // Composite (renderer) keys and temporal-LOD suffixes both parse.
  assert.equal(parseKey('14/3/9/500#0::flows').t, 500);
  assert.equal(parseKey('14/3/9/500#1@3600000').bucketMs, 3600000);
  assert.equal(parseKey('garbage'), undefined);
});

// ─────────────────────────────────────────────────────── unit: mock clock ──

test('mock clock is integer-valued and strictly monotonic', () => {
  const c = new MockClock(0);
  assert.equal(c.nowMs, 0);
  assert.equal(c.advanceTo(1000), 1000);
  assert.equal(
    c.advanceTo(1000),
    1000,
    'advancing to now is a no-op, not an error',
  );
  assert.equal(c.advanceBy(250), 1250);
  assert.throws(() => c.advanceTo(999), /backwards/);
  assert.throws(() => c.advanceBy(-1), /non-negative integer/);
  assert.throws(() => c.advanceBy(1.5), /non-negative integer/);
  assert.throws(() => new MockClock(1.5), /integer/);
});

test('replay drives the mock clock and refuses a non-monotonic trace', () => {
  const header = {
    ch: 'header',
    traceVersion: TRACE_VERSION,
    route: 'unit/backwards',
    config: {
      temporalBucketMs: 1000,
      prefetchHorizonBuckets: 1,
      maxResidentTiles: 4,
    },
  };
  const vp = (tMs, playheadMs) => ({
    ch: 'viewport',
    tMs,
    playheadMs,
    timeWindowMs: 1000,
    zoom: 2,
    bounds: [-80, 10, -10, 60],
    direction: 1,
    animating: true,
  });
  const req = (t) => ({
    ch: 'requests',
    tMs: 0,
    key: `2/1/1/${t}#0`,
    priority: 0,
    bytes: 1000,
    enqueuedAt: 0,
    dispatchedAt: 1,
    completedAt: 2,
    source: 'unit',
  });
  const events = [req(0), req(1000), vp(0, 0), vp(1000, 1000)];
  assert.ok(replay({ header, events }).invariants.ok);

  const backwards = [req(0), req(1000), vp(1000, 1000), vp(0, 0)];
  assert.throws(() => replay({ header, events: backwards }), /backwards/);
});

// ─────────────────────────────────────────── unit: canonical serialization ──

test('canonical JSON is insertion-order independent and rejects non-finite', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalJson({ ch: 'x', a: 1 }), '{"ch":"x","a":1}');
  assert.equal(canonicalJson([]), '[]');
  assert.equal(canonicalJson({}), '{}');
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.throws(() => canonicalJson({ a: Infinity }), /non-finite/);
  assert.throws(() => canonicalJson({ a: Number.NaN }), /non-finite/);
  // -0 and 0 must not produce different bytes.
  assert.equal(canonicalJson({ a: -0 }), canonicalJson({ a: 0 }));
});

test('fnv1a64 digest is stable and content-sensitive', () => {
  assert.equal(fnv1a64Hex('abc'), fnv1a64Hex('abc'));
  assert.notEqual(fnv1a64Hex('abc'), fnv1a64Hex('abd'));
  assert.match(fnv1a64Hex(''), /^[0-9a-f]{16}$/);
});

// ────────────────────────────────────────────────────────── cost discipline ──

test('cost is ALWAYS blended bytes + g*reads, never request count alone', () => {
  const c = blendedCost({ bytesFetched: 1000, reads: 2, readCostBytes: 100 });
  assert.equal(c.model, 'bytes + g*reads');
  assert.equal(c.value, 1200);
  assert.equal(c.readCostBytes, 100);
  assert.equal(c.bytesFetched, 1000);
  assert.equal(c.reads, 2);

  // g defaults to the shipping range-coalescing gap (2 MiB), i.e. the reader's
  // own standing "one request ≈ this many bytes" estimate.
  assert.equal(DEFAULT_READ_COST_BYTES, 2 * 1024 * 1024);

  assert.throws(
    () => blendedCost({ bytesFetched: -1, reads: 0, readCostBytes: 1 }),
    /bytesFetched/,
  );
  assert.throws(
    () => blendedCost({ bytesFetched: 0, reads: 1.5, readCostBytes: 1 }),
    /reads/,
  );
});

test('GUARD: fewer reads does not make a 669 MiB answer cheaper', () => {
  // The do-not-touch register's anti-lesson, as an executable guard: an answer
  // with FEWER requests but vastly more bytes must never rank cheaper. This is
  // the exact shape of the "2 reads = cheapest" incident.
  const fewReadsHugeBytes = blendedCost({
    bytesFetched: 669 * 1024 * 1024,
    reads: 2,
    readCostBytes: DEFAULT_READ_COST_BYTES,
  });
  const manyReadsSmallBytes = blendedCost({
    bytesFetched: 4 * 1024 * 1024,
    reads: 40,
    readCostBytes: DEFAULT_READ_COST_BYTES,
  });
  assert.ok(fewReadsHugeBytes.reads < manyReadsSmallBytes.reads);
  assert.ok(
    fewReadsHugeBytes.value > manyReadsSmallBytes.value,
    'the byte term must dominate; ranking by read count alone is rejected',
  );
});

test('every report carries the blended cost and no bare request-count cost', () => {
  const trace = parseTrace(fixtureText);
  for (const name of VARIANTS.keys()) {
    const r = replay(trace, { variant: name });
    assert.equal(r.cost.model, 'bytes + g*reads');
    assert.equal(
      r.cost.value,
      r.cost.bytesFetched + r.cost.readCostBytes * r.cost.reads,
    );
    // `reads` survives only as a counter beside the bytes it cost.
    assert.equal(r.requests.reads, r.cost.reads);
    assert.notEqual(r.cost.value, r.cost.reads);
  }
});

// ──────────────────────────────────── simulation: the pinned incumbent before ──

/**
 * THE BASELINE PIN. These numbers are the incumbent eviction policy's
 * behaviour on the loop-boundary micro-trace, and they are the "before" any
 * Phase 1 eviction change is measured against. If this test goes red because
 * a policy changed, that is the signal — re-pin deliberately, in the item that
 * changed the policy, and record the delta.
 */
test('SIMULATION: the incumbent demonstrably refetches at the loop boundary', () => {
  const trace = parseTrace(fixtureText);
  const r = replay(trace, { variant: 'incumbent' });

  assert.equal(r.trace.steps, 10);
  assert.equal(r.trace.universeTiles, 8);
  assert.equal(r.trace.universeSource, 'trace');

  // Reads and bytes.
  assert.equal(r.cost.reads, 10, 'eight distinct tiles + two refetches');
  assert.equal(r.cost.bytesFetched, 129000);
  assert.equal(r.cost.value, 129000 + DEFAULT_READ_COST_BYTES * 10);

  // THE PATHOLOGY. Linear playhead distance ranks buckets 0 and 1000 as
  // "furthest behind" just before the wrap, so they are evicted — and they are
  // exactly what the wrap demands next.
  assert.equal(r.refetch.cycles, 2);
  assert.equal(r.refetch.onDemand, 1, 'a user-visible miss at the wrap');
  assert.equal(r.refetch.onPrefetch, 1);
  assert.equal(r.refetch.bytes, 21000);
  assert.equal(r.requests.priorityMisses, 2);

  // Eviction attribution, per tier, and the runway signal.
  assert.equal(r.eviction.total, 4);
  assert.deepEqual(r.eviction.byTier, { a: 0, b: 2, c: 2, d: 0 });
  assert.equal(r.eviction.runwayEvictions, 2);
  assert.equal(r.eviction.bytesEvicted, 54000);
  assert.equal(r.eviction.graceEvictions, 0);

  // Residency stayed inside the declared limits after each pass.
  assert.equal(r.residency.tilesResident, 6);
  assert.ok(r.residency.tilesResident <= r.params.maxResidentTiles);
  assert.equal(r.residency.bytesResident, 75000);

  // Runway held (the pathology shows up as refetch, not as a stall).
  assert.equal(r.runway.violations, 0);
  assert.equal(r.runway.minRunwayMs, 1000);
});

test('SIMULATION: each variant behaves as its model predicts', () => {
  const trace = parseTrace(fixtureText);
  const r = Object.fromEntries(
    [...VARIANTS.keys()].map((n) => [n, replay(trace, { variant: n })]),
  );

  // Plain LRU — the pre-tiering control — is the worst of the four, which is
  // why the tiering exists.
  assert.equal(r.lru.refetch.cycles, 3);
  assert.ok(r.lru.cost.value > r.incumbent.cost.value);

  // A loop-aware distance and the offline optimum both avoid the wrap miss
  // entirely: zero demand refetches, and strictly fewer refetch cycles and
  // reads than the incumbent.
  for (const name of ['loop-aware', 'belady']) {
    assert.equal(
      r[name].refetch.onDemand,
      0,
      `${name}: no user-visible wrap miss`,
    );
    assert.ok(r[name].refetch.cycles < r.incumbent.refetch.cycles, name);
    assert.ok(r[name].cost.reads < r.incumbent.cost.reads, name);
    assert.ok(r[name].cost.value < r.incumbent.cost.value, name);
  }

  // Belady is the bound, so nothing may beat it on the blended cost.
  for (const name of Object.keys(r)) {
    assert.ok(
      r[name].cost.value >= r.belady.cost.value,
      `${name} beat the offline optimum — the oracle or the sim is wrong`,
    );
  }
  assert.equal(r.belady.variantKind, 'oracle-bound');
  assert.equal(r.incumbent.variantKind, 'policy');
});

test('demand is derived from the trajectory, not from what the recorder fetched', () => {
  // The recorded trace fetches each of the 8 tiles exactly once. A variant
  // that holds more in cache must be CREDITED with hits rather than penalised
  // by the absence of a recorded request — so hits must exceed the recorded
  // request count.
  const trace = parseTrace(fixtureText);
  const recordedRequests = trace.events.filter(
    (e) => e.ch === 'requests',
  ).length;
  assert.equal(recordedRequests, 8);
  const r = replay(trace, { variant: 'incumbent' });
  assert.ok(
    r.requests.priorityHits + r.requests.prefetchHits > recordedRequests,
  );
});

test('byte sizes come from measured entries, never from a size model', () => {
  const trace = parseTrace(fixtureText);
  const { universe, conflicts } = buildUniverseFromTrace(trace.events);
  assert.equal(conflicts, 0);
  assert.equal(universe.size, 8);
  // Exactly the sizes the trace recorded — nothing interpolated or fitted.
  assert.deepEqual(
    [...universe.values()].sort((a, b) => a.t - b.t).map((m) => m.bytes),
    [10000, 11000, 12000, 13000, 14000, 15000, 16000, 17000],
  );
  const firstPassBytes =
    10000 + 11000 + 12000 + 13000 + 14000 + 15000 + 16000 + 17000;
  const r = replay(trace, { variant: 'incumbent' });
  assert.equal(r.cost.bytesFetched, firstPassBytes + r.refetch.bytes);
});

// ─────────────────────────────────────────────────────────────  determinism ──

test('DETERMINISM: same trace + same variant ⇒ byte-identical JSON report', () => {
  const a = parseTrace(fixtureText);
  const b = parseTrace(fixtureText);
  for (const name of VARIANTS.keys()) {
    const first = formatReport(replay(a, { variant: name }));
    const second = formatReport(replay(b, { variant: name }));
    assert.equal(first, second, `variant ${name} is not deterministic`);
    // A third run from a freshly re-serialized trace must agree too: no
    // dependence on object identity or Map insertion history.
    const third = formatReport(
      replay(parseTrace(serializeTrace(a)), { variant: name }),
    );
    assert.equal(
      first,
      third,
      `variant ${name} depends on trace object identity`,
    );
  }
});

test('DETERMINISM: distinct variants produce distinct reports (no accidental alias)', () => {
  const trace = parseTrace(fixtureText);
  const seen = new Set();
  for (const name of VARIANTS.keys()) {
    seen.add(formatReport(replay(trace, { variant: name })));
  }
  assert.equal(seen.size, VARIANTS.size);
});

test('DETERMINISM: the report contains no wall clock and no floating-point drift', () => {
  const trace = parseTrace(fixtureText);
  const text = formatReport(replay(trace, { variant: 'incumbent' }));
  const report = JSON.parse(text);
  // Every numeric leaf is an integer.
  const walk = (v, at) => {
    if (typeof v === 'number') {
      assert.ok(Number.isSafeInteger(v), `${at} is not an integer: ${v}`);
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${at}[${i}]`));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
    }
  };
  walk(report, 'report');
  // No ISO timestamp of the RUN leaked into the output.
  assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text), false);
});

test('unknown variant names fail loudly', () => {
  const trace = parseTrace(fixtureText);
  assert.throws(() => replay(trace, { variant: 'wishful' }), /unknown variant/);
});

// ───────────────────────────────────────────── integration: conservation ──

test('INTEGRATION: conservation invariants hold for every variant', () => {
  const trace = parseTrace(fixtureText);
  for (const name of VARIANTS.keys()) {
    const r = replay(trace, { variant: name });
    assert.ok(
      r.invariants.ok,
      `${name}: ${JSON.stringify(r.invariants.checks)}`,
    );

    const fetched = r.cost.bytesFetched;
    const decoded = r.decode.bytesDecoded;
    const evicted = r.eviction.bytesEvicted;
    const resident = r.residency.bytesResident;
    // bytes fetched ≥ bytes decoded ≥ bytes evicted + resident
    assert.ok(fetched >= decoded, `${name}: fetched < decoded`);
    assert.ok(
      decoded >= evicted + resident,
      `${name}: decoded < evicted + resident`,
    );
    // and nothing leaks: every fetched byte is either evicted or still held.
    assert.equal(fetched, evicted + resident, `${name}: bytes leaked`);
    assert.equal(r.decode.queued, r.cost.reads);
  }
});

test('the conservation checker actually fails on a broken report', () => {
  const trace = parseTrace(fixtureText);
  const r = replay(trace, { variant: 'incumbent' });
  const broken = structuredClone(r);
  broken.eviction.bytesEvicted += 1;
  const res = checkConservation(broken);
  assert.equal(res.ok, false);
  assert.ok(
    res.checks.some((c) => !c.ok && c.name === 'fetched==evicted+resident'),
  );
});

test('conservation holds under sensitivity sweeps of the replay parameters', () => {
  const trace = parseTrace(fixtureText);
  for (const maxResidentTiles of [2, 3, 4, 6, 8, 16]) {
    for (const prefetchHorizonBuckets of [0, 1, 2, 4]) {
      for (const name of VARIANTS.keys()) {
        const r = replay(trace, {
          variant: name,
          config: { maxResidentTiles, prefetchHorizonBuckets },
        });
        assert.ok(
          r.invariants.ok,
          `${name} tiles=${maxResidentTiles} horizon=${prefetchHorizonBuckets}: ` +
            JSON.stringify(r.invariants.checks.filter((c) => !c.ok)),
        );
        assert.ok(
          r.residency.tilesResident <= Math.max(1, maxResidentTiles) + 1,
        );
      }
    }
  }
});

test('a smaller cache monotonically costs at least as much (sanity of the sim)', () => {
  const trace = parseTrace(fixtureText);
  let prev = 0;
  for (const maxResidentTiles of [8, 6, 4, 3]) {
    const r = replay(trace, {
      variant: 'incumbent',
      config: { maxResidentTiles },
    });
    assert.ok(
      r.cost.value >= prev,
      `cache ${maxResidentTiles} cost ${r.cost.value} < previous ${prev}`,
    );
    prev = r.cost.value;
  }
});

// ────────────────────────────────────────────────────────── the CLI seam ──

test('CLI: the replay command is deterministic at the process boundary', () => {
  const args = ['src/policy-replay.mjs', FIXTURE, '--all', '--json'];
  const run = () =>
    execFileSync(process.execPath, args, { cwd: benchRoot, encoding: 'utf8' });
  assert.equal(run(), run(), 'two identical CLI invocations disagreed');
  const reports = JSON.parse(run());
  assert.equal(reports.length, VARIANTS.size);
  assert.ok(reports.every((r) => r.invariants.ok));
});

test('CLI: --list-variants documents every registered variant', () => {
  const out = execFileSync(
    process.execPath,
    ['src/policy-replay.mjs', '--list-variants'],
    { cwd: benchRoot, encoding: 'utf8' },
  );
  for (const name of VARIANTS.keys()) assert.match(out, new RegExp(name));
});

test('CLI: the human-readable summary states the cost model and the boundary', () => {
  const out = execFileSync(
    process.execPath,
    ['src/policy-replay.mjs', FIXTURE, '--all'],
    { cwd: benchRoot, encoding: 'utf8' },
  );
  assert.match(out, /cost model: bytes \+ g\*reads/);
  assert.match(out, /no GPU\/render feedback/);
});

test('the recorder module parses and exposes its entry points', async () => {
  // Importing is enough: `policy-record.mjs` must not launch a browser or run
  // its driver on import (it guards on being invoked directly).
  const mod = await import('../src/policy-record.mjs');
  assert.equal(typeof mod.main, 'function');
  assert.equal(typeof mod.installSampler, 'function');
});
