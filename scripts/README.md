# Scripts

Repository tooling for poopdeck.gl. Everything here runs under plain `node` —
there is no build step and nothing is published.

| Script                         | What it does                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `sync-stt.mjs`                 | Vendors the docs, conformance vectors and status block this repo consumes from STT; `--check` gates it      |
| `check-project-status.mjs`     | Proves every claim in `project-status.json` against the manifest that decides it                            |
| `sync-versions.mjs`            | Keeps the Claude Code plugin surface in lockstep with `packages/core`'s version                             |
| `check-doc-links.mjs`          | Every relative link in every Markdown file resolves                                                         |
| `check-doc-snippets.mjs`       | Typechecks the code samples in the docs (needs a `turbo run build` first)                                   |
| `gen-capabilities-doc.mjs`     | Regenerates `docs/spec/backend-capabilities.md` from each backend's `BackendDescriptor`; `--check` gates it |
| `smoke-pack.mjs`               | Pre-publish gate: real tarballs, real peers, every `exports` subpath                                        |
| `estimate-3d-tiles-ground.mjs` | Probes Google's Photorealistic 3D Tiles for each AV scene's ground height                                   |

## Datasets are not built here

Dataset generation moved to the STT repository with the toolchain that does it
(`stt-generate`, `stt-build`, and the Python extractors under
`stt:scripts/data-generation/`) — see
[repo-split-2026-08.md](../docs/roadmap/repo-split-2026-08.md). To build the
showcase's data locally:

```bash
cargo install --git https://github.com/BertCh/spatiotemporal-tiles \
  --locked spatiotemporal-tiles --features cli
# then, from a checkout of that repository:
cargo install --path stt:tools/stt-generate
stt-generate earthquakes --output earthquakes.stt
```

Point the showcase at the result with `VITE_DATA_BASE`, or drop the archive
under `examples/showcase/public/data/`. In production the showcase reads the
published fleet over HTTPS and builds nothing.

---

**See also**: [Repository README](../README.md) ·
[Data generation guide](../docs/guides/data-generation.md) (vendored from STT)
