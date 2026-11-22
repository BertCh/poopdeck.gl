# `path-codec/` — the `PATH_CODEC` section (packed-format §5.2.7)

Vectors for the opt-in path codec: a LineString layer whose coordinates and
per-vertex times ride a `PATH_CODEC` (`0x06`) layer-frame section, behind the
must-understand `path-codec` capability. A reader that implements the
capability must pass all of them; a reader that does not must refuse the two
archives at open.

Regenerate with `cargo run -p stt-core --example make-path-codec-vectors`.
Byte-reproducible: a re-run is a no-op diff unless the writer changed.

| file / dir      | what it is                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sections.json` | bare section bytes. `valid[]`: `section_hex` + the exact decoded `expected` values. `reject[]`: sections a decoder MUST reject, each with its `reason`                            |
| `tiles.json`    | whole UNCOMPRESSED self-contained (inline-schema) tile payloads with codec layers, each with a non-codec `twin_payload_hex` and the decoded `geometry` / `vertex_time` columns |
| `grid/`         | packed archive, `--quantize-coords 1` (world-grid mode, `Int32` leaf), capabilities `coord-quant`, `path-codec`, `time-delta`                                                    |
| `decimal/`      | packed archive, raw `Float64` (decimal mode), capabilities `path-codec`, `time-delta`                                                                                            |

## Number spelling

Chosen so a JavaScript test can compare bit-exactly without a float parser:

- Float64 coordinates: 16 lowercase hex digits, the IEEE-754 bit pattern read
  as a big-endian `u64` (`f64::to_bits` / `DataView.getBigUint64`). `-0.0`,
  NaN payloads and infinities are distinct values.
- Int32 grid indices: JSON numbers.
- Times (Unix ms, `i64`): decimal strings.

## `sections.json`

```text
valid[i]  = { name, note, section_hex, tags, exception_count,
              expected: { mode: "grid" | "decimal", counts: [u32],
                          coords: [[x, y]] (numbers or f64 hex),
                          times: [string] | null } }
reject[i] = { name, reason, section_hex }
```

`coords` and `times` are flat across the layer (vertex `n` of the layer is
`coords[n]`), features in row order; `counts[f]` vertices belong to feature
`f`. `tags` and `exception_count` are informational (which predictors and how
many XOR patches the section uses). `valid` covers both modes, with and
without TIME: a `TIME_VEL` feature, an empty feature, a single-vertex feature,
unsorted and negative times, decimal exceptions (a clip vertex, `-0.0`, NaN,
±inf), an all-exceptions layer, Int32 extremes, and a zero-feature layer.
`reject` covers a trailing byte, a bad version, a reserved flag bit,
`r >= U`, `U = 0`, an unknown tag, `TIME_VEL` without TIME, a count mismatch,
exception indices out of range / not increasing, a patch half above
`2^32 - 1`, `e > 15`, an Int32 overflow, the `±(2^53 - 1)` integer bound,
truncation, and a count the section is too short to hold.

## `tiles.json`

```text
tiles[i] = { name, quantize_coords_m, payload_hex, twin_payload_hex,
             layers: [{ name, rows, path_codec, columns,
                        geometry: { leaf: "Int32" | "Float64",
                                    offsets: [i32], values: [...] } | null,
                        vertex_time: { offsets: [i32], valid: [bool],
                                       values: [string] } | null }] }
```

`payload_hex` and `twin_payload_hex` are the SAME layers, with and without the
codec; the twin uses the absolute `List<Int64>` vertex-time tier, the shape a
codec layer decodes to, so decoding both must yield identical columns.
`path_codec` says whether that layer carried the section (the `stops` point
layer in `grid-tile` does not — a tile may mix codec and non-codec layers).
`geometry.values` is the flat coordinate leaf (`x, y, x, y, …`); a codec
feature with zero vertices has an empty geometry list and a NULL
`vertex_time` entry (`valid[f] = false`).
