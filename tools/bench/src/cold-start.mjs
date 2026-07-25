/**
 * Cold-start benchmark entry point — requests / bytes to first frame, measured
 * over real HTTP against a deployed dataset. See `cold-start-bench.mjs` for the
 * measurement itself and `README.md` for what the numbers mean.
 *
 * Same shape as `index.mjs`: `@poopdeck.gl/core`'s compiled `dist/` uses
 * extensionless relative imports, which Node's strict ESM resolver rejects, so
 * the resolution hook is registered BEFORE anything from the package loads.
 *
 * Usage:  node src/cold-start.mjs [dataset ...] [--json] [--verbose]
 *                                 [--repeat N] [--base URL]
 */

import { register } from 'node:module';

register(new URL('./loader-hook.mjs', import.meta.url));

await import('./cold-start-bench.mjs');
