/**
 * Invariant: per-frame render caches live on `this.state`, never in class FIELDS.
 *
 * deck's `_transferState` (core/lib/layer.ts) moves ONLY `state` and
 * `internalState` onto the instance React hands it each render — class-field
 * initializers re-run on that instance. So a field-held cache is silently
 * emptied by the deck-documented idiom
 *
 *     layers={[new AnimatedIconLayer({...})]}   // rebuilt every React render
 *
 * which is how most apps write it. The layers then re-do per frame exactly the
 * work their caches exist to avoid: re-decoding every resident tile, re-packing
 * consolidated buffers, rebuilding glide track indices, re-uploading GPU
 * buffers. `BundledFlowmapLayer` was worse than a perf cliff — its `bundle`
 * field owned 3 textures + 3 framebuffers + 4 compiled Models plus an r32float
 * texture, and `finalizeState` (the only dispose path) never runs on a MATCHED
 * old layer, so each re-instantiation LEAKED a full GPU bundle.
 *
 * `AnimatedTripsLayer` diagnosed and fixed this with `stateSlot`; the fix was
 * then ported to the rest of the family.
 *
 * HOW THIS TEST WORKS: a class field is an OWN property of the instance and
 * never appears on the prototype. An accessor backed by `stateSlot` is a
 * prototype getter. Asserting the prototype descriptor is therefore a direct
 * structural check that the storage moved — it cannot be satisfied by a field.
 */
import { describe, it, expect } from 'vitest';

import { AnimatedTripsLayer } from '../src/layers/trips/animated-trips-layer';
import { AnimatedTripHeadsLayer } from '../src/layers/trips/animated-trip-heads-layer';
import { AnimatedPathLayer } from '../src/layers/core/animated-path-layer';
import { AnimatedIconLayer } from '../src/layers/core/animated-icon-layer';
import { AnimatedTextLayer } from '../src/layers/core/animated-text-layer';
import { H3SummaryLayer } from '../src/layers/summary/h3-summary-layer';
import { QuadbinSummaryLayer } from '../src/layers/summary/quadbin-summary-layer';
import { AnimatedHeatmapLayer } from '../src/layers/summary/heatmap-layer';
import { AnimatedHexagonLayer } from '../src/layers/summary/animated-hexagon-layer';
import { FlowmapLayer } from '../src/layers/summary/flowmap-layer';
import { BundledFlowmapLayer } from '../src/layers/summary/bundled-flowmap-layer';

/** [class, cache member names that must be prototype accessors]. */
const CASES: [string, new (...args: any[]) => unknown, string[]][] = [
  // The layer that established the pattern.
  [
    'AnimatedTripsLayer',
    AnimatedTripsLayer,
    ['preparedTileCache', 'sublayerCache', 'lastTilesRef'],
  ],
  ['AnimatedTripHeadsLayer', AnimatedTripHeadsLayer, ['preparedTileCache']],
  // Ported.
  [
    'AnimatedPathLayer',
    AnimatedPathLayer,
    ['preparedTileCache', 'sublayerCache', 'lastLayerPropsKey', 'lastTilesRef'],
  ],
  [
    'AnimatedIconLayer',
    AnimatedIconLayer,
    [
      'preparedTileCache',
      'sublayerCache',
      'lastLayerPropsKey',
      'lastTilesRef',
      // The glide path allocates the most per frame, so it matters most.
      'interpTrackIndex',
      'interpMaintainer',
      'interpPickRows',
      'interpPosBuf',
    ],
  ],
  [
    'AnimatedTextLayer',
    AnimatedTextLayer,
    [
      'decodedCache',
      'visibleCache',
      'sublayerCache',
      'lastLayerPropsKey',
      'lastTilesRef',
      'lastFrameTime',
    ],
  ],
  [
    'H3SummaryLayer',
    H3SummaryLayer,
    [
      'preparedTileCache',
      'sublayerCache',
      'lastTilesRef',
      'lastPruneKey',
      'lastSubBucketTick',
    ],
  ],
  [
    'QuadbinSummaryLayer',
    QuadbinSummaryLayer,
    [
      'preparedTileCache',
      'sublayerCache',
      'lastTilesRef',
      'lastPruneKey',
      'lastSubBucketTick',
    ],
  ],
  [
    'AnimatedHeatmapLayer',
    AnimatedHeatmapLayer,
    ['_channelCache', '_filterRange', '_filterSoftRange'],
  ],
  ['AnimatedHexagonLayer', AnimatedHexagonLayer, ['_cache', '_windowCache']],
  [
    'FlowmapLayer',
    FlowmapLayer,
    ['geomCache', 'arcCache', 'lastTilesRef', 'nodeTable'],
  ],
  [
    'BundledFlowmapLayer',
    BundledFlowmapLayer,
    // `bundle` is the GPU-owning one — the correctness case, not just perf.
    ['bundle', 'geomCache', 'fallbackCache', 'nodeTable', 'lastTilesRef'],
  ],
];

describe.each(CASES)('%s render caches', (_name, Layer, members) => {
  it.each(members)(
    '`%s` is a prototype accessor, not a class field',
    (member) => {
      const descriptor = Object.getOwnPropertyDescriptor(
        Layer.prototype,
        member,
      );
      // Undefined here means the member is still a class field rather than a
      // prototype accessor, so deck's `_transferState` discards it on every
      // re-instantiation. The parameterized test name names the member.
      expect(descriptor).toBeDefined();
      expect(typeof descriptor!.get).toBe('function');
    },
  );
});

describe('stateSlot storage', () => {
  it('a class field would fail this test (control)', () => {
    // Guards the test itself: prove the assertion above distinguishes the two
    // shapes, so it cannot silently pass if someone reverts a getter to a field.
    class WithField {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      cache = new Map();
    }
    class WithAccessor {
      private bag = { cache: new Map() };
      get cache() {
        return this.bag.cache;
      }
    }
    expect(
      Object.getOwnPropertyDescriptor(WithField.prototype, 'cache'),
    ).toBeUndefined();
    expect(
      Object.getOwnPropertyDescriptor(WithAccessor.prototype, 'cache')?.get,
    ).toBeTypeOf('function');
  });
});
