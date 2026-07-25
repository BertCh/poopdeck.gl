/**
 * Docs navigation manifest — the single source of truth for which repo
 * `docs/*.md` files are published on the site, their order, grouping, and
 * display titles. Auto-discovery can't express section grouping or prev/next
 * order, and titles would require eagerly loading every file; the corpus is
 * ~40 files and changes rarely, so an explicit manifest wins.
 *
 * `test/docs-manifest-contract.test.ts` pins this against the content glob:
 * every entry must resolve to a bundled file, and every bundled file must be
 * either listed here or explicitly excluded.
 */

export interface DocEntry {
  /** Route slug under /docs/, mirrors the file path (minus .md). */
  slug: string;
  /** Path relative to the repo docs/ dir. */
  file: string;
  title: string;
  /** One-line description for the docs landing cards. */
  blurb?: string;
  /**
   * Optional sub-group label within a section. Consecutive entries sharing a
   * group render under one small sub-header in the sidebar; ungrouped entries
   * render flat. Grouping is visual only — prev/next order is the flat list.
   */
  group?: string;
  /** 'json' renders the raw file as a highlighted JSON page. */
  kind?: 'markdown' | 'json';
}

export interface DocSection {
  id: string;
  label: string;
  blurb: string;
  entries: DocEntry[];
}

export const GITHUB_BLOB_BASE =
  'https://github.com/BertCh/spatiotemporal-tiles/blob/main/';

