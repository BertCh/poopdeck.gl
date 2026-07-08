# AI-assisted suite (Agent Skills + MCP) — 2026-07

> **Status update (CARTO integration removed):** the CARTO deep-integration
> work — the `@poopdeck.gl/carto` interop package, the stt-serve
> `--carto-compat` Maps-API façade, `stt-optimize export`, and
> `carto-integration-2026-07.md` — has been **expunged**; poopdeck.gl keeps
> only a shallow integration. The **MCP server + Agent Skills** described here
> were **retained standalone** (they never depended on CARTO at runtime).
> References below to `@poopdeck.gl/carto`, `sttJsonConfiguration`,
> `--carto-compat`, `carto-interop`, or `carto-integration-2026-07.md` are
> **historical** and no longer exist — STT layer classes for `view_map` specs
> now come from `@poopdeck.gl/layers` (register them in a `@deck.gl/json`
> `JSONConfiguration`).

> **Question:** what is the state of the art for **Agent Skills** and **MCP**, how
> do the two compose as a modern, standards-based whole, and how should
> poopdeck.gl ship an AI-assisted suite on top of them?
>
> **Method (2026-07-07):** four parallel research streams — (1) SoTA Agent Skills
> (Anthropic docs + the agentskills.io open standard), (2) SoTA MCP (spec 2025-11-25
> + the 2026-07-28 RC + Linux Foundation governance), (3) best-in-class comparable
> AI dev suites (Cloudflare, Playwright, GitHub, Supabase, Stripe, Sentry, Postgres,
> CARTO, Mapbox, Felt, kepler.gl…), (4) a full map of poopdeck.gl's own surface.
> Every external claim carries a URL in §11. This doc **supersedes and refines
> Phase D of `carto-integration-2026-07.md`** (D1 MCP / D2 json-registration /
> D3 skills), which was the original one-paragraph sketch.
>
> **Status:** design record — **now largely implemented (2026-07-07, uncommitted).**
> The `@poopdeck.gl/mcp` server was built out (by the CARTO Phase-D pass) and then
> extended per this design; the plugin + skills tier was built fresh. See §12 for
> the as-built inventory and what remains. When first written, this doc described
> the MCP package as an empty scaffold — that is no longer accurate.

---

## 0. Verdict

1. **The two primitives are complementary, not competing, and the field has
   converged on the split.** MCP = *connectivity* (live introspection + actions
   over external systems); Skills = *procedural know-how* (playbooks, opinions,
   and crucially **which tool to reach for**). The one-line test everyone now
   quotes: *"If you're explaining how to do something, that's a skill. If you need
   the model to access something, that's MCP."* Ship **both, as one plugin**.

2. **poopdeck.gl's `stt-*` Rust CLIs are its "wrangler."** The exemplar suite is
   Cloudflare's: a `wrangler` **skill** that teaches the agent *when to call the
   MCP API vs the wrangler CLI*, over a set of **MCP** servers that do live ops.
   Map directly: poopdeck skills carry the workflow/opinion and route between the
   MCP and the `stt-build`/`stt-optimize`/`stt-serve`/`stt-validate` CLIs.

3. **There is real whitespace.** *No official deck.gl or kepler.gl MCP exists.*
   The nearest analog — CARTO Agentic Tools (3 tools that teach the agent the
   deck.gl-JSON spec) — is closed/hosted. poopdeck.gl can be **the open,
   self-hostable, temporal-native deck.gl agent surface** — which is exactly what
   the `@poopdeck.gl/mcp` description already claims. The **temporal wedge** is the
   differentiator: make time first-class in the agent surface.

4. **Most of the plumbing already exists.** `@poopdeck.gl/carto` already exports
   `sttJsonConfiguration` (the `@deck.gl/json` registration — CARTO-plan "D2" is
   effectively done, so `view_map` has layers to instantiate). The 7 `stt-optimize`
   subcommands + `stt-validate` **already emit `--format json`** — they wrap into
   read-only MCP tools almost verbatim. `docs/api` (40 refs) + `docs/spec` +
   `docs/guides` are a ready-made progressive-disclosure corpus for skills.

5. **Standards posture (recommended):** author skills to the **agentskills.io open
   standard** (portable across Codex/Gemini CLI/Cursor/Copilot); build the MCP on
   the **official TS SDK**, target the **stable `2025-11-25`** revision now, and
   design forward-compatible with the **`2026-07-28` RC** (final in ~3 weeks:
   stateless architecture, the **MCP Apps** UI extension, the **Tasks** async
   primitive). Package everything as a **Claude Code plugin** (`.claude-plugin/` +
   `skills/` + `.mcp.json`) listed in a `marketplace.json`, with an `llms.txt`
   static tier underneath.

