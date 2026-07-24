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
crates/                 # cargo workspace — 5 crates
  stt-core/             #   archive + Arrow tile format library
  stt-build/            #   GeoParquet / PostGIS / DuckDB → packed .stt
  stt-optimize/         #   input analysis + archive inspect/doctor/diff
  stt-generate/         #   bundled reference-dataset generators (unpublished)
  spatiotemporal-tiles/ #   umbrella crate: re-exports the libs + ships the CLIs
    src/bin/            #     stt-build, stt-optimize, stt-validate,
                        #     stt-bundle, stt-serve
packages/               # pnpm workspace — 8 @poopdeck.gl packages
  core/                 #   reader, decoder pool, cache, render kernel
  layers/               #   deck.gl backend (primary)
  three/ maplibre/ cesium/   #   alternate renderer backends
  playback/ react/      #   clock + governor + React UI
  mcp/                  #   MCP server (`stt-mcp`) — not yet on npm
examples/showcase/      # React Router demo site (dozens of real datasets)
tools/                  # bench, perf, render-test harnesses
docs/                   # spec, API reference, guides, architecture
poopdeck-ai/            # Claude Code plugin (MCP server + Agent Skills)
```

`stt-generate` is a separate crate with its own `stt-generate` binary; the other
five CLIs are bins inside `spatiotemporal-tiles` and are feature-gated (a bare
`cargo install spatiotemporal-tiles` gets all five).

## Setup

- **Node 20+** (`packages/mcp` requires `>=20`) and **pnpm** — the version is
  pinned by `packageManager` in `package.json`, so `corepack enable` is enough.
- **Rust 1.88+** — the MSRV in `[workspace.package]`, enforced by a CI job.

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
```

CI additionally compiles each published feature combination on its own
(workspace feature unification would otherwise hide missing `cfg` gates) and
runs `cargo package --workspace --exclude stt-generate --locked` as a standing
publishability check. If you add a feature, add its lane to
`.github/workflows/ci.yml`.

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

npm and crates.io versions move in **lockstep**, and each side has its own
automation:

- **npm** — [changesets](https://github.com/changesets/changesets). Add
  `pnpm changeset` to any PR that changes a published package; the
  `@poopdeck.gl/*` packages are a `fixed` group, so they all bump together.
  `release-npm.yml` opens a Version Packages PR and publishes on merge
  (`pnpm version-packages` → `pnpm release`).
- **crates.io** — [release-plz](https://release-plz.dev) (`release-plz.toml`):
  merging to `main` opens a release PR that bumps the version group and updates
  changelogs; merging that publishes the crates and tags `v{version}`, which
  cargo-dist picks up to build binaries.
- **Everything else** — `node scripts/sync-versions.mjs` rewrites the files no
  release tool owns: the Claude Code plugin manifest, the marketplace entry, and
  each skill's frontmatter `metadata.version`. Run it after a version bump;
  `--check` reports drift and exits non-zero.

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
