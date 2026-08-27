# Security

## Reporting a vulnerability

Report privately — do **not** open a public issue.

For usage questions, ordinary defects, and feature requests, follow
[SUPPORT.md](SUPPORT.md) instead. The security channel is only for suspected
vulnerabilities.

- Preferred: GitHub's private vulnerability reporting on this repository
  (**Security → Report a vulnerability**).
- Fallback, if that is unavailable: email <rgcgeog@gmail.com> with `[security]`
  in the subject.

This is a solo project. Expect an acknowledgement within about a week and a fix
on a best-effort schedule; there is no SLA. If a report needs coordinated
disclosure, say so and a date will be agreed before anything is published.

## Supported versions

Only the **latest published** version of each artifact gets fixes:

| Artifact         | Registry |
| ---------------- | -------- |
| `@poopdeck.gl/*` | npm      |

The project is pre-1.0, so "supported" means the current version — patches are
not backported to older 0.x lines. The archive format, the Rust crates and the
`stt-*` CLIs are a separate project with its own policy; report those to
[BertCh/spatiotemporal-tiles](https://github.com/BertCh/spatiotemporal-tiles/security).

## What is in scope

The interesting surface is **untrusted archive bytes**. A `.stt` archive is
fetched over HTTP and decoded by code that runs in a user's browser or on their
machine, so the decoders treat every byte as hostile input:

- `@poopdeck.gl/core` — manifest parsing, pack and directory decoding, zstd
  frames, quantized geometry. Panics or hangs a remote archive can trigger, and
  unbounded allocation from attacker-chosen lengths. (The Rust reader,
  `stt-core`, is the same surface in another language and is reported upstream.)
- The renderer packages — `layers`, `three`, `maplibre`, `cesium`, `react` — to
  the extent that archive-controlled values reach shader codegen or the DOM.

## What is not in scope

- **The map tokens committed under `examples/showcase/`.** Mapbox and Google
  Maps client keys are public by nature — they ship inside the built site
  regardless. They are URL-restricted; a report that they are "leaked" is not a
  vulnerability. Tell us instead if one is missing its URL restriction.
- The showcase's demo datasets and the tile bucket that serves them: public
  read-only data, published deliberately.
- Slowness or memory pressure from rendering a deliberately enormous archive.
  Streaming a 100 GB dataset is a supported use, not an attack; a decoder that
  can be made to allocate unboundedly by a _small_ archive is in scope, above.
- Findings from automated scanners with no demonstrated impact on the above.
