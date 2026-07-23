// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * Capability descriptor for the MapLibre GL backend — Phase 5 of
 * docs/roadmap/renderer-abstraction-2026-06.md.
 *
 * This is what the maplibre adapter DECLARES about itself against the shared
 * vocabulary in `@poopdeck.gl/core/capabilities`. It is machine-checked against
 * the package's real exports + a conformance evidence set (see
 * test/backend-descriptor.test.ts and `assertDescriptorConsistent`), so it
 * cannot over-claim: every `supported: true` kind, every `true` capability and
 * every declared time-filter mode must have a passing case behind it.
 *
 * The adapter ships five layer classes (point/line/polygon/trips/heatmap). Every
 * other layer kind degrades to deck.gl (`@poopdeck.gl/layers`); `arc` carries a
 * `line` fallback because an arc is naturally a line in a backend without arc
 * geometry. The adapter interleaves into the basemap's own GL context and
 * projects lon/lat → world on the CPU. Host dispatch (Wave M1) covers maplibre
 * v3–v6 + mapbox v3: on v5+ hosts the layers render via the injected
 * projection prelude — including globe — while ≤v4/mapbox hosts ride the
 * legacy mercator matrix path. Tileset ownership defaults to one archive per
 * layer; an opt-in `SharedTilesetSource` serves N layers from one archive.
 * Only the `window` and `trail` time-filter modes are implemented —
 * `wake`/`cumulative` are NOT — and there is no declared picking yet (the
 * id-FBO scaffold is points-only; descriptor flip rides Wave M2/D11).
 */

import {
  LAYER_KINDS,
  type BackendDescriptor,
  type Capability,
  type LayerKind,
  type LayerKindSupport,
} from '@poopdeck.gl/core/capabilities';

/** The kinds the maplibre adapter actually renders (each backed by an exported class). */
const SUPPORTED_KINDS: readonly LayerKind[] = [
  'point',
  'line',
  'polygon',
  'trips',
  'heatmap',
];

/** Why an unsupported kind degrades — a single, honest referral to the deck backend. */
const DECK_REFERRAL =
  'not implemented in the maplibre adapter; use @poopdeck.gl/layers (deck)';

/**
 * Build the exhaustive `LayerKind → support` record from the frozen `LAYER_KINDS`
 * vocabulary, so a new kind added to core forces a decision here rather than
 * silently defaulting. Supported kinds are `{ supported: true }`; `arc` degrades
 * to `line`; everything else is an unsupported deck referral.
 */
const layerKinds = Object.fromEntries(
  LAYER_KINDS.map((kind): [LayerKind, LayerKindSupport] => {
    if (SUPPORTED_KINDS.includes(kind)) return [kind, { supported: true }];
    if (kind === 'arc') {
      return [
        kind,
        { supported: false, fallbackKind: 'line', reason: DECK_REFERRAL },
      ];
    }
    if (kind === 'text') {
      return [
        kind,
        { supported: false, fallbackKind: 'icon', reason: DECK_REFERRAL },
      ];
    }
    if (kind === 'mesh') {
      return [
        kind,
        {
          supported: false,
          fallbackKind: 'boundingBox',
          reason: DECK_REFERRAL,
        },
      ];
    }
    if (kind === 'pointCloud') {
      return [
        kind,
        { supported: false, fallbackKind: 'point', reason: DECK_REFERRAL },
      ];
    }
    if (kind === 'hexbin') {
      return [
        kind,
        { supported: false, fallbackKind: 'h3Summary', reason: DECK_REFERRAL },
      ];
    }
    return [kind, { supported: false, reason: DECK_REFERRAL }];
  }),
) as Record<LayerKind, LayerKindSupport>;

export const maplibreBackend: BackendDescriptor = {
  id: 'maplibre',
  capabilities: {
    // Requires a v5+ maplibre host: the layers compile the host's injected
    // projection prelude (projectTile*/variantName program cache) so globe
    // and the globe↔mercator transition render natively. Legacy hosts
    // (maplibre ≤v4, mapbox v3) still render mercator via the uMatrix path.
    globe: true,
    picking: false,
    extrude3d: true,
    metricSizing: false,
    gpuHeatmap: true,
    liveBundling: false,
    timeAsHeight: false,
    interleavedBasemap: true,
    userExtensions: false,
    cameraRoll: false,
  } satisfies Record<Capability, boolean>,
  // window + trail only — maplibre has no wake/cumulative.
  timeFilterModes: ['window', 'trail'],
  layerKinds,
  projectsOnCpu: true,
  // DEFAULT ownership. An opt-in shared source (D6a `SharedTilesetSource`,
  // layer option `source`) serves N layers from one archive; this field
  // flips only if/when shared becomes the default path.
  tilesetOwnership: 'per-layer',
  pickMechanism: 'none',
  interleavedBasemap: true,
  // What a ≤v4 host drives; v5+ hosts may present globe (see capabilities.globe).
  basemapProjection: 'mercator',
};
