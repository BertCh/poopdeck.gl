import { defineConfig } from 'vite';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  server: {
    port: 3000,
  },
  // A single `three` instance must back both r3f's reconciler and the engine's
  // WebGPURenderer — a duplicate copy breaks reconciliation and the renderer.
  // `react`/`react-dom`/r3f must ALSO be deduped: `@poopdeck.gl/three` ships its
  // own react in node_modules, and when its dist is served via `/@fs/` (not
  // pre-bundled) vite would otherwise bind a SECOND React instance → elements
  // created in the three package fail to render in the showcase tree with
  // "Objects are not valid as a React child" (mismatched element `$$typeof`).
  resolve: {
    dedupe: [
      'three',
      'react',
      'react-dom',
      '@react-three/fiber',
      '@react-three/drei',
    ],
  },
  optimizeDeps: {
    include: [
      'maplibre-gl',
      'mapbox-gl',
      // Pin React (and every entry the renderer touches) into the FIRST
      // optimize pass. `@poopdeck.gl/react` is a symlinked workspace package
      // served from its dist as source; its bare `react` import would otherwise
      // be discovered LATE (only when a demo page first mounts usePlayback),
      // triggering a mid-session re-optimize that bumps the browser hash. When
      // that happens, react and react-dom can land in two different optimizer
      // generations (react `?v=A`, react-dom `?v=B`) → two React module
      // instances → the react-dom dispatcher is invisible to the hook's React →
      // "Invalid hook call / Cannot read properties of null (reading
      // 'useState')". Listing them up front keeps react + react-dom in one
      // generation for the whole session.
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      // Pre-bundle the React-consuming linked packages so their `react` import
      // collapses onto the single deduped instance above (dedupe alone is not
      // enough for hooks — it fixes element `$$typeof` identity but not the
      // shared-internals dispatcher). Including `@poopdeck.gl/playback` too so
      // the copy the react package bundles is the SAME one the app imports
      // directly (no duplicate PlaybackGovernor/TimeController class identities).
      '@poopdeck.gl/react',
      '@poopdeck.gl/react/hover-preview',
      '@poopdeck.gl/playback',
    ],
    exclude: ['brotli-wasm'],
    // Vite 8 uses Rolldown for dependency optimization, including the
    // top-level await used by three/webgpu and three/tsl. No legacy esbuild
    // target override is needed.
  },
  build: {
    target: 'esnext',
    // The React Router buildEnd hook copies the deployable subset only after
    // prerendering has finalized build/client.
    copyPublicDir: false,
  },
  assetsInclude: ['**/*.wasm'],
});
