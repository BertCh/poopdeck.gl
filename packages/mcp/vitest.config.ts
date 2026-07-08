import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve .ts first so tests exercise the TypeScript sources directly.
  resolve: {
    extensions: ['.ts', '.mjs', '.js', '.mts', '.cjs', '.json'],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