export const docSections: DocSection[] = [
  {
    id: 'intro',
    label: 'Introduction',
    blurb:
      'What spatiotemporal tiles are: the packed container, temporal bucketing, temporal LOD, blob ordering, and the streaming render model.',
    entries: [
      {
        slug: 'intro/concepts',
        file: 'intro/concepts.md',
        title: 'Core Concepts',
        blurb: 'Spatiotemporal tiling, temporal LOD, and optimistic rendering.',
      },
      {
        slug: 'intro/choosing',
        file: 'intro/choosing.md',
        title: 'Choosing a Layer & Backend',
        blurb:
          'Which layer fits your data shape, and which renderer backend fits your stack.',
      },
    ],
  },
  {
    id: 'architecture',
    label: 'Architecture',
    blurb:
      'How the Rust build tools and the TypeScript reader + render stack fit together.',
    entries: [
      {
        slug: 'architecture/system-overview',
        file: 'architecture/system-overview.md',
        title: 'System Overview',
        blurb: 'The Rust generation pipeline and the JS reader/render stack.',
      },
      {
        slug: 'architecture/data-format',
        file: 'architecture/data-format.md',
        title: 'Tile Payload Format',
        blurb: 'Normative spec of the Arrow IPC + GeoArrow tile payload.',
      },
      {
        slug: 'architecture/deckgl-integration',
        file: 'architecture/deckgl-integration.md',
        title: 'deck.gl Integration',
        blurb:
          'How @poopdeck.gl/layers relates to TileLayer, and where it deliberately departs.',
      },
    ],
  },
  {
    id: 'spec',
    label: 'Format Spec',
    blurb:
      'The canonical packed container: manifest + content-addressed packs + the v5 directory codec.',
    entries: [
      {
        slug: 'spec/stt-packed-format',
        file: 'spec/stt-packed-format.md',
        title: 'Packed Format',
        blurb: 'manifest.json + content-addressed packs + directory (adopted).',
      },
      {
        slug: 'spec/time-model',
        file: 'spec/time-model.md',
        title: 'Time Model',
        blurb:
          'The temporal axis: buckets, temporal LOD, read-time pruning, OGC TMS mapping.',
      },
      {
        slug: 'spec/sidecar-assets',
        file: 'spec/sidecar-assets.md',
        title: 'Sidecar Assets',
        blurb:
          'Scene bundles, non-tile sidecars, and georeferenced vs anchored-local frames.',
      },
      {
        slug: 'spec/conformance',
        file: 'spec/conformance.md',
        title: 'Conformance',
        blurb:
          'MUST/SHOULD reader & writer requirements, golden fixtures, the reference validator.',
      },
      {
        slug: 'spec/stt-serve-protocol',
        file: 'spec/stt-serve-protocol.md',
        title: 'stt-serve Protocol',
        blurb:
          'HTTP surface of the dynamic tile server: routes, status codes, headers, /metadata.json.',
      },
      {
        slug: 'spec/backend-capabilities',
        file: 'spec/backend-capabilities.md',
        title: 'Backend Capability Matrix',
        blurb:
          'Generated cross-backend table of render traits, capabilities, and time-filter modes.',
      },
      {
        slug: 'spec/manifest-schema',
        file: 'spec/manifest.schema.json',
        title: 'Manifest Schema',
        blurb: 'Machine-checkable JSON Schema for manifest.json.',
        kind: 'json',
      },
    ],
  },
  {
    id: 'layers',
    label: 'deck.gl Layers',
    blurb:
      'Every animated layer on the SpatioTemporalLayer chassis — points, paths, polygons, trips, OD flows, splats, and the server-aggregated summary tiers.',
    entries: [
      {
        slug: 'api/spatiotemporal-layer',
        file: 'api/spatiotemporal-layer.md',
        title: 'SpatioTemporalLayer',
        group: 'Core',
      },
      {
        slug: 'api/animated-point-layer',
        file: 'api/animated-point-layer.md',
        title: 'AnimatedPointLayer',
        group: 'Core',
      },
      {
        slug: 'api/animated-path-layer',
        file: 'api/animated-path-layer.md',
        title: 'AnimatedPathLayer',
        group: 'Core',
      },
      {
        slug: 'api/animated-polygon-layer',
        file: 'api/animated-polygon-layer.md',
        title: 'AnimatedPolygonLayer',
        group: 'Core',
      },
      {
        slug: 'api/animated-column-layer',
        file: 'api/animated-column-layer.md',
        title: 'AnimatedColumnLayer',
        group: 'Core',
      },
      {
        slug: 'api/animated-icon-layer',
        file: 'api/animated-icon-layer.md',
        title: 'AnimatedIconLayer',
        group: 'Core',
      },
      {
        slug: 'api/animated-text-layer',
        file: 'api/animated-text-layer.md',
        title: 'AnimatedTextLayer',
        group: 'Core',
      },
      {
        slug: 'api/animated-bounding-box-layer',
        file: 'api/animated-bounding-box-layer.md',
        title: 'AnimatedBoundingBoxLayer',
        group: 'Core',
      },
      {
        slug: 'api/animated-mesh-layer',
        file: 'api/animated-mesh-layer.md',
        title: 'AnimatedMeshLayer',
        group: 'Core',
      },
      {
        slug: 'api/animated-point-cloud-layer',
        file: 'api/animated-point-cloud-layer.md',
        title: 'AnimatedPointCloudLayer',
        group: 'Core',
      },
      {
        slug: 'api/splat-layer',
        file: 'api/splat-layer.md',
        title: 'SplatLayer',
        group: 'Core',
      },
      {
        slug: 'api/animated-trips-layer',
        file: 'api/animated-trips-layer.md',
        title: 'AnimatedTripsLayer',
        group: 'Trips',
      },
      {
        slug: 'api/animated-trip-heads-layer',
        file: 'api/animated-trip-heads-layer.md',
        title: 'AnimatedTripHeadsLayer',
        group: 'Trips',
      },
      {
        slug: 'api/animated-arc-layer',
        file: 'api/animated-arc-layer.md',
        title: 'AnimatedArcLayer',
        group: 'OD & flow',
      },
      {
        slug: 'api/animated-line-layer',
        file: 'api/animated-line-layer.md',
        title: 'AnimatedLineLayer',
        group: 'OD & flow',
      },
      {
        slug: 'api/flowmap-layer',
        file: 'api/flowmap-layer.md',
        title: 'FlowmapLayer',
        group: 'OD & flow',
      },
      {
        slug: 'api/flow-lines-layer',
        file: 'api/flow-lines-layer.md',
        title: 'FlowLinesLayer',
        group: 'OD & flow',
      },
      {
        slug: 'api/bundled-flowmap-layer',
        file: 'api/bundled-flowmap-layer.md',
        title: 'BundledFlowmapLayer',
        group: 'OD & flow',
      },
      {
        slug: 'api/flow-corridor-layer',
        file: 'api/flow-corridor-layer.md',
        title: 'FlowCorridorLayer',
        group: 'OD & flow',
      },
      {
        slug: 'api/flow-stroke-layer',
        file: 'api/flow-stroke-layer.md',
        title: 'FlowStrokeLayer',
        group: 'OD & flow',
      },
      {
        slug: 'api/heatmap-time-layer',
        file: 'api/heatmap-time-layer.md',
        title: 'AnimatedHeatmapLayer',
        group: 'Summary tiers',
      },
      {
        slug: 'api/animated-hexagon-layer',
        file: 'api/animated-hexagon-layer.md',
        title: 'AnimatedHexagonLayer',
        group: 'Summary tiers',
      },
      {
        slug: 'api/h3-summary-layer',
        file: 'api/h3-summary-layer.md',
        title: 'H3SummaryLayer',
        group: 'Summary tiers',
      },
      {
        slug: 'api/quadbin-summary-layer',
        file: 'api/quadbin-summary-layer.md',
        title: 'QuadbinSummaryLayer',
        group: 'Summary tiers',
      },
    ],
  },
  {
    id: 'extensions',
    label: 'Extensions',
    blurb:
      'GPU layer extensions: temporal filtering, categorical color, marching chevrons, and gaussian splats.',
    entries: [
      {
        slug: 'api/extensions',
        file: 'api/extensions.md',
        title: 'deck.gl Extensions',
        blurb:
          'Which @deck.gl/extensions work as-is on STT layers, the two ported (data-filter, collision), and the three skipped.',
      },
      {
        slug: 'api/data-filter-extension',
        file: 'api/data-filter-extension.md',
        title: 'STTDataFilterExtension',
      },
      {
        slug: 'api/collision-filter-extension',
        file: 'api/collision-filter-extension.md',
        title: 'CollisionFilterExtension',
      },
      {
        slug: 'api/time-filter-extension',
        file: 'api/time-filter-extension.md',
        title: 'TimeFilterExtension',
      },
      {
        slug: 'api/category-color-extension',
        file: 'api/category-color-extension.md',
        title: 'CategoryColorExtension',
      },
      {
        slug: 'api/chevron-flow-extension',
        file: 'api/chevron-flow-extension.md',
        title: 'ChevronFlowExtension',
      },
      {
        slug: 'api/splat-extension',
        file: 'api/splat-extension.md',
        title: 'SplatExtension',
      },
    ],
  },
  {
    id: 'playback',
    label: 'Playback',
    blurb:
      'The animation clock, the buffering governor, the media-element facade, and the React playback hooks + controls.',
    entries: [
      {
        slug: 'api/stt-player',
        file: 'api/stt-player.md',
        title: 'SttPlayer',
      },
      {
        slug: 'api/time-controller',
        file: 'api/time-controller.md',
        title: 'TimeController',
      },
      {
        slug: 'api/playback-governor',
        file: 'api/playback-governor.md',
        title: 'PlaybackGovernor',
      },
      {
        slug: 'api/stt-react',
        file: 'api/stt-react.md',
        title: '@poopdeck.gl/react',
      },
    ],
  },
  {
    id: 'core',
    label: 'Core Reader & Kernel',
    blurb:
      'The @poopdeck.gl/core reader — archive, tileset, decoder, binary features — and the framework-free render kernel.',
    entries: [
      {
        slug: 'api/stt-loader',
        file: 'api/stt-loader.md',
        title: 'Tile Decoding',
      },
      {
        slug: 'api/spatiotemporal-tileset',
        file: 'api/spatiotemporal-tileset.md',
        title: 'SpatiotemporalTileset',
      },
      {
        slug: 'api/binary-features',
        file: 'api/binary-features.md',
        title: 'Binary Features',
      },
      {
        slug: 'api/render-kernel',
        file: 'api/render-kernel.md',
        title: 'Render Kernel',
      },
    ],
  },
  {
    id: 'backends',
    label: 'Renderer Backends',
    blurb:
      'Rendering STT beyond deck.gl: Three.js + TSL, MapLibre custom layers, CesiumJS — and the descriptor contract behind the capability matrix.',
    entries: [
      {
        slug: 'api/stt-three',
        file: 'api/stt-three.md',
        title: '@poopdeck.gl/three',
      },
      {
        slug: 'api/stt-maplibre',
        file: 'api/stt-maplibre.md',
        title: '@poopdeck.gl/maplibre',
      },
      {
        slug: 'api/stt-cesium',
        file: 'api/stt-cesium.md',
        title: '@poopdeck.gl/cesium',
      },
      {
        slug: 'api/backend-descriptor',
        file: 'api/backend-descriptor.md',
        title: 'BackendDescriptor',
      },
    ],
  },
  {
    id: 'cli',
    label: 'CLI',
    blurb:
      'stt-build, stt-generate, stt-optimize, stt-validate and stt-serve — every flag, with examples.',
    entries: [
      {
        slug: 'api/cli-reference',
        file: 'api/cli-reference.md',
        title: 'CLI Reference',
        blurb:
          'stt-build · stt-generate · stt-optimize · stt-validate · stt-serve',
      },
    ],
  },
  {
    id: 'guides',
    label: 'Guides',
    blurb:
      'End-to-end recipes: build the showcase datasets, or bring your own data from Python.',
    entries: [
      {
        slug: 'guides/csv-quickstart',
        file: 'guides/csv-quickstart.md',
        title: 'From CSV to an Animated Map',
        blurb:
          'The fastest onboarding path: CSV → DuckDB → stt-build → deck.gl + React, all on published packages.',
      },
      {
        slug: 'guides/data-generation',
        file: 'guides/data-generation.md',
        title: 'Data Generation',
        blurb: 'Per-dataset build recipes for every showcase archive.',
      },
      {
        slug: 'guides/python',
        file: 'guides/python.md',
        title: 'Building from Python',
        blurb: 'GeoPandas / DuckDB / pyarrow → GeoParquet → stt-build.',
      },
      {
        slug: 'guides/deploying',
        file: 'guides/deploying.md',
        title: 'Deploying a Dataset',
        blurb: 'R2 / S3 / GCS / nginx: cache regimes, CORS, copy-never-delete.',
      },
      {
        slug: 'guides/tuning-tiles',
        file: 'guides/tuning-tiles.md',
        title: 'Tuning Your Tiles',
        blurb:
          'The measure → interpret → decide loop: analyze, --auto, inspect, doctor, diff, style hints.',
      },
      {
        slug: 'guides/export',
        file: 'guides/export.md',
        title: 'Exporting Back to GeoParquet',
        blurb:
          'stt-optimize export: get data back out of a built archive, whole or filtered by bbox and time.',
      },
      {
        slug: 'guides/wasm',
        file: 'guides/wasm.md',
        title: 'The WASM Decoder',
        blurb:
          'Read packed archives from any WASM host: build it, the API surface, and what it does not do yet.',
      },
    ],
  },
  {
    id: 'ai',
    label: 'AI Suite',
    blurb:
      'The agent surface over STT: the @poopdeck.gl/mcp server plus the poopdeck-ai Agent Skills plugin — discover, analyze, compose, build, and debug datasets from an AI assistant.',
    entries: [
      {
        slug: 'guides/ai-suite',
        file: 'guides/ai-suite.md',
        title: 'AI Suite (MCP + Skills)',
        blurb:
          'Give an AI assistant a temporal-native surface over your tiles: install the plugin, the tools + skills, worked flows, and the security model.',
      },
      {
        slug: 'api/stt-mcp',
        file: 'api/stt-mcp.md',
        title: '@poopdeck.gl/mcp',
        blurb:
          'MCP server reference: the stt-mcp command, discovery/analysis/interactive/execution tools, dataset resources, and --allow-cli.',
      },
    ],
  },
];

/**
 * Bundled-but-unrouted files: present in the content glob (or adjacent in
 * docs/) yet deliberately not published. The README is a link hub that
 * duplicates the sidebar.
 */
export const EXCLUDED_DOC_FILES = ['README.md'];

/** Flattened entry order for prev/next navigation. */
export const flatDocEntries: DocEntry[] = docSections.flatMap((s) => s.entries);

const bySlug = new Map(flatDocEntries.map((e) => [e.slug, e]));

export function getDocEntry(slug: string): DocEntry | undefined {
  return bySlug.get(slug);
}

export function getPrevNext(slug: string): {
  prev: DocEntry | undefined;
  next: DocEntry | undefined;
} {
  const i = flatDocEntries.findIndex((e) => e.slug === slug);
  if (i === -1) return { prev: undefined, next: undefined };
  return { prev: flatDocEntries[i - 1], next: flatDocEntries[i + 1] };
}

export function getSectionForSlug(slug: string): DocSection | undefined {
  return docSections.find((s) => s.entries.some((e) => e.slug === slug));
}
