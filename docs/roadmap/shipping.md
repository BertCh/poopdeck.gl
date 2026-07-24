# Shipping & distribution — decision record

_How this project is published, why the scheme looks the way it does, what was
counted out, and the one release defect that is still open. Behavior of the CLIs
themselves lives in [../api/cli-reference.md](../api/cli-reference.md)._

**Where it stands (verified against the registries 2026-07-24).** The npm side
is current: **eight** `@poopdeck.gl` packages, **all eight published at 0.5.0**
(`core`, `playback`, `layers`, `maplibre`, `three`, `cesium`, `react`, `mcp` —
`mcp` shipped at 0.5.0, so any note calling it "the unpublished one" is stale).
The Rust side is **behind**: crates.io `spatiotemporal-tiles` max_version is
**0.4.0**, published 2026-07-06. See "Open release defect" below.

## Distribution pathways (decided)

| channel               | artifact                                                                                                                                                     | mechanism                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| npm `@poopdeck.gl`    | 8 packages: core, playback, layers, maplibre, three, cesium, react, mcp                                                                                      | changesets (fixed/lockstep group) + `release-npm.yml`; `pnpm -r publish` rewrites `workspace:*` |
| crates.io             | **one public name**: `spatiotemporal-tiles` (facade lib + all 5 CLI bins, feature-gated) over 3 internal lib crates: `stt-core`, `stt-build`, `stt-optimize` | release-plz (lockstep `version_group`, tag `v{ver}`) + Trusted Publishing                       |
| GitHub Releases       | prebuilt `stt-*` binaries, 5 targets + shell/powershell installers                                                                                           | cargo-dist 0.32.0 on tag push (`release.yml`, generated/vendored)                               |
| Cloudflare (existing) | showcase site + R2 tile data                                                                                                                                 | unchanged (`wrangler`, `scripts/r2-sync.sh`)                                                    |

## Naming rationale

- crates.io has a flat namespace; the bare `stt` name is squatted by an
  abandoned whisper lib, and "stt" reads as speech-to-text anyway. RFC 3243
  (`spatiotemporal-tiles::core`-style namespaces) is a 2026 Rust project goal
  but **not yet publishable** — owning the `spatiotemporal-tiles` base name
  reserves that namespace for when it lands.
- The facade is the bevy/gix model: users type ONE name
  (`cargo add spatiotemporal-tiles`, `cargo install spatiotemporal-tiles`);
  `stt-core/build/optimize` publish only because cargo requires published deps,
  and carry "internal implementation crate" banners.
- `crates/stt-validate` and `crates/stt-serve` were dissolved into the facade
  as feature-gated bin targets (binary names unchanged: `stt-build`,
  `stt-optimize`, `stt-validate`, `stt-serve`; `stt-bundle` joined later).
  `stt-generate` stays `publish = false` (RC nexrad deps; internal demo
  tooling).

## Feature/install matrix (facade)

- **Defaults ship the CLIs, not a slim lib.** `default = ["build-cli",
"optimize-cli", "validate-cli", "bundle-cli", "serve-postgres"]` — a bare
  `cargo install spatiotemporal-tiles` gets all five binaries with the light
  pure-Rust dep set (PostGIS serve backend only; bundled DuckDB is a heavy C++
  build). Library consumers are told to depend with `default-features = false`;
  docs.rs is configured that way too (`no-default-features`, features
  `build, optimize, postgres, duckdb`).
- `build` / `optimize` → library re-exports; `postgres` / `duckdb` forward to
  stt-build's input sources; `projection` (system libproj) is never in
  defaults, docs.rs, or dist builds.
- `cli` → all five bins, both stt-serve backends; it is what
  `[package.metadata.dist]` builds. Lighter serve:
  `--features build-cli,optimize-cli,validate-cli,serve-postgres` skips the
  ~10-min bundled-DuckDB compile. `serve-core` alone is a deliberate
  `compile_error!` (needs ≥1 backend). `serve-postgres-tls` adds
  `sslmode=require` and is never a default — it would pull native-tls into the
  light dep set and disturb the local-dev NoTls path.
- stt-build's `geoparquet` feature is a **no-op back-compat alias** — the
  encode path needs arrow/parquet unconditionally (the optional-feature split
  never compiled and was untested before this work).

## Version/tag scheme

- Everything is meant to be lockstep (npm `fixed` group;
  `[workspace.package] version`), tree currently **0.5.0**.
- Rust tag: `v{version}` (release-plz creates on the facade; cargo-dist
  consumes). npm tags: changesets-style `@poopdeck.gl/pkg@x.y.z`. No overlap.
- MSRV: `rust-version = 1.88` (empirically forced by `home`/`osmpbf`/
  `delaunator`; enforced by the CI `rust-msrv` job). Bumps are deliberate,
  in minor releases.

## Open release defect — the lockstep is currently broken

Not a shipped state; the thing to fix before the next release is announced.

- **npm 0.5.0 / crates.io 0.4.0.** crates.io has 0.1.0, 0.1.1, 0.3.0, 0.4.0 —
  it never got a 0.2.0 either, so the "crate and npm versions stay in lockstep"
  rule has been aspirational, not enforced.
