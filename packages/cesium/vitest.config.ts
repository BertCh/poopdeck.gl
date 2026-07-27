import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    extensions: ['.ts', '.mjs', '.js', '.json'],
  },
  test: {
    // Scope discovery to test/ so a stray src/**/*.test.ts is never swept in.
    //
    // `node` (not jsdom) is correct even though `camera-apply.test.ts` imports
    // real `@cesium/engine`: cesium's ESM entry is plain source whose maths and
    // Scene/Camera modules touch no browser globals, and `Camera` needs only a
    // handful of plain fields off `Scene` (see that file's `makeCamera`). Only
    // an actual `Scene` wants WebGL. The earlier note here — "the `cesium`
    // package can't load under Node" — was untested folklore, and it is what
    // pushed the camera-placement guard into hand-rolled algebra that turned out
    // to be a tautology.
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
