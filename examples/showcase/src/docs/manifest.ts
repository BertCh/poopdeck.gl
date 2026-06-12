/**
 * Docs navigation manifest — the single source of truth for which repo
 * `docs/*.md` files are published on the site, their order, grouping, and
 * display titles. Auto-discovery can't express section grouping or prev/next
 * order, and titles would require eagerly loading every file; the corpus is
 * ~20 files and changes rarely, so an explicit manifest wins.
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
  /** 'json' renders the raw file as a highlighted JSON page. */
  kind?: "markdown" | "json";
}

export interface DocSection {
  id: string;
  label: string;
  blurb: string;
  entries: DocEntry[];
}

export const GITHUB_BLOB_BASE =
  "https://github.com/BertCh/spatiotemporal-tiles/blob/master/";

export const docSections: DocSection[] = [
  {
    id: "intro",
    label: "Introduction",
    blurb:
      "What spatiotemporal tiles are: the packed container, temporal bucketing, temporal LOD, blob ordering, and the streaming render model.",
    entries: [
      {
        slug: "intro/concepts",
        file: "intro/concepts.md",
        title: "Core Concepts",
        blurb: "Spatiotemporal tiling, temporal LOD, and optimistic rendering.",
      },
    ],
  },
  {
    id: "architecture",
    label: "Architecture",
    blurb:
      "How the Rust build tools and the TypeScript reader + render stack fit together.",
    entries: [
      {
        slug: "architecture/system-overview",
        file: "architecture/system-overview.md",
        title: "System Overview",
        blurb: "The Rust generation pipeline and the JS reader/render stack.",
      },
      {
        slug: "architecture/data-format",
        file: "architecture/data-format.md",
        title: "Tile Payload Format",
        blurb: "Normative spec of the Arrow IPC + GeoArrow tile payload.",
      },
      {
        slug: "architecture/deckgl-integration",
        file: "architecture/deckgl-integration.md",
        title: "deck.gl Integration",
        blurb:
          "How @stt/deck.gl relates to TileLayer, and where it deliberately departs.",
      },
    ],
  },
  {
    id: "spec",
    label: "Format Spec",
    blurb:
      "The canonical packed container: manifest + content-addressed packs + the v5 directory codec.",
    entries: [
      {
        slug: "spec/stt-packed-format",
        file: "spec/stt-packed-format.md",
        title: "Packed Format",
        blurb: "manifest.json + content-addressed packs + directory (adopted).",
      },
      {
        slug: "spec/manifest-schema",
        file: "spec/manifest.schema.json",
        title: "Manifest Schema",
        blurb: "Machine-checkable JSON Schema for manifest.json.",
        kind: "json",
      },
    ],
  },
  {
    id: "api",
    label: "JS API",
    blurb:
      "deck.gl layers and extensions, the playback clock, and the @stt/core reader.",
    entries: [
      {
        slug: "api/spatiotemporal-layer",
        file: "api/spatiotemporal-layer.md",
        title: "SpatioTemporalLayer",
      },
      {
        slug: "api/animated-point-layer",
        file: "api/animated-point-layer.md",
        title: "AnimatedPointLayer",
      },
      {
        slug: "api/animated-path-layer",
        file: "api/animated-path-layer.md",
        title: "AnimatedPathLayer",
      },
      {
        slug: "api/animated-polygon-layer",
        file: "api/animated-polygon-layer.md",
        title: "AnimatedPolygonLayer",
      },
      {
        slug: "api/animated-trips-layer",
        file: "api/animated-trips-layer.md",
        title: "AnimatedTripsLayer",
      },
      {
        slug: "api/animated-trip-heads-layer",
        file: "api/animated-trip-heads-layer.md",
        title: "AnimatedTripHeadsLayer",
      },
      {
        slug: "api/heatmap-time-layer",
        file: "api/heatmap-time-layer.md",
        title: "AnimatedHeatmapLayer",
      },
      {
        slug: "api/h3-summary-layer",
        file: "api/h3-summary-layer.md",
        title: "H3SummaryLayer",
      },
      {
        slug: "api/quadbin-summary-layer",
        file: "api/quadbin-summary-layer.md",
        title: "QuadbinSummaryLayer",
      },
      {
        slug: "api/flowmap-layer",
        file: "api/flowmap-layer.md",
        title: "FlowmapLayer",
      },
      {
        slug: "api/animated-arc-layer",
        file: "api/animated-arc-layer.md",
        title: "AnimatedArcLayer",
      },
      {
        slug: "api/animated-line-layer",
        file: "api/animated-line-layer.md",
        title: "AnimatedLineLayer",
      },
      {
        slug: "api/animated-icon-layer",
        file: "api/animated-icon-layer.md",
        title: "AnimatedIconLayer",
      },
      {
        slug: "api/animated-column-layer",
        file: "api/animated-column-layer.md",
        title: "AnimatedColumnLayer",
      },
      {
        slug: "api/time-filter-extension",
        file: "api/time-filter-extension.md",
        title: "TimeFilterExtension",
      },
      {
        slug: "api/category-color-extension",
        file: "api/category-color-extension.md",
        title: "CategoryColorExtension",
      },
      {
        slug: "api/stt-player",
        file: "api/stt-player.md",
        title: "SttPlayer",
      },
      {
        slug: "api/time-controller",
        file: "api/time-controller.md",
        title: "TimeController",
      },
      {
        slug: "api/playback-governor",
        file: "api/playback-governor.md",
        title: "PlaybackGovernor",
      },
      {
        slug: "api/stt-loader",
        file: "api/stt-loader.md",
        title: "Tile Decoding",
      },
      {
        slug: "api/spatiotemporal-tileset",
        file: "api/spatiotemporal-tileset.md",
        title: "SpatiotemporalTileset",
      },
      {
        slug: "api/binary-features",
        file: "api/binary-features.md",
        title: "Binary Features",
      },
      {
        slug: "api/stt-maplibre",
        file: "api/stt-maplibre.md",
        title: "@stt/maplibre",
      },
    ],
  },
  {
    id: "cli",
    label: "CLI",
    blurb:
      "stt-build, stt-generate, stt-optimize and stt-validate — every flag, with examples.",
    entries: [
      {
        slug: "api/cli-reference",
        file: "api/cli-reference.md",
        title: "CLI Reference",
        blurb: "stt-build · stt-generate · stt-optimize · stt-validate",
      },
    ],
  },
  {
    id: "guides",
    label: "Guides",
    blurb:
      "End-to-end recipes: build the showcase datasets, or bring your own data from Python.",
    entries: [
      {
        slug: "guides/data-generation",
        file: "guides/data-generation.md",
        title: "Data Generation",
        blurb: "Per-dataset build recipes for every showcase archive.",
      },
      {
        slug: "guides/python",
        file: "guides/python.md",
        title: "Building from Python",
        blurb: "GeoPandas / DuckDB / pyarrow → GeoParquet → stt-build.",
      },
    ],
  },
];

/**
 * Bundled-but-unrouted files: present in the content glob (or adjacent in
 * docs/) yet deliberately not published. The README is a link hub that
 * duplicates the sidebar.
 */
export const EXCLUDED_DOC_FILES = ["README.md"];

/** Flattened entry order for prev/next navigation. */
export const flatDocEntries: DocEntry[] = docSections.flatMap(
  (s) => s.entries,
);

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
