# Archive format and generation performance

This is the implementation record for the STT archive audit. It covers the
vector spatiotemporal workloads supported by STT/poopdeck.gl: instantaneous
events, moving points, paths and trips, polygons, flow/corridor products,
coarse summary cells, and static-geometry value matrices.

## Decision

STT uses one current archive contract:

- packed `formatVersion: 3`;
- directory codec v6;
- Arrow IPC layer frame v2 with GeoArrow geometry;
- immutable, content-addressed `.sttp` packs and `.sttd` directory objects;
- a required manifest `variants` registry;
- raw variant 0 and summary variant 1;
- no v2 writer, no v1 reader, and no transcode path in either direction.

Readers keep a **read-only** window back to packed v2 (directory codec v5), so
already-published archives are not stranded — several have no reproducible
source. That window forks in the container only, never below the layer frame.
Everything this record measures is written at v3.

## Why this shape fits the visualization range

| Workload                     | Physical shape                                                | Important optimization                                                              |
| ---------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Events and moving points     | GeoArrow point geometry plus columnar id/time/properties      | compact feature times; explicit coordinate/attribute quantization                   |
| Trips and trajectories       | GeoArrow LineString plus adaptive-width `vertex_time`         | temporal clipping, u16/u32 deltas, optional vertex-value quantization               |
| Polygons and regions         | GeoArrow polygon plus optional `triangles` and `part_offsets` | geometry simplification below the lossless max-zoom tier; optional pre-tessellation |
| Flows and corridors          | LineString plus vector or vertex-value columns                | GPU-ready fixed-size vectors and static-geometry value matrices                     |
| H3/Quadbin summaries         | summary variant with cell id and aggregate columns            | collision-free coexistence with raw tiles at identical `(z,x,y,t)`                  |
| Sparse categorical tiles     | plain Arrow `Utf8`                                            | avoids a tile-local dictionary batch that costs more than it saves                  |
| Repetitive categorical tiles | `Dictionary<UInt16,Utf8>`                                     | reduces repeated string bytes; selected from the actual tile values                 |

The archive remains vector-first. Time-varying rasters and scientific
datacubes require a different storage model and remain out of scope.

## Generation policy

Default and `--auto` builds preserve every usable source feature. Size is
managed first by an honest zoom range and temporal buckets. Per-tile thinning,
sampling, aggregation, and byte/feature budgets remain explicit opt-ins and
must report removals.

Temporal LOD is lossless re-bucketing: it preserves each feature and property
in coarser temporal request groups. It can reduce request count during broad
views, but increases archive bytes. Summary tiers are opt-in coarse-zoom
products in a separate variant; they never replace the raw tier.

The showcase generators follow the same rule. AIS and flight sampling now
default to `0` (disabled), reject negative intervals, and sample only when the
user supplies a positive interval.

## Directory and transport policy

Sparse archives use one compressed directory frame. At 8,192 entries and
above, `stt-build` pages the directory by default so cold viewport queries
load only the relevant leaves. `--paged-directory-min-entries 1` forces paging
for testing or a known range-heavy deployment; `--single-directory` opts out.

Every paged v3 manifest carries `rootHash` and one `pageHashes` value per leaf.
On-demand range reads are authenticated before decompression. A paged manifest
without those hashes is invalid; there is no unhashed paged compatibility
shape.

## Verification gates

The contract is pinned by:

- Rust v3 single and paged byte fixtures;
- Rust-to-TypeScript golden archive reads;
- manifest JSON Schema tests;
- adversarial directory and layer-frame decoders;
- a raw/summary overlap regression where both products intentionally share
  the same `(z,x,y,t)`;
- categorical tests covering tiny sparse values, repeated values, and more
  than 65,535 distinct strings;
- adaptive directory threshold tests;
- `stt-validate` schema checks that accept both exact categorical
  representations and classify their per-tile switch as expected adaptivity.

See [STT packed format](../spec/stt-packed-format.md),
[Conformance](../spec/conformance.md), and
[CLI reference](../api/cli-reference.md) for the normative contract and flags.
