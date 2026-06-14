import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    extensions: ['.ts', '.mjs', '.js', '.json'],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
