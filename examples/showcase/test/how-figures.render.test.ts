import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';

import BuildIntelligence from '../src/components/how/BuildIntelligence.tsx';
import CoverLookback from '../src/components/how/CoverLookback.tsx';
import DecodePipeline from '../src/components/how/DecodePipeline.tsx';
import PackagesMap from '../src/components/how/PackagesMap.tsx';
import ParityKernel from '../src/components/how/ParityKernel.tsx';
import TileAnatomy from '../src/components/how/TileAnatomy.tsx';
import TrajectoryClipping from '../src/components/how/TrajectoryClipping.tsx';
import PlaybackDiagram from '../src/components/how/PlaybackDiagram.tsx';

/**
 * Render smoke tests for the How-It-Works figures added in the build-time
 * intelligence + consumer-side pass. These are static presentational
 * components, so we only assert they render to SVG/HTML without throwing and
 * carry the load-bearing evidence strings that the prose is built around —
 * enough to catch an import break, a token typo, or a dropped mechanism.
 */

const CASES: { name: string; Comp: React.FC; anchors: string[] }[] = [
  {
    name: 'BuildIntelligence',
    Comp: BuildIntelligence,
    // the no-thinning firewall + the real verbs/rule codes
    anchors: ['no-thinning', 'doctor', 'expensive-feature-ids', 'style_hints'],
  },
  {
    name: 'CoverLookback',
    Comp: CoverLookback,
    anchors: ['cover_t_min', 'look-back', 'time_start'],
  },
  {
    name: 'DecodePipeline',
    Comp: DecodePipeline,
    anchors: ['worker', 'OPFS', 'zero-copy'],
  },
  {
    // the honest parity story: ONE CPU oracle, hand-written dialects except
    // Cesium, held together by conformance tests (docs/api/render-kernel.md)
    name: 'ParityKernel',
    Comp: ParityKernel,
    anchors: ['time-filter', 'conformance', 'hand-written', 'Cesium'],
  },
  {
    name: 'TrajectoryClipping',
    Comp: TrajectoryClipping,
    anchors: ['clip_trajectory', 'border vertex', 'dateline'],
  },
  {
    // the enriched playback section — governor state machine + package seam
    name: 'PlaybackDiagram',
    Comp: PlaybackDiagram,
    anchors: ['BufferSource', 'degraded creep', 'canplaythrough'],
  },
  {
    // the formatVersion-2 frame: sectioned, schema hoisted to manifest.schemas,
    // CORE/PROPS split. `end_time` is OPTIONAL — three required columns, not
    // four (spec §5.2, reserved CORE column order).
    name: 'TileAnatomy',
    Comp: TileAnatomy,
    anchors: [
      'TILE_META',
      'CORE_BATCH',
      'PROPS_BATCH',
      'part_offsets',
      'manifest.capabilities',
    ],
  },
  {
    // five CLIs (stt-bundle joined), and the capability matrix must not drift
    // from docs/spec/backend-capabilities.md. Wrapped: it links into /docs.
    name: 'PackagesMap',
    Comp: () =>
      React.createElement(MemoryRouter, null, React.createElement(PackagesMap)),
    anchors: ['stt-bundle', 'hexbin', 'pointCloud', 'quadbinSummary'],
  },
];

describe('How-It-Works figures render', () => {
  for (const { name, Comp, anchors } of CASES) {
    it(`${name} renders to markup with its key evidence`, () => {
      const html = renderToString(React.createElement(Comp));
      expect(html.length).toBeGreaterThan(200);
      for (const a of anchors) expect(html).toContain(a);
    });
  }
});
