# Measurements — cold start, 2026-07

**What this file is.** The project could state its compression ratio and could
not state its cold-start cost. This is that number, measured, with the method
and the caveats attached so it can be re-run and disputed.

§1, §4, §5, §6 and §8 were superseded by
[measurements-2026-08.md §9](./measurements-2026-08.md) (2026-08-10, eight
datasets, republished fleet) and have been cut to pointers; their headings stay
because other records cite them by number. §2 (method), §3 (the archives at
rest) and §7 (caveats, including the discharged `DYNAMIC` correction) are not
restated there and stand.

[`stt-packed-format-decisions.md`](https://github.com/BertCh/spatiotemporal-tiles/blob/main/docs/roadmap/stt-packed-format-decisions.md) names
COPC's benchmark as the bar to clear — _"4 reads / ~110 KB on a 5.7 GB,
1.2-billion-point file"_ — and the paged directory exists specifically to make
the STT equivalent good. Until now nobody had run it.

Harness: [`tools/bench/src/cold-start.mjs`](../../tools/bench/src/cold-start.mjs).

```sh
pnpm --filter @poopdeck.gl/bench bench:cold-start
pnpm --filter @poopdeck.gl/bench bench:cold-start -- --verbose --repeat 5
pnpm --filter @poopdeck.gl/bench bench:cold-start -- --cache-bust
```

---

## 1. The headline

**Superseded.** The current headline — eight datasets against the republished
fleet, captured 2026-08-10 — is
[measurements-2026-08.md §9.1](./measurements-2026-08.md).

---

## 2. Method

### What is measured

The harness drives the real `@poopdeck.gl/core` `STTArchive` — the same reader
the browser runs — behind an instrumented `fetch` that records every request,
its byte range, its response length and Cloudflare's `cf-cache-status`. It is
not a model of the protocol; it is the protocol. A fresh `STTArchive` per run
means no warm manifest, no resident directory pages, no byte cache. Node has no
OPFS, so nothing persists between runs either.

"First frame" is defined as: the archive is open and `getTilesInBounds(bounds,
zoom, timeRange)` has resolved — i.e. every tile the primary zoom needs for the
default camera at the default playhead is fetched and decoded. That is the same
call `SpatioTemporalTileset` makes on its first selection pass.

The viewport is derived exactly as `SpatioTemporalLayer` derives it, on a
1280×800 px canvas:

```
zoom   = clamp(floor(viewState.zoom), metadata.minZoom, metadata.maxZoom)
bounds = Web-Mercator unprojection of the canvas corners
time   = [playhead - timeWindow/2, playhead + timeWindow/2]
```

### What is deliberately NOT measured

`SpatioTemporalTileset`'s speculative work: prefetch lookahead, coarse
parent-fallback zoom levels, and the overview storyboard tier. All three are
throughput spent _after_ the first frame is already drawable. **A real app's
first-second traffic is therefore higher than what this harness reports** —
what these numbers bound is the critical path, which is the thing the format
claims to make cheap.

Also excluded: HTTP header bytes, TLS record overhead, and TCP/QUIC framing.
Body lengths are read from `content-length` (for a `206` that is exactly the
range body). All requests ride one HTTP/2 connection.

### The cameras

Taken from the showcase's own `initialViewState` where a demo registers one, so
the numbers describe the view a visitor actually lands on.

| dataset              | camera                  | tile zoom | time window | playhead    |
| -------------------- | ----------------------- | --------- | ----------- | ----------- |
| `earthquakes-v2`     | lon 140, lat 20, zoom 2 | z2        | 30 d        | range start |
| `flights`            | lon −95, lat 38, zoom 4 | z4        | 1 h         | mid-span    |
| `goes-glm-lightning` | lon −95, lat 38, zoom 3 | z3        | 15 min      | mid-span    |

The two trajectory/event-stream sets use a **mid-span** playhead on purpose: at
`t = range.start` a trajectory dataset has barely any features yet, and starting
there would flatter the numbers with a near-empty viewport.

---

## 3. The datasets, at rest

Sizes are read from each deployed `manifest.json` at measurement time.

| dataset              | packs | pack bytes  | directory | layout | pages | root page | tiles   | features   |
| -------------------- | ----- | ----------- | --------- | ------ | ----- | --------- | ------- | ---------- |
| `earthquakes-v2`     | 1     | 45,765,484  | 2,047,129 | paged  | 25    | 494 B     | 102,225 | 522,982    |
| `flights`            | 13    | 843,378,654 | 3,159,559 | paged  | 55    | 919 B     | 223,239 | 40,342,819 |
| `goes-glm-lightning` | 3     | 141,987,803 | 478,702   | paged  | 6     | 211 B     | 24,389  | 14,401,199 |

`goes-glm-lightning` carries an **h3 summary tier** over z0–z4
(`_count`, `sum(energy_fj)`). At the z3 camera the tiles returned carry the
`summary` layer only — verified, not assumed — so its 362 "features" are h3
cells, each standing for many raw flashes.

---

## 4. Where the bytes go

**Superseded.** The current per-request byte split, the directory-leaf share
and the warm-edge traces are
[measurements-2026-08.md §9.3](./measurements-2026-08.md).

---

## 5. Wall time

**Superseded.** The current warm-edge and cold-edge wall times are
[measurements-2026-08.md §9.4](./measurements-2026-08.md).

---

## 6. Context

**Superseded.** The current capture context — machine, runtime, reader build,
deployment, PoP, link — is the table in
[measurements-2026-08.md §9.4](./measurements-2026-08.md).

---

## 7. Caveats, including one correction

1. **These are warm-edge numbers by default.** `cf-cache-status: HIT` on all
   three. `--cache-bust` gives the origin round-trip figures in
   [measurements-2026-08.md §9.4](./measurements-2026-08.md).

2. **Correction to the pre-measurement assumption.** This deployment was
   believed to be serving `cf-cache-status: DYNAMIC` — i.e. uncached — which
   would have made every number above an origin round trip. It is not, as of
   2026-07-24. Measured across manifests, `index/*.sttd` and `packs/*.sttp`:

   | object class    | `cache-control`                          | observed `cf-cache-status`     |
   | --------------- | ---------------------------------------- | ------------------------------ |
   | `manifest.json` | `public, max-age=14400, must-revalidate` | `HIT` / `REVALIDATED` / `MISS` |
   | `index/*.sttd`  | `public, max-age=31536000, immutable`    | `HIT` / `MISS`                 |
   | `packs/*.sttp`  | `public, max-age=31536000, immutable`    | `HIT` / `MISS`                 |

   `DYNAMIC` was never observed on any path. Range requests are served from a
   cached whole object: a _previously unrequested_ byte range of an already-hot
   pack returns `HIT` with the object's `age`. Whatever caused the earlier
   `DYNAMIC` reading has been fixed or was misread; either way the open defect
   should be closed against this measurement rather than carried forward.

   _Closed 2026-07-26._ Re-probed independently: a ranged GET of an
   `earthquakes-v2` pack returned `cf-cache-status: MISS` then `HIT`, carrying
   `cache-control: public, max-age=31536000, immutable` and `age: 173536`
   (~2 days at the edge). The item is struck from the
   [roadmap README](./README.md) backlog and listed there as discharged. **The
   lesson worth keeping:** a headline claim was carried as the top-priority
   defect for weeks on the strength of one header reading that no second probe
   ever reproduced. Re-measure before scheduling work against a measurement.

3. **The numbers are per-camera.** A different default view changes the tile
   count and therefore the byte figure. The request count is far more stable —
   the archive coalesces adjacent ranges, so a wider viewport tends to widen the
   ranges rather than multiply the requests.

4. **Decode is on the critical path but not in the byte figure.** Wall time
   includes it; requests and bytes do not.

5. **Node, not a browser.** No OPFS layer, no worker pool, no rendering. The
   network behaviour is the same; the decode cost is inline and single-threaded
   here, where a browser would decode in the worker pool.

6. **Not measured, and worth measuring next:** the same figures from a real
   browser (including the tileset's prefetch and parent-fallback traffic), the
   cost of a _seek_ rather than a cold open, and the effect of a smaller
   directory `pageEntries` on the directory-leaf term
   ([measurements-2026-08.md §9.3](./measurements-2026-08.md)).

---

## 8. Datasets probed and dropped

**Superseded.** Five of the 64 registered dataset URLs 404'd at capture time
(2026-07-24/26) and could not be measured. All five are live post-B2 and were
re-captured on 2026-08-10; the fleet-state table is in
[measurements-2026-08.md §9.4](./measurements-2026-08.md).
