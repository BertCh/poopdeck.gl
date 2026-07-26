/**
 * deck.gl ↔ @poopdeck.gl export-name collision gate.
 *
 * deck.gl is the primary backend, so a real app imports `@deck.gl/*` and
 * `@poopdeck.gl/*` into the SAME module all the time. Any name exported by both
 * therefore cannot be written down: TypeScript rejects the duplicate identifier,
 * and in plain JS whichever import is evaluated last wins. Through 0.5.x
 * `@poopdeck.gl/three` shipped bare `ArcLayer` / `IconLayer` / `TripsLayer` /
 * `ColumnLayer` / `PolygonLayer` / `PointCloudLayer`, `@poopdeck.gl/layers`
 * shipped a `DataFilterExtension` that is a DIFFERENT class from deck's, and
 * `@poopdeck.gl/core` shipped `Layer` and `Position`. The 0.6.0 naming pass
 * moved all of them behind the `STT` prefix.
 *
 * This test is what stops that from silently coming back. It is deliberately
 * STATIC (parse the barrels + deck's shipped `.d.ts`) rather than dynamic:
 * importing `@poopdeck.gl/three` for real drags in `three/webgpu`, and the
 * hazard we care about is a name, which exists at parse time.
 *
 * Any export still carrying a `@deprecated` JSDoc tag on its specifier is
 * EXEMPT from the collision check — the tag is recognised on the export
 * specifier, the only placement TypeScript honours for a re-export. The 0.6.0
 * rename aliases that used to rely on this exemption have all been removed;
 * see the "no 0.5.x name that collided" test below, which asserts they stay
 * gone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const DECK_DIR = path.resolve(HERE, '../node_modules/@deck.gl');

/** Every deck.gl entry point this repo (or a typical consumer) imports. */
const DECK_PACKAGES = [
  'core',
  'layers',
  'aggregation-layers',
  'geo-layers',
  'mesh-layers',
  'extensions',
  'widgets',
  'react',
];

/** Every public entry point of the @poopdeck.gl packages. */
const POOPDECK_BARRELS: Array<[string, string]> = [
  ['@poopdeck.gl/core', 'packages/core/src/index.ts'],
  ['@poopdeck.gl/layers', 'packages/layers/src/index.ts'],
  ['@poopdeck.gl/playback', 'packages/playback/src/index.ts'],
  ['@poopdeck.gl/react', 'packages/react/src/index.ts'],
  ['@poopdeck.gl/three', 'packages/three/src/index.ts'],
  ['@poopdeck.gl/three/internal', 'packages/three/src/internal.ts'],
  ['@poopdeck.gl/three/r3f', 'packages/three/src/r3f/index.tsx'],
  ['@poopdeck.gl/maplibre', 'packages/maplibre/src/index.ts'],
  ['@poopdeck.gl/cesium', 'packages/cesium/src/index.ts'],
];

/**
 * The ONE class of allowed shadow: a name we re-export from deck.gl unchanged,
 * so both packages hand back the identical object and there is nothing to
 * confuse. Each entry is PROVEN below by an identity assertion, not trusted.
 */
const IDENTITY_REEXPORTS: Array<{
  pkg: string;
  name: string;
  deckModule: string;
  ourModule: string;
}> = [
  {
    pkg: '@poopdeck.gl/layers',
    name: 'CollisionFilterExtension',
    deckModule: '@deck.gl/extensions',
    ourModule:
      '../../../packages/layers/src/extensions/collision-filter-extension',
  },
];

const exemptFor = (pkg: string) =>
  new Set(IDENTITY_REEXPORTS.filter((r) => r.pkg === pkg).map((r) => r.name));

interface ExportedName {
  name: string;
  deprecated: boolean;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
}

/** `@deprecated` written directly on the export specifier (`X as Y`). */
function specifierIsDeprecated(
  el: ts.ExportSpecifier,
  src: ts.SourceFile,
): boolean {
  const leading = ts.getLeadingCommentRanges(src.text, el.pos) ?? [];
  return leading.some(
    (r) =>
      src.text.slice(r.pos, r.end).includes('@deprecated') &&
      src.text.slice(r.pos, r.pos + 3) === '/**',
  );
}

function exportedNames(file: string): ExportedName[] {
  const src = parse(file);
  const out: ExportedName[] = [];
  src.forEachChild((node) => {
    if (
      ts.isExportDeclaration(node) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const el of node.exportClause.elements) {
        out.push({
          name: el.name.text,
          deprecated: specifierIsDeprecated(el, src),
        });
      }
      return;
    }
    const exported = ts.canHaveModifiers(node)
      ? ts
          .getModifiers(node)
          ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      : false;
    if (!exported) return;
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name))
          out.push({ name: d.name.text, deprecated: false });
      }
    } else if (
      (ts.isClassDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name
    ) {
      out.push({ name: node.name.text, deprecated: false });
    }
  });
  return out;
}

