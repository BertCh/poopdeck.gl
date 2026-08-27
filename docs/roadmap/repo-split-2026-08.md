# The great divide — splitting STT and poopdeck.gl into two repositories

> **Status:** landed 2026-08-26 as `71a1ef3` here and `18a4f7c`/`68466a2` in
> poopdeck.gl, from `0e34c76` (the 0.7.0 release commit). §§1–7 are the contract
> as planned; §8 is as built. This record is the split's **contract**: what each
> repository owns, what crosses the seam and how, and what was deliberately left
> duplicated. §§1–7 were written before the move so both repositories inherit it
> through history.

## 1. Why

The monorepo has been carrying two projects that share a name and nothing else
structurally. `README.md` has said so in prose since the 0.6 line:

> **STT** is the open format and Rust toolchain. **poopdeck.gl** is the
> TypeScript rendering ecosystem and live showcase.

Everything downstream of that sentence disagreed with it. One `pnpm install`
pulled a 39-package browser graph onto a machine that only wanted
`cargo install spatiotemporal-tiles`. One CI run spent Rust-job minutes on a
Tailwind change. One `0.7.0` tag meant two unrelated things in two registries.
One backlog interleaved encoder byte-breaks with shader colour management. The
release-npm workflow and the cargo-dist workflow both fired on `main`.

The split makes the stated boundary structural.

### 1.1 What the boundary actually is

The seam is the **archive on disk**: `manifest.json`, the content-addressed
packs, the directory pages, and the Arrow/GeoArrow tile payload. Everything
upstream of those bytes is STT. Everything downstream is poopdeck.gl. The
format spec (`docs/spec/`) is the written form of the seam, and STT owns it
because STT's writer is the reference implementation that defines it.

This is why `@poopdeck.gl/core` — which contains a _reader_ for the format —
goes to poopdeck whole, and is not split in half. A reader is a consumer of
the contract, not a co-author of it. Splitting the package would put a
published-npm-package hop between `packages/core/src/archive.ts` and
`packages/core/src/tile-decoder.ts`, two files that change together, to buy a
layering purity nothing else in the tree needs. What the reader owes upstream
is **conformance**, and conformance is testable with artifacts (§4.2) rather
than enforced with a dependency edge.

## 2. The division

### 2.1 `spatiotemporal-tiles` (this repository) — the format and the tiler

| Keeps                           | What it is                                                             |
| ------------------------------- | ---------------------------------------------------------------------- |
| `crates/stt-core`               | Format reader/writer, packs, directory codec, Arrow tile encode        |
| `crates/stt-build`              | The tiler; GeoParquet / PostGIS / DuckDB inputs                        |
| `crates/stt-optimize`           | `inspect` / `doctor` / `diff` / `export` / `order-audit` / `recommend` |
| `crates/spatiotemporal-tiles`   | The published facade + five CLIs, incl. `stt-serve`                    |
| `crates/stt-wasm`               | The Rust reader compiled to WASM (`publish = false`)                   |
| `tools/stt-generate`            | Reference-dataset generator (own cargo workspace)                      |
| `conformance/`                  | **New.** The vectors and generator behind `docs/spec/conformance.md`   |
| `docs/spec/`, format docs       | The normative contract (§3.1 for the exact list)                       |
| `scripts/data-generation/`      | The dataset production pipeline (Python/bash → `stt-build`)            |
| `scripts/{postgis,duckdb}/`     | DB-source benchmarks and fixtures                                      |
| `scripts/r2-sync.sh` + friends  | Publishing built archives to object storage                            |
| `.github/workflows/release.yml` | cargo-dist                                                             |

### 2.2 `poopdeck` (new repository) — the renderer

