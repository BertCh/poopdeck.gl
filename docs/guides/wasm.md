# The WASM decoder

`crates/stt-wasm` compiles the **Rust** STT reader to WebAssembly and exposes
three moves through `wasm-bindgen`: open a `manifest.json` from bytes, list
tiles, decode a tile blob to Arrow IPC. It adds no decoding logic of its own —
every byte is parsed by the same `stt-core` code paths `stt-build` and
`stt-validate` use.

## Why it exists

The format has two readers: `stt_core::PackedReader` (Rust) and
`@poopdeck.gl/core` (TypeScript). Both were written by the same author against
the same intent, so `docs/spec/conformance.md` passing proves the two agree —
not that the spec is implementable by a stranger.

This crate does not fix that. What it does is far cheaper and, for adoption,
probably worth more: it puts the reader somewhere a **third party** can reach
it without porting anything. A Python notebook, a Go service, a C++ host, a
future GDAL or Martin path — none of them is going to reimplement a v6 varint
directory, and all of them already read Arrow IPC. Bytes in, Arrow out.

It is additive by construction: a new crate, no format change, no change to any
existing reader.

## What it is not

Not a renderer, not a tile server, and **not an independent implementation** —
if you are looking for the second implementation that would validate the spec,
this is not it. It is the first implementation, compiled small.

## Building

```bash
rustup target add wasm32-unknown-unknown
cargo build -p stt-wasm --target wasm32-unknown-unknown --release
# → target/wasm32-unknown-unknown/release/stt_wasm.wasm
```

That produces the raw module, and it is the only step verified so far. For a
loadable JS package you also need the bindgen glue — neither tool was available
on the machine that wrote this guide, so treat the recipe as the standard one
rather than as a tested one:

```bash
cargo install wasm-pack           # or: cargo install wasm-bindgen-cli
wasm-pack build crates/stt-wasm --target web --out-dir pkg
```

### macOS needs a different C compiler

zstd is a C library, so the wasm build has to compile C to wasm — and Apple's
`/usr/bin/clang` ships **no WebAssembly LLVM backend**:

```
error: unable to create target: 'No available targets are compatible with
triple "wasm32-unknown-unknown"'
```

