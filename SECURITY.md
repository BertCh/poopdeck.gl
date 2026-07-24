# Security

## Reporting a vulnerability

Report privately — do **not** open a public issue.

- Preferred: GitHub's private vulnerability reporting on this repository
  (**Security → Report a vulnerability**).
- Fallback, if that is unavailable: email <rgcgeog@gmail.com> with `[security]`
  in the subject.

This is a solo project. Expect an acknowledgement within about a week and a fix
on a best-effort schedule; there is no SLA. If a report needs coordinated
disclosure, say so and a date will be agreed before anything is published.

## Supported versions

Only the **latest published** version of each artifact gets fixes:

| Artifact                                                   | Registry  |
| ---------------------------------------------------------- | --------- |
| `spatiotemporal-tiles` (+ `stt-core`/`-build`/`-optimize`) | crates.io |
| `@poopdeck.gl/*`                                           | npm       |

The project is pre-1.0 and both registries move in lockstep, so "supported"
means the current version — patches are not backported to older 0.x lines.

## What is in scope

The interesting surface is **untrusted archive bytes**. A `.stt` archive is
fetched over HTTP and decoded by code that runs in a user's browser or on their
machine, so the decoders treat every byte as hostile input:

- `stt-core` (Rust) and `@poopdeck.gl/core` (TS) — manifest parsing, pack and
  directory decoding, zstd frames, quantized geometry. Memory-safety issues,
  panics that a remote archive can trigger, unbounded allocation from
  attacker-chosen lengths.
- The CLIs `stt-build` / `stt-optimize` / `stt-validate` / `stt-bundle` — same
  decoders, plus input parsing (GeoParquet, WKB) of files you did not author.
- `stt-serve` — it binds a port. Anything that lets a request read outside the
  configured archive/table, or that turns a query parameter into unintended SQL
  against the Postgres or DuckDB backend.
- The renderer packages, to the extent that archive-controlled values reach
  shader codegen or the DOM.

## What is not in scope

- **The map tokens committed under `examples/showcase/`.** Mapbox and Google
  Maps client keys are public by nature — they ship inside the built site
  regardless. They are URL-restricted; a report that they are "leaked" is not a
  vulnerability. Tell us instead if one is missing its URL restriction.
- The showcase's demo datasets and the tile bucket that serves them: public
  read-only data, published deliberately.
- Denial of service achieved by pointing the tools at a deliberately enormous
  local file. Building a 100 GB archive is a supported use, not an attack.
- Findings from automated scanners with no demonstrated impact on the above.