| Gets                                        | What it is                                           |
| ------------------------------------------- | ---------------------------------------------------- |
| `packages/core`                             | TS reader + tileset runtime + render kernel          |
| `packages/{layers,three,maplibre,cesium}`   | The four renderer backends                           |
| `packages/{playback,react}`                 | Clock, governor, React bindings                      |
| `packages/mcp`                              | The MCP server (drives the `stt-*` CLIs off `PATH`)  |
| `examples/{showcase,minimal}`               | poopdeck.gl and the published-packages smoke example |
| `tools/{bench,perf,render-test}`            | Frame cost, policy replay, pixel baselines           |
| `poopdeck-ai/`                              | The Claude Code plugin: skills + `.mcp.json`         |
| `docs/api/`, renderer docs                  | §3.2 for the exact list                              |
| `.changeset/`, `patches/`, `wrangler.jsonc` | npm release + the load-bearing luma patch            |
| `.github/workflows/release-npm.yml`         | changesets                                           |

`data/` is untracked and stays here: it is generator input, and it is large.

### 2.3 Versioning after the split

The lockstep ends. Rust releases on its own cadence from this repository;
`@poopdeck.gl/*` releases on its own from poopdeck. They are related by the
**format version**, not by a shared version number — an archive declares
`formatVersion` and `directoryVersion`, and `project-status.json` on each side
declares what that side writes and reads. `scripts/sync-versions.mjs` split
accordingly: each copy now polices only its own registry.

The first post-split releases should be `0.8.0` on both sides, cut
independently, so the shared-`0.7.0` coincidence does not read as a promise.

## 3. Documentation

Ownership follows the seam. The published site (poopdeck.gl) still renders the
complete corpus, so poopdeck **vendors** the STT-owned pages at their existing
paths — no slug changes, no dead links, no site holes — and a CI gate fails on
drift (§4.1).

### 3.1 STT owns

```
docs/spec/stt-packed-format.md        docs/architecture/data-format.md
docs/spec/time-model.md               docs/architecture/archive-format-performance.md
docs/spec/conformance.md              docs/architecture/system-overview.md
docs/spec/manifest.schema.json        docs/api/cli-reference.md
docs/spec/tile-matrix-set.json        docs/guides/tuning-tiles.md
docs/spec/stt-serve-protocol.md       docs/guides/data-generation.md
docs/spec/sidecar-assets.md           docs/guides/python.md
docs/spec/scene.schema.json           docs/guides/export.md
docs/spec/av-palettes.json  (new)     docs/guides/csv-quickstart.md
                                      docs/guides/deploying.md
                                      docs/guides/wasm.md
                                      docs/intro/{concepts,glossary,choosing}.md
```

`system-overview.md` is STT-owned because it describes the two-stack
architecture _from the archive outward_; poopdeck vendors it rather than
forking it, so there is one drawing of the system rather than two that drift.

### 3.2 poopdeck owns

All 44 remaining `docs/api/*.md` (every layer, extension, and the four backend
descriptors), `docs/spec/backend-capabilities.md` (machine-generated from the
TS `BackendDescriptor`s, so it cannot live upstream of them),
`docs/spec/render-spec.json`, `docs/architecture/deckgl-integration.md`,
`docs/guides/ai-suite.md`, `docs/intro/quickstart.md`, and
`docs/intro/status-and-support.md`.

### 3.3 The roadmap splits by subject, and so does the backlog

`docs/roadmap/README.md` is the single register of open work (house rule).
After the split there are two registers, each complete for its own repository,
cross-linked at the top. Records go where their subject went:

- **STT:** `stt-packed-format-decisions.md`, the four `optimization-*.md`,
  `db-input-adaptors.md`, `formal-semantics-2026-08.md`, `demos-and-datasets.md`
  (the licence register and build recipes), `av-cockpit.md`,
  `storm-4d-greenfield-2026-07.md`, `neural-atlas-2026-07.md`, `shipping.md`
  (cargo half).
- **poopdeck:** `renderer-architecture.md`, `playback-and-loading.md`, both
  `measurements-*.md`, `tile-loading-3d-2026-07.md`, both
  `tile-loading-audit-2026-08*.md`, `ai-suite.md`, `launch-readiness-2026-08.md`,
  `openusd-integration-2026-07.md`, `shipping.md` (npm half).

