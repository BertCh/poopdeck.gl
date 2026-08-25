#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'],
  {
    cwd: ROOT,
    encoding: 'utf8',
  },
)
  .split('\n')
  .filter(Boolean)
  .sort();

const failures = [];
let checked = 0;

for (const file of files) {
  const text = readFileSync(resolve(ROOT, file), 'utf8');
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) {
      target = target.slice(1, -1);
    } else {
      target = target.split(/\s+["']/u, 1)[0];
    }
    if (
      !target ||
      target.startsWith('#') ||
      target.startsWith('/') ||
      /^[a-z][a-z0-9+.-]*:/iu.test(target)
    ) {
      continue;
    }

    const pathOnly = target.split('#', 1)[0].split('?', 1)[0];
    if (!pathOnly) continue;
    checked += 1;
    let decoded;
    try {
      decoded = decodeURIComponent(pathOnly);
    } catch {
      failures.push(`${file}: invalid URL encoding in ${target}`);
      continue;
    }
    if (!existsSync(resolve(ROOT, dirname(file), decoded))) {
      failures.push(`${file}: missing ${target}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`documentation links: ${failures.length} missing target(s)`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(
  `documentation links: ${checked} relative targets resolve across ${files.length} Markdown files`,
);
