#!/usr/bin/env bash
# Regenerate the density-profile sidecars behind the "cube laid down in a line"
# utility (src/components/demo/CubeInLine.tsx).
#
# One profile per local archive: the demo-page "Under the hood" panel shows the
# profile for that demo's own dataset (no selector), and the how-it-works
# explorer switches between the four "poles". Each profile is the native tier of
# a real archive downsampled into a sparse (sx, sy, tb) occupancy+bytes cube,
# plus the blob-ordering anchors, emitted by the stt-core `density-profile`
# example (ordering math is production curve.rs, so numbers can't drift). Reads
# only the directory — no payloads.
#
# public/data is git-ignored (R2-hosted); public/density IS committed so the
# sidecars ship with the Pages build. Run from the repo root:
#   examples/showcase/scripts/build-density-profiles.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DATA="$ROOT/examples/showcase/public/data"
OUT="$ROOT/examples/showcase/public/density"
mkdir -p "$OUT"

echo "building density-profile example…"
cargo build --release -p stt-core --example density-profile
BIN="$ROOT/target/release/examples/density-profile"

# Nicer labels for the four "poles" shown in the how-it-works selector; every
# other archive falls back to its directory name (only used in aria text).
label_for() {
  case "$1" in
    drifters) echo "Ocean drifters" ;;
    nyc-rideshare) echo "NYC rideshare" ;;
    gtfs-nl) echo "GTFS transit (NL)" ;;
    gtfs-ch) echo "GTFS transit (CH)" ;;
    flights) echo "Global flights" ;;
    *) echo "$1" ;;
  esac
}

count=0
for manifest in "$DATA"/*/manifest.json; do
  [[ -f "$manifest" ]] || continue
  stem="$(basename "$(dirname "$manifest")")"
  if "$BIN" "$manifest" --id "$stem" --label "$(label_for "$stem")" > "$OUT/$stem.json" 2>/dev/null; then
    count=$((count + 1))
  else
    echo "  skip $stem — emitter failed (empty/unsupported archive)" >&2
    rm -f "$OUT/$stem.json"
  fi
done

echo "wrote $count profiles to $OUT"
du -sh "$OUT" 2>/dev/null || true
