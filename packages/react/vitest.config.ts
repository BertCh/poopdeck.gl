import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    extensions: ['.ts', '.tsx', '.mjs', '.js', '.json'],
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    // Hooks/components mount under jsdom (window, document, KeyboardEvent).
    environment: 'jsdom',
  },
});
