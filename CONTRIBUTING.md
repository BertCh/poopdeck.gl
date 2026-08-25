# Contributing

Thanks for helping out. This file is the short version: layout, the commands
that actually exist, and the invariants you must not break. For the deeper
"to do X, look here" routing table — which CLI, which package, which doc —
read [`AGENTS.md`](AGENTS.md). It is written for AI agents but works fine for
humans, and it is the canonical map; this file deliberately does not duplicate
it.

## Layout

Two workspaces live side by side in one checkout.

```
crates/                 # cargo workspace — the 4 PUBLISHED crates
  stt-core/             #   archive + Arrow tile format library
  stt-build/            #   GeoParquet / PostGIS / DuckDB → packed .stt
  stt-optimize/         #   input analysis + archive inspect/doctor/diff
  spatiotemporal-tiles/ #   umbrella crate: re-exports the libs + ships the CLIs
    src/bin/            #     stt-build, stt-optimize, stt-validate,
                        #     stt-bundle, stt-serve
packages/               # pnpm workspace — 7 published packages + Cesium preview
  core/                 #   reader, decoder pool, cache, render kernel
  layers/               #   deck.gl backend (primary)
  three/ maplibre/       #   published alternate renderer backends
  cesium/                #   experimental workspace-only backend (private)
  playback/ react/      #   clock + governor + React UI
  mcp/                  #   published MCP server (`stt-mcp`)
examples/showcase/      # React Router demo site (dozens of real datasets)
tools/                  # bench, perf, render-test harnesses
  stt-generate/         #   reference-dataset generators — its OWN cargo
                        #   workspace, unpublished, off the root MSRV
docs/                   # spec, API reference, guides, architecture
poopdeck-ai/            # Claude Code plugin (MCP server + Agent Skills)
```

`stt-generate` is deliberately outside the root workspace (`cargo test
--manifest-path tools/stt-generate/Cargo.toml` to run it); the five shipped CLIs
are bins inside `spatiotemporal-tiles` and are feature-gated (a bare
`cargo install spatiotemporal-tiles` gets all five).

## Setup

- **Node 24+** and **pnpm** — the Node major is pinned by `.node-version`, and pnpm is
  pinned by `packageManager` in `package.json`, so `corepack enable` is enough.
- **Rust 1.87+** — the MSRV in `[workspace.package]`, enforced by a CI job that
  checks the four published crates on exactly that toolchain.

```bash
pnpm install
```

## TypeScript

```bash
pnpm build                                # turbo run build
pnpm test                                 # turbo run test
pnpm typecheck                            # turbo run typecheck

pnpm --filter @poopdeck.gl/core test      # one package
pnpm --filter @poopdeck.gl/showcase dev   # run the showcase locally

node scripts/smoke-pack.mjs               # publish-shape gate (after build)
```

`smoke-pack.mjs` packs real tarballs, installs them into scratch projects with
real peers, and imports every `exports` subpath under plain Node. CI runs it on
every PR and again before publishing, so run it yourself before touching a
package's `exports`, `files`, or build output.

The showcase consumes the packages' **built `dist/`**, which is git-ignored — if
you edit e.g. `packages/playback/src` and the showcase does not change, rebuild
that package.

## Rust

```bash
cargo test --workspace --locked                  # default features
cargo test --workspace --all-features --locked   # incl. duckdb, projection
cargo build --release                            # binaries → target/release/

# The generator is its own workspace — `--workspace` above does NOT cover it.
cargo test --manifest-path tools/stt-generate/Cargo.toml
```

CI additionally compiles each published feature combination on its own
(workspace feature unification would otherwise hide missing `cfg` gates), runs
`cargo package --workspace --exclude stt-generate --locked` as a standing
publishability check, and runs the `#[ignore]`d DuckDB spatial test (the only
one that exercises the SQL `stt-serve` emits). If you add a feature, add its
lane to `.github/workflows/ci.yml`.