6. **Recommended build order:** Phase 1 (read-only MCP core over a `--packed`
   dir — discovery + introspection, wrapping the JSON-emitting subcommands) is the
   highest-leverage, lowest-risk start. Then Phase 2 (map composition + MCP-Apps
   inline render, reusing `sttJsonConfiguration`), Phase 3 (the skills suite +
   plugin packaging), Phase 4 (gated execution tools + remote Streamable-HTTP +
   OAuth), Phase 5 (RC migration + token-efficiency + registry publish).

---

## 1. SoTA — Agent Skills

**What they are.** A Skill = a folder with a `SKILL.md` entrypoint (Markdown +
YAML frontmatter) plus optional `scripts/`, `references/`, `assets/`.
**Model-invoked** — auto-loaded when a task matches its `description` (contrast a
slash command, which is user-initiated). Launched 2025-10-16; **released as an
open standard 2025-12-18 at agentskills.io**; adopted cross-vendor within weeks
(OpenAI Codex, Google Gemini CLI, GitHub Copilot/VS Code, Cursor, JetBrains Junie,
Goose, and ~40 more listed on the standard's showcase).

**The core mechanism — 3-tier progressive disclosure** (the reason skills are
cheap and MCP is not):

| Level | Loaded | Cost | Content |
|---|---|---|---|
| **L1 metadata** | always, in system prompt | **~100 tok/skill** | `name` + `description` only |
| **L2 body** | when the skill triggers | **target < 5k tok / < 500 lines** | `SKILL.md` |
| **L3 resources** | on demand / on execution | **0 tok until read** | `references/*.md`, `scripts/*` (run via bash — *source never enters context*, only output) |

**Frontmatter (open standard):** `name` (req; ≤64 chars, kebab-case, **must match
the folder name**, no "claude"/"anthropic") and `description` (req; ≤1024 chars,
**third-person, states both what it does AND when to use it** — the *sole* trigger
signal). Optional: `license`, `compatibility` (≤500 chars env requirements),
`metadata` (arbitrary string map — **`version` lives here**, there is no top-level
version field), `allowed-tools` (experimental, implementation-varying). Claude Code
adds a non-portable superset (`when_to_use`, `argument-hint`, `disable-model-
invocation`, `user-invocable`, `model`, `effort`, `context: fork`, `agent`,
`hooks`, `paths`) — **treat those as graceful-degradation extensions.**

**Authoring best practices** (Anthropic, published): "context window is a public
good" — be concise, assume the model is smart, only add what it doesn't know.
Descriptions are the trigger: make them slightly pushy, pack concrete keywords.
Gerund naming (`building-stt-datasets`). **Match degrees of freedom to task
fragility** — high freedom = prose for open-ended tasks; **low freedom = exact
scripts ("run this, do not modify") for fragile/consistency-critical ops** (e.g.
the summary-id repair, a publish-encode command). Keep references *one level deep*.
**Eval-driven**: ≥3 evals before docs, baseline without-skill vs with-skill.
Reference MCP tools by fully-qualified `ServerName:tool_name`.

**Distribution.** Personal (`~/.claude/skills/`), project (`.claude/skills/`,
checked into VCS), or **plugin** (`<plugin>/skills/<name>/` → `/plugin:skill`).
Claude API has a **Skills API** (`POST /v1/skills`, dir bundles < 30 MB, ≤8 per
request). claude.ai takes zip uploads (per-user). **Custom skills do not sync
across surfaces** — publish per surface. Validate with `skills-ref validate`.

---

## 2. SoTA — Model Context Protocol

**Spec versions.** Stable = **`2025-11-25`** (date-versioned; the string only
bumps on a backwards-incompatible change). A **release candidate `2026-07-28`** is
frozen and goes **final on 2026-07-28** — "the largest revision since launch."
Governance moved to the **Linux Foundation** (code + spec Apache-2.0), a
PyTorch-style maintainer hierarchy (Lead → Core → Maintainers = the **Steering
Group**), changes via **SEPs**. Basis: **JSON-RPC 2.0**, schema authored in
TypeScript → published as JSON Schema.

**Architecture.** host → clients (1:1 per server) → servers. Each client owns one
isolated stateful session; **a server cannot see the full conversation or peer
servers** (a structural security property). Capabilities negotiated at `initialize`.

**Primitives** (server-exposed unless noted):
- **Tools** — model-controlled functions. `tools/list`/`tools/call`; results carry
  text/image/audio, **structured JSON output** (since 2025-06-18), and **resource
  links**; annotations (readOnly / destructive / idempotent hints).
- **Resources** — app-controlled context addressed by URI. `resources/read`; **URI
  templates** (RFC 6570) for parameterized/dynamic resources + autocomplete;
  **subscriptions** (`resources/subscribe` → `notifications/resources/updated`).
- **Prompts** — user-controlled parameterized templates (`prompts/get`).
- **Sampling** *(client-exposed; deprecated in the RC)* — server asks the client's
  LLM for a completion; 2025-11-25 adds `tools`/`toolChoice`.
- **Elicitation** *(client-exposed)* — request structured user input mid-run:
  **form** mode (flat JSON Schema, primitives only) and **url** mode (new — send
  the user out-of-band for secrets/OAuth/payments). **Form mode MUST NOT request
  secrets.**
- **Roots / Logging** *(both deprecated in the RC, 12-month window)*, **Completions**
  (argument autocomplete), **Notifications** (`progress`, `*/list_changed`, …),
  **Ping**.

**Transports.** **stdio** (subprocess; best for local/self-host) and **Streamable
HTTP** (single endpoint, POST + optional GET/SSE; `Mcp-Session-Id`; resumable via
`Last-Event-Id`; for remote/multi-client). The old **HTTP+SSE transport is
deprecated** (legacy EOL reported ~2026-04-01). The **RC removes protocol-level
session management (stateless)** so servers can round-robin behind a load balancer.

**Authorization & security** (OAuth 2.1). Servers are **OAuth Resource Servers**,
MUST validate tokens; discovery via **RFC 9728 Protected Resource Metadata**;
clients MUST implement **Resource Indicators (RFC 8707)** and servers MUST validate
audience. Named threats + required mitigations: **confused deputy** (per-client
consent, exact `redirect_uri` match, CSRF `state`), **token passthrough
(forbidden)**, **session hijacking** (non-deterministic session IDs, never use
sessions for authN), **SSRF** on metadata discovery, **prompt injection / tool
poisoning** (host-enforced consent + server isolation + human-in-the-loop —
largely an app-level responsibility).

**Ecosystem.** Official SDKs: **TypeScript + Python** (flagship), plus Go, C#,
Java, Kotlin, Swift, Rust. **MCP Registry** (`registry.modelcontextprotocol.io`,
`server.json`, reverse-DNS names, DNS/GitHub namespace verification) — a metadata
catalog, still **preview**. Reference servers capped at 7 educational examples;
**FastMCP** dominates the Python side. Clients: Claude Code/Desktop, VS Code,
Cursor, Windsurf, Zed, JetBrains, plus the Anthropic **MCP Connector** (call remote
MCP straight from the Messages API).

**The token-efficiency frontier (this reshapes the server design).** MCP tool defs
load *up front* — 5 servers / 58 tools ≈ **55k tokens before the conversation
starts**. Three converging mitigations:
- **Code execution with MCP** (Anthropic) — present servers as a *filesystem of
  typed code APIs* the agent imports from a sandbox; load only the tools it needs;
  large intermediate data stays in the sandbox, never in context. Worked example:
  **150k → 2k tokens (~98.7%)**. Agents can persist reusable code into a
  `./skills/` dir — the concrete bridge from MCP-calling to Skills.
- **Tool Search Tool** (Claude Developer Platform) — index tool defs, surface on
  demand (MCP-eval accuracy 79.5% → 88.1% on Opus 4.5). Effectively mandatory past
  ~10 tools.
- **Programmatic Tool Calling** — the model writes orchestration in a sandbox;
  per-call round-trips and intermediate data stay out of context.

---

## 3. The complementarity model (how the two compose)

| | **Skills** | **MCP** | **Static (`llms.txt`/`.md`)** |
|---|---|---|---|
| Carries | procedure, opinion, guardrails, **routing** | live introspection, actions, data | frozen reference |
| Invoked | model-invoked by `description` | tool call | manually pointed-at |
| Cost | ~100 tok idle, <5k on trigger, L3 free | tool defs load up front | crawl-time (mostly unused) |
| Best for | multi-step workflows, "which layer / which tool", consistency-critical ops | real-time state, mutating actions, big data | cheap fallback |
| Analogy | the expert employee | access to the aisles | the printed manual |

**Structural claim (Anthropic):** *"A single skill can orchestrate multiple MCP
servers, and a single MCP server can support dozens of skills."* Skills tell the
model **how** to call the tools ("filter by date range first"). **The load-bearing
move is putting *which tool to reach for* in the skill** — the Cloudflare `wrangler`
skill that routes between the MCP API and the CLI is the pattern to copy verbatim,
because poopdeck's `stt-*` CLIs are exactly that CLI.

**Vendors shipping BOTH (evidence the pattern is real):** Cloudflare
(`cloudflare/skills` = skills + ~13 MCP servers, one install), Sentry
(`sentry-for-ai`, plugin auto-configures the MCP), Stripe (MCP + Skills + llms.txt,
three tiers), Microsoft (`microsoft/skills`, named for the pattern), Databricks
(the `SKILL.md` literally drives the Managed MCP with SELECT-only guardrails).
**Package as one Claude Code plugin** so `.mcp.json` auto-registers the server and
`skills/` auto-loads — one install, no hand-edited config.

---

## 4. Best-in-class comparables — the patterns to copy

**The whitespace:** no official deck.gl/kepler.gl MCP. CARTO Agentic Tools is the
closest analog and validates the shape. Distilled design rules from the field:

1. **Few, powerful, consolidated tools — never 1:1 the API.** Cloudflare Code Mode
   = **2 tools** (`search`+`execute`) for 2,500+ endpoints (~1k tokens vs ~1.17M
   naive). Stripe = **4 dispatchers**. CARTO = **3 tools that teach the deck.gl
   JSON spec**. GitHub = **toolsets**; Supabase = **feature groups**. Target ~12–15
   tools, grouped.
2. **The server does the analysis; return opinionated verdicts, not raw dumps.**
   Chrome DevTools MCP returns "why is LCP slow," not a waterfall; Postgres MCP Pro
   returns index recommendations; Sentry's `analyze_issue_with_seer` returns file
   paths + code fixes. → poopdeck's `stt-optimize doctor` (severity-ranked findings
   + remediation + projected win) is *already exactly this shape*.
