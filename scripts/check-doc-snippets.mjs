#!/usr/bin/env node
/**
 * Typecheck the TypeScript code samples in the onboarding docs.
 *
 * ## Why
 *
 * The quickstart's React samples are written as `.tsx` and are meant to be
 * copy-pasted verbatim. Two of them did not compile under `strict` with the
 * standard Vite TS setup — `style={{ inset: 0 }}` against deck's
 * `Partial<CSSStyleDeclaration>`, and `<PlaybackControls {...playback} />`
 * against a `timeRange` the hook echoes back optional. Both errors were in code
 * the docs told the reader to copy, and nothing in the repo would have noticed
 * (DX review 2026-08-26, F3).
 *
 * ## What counts as a snippet
 *
 * A fenced ```ts / ```tsx block in one of {@link DOCS}, that STARTS with an
 * `import` statement. That rule is the whole selection heuristic: a block with
 * imports is a standalone module the reader can paste into a file, so it must
 * compile on its own; a block without them is a fragment quoted for context
 * (`onMetadataLoad: (meta) => …`) and has no self-contained meaning. Fragments
 * are counted and reported, never checked.
 *
 * ## How
 *
 * Each snippet is written into `examples/showcase/.doc-snippets/` — inside the
 * showcase package, so it resolves the real `@poopdeck.gl/*` and deck.gl
 * versions the docs pin — and the whole directory is typechecked in ONE `tsc`
 * pass against showcase-equivalent strict settings.
 *
 * Requires the workspace packages to be built (`pnpm turbo run build`): the
 * snippets import package entry points, which resolve to `dist`.
 *
 * Usage: `node scripts/check-doc-snippets.mjs [--keep]`
 *   --keep  leave the generated directory in place for inspection
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SHOWCASE = join(ROOT, 'examples/showcase');
const OUT_DIR = join(SHOWCASE, '.doc-snippets');

/**
 * Docs whose TypeScript samples are a promise to the reader. Deliberately an
 * allowlist, not a glob: a spec or roadmap page quotes illustrative code that
 * is not meant to compile, and sweeping those in would force the gate to grow
 * exceptions until it gated nothing.
 */
const DOCS = ['docs/intro/quickstart.md', 'docs/guides/csv-quickstart.md'];

/** ```ts / ```tsx fenced blocks, with their 1-based opening-fence line. */
function extractSnippets(markdown) {
  const out = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const fence = /^```(tsx?|typescript)\s*$/.exec(lines[i]);
    if (!fence) continue;
    const start = i + 1;
    let end = start;
    while (end < lines.length && lines[end] !== '```') end++;
    out.push({
      lang: fence[1] === 'typescript' ? 'ts' : fence[1],
      line: i + 1,
      code: lines.slice(start, end).join('\n'),
    });
    i = end;
  }
  return out;
}

/** A snippet is a standalone module iff its first statement is an import. */
function isStandalone(code) {
  for (const raw of code.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('//') || line.startsWith('/*')) continue;
    return line.startsWith('import ');
  }
  return false;
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

/** Generated file name → the doc and line it came from, for error mapping. */
const origin = new Map();
let checked = 0;
let fragments = 0;

for (const doc of DOCS) {
  const markdown = readFileSync(join(ROOT, doc), 'utf8');
  const slug = doc.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  for (const snippet of extractSnippets(markdown)) {
    if (!isStandalone(snippet.code)) {
      fragments++;
      continue;
    }
    const name = `${slug}-L${snippet.line}.${snippet.lang}`;
    writeFileSync(join(OUT_DIR, name), `${snippet.code}\n`);
    origin.set(name, `${doc}:${snippet.line}`);
    checked++;
  }
}

if (checked === 0) {
  console.error(
    'doc snippets: found NOTHING to check — the extractor or the allowlist is broken',
  );
  process.exit(1);
}

// Vite supplies these ambient declarations in a real app; the snippets import
// a stylesheet and read `import.meta.env`, neither of which plain tsc knows.
writeFileSync(
  join(OUT_DIR, 'globals.d.ts'),
  [
    "declare module '*.css';",
    'interface ImportMetaEnv {',
    '  readonly [key: string]: string | boolean | undefined;',
    '}',
    'interface ImportMeta {',
    '  readonly env: ImportMetaEnv;',
    '}',
    '',
  ].join('\n'),
);

// Mirrors examples/showcase/tsconfig.json — the setup `npm create vite` gives
// someone starting today, which is the setup the reader will paste into.
writeFileSync(
  join(OUT_DIR, 'tsconfig.json'),
  `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2020',
        lib: ['ES2020', 'DOM', 'DOM.Iterable'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        resolveJsonModule: true,
        isolatedModules: true,
        // Each snippet is a separate top-level file in one directory; without
        // this they share a global scope and collide on `App`, `DATA`, `DAY`.
        moduleDetection: 'force',
      },
      include: ['./*.ts', './*.tsx', './globals.d.ts'],
    },
    null,
    2,
  )}\n`,
);

let failed = false;
try {
  execFileSync('npx', ['tsc', '--noEmit', '-p', OUT_DIR], {
    cwd: SHOWCASE,
    stdio: 'pipe',
    encoding: 'utf8',
  });
} catch (error) {
  failed = true;
  const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  // Rewrite generated paths back to the doc they came from, so the failure
  // names a Markdown file someone can go and fix.
  const mapped = output.replace(
    /(?:.*[/\\])?([a-zA-Z0-9-]+-L\d+\.tsx?)/g,
    (match, file) => origin.get(file) ?? match,
  );
  console.error('doc snippets: TypeScript errors in copy-pasteable samples\n');
  console.error(mapped.trim());
}

if (!failed && !process.argv.includes('--keep')) {
  rmSync(OUT_DIR, { recursive: true, force: true });
}

if (failed) {
  console.error(
    `\nGenerated sources kept at ${OUT_DIR} for inspection.\n` +
      'Fix the sample in the Markdown, not the generated file.',
  );
  process.exit(1);
}

console.log(
  `doc snippets: ${checked} standalone samples typecheck across ${DOCS.length} docs ` +
    `(${fragments} fragments skipped)`,
);
