import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Prefer TypeScript sources, matching the other workspace packages.
    extensions: ['.ts', '.mjs', '.js', '.json'],
  },
  test: {
    // Heavy compute suites (fleet-frame decode timing, the full order × gesture
    // × progress render sweep) run close to the 5 s default when `turbo run
    // test` saturates the machine; they take 1-6 s on their own. Vitest 4's
    // forked-child pool makes the crowding sharper than v1's threads did.
    testTimeout: 30_000,
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
