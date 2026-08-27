# Shipping & distribution — decision record

_How this project is published, why the scheme looks the way it does, and what
was counted out. Behavior of the CLIs themselves lives in
[../api/cli-reference.md](../api/cli-reference.md)._

> **Status note (2026-08-26).** This is a decision record, so dated registry
> observations below are retained as history. For the current release procedure,
> use [CONTRIBUTING.md](../../CONTRIBUTING.md#releasing). The manifests here
> currently define seven public `@poopdeck.gl/*` packages at **0.8.0** and the
> private experimental Cesium package at **0.5.0** (`packages/*/package.json`,
> mirrored into `project-status.json`). The cargo half of this record — facade
> naming, the feature/install matrix, cargo-dist, the crates.io HTTP/2 publish
> stall, and the R2 fleet-publishing order — moved upstream with the crates and
> now lives in the STT repository's
> [shipping.md](https://github.com/BertCh/spatiotemporal-tiles/blob/main/docs/roadmap/shipping.md).

## Distribution pathways (decided)

| channel               | artifact                                                                                               | mechanism                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| npm `@poopdeck.gl`    | 7 public packages: core, playback, layers, maplibre, three, react, mcp; Cesium is private/experimental | changesets (`fixed` group) + `release-npm.yml`; `pnpm -r publish` rewrites `workspace:*` |
| Cloudflare (existing) | showcase site                                                                                          | `wrangler` (the R2 tile fleet ships from the STT repository)                             |

## Naming rationale

`@poopdeck.gl` is an npm scope, so the package family gets a namespace for free
— the thing crates.io's flat namespace forced the facade design on upstream.
Each package is named for the host it binds to (`layers` = deck.gl, `three`,
`maplibre`, `cesium`), with `core` and `playback` host-free.

## Version/tag scheme

- The seven public npm packages release as one changesets `fixed` group
  (`.changeset/config.json`) and currently read **0.8.0**. The private Cesium
  package is outside that release set.
- npm tags are changesets-style `@poopdeck.gl/pkg@x.y.z`.
- Since the 2026-08-26 split there is **no lockstep with crates.io**. The two
  stacks release on their own cadences and are related only by the archive's
  `formatVersion` ([repo-split-2026-08.md §2.3](./repo-split-2026-08.md)).

## Release systems: three became two (the deletion happened)

The repo used to carry **three** independent release mechanisms and used none of
them end-to-end. `release-plz.toml` and `.github/workflows/release-plz.yml` are
now **gone** (verified 2026-07-26): changesets owns npm, while cargo-dist builds
Rust binaries from a manually dispatched workflow for an existing `v{version}`
tag. The evidence that forced the deletion is kept because it is the argument
against ever adding a third (**as of 2026-07-26**):

- `.changeset/` holds `config.json` and nothing else; the last commit to touch
  a changeset `.md` was the 0.3.0 release (`94e807b`). _(Still true.)_
- `crates/*/CHANGELOG.md` **do not exist**, despite `release-plz.toml` setting
  `changelog_update = true`.
- 0.5.0 landed as a hand-edited bump commit (`8bdc01d`, "bump workspace and npm
  packages to 0.5.0"), not as output of any of the three.

**The reasoning that settled it, kept as the standing rule.** release-plz's value
is the release-PR/changelog workflow, and that workflow produced zero PRs and zero
changelogs here — a third system whose only effect was to make the crate
changelogs look _missing_ rather than absent-by-choice. Changesets keeps npm (it
already owns the `fixed` group and the `@poopdeck.gl/pkg@x.y.z` tags); Rust
binary distribution went upstream with the crates at the 2026-08-26 split.

## Auth lifecycle (token → OIDC)

Bootstrap tokens live in the gitignored root `.env` (`NPM_TOKEN`,
`CRATES_TOKEN`). The current npm workflow is the future trusted-publisher target:
configure each public package for `release-npm.yml`, enable provenance now that
the repository is public, then revoke `NPM_TOKEN`. That is still open — **T3** in
the [roadmap README](./README.md).

## CI gates that keep publishability true

> **First green run on GitHub's own runners: 2026-08-26** (`CI` and `Release npm`,
> `main` at `027e2f6`). The durable lesson from the 2026-07-31 hand-run that
> preceded it: running every job by hand found four red that the default suite
> could not see, which is why each gate below is listed separately rather than
> folded into one "tests pass" line.

`.github/workflows/ci.yml` declares three jobs — `typescript-lint`,
`typescript`, `showcase-probe`. The publishability-relevant steps:

- **Vendored STT artifacts match upstream** (`scripts/sync-stt.mjs --check`):
  byte-compares the 25 vendored doc entries, the conformance vector trees under
  `packages/core/test/fixtures/`, and the `stt` block of `project-status.json`
  against the pinned upstream SHA. Fails rather than skips if it cannot reach a
  source.
- **`scripts/check-project-status.mjs`**: proves every `project-status.json`
  claim this repository can still decide against the manifest that decides it.
- **`scripts/check-doc-links.mjs`** and
  **`.github/scripts/check-roadmap-citations.mjs`**: relative links and
  `docs/roadmap/*.md §N` citations resolve, by anchor where one is given.
- **`.github/scripts/check-golden-pins.mjs`** plus its own `node --test`
  self-test: golden byte pins only move inside a declared rebuild window.
- **`scripts/gen-capabilities-doc.mjs --check`**: the generated backend
  capability matrix matches the descriptors.
- **`scripts/check-doc-snippets.mjs`**: the copy-pasteable onboarding samples
  typecheck (needs a build first).
- **`scripts/smoke-pack.mjs`** (a step in the `typescript` job, and the
  `release-npm` pre-publish gate): packs every package tarball, scratch-installs
  with real peers, imports EVERY exports key under plain Node, plus a deck-free
  core+playback+react install (HoverPreview regression).
- **`showcase-probe`**: every demo loads in headless Chromium.

## Explicit non-goals (counted out, with revival triggers)

- **DB extensions** (pgrx Postgres extension, DuckDB community extension):
  the DB story is input adaptors + the `stt-serve` binary (the `ST_AsMVT`
  analog, per `db-input-adaptors.md`). Nothing runs _inside_ a database.
- **Python packaging**: `stt:scripts/data-generation/*` stay internal scripts
  (dataset-specific licenses, per-dataset venvs).
- **Docker image / Homebrew tap**: cargo-dist's installers + `cargo install`
  cover it. Revive with a ghcr.io image for `stt-serve` if someone actually
  asks to run the server as a service.
- **Node 24+ is the _development_ floor** (`.node-version`, `.nvmrc`, the root
  `package.json` engines, `packageManager` pnpm@11.23.0). The published browser
  packages declare `node >=20` so a consumer on Node 20 LTS can install them;
  `@poopdeck.gl/mcp` is the exception at `>=24.0.0` because it runs as a server
  process. `project-status.json` carries both, as `toolchain.node` and
  `toolchain.runtimeNode`. apache-arrow stays a hard dep of core.

**Closed, do not re-litigate: MapLibre v5/v6.** This was counted out when v5
replaced the positional-matrix custom-layer `render(gl, matrix)` signature. The
host-version adapter now normalizes the supported signatures, the declared peer
range is `^3 || ^4 || ^5 || ^6`, and the showcase runs 6.6.x
(`packages/maplibre/src/lib/host-adapter.ts`, per `base-layer.ts`).

## Known risks / fallbacks

- The `fixed` group means one package's patch drags all seven; that is accepted
  as the price of a single number a consumer can reason about across the family.
- The Cesium package sits outside the group at `0.5.0` and is `private`, so
  nothing bumps it automatically — it drifts by design, not by accident.

_(cargo-dist, docs.rs and the Windows dist job are risks of the Rust
distribution and moved upstream with it.)_
