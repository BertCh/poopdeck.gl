import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateLlmsArtifacts } from '../src/docs/llms.ts';
import {
  getPublicIndexPaths,
  renderSitemapXml,
} from '../src/lib/publicPaths.ts';

const showcaseRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.join(showcaseRoot, '..', '..');

/**
 * Finish the static site only after React Router has emitted and prerendered
 * its complete build. Vite's closeBundle hook runs too early: React Router's
 * later prerender finalization replaces the client directory and used to erase
 * `_headers`, the public spec, and the generated llms files.
 */
export async function finalizeStaticAssets(clientDir: string): Promise<void> {
  const publicDir = path.join(showcaseRoot, 'public');
  const docsDir = path.join(repoRoot, 'docs');
  const llmsSourcePath = path.join(repoRoot, 'llms.txt');
  const skipped: string[] = [];

  fs.mkdirSync(clientDir, { recursive: true });
  fs.cpSync(publicDir, clientDir, {
    recursive: true,
    force: true,
    filter(src) {
      if (path.basename(src) === '.DS_Store') return false;
      const rel = path.relative(publicDir, src).split(path.sep).join('/');
      const top = rel.split('/')[0];

      // Tile archives and their source/intermediate files live on the R2 data
      // origin, not in the Worker asset bundle. Match staging trees by shape so
      // a newly named data-vN directory cannot silently add gigabytes.
      if (top === 'data' || top.startsWith('data-')) {
        if (rel === top) skipped.push(`${top}/ (entire tree)`);
        return false;
      }
      if (/\.(stt|parquet)$/i.test(rel)) {
        skipped.push(rel);
        return false;
      }
      return true;
    },
  });

  if (!fs.existsSync(docsDir) || !fs.existsSync(llmsSourcePath)) {
    throw new Error('Cannot emit llms files: docs/ or llms.txt is missing');
  }
  const { llmsTxt, llmsFull, docFiles } = generateLlmsArtifacts({
    docsDir,
    llmsSource: fs.readFileSync(llmsSourcePath, 'utf8'),
  });
  fs.writeFileSync(path.join(clientDir, 'llms.txt'), llmsTxt);
  fs.writeFileSync(path.join(clientDir, 'llms-full.txt'), llmsFull);
  for (const { path: relativePath, text } of docFiles) {
    const destination = path.join(clientDir, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, text);
  }

  fs.writeFileSync(
    path.join(clientDir, 'sitemap.xml'),
    renderSitemapXml(await getPublicIndexPaths()),
  );

  console.info(
    `Finalized static assets: ${docFiles.length} llms docs; excluded ${skipped.join(', ') || 'no data trees'}`,
  );
}
