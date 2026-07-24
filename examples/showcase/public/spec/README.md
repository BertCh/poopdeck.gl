# `/spec/*.json` — the schemas served at their own `$id`

These four files are **byte-identical copies of `docs/spec/*.json`**, and
`docs/spec/` is the source of truth. Nothing here may be edited directly.

## Why the copy exists

`docs/spec/manifest.schema.json` and `docs/spec/scene.schema.json` each declare

```json
"$id": "https://poopdeck.gl/spec/<name>.json"
```

so any validator that *resolves* the `$id` — rather than being handed the file —
fetches that absolute URL. Before this directory existed, that URL had no
matching asset, so the showcase Worker answered with the SPA shell: **HTTP 200,
`text/html`**. A validator would then either fail on a JSON parse error or,
worse, quietly validate against nothing. `_headers` (in `public/`) serves these
with `application/schema+json` + `Access-Control-Allow-Origin: *`.

## Keeping it honest

A silently-diverging second copy of a schema is worse than no copy. After
editing anything under `docs/spec/`, re-run the copy and confirm it is clean:

```bash
cp docs/spec/*.json examples/showcase/public/spec/
git diff --stat examples/showcase/public/spec/    # empty == already in sync
```

Or just check, without writing:

```bash
for f in docs/spec/*.json; do
  cmp "$f" "examples/showcase/public/spec/$(basename "$f")" || echo "DRIFT: $f"
done
```

## The intended replacement

This copy should not exist long-term. `examples/showcase/vite.config.ts`
already runs an `emitLlmsDocs()` plugin that reads the repo's `docs/` tree at
build time and writes `docs/spec/*.json` verbatim into
`build/client/llms/spec/` (pinned byte-for-byte by
`examples/showcase/test/llms-generator.test.ts`). Emitting the same bytes to
`build/client/spec/` from that plugin removes the duplicate entirely — at which
point this directory should be deleted and the `_headers` block left as-is.
