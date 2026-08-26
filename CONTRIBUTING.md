# Contributing

Thanks for helping out. This file is the short version: layout, the commands
that actually exist, and the invariants you must not break. For the deeper
"to do X, look here" routing table — which CLI, which package, which doc —
read [`AGENTS.md`](AGENTS.md). It is written for AI agents but works fine for
humans, and it is the canonical map; this file deliberately does not duplicate
it.

## Layout

One pnpm workspace. The Rust toolchain that BUILDS archives lives in a separate
repository, [BertCh/spatiotemporal-tiles][stt-repo]; this one renders them.

```
packages/               # pnpm workspace — 7 published packages + Cesium preview
  core/                 #   reader, decoder pool, cache, render kernel
  layers/               #   deck.gl backend (primary)
  three/ maplibre/       #   published alternate renderer backends
  cesium/                #   experimental workspace-only backend (private)
  playback/ react/      #   clock + governor + React UI
  mcp/                  #   published MCP server (`stt-mcp`)
examples/showcase/      # React Router demo site (dozens of real datasets)
examples/minimal/       # the PUBLISHED packages from npm — the smoke example
tools/                  # bench, perf, render-test harnesses
docs/                   # API reference, guides, architecture + the vendored spec
poopdeck-ai/            # Claude Code plugin (MCP server + Agent Skills)
```

[stt-repo]: https://github.com/BertCh/spatiotemporal-tiles

### The vendored half of `docs/`

Twenty-three pages under `docs/` — the whole normative `docs/spec/` set, the
CLI reference, the format architecture pages, and several guides — are
**authored upstream and copied here** so poopdeck.gl serves one complete
corpus. `.stt-sync.json` is the list. They carry no banner in their bodies (it
would break the byte comparison), so check that file before editing a doc that
describes the _format_ rather than the _renderer_.

```bash
pnpm stt:check                                     # CI gate: vendored == upstream
STT_REPO=../spatiotemporal-tiles pnpm stt:sync     # refresh from a local checkout
pnpm stt:sync --ref <sha>                          # re-pin to an upstream commit
```

The same mechanism vendors the six conformance golden-fixture trees under
`packages/core/test/fixtures/` (produced by the Rust writer, so re-blessing them
here is incoherent — see `.github/scripts/check-golden-pins.mjs`) and the `stt`
block of `project-status.json`.

A change that spans both repositories lands **upstream first**: the vectors and
the spec move, `pnpm stt:check` here goes red, and the reader catches up. That
ordering is the point, not an inconvenience.

## Setup

- **Node 24+** and **pnpm** — the Node major is pinned by `.node-version`, and pnpm is
  pinned by `packageManager` in `package.json`, so `corepack enable` is enough.
- **No Rust toolchain is required.** If you want to build archives locally,
  `cargo install spatiotemporal-tiles` gets the five CLIs; to co-develop a
  format change, clone the upstream repo beside this one and point `STT_REPO`
  at it.

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

## Archives to develop against

There is no Rust in this checkout. The showcase reads the published fleet over
HTTPS in production and needs nothing local. To work against your own data:

```bash
cargo install spatiotemporal-tiles     # the five stt-* CLIs
stt-build --input data.parquet --output tiles --time-field ts --time-format unix-ms
```

Then either drop the result under `examples/showcase/public/data/` (git-ignored)
or point `VITE_DATA_BASE_URL` at wherever you serve it. The reader tests do not
need any of this — they run against the committed conformance vectors.

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

**npm and crates.io no longer move in lockstep.** Before the 2026-08-26
repository split they shared one number, and a `sync-versions` gate existed
because they had once diverged silently (0.4.0 vs 0.5.0). Now they are separate
projects: this repository releases `@poopdeck.gl/*` on its own cadence, and what
relates the two stacks is the archive's `formatVersion`, declared in
`project-status.json` on both sides
([repo-split-2026-08.md §2.3](docs/roadmap/repo-split-2026-08.md)). Do not
"fix" a version mismatch between the registries — there is nothing to fix.

Add `pnpm changeset` to any PR that changes a published package. The
`@poopdeck.gl/*` packages are a `fixed` group, so they all bump together.

To release:

1. **npm.** `release-npm.yml` opens a Version Packages PR from the accumulated
   changesets; merging it runs `pnpm version-packages` → `pnpm release`
   (build + `smoke-pack` + publish). That sets the canonical number.
2. **The plugin surface follows it.** Run `node scripts/sync-versions.mjs` — it
   rewrites the Claude Code plugin manifest, the marketplace entry, and each
   skill's frontmatter `metadata.version` to match `packages/core/package.json`.
   `--check` reports drift and exits non-zero; CI runs it on every PR. These
   files sit outside the changesets fixed group, so nothing else bumps them.

3. **Bump `examples/minimal` afterwards.** It installs the packages from **npm**,
   not from the workspace — that is the whole point of it — so it can only name
   a version that already exists. `changeset version` rewrites its ranges to the
   version being released, which does not resolve until the publish lands and
   breaks `pnpm install --frozen-lockfile` in the meantime. Hold it at the last
   published range through the release commit, then bump it once npm has the new
   one.

Changelogs: `packages/*/CHANGELOG.md` are written by changesets — do not
hand-edit them.

## Invariants — do not break these

These are load-bearing design decisions, not style preferences. A change that
violates one will be sent back regardless of how well it is implemented.

- **No thinning.** Never thin, sample, or aggregate features to hit a byte
  budget — comprehensive data is the whole point of the format. Shrink by
  clamping the zoom range and using temporal bucketing. The H3/Quadbin
  **summary** tier is an opt-in coarse-zoom aid, never a replacement for the
  base tier.
- **The manifest/archive is the contract**, and since the split it is the
  contract _between two repositories_. `manifest.json` carries capabilities, the
  temporal block, the pack table, and optional per-property style hints. Readers
  and renderers negotiate through it. `docs/spec/manifest.schema.json` is
  vendored: a reader change that needs a schema change is an upstream change
  first.
- **Packs and the directory are immutable and content-addressed** (the hash is
  the filename). Only the small `manifest.json` is mutable. Never rewrite a pack
  in place — write a new one and update the manifest.
- **deck.gl is pinned to the `9.3.x` line** across the repo (see `overrides` in
  `pnpm-workspace.yaml` — pnpm 11 no longer reads `pnpm.overrides` from
  `package.json`). Do not bump it.
- **The luma.gl patch in `patches/` is load-bearing.** It is the `UniformBlock`
  UBO re-upload fix, worth 44.6 → 86.8 fps on storm-4d; losing it is a silent
  2× frame-time regression.
- The showcase honors `prefers-reduced-motion`; any new animated surface must
  gate on it.

## Pull requests

Keep the diff scoped, run the relevant suite above, add a changeset if a
published package changed, and describe _why_ in the PR body. New renderer
behavior belongs in the matching `docs/api/` page. New CLI behavior belongs in
`docs/api/cli-reference.md` — which is vendored, so that half of the change goes
upstream.
