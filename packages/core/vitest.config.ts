import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The committed build artifacts (`src/*.js`) sit next to the `.ts` sources.
  // Force resolution to prefer TypeScript sources so tests exercise the
  // current source, not stale compiled output.
  resolve: {
    extensions: ['.ts', '.mjs', '.js', '.json'],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
