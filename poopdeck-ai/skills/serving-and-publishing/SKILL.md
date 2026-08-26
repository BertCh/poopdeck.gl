---
name: serving-and-publishing
description: >-
  Publish a built SpatioTemporal Tiles archive to a static host/CDN (R2, S3,
  GCS, nginx) or serve tiles live from PostGIS/DuckDB with stt-serve. Use when a
  user asks how to deploy or host a .stt, what Cache-Control headers tiles need,
  why tiles 404 or CORS-fail after a deploy, how to set up R2/CloudFront, what
  stt-serve does and which flags it takes, whether to pre-bake or serve
  dynamically, or how to hand a manifest URL to the renderer. Enforces the
  immutable-packs / mutable-manifest split and the copy-never-delete deploy rule.
license: MIT
metadata:
  version: '0.7.0'
---

# Serving & publishing STT tiles

Two completely different stories — pick first:

| Situation                                                | Do this                                                                      |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Data is fixed or rebuilt on a schedule (the normal case) | **Publish the packed directory statically.** No tile server, no invalidation |
| Data changes continuously (a live PostGIS/DuckDB table)  | **Run `stt-serve`** — one tile generated per request, `no-store`             |

> **Doc paths** are repo-relative. With no repo on disk, use the MCP
> `get_doc`/`search_docs` tools (or the `stt://docs/<path>` resource), or fetch
> `https://poopdeck.gl/llms/<path>` — full chain in **poopdeck-overview**.
> Everything load-bearing below is inlined.

## Static publishing — the whole recipe

A packed dataset is a static directory: `manifest.json` +
`index/<blake3>.sttd` + `packs/<blake3>.sttp`. Any HTTP host that supports
**Range requests** serves it. Build with `stt-build --publish` (zstd 19 + the
default paged directory — `stt-generate` passes it already); the output is
deploy-ready as written.

### 1. The two Cache-Control regimes (load-bearing)

`packs/` and `index/` are **content-addressed** (blake3 → filename), so their
bytes can never change without their name changing. `manifest.json` is the one
mutable object — flipping it is what makes a deploy live.

| Objects                        | `Cache-Control`                       | Why                               |
| ------------------------------ | ------------------------------------- | --------------------------------- |
| `packs/*.sttp`, `index/*.sttd` | `public, max-age=31536000, immutable` | Content-addressed — cache forever |
| `manifest.json`                | `public, max-age=60, must-revalidate` | Mutable; the deploy-fresh object  |

Most tools apply one header per invocation, so this is **two upload passes**.

### 2. Copy, never sync-with-delete

New packs upload **alongside** the old ones; only the manifest flip switches
readers over. Deleting old packs during a deploy 404s live sessions that already
opened the old manifest (a tab holds its manifest for the whole session, and the
edge caches it for up to 60 s). Order every deploy: **packs + index first,
`manifest.json` last.**

### 3. Garbage-collect on a retention window, with the grace rule

Delete an unreferenced pack only when it is all of:

- unreferenced by the **local** manifests being deployed, **and**
- unreferenced by the **currently-deployed** manifest — read read-only _before_
  anything uploads (the one-deploy **grace rule**, format spec §2), **and**
- older than the retention window (default **7 days**).

If the deployed manifests exist but can't be read, skip GC for that run
(fail-safe). Retiring a dataset: delete its **remote `manifest.json` first**,
then let a later sync collect the now-unreferenced objects — otherwise its own
deployed manifest keeps protecting them forever.

### 4. CORS (browsers fetch tiles cross-origin with Range)

The bucket must allow `GET`/`HEAD` with the **`Range`** request header and
**expose** `Content-Range`, `Content-Length`, `Accept-Ranges`, `ETag`,
`Last-Modified`. `scripts/r2-cors.json` is the reference policy — wildcard
origin on purpose (tiles are public read-only data, and a wildcard avoids a
`Vary: Origin` fan-out at the edge). A missing CORS policy looks exactly like a
blank map.

### 5. Cloudflare R2 (the reference deploy)

`scripts/r2-sync.sh` implements all of the above with rclone: an immutable pass,
a manifest pass, and a retention-aware GC pass. Credentials in `.env` (see
`.env.r2.example`).

