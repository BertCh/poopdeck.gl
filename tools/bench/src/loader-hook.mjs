/**
 * ESM resolution hook for the benchmark.
 *
 * `@stt/core` is compiled by `tsc` with extensionless relative imports
 * (e.g. `import './archive'`). Node's strict ESM resolver requires explicit
 * file extensions, so loading the package's `dist/` directly fails with
 * ERR_MODULE_NOT_FOUND.
 *
 * This hook (registered via `module.register` in index.mjs) retries failed
 * specifiers with `.js` / `/index.js` suffixes, WITHOUT modifying the
 * `@stt/core` package.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;

    // Skip specifiers that already carry a JS extension — nothing to fix.
    if (/\.[mc]?js$/.test(specifier)) throw err;

    for (const suffix of ['.js', '/index.js']) {
      try {
        const candidate = await nextResolve(specifier + suffix, context);
        const file = fileURLToPath(candidate.url);
        if (existsSync(file)) return candidate;
      } catch {
        /* try next suffix */
      }
    }
    throw err;
  }
}