3. **Semantic/structured returns over pixels.** Playwright MCP drives off the a11y
   tree with stable `ref` handles, not screenshots — "deterministic, no vision
   model." Return GeoJSON/metadata; render maps as **interactive MCP-Apps UI**, not
   base64 (Mapbox already does this).
4. **Feed the model data *shape/metadata*, not raw rows.** kepler.gl's AI Assistant
   sends only dataset/layer/variable *names* to the LLM — privacy **and** token
   story in one. → `describe_dataset` returns the manifest/schema/timeRange, never
   feature rows.
5. **Declarative spec > imperative code as the generation target.** Databricks/
   Vega-Lite: specs are auditable, compact, **schema-validatable** (render→check→fix
   loop → <1% empty-chart rate). CARTO teaches the deck.gl JSON via a system-prompt
   **"expertise builder"** so the model needs no GIS knowledge; aesthetics
   (palette/binning/zoom) are delegated to the library, not the model.
6. **Safety as an operator-enforced switch, not a model instruction.** `--read-only`
   (Supabase/GitHub) *removes mutating tools from the manifest entirely*; Prisma's
   CLI itself blocks destructive commands unless consented. Least-privilege scoping
   is operator config.
7. **Docs-as-context, curated-index-then-fetch, version-pinned.** `list-sections →
   get-documentation` (Svelte), `resolve-library-id → get-library-docs` (Context7),
   explicit `tokens` budget params + relevance capping (Ref/Vercel), pinned to the
   *installed* version (Next.js reads `node_modules/next/dist/docs`).
