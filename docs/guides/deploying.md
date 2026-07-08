# Deploying a Dataset

A packed STT dataset is a static directory — deploying it means copying it to
any HTTP host that supports **Range requests** and setting two `Cache-Control`
regimes. No tile server, no invalidation pipeline.

## The two cache regimes

The [packed format](../spec/stt-packed-format.md) makes cacheability a property
of the _format_: `packs/` and `index/` objects are content-addressed (blake3 →
filename), so their bytes can never change without their name changing.

| Objects                        | `Cache-Control`                       | Why                                                              |
| ------------------------------ | ------------------------------------- | ---------------------------------------------------------------- |
| `packs/*.sttp`, `index/*.sttd` | `public, max-age=31536000, immutable` | Content-addressed — cache forever, never purge                   |
| `manifest.json`                | `public, max-age=60, must-revalidate` | The one mutable object; a deploy flips a dataset by rewriting it |

Two rules follow from the immutable half:

1. **Copy, never sync-with-delete.** A new build's packs upload _alongside_ the
   old ones; only the manifest flip makes readers use them. Deleting the old
   packs during a deploy 404s live sessions that opened the old manifest.
2. **Garbage-collect with a retention window.** Delete an unreferenced pack
   only after every cached manifest and open session could have drained
   (the reference script defaults to 7 days). "Unreferenced" must be judged
   against the _deployed_ manifest too, not just the build being uploaded:
   the reference script reads the currently-deployed `manifest.json` before
   uploading and protects everything it references for one deploy cycle
   (the **grace rule** of the [format spec §2](../spec/stt-packed-format.md)).

## Cloudflare R2 (the reference deploy)

`scripts/r2-sync.sh` implements all of the above with rclone: an immutable
pass for `packs/**` + `index/**`, a manifest pass, and a retention-aware GC
pass. Credentials go in `.env` at the repo root (see `.env.r2.example`).

```bash
cp .env.r2.example .env          # fill in R2 account / token / bucket
scripts/r2-sync.sh --dry-run     # review what would change
scripts/r2-sync.sh               # sync everything under public/data + GC
scripts/r2-sync.sh flights       # one dataset, e.g. after a rebuild
scripts/r2-sync.sh --no-prune    # upload only, defer GC — use for major republishes
scripts/r2-sync.sh --prune-now   # GC without the retention window (disaster cleanup)
STT_DATA_DIR=path/to/staging scripts/r2-sync.sh   # deploy a staging tree
```

### GC, the grace rule, and major republishes

The GC pass deletes a `packs/`/`index/` object only when it is unreferenced
by the **local** manifests being deployed, unreferenced by the
**currently-deployed** manifests (fetched read-only before anything uploads —
the one-deploy _grace rule_), and older than the retention window
(`R2_PRUNE_RETENTION`, default `7d`). If the deployed manifests exist but
cannot be read, the script uploads normally and skips GC for that run
(fail-safe). `--prune-now` drops only the age gate — the grace rule still
protects the previous deploy, but anything older than that can 404 live
sessions, and the script warns loudly when the deployed manifest still
references objects the new deploy does not.

For a **major republish** that changes every object (a format-version bump, a
full rebuild), the recommended mode is `--no-prune`: upload additively, flip
the manifests, and let a later default sync garbage-collect the old objects
once the retention window has passed.

One consequence of the grace rule: a dataset that is deleted locally but still
deployed keeps protecting its own objects (its remote manifest is re-read on
every sync). To retire a dataset, delete its remote `manifest.json` first —
e.g. `rclone deletefile r2:<bucket>/data/<stem>/manifest.json` — then let a
later sync collect the now-unreferenced objects.

Browser clients fetch cross-origin, so the bucket needs a CORS policy allowing
`GET`/`HEAD` with the `Range` request header and exposing `Content-Range` /
`ETag` — `scripts/r2-cors.json` is the reference policy (wildcard origin:
tiles are public read-only data, and a wildcard avoids `Vary: Origin`
fan-out at the edge).

## Any other static host

The same recipe ports to S3 + CloudFront, GCS, or a plain nginx box:

- Upload `packs/` and `index/` with the immutable header, `manifest.json`
  with the short-TTL header (e.g. `aws s3 cp --cache-control ...` in two
  passes, or nginx `location` blocks keyed on path).
- Ensure Range requests pass through (default on S3/GCS; nginx serves ranges
  natively for static files).
- Apply the CORS policy above if the viewer is on a different origin.
- Order deploys: upload new packs + directory **first**, flip `manifest.json`
  last.

## Build for publishing

`stt-build --publish` (which `stt-generate` passes automatically) produces
serve-as-is output — zstd level 19 and the default paged directory — so a
from-source build is deploy-ready as written, with no separate repack step.
Validate before syncing:

```bash
target/release/stt-validate path/to/dataset/manifest.json
```

## When static isn't enough

For data that changes continuously (a live database table), skip the packed
deploy entirely and run [`stt-serve`](../spec/stt-serve-protocol.md), which
generates tiles per request from PostGIS or DuckDB. Its responses are
deliberately `no-store` — the packed format is the caching story; `stt-serve`
is the freshness story.