That is a toolchain gap, not a code problem. Point `cc` at any clang that has
the backend — [wasi-sdk](https://github.com/WebAssembly/wasi-sdk/releases) is
the smallest self-contained option, and Homebrew `llvm` works too:

```bash
export CC_wasm32_unknown_unknown=/path/to/wasi-sdk/bin/clang
export AR_wasm32_unknown_unknown=/path/to/wasi-sdk/bin/llvm-ar
cargo build -p stt-wasm --target wasm32-unknown-unknown --release
```

Linux distro clang normally has every LLVM target enabled, so nothing extra is
needed there.

## Size

Measured back to back on one source snapshot, aarch64-apple-darwin host,
Rust 1.90, arrow 59, wasi-sdk 33 as the C compiler. The default row is the
release profile the workspace already defines (`opt-level = 3`, fat LTO,
`codegen-units = 1`, `strip = true`); the second row adds
`--config 'profile.release.opt-level="z"' --config 'profile.release.panic="abort"'`.

| build                                | raw                  | gzip -9           | brotli -q11       |
| ------------------------------------ | -------------------- | ----------------- | ----------------- |
| default release profile              | 3,599,971 (3.43 MiB) | 741,803 (724 KiB) | 490,194 (479 KiB) |
| `opt-level = "z"`, `panic = "abort"` | 2,884,797 (2.75 MiB) | 624,695 (610 KiB) | 420,485 (411 KiB) |
|                                      | −19.9%               | −15.8%            | −14.2%            |

Arrow is most of it — the `arrow` umbrella crate pulls the compute, cast, ord
and row kernels along with `arrow-ipc`, and `stt-core`'s public decode API
returns `arrow::array::RecordBatch`, so the dependency is not optional. Levers
not yet applied, in rough order of payoff:

- `wasm-opt -Oz` (ships with `wasm-pack`) — **not measured**; the tool was not
  available on the machine that produced this table, so no number is claimed for
  it.
- A dedicated `[profile.release-wasm]` in the workspace root, so the size trade
  does not apply to the native CLIs.
- Depending on `arrow-array` + `arrow-ipc` directly instead of the umbrella
  crate — only pays off if `stt-core` stops re-exporting `arrow` types, so it is
  a format-crate change, not a wasm-crate one.

Brotli is the honest number for a browser: 479 KiB over the wire, once, cached
by the CDN like any other asset.

## The API

`SttArchive` never does I/O. It tells you which object key and which byte range
it needs next; you fetch the bytes however your host already fetches bytes —
`fetch`, `requests`, `fsspec`, a local file — and hand them back. Range-request
policy (auth, retries, caching, coalescing) stays where you already solved it,
and the module stays small and synchronous.

| method                                              | takes                                              | gives                                              |
| --------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------- |
| `version()`                                         |                                                    | the decoder's crate version                        |
| `SttArchive.open(bytes)`                            | `manifest.json` bytes                              | an archive handle                                  |
| `.formatVersion()`                                  |                                                    | `3`                                                |
| `.metadataJson()`                                   |                                                    | dataset metadata as JSON (bbox, time range, zooms) |
| `.directoryKey()` / `.directoryLength()`            |                                                    | the object to fetch next, and its size             |
| `.directoryIsPaged()`                               |                                                    | whether the directory object is paged              |
| `.loadDirectory(bytes)`                             | the whole directory object                         | tile count                                         |
| `.tileCount()` / `.tile(i)`                         |                                                    | one `TileInfo`                                     |
| `.tilesJson()`                                      |                                                    | every tile as one JSON array (bulk path)           |
| `.packCount()` / `.packKey(id)` / `.packLength(id)` |                                                    | pack object keys                                   |
| `.decodeTile(i, blob)`                              | exactly the tile's `[offset, offset+length)` bytes | a `DecodedTile`                                    |
| `.decodeTileInPack(i, packBytes)`                   | the whole pack object                              | a `DecodedTile`                                    |

`version()` is a free module export, not a method on `SttArchive` — a host logs
it to record which decoder it loaded.

`TileInfo` carries `zoom`, `x`, `y`, `timeStart`, `timeEnd`, `featureCount`,
`packId`, `offset`, `length`, `uncompressedSize`. Times and offsets are plain
numbers, not `BigInt`: Unix-ms and pack offsets are exact in a double for
anything this format can hold, and `BigInt` would force every host to convert.

`DecodedTile` gives `layerCount()`, `layerName(i)` and `layerIpc(i)`. Each
`layerIpc` is a **self-contained Arrow IPC stream** — schema message, one
record batch, EOS. That re-framing is the point of the crate: on disk a
formatVersion-3 tile references a schema template stored once in the manifest,
which is excellent on the wire and useless to a consumer that only speaks
Arrow.

### JavaScript

```js
import init, { SttArchive } from './pkg/stt_wasm.js';
import { tableFromIPC } from 'apache-arrow';

await init();
const base = 'https://tiles.example.com/earthquakes';
const get = async (key, range) =>
  new Uint8Array(
    await (
      await fetch(`${base}/${key}`, range && { headers: { Range: range } })
    ).arrayBuffer(),
  );

const archive = SttArchive.open(await get('manifest.json'));
archive.loadDirectory(await get(archive.directoryKey()));

const tile = archive.tile(0);
const start = tile.offset;
const blob = await get(
  archive.packKey(tile.packId),
  `bytes=${start}-${start + tile.length - 1}`,
);

const decoded = archive.decodeTile(0, blob);
for (let i = 0; i < decoded.layerCount(); i++) {
  const table = tableFromIPC(decoded.layerIpc(i));
  console.log(
    decoded.layerName(i),
    table.numRows,
    table.schema.fields.map((f) => f.name),
  );
}
```

Note the `Range` header: one request per tile, `[offset, offset + length)`. The
whole-pack form (`decodeTileInPack`) is there for a host that already has the
pack cached, or that reads from local disk.

### Python

There is no PyPI wheel (see below). Today the path is any wasm runtime with
wasm-bindgen glue — `wasmtime-py` plus the `--target nodejs`/`--target bundler`
output, or `pywasm`. Once the bytes are out, the consumption is ordinary:

```python
import pyarrow as pa

blob = session.get(f"{base}/{pack_key}",
                   headers={"Range": f"bytes={offset}-{offset + length - 1}"}).content
decoded = archive.decodeTile(index, blob)
for i in range(decoded.layerCount()):
    table = pa.ipc.open_stream(decoded.layerIpc(i)).read_all()
```

`docs/guides/python.md` covers the other direction — getting Python data
**into** an archive with `stt-build`.

## What this does NOT do yet

Named honestly, because each one is a real gap and not a rounding error:

- **Not published.** `publish = false`, and there is no npm package and no PyPI
  wheel. You build it yourself. Publishing means settling the wasm-pack
  packaging, a name, and a version-skew policy against `@poopdeck.gl/core`, and
  none of that is decided.
- **No fetching.** By design, but it does mean there is no batteries-included
  path: you write the fetch loop. There is no request coalescing, no retry, no
  cache, no concurrency control — the TypeScript reader has all of that, and
  none of it is here.
- **Paged directories load whole.** `loadDirectory` takes the entire `.sttd`
  even when the manifest says `layout: "paged"` (`.directoryIsPaged()` reports
  which layout you got). The paging win — fetching only the leaf pages a
  viewport and time window touch — needs a leaf-at-a-time API this crate does
  not expose. Correct, just not cold-start-cheap.
- **No tile lookup by address or time.** You get the directory as a flat list in
  directory order (zoom, then Hilbert index) and index into it. Spatial and
  temporal query live in the host for now; `tilesJson()` exists so you can build
  your own index without crossing the wasm boundary per tile.
- **No content-address verification.** Pack and directory objects are named by
  their blake3-128 hash and this decoder does not check it. Per-tile CRC32C
  **is** verified on every decode, and both object length and blob length are
  checked against the manifest, so truncation and corruption are caught — but
  the object-level hash is not. `stt-validate` does that check.
- **No writer.** Decode only. Nothing here builds or repacks an archive.
- **No bundle (`.sttb`) support.** The single-file interchange profile has no
  entry point here; only the exploded manifest + directory + packs layout.
- **Not tested in a browser.** The test suite runs the exported entry points on
  the host, including a parity suite that decodes every tile of a freshly
  written archive through both this reader and `stt_core::PackedReader` and
  compares the Arrow record batches. What is _not_ covered is the wasm-bindgen
  glue itself — that needs `wasm-bindgen-test` and a headless runner.

## Tests

```bash
cargo test -p stt-wasm
```

Fixtures are written by the real `PackWriter` in both v3 directory layouts:
single and paged. Refusal is covered by mutating a live manifest — an unknown
required capability, an unsupported `formatVersion`, and non-STT JSON — since
this reader accepts exactly `formatVersion` 3 and nothing else. A format change
fails here rather than in a published artifact.
