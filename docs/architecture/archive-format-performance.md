# Archive layout and generation policy

## The current contract

STT uses one current archive contract:

- packed `formatVersion: 3`;
- directory codec v6;
- Arrow IPC layer frame v2 with GeoArrow geometry;
- immutable, content-addressed `.sttp` packs and `.sttd` directory objects;
- a required manifest `variants` registry;
- raw variant 0 and summary variant 1;
- one writer path and no payload transcode in either direction. The sole
  cross-version path is the container-only v2 → v3 migration
  (`stt_core::pack::migrate_dataset_v2_to_v3`), which rewrites the manifest and
  the directory object and never touches a pack. Any change below the container
  is a rebuild from source.

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

The showcase generators follow the same rule. AIS and flight sampling default
to `0` (disabled), reject negative intervals, and sample only when the user
supplies a positive interval.

See [STT packed format](../spec/stt-packed-format.md),
[Conformance](../spec/conformance.md), and
[CLI reference](../api/cli-reference.md) for the normative contract and flags.
