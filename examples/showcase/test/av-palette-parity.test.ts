/**
 * AV palette parity — the renderer half of a cross-language contract.
 *
 * The AV cockpit's palettes exist in two places by necessity: the extractors
 * bake them into `scene.json` and the tiles (Python, in the STT repository),
 * and `datasets.ts` paints the geometry and the legend with them (here). They
 * had already drifted in hue once before anyone noticed, so a guard was written
 * that read BOTH files and asserted they agreed.
 *
 * That guard could not survive the repository split — the two files no longer
 * share a tree. What replaced it: the authority (`av_common.py`) EXPORTS the
 * contract as `docs/spec/av-palettes.json`, gated upstream by
 * `emit_av_palettes.py --check`; this repository vendors that artifact
 * (`.stt-sync.json`, byte-gated by `pnpm stt:check`) and asserts `datasets.ts`
 * against it here. Same invariant, one authored copy, and the contract is now a
 * file a third party building an AV cockpit can read.
 *
 * `datasets.ts` is parsed textually rather than imported: the module pulls in
 * the whole showcase dataset registry (and, transitively, deck layers), and the
 * thing under test is the literal a human edits. The regexes tolerate
 * whitespace, trailing commas, bare/quoted keys, and trailing `//` comments.
 * See docs/roadmap/repo-split-2026-08.md §4.3.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SHOWCASE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const REPO_ROOT = path.resolve(SHOWCASE_ROOT, '..', '..');

type Rgba = [number, number, number, number];

interface AvPalettes {
  version: number;
  valueLocked: Record<string, Record<string, Rgba>>;
  keySets: Record<string, string[]>;
  tsOnlyKeys: Record<string, string[]>;
}

const contract: AvPalettes = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'docs/spec/av-palettes.json'), 'utf8'),
);
const datasetsTs = readFileSync(
  path.join(SHOWCASE_ROOT, 'src/datasets.ts'),
  'utf8',
);

/** The body of a `const <name> ... = { … };` block. */
function constBody(name: string): string {
  const m = new RegExp(
    String.raw`const\s+${name}\b[^=]*=\s*\{([\s\S]*?)\};`,
  ).exec(datasetsTs);
  if (!m) throw new Error(`could not locate \`const ${name}\` in datasets.ts`);
  return m[1];
}

/** `key: [r, g, b, a]` entries, in source order. */
function parsePalette(name: string): Map<string, Rgba> {
  const entry =
    /(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,?\s*\]/g;
  const out = new Map<string, Rgba>();
  for (const m of constBody(name).matchAll(entry)) {
    const key = m[1] ?? m[2] ?? m[3];
    out.set(key, [Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7])]);
  }
  if (out.size === 0) {
    throw new Error(`parsed zero entries from \`${name}\` — format drift?`);
  }
  return out;
}

/** `{ color: '#rrggbb', label: '…' }` items, in source order. */
function parseLegend(name: string): { hex: string; label: string }[] {
  const item =
    /\{\s*color:\s*['"](#[0-9a-fA-F]{6})['"]\s*,\s*label:\s*['"]([^'"]+)['"]\s*,?\s*\}/g;
  const items = [...constBody(name).matchAll(item)].map((m) => ({
    hex: m[1].toLowerCase(),
    label: m[2],
  }));
  if (items.length === 0) {
    throw new Error(
      `parsed zero legend items from \`${name}\` — format drift?`,
    );
  }
  return items;
}

const hexOf = ([r, g, b]: Rgba) =>
  `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;

describe('AV palettes match the upstream contract', () => {
  it('vendors a contract this test understands', () => {
    expect(contract.version).toBe(1);
  });

  const valueLocked: [string, string][] = [
    ['OBJECT_COLORS', 'AV_OBJECT_COLORS'],
    ['LIDARSEG_COLORS', 'AV_LIDARSEG_COLORS'],
    ['HEIGHT_BAND_COLORS', 'AV_HEIGHT_BAND_COLORS'],
  ];

  for (const [upstreamName, tsName] of valueLocked) {
    it(`${tsName} has the same keys as ${upstreamName}`, () => {
      const allowed = new Set(contract.tsOnlyKeys[upstreamName] ?? []);
      const want = Object.keys(contract.valueLocked[upstreamName]);
      const have = [...parsePalette(tsName).keys()];
      // Documented renderer-only extras (the synthetic `ego` track colour) are
      // permitted; anything else in either direction is drift.
      expect(have.filter((k) => !allowed.has(k)).sort()).toEqual(want.sort());
    });

    it(`${tsName} has the same RGBA as ${upstreamName}`, () => {
      const ts = parsePalette(tsName);
      for (const [key, rgba] of Object.entries(
        contract.valueLocked[upstreamName],
      )) {
        expect(ts.get(key), `${tsName}.${key}`).toEqual(rgba);
      }
    });
  }

  it('AV_MAP_COLORS covers exactly the valid map_layer names', () => {
    // Key-only: the colours live here alone, but the NAME set is what the
    // extractors emit into the `map_layer` column and must be honoured in full.
    expect([...parsePalette('AV_MAP_COLORS').keys()].sort()).toEqual(
      [...contract.keySets.MAP_LAYERS].sort(),
    );
  });

  it('AV_ISO_DENSITY_COLORS is keyed in band order', () => {
    // Ordered on purpose: band order is ramp order.
    expect([...parsePalette('AV_ISO_DENSITY_COLORS').keys()]).toEqual(
      contract.keySets.ISO_DENSITY_BANDS,
    );
  });
});

describe('AV legends are derived from the palettes they label', () => {
  // Purely local, and the third hand-copy layer that had already drifted
  // (#28a8a8 vs #26a8a8): a legend swatch is a hex restatement of an RGBA that
  // lives a few lines above it, so nothing but a test keeps the two equal.
  it('AV_ISO_DENSITY_LEGEND is the density ramp, in order', () => {
    const ramp = [...parsePalette('AV_ISO_DENSITY_COLORS').values()].map(hexOf);
    expect(parseLegend('AV_ISO_DENSITY_LEGEND').map((i) => i.hex)).toEqual(
      ramp,
    );
  });

  it('every AV_HEIGHT_BAND_LEGEND swatch is a height-band colour', () => {
    // Membership, not order: the legend labels a SUBSET of the eight bands.
    const valid = new Set(
      [...parsePalette('AV_HEIGHT_BAND_COLORS').values()].map(hexOf),
    );
    const drifted = parseLegend('AV_HEIGHT_BAND_LEGEND').filter(
      (i) => !valid.has(i.hex),
    );
    expect(drifted).toEqual([]);
  });
});
