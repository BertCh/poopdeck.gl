# Blob-ordering heuristic — findings from the density sweep (2026-07)

> **STATUS: SHIPPED 2026-07-05.** All five findings below are implemented (see
> §3). F1+F2 improve the `auto` default; F3 is the opt-in `--blob-ordering
> measured` mode + `stt-optimize order-audit` advisor, both backed by a shared
> range-read simulator (`crates/stt-core/src/ordering_sim.rs`); F4a records the
> resolved order in `manifest.blobOrdering`; F5 fixes the stale docs. Building
> the measured picker **overturned this doc's own headline caveat** — see §3's
> "what shipping taught us": the adjacency-break proxy used below is *not* a good
> cost model, and real range-read cost flips several conclusions.

> The packed writer **always** reorders tile blobs at build by one concrete
> space-filling curve, chosen by the static `BlobOrdering::choose()` cardinality
> heuristic (`--blob-ordering auto` is the default; there is no no-reorder mode —
> `eager` maps to `Auto`). Building the demo-page "cube laid down in a line"
> utility produced a directory-only density/ordering probe
> (`crates/stt-core/examples/density-profile.rs`) that we ran over all 36 local
> archives. This records what that sweep revealed about the heuristic, with a
> ranked findings list and phased proposed work.
>
> **Method:** per-archive directory read (no payloads) → per-`(x,y,t)`
> occupancy + bytes, plus each of the four orderings' linearizations and their
> adjacency-break counts (non-neighbour hops in byte order), cross-tabulated
> against the `choose()` pick and against a recompute using *occupied-extent*
> space bits.

## 0. Verdict & caveat