The three demo contracts in the STT list are there because the code that cites
them as normative is the Python dataset-generation pipeline, which stays with the
tiler; §8.1 records the correction.

`shipping.md` is the one record that is genuinely two documents wearing one
name; it is split rather than duplicated.

## 4. The seam machinery

Three artifacts cross the boundary. Each is **generated in STT, vendored in
poopdeck, and gated on both sides**. The vendoring pin lives in
`poopdeck/.stt-sync.json`: the upstream repo, the pinned commit, and the file
list. `scripts/sync-stt.mjs` rewrites the vendored copies from a local checkout
(`STT_REPO=../spatiotemporal-tiles`) or from the pinned ref; `--check` compares
and exits non-zero on drift, and that is the CI gate.

### 4.1 Documentation

The files of §3.1, copied to their existing paths under `poopdeck/docs/`.
A synced file carries no marker in its body (it would corrupt the byte
comparison); `.stt-sync.json` is the list, and `CONTRIBUTING.md` on both sides
says which side to edit.

### 4.2 Conformance vectors

Today the format has two golden-fixture trees and one gate spanning them:

- `crates/stt-core/tests/fixtures/v2-golden/` — the **writer** oracle.
- `packages/core/test/fixtures/{legacy-shape,packed-golden,paged-golden,
paged-golden-single,v2-golden,v2-golden-tracks}` — the **reader** oracle,
  ~110 objects, produced by `packages/core/scripts/make-v2-golden.sh` driving
  the _Rust writer_.

The reader oracle is therefore an STT artifact that happened to live in the
reader's test directory. After the split it becomes one:

```
conformance/
  vectors/          the six dataset trees + expected-hashes.json
  make-vectors.sh   (was packages/core/scripts/make-v2-golden.sh)
  README.md         how a third-party reader consumes them
```

poopdeck keeps `packages/core/test/fixtures/` at its current path — no test
touches change — as a vendored copy of `conformance/vectors/`. Both repositories
keep a copy of the golden-pin gate, each scoped to its own tree, so the
`Rebuild-Window:` trailer rule survives on both sides.

A published `@spatiotemporal-tiles/conformance-vectors` npm package would
remove the duplication; it is not worth the publishing burden until a
third-party reader exists.

### 4.3 The AV palette dual copy

`scripts/data-generation/test_av_palette_parity.py` currently asserts that
`av_common.py`'s palettes and `examples/showcase/src/datasets.ts`'s palettes
are identical — a test that reads across the new boundary. It is replaced by a
generated artifact:

- STT emits `docs/spec/av-palettes.json` from `av_common.py`, gated in STT CI.
- poopdeck vendors that JSON and asserts `datasets.ts` matches it, in TS.

Same invariant, no Python in the renderer repository, and the contract becomes
a file a third party can read instead of a test only we can run.

### 4.4 `project-status.json` splits

Each side keeps the half it can verify: STT holds `release.rust`,
`toolchain.rust`, `archive.{writes,reads}`, `commands`,
`repositoryOnlyCommands`; poopdeck holds `release.javascript`, the Node/pnpm
toolchain, `packages`, and its own `otherSurfaces`. poopdeck's file carries a
synced `stt` block so the showcase's status page can still render both without
a network call. Each `check-project-status.mjs` validates only its own half.

## 5. What is deliberately duplicated

`LICENSE`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `SUPPORT.md`, `GOVERNANCE.md`,
`.oxlintrc.json` / `.oxfmtrc.json` (poopdeck's is the live one; STT keeps a
reduced copy for its `.mjs` scripts), `scripts/check-doc-links.mjs`, and the
golden-pin gate. Duplication is cheaper than a shared-tooling package for
files that change once a year.

`AGENTS.md`, `CONTRIBUTING.md`, `README.md`, `CHANGELOG.md` and `llms.txt` are
**not** duplicated — each is rewritten for its repository's scope.

## 6. History

