import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Prefer TypeScript sources, matching the other workspace packages.
    // `.tsx` is in the list so a test that imports an app COMPONENT gets the
    // component's own extensionless sibling imports resolved too (docs
    // Markdown → CodeBlock/Mermaid/DocTabs); without it only the entry file
    // could carry an explicit .tsx and its imports failed to resolve.
    extensions: ['.ts', '.tsx', '.mjs', '.js', '.json'],
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
