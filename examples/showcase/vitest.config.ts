import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Prefer TypeScript sources, matching the other workspace packages.
    extensions: ['.ts', '.mjs', '.js', '.json'],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