8. **Distribution norm:** remote-hosted OAuth server **and** local-stdio self-host;
   multi-component "suite" plugins (the CockroachDB plugin = 32 skills + 3 subagents
   + 14 tools across 2 MCP backends is the north star for a coordinated suite).

---

## 5. poopdeck.gl surface & the jobs to be done

The suite must cover this toolchain (see the codebase inventory for full detail):

- **CLIs (the "wrangler"):** `stt-build` (GeoParquet/DB → packed `.stt`),
  `stt-optimize` (**7 subcommands**: `analyze` / `recommend` / `inspect` / `diff` /
  `doctor` / `order-audit` / `export` — analyze/inspect/diff/doctor/order-audit all
  take `--format json`; recommend emits JSON + `--command`/`--explain`),
  `stt-serve` (dynamic tiles; `--packed`/`--postgres`/`--duckdb`; `--carto-compat`
  façade), `stt-validate` (`--json` integrity/decode/schema/summary/temporal),
  `stt-bundle` (`.sttb`), `stt-generate` (reference datasets).
- **Packages:** `core`, `layers` (~25 STT layers), `three` (WebGPU), `playback`,
  `react`, `maplibre`, `cesium`, **`carto`** (ships `sttJsonConfiguration` for
  `@deck.gl/json` — the `view_map` layer registry), and the **`mcp` stub**.
- **Corpus:** `docs/api` (40), `docs/spec`, `docs/guides` (incl. `tuning-tiles.md`,
  `carto-interop.md`), `docs/architecture` — ideal skill L3 references.

