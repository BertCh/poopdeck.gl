---
'@poopdeck.gl/core': minor
'@poopdeck.gl/layers': minor
'@poopdeck.gl/three': minor
'@poopdeck.gl/maplibre': minor
---

Packed `formatVersion: 3` — tiles are addressed by variant, not just by `(z,x,y,t)`

A raw tile and a summary (H3/Quadbin) tile could occupy the same
`(zoom, x, y, time-bucket)` address, because that address had no room to say
_which product_ it named. The two collided in the directory and in every client
cache keyed on it. v3 adds the missing axis:

- **`manifest.variants` is a required registry.** Every directory entry's
  `variant_id` resolves to exactly one entry in it. Variant 0 is always `raw`;
  the canonical summary variant is 1.
- **Directory codec v6** carries `variant_id` per entry, and object magic moves
  to version byte 3.
- **Sparse archives now pick the single-frame directory automatically** and
  archives with ≥ 8,192 entries page by default, instead of the previous fixed
  choice.

**Readers open v2; writers only emit v3.** The window is deliberately
asymmetric and read-only: a published archive is a durable artifact and several
have no reproducible source, so a read-side cutover would strand them rather
than migrate them. A v2 manifest has no `variants` key, which is not missing
information — it _is_ the implicit raw-only registry, and its directory decodes
every entry to variant 0. v1 is refused. There is no transcode path in either
direction, and v2 forks in the container only, never below the layer frame.
Both reference implementations pin the window as
`MIN_PACKED_FORMAT_VERSION ..= PACKED_FORMAT_VERSION`.

**Tile keys carry the variant.** The canonical key is now
`z/x/y/t#<variant>` (plus the existing `@<bucketMs>` suffix on a temporal-LOD
tile), and `parseTileKey` reports `variantId` back. This string is embedded in
the OPFS cache key, so **the first load after upgrading is cold** — previously
cached tiles are orphaned, not corrupted. If you built keys by hand anywhere,
switch to `tileKey`/`parseTileKey`: a hand-spelled `z/x/y/t` now aliases a
summary tile onto its raw twin, which is the collision this release exists to
remove.

**What you have to do.** Nothing, to keep reading what you already publish. To
publish _new_ archives, rebuild with the 0.6.0 `stt-build` — the output is v3.
