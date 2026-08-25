import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SHOWCASE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const REPO_ROOT = path.resolve(SHOWCASE_ROOT, '..', '..');

describe('public project status', () => {
  for (const name of ['project-status.json', 'project-status.schema.json']) {
    it(`serves a byte-identical ${name}`, async () => {
      const [source, published] = await Promise.all([
        readFile(path.join(REPO_ROOT, name)),
        readFile(path.join(SHOWCASE_ROOT, 'public', name)),
      ]);
      expect(published).toEqual(source);
    });
  }
});
