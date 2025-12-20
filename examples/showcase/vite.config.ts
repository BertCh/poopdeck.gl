import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
  },
  optimizeDeps: {
    include: ['maplibre-gl', 'mapbox-gl'],
    exclude: ['brotli-wasm'],
  },
  build: {
    target: 'esnext',
  },
  assetsInclude: ['**/*.wasm'],
});