poopdeck is created with `git filter-repo` over a clone of this repository,
keeping every commit that touched a poopdeck path. Blame and bisect survive on
the 881 package files and 239 example files, which is where the density of
hard-won fixes lives (the luma UBO patch, the seam-wall mask, the governor
inert-source fix). This repository keeps its full history and simply deletes
the moved paths in one commit, so `git log --follow` still reaches them.

The pre-split commit is tagged `pre-split-0.7.0` on both sides.

## 7. Known costs, accepted

- **Two-repo changes.** A format change that needs a reader change is now two
  PRs. Mitigated by §4.2: the vectors land in STT first, and poopdeck's sync
  gate goes red until it catches up — which is the correct order anyway.
- **The vendored corpus.** poopdeck's `docs/` contains files it must not edit
  (§8.1 has the as-built count). The gate makes an accidental edit fail loudly
  rather than silently win.
- **`stt-wasm` and the showcase.** The WASM decoder is built in STT and
  consumed (optionally, behind a flag) by the showcase. It is published as a
  release artifact rather than vendored; the showcase's Vite config already
  treats it as optional.
- **The MCP straddles.** `@poopdeck.gl/mcp` ships from poopdeck and spawns
  `stt-*` binaries from `PATH`. This was already true — `cli-runner.ts` has
  always resolved them by `PATH` with a `--stt-*-bin` override — so nothing in
  the package changes. Its docs now say the CLIs are a separate install.

## 8. As built — 2026-08-26

