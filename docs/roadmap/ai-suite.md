# AI-assisted suite (Agent Skills + MCP) — decision record

Why poopdeck.gl ships an agent surface, what shape it takes, what we declined. The
tool/flag reference lives in `packages/mcp/README.md` and `docs/api`.

## The verdict that shaped the product

1. **The two primitives are complementary, not competing.** MCP = _connectivity_
   (live introspection + actions over external systems); Skills = _procedural
   know-how_ (playbooks, opinions, and crucially **which tool to reach for**). The
   one-line test: _"If you're explaining how to do something, that's a skill. If you
   need the model to access something, that's MCP."_ Ship **both, as one plugin**, so
   one install wires the server (`.mcp.json`) and auto-loads `skills/` — no
   hand-edited config.

2. **poopdeck.gl's `stt-*` Rust CLIs are its "wrangler."** The skills carry the
   workflow and opinion and **route** between the MCP tools and
   `stt-build`/`stt-optimize`/`stt-serve`/`stt-validate`. **The load-bearing move is
   putting _which tool to reach for_ in the skill.**

3. **The wedge is time.** When this was decided (2026-07) there was no open,
   self-hostable, temporal-native deck.gl agent surface. Making time first-class in
   the agent surface (`set_time`, `play_pause`, `timeRange` in every dataset
   description) is the differentiator, not the tool count.

4. **Server-side rules adopted:** few consolidated tools, never 1:1 the CLI surface;
   return **opinionated verdicts, not raw dumps** (`dataset_report` = severity-ranked
   findings + remediation + projected win, which `stt-optimize doctor` already
   emits); feed the model **metadata, not rows**; make a **declarative spec** the
   generation target, because a spec is schema-validatable and code is not.

5. **`debugging-blank-renders` and `tuning-stt-tiles` were written first** because
   they capture hard-won, non-obvious knowledge (the summary-id defect, the
   no-thinning principle) that lives in project memory, not in the code.

## Security model

Enforced by the server/operator, never by instructing the model.

- **Read-only by default.** `build_dataset` / `validate_dataset` /
  `generate_dataset` are **absent from the manifest** unless `--allow-cli`. Any
  subprocess at all is opt-in: `dataset_report` / `recommend_build` /
  `diff_datasets` are always listed (for discoverability) but self-gate on
  `--allow-cli` and refuse without it.
- **Least privilege.** `--data-root <dir>` roots the server to one tree.
  `resolveDatasetDir` (`packages/mcp/src/manifest.ts`) checks containment **twice** —
  lexically to catch `..`, then against the canonicalized realpath to catch symlink
  escapes. Passing an explicit path to a tool escapes that sandbox, so an explicit
  path is itself gated on `--allow-cli`.
- **No shell.** `spawn(bin, args)` with **argument arrays** — no shell string
  interpolation, ever. Output capped at 200k chars, 120 s default timeout,
  abort-aware (a cancelled request never spawns; a mid-run abort SIGKILLs).
- **HTTP transport** enforces DNS-rebinding protection via Host/Origin allow-lists.
  Documented in `--help`: binding a non-localhost `--host` together with
  `--allow-cli` exposes browser-driven arbitrary file read/write and subprocess
  spawn — trusted networks only.

### The shipped-plugin defect, and why the fix had two halves (closed)

`poopdeck-ai/.mcp.json` used to pass **`--allow-cli`** and point `STT_DATA_ROOT`
at `examples/showcase/public/data`, launching `packages/mcp/dist/bin.js`
directly. **Both of those paths are gitignored** (`dist/`, `data/`), so a
marketplace installer got neither the built server nor the data — it was inert
only because the paths were broken.

Worth keeping because the trap is re-enterable: **repairing the path alone would
have been worse than the bug.** Swapping in `npx -y @poopdeck.gl/mcp` while
leaving `--allow-cli` would ship a marketplace plugin that enables arbitrary
subprocess execution by default for every installer — exactly the posture
`config.ts` defaults OFF. Both halves shipped: the plugin now launches
`npx -y @poopdeck.gl/mcp` with no flags. _(The repo-root `.mcp.json` still passes
`--allow-cli` against a local data root; that one is the maintainer's dev config,
not a distributed artifact.)_

