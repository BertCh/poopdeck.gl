# Governance

STT and poopdeck.gl are maintainer-led, pre-1.0 open-source projects. This file
describes how project decisions are made today; it does not imply a foundation,
steering committee, or guaranteed support organization.

## Roles

- **Users** run the tools and provide feedback.
- **Contributors** submit issues, documentation, tests, code, datasets, or
  design proposals.
- **Maintainers** triage issues, review changes, manage releases and project
  infrastructure, and make final decisions about project scope.

Roles are earned through sustained, constructive participation. The existing
maintainer may invite contributors to take ownership of a defined area. Access
can be narrowed or removed when someone is inactive, requests removal, or no
longer follows the project's security and conduct expectations.

## Decision process

Most decisions happen through issues and pull requests:

1. Describe the user problem, constraints, and alternatives.
2. Gather relevant technical evidence and feedback.
3. Prefer the smallest change that preserves documented compatibility and the
   project's [ground rules](AGENTS.md#ground-rules-read-before-recommending-anything).
4. A maintainer records the decision by merging, closing with an explanation,
   or requesting revision.

Consensus is preferred but not required. The maintainer has final authority and
is responsible for keeping decisions coherent with the project's scope,
maintenance capacity, and safety obligations.

Substantial proposals should begin as a feature request before implementation.
This includes changes to the archive format, public APIs, compatibility policy,
default data-preservation behavior, or long-term maintenance burden. A proposal
should cover motivation, compatibility, alternatives, migration, tests, and
documentation.

## Compatibility and releases

The archive and manifest are the interoperability contract. Packs are immutable
and content-addressed; changes must not silently rewrite them in place. Default
and automatic builds preserve every usable feature unless a user explicitly
opts into a documented reduction.

The project is pre-1.0. Breaking changes are possible, but should be deliberate,
documented in release notes, tested across affected Rust and TypeScript
surfaces, and accompanied by migration guidance when practical. Published
artifacts and the repository should agree on version and maturity status before
a release is announced.

## Contributions and review

All contributions are reviewed on their technical merit, fit with project
scope, long-term maintenance cost, documentation, and tests. Opening an issue
or pull request does not guarantee acceptance or a delivery date. Maintainers
may decline work that is correct but too broad or costly to support.

Contributors retain copyright to their work and submit it under the repository's
[MIT license](LICENSE). Participation is governed by the [Code of
Conduct](CODE_OF_CONDUCT.md).

## Security and conflicts

Security reports follow [SECURITY.md](SECURITY.md) and may be handled privately
until coordinated disclosure. Conduct concerns follow
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). A maintainer with a material personal
or financial conflict should disclose it and seek independent review when a
suitable reviewer is available.

## Changing governance

Governance changes use the same public pull-request process. The document should
be updated when the maintainer model materially changes rather than describing
an organization that does not yet exist.
