/**
 * @stt/bench entry point.
 *
 * `@stt/core`'s compiled `dist/` output uses extensionless relative imports,
 * which Node's strict ESM resolver rejects. We register a small resolution
 * hook (loader-hook.mjs) BEFORE importing anything from `@stt/core`, so the
 * package loads cleanly without modifying it. The actual benchmark lives in
 * `bench.mjs` and is loaded dynamically after the hook is in place.
 *
 * `@stt/core` no longer ships a tile-decoding web-worker pool — tile decoding
 * is now inline/synchronous (Apache Arrow IPC) — so no worker setup is needed.
 *
 * Usage:  node src/index.mjs [path-to.stt]
 */

import { register } from 'node:module';

register(new URL('./loader-hook.mjs', import.meta.url));

await import('./bench.mjs');