## As built

- **13 MCP tools** in `packages/mcp/src/server.ts`: `list_datasets`,
  `describe_dataset`, `dataset_report`, `search_docs`, `get_doc`, `recommend_build`,
  `diff_datasets`, `view_map`, `set_time`, `play_pause`, and (behind `--allow-cli`)
  `build_dataset`, `validate_dataset`, `generate_dataset`.
- **Resources:** `stt://datasets/{name}` and `stt://docs/{path}` templates.
  Both list callbacks are capped at 100 entries — the SDK's `ResourceTemplate.list`
  takes no cursor, so an uncapped data-root of hundreds of datasets would emit one
  unbounded ~40k-token listing on connect; `list_datasets` (with its `search`
  filter) is the paging-capable path.
- **`describe_dataset` reads manifests directly and MUST NOT depend on
  `@poopdeck.gl/core`** (`STTArchive` drags in the browser runtime) — noted in
  `manifest.ts` so it isn't "simplified" back in.
- **Transports:** stdio + stateless Streamable HTTP; expertise-builder system prompt
  (`buildSystemPrompt`).
- **10 skills** in `poopdeck-ai/skills/`, authored to the agentskills.io open
  standard: `poopdeck-overview` (router), `installing-poopdeck`,
  `building-stt-datasets`, `generating-stt-datasets`, `tuning-stt-tiles`,
  `wiring-deckgl-layers`, `choosing-a-renderer`, `adding-playback`,
  `serving-and-publishing`, `debugging-blank-renders`.
- **Distribution:** `@poopdeck.gl/mcp` **published on npm at 0.5.0** (`bin: stt-mcp`);
  `poopdeck-ai` plugin + repo-root `.claude-plugin/marketplace.json`; `llms.txt`
  static tier.
- **Verified end-to-end** over real stdio against the real `stt-optimize` /
  `stt-validate` binaries and a fixture archive: `recommend_build` produced
  `--min-zoom 9 --max-zoom 10 --temporal-bucket 1m --style-hints` from
  `storm-tracks.parquet`. (`--min-zoom`/`--max-zoom` are the canonical `stt-build`
  flags; the design draft's `--min-zoom-level` never existed.)

## Counted out, with revival triggers

- **`compose_layer` (NL → Zod-validated layer spec) not built.** `view_map`'s
  `@@type` inference plus the `wiring-deckgl-layers` skill cover the "which layer +
  which props" job. _Revive if_ agents start emitting layer props that fail
  validation often enough to need a render→check→fix loop.
- **`view_map` does not render a live map.** It returns the `@deck.gl/json` spec as
  text plus a best-effort `ui://` HTML resource that says so on its face: live
  rendering needs an MCP-Apps host to register the STT layer classes with
  `@deck.gl/json` **and** an http(s) `--public-base-url` so each manifest URL is
  browser-loadable — "rendering the spec below without those two pieces would only
  draw an empty canvas." Shipping a fake live map was rejected over shipping an
  honest preview. _Revive when_ a target client supports MCP Apps end to end.
- **MCP Registry `server.json` not published.** The registry is still preview;
  distribution is not gated on it (plugin + marketplace + npm are the real
  channels). _Revive at_ registry GA.
- **Roots / Sampling / Logging deliberately unused** — deprecated upstream; do not
  design around them.

## Open

Carried as **K8** in the [roadmap README](./README.md) — none of it blocks a
release, and none of it has a forcing consumer yet.

- Remote hosting: OAuth 2.1 Resource Server (RFC 8707 audience validation, no token
  passthrough) in front of the HTTP transport. Not started; the transport ships.
- Migration to the `2026-07-28` MCP revision (stateless, MCP Apps, Tasks for async
  builds). Target today is `2025-11-25` on `@modelcontextprotocol/sdk ^1.29.0`.
- No evals exist for any skill; the intended bar was ≥3 per skill, without-skill
  baseline vs with-skill.
- Token-budget measurement of the 13-tool surface; adopt Tool Search if it grows.
