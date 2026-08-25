import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The package keeps committed .js build artifacts alongside .ts sources in
  // src/. Resolve .ts FIRST so tests exercise the TypeScript sources, not the
  // stale compiled output.
  resolve: {
    extensions: ['.ts', '.mjs', '.js', '.mts', '.cjs', '.json'],
  },
  test: {
    // Vitest 4 runs each file in a forked child (v1's default was a worker
    // thread). Under `turbo run test` the packages run in parallel, and the
    // heaviest compute suites here (the 23k-camera selection sweep, the TSL
    // graph walk) sit close to the 5 s default when the machine is saturated.
    // They finish in 1-6 s on their own; the ceiling is contention, not a hang.
    testTimeout: 30_000,
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