**Jobs to be done → suite coverage:** ingest→GeoParquet · analyze+recommend a build
recipe · build `.stt` (+ `--auto`) · build-from-DB · **validate / debug blank
render** · inspect/audit/lint/diff · re-encode for publish · bundle · serve · CARTO/
warehouse export · publish to R2 · **wire a deck.gl layer** · wire three/maplibre/
cesium · add playback UI · tune styling. Each maps to a skill and/or MCP tool below.

---

## 6. Proposed architecture

### 6.1 One plugin, three tiers

```
poopdeck-ai/                         # Claude Code plugin (also usable standalone)
├── .claude-plugin/
│   ├── plugin.json                  # manifest
│   └── marketplace.json             # catalog entry (github source)
├── .mcp.json                        # auto-registers @poopdeck.gl/mcp (stdio) on enable
├── skills/                          # the procedural tier (open-standard SKILL.md)
│   ├── poopdeck-overview/           #   the router skill (when to use which CLI/tool/pkg)
│   ├── building-stt-datasets/
│   ├── tuning-stt-tiles/
│   ├── wiring-deckgl-layers/
│   ├── choosing-a-renderer/
│   ├── adding-playback/
│   ├── serving-and-publishing/
│   ├── carto-interop/
│   └── debugging-blank-renders/
└── (llms.txt + docs/*.md)           # static tier, emitted from the existing corpus
```

`@poopdeck.gl/mcp` (`bin: stt-mcp`) is the MCP tier. `.mcp.json` uses
`${CLAUDE_PLUGIN_ROOT}` / `npx -y @poopdeck.gl/mcp` so one install wires the server;
`skills/` auto-loads. The server also runs standalone (self-host / Claude Desktop /
any MCP client) and, later, remote (Streamable HTTP at e.g. `mcp.poopdeck.gl`).

### 6.2 MCP server — tool taxonomy

Few, consolidated, opinionated, read-only-by-default. Datasets/docs exposed as
**Resources** (cheap, cacheable) in addition to tools.

**A. Discovery (read-only)**
- `list_datasets` — catalog over a `--packed` dir / R2 listing / `datasets.ts`;
  compact metadata only.
- `describe_dataset` — manifest metadata, schema, `timeRange`, `styleHints`,
  `capabilities`, summary tier. **Metadata not rows** (kepler.gl pattern).
- **Resources:** `stt://datasets/{id}` (+ `stt://datasets/{id}/manifest`,
  `.../schema`) via URI templates — 0-token until read (Mapbox `mapbox://categories`
  / reference-Postgres "schema as resources" pattern).

**B. Introspection / analysis (read-only, opinionated verdicts)** — thin wrappers
over the JSON-emitting subcommands:
- `inspect_dataset` → `stt-optimize inspect --format json`
- `audit_dataset` → `stt-optimize doctor --format json` (+ `order-audit`) —
  severity-ranked findings + remediation + projected win.
- `recommend_build` → `stt-optimize analyze` + `recommend --command --explain` — a
  suggested `stt-build` invocation with confidence/rationale (the render→check→fix
  precursor).
- `diff_datasets` → `stt-optimize diff` (regression gate).
- `validate_dataset` → `stt-validate --json` (safe; stays on in read-only mode).

**C. Map composition (the flagship — teach the STT/deck.gl-JSON spec)**
- `view_map` — accepts a `@deck.gl/json` spec with STT layers registered via the
  existing **`sttJsonConfiguration`**; renders an **inline interactive map through
  the MCP Apps extension** (Mapbox/CARTO already do this). Time-native: honors
  `currentTime`/`timeWindow`; the app supports scrub/play.
- `compose_layer` — params/NL → a **Zod-validated** STT layer spec (pick from ~25
  layers, color binning, palette, `tier`, `scrubLod`), with a **system-prompt
  expertise builder** injecting layer types + palettes + the dataset's `styleHints`
  (the `@carto/agentic-deckgl` `buildSystemPrompt()` pattern). Aesthetics delegated
  to the library, not the model.
- `set_time` / `set_time_range` / `play_pause` — session view-state (the temporal
  wedge; no CARTO equivalent).

**D. Execution (mutating — OFF by default; `--allow-build`/`--allow-serve`)** —
tools **removed from the manifest** unless enabled (Supabase pattern):
- `build_dataset` (prefer running the low-freedom recipe from `recommend_build`),
  `serve_dataset`. Gated shell-outs to the CLIs.

**E. Docs (optional, secondary to skills)** — `search_docs` + `get_doc` over
`docs/*`, explicit `tokens` budget + relevance cap, version-pinned. Most of this
is better as skill L3, so keep it thin.

