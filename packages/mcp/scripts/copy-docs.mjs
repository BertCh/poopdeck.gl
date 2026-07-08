#!/usr/bin/env node
// @poopdeck.gl/mcp
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/mcp contributors

/**
 * Build-time bundling of the PUBLISHED documentation corpus into
 * `<pkg>/docs/`, so a published `npx`/global install of `@poopdeck.gl/mcp`
 * ships the docs and can serve them with no repo on disk (the server's
 * default `docsRoot` prefers this bundled copy — see `src/config.ts`).
 *
 * The corpus is EXACTLY `docs/README.md` plus every `*.md` directly under
 * `docs/{intro,architecture,spec,api,guides}` — the same "published" set the
 * showcase renders (`examples/showcase/src/docs/content.ts`) and the server's
 * `src/docs.ts` corpus allow-list. It EXCLUDES `docs/roadmap/`.
 *
 * Resilient by design: if the source `docs/` tree is absent (e.g. building
 * from an extracted npm tarball, which carries no repo `docs/`), it skips
 * silently and leaves any already-bundled `docs/` in place.
 */
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLISHED_DOC_DIRS = ['intro', 'architecture', 'spec', 'api', 'guides'];
const ROOT_DOC = 'README.md';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..');
const SRC_DOCS = path.join(REPO_ROOT, 'docs');
const DEST_DOCS = path.join(PKG_ROOT, 'docs');

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(SRC_DOCS))) {
    // No source docs tree (e.g. building from an extracted tarball) — nothing to
    // copy. Leave any pre-bundled docs/ untouched.
    process.stdout.write(
      `copy-docs: source docs tree not found at ${SRC_DOCS} — skipping.\n`,
    );
    return;
  }

  // Start clean so a renamed/deleted source doc doesn't linger in the bundle.
  await rm(DEST_DOCS, { recursive: true, force: true });
  await mkdir(DEST_DOCS, { recursive: true });

  let copied = 0;

  const rootDoc = path.join(SRC_DOCS, ROOT_DOC);
  if (await exists(rootDoc)) {
    await cp(rootDoc, path.join(DEST_DOCS, ROOT_DOC));
    copied++;
  }

  for (const dir of PUBLISHED_DOC_DIRS) {
    const srcDir = path.join(SRC_DOCS, dir);
    if (!(await exists(srcDir))) continue;
    const names = await readdir(srcDir);
    const mdFiles = names.filter((n) => n.endsWith('.md'));
    if (mdFiles.length === 0) continue;
    await mkdir(path.join(DEST_DOCS, dir), { recursive: true });
    for (const name of mdFiles) {
      await cp(path.join(srcDir, name), path.join(DEST_DOCS, dir, name));
      copied++;
    }
  }

  process.stdout.write(
    `copy-docs: bundled ${copied} doc(s) into ${DEST_DOCS}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `copy-docs failed: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});
