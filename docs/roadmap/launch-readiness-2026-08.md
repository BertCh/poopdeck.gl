# Launch readiness — August 2026

This is the short, active launch checklist for **poopdeck.gl**. It tracks only
work that changes whether the renderer can be launched confidently. Design
history, experiments, and measured investigations stay in the subject-specific
decision records in this directory. Format, tiler, optimizer and dataset launch
items live in the STT repository's
[own register](https://github.com/BertCh/spatiotemporal-tiles/blob/main/docs/roadmap/README.md);
the STT rows below are read-only facts, carried here because launch material
quotes them.

## Current release contract

These facts are authoritative for the launch candidate. If one changes, update
the named source first and let `project-status.json` validation catch copies
that drift.

| Contract               | Current state                                                                                      | Source of truth                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Rust workspace release | `0.8.0`; MSRV `1.88`                                                                               | vendored `stt` block of `project-status.json`                                                               |
| JavaScript release     | seven public packages at `0.8.0`                                                                   | `packages/*/package.json`                                                                                   |
| Cesium backend         | frozen npm release `0.5.0`; workspace package is private/experimental                              | `packages/cesium/package.json` and README                                                                   |
| Packed archive writer  | `formatVersion: 3`, directory codec v6                                                             | `stt:crates/stt-core` constants and `docs/spec/`                                                            |
| Compatibility window   | readers also open packed v2 / directory v5 read-only                                               | packed-format spec and conformance fixtures                                                                 |
| Installed CLIs         | `stt-build`, `stt-optimize`, `stt-validate`, `stt-bundle`, `stt-serve`                             | `stt:crates/spatiotemporal-tiles/src/bin/`                                                                  |
| Dataset generator      | repo-only workspace at `stt:tools/stt-generate`                                                    | `stt:tools/stt-generate/Cargo.toml`                                                                         |
| JavaScript runtime     | dev toolchain Node 24+ and pnpm 11.23.0; published packages `node >=20`, `@poopdeck.gl/mcp` `>=24` | `.node-version` and root `packageManager`; `project-status.json` `toolchain.node` / `toolchain.runtimeNode` |

Rows sourced upstream (`stt:` prefixed, plus the Rust release and MSRV) are not
re-derived here — `scripts/check-project-status.mjs` deliberately verifies only
the half this repository still decides, and the rest arrives as the vendored
`stt` block, byte-gated by `pnpm stt:check`.

`STT` is the neutral format and toolchain name. `poopdeck.gl` is the rendering
package family and public showcase. Launch material should keep that distinction
visible instead of presenting them as unrelated products or interchangeable
names.

## Launch gates

### Source and release

- [x] The configured GitHub repository is public and every package/crate source,
      issue, homepage, and release link resolves. Both `BertCh/poopdeck.gl` and
      `BertCh/spatiotemporal-tiles` are public as of 2026-08-26.
- [x] Required GitHub Actions complete on the public repository from a clean
      checkout. `CI` and `Release npm (@poopdeck.gl)` are both green on `main` at
      `027e2f6` (2026-08-26). Residual: protected-branch required checks are not
      configured yet.
- [x] One release candidate installs from crates.io and npm using only the
      documented prerequisites — 0.8.0, both registries, 2026-08-26. Residual:
      the cargo-dist prebuilt binaries for the `v0.8.0` tag have not been
      install-tested.
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
- [x] Define deployment security headers in source and verify the headers served
      at the edge. `curl -sI https://poopdeck.gl` returns every header declared in
      `examples/showcase/public/_headers` (CSP `frame-ancestors`, HSTS,
      Permissions-Policy, Referrer-Policy, X-Content-Type-Options,
      X-Frame-Options), verified 2026-08-26.

`DemoViewer`'s 7 KiB gzip budget was calibrated against a 5.1 KiB component and
predates the interleaved MapboxOverlay terrain path, the mobile chrome and the
pitch/camera limits; it was re-based to 9.5 KiB on 2026-08-25 against a measured
9.0 KiB (26,697 B raw) local build, reviewed. Splitting the terrain path behind a
dynamic import is the remaining reduction — a follow-up, not a blocker.

### Reliability and operations

- [x] Pass the complete TypeScript suite on hosted CI. Green 2026-08-26 on
      `027e2f6`: typecheck plus vitest for all eight packages, the showcase, and
      `@poopdeck.gl/bench`.
- [ ] Verify npm tarballs and the showcase demo probe in the release run.
      `smoke-pack` and `showcase-probe` both run in `ci.yml`; what remains is
      wiring them as required checks on the release path.
- [ ] Add dependency review, JavaScript vulnerability scanning, release
      provenance/checksums, and minimal workflow permissions. (Provenance is
      **T3** in the [backlog](./README.md).)
- [ ] Document canary verification and rollback for the website.

Deterministic archive output, conformance fixtures, CLI feature lanes, dataset
provenance and archive-fleet deployment ordering are STT-owned launch items and
live in its
[register](https://github.com/BertCh/spatiotemporal-tiles/blob/main/docs/roadmap/README.md).

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
