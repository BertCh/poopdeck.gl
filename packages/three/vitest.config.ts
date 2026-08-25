import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    extensions: ['.ts', '.tsx', '.mjs', '.js', '.json'],
  },
  test: {
    // Vitest 4 runs each file in a forked child (v1's default was a worker
    // thread). Under `turbo run test` the packages run in parallel, and the
    // heaviest compute suites here (the 23k-camera selection sweep, the TSL
    // graph walk) sit close to the 5 s default when the machine is saturated.
    // They finish in 1-6 s on their own; the ceiling is contention, not a hang.
    testTimeout: 30_000,
    // Pure-function tests only (projection, quaternion math, time-filter alpha,
    // color expansion, tile→attribute wiring). No WebGL/WebGPU in CI, so the
    // GPU material + renderer paths are verified by the user in-browser instead
    // — see the `react` package, which likewise left its WebGL HoverPreview
    // untested. Node env: these tests touch only typed arrays + math.
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
