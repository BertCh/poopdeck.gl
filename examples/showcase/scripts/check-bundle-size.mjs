import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const showcaseDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const clientDir = path.join(showcaseDir, 'build', 'client');
const assetsDir = path.join(clientDir, 'assets');

const kib = (bytes) => bytes / 1024;
const gzipKiB = (file) => kib(gzipSync(fs.readFileSync(file)).byteLength);

function routeJavaScriptKiB(htmlPath) {
  const html = fs.readFileSync(path.join(clientDir, htmlPath), 'utf8');
  const refs = new Set(
    [...html.matchAll(/(?:href|src)="\/?(assets\/[^"]+\.js)"/g)].map(
      (match) => match[1],
    ),
  );
  return [...refs].reduce(
    (sum, ref) => sum + gzipKiB(path.join(clientDir, ref)),
    0,
  );
}

const failures = [];
const report = [];
function check(label, actual, maximum) {
  report.push(
    `${label}: ${actual.toFixed(1)} KiB gzip / ${maximum} KiB budget`,
  );
  if (actual > maximum) failures.push(`${label} is ${actual.toFixed(1)} KiB`);
}

check('home initial JS', routeJavaScriptKiB('index.html'), 145);
check(
  'demo initial JS',
  routeJavaScriptKiB('demos/ocean-drifters/index.html'),
  195,
);

const chunkBudgets = [
  [/^entry\.client-.*\.js$/, 'client entry', 65],
  [/^datasets-.*\.js$/, 'dataset catalog', 27],
  [/^DemoPageImpl-.*\.js$/, 'demo shell', 5],
  // 7 -> 9.5: the interleaved MapboxOverlay terrain path, the mobile chrome
  // (`useIsMobile`) and the pitch/camera limits all landed in this component
  // on 2026-08-25, measured at 5.1 -> 9.0 KiB gzip (14,004 -> 26,697 B raw for
  // the same chunk). The 7 KiB number was calibrated against the 5.1 KiB
  // component and predates all three, so it is stale rather than breached.
  // Reviewed and re-based deliberately — see docs/roadmap/launch-readiness-2026-08.md.
  // The real reduction available here is splitting the terrain path behind a
  // dynamic import: most demos never load it, and it is the largest single
  // addition. Tracked as a follow-up, not a launch blocker.
  [/^DemoViewer-.*\.js$/, 'deck viewer', 9.5],
  [/^MaplibreRenderer-.*\.js$/, 'MapLibre renderer', 70],
  [/^SttThreeGeoViewer-.*\.js$/, 'Three renderer shell', 5],
  [/^HomeGlobe-.*\.js$/, 'home globe shell', 2.5],
  // 95 -> 100: apache-arrow 17 -> 21 measured at +7.5 KiB gzip here
  // (91,472 -> 99,133 B for the same worker source). Arrow is ~79% of
  // this bundle and `tile.ts` needs the barrel (tableFromIPC, Table,
  // Schema, Struct, Field, Type), so there is no subpath to trim to.
  [/^tile-decoder\.worker-.*\.js$/, 'tile decoder worker', 100],
];
const assetNames = fs.readdirSync(assetsDir);
for (const [pattern, label, maximum] of chunkBudgets) {
  const matches = assetNames.filter((name) => pattern.test(name));
  if (matches.length !== 1) {
    failures.push(
      `${label} expected one emitted chunk, found ${matches.length}`,
    );
    continue;
  }
  check(label, gzipKiB(path.join(assetsDir, matches[0])), maximum);
}

const largest = assetNames
  .filter((name) => name.endsWith('.js'))
  .map((name) => [name, gzipKiB(path.join(assetsDir, name))])
  .sort((a, b) => b[1] - a[1])[0];
check(`largest lazy chunk (${largest[0]})`, largest[1], 1_200);

console.log(
  `\nPerformance budgets\n${report.map((line) => `  ${line}`).join('\n')}`,
);
if (failures.length) {
  console.error(
    `\nBundle budget exceeded:\n${failures.map((x) => `  - ${x}`).join('\n')}`,
  );
  process.exitCode = 1;
}
