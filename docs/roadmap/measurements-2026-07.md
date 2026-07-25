# Measurements — cold start, 2026-07

**What this file is.** The project could state its compression ratio and could
not state its cold-start cost. This is that number, measured, with the method
and the caveats attached so it can be re-run and disputed.

[`stt-packed-format-decisions.md`](./stt-packed-format-decisions.md) names
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

Every archive below is opened from a cold client — no manifest, no directory,
no tiles — and taken to the point where the first frame is drawable at the
demo's own default camera and playhead.

| dataset              | shape                | archive  | features   | **requests** | **bytes to first frame**   | % of archive |
| -------------------- | -------------------- | -------- | ---------- | ------------ | -------------------------- | ------------ |
| `earthquakes-v2`     | sparse global events | 45.6 MiB | 522,982    | **5**        | **335.4 KiB** (343,492 B)  | 0.718 %      |
| `flights`            | dense trajectories   | 807 MiB  | 40,342,819 | **5**        | **5.69 MiB** (5,967,269 B) | 0.705 %      |
| `goes-glm-lightning` | summary tier (h3)    | 136 MiB  | 14,401,199 | **4**        | **250.9 KiB** (256,888 B)  | 0.180 %      |

Four to five HTTP requests, in every case, regardless of whether the archive is
46 MB or 807 MB. That is the property the format was built for, and it holds.

The byte figure is not scale-invariant, and should not be quoted as if it were:
it tracks how much _data_ the first viewport actually contains. `flights` costs
5.69 MiB because the first frame genuinely draws 155,992 aircraft positions.

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
call `SpatiotemporalTileset` makes on its first selection pass.

The viewport is derived exactly as `SpatioTemporalLayer` derives it, on a
1280×800 px canvas:

```
zoom   = clamp(floor(viewState.zoom), metadata.minZoom, metadata.maxZoom)
bounds = Web-Mercator unprojection of the canvas corners
time   = [playhead - timeWindow/2, playhead + timeWindow/2]
```

### What is deliberately NOT measured

`SpatiotemporalTileset`'s speculative work: prefetch lookahead, coarse
parent-fallback zoom levels, and the overview storyboard tier. All three are
throughput spent _after_ the first frame is already drawable. **A real app's
first-second traffic is therefore higher than the table above** — what these
numbers bound is the critical path, which is the thing the format claims to
make cheap.

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

| dataset              | manifest        | directory (root + leaves) | tile blobs                  |
| -------------------- | --------------- | ------------------------- | --------------------------- |
| `earthquakes-v2`     | 1 req, 2,882 B  | 2 req, 235,637 B (68.6 %) | 2 req, 104,973 B            |
| `flights`            | 1 req, 14,948 B | 2 req, 62,788 B (1.1 %)   | 2 req, 5,889,533 B (98.7 %) |
| `goes-glm-lightning` | 1 req, 4,902 B  | 2 req, 138,994 B (54.1 %) | 1 req, 112,992 B            |

The directory is always **two** requests: the root page, then a single
coalesced range covering every leaf that survived the root's bbox / zoom /
temporal pruning. The exact traces (warm edge):

```
earthquakes-v2
  200  manifest      2.8 KiB   HIT
  206  directory       502 B   HIT   bytes=0-501            <- root page
  206  directory   229.6 KiB   HIT   bytes=154227-389361    <- surviving leaves
  206  pack         50.4 KiB   HIT   bytes=4886013-4937627
  206  pack         52.1 KiB   HIT   bytes=12450290-12503647

flights
  200  manifest     14.6 KiB   HIT
  206  directory       927 B   HIT   bytes=0-926
  206  directory    60.4 KiB   HIT   bytes=927-62787
  206  pack         1.15 MiB   HIT   bytes=40781426-41989538
  206  pack         4.46 MiB   HIT   bytes=49697015-54378434

goes-glm-lightning
  200  manifest      4.8 KiB   HIT
  206  directory       219 B   HIT   bytes=0-218
  206  directory   135.5 KiB   HIT   bytes=219-138993
  206  pack        110.3 KiB   HIT   bytes=57496930-57609921
```

**The paged directory is doing its job, and it is also the remaining cost.**
Only 11.5 % of `earthquakes-v2`'s 2 MB directory and 2.0 % of `flights`' 3 MB
directory is ever fetched — the pruning works. But on the two sparse datasets
the surviving leaves are _the majority of the cold start_: 68.6 % for
earthquakes, 54.1 % for lightning. The dominant term there is the leaf page
granularity (4096 entries), not the tile data. Halving `pageEntries` is the
obvious lever and has not been tried; recording it here so the next person does
not have to rediscover which knob matters.

---

## 5. Wall time

Median of 5 cold opens, same machine, same session. Wall time includes zstd
decompression and Arrow decode, not just transfer.

| dataset              | warm edge (`cf-cache-status: HIT`) | cold edge (`--cache-bust`, forced to R2 origin) |
| -------------------- | ---------------------------------- | ----------------------------------------------- |
| `earthquakes-v2`     | 128 ms                             | 549 ms                                          |
| `flights`            | 431 ms                             | 1,207 ms                                        |
| `goes-glm-lightning` | 90 ms                              | 792 ms                                          |

Request and byte counts are identical in both columns — the protocol does not
change, only the latency of each hop.

---

## 6. Context

|            |                                                                           |
| ---------- | ------------------------------------------------------------------------- |
| Machine    | Apple M3 Pro, 36 GB RAM, macOS 14.1 (23B2073), arm64                      |
| Runtime    | Node v22.20.0 (`fetch` / undici), HTTP/2                                  |
| Deployment | Cloudflare R2 behind the `tiles.poopdeck.gl` custom domain                |
| Edge PoP   | `BOS` (`cf-ray: …-BOS`)                                                   |
| Link       | DNS 3.5 ms · TCP connect 15.5 ms · TLS 33 ms · TTFB 58 ms (warm manifest) |
| Throughput | ~40 MiB/s (~336 Mbps) sustained on a 16 MiB warm range read               |
| Measured   | 2026-07-24                                                                |

This is one client, on one link, against one PoP. The **request counts** are a
property of the format and travel; the **wall times** are a property of this
machine and this network and do not.

---

## 7. Caveats, including one correction

1. **These are warm-edge numbers by default.** `cf-cache-status: HIT` on all
   three. `--cache-bust` gives the origin round-trip figures in §5.

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
   directory `pageEntries` on §4's dominant term.

---

## 8. Datasets probed and dropped

`gtfs-ch`, `rainfall-2019`, `storm4d-isolines`, `wpc-fronts` and
`wpc-fronts-pips` return **404** on `tiles.poopdeck.gl` (5 of the 64 dataset
URLs registered in `examples/showcase/src/datasets.ts`, probed 2026-07-24).
The first three are deliberate — their demo ids sit in the showcase's
`LOCAL_ONLY_DATASETS` gate. The last two are **not** gated: they belong to the
ungated `severe-weather-2024` composite, which will 404-stall its fronts
overlay until they are r2-synced.

No dataset was included in this file on the strength of an assumption; every row
was measured against a manifest that returned 200.
