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
 * geometry. MapLibre v4 is mercator-only and interleaves into the basemap's own
 * GL context, projecting lon/lat → world on the CPU per layer (one archive per
 * layer, not a shared tileset), with no GPU picking. Only the `window` and
 * `trail` time-filter modes are implemented — `wake`/`cumulative` are NOT.
 */

import {
  LAYER_KINDS,
  type BackendDescriptor,
  type Capability,
  type LayerKind,
  type LayerKindSupport,
} from '@poopdeck.gl/core/capabilities';

/** The kinds the maplibre adapter actually renders (each backed by an exported class). */
const SUPPORTED_KINDS: readonly LayerKind[] = ['point', 'line', 'polygon', 'trips', 'heatmap'];

/** Why an unsupported kind degrades — a single, honest referral to the deck backend. */
const DECK_REFERRAL = 'not implemented in the maplibre adapter; use @poopdeck.gl/layers (deck)';

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
      return [kind, { supported: false, fallbackKind: 'line', reason: DECK_REFERRAL }];
    }
    return [kind, { supported: false, reason: DECK_REFERRAL }];
  }),
) as Record<LayerKind, LayerKindSupport>;

export const maplibreBackend: BackendDescriptor = {
  id: 'maplibre',
  capabilities: {
    globe: false,
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
  tilesetOwnership: 'per-layer',
  pickMechanism: 'none',
  interleavedBasemap: true,
  basemapProjection: 'mercator',
};