*Token architecture:* ~12–15 tools grouped; datasets/docs as resources; design for
Tool Search / Programmatic Tool Calling; keep breadth cheap so the skills own the
budget. If the surface grows, adopt a Cloudflare-Code-Mode `search()`+`execute()`
consolidation.

### 6.3 Skills suite (the procedural tier)

Author to the open standard (portable). Each skill maps to a job-to-be-done, pulls
L3 from the existing `docs/` corpus, bundles **low-freedom scripts** for fragile ops,
and **routes** between the MCP tools and the CLIs:

| Skill | Trigger (description gist) | Teaches / routes to | L3 source |
|---|---|---|---|
| `poopdeck-overview` | "working with poopdeck.gl / spatiotemporal tiles" | the router: which CLI vs MCP tool vs package | `docs/intro/*` |
| `building-stt-datasets` | "build a .stt from GeoParquet or a DB" | `stt-build` flag model, time/zoom/summary decisions, `--auto`; **call `recommend_build` first** | `cli-reference`, `csv-quickstart` |
| `tuning-stt-tiles` | "optimize / shrink / lint tiles for publish" | inspect→doctor→diff loop, **no-thinning principle**, publish encode levers; routes to `audit_dataset`/`diff_datasets` | `guides/tuning-tiles.md` |
| `wiring-deckgl-layers` | "add a SpatioTemporalLayer / pick the right STT layer" | layer-selection decision tree, styling/extensions, the JSON spec; routes to `compose_layer`/`view_map` | `spatiotemporal-layer.md`, per-layer docs |
| `choosing-a-renderer` | "deck vs three vs maplibre vs cesium" | trade-offs, camera/clock sharing | `intro/choosing.md` |
| `adding-playback` | "add scrub/play controls" | `SttPlayer`/`PlaybackGovernor`/React hooks | `stt-player.md`, `stt-react.md` |
| `serving-and-publishing` | "serve tiles / publish to R2" | `stt-serve` backends, R2; routes to `serve_dataset` | `guides/deploying.md` |
| `debugging-blank-renders` | "my STT map renders blank/empty" | the blank-render class (summary-id defect, capabilities, time-window); validate→diagnose→fix; routes to `validate_dataset`/`audit_dataset`; bundles the summary-id repair script | gotchas + `stt-validate` |

The `debugging-blank-renders` and `tuning-stt-tiles` skills capture hard-won,
non-obvious knowledge (the summary-id defect, the no-thinning principle) that lives
in project memory, not the code — the highest-value skills to write first.

---

## 7. Standards & versioning decisions (flag for sign-off)

