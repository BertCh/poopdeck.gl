import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    extensions: ['.ts', '.tsx', '.mjs', '.js', '.json'],
  },
  test: {
    // Pure-function tests only (projection, quaternion math, time-filter alpha,
    // color expansion, tile→attribute wiring). No WebGL/WebGPU in CI, so the
    // GPU material + renderer paths are verified by the user in-browser instead
    // — see the `react` package, which likewise left its WebGL HoverPreview
    // untested. Node env: these tests touch only typed arrays + math.
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