/** name → the deck packages that export it. */
function deckExportIndex(): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const pkg of DECK_PACKAGES) {
    const dts = path.join(DECK_DIR, pkg, 'dist/index.d.ts');
    if (!existsSync(dts)) continue;
    for (const { name } of exportedNames(dts)) {
      const entry = index.get(name) ?? [];
      entry.push(`@deck.gl/${pkg}`);
      index.set(name, entry);
    }
  }
  return index;
}

const deck = deckExportIndex();

describe('deck.gl export-name collisions', () => {
  it('finds deck.gl on disk with a non-trivial export surface', () => {
    // Guards the whole suite against silently passing because the .d.ts files
    // moved and every lookup missed.
    expect(deck.size).toBeGreaterThan(100);
    expect(deck.get('Layer')).toContain('@deck.gl/core');
    expect(deck.get('ArcLayer')).toContain('@deck.gl/layers');
    expect(deck.get('TripsLayer')).toContain('@deck.gl/geo-layers');
    expect(deck.get('DataFilterExtension')).toContain('@deck.gl/extensions');
  });

  for (const [pkg, rel] of POOPDECK_BARRELS) {
    const file = path.join(REPO, rel);

    it(`${pkg} has no non-deprecated export that shadows a deck.gl name`, () => {
      expect(existsSync(file), `${rel} missing`).toBe(true);
      const exempt = exemptFor(pkg);
      const collisions = exportedNames(file)
        .filter((e) => !e.deprecated && deck.has(e.name) && !exempt.has(e.name))
        .map((e) => `${e.name} (also ${deck.get(e.name)!.join(', ')})`);
      expect(collisions, `${pkg} shadows deck.gl exports`).toEqual([]);
    });
  }

  for (const r of IDENTITY_REEXPORTS) {
    it(`${r.pkg}'s ${r.name} IS deck's class, not a same-named twin`, async () => {
      const [deckMod, ourMod] = await Promise.all([
        import(/* @vite-ignore */ r.deckModule),
        import(/* @vite-ignore */ r.ourModule),
      ]);
      expect(ourMod[r.name]).toBe(deckMod[r.name]);
    });
  }

  it('no 0.5.x name that collided with deck is exported any more', () => {
    // The clean-break half of the contract. These names were renamed to their
    // STT*-prefixed spellings and the transitional aliases have been removed —
    // this guards against any of them being reintroduced and re-shadowing deck.
    const removed: Record<string, string[]> = {
      'packages/three/src/index.ts': [
        'ArcLayer',
        'IconLayer',
        'TripsLayer',
        'ColumnLayer',
        'PolygonLayer',
        'PointCloudLayer',
      ],
      'packages/layers/src/index.ts': [
        'DataFilterExtension',
        'DataFilterExtensionProps',
        'DataFilterExtensionOptions',
      ],
      'packages/core/src/index.ts': ['Layer', 'Position'],
      'packages/maplibre/src/index.ts': [
        'STTMaplibreLayer',
        'STTMaplibreLayerOptions',
      ],
    };
    for (const [rel, names] of Object.entries(removed)) {
      const byName = new Set(
        exportedNames(path.join(REPO, rel)).map((e) => e.name),
      );
      for (const name of names) {
        expect(
          byName.has(name),
          `${rel} still exports the retired name ${name}`,
        ).toBe(false);
      }
    }
  });

  it('every backend spells its layer classes with the shared STT prefix', () => {
    // The consistency half: one layer kind, one spelling, on every backend.
    // deck (`@poopdeck.gl/layers`) is exempt by design — its `Animated*` family
    // names the time-animated variant of a deck layer and never collided.
    const backends = [
      'packages/three/src/index.ts',
      'packages/maplibre/src/index.ts',
      'packages/cesium/src/index.ts',
    ];
    for (const rel of backends) {
      const unprefixed = exportedNames(path.join(REPO, rel))
        .filter(
          (e) =>
            !e.deprecated &&
            e.name.endsWith('Layer') &&
            !e.name.startsWith('STT') &&
            // The layer CONTRACT / base class, not a concrete layer kind.
            !['SttLayer', 'BaseSttLayer'].includes(e.name),
        )
        .map((e) => e.name);
      expect(unprefixed, `${rel} exports unprefixed layer classes`).toEqual([]);
    }
  });
});