- **No `v0.5.0` tag exists** (origin has `v0.1.0`, `v0.1.1`, `v0.4.0` only).
  cargo-dist builds binaries **on tag push**, so no 0.5.0 binaries or installer
  scripts were ever produced — while `crates/spatiotemporal-tiles/README.md`
  tells users "prebuilt binaries and a shell installer are on the releases
  page". **Untagged release ⇒ the README's install path is a dead link.** Tag
  the release or stop advertising the binaries; do not ship 0.6.0 with the
  claim unbacked. (Same README, same pass: it says `cargo install` "installs
  the four binaries" — defaults install five.)
- **release-plz has never run.** All 183 commits in the repo are the author's —
  there is not one bot commit and not one `chore: release` PR merge. The
  automation described in `release-plz.toml` is config, never exercised.

## Three release systems, one of which should be deleted

The repo carries **three** independent release mechanisms and uses none of them
end-to-end. Evidence, all checkable in the tree:

- `.changeset/` holds `config.json` and nothing else; the last commit to touch
  a changeset `.md` was the 0.3.0 release (`94e807b`).
- `packages/*/CHANGELOG.md` stop at **0.4.0** — with two tells that they are
  now hand-maintained: `packages/maplibre/CHANGELOG.md` heads an `## Unreleased`
  section, and `packages/mcp/CHANGELOG.md` heads `## 0.5.0` with the line "Not
  yet published to npm", which the registry contradicts.
- `crates/*/CHANGELOG.md` **do not exist**, despite `release-plz.toml` setting
  `changelog_update = true`.
- 0.5.0 landed as a hand-edited bump commit (`8bdc01d`, "bump workspace and npm
  packages to 0.5.0"), not as output of any of the three.

**Recommendation: collapse to ONE system.** Keep changesets for npm (it already
owns the `fixed` group and the `@poopdeck.gl/pkg@x.y.z` tags) and cargo-dist on
a hand-pushed `v{version}` tag for Rust; **delete `release-plz.toml` and
`release-plz.yml`.** release-plz's value is the release-PR/changelog workflow,
and that workflow has produced zero PRs and zero changelogs here — it is a
third system whose only current effect is to make the crate changelogs look
missing rather than absent-by-choice. Whichever survives, the release ritual
must end with a `v{version}` tag push, or the binaries silently stop existing.

## Operational constraint: publishing crates from this network

`cargo publish` **stalls on upload from the author's network** — the h2
`PUT`-with-body hangs; plain HTTP/1.1 to crates.io is fine, and setting
`multiplexing = false` does **not** help. It is not cargo, not the sandbox, and
not crates.io being down. **Publish the crate from a different network** (or
from CI, once CI can run). Budget for this when planning a release; it has
eaten a release window before.

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

> These gates exist **as config only and are UNVERIFIED** — GitHub Actions has
> never run for this repo (zero bot commits), so the release automation is
> unproven end-to-end and every publish so far has been manual.

- `smoke-pack` (a step in the `typescript` CI job, and the `release-npm`
  pre-publish gate — `scripts/smoke-pack.mjs`): packs every package tarball,
  scratch-installs with real peers, imports EVERY exports key under plain Node,
  plus a deck-free core+playback+react install (HoverPreview regression).
- `rust-package`: `cargo package --workspace --exclude stt-generate --locked`
  on every PR.
- `rust-feature-lanes`: facade `serve-postgres` / `serve-duckdb` / `cli` solo
  compiles + stt-build `--no-default-features`.
- `rust-all-features`: tests (not just builds) the full feature surface.
- `rust-msrv`: `cargo check --workspace` on 1.88.

## Explicit non-goals (counted out, with revival triggers)

- **DB extensions** (pgrx Postgres extension, DuckDB community extension):
  the DB story is input adaptors + the `stt-serve` binary (the `ST_AsMVT`
  analog, per `db-input-adaptors.md`). Nothing runs _inside_ a database.
- **Python packaging**: `scripts/data-generation/*` stay internal scripts
  (dataset-specific licenses, per-dataset venvs).
- **Docker image / Homebrew tap**: cargo-dist's installers + `cargo install`
  cover it. Revive with a ghcr.io image for `stt-serve` if someone actually
  asks to run the server as a service.
- Node 18 (EOL; engines `>=20`), apache-arrow stays a hard dep of core.

**Closed, do not re-litigate: MapLibre v5.** This was counted out on the
grounds that v5 replaced the positional-matrix custom-layer `render(gl, matrix)`
signature. The port landed — the peer range is now `^3 || ^4 || ^5 || ^6` and
host-version dispatch normalizes both signatures (`packages/maplibre/src/lib/
host-adapter.ts`, per `base-layer.ts`).

## Known risks / fallbacks

- cargo-dist is community-maintained post-axo: version pinned (0.32.0),
  generated `release.yml` treated as vendored; fallback is
  `taiki-e/upload-rust-binary-action`.
- docs.rs timeout on the bundled-duckdb doc build: drop `duckdb` from the
  affected `[package.metadata.docs.rs]` features in a patch release.
- Windows dist job (fat archives + DuckDB) is the wall-clock long pole;
  `[profile.dist]` already uses thin-LTO as the relief valve.
