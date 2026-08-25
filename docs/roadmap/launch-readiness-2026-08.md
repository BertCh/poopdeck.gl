# Launch readiness — August 2026

This is the short, active launch checklist for STT and poopdeck.gl. It tracks
only work that changes whether the project can be launched confidently. Design
history, experiments, and measured investigations stay in the subject-specific
decision records in this directory.

## Current release contract

These facts are authoritative for the launch candidate. If one changes, update
the named source first and let `project-status.json` validation catch copies
that drift.

| Contract               | Current state                                                          | Source of truth                                         |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| Rust workspace release | `0.6.0`; MSRV `1.87`                                                   | root `Cargo.toml`                                       |
| JavaScript release     | seven public packages at `0.6.0`                                       | `packages/*/package.json`                               |
| Cesium backend         | frozen npm release `0.5.0`; workspace package is private/experimental  | `packages/cesium/package.json` and README               |
| Packed archive writer  | `formatVersion: 3`, directory codec v6                                 | `stt-core` pack/directory constants and `docs/spec/`    |
| Compatibility window   | readers also open packed v2 / directory v5 read-only                   | packed-format spec and conformance fixtures             |
| Installed CLIs         | `stt-build`, `stt-optimize`, `stt-validate`, `stt-bundle`, `stt-serve` | `crates/spatiotemporal-tiles/src/bin/`                  |
| Dataset generator      | repo-only workspace at `tools/stt-generate`                            | `tools/stt-generate/Cargo.toml`                         |
| JavaScript runtime     | Node 24+ and pnpm 11.23.0                                              | `.node-version`, package engines, root `packageManager` |

`STT` is the neutral format and toolchain name. `poopdeck.gl` is the rendering
package family and public showcase. Launch material should keep that distinction
visible instead of presenting them as unrelated products or interchangeable
names.

## Launch gates

### Source and release

- [ ] The configured GitHub repository is public and every package/crate source,
      issue, homepage, and release link resolves.
- [ ] Required GitHub Actions complete on the public repository from a clean
      checkout, with protected-branch checks enabled.
- [ ] One release candidate installs from crates.io, npm, and release binaries
      using only the documented prerequisites.
- [x] Release notes describe the Rust and JavaScript artifacts, format
      compatibility, maturity tiers, and known limitations together.

### Documentation and product contract

- [x] Correct the first set of stale format, CLI, generator, package-status, and
      version references found by the launch audit.
- [x] Generate or validate repeated project facts from one machine-readable
      contract: versions, runtime requirements, format/codec versions, CLI inventory,
      and package maturity.
- [x] Mark public surfaces as stable, preview, or experimental. The primary
      launch path is the format/spec, build/validate/optimize CLIs, TypeScript core,
      deck.gl layers, playback/React, and the minimal example.
- [x] Reduce the root README to an adoption path: problem, intended user,
      choose/do-not-choose guidance, five-minute quickstart, and links to depth.
- [ ] Archive stale campaign notes rather than restating current behavior in
      historical decision records.

### Website

- [x] Give major routes unique titles, descriptions, canonical URLs, and social
      previews; add `robots.txt`, a sitemap, and software/project structured data.
- [x] Add a first-viewport installation or “build your first archive” action.
- [x] Return a real 404 for unknown routes while preserving the explicit
      client-only application routes.
- [x] Eliminate runtime console warnings and pass bundle budgets on the exact
      launch build. Budgets pass as of 2026-08-25 (see the note below on the
      reviewed `DemoViewer` re-base).
- [ ] Run automated accessibility checks plus representative Chromium, Firefox,
      and WebKit smoke tests.
- [ ] Define deployment security headers in source and verify the headers served
      at the edge. Source policy and worker tests are complete; live edge
      verification remains.

Local production verification on 2026-08-24 prerendered the public route set,
generated an 87-URL sitemap, emitted the documentation/status artifacts, and
then failed the final bundle gate: `DemoViewer` was 9.0 KiB gzip against its
7 KiB budget.

**Resolved 2026-08-25 by re-basing the budget to 9.5 KiB, reviewed.** The
deployed component measured 5.1 KiB gzip (14,004 B raw) and the local build
9.0 KiB (26,697 B) — the growth is the interleaved MapboxOverlay terrain path,
the mobile chrome, and the pitch/camera limits, all of which are intended and
shipped. The 7 KiB number was calibrated against the 5.1 KiB component and
predates all three, so it was stale rather than breached. Every other budget
passes with headroom. The reduction still available is splitting the terrain
path behind a dynamic import — most demos never load it, and it is the largest
single addition; that is a follow-up, not a launch blocker.

### Reliability and operations

- [ ] Pass the complete Rust and TypeScript suites on hosted CI. A local audit
      is not release evidence.
- [ ] Verify deterministic archive output, format conformance fixtures, npm
      tarballs, CLI feature lanes, and the showcase demo probe in the release run.
- [ ] Record source, licence, acquisition date, generator command/commit,
      checksums, and rebuild status for every showcased dataset.
- [ ] Add dependency review, JavaScript and Rust vulnerability scanning, release
      provenance/checksums, and minimal workflow permissions.
- [ ] Document manifest-first deployment ordering, canary verification, and
      rollback for the archive fleet and website.

## Implementation order

1. **Launch blockers:** public source, hosted green CI, coherent release state,
   and a clean install from published artifacts.
2. **Trust surface:** correct docs, explicit maturity/support, SEO and 404
   behavior, accessibility, security headers, and dataset provenance.
3. **After launch:** split oversized modules behind characterization tests,
   narrow public exports, consolidate releases, and formalize format evolution.

Do not broaden scope before launch. In particular, do not add renderers or demo
modes, change the packed format without a correctness requirement, or weaken the
no-default-thinning guarantee to meet a size target.
