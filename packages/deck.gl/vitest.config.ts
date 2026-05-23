import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The package keeps committed .js build artifacts alongside .ts sources in
  // src/. Resolve .ts FIRST so tests exercise the TypeScript sources, not the
  // stale compiled output.
  resolve: {
    extensions: ['.ts', '.mjs', '.js', '.mts', '.cjs', '.json'],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
