import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SHOWCASE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const REPO_ROOT = path.resolve(SHOWCASE_ROOT, '..', '..');

describe('public specification assets', () => {
  it('serves byte-identical copies of every canonical JSON specification', async () => {
    const sourceDir = path.join(REPO_ROOT, 'docs', 'spec');
    const publicDir = path.join(SHOWCASE_ROOT, 'public', 'spec');
    const names = (await readdir(sourceDir))
      .filter((name) => name.endsWith('.json'))
      .sort();

    expect(names).not.toHaveLength(0);
    for (const name of names) {
      const [source, published] = await Promise.all([
        readFile(path.join(sourceDir, name)),
        readFile(path.join(publicDir, name)),
      ]);
      expect(published, `${name} has drifted from docs/spec`).toEqual(source);
    }
  });
});