`auto` is a single static cardinality rule, and the *"measured per-dataset
simulator that tries all orders and overrides `choose()` when available"*
promised in `curve.rs:68-70` **was never built** — so `auto` always uses
`choose()`. The sweep shows `choose()` leaving locality on the table in two
systematic, cheap-to-fix ways (spatial cardinality overstated; the shallow-time
pole missed), plus a structural gap (no measured, access-pattern-aware pick; the
chosen ordering isn't even recorded).

**Caveat on the evidence:** the sweep ranks orderings by *adjacency breaks* — a
locality **proxy**, not range-read cost under a specific access pattern. The
break-optimal ordering is frequently `time-major`, which is *catastrophic* for
scrub/playback, so `auto`'s `hilbert3` generalist is legitimately correct in
many of the 22/36 cases where the proxy "disagrees" with it. The findings below
are the ones where the proxy points to a real, **no-downside** win.

## 1. Findings (ranked)

### F1 — `choose()` compares raw max-zoom (space) against occupied-bucket bits (time) — *high confidence, low risk*

`PackWriter::finalize` (`crates/stt-core/src/pack.rs:388-395`) resolves `Auto`
with `zoom_bits = max_z` (the raw maximum zoom **level**) but
`time_bits = bits_for(#occupied buckets)`. The time axis uses the *occupied*
temporal extent; the space axis uses the *grid* extent. For sparse data the
spatial bounding box is a tiny fraction of `2^zoom` (nyc-rideshare: zoom 16 but
~7 bits of occupied tiles), so `choose()` systematically **overstates spatial
cardinality** and biases toward `hilbert3`.

Fix: derive space bits from the buffered tiles' occupied bbox
(`bits_for(x_span)`, `bits_for(y_span)`), symmetric to the time axis — both are
already in hand at `finalize`. Evidence: recomputing `choose()` with
occupied-extent space bits flips the pick on **3/36** (`nyc-taxi-points`,
`wildfires`, `nyc-taxi-paths`); for `nyc-taxi-paths` the flip → `spatial`
matches the lowest-break ordering.

### F2 — the heuristic catches deep-time but not shallow-time (snapshot) datasets — *high confidence, low risk*

`choose()` (`curve.rs:74-80`) only leaves `hilbert3` when time **dominates**
(`time_bits > space_bits + 3`). It never leaves `hilbert3` when time is trivially
**shallow**. But at one/few time buckets, `hilbert3` interleaves a degenerate
3rd axis and is strictly worse than the pure 2D-Hilbert (`spatial`) — with zero
access-pattern downside (there is no timeline to scrub). The heuristic is
asymmetric: it handles the time-dominant pole but not the space-dominant one.

Evidence: ~7 shipped archives with `tbSpan ≈ 0` (`bixi-streets`,
`bixi-streets-flow`, `bixi-corridors`, `bixi-live-flow`, `bixi-flowmap-baked`,
`bixi-flowmap-dense`, `nwm-rivers-flood-2019-03`) rank `spatial` below `hilbert3`
on breaks. Fix: when `time_bits ≤ 1`, return `spatial`/2D-Hilbert — symmetric to
the deep-time case.

### F3 — no measured, access-pattern-weighted picker exists — *structural*

The right objective is per-dataset **range-read cost under the actual access
mix** (scrub/playback vs pan/snapshot vs zoom), not a cardinality rule. That
measured pick can run entirely off the directory — occupancy + byte weights +
the four linearizations + a range-coalescing simulation, no payload reads (the
density-profile example is a working prototype of exactly this data path).
`curve.rs:68-70` promises it but it was never built; `stt-optimize`'s only
ordering support (`crates/stt-optimize/src/advisors/layout.rs:117-149`) is
explicitly an "access-shape heuristic, **not simulated**".

Proposed: build the measured picker and either wire it into
`PackWriter::finalize` behind `auto`, or expose it as an `stt-optimize` advisor
that reports per-ordering read-cost and recommends/executes a reorder. Requires
a decision on the default access-pattern weighting (playback-dominant is the
current implicit assumption).

### F4 — observability: the chosen ordering isn't recorded, and nothing audits it — *medium*

`Manifest`/`Metadata` store **no ordering label** (`pack.rs:172-194`), so which
ordering an archive uses can only be *inferred* by reconstructing the
`(pack_id, offset)` byte layout. There is no `stt-optimize reoptimize`/re-sort.

Proposed: (a) persist the resolved `BlobOrdering` in the manifest; (b) promote
the directory-only density/ordering probe (currently
`crates/stt-core/examples/density-profile.rs`) into a first-class `stt-optimize`
ordering advisor; (c) optionally emit the density profile as an **opt-in build
sidecar** (like `style_hints`) so tooling and the FE "under the hood" panel get
it without the manual regen script.

### F5 — doc bug + minor — *trivial*

`BlobOrdering::Hilbert3`'s doc comment (`curve.rs:36-39`) is **stale**: it claims
`stt-build` "defaults to `eager` (no reorder)". The default is `auto`, and there
is no no-reorder mode. Fix the comment. Minor: `morton3` is empirically dominated
— it is the **worst** (most-breaks) ordering on 26/36 archives and the best on
**none** — confirming its "rarely the best choice" comment; consider marking it
research-only in docs. *(Correction, post-implementation: on the real blended
read-cost — not this break proxy — morton3 does edge tiny datasets; see §3. It
is now marked research-only and the picker never selects it.)*

## 2. Proposed work (phased) — all shipped 2026-07-05

- **P0** — F1 (occupied-extent space bits) + F2 (shallow-time → spatial) in
  `choose()`; F5 doc fix. ✅ `crates/stt-core/src/curve.rs` + the `pack.rs`
  finalize caller; unit-tested; the F1/F2 flip moves **12/36** archives to a
  better `auto` pick.
- **P1** — F4(a) persist the resolved order in `manifest.blobOrdering`
  (Rust write + TS reader + JSON schema); F4(b) `stt-optimize order-audit`
  advisor. ✅
- **P2** — F3 measured picker, opt-in as `--blob-ordering measured`
  (`PackWriter::with_measured_ordering`), backed by the shared
  `crates/stt-core/src/ordering_sim.rs`. ✅ `auto` stays the safe default.

## 3. What shipping taught us (the caveat was right — for the wrong reason)

The §0 caveat warned the adjacency-break metric is only a proxy. Building the
real simulator proved it is a **misleading** one, in two concrete ways:

1. **Request count is a broken cost primary.** A first cut ranked orderings by
   coalesced range-read *count*. On drifters that recommended `time-major` at
   *"2 reads"* — but those 2 reads transfer **669 MiB** (at the reader's 2 MiB
   coalescing gap, a scattered spatial band fuses into one archive-spanning
   range). `spatial` reads 184 MiB in 94 requests. Ranking by count called the
   669 MiB read "cheapest." The fix is a **blended cost `bytes_read + reads ×
   gap`**: the reader over-reads up to `gap` bytes to save one request, so it
   *prices a request at exactly `gap` bytes* — ranking by that is self-consistent
   with the reader's own coalescing decision. Under it, deep-time correctly picks
   `spatial`.

2. **"morton3 is never the winner" was an artefact of the proxy.** On the *real*
   read-cost, morton3 edges the field on some tiny datasets (marginal over-read
   at equal request count). Since morton3 is stated research-only, the picker now
   **reports but never selects** it (`ordering_sim::SELECTABLE`), which makes the
   claim true by construction rather than by luck. F5's "empirically never
   optimal" is *not* literally true and the shipped docs say so.

**Validated on all 36 archives** (via the density probe, which shares
`ordering_sim::evaluate`): `measured` picks spatial 16 / time 12 / hilbert3 8,
never morton3; deep-time → spatial, wide-shallow → time-major, balanced →
hilbert3. `order-audit` prints the per-ordering cost table so the pick is
legible (e.g. drifters shows time-major's 669 MiB next to spatial's 184 MiB).

**Still open (deliberately):** the scrub/pan query mix is equal-weighted and
fixed; a genuinely access-pattern-weighted picker (and whether `measured` should
ever become the `auto` default) remains gated on that decision. `measured` being
opt-in is the hedge — `auto` (improved `choose()`) stays the conservative
default and never selects `time-major`.

## Provenance & links

Surfaced while building the demo-page **"cube laid down in a line"** utility
(`examples/showcase/src/components/demo/CubeInLine.tsx`, one panel per demo) and
its density-profile emitter; the how-it-works Archive section carries the
dataset-selector explorer version. Adjacent records:
[`stt-format-review-2026-07.md`](./stt-format-review-2026-07.md) — its "Hilbert
index unspecced" finding is a distinct, spec-side concern;
[`stt-optimize-intelligence-2026-07.md`](./stt-optimize-intelligence-2026-07.md)
— the "measure, don't model" advisor/doctor home for F3/F4.
