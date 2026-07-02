# Shipping & distribution — decision record (2026-07)

Status: **EXECUTING** — hygiene + automation landed; first publishes pending.
Owner of the publish backlog. Companion audits: `full-ecosystem-audit-2026-07.md`
(release-story criticals), `naming-types-consistency-2026-06.md` (closed).

## Distribution pathways (decided)

| channel | artifact | mechanism |
|---|---|---|
| npm `@poopdeck.gl` | 7 packages: core, playback, layers, maplibre, three, cesium, react | changesets (fixed/lockstep group) + `release-npm.yml`; `pnpm -r publish` rewrites `workspace:*` |
| crates.io | **one public name**: `spatiotemporal-tiles` (facade lib + all 4 CLI bins, feature-gated) over 3 internal lib crates: `stt-core`, `stt-build`, `stt-optimize` | release-plz (lockstep `version_group`, tag `v{ver}`) + Trusted Publishing |
| GitHub Releases | prebuilt `stt-*` binaries, 5 targets + shell/powershell installers | cargo-dist on tag push (`release.yml`, generated/vendored) |
| Cloudflare (existing) | showcase site + R2 tile data | unchanged (`wrangler`, `scripts/r2-sync.sh`) |

## Naming rationale

- crates.io has a flat namespace; the bare `stt` name is squatted by an
  abandoned whisper lib, and "stt" reads as speech-to-text anyway. RFC 3243
  (`spatiotemporal-tiles::core`-style namespaces) is a 2026 Rust project goal
  but **not yet publishable** — owning the `spatiotemporal-tiles` base name
  reserves that namespace for when it lands.
- The facade is the bevy/gix model: users type ONE name
  (`cargo add spatiotemporal-tiles`, `cargo install spatiotemporal-tiles
  --features cli`); `stt-core/build/optimize` publish only because cargo
  requires published deps, and carry "internal implementation crate" banners.
- `crates/stt-validate` and `crates/stt-serve` were dissolved into the facade
  as feature-gated `src/bin/` targets (binary names unchanged: `stt-build`,
  `stt-optimize`, `stt-validate`, `stt-serve`). `stt-generate` stays
  `publish = false` (RC nexrad deps; internal demo tooling).

## Feature/install matrix (facade)

- `default = []` → `stt::core` only (slim `cargo add`).
- `build` / `optimize` → library re-exports; `postgres` / `duckdb` forward to
  stt-build's input sources; `projection` (system libproj) is never in
  defaults, docs.rs, or dist builds.
- `cli` → all four bins, both stt-serve backends. Lighter serve:
  `--features build-cli,optimize-cli,validate-cli,serve-postgres` skips the
  ~10-min bundled-DuckDB compile. `serve` alone is a deliberate
  `compile_error!` (needs ≥1 backend).
- stt-build's `geoparquet` feature is now a **no-op back-compat alias** — the
  encode path needs arrow/parquet unconditionally (the optional-feature split
  never compiled and was untested before this work).

## Version/tag scheme

- Everything lockstep at 0.1.0 (npm `fixed` group; `[workspace.package]`).
- Rust tag: `v{version}` (release-plz creates on the facade; cargo-dist
  consumes). npm tags: changesets-style `@poopdeck.gl/pkg@x.y.z`. No overlap.
- MSRV: `rust-version = 1.88` (empirically forced by `home`/`osmpbf`/
  `delaunator`; enforced by the CI `rust-msrv` job). Bumps are deliberate,
  in minor releases.

## Auth lifecycle (token → OIDC)

Bootstrap tokens live in the gitignored root `.env` (`NPM_TOKEN`,
`CRATES_TOKEN`). Both registries only allow Trusted-Publisher config AFTER a
package exists, so: first publish with tokens → same day, configure GitHub
trusted publishers (npm: each package → `release-npm.yml`; crates.io: each
crate → `release-plz.yml`) → revoke both tokens. `RELEASE_PLZ_PAT` (a PAT, not
`GITHUB_TOKEN`) is needed so release PRs trigger CI. npm provenance
(`NPM_CONFIG_PROVENANCE`) requires a **public** repo — enable it when the repo
flips public.

## CI gates that keep publishability true

- `smoke-pack` (typescript job + release-npm pre-publish): packs all 7
  tarballs, scratch-installs with real peers, imports EVERY exports key under
  plain Node, plus a deck-free core+playback+react install (HoverPreview
  regression).
- `rust-package`: `cargo package --workspace --exclude stt-generate --locked`
  on every PR.
- `rust-feature-lanes`: facade `serve-postgres` / `serve-duckdb` / `cli` solo
  compiles + stt-build `--no-default-features`.
- `rust-all-features`: tests (not just builds) the full feature surface.
- `rust-msrv`: `cargo check --workspace` on 1.88.

## Explicit non-goals (counted out, revisit on demand)

- **DB extensions** (pgrx Postgres extension, DuckDB community extension):
  the DB story is input adaptors + the `stt-serve` binary (the `ST_AsMVT`
  analog, per `db-input-adaptors.md`). Nothing runs *inside* a database.
- **Python packaging**: `scripts/data-generation/*` stay internal scripts
  (dataset-specific licenses, per-dataset venvs).
- **Docker image / Homebrew tap**: not this wave; cargo-dist's installers +
  `cargo install` cover it. A ghcr.io image for stt-serve is the natural next
  channel if demand appears.
- **MapLibre v5**: peer stays `^3 || ^4` — v5 replaced the positional-matrix
  custom-layer `render(gl, matrix)` signature (see
  `packages/maplibre/src/base-layer.ts`); port tracked separately.
- Node 18 (EOL; engines `>=20`), apache-arrow stays a hard dep of core.

## First-publish runbooks

See the phase-5 section of the working plan; condensed:

1. **npm**: verify `NPM_TOKEN` scope (granular, `@poopdeck.gl` + new
   packages, write, bypass-2FA) → add as repo secret → merge to main →
   `release-npm.yml` publishes all 7 (changesets publishes any
   version missing from the registry, no changeset files needed for 0.1.0) →
   verify `npm view` ×7 + registry-install smoke → trusted publishers + token
   revoke + "2FA or automation" publish access.
2. **crates.io**: `CARGO_REGISTRY_TOKEN="$CRATES_TOKEN"` then
   `cargo publish --locked -p` in order: `stt-core` → `stt-optimize` →
   `stt-build` → `spatiotemporal-tiles` (4 new crates fit the burst limit) →
   trusted publishers + token revoke → `git tag v0.1.0 && git push origin
   v0.1.0` → dist builds binaries → verify `cargo install spatiotemporal-tiles
   --features cli --locked` in a clean env, docs.rs green, installer script.

## Known risks / fallbacks

- cargo-dist is community-maintained post-axo: version pinned (0.32.0),
  generated `release.yml` treated as vendored; fallback is
  `taiki-e/upload-rust-binary-action`.
- docs.rs timeout on stt-build's bundled-duckdb doc build: drop `duckdb` from
  its `[package.metadata.docs.rs]` features in a patch release.
- Windows dist job (fat archives + DuckDB) is the wall-clock long pole;
  `[profile.dist]` already uses thin-LTO as the relief valve.
