# Support

STT and poopdeck.gl are maintainer-led, pre-1.0 open-source projects. Support is
best effort: response times are not guaranteed, and only the latest published
version of each artifact receives fixes.

## Start here

1. Read the [concepts](docs/intro/concepts.md) and [choosing
   guide](docs/intro/choosing.md).
2. For build and CLI questions, use the [CLI
   reference](docs/api/cli-reference.md) and [tile-tuning
   guide](docs/guides/tuning-tiles.md).
3. For archive problems, run `stt-validate` and `stt-optimize doctor` before
   reporting an issue.
4. Search existing issues before opening a new one.

The in-repository [`llms.txt`](llms.txt) and the published
<https://poopdeck.gl/llms.txt> index the documentation for search and AI tools.

## Where to ask

- **Reproducible defect:** open a bug report with the smallest reproduction,
  exact package or CLI versions, operating system, and relevant browser/GPU.
- **Feature or design proposal:** open a feature request and describe the user
  problem before proposing an API.
- **Usage question:** open an issue only after checking the documentation and
  existing issues. Label the title as a question and include enough context for
  another person to reproduce the setup.
- **Security vulnerability:** use the private process in
  [SECURITY.md](SECURITY.md). Do not file a public issue.
- **Sensitive conduct concern:** use the private process in
  [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

Please do not send ordinary support questions to the security or conduct email
addresses. Public questions produce searchable answers for everyone.

## What maintainers can provide

Maintainers may clarify documented behavior, triage reproducible defects, and
review focused contributions. They cannot guarantee individual debugging,
architecture consulting, data conversion, deployment work, or a delivery date
for feature requests.

When a problem depends on private data, create a minimal synthetic reproduction
that can be shared publicly. Never post credentials, private URLs, access
tokens, or confidential datasets.

## Version policy

Only the current release line is supported. Because the project is pre-1.0,
minor releases may include breaking changes; those changes should be called out
in release notes and migration guidance. Older 0.x releases do not receive
backports unless a maintainer explicitly announces otherwise.
