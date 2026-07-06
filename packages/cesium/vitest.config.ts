import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    extensions: ['.ts', '.mjs', '.js', '.json'],
  },
  test: {
    // Scope discovery to test/ so a stray src/**/*.test.ts is never swept in.
    // Every cesium test is deliberately cesium-free (the `cesium` package can't
    // load under Node), so the default `node` environment is correct.
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
