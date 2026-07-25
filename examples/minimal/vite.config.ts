import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5180 },
  optimizeDeps: {
    // @poopdeck.gl/core spawns its tile-decoder web worker with
    // `new Worker(new URL('./tile-decoder.worker.js', import.meta.url))`.
    // If Vite's dev pre-bundler rewrites these packages into
    // node_modules/.vite/deps/, that relative URL no longer resolves and every
    // tile decode fails with "worker crashed". Excluding them keeps the
    // published dist/ layout intact in dev. (The production `vite build` path
    // handles the worker URL correctly on its own and needs no config.)
    exclude: [
      '@poopdeck.gl/core',
      '@poopdeck.gl/layers',
      '@poopdeck.gl/playback',
      '@poopdeck.gl/react',
    ],
    // Excluding the packages above means Vite discovers their deck.gl imports
    // LATE (in the browser, not in the initial scan) and would serve them
    // unbundled — where deck.gl's CommonJS `earcut` import has no ESM default.
    // Pinning the graph into the first optimize pass avoids that.
    include: [
      '@deck.gl/core',
      '@deck.gl/layers',
      '@deck.gl/react',
      '@deck.gl/extensions',
      '@deck.gl/geo-layers',
      '@deck.gl/aggregation-layers',
      '@deck.gl/mesh-layers',
      '@luma.gl/core',
      '@luma.gl/engine',
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
    ],
  },
});