The split landed as `71a1ef3` here and `18a4f7c`/`68466a2` in
[poopdeck.gl](https://github.com/BertCh/poopdeck.gl). Both trees are green.
What follows is where reality differed from §§1–7, and what the work turned up.

### 8.1 Deviations from the plan

- **The repository is `poopdeck.gl`, not `poopdeck`.** The obvious name was
  already taken locally by an unrelated project. The chosen name matches the npm
  scope and the domain, and follows the deck.gl/luma.gl precedent.
- **25 vendored artifacts, not the 23 listed in §3.1** — 20 pages and 5
  generated JSON contracts. `docs/spec/stt-generate-datasets.json` joined the set
  (§8.2), and this record itself is the 25th (last bullet below).
  `docs/spec/backend-capabilities.md` went the other way: it is generated from
  the TypeScript `BackendDescriptor`s, so it cannot live upstream of them.
  `poopdeck/.stt-sync.json` is the authoritative list.
- **Three demo contracts stayed upstream.** §3.3 as first written assigned
  `av-cockpit.md`, `storm-4d-greenfield-2026-07.md` and
  `neural-atlas-2026-07.md` to poopdeck. The code that cites their numbered
  sections as normative is the Python dataset-generation pipeline, which stayed
  with the tiler — 41 and 13 citations for the first two remain in the STT tree —
  so the records stayed with it. §3.3 now lists them under STT, and
  `.stt-sync.json`'s `upstreamOnly` names all three.
- **`shipping.md` was duplicated, not split.** §3.3 called it two documents
  wearing one name. Both copies landed carrying both halves — the npm release
  machinery and the cargo one. The upstream copy has since been pruned to the
  cargo half it owns; pruning the downstream copy to the npm half is
  poopdeck.gl's to do.
- **The ledgers are duplicated, not split.** §3.3 said the roadmap divides by
  subject. The open backlog does. The _discharged_ and _consolidation_ ledgers
  are kept verbatim in both repositories instead: the work they record was done
  in one tree, and bisecting a frozen history along a boundary that did not
  exist at the time would misdescribe it.
- **The 76 GB archive fleet moved too.** It lived at
  `examples/showcase/public/data` — a path inside a repository that is no longer
  here. It is now `data-fleet/`, and `r2-sync.sh`, `rebuild-fleet-v3.sh`,
  `patch-manifest-metadata.mjs`, `tools/fleet-order-audit.sh` and every
  data-generation script follow it. Untracked, as before.
- **This record is itself vendored.** Both repositories cite it as the contract,
  so it has one authored copy rather than two that drift.

### 8.2 One more artifact than planned

§4 named three things crossing the seam. There are four: the MCP server's
`generate_dataset` tool advertises a dataset enum that a TypeScript test kept
equal to `stt-generate`'s clap `enum Commands`, by parsing `main.rs`. That test
could not survive the split either, so the parser moved **here** — a scanner for
Rust belongs beside the Rust it scans — and emits
`docs/spec/stt-generate-datasets.json`, gated by
`scripts/gen-generate-datasets.mjs --check`. The guard that a
`#[command(rename_all = …)]` has not silently invalidated the kebab-case
derivation moved with it, and now throws rather than emitting a confidently
wrong list.

Both cross-language tests therefore ended the same way, and it is the pattern to
reach for again: **replace a test that reads two trees with an artifact one tree
publishes and the other asserts against.** The invariant survives intact, and it
becomes a file a third party can read instead of a check only we can run.

### 8.2b `choosing.md` split in two — 2026-08-26

§3.1 assigned `docs/intro/choosing.md` here on the strength of its first two
sections. Its other three — which renderer, which layer, which playback API —
were renderer material, and 26 of the page's 30 relative links resolved only
downstream. §4.1's vendored-page-may-link-downstream rule made that legal, not
correct: the page's owner and its subject had come apart.

The page is now two. `docs/intro/choosing.md` keeps "Should I use STT?" and
"Static archive or live service?" and stays vendored; the renderer half became
`poopdeck:docs/intro/choosing-a-renderer.md`, owned downstream and declared in
`docs/.corpus.json` as `downstreamOnly`. The published corpus is unchanged —
both pages are served from the same site — but each half now sits with the code
it describes.

The general rule, worth applying to the next page that drifts: **ownership
follows subject, and a page whose links mostly leave its own repository is the
symptom.**

### 8.3 What the gates caught

Worth recording, because it is the argument for keeping them strict:

- The golden-pin gate **rejected the split's own commit**. The relocation had
  quietly dropped `legacy-shape/README.md`, so it was not the byte-identical
  move the trailer claimed. The fix was to restore the file, not to relax the
  claim.
- That trailer is new. `Rebuild-Window: R1` means "the fleet needs
  re-uploading"; spending it on a rename would teach everyone to read it as
  noise. `Pin-Relocation: <old> -> <new>` is **verified against the object
  database** — the old root must be gone, the new root must be new, and the two
  must hold the same blobs at the same relative paths. Five tests cover a copy,
  a changed byte, and a re-blessing smuggled alongside a real move.
- A `README.md` inside a pinned tree is now explicitly **not** a pin. No archive
  object is ever named that, so the carve-out cannot hide anything; without it,
  correcting a vector's own explanation would need a rebuild declaration.
- Four Rust tests were reading the reader-side fixtures across the old boundary
  (`container_migration.rs`, `make-golden-fixture.rs`). They went red on the
  first `cargo test` after the prune, which is exactly what should happen, and
  they now read `conformance/vectors/`.
- Both doc-link gates learned that the corpus spans two repositories, in mirror
  image: a vendored page may link into the other half (42 do upstream, 7
  downstream), and a page a repository owns alone may not. The alternative —
  absolute URLs everywhere — would have made the published site link out of
  itself for pages it is already serving, and is impossible in a vendored file
  anyway, since it is byte-compared.

### 8.4 Still open

Tracked as S1–S3 in the backlog above: the vendor pin has never been exercised
without a sibling checkout, the first independent releases are uncut, and the
rehomed fleet has been repointed by rewrite rather than by running the scripts.
Neither repository exists on the remote yet (T1).

**Status — later on 2026-08-26.** All of the above closed except one check. Both
repositories are public; `.stt-sync.json` pins `f4c4a95` and the downstream sync
gate ran green with no sibling checkout; `0.8.0` was cut independently on
crates.io and on npm; and `r2-sync.sh` has been run for real, with credentials,
against the `data-fleet/` root. What remains is the read half of S3: one
`stt-optimize inspect --sample 0` over a stem under the new root, from a clean
checkout.