## Lint & format

**oxlint + oxfmt. Prettier was removed — do not add it back.** Config lives in
`.oxlintrc.json` / `.oxfmtrc.json`; the house style is single quotes, 2-space
indent, 80-column print width.

```bash
pnpm lint          # oxlint
pnpm lint:fix
pnpm format        # oxfmt (writes)
pnpm format:check
```

Markdown in `docs/` and at the repo root is prose-wrapped at ~80 columns — match
the file you are editing.

## Releasing

npm and crates.io versions move in **lockstep** — one number, both registries.
There is one release system: **changesets drives the version, cargo-dist builds
the binaries.** (There used to be three; two of them had never produced a
release. release-plz was deleted rather than left as config nobody runs.)

Add `pnpm changeset` to any PR that changes a published package. The
`@poopdeck.gl/*` packages are a `fixed` group, so they all bump together.

To release:

1. **npm.** `release-npm.yml` opens a Version Packages PR from the accumulated
   changesets; merging it runs `pnpm version-packages` → `pnpm release`
   (build + `smoke-pack` + publish). That is what sets the canonical number.
2. **Everything else follows the canonical number.** Run
   `node scripts/sync-versions.mjs` — it rewrites `[workspace.package] version`
   in `Cargo.toml`, the Claude Code plugin manifest, the marketplace entry, and
   each skill's frontmatter `metadata.version` to match
   `packages/core/package.json`. `--check` reports drift and exits non-zero;
   CI runs it on every PR. **This is the gate that keeps crates.io and npm from
   diverging** — they did exactly that (0.4.0 vs 0.5.0) back when Cargo.toml
   was a hand edit no check covered.
3. **crates.io.** Publish by hand, in dependency order:
   `stt-core` → `stt-optimize` → `stt-build` → `spatiotemporal-tiles`.
   `stt-generate` is `publish = false`. Note the standing constraint in
   `docs/roadmap/shipping.md`: `cargo publish` stalls on upload from the
   author's network (h2 `PUT`-with-body hangs) — publish from elsewhere.
4. **Binaries.** Tag `v{version}` and push it, then run the **Release**
   workflow (Actions → Release → Run workflow) with that tag. cargo-dist is
   configured with `dispatch-releases = true`, so pushing the tag alone does
   **not** build anything.

Changelogs: `packages/*/CHANGELOG.md` are written by changesets — do not
hand-edit them. The crates have **no** changelog files, deliberately; the
GitHub Release cargo-dist creates in step 4 is the crate-side record.

## Invariants — do not break these

These are load-bearing design decisions, not style preferences. A change that
violates one will be sent back regardless of how well it is implemented.

- **No thinning.** Never thin, sample, or aggregate features to hit a byte
  budget — comprehensive data is the whole point of the format. Shrink by
  clamping the zoom range and using temporal bucketing. The H3/Quadbin
  **summary** tier is an opt-in coarse-zoom aid, never a replacement for the
  base tier.
- **The manifest/archive is the contract.** `manifest.json` carries
  capabilities, the temporal block, the pack table, and optional per-property
  style hints. Readers, CLIs, and renderers all negotiate through it — read it
  before guessing, and keep `docs/spec/manifest.schema.json` in step with any
  change.
- **Packs and the directory are immutable and content-addressed** (the hash is
  the filename). Only the small `manifest.json` is mutable. Never rewrite a pack
  in place — write a new one and update the manifest.
- **deck.gl is pinned to the `9.3.x` line** across the repo (see
  `pnpm.overrides`). Do not bump it.
- The showcase honors `prefers-reduced-motion`; any new animated surface must
  gate on it.

## Pull requests

Keep the diff scoped, run the relevant suite above, add a changeset if a
published package changed, and describe _why_ in the PR body. New behavior in a
CLI belongs in `docs/api/cli-reference.md`; new renderer behavior belongs in the
matching `docs/api/` page.