1. **MCP spec target.** Recommend **`2025-11-25` now**, forward-compatible with the
   **`2026-07-28` RC** (final in ~3 weeks). RC brings **stateless architecture**
   (drop session assumptions), the **MCP Apps** UI extension (the standards-track
   home for `view_map`'s inline map — build against it), the **Tasks** primitive
   (ideal for long `build_dataset` runs), and **deprecates Roots/Sampling/Logging**
   (don't design around them). *Verify `@modelcontextprotocol/sdk ^1.29.0` covers
   the 2025-11-25 primitives; bump when RC SDKs stabilize.*
2. **Skills standard.** Author to **agentskills.io** (two required fields; portable);
   layer Claude Code extensions as optional. Validate with `skills-ref validate`.
3. **Transports.** stdio (plugin / self-host) now; add Streamable HTTP + OAuth 2.1
   for a hosted server later (Phase 4). Registry `server.json` at Phase 5.
4. **Distribution.** Claude Code plugin + `marketplace.json`; npm `@poopdeck.gl/mcp`;
   `llms.txt` static tier; optional Claude Skills-API upload.
5. **Naming.** `@poopdeck.gl/mcp` (set) + plugin id `poopdeck-ai` (proposed).

---

## 8. Security model

Adopt the field defaults, enforced by the *server/operator*, not the model:
- **Read-only by default.** Mutating tools (`build_dataset`, `serve_dataset`)
  **absent from the manifest** unless `--allow-build`/`--allow-serve`.
- **Least privilege / scoping.** `--packed <dir>` roots the server to one tree;
  no arbitrary filesystem or shell.
- **Gated shell-outs.** Execution tools run known `stt-*` binaries with validated
  args (no shell string interpolation); Prisma-style consent.
- **Remote (Phase 4):** OAuth 2.1 Resource Server, RFC 8707 audience validation,
  no token passthrough, non-deterministic session IDs, SSRF guards, MCP-Apps CSP.
- **Prompt-injection posture:** rely on host consent + server isolation +
  human-in-the-loop for any mutating tool; audit bundled skill scripts.

---

## 9. Phased plan (delegatable)

**Phase 1 — Read-only MCP core (highest leverage, lowest risk).**
Implement `@poopdeck.gl/mcp` on the TS SDK (stdio): `list_datasets`,
`describe_dataset` (+ dataset Resources), `inspect_dataset`, `audit_dataset`,
`recommend_build`, `diff_datasets`, `validate_dataset` — thin wrappers over the
JSON-emitting subcommands over a `--packed` dir. *Accept:* MCP-inspector session
exercises every tool against a frozen fixture archive; structured outputs validated.

**Phase 2 — Map composition + inline render.**
`view_map` (reuse `sttJsonConfiguration`) rendered via MCP Apps; `compose_layer`
with the expertise-builder + Zod validation + render→check→fix; `set_time`/
`set_time_range`/`play_pause`. *Accept:* an agent emits a valid animated STT map
from NL; invalid specs self-correct.

**Phase 3 — Skills suite + plugin packaging.**
Author the ~9 skills to the open standard (start with `debugging-blank-renders`,
`tuning-stt-tiles`, `building-stt-datasets`, `wiring-deckgl-layers`, and the
`poopdeck-overview` router), wire L3 to `docs/`, bundle low-freedom scripts. Add
`.claude-plugin/plugin.json`, `.mcp.json`, `marketplace.json`, and the `llms.txt`
emitter. *Accept:* one-command install wires MCP + skills; ≥3 evals per skill show
with-skill > baseline; `skills-ref validate` clean.

**Phase 4 — Gated execution + remote server.**
`build_dataset`/`serve_dataset` behind switches; Tasks-based async build; Streamable
HTTP + OAuth 2.1 host at `mcp.poopdeck.gl`. *Accept:* hosted server passes the MCP
security checklist; mutating tools absent without flags.

**Phase 5 — RC migration + efficiency + registry.**
Migrate to `2026-07-28` (stateless; MCP Apps/Tasks official); adopt Tool Search /
Programmatic Tool Calling; publish `server.json` to the MCP Registry; validate the
skills across Codex/Gemini CLI/Cursor. *Accept:* registry listing live; token
budget measured; cross-vendor skill smoke tests pass.

---

## 10. Risks & open questions

- **RC timing.** The `2026-07-28` break lands mid-build. Mitigation: target
  2025-11-25, isolate transport/session behind an adapter, plan Phase 5 migration.
- **MCP Apps maturity.** The inline-map UI extension is new/standards-track; confirm
  client support (Claude Desktop/VS Code/Goose) before betting `view_map` on it —
  fall back to returning a spec + a hosted preview URL (Vizro pattern).
- **CLI-as-tool coupling.** Shelling out to `stt-*` needs the binaries present.
  Decide: bundle via npm optionalDeps? Assume a local install? Prefer the packed-dir
  read path (no shell) for read-only tools; reserve shell-outs for execution.
- **Registry is preview** — no GA; don't gate distribution on it (plugin +
  marketplace + npm are the real channels).
- **`nrows`/distinct-row counts** and other CARTO-doc deviations carry over — keep
  the MCP honest about what the format can/can't report.
- **Open question:** compile skills to multi-harness variants (wshobson-style) or
  rely on native cross-vendor `SKILL.md` consumption? Recommend the latter (the
  format is now natively consumed) unless a specific non-Claude target demands it.

---

## Implementation status — as built (2026-07-07, uncommitted)

**MCP server (`@poopdeck.gl/mcp`, `bin: stt-mcp`) — built + extended, 59 tests green.**
- Discovery: `list_datasets`, `describe_dataset` (manifest-only, no `@poopdeck.gl/core`
  runtime dep), `dataset_report` (`stt-optimize inspect`/`doctor`/`order-audit`).
- Analysis (added per this design): `recommend_build` (`stt-optimize recommend` →
  recipe + rendered `stt-build` command), `diff_datasets` (`stt-optimize diff`).
- Interactive: `view_map` (`@deck.gl/json` spec via the inferred `@@type`, + a
  best-effort self-contained HTML resource), `set_time`, `play_pause`.
- Execution (gated behind `--allow-cli`): `build_dataset`, `validate_dataset`.
- **Resources (added):** `stt://datasets/{name}` via a `ResourceTemplate` (list +
  read), same payload as `describe_dataset`.
- Transports: stdio + stateless Streamable HTTP. Expertise-builder system prompt
  (`buildSystemPrompt`). Safe `spawn` (arg arrays, no shell), binary resolver,
  output caps, timeouts, path-traversal containment on dataset names.
- **Verified end-to-end** over real stdio against the real `stt-optimize`/
  `stt-validate` binaries and a fixture archive (every tool + resource exercised;
  `recommend_build` produced `--min-zoom 9 --max-zoom 10 --temporal-bucket 1m
  --style-hints` from `storm-tracks.parquet`).

**Plugin + skills tier — built fresh (the previously-absent "D3").**
- `poopdeck-ai/` Claude Code plugin: `.claude-plugin/plugin.json`, `.mcp.json`
  (auto-registers the server, read-only by default), README; repo-root
  `.claude-plugin/marketplace.json`; repo-root `llms.txt` static tier.
- Five skills authored to the **agentskills.io open standard** (validated: names
  match folders, kebab-case, descriptions ≤1024, bodies <500 lines):
  `poopdeck-overview` (router), `building-stt-datasets`, `tuning-stt-tiles`,
  `wiring-deckgl-layers`, `debugging-blank-renders`. Each routes between the CLIs
  and the MCP tools; the last two encode non-obvious project knowledge (the
  summary-id defect, the no-thinning rule).

**Deviations from the design, and what remains:**
1. `--min-zoom`/`--max-zoom` are the canonical stt-build flags (not
   `--min-zoom-level`); `recommend_build` renders those.
2. `compose_layer` was **not** built as a separate tool — `view_map`'s `@@type`
   inference + the `wiring-deckgl-layers` skill cover the "which layer + props"
   job; a dedicated NL→validated-layer-spec tool with a Zod layer catalog is the
   natural next add if needed.
3. `search_docs`/`get_doc` deferred — the skills' L3 doc references + `llms.txt`
   cover it for now.
4. Read-only-subprocess tools (`recommend_build`/`diff_datasets`/`dataset_report`)
   self-gate on `--allow-cli` (any subprocess is opt-in), matching the existing
   server posture; only `build_dataset` mutates.
5. Open: remote Streamable-HTTP + OAuth 2.1 hosting (Phase 4); the `2026-07-28` RC
   migration + MCP-Apps live inline render + Tasks-based async builds (Phase 5);
   more skills (`choosing-a-renderer`, `adding-playback`, `serving-and-publishing`,
   `carto-interop`); publish `@poopdeck.gl/mcp` to npm so `.mcp.json` can use `npx`;
   evals per skill; registry `server.json`. None of the suite is committed yet.

## 11. Sources

**Agent Skills:** anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills ·
platform.claude.com/docs/en/agents-and-tools/agent-skills/overview ·
.../agent-skills/best-practices · agentskills.io/specification ·
github.com/anthropics/skills · github.com/agentskills/agentskills ·
code.claude.com/docs/en/skills · platform.claude.com/docs/en/build-with-claude/skills-guide

**MCP:** modelcontextprotocol.io/specification/versioning ·
.../2025-11-25/changelog · .../2025-11-25/architecture ·
.../2025-11-25/client/elicitation · .../2025-11-25/basic/security_best_practices ·
.../2025-03-26/basic/transports · modelcontextprotocol.io/community/governance ·
blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/ ·
modelcontextprotocol.io/registry/about · github.com/modelcontextprotocol/typescript-sdk ·
anthropic.com/engineering/code-execution-with-mcp · anthropic.com/engineering/advanced-tool-use

**Complementarity:** claude.com/blog/extending-claude-capabilities-with-skills-mcp-servers ·
claude.com/blog/skills-explained · simonwillison.net/2025/Oct/16/claude-skills/ ·
github.com/cloudflare/skills · github.com/getsentry/sentry-for-ai · github.com/microsoft/skills ·
code.claude.com/docs/en/plugins · code.claude.com/docs/en/plugin-marketplaces

**Comparable suites & geo/dataviz AI:** github.com/mapbox/mcp-server ·
developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/ ·
blog.cloudflare.com/code-mode-mcp/ · github.com/microsoft/playwright-mcp ·
github.com/ChromeDevTools/chrome-devtools-mcp · github.com/github/github-mcp-server ·
supabase.com/docs/guides/ai-tools/mcp · docs.stripe.com/mcp · github.com/getsentry/sentry-mcp ·
github.com/crystaldba/postgres-mcp · docs.carto.com/carto-for-agents/mcp-server ·
carto.com/blog/carto-agentic-tools-for-developers/ · felt.com/blog/introducing-felt-mcp-server ·
github.com/keplergl/kepler.gl/blob/master/docs/user-guides/ai-assistant.md ·
databricks.com/blog/bringing-visualizations-life-multi-agent-systems-vega-lite ·
github.com/antvis/mcp-server-chart · idl.uw.edu/mosaic/vgplot/

*Internal cross-refs:* `docs/roadmap/carto-integration-2026-07.md` (Phase D), the
codebase surface inventory, `packages/mcp/package.json` (the scaffold).
