# Archived model evaluations (December 2025)

Historical, **reference-only** third-party reviews of the STT format and the
deck.gl integration, each asking the same question: what stands between the
architecture as it was and 120 fps playback with remote on-demand data.

These were written against the repo as of `5e527d4` (2025-12-07), before the
`packages/deck.gl` → `packages/layers` rename, the packed-v2 format, the
render-kernel abstraction, and the maplibre/three/cesium backends. Treat every
file path, layer name, and measurement in them as describing that old tree —
several of the concerns they raise have since been fixed, and the code they
cite mostly no longer exists at those paths.

They are kept because the _reasoning_ about the format/render boundary is still
useful prior art, and because they were the only copies in existence: each one
lived as an untracked file inside a stale Cursor worktree that has since been
pruned.

| File                                             | Author            | Notes                                             |
| ------------------------------------------------ | ----------------- | ------------------------------------------------- |
| `2025-12-claude-opus-4-architecture-analysis.md` | Claude Opus 4     | Format, deck.gl layers, loaders.gl integration    |
| `2025-12-gpt-5.1-codex-max-deckgl-evaluation.md` | gpt-5.1-codex-max | `packages/core` + `packages/deck.gl` read-through |
| `2025-12-composer-architecture-analysis.md`      | Composer          | Format + deck.gl, playback vs. map interaction    |