```bash
cp .env.r2.example .env         # R2 account / token / bucket
scripts/r2-sync.sh --dry-run    # review what would change
scripts/r2-sync.sh              # everything under public/data, then GC
scripts/r2-sync.sh flights      # one dataset, e.g. after a rebuild
scripts/r2-sync.sh --no-prune   # upload only — USE THIS for major republishes
scripts/r2-sync.sh --prune-now  # GC ignoring the retention window (disaster only)
STT_DATA_DIR=path/to/staging scripts/r2-sync.sh   # deploy a staging tree
```

For a **major republish** that changes every object (format-version bump, full
rebuild), use `--no-prune`: upload additively, flip the manifests, let a later
default sync collect the old objects once the window has passed.

### 6. Any other static host

S3 + CloudFront, GCS, or plain nginx: same two header passes keyed on path,
Range must pass through (default on S3/GCS; nginx serves ranges natively), same
CORS policy, packs/index uploaded before the manifest flip.

### 7. Verify before and after

```bash
stt-validate path/to/dataset/manifest.json      # integrity + decode, pre-sync
curl -sI  https://tiles.example.com/data/<stem>/manifest.json   # 200 + short TTL
curl -sI -H 'Range: bytes=0-15' https://tiles.example.com/data/<stem>/packs/<hash>.sttp
```

The second range request must return `206` with `Content-Range`. Then point the
renderer's `data` prop at the `manifest.json` URL.

`stt-bundle pack <dir> -o x.sttb` makes a **single-file** archive for
interchange/download only — nothing serves `.sttb` over HTTP ranges. Unpack it
before deploying.

## Dynamic serving — `stt-serve`

For a live source, skip the packed deploy entirely. `stt-serve` queries PostGIS
or DuckDB per request and encodes one tile with the **same** per-tile encoder
`stt-build` uses.

```bash
# The default install already has the PostGIS backend:
stt-serve --postgres "$PGURL" --table hurricane_obs --geom-column geom \
          --time-field iso_time --temporal-bucket 7d --min-zoom 3 --max-zoom 8

# Embedded DuckDB backend needs a feature build:
cargo build --release -p spatiotemporal-tiles --features serve-duckdb
stt-serve --duckdb hurricane.duckdb --table hurricane_obs --time-field iso_time
```

Routes — `GET /tiles/{z}/{x}/{y}/{t}.stt`, `GET /metadata.json`, `GET /health`.
With `--config <file.json>` each dataset serves under `/{name}/…` plus a
`GET /datasets` catalog. Defaults: `--bind 127.0.0.1:8088`, `--temporal-bucket
1h`, `--min-zoom 0 --max-zoom 14`, `--pool-size 8`, `--geom-column geom`,
`--time-field timestamp`.

What a client must know:

- **`204 No Content` is normal**, not an error — the tile is legitimately empty
  (no rows, or nothing placed after exact per-tile placement).
- Responses are **`Cache-Control: no-store`** and
  `Content-Type: application/x-stt-tile` (uncompressed layer frame, not a zstd
  pack blob). A CDN in front may still cache on its own terms.
- **`stt-serve` sets no CORS headers and no TLS/auth.** Put a proxy or gateway in
  front for a browser client on another origin.
- `--summary-tier` and `--adaptive-temporal` are **rejected at startup** — they
  span many tiles by construction. Pre-bake them with `stt-build`.
- `--source-srid <SRID>` reprojects non-4326 geometry per request (bypasses a
  plain spatial index; storing 4326 is the fast path).

`stt-serve` shares `stt-build`'s per-tile and encoder-global flag surface
(`--simplify*`, `--pre-tessellate`, `--quantize-*`, `--vector-group`, the
per-tile budgets, `--exclude`/`--include`, `--temporal-lod`, …) through the same
options module — set them identically on both sides or offline and live tiles
diverge.

Pre-bake unless the data genuinely changes under you: static packed is
edge-cacheable forever with no server to run; `stt-serve` trades all cacheability
for freshness and puts a database in the hot path. Before publishing, run the
optimize loop (**tuning-stt-tiles**) — and remember the project rule: shrink via
zoom-range clamp and temporal bucketing, **never** by dropping features.

Refs: `docs/guides/deploying.md`, `docs/spec/stt-serve-protocol.md`,
`docs/api/cli-reference.md` (`stt-serve`, `stt-bundle`),
`docs/spec/stt-packed-format.md`.
