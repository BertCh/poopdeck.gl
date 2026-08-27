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

`scripts/r2-sync.sh` implements all of the above with rclone: a grace-rule read
of the deployed manifests, an immutable pass for `packs/**` + `index/**`, a
manifest pass, three sidecar passes (AV scene bundles, `/worlds` bundles, and
root-level `*.meta.json` / `*.bin`) that ride the short-TTL regime because their
filenames are stable while their bytes change, and a retention-aware GC pass
that touches only `packs/` and `index/`. Credentials go in `.env` at the repo
root (see `.env.r2.example`).

```bash
cp .env.r2.example .env          # fill in R2 account / token / bucket
scripts/r2-sync.sh --dry-run     # review what would change
scripts/r2-sync.sh               # sync everything under data-fleet/ + GC
scripts/r2-sync.sh flights       # one dataset, e.g. after a rebuild
scripts/r2-sync.sh --no-prune    # upload only, defer GC — use for major republishes
scripts/r2-sync.sh --prune-now   # GC without the retention window (disaster cleanup)
STT_DATA_DIR=path/to/staging scripts/r2-sync.sh   # deploy a COMPLETE staging tree
```

An R2 bucket serves nothing publicly until a domain is attached to it (R2 →
Settings → Public access → Custom domain). That hostname is what the viewer and
the probes below use; it goes in `.env` as `R2_PUBLIC_BASE_URL`.

`STT_DATA_DIR` must point at a **complete** tree: GC judges "unreferenced"
against the local manifests it can see, so a partial staging tree marks every
dataset it omits for deletion. Pair a partial tree with `--no-prune`, or pass
the single stem instead.

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

## Verify the edge after every sync

Setting the right `Cache-Control` on the origin objects is necessary and **not
sufficient**: the whole "a warm load is served entirely from edge cache" claim
lives or dies on what the CDN in front of the bucket decides to do with those
headers, and both halves of the two-regime table can be silently defeated by
zone configuration. Sync uploads the bytes; only a probe tells you the edge
agreed — two checks, both cheap enough to run on every deploy.

### 1. Immutable objects must actually be cached

`packs/*.sttp` and `index/*.sttd` are non-standard extensions served as
`application/octet-stream`. Cloudflare's default cache behavior on a **generic
proxied origin** is extension-driven, so unknown extensions come back
`cf-cache-status: DYNAMIC` — never cached, every viewport range request going
to origin — no matter how long the origin's `max-age` is, and nothing in the
archive tells you the edge ignored them.

Probe with a **repeated ranged** request, because ranges are how the reader
actually fetches tiles — a cacheable whole-object GET proves nothing about
range coalescing at the edge:

```bash
BASE=https://tiles.poopdeck.gl/data/earthquakes-v2
PACK=$(curl -sS "$BASE/manifest.json" |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["packs"][0]["key"])')

status() {
  curl -sS -o /dev/null -D - -H 'Range: bytes=0-65535' "$1" |
    tr -d '\r' | awk 'tolower($1)=="cf-cache-status:"{print $2}'
}

status "$BASE/$PACK" >/dev/null                       # prime the edge (MISS)
[ "$(status "$BASE/$PACK")" = HIT ] ||
  { echo "FAIL: immutable pack is not cached at the edge"; exit 1; }
```

The first request reports `MISS`, every later one `HIT`. `DYNAMIC` or `BYPASS`
means the edge is not caching packs at all — fix it with an explicit **Cache
Rule** on the tiles hostname rather than by touching the archive:

| Cache Rule field  | Value                                                |
| ----------------- | ---------------------------------------------------- |
| When incoming     | `http.request.uri.path` ends with `.sttp` or `.sttd` |
| Cache eligibility | Eligible for cache                                   |
| Edge TTL          | Use cache-control header from origin                 |
| Browser TTL       | Use cache-control header from origin                 |

### 2. The manifest's short TTL must survive the edge

The manifest is the mutable half, and its 60-second TTL is what makes a deploy
flip visible promptly. A zone-level **Browser Cache TTL** set to a fixed
duration overrides any origin `max-age` _lower_ than it — so the 1-year packs
sail through untouched while the manifest is quietly raised, and a dataset flip
stays invisible to browsers that already hold one for the whole window:

```bash
curl -sS -o /dev/null -D - "$BASE/manifest.json" | grep -i '^cache-control:'
# want: cache-control: public, max-age=60, must-revalidate
```

`r2-sync.sh` uploads `max-age=60, must-revalidate`; a larger `max-age` on the
response means a zone-level Browser Cache TTL is overriding it. Set the tiles
hostname's Browser Cache TTL to "Respect existing headers", or fold it into the
same Cache Rule. The symptom — a republish that stays invisible for hours to
browsers already holding a manifest — reads as a sync failure rather than a
cache setting, which is why the probe is worth running every deploy.

Neither probe needs credentials — run them against the public hostname from
anywhere, including from a CI job after `scripts/r2-sync.sh`.

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
- Run both [edge probes](#verify-the-edge-after-every-sync) against whatever
  hostname you end up on. Neither failure mode is Cloudflare-specific: a CDN
  that decides cacheability by file extension will not cache `.sttp`/`.sttd`,
  and a fixed browser-TTL override will bury the manifest's 60-second TTL.

## Build for publishing

`stt-build --publish` (which `stt-generate` passes automatically) produces
serve-as-is output — zstd level 19 and the default paged directory — so a
from-source build is deploy-ready as written, with no separate repack step.
Validate before syncing:

```bash
stt-validate path/to/dataset
```

## When static isn't enough

For data that changes continuously (a live database table), skip the packed
deploy entirely and run [`stt-serve`](../spec/stt-serve-protocol.md), which
generates tiles per request from PostGIS or DuckDB. Its responses are
deliberately `no-store` — the packed format is the caching story; `stt-serve`
is the freshness story.
