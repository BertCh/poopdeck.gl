// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * User shader extensions — this backend's answer to deck.gl's `LayerExtension`.
 *
 * deck can hand a user a `LayerExtension` because every deck layer is built out
 * of luma shader MODULES with named injection points (`vs:#main-start`,
 * `fs:DECKGL_FILTER_COLOR`, …). This package has no module system: each layer
 * ASSEMBLES its own GLSL ES 1.00 string from shared chunks (see
 * `shaders/time-window.glsl.ts`, `shaders/data-filter.glsl.ts`) and links it
 * itself. The analogue here is therefore the same idea one layer down — a small
 * set of NAMED SEAMS in that assembly, plus a declaration surface for the
 * attributes / uniforms / varyings a user snippet needs, plus one per-draw
 * callback to feed those uniforms.
 *
 * ── The object ──────────────────────────────────────────────────────────────
 * An extension is a PLAIN OBJECT (see {@link STTShaderExtension}); there is no
 * base class to subclass and no lifecycle to implement. Pass a list of them in
 * any supporting layer's options:
 *
 * ```ts
 * const pulse: STTShaderExtension = {
 *   name: 'pulse',
 *   uniforms: 'uniform float uPulse;',
 *   vertex: {
 *     // `sttExtSize` starts at 1.0; the layer multiplies its size by it.
 *     size: '    sttExtSize *= 1.0 + 0.5 * uPulse;',
 *   },
 *   onBeforeDraw: (u, ctx) => u.setFloat('uPulse', Math.sin(ctx.currentTime / 500)),
 * };
 * new STTPointLayer({ …, extensions: [pulse] });
 * ```
 *
 * ── The seams ───────────────────────────────────────────────────────────────
 * | seam | stage | canonical mutable | consumed by |
 * |---|---|---|---|
 * | `position` | vertex | `vec3 sttExtPosition` (tile-mercator) | the layer's projection |
 * | `alpha`    | vertex | `float sttExtAlpha` (starts 1.0)      | `vAlpha` composition |
 * | `size`     | vertex | `float sttExtSize` (starts 1.0)       | the layer's radius/width |
 * | `color`    | fragment | `vec4 sttExtColor`                  | `gl_FragColor` |
 *
 * Everything the layer has already declared is in scope at a seam — the tile's
 * own `aMercator`, `aTime`, `aRadius`, `aColor` and (when the DataFilter is
 * compiled) `aFilterValue`. Most useful extensions need no new attribute at all.
 *
 * ── The three invariants this module exists to enforce ──────────────────────
 * 1. **An extension cannot widen visibility.** The shipped time-filter gate is
 *    composed AFTER the `alpha` seam and multiplies the (clamped) extension
 *    factor: `vAlpha = (<mode alpha>) * clamp(sttExtAlpha, 0.0, 1.0)`, so the
 *    result is always ≤ what the layer would have drawn. The DataFilter body
 *    and the fragment stage's `if (vAlpha <= 0.0) discard;` then run after
 *    that, untouched. In the fragment stage the same rule holds by
 *    construction: the `color` seam writes `sttExtColor`, and the layer's own
 *    gates multiply into the alpha channel afterwards. NO seam is ever spliced
 *    after a gate.
 * 2. **The id/pick program gets the same VERTEX seams.** A `position` seam that
 *    moves geometry moves the pickable shape with it, because the layer builds
 *    both vertex sources from one builder. FRAGMENT seams are deliberately NOT
 *    spliced into the id stage: an id fragment must decode to an exact byte
 *    triple, so nothing user-supplied may touch its colour.
 * 3. **An extension's identity is part of the program-cache key.** Two layers
 *    (or one layer before and after `setExtensions`) with different extensions
 *    compile different source and MUST NOT share a linked program. {@link
 *    ExtensionChunks.key} is the fragment every layer appends to its own cache
 *    key; it is content-addressed (name + a hash of the extension's whole GLSL
 *    contribution), so two extensions that merely share a `name` still get
 *    distinct keys, and an extension object rebuilt each frame from the same
 *    text still hits the same cached program.
 *
 * ── Back-compat ─────────────────────────────────────────────────────────────
 * An empty list produces {@link EMPTY_EXTENSION_CHUNKS}, and every splice
 * helper here returns the layer's ORIGINAL text byte for byte in that case
 * (`spliceExtensionAlpha` returns exactly `    vAlpha = <expr>;`, the position
 * and size splices return `''`). The no-extension shader is not "equivalent",
 * it is IDENTICAL — `test/extensions.test.ts` compares it against a golden.
 *
 * ── What this deliberately does NOT do ──────────────────────────────────────
 * - **It is not a sandbox.** Snippets are pasted into a shader the caller's own
 *   app compiles. A snippet can name any symbol in scope, including `vAlpha`,
 *   and assign to it. Invariant (1) is about SEAM PLACEMENT — no user text runs
 *   after a gate — not about preventing a determined caller from writing
 *   `vAlpha = 1.0;` in their own snippet. It is a hook for the app that owns
 *   the map, not a plugin boundary for untrusted code.
 * - **No GLSL parsing, no cross-compilation.** The text is spliced verbatim.
 *   It must be GLSL ES 1.00 (`attribute`/`varying`, no `in`/`out`), because
 *   that is what this package compiles on every host from one build. A syntax
 *   error surfaces as `STT shader compile failed:` from `linkProgram`, with the
 *   driver's log — which is why every seam block is preceded by a
 *   `// [stt-ext] <name> · <seam>` marker line: it is what makes the driver's
 *   line number point at a named extension.
 * - **No attribute plumbing from tile data.** The layer builds no buffer for an
 *   extension attribute. {@link ExtensionUniformWriter.setAttributeBuffer}
 *   binds a buffer the EXTENSION owns; per-feature data that already lives in
 *   the tile is reachable through the layer's own attributes instead.
 * - **No fragment-stage seam on the id pass, no seam inside a shared kernel.**
 *   The time-window and DataFilter kernels stay byte-identical for every layer
 *   and every extension; an extension composes with them, never inside them.
 * - **No `#define` injection and no varying budget management.** GLSL ES 1.00
 *   guarantees only 8 varying vectors; an extension that declares more than the
 *   host has left gets a link failure, and this module does not count them.
 */

import type { TileId } from '@poopdeck.gl/core';

/**
 * Seams a snippet can be spliced into in the VERTEX stage, in the order they
 * execute. Each names a canonical mutable (see {@link EXTENSION_SEAM_VARS});
 * a snippet reads and writes that variable rather than the layer's own, so one
 * extension works on any layer that adopts the hook.
 *
 * - `position` — runs on the decoded tile-mercator position BEFORE projection,
 *   so it moves the drawn AND the picked geometry.
 * - `alpha` — contributes a 0..1 factor, applied before the shipped gates.
 * - `size` — contributes a multiplier on the layer's point radius / line width,
 *   applied before the DataFilter's size transform.
 */
export type ExtensionVertexSeam = 'position' | 'alpha' | 'size';

/**
 * Seams in the FRAGMENT stage. Only the visual program has any: the id-pick
 * fragment stage must decode to an exact byte triple, so it takes no user text.
 */
export type ExtensionFragmentSeam = 'color';

/** The canonical mutable each seam hands the snippet. */
export const EXTENSION_SEAM_VARS = Object.freeze({
  position: 'sttExtPosition',
  alpha: 'sttExtAlpha',
  size: 'sttExtSize',
  color: 'sttExtColor',
} as const);

/**
 * Facts about the draw a {@link STTShaderExtension.onBeforeDraw} callback is
 * about to feed uniforms for.
 *
 * ⚠️ The object is a per-layer SCRATCH, refilled for every (tile, pass) — read
 * what you need and do not retain it. Times are as the layer sees them:
 * `currentTime` is ABSOLUTE (Unix ms), while `windowStart`/`windowEnd` are
 * TILE-RELATIVE, exactly as the shader's own uniforms are. Add `timeOffset` to
 * a tile-relative time to get an absolute one.
 */
export interface ExtensionDrawContext {
  /** `'draw'` for the visual pass, `'pick'` for the id-FBO pass. */
  pass: 'draw' | 'pick';
  /** The tile being drawn. */
  tileId: TileId;
  /** Absolute play-head time, Unix ms. */
  currentTime: number;
  /** Render-window edges, tile-relative (already offset by `timeOffset`). */
  windowStart: number;
  windowEnd: number;
  /** This tile's time origin: `absolute = relative + timeOffset`. */
  timeOffset: number;
  /** Integer map zoom, as the tileset computes it. */
  zoom: number;
  /** Vertices in this tile's position buffer. */
  vertexCount: number;
}

/**
 * The ONLY handle an extension gets on the GL side.
 *
 * Deliberately narrow: no `gl`, no `WebGLProgram`. Every setter resolves the
 * name against the uniforms/attributes THIS extension declared and ignores
 * (warning once) anything else — so an extension cannot reach the layer's own
 * `uWindowStart`, `uMatrix` or `uFilterRange` and quietly undo a gate it is
 * composed under. Locations are resolved once per program and cached.
 *
 * Vector setters take an array (`[x, y]`, `[r, g, b, a]`, …) and go through
 * `uniform2fv`/`3fv`/`4fv`, so a reused scratch `Float32Array` costs nothing.
 */
export interface ExtensionUniformWriter {
  /** `uniform float` ← value. */
  setFloat(name: string, value: number): void;
  /** `uniform int` / `uniform sampler2D` ← value. */
  setInt(name: string, value: number): void;
  /** `uniform vec2` ← `[x, y]`. */
  setVec2(name: string, value: ArrayLike<number>): void;
  /** `uniform vec3` ← `[x, y, z]`. */
  setVec3(name: string, value: ArrayLike<number>): void;
  /** `uniform vec4` ← `[x, y, z, w]`. */
  setVec4(name: string, value: ArrayLike<number>): void;
  /** `uniform mat4` ← 16 floats, column-major (never transposed: WebGL1). */
  setMatrix4(name: string, value: Float32Array | number[]): void;
  /**
   * Bind a buffer the EXTENSION owns to an attribute the extension DECLARED.
   * The layer allocates nothing for extension attributes and never deletes
   * this buffer — its lifetime is the caller's. Called per tile per pass, so
   * the natural use is a per-tile buffer looked up from `ctx.tileId`.
   *
   * On the visual pass the layer's per-tile VAO is bound, so the binding is
   * recorded there and simply re-recorded next frame; on the pick pass the
   * binding is on the default VAO and the layer disables it again afterwards.
   */
  setAttributeBuffer(
    name: string,
    buffer: WebGLBuffer,
    layout: ExtensionAttributeLayout,
  ): void;
}

/** `vertexAttribPointer` arguments for {@link ExtensionUniformWriter.setAttributeBuffer}. */
export interface ExtensionAttributeLayout {
  /** Components per vertex: 1–4. */
  size: number;
  /** GL type; defaults to `gl.FLOAT`. */
  type?: number;
  /** Normalize integer types into 0..1 / -1..1. Default false. */
  normalized?: boolean;
  /** Byte stride. Default 0 (tightly packed). */
  stride?: number;
  /** Byte offset of the first component. Default 0. */
  offset?: number;
}

/**
 * A user's injection into a shipped layer's shaders.
 *
 * Every field is optional except {@link name} — an extension that only declares
 * a uniform and a `size` snippet is a complete extension. All GLSL is spliced
 * VERBATIM; supply your own indentation (four spaces inside `main()`, two at
 * declaration level, matching the surrounding assembly).
 */
export interface STTShaderExtension {
  /**
   * Stable identity, used in the program-cache key and in the `// [stt-ext]`
   * marker that precedes each spliced block in the compiled source. It does
   * NOT have to be unique — the cache key hashes the GLSL as well — but a
   * descriptive one is what makes a driver's compile log readable.
   */
  name: string;
  /** `attribute` declarations, vertex stage only. */
  attributes?: string;
  /**
   * `uniform` declarations. Spliced into BOTH stages (legal in GLSL ES 1.00 —
   * same name, same type, one program-level location) so one block serves a
   * snippet in either. Names declared here are exactly the names the
   * {@link ExtensionUniformWriter} will accept.
   */
  uniforms?: string;
  /**
   * `varying` declarations, spliced into both stages — how a `position`/`alpha`
   * seam hands a value to a `color` seam. A varying declared for the vertex
   * stage alone is legal: the id program never sees the fragment declarations.
   */
  varyings?: string;
  /** Helper functions / constants for the vertex stage, spliced above `main()`. */
  vertexDeclarations?: string;
  /** Helper functions / constants for the fragment stage, spliced above `main()`. */
  fragmentDeclarations?: string;
  /** Statement blocks by vertex seam. See {@link ExtensionVertexSeam}. */
  vertex?: Partial<Record<ExtensionVertexSeam, string>>;
  /** Statement blocks by fragment seam. See {@link ExtensionFragmentSeam}. */
  fragment?: Partial<Record<ExtensionFragmentSeam, string>>;
  /**
   * Feed this extension's uniforms, once per tile per pass, after the layer has
   * set its own and bound the geometry. Runs for the id-pick pass too
   * (`ctx.pass === 'pick'`) — a `position` seam is compiled into that program,
   * so its uniforms must be there as well or the hit box drifts off the drawn
   * shape.
   */
  onBeforeDraw?(
    uniforms: ExtensionUniformWriter,
    ctx: ExtensionDrawContext,
  ): void;
}

/** One extension, plus what was parsed out of its declarations. */
export interface ComposedExtension {
  readonly ext: STTShaderExtension;
  /** Uniform names it declared — the only names its writer accepts. */
  readonly uniformNames: ReadonlySet<string>;
  /** Attribute names it declared — likewise for `setAttributeBuffer`. */
  readonly attributeNames: ReadonlySet<string>;
}

/**
 * The composed GLSL a layer splices, plus the cache-key fragment it appends.
 * Every string field is `''` when no extension contributed one, which is what
 * keeps the no-extension source byte-identical.
 */
export interface ExtensionChunks {
  /** Vertex-stage `attribute` declarations. */
  readonly attributes: string;
  /** `uniform` declarations for BOTH stages. */
  readonly uniforms: string;
  /** `varying` declarations for BOTH stages. */
  readonly varyings: string;
  /** Vertex-stage helper declarations (above `main()`). */
  readonly vertexDeclarations: string;
  /** Fragment-stage helper declarations (above `main()`). */
  readonly fragmentDeclarations: string;
  /** Statement text per vertex seam, marker comments included. */
  readonly vertexSeams: Readonly<Record<ExtensionVertexSeam, string>>;
  /** Statement text per fragment seam. */
  readonly fragmentSeams: Readonly<Record<ExtensionFragmentSeam, string>>;
  /**
   * Program-cache-key fragment: `''` for an empty list, otherwise
   * `:ext:<name>#<hash>[+…]`. See invariant (3) in the module header.
   */
  readonly key: string;
  /** The composed extensions, in splice order. */
  readonly list: readonly ComposedExtension[];
}

const NO_VERTEX_SEAMS: Readonly<Record<ExtensionVertexSeam, string>> =
  Object.freeze({ position: '', alpha: '', size: '' });

const NO_FRAGMENT_SEAMS: Readonly<Record<ExtensionFragmentSeam, string>> =
  Object.freeze({ color: '' });

/**
 * The no-extension composition. A singleton so the (overwhelmingly common)
 * empty case allocates nothing and can be identity-compared.
 */
export const EMPTY_EXTENSION_CHUNKS: ExtensionChunks = Object.freeze({
  attributes: '',
  uniforms: '',
  varyings: '',
  vertexDeclarations: '',
  fragmentDeclarations: '',
  vertexSeams: NO_VERTEX_SEAMS,
  fragmentSeams: NO_FRAGMENT_SEAMS,
  key: '',
  list: Object.freeze([]) as readonly ComposedExtension[],
});

const VERTEX_SEAMS: readonly ExtensionVertexSeam[] = [
  'position',
  'alpha',
  'size',
];
const FRAGMENT_SEAMS: readonly ExtensionFragmentSeam[] = ['color'];

/** A block, guaranteed to end in exactly one newline; `''` stays `''`. */
function block(text: string | undefined): string {
  if (!text) return '';
  const trimmed = text.replace(/\s+$/, '');
  return trimmed.length === 0 ? '' : `${trimmed}\n`;
}

/**
 * FNV-1a (32-bit) over a string, as lowercase base-36.
 *
 * Only ever used to make a CACHE KEY short: the alternative is keying on the
 * whole contributed source, and that key is string-compared per tile per frame
 * (a layer's VAO staleness check). Paired with the length in
 * {@link extensionSourceDigest} so a collision needs to match both.
 */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // ×16777619 without overflowing the float mantissa.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** Everything about an extension that changes the compiled source. */
function extensionSource(ext: STTShaderExtension): string {
  const parts: string[] = [
    ext.attributes ?? '',
    ext.uniforms ?? '',
    ext.varyings ?? '',
    ext.vertexDeclarations ?? '',
    ext.fragmentDeclarations ?? '',
  ];
  for (const seam of VERTEX_SEAMS) parts.push(ext.vertex?.[seam] ?? '');
  for (const seam of FRAGMENT_SEAMS) parts.push(ext.fragment?.[seam] ?? '');
  return parts.join(' ');
}

/**
 * Content digest of one extension's GLSL contribution: `<hash><length>`, both
 * base-36. Exported for the cache-key tests — two extensions differing by one
 * character must differ here, and two structurally identical ones must not.
 */
export function extensionSourceDigest(ext: STTShaderExtension): string {
  const src = extensionSource(ext);
  return `${fnv1a32(src).toString(36)}${src.length.toString(36)}`;
}

/**
 * Names declared by a `uniform` / `attribute` block.
 *
 * Deliberately a regex, not a parser: it understands the two forms this hook's
 * documentation shows (`uniform float uFoo;`, with an optional precision
 * qualifier, a comma list, and an array suffix) and nothing else. A declaration
 * it cannot read is not an error — the name simply never reaches the allow-list,
 * and the writer refuses it with a named warning rather than silently writing
 * to the wrong location. Keep the declarations plain.
 */
export function parseDeclaredNames(
  glsl: string | undefined,
  keyword: 'uniform' | 'attribute',
): Set<string> {
  const names = new Set<string>();
  if (!glsl) return names;
  // Strip line comments first so a commented-out declaration is not "declared".
  const src = glsl.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const decl = new RegExp(
    `\\b${keyword}\\s+(?:(?:lowp|mediump|highp)\\s+)?[A-Za-z_]\\w*\\s+([^;]+);`,
    'g',
  );
  for (const m of src.matchAll(decl)) {
    for (const entry of m[1]!.split(',')) {
      const name = entry
        .trim()
        .replace(/\[[^\]]*\]$/, '')
        .trim();
      if (/^[A-Za-z_]\w*$/.test(name)) names.add(name);
    }
  }
  return names;
}

/**
 * Compose a list of extensions into the strings a layer splices and the key it
 * appends to its program-cache key.
 *
 * An EMPTY list returns {@link EMPTY_EXTENSION_CHUNKS} — no splices, no key,
 * the shipped shader. A non-empty list of extensions that happen to splice
 * nothing still gets its own key: the key may over-separate (one extra link),
 * because the failure on the other side is a layer drawing with another
 * layer's program.
 *
 * Order is the caller's: extensions are spliced in list order at every seam, so
 * two that both scale `sttExtSize` compose multiplicatively in the order given.
 */
export function composeExtensionChunks(
  extensions: readonly STTShaderExtension[] | undefined,
): ExtensionChunks {
  if (!extensions || extensions.length === 0) return EMPTY_EXTENSION_CHUNKS;

  const list: ComposedExtension[] = [];
  const keys: string[] = [];
  let attributes = '';
  let uniforms = '';
  let varyings = '';
  let vertexDeclarations = '';
  let fragmentDeclarations = '';
  const vertexSeams: Record<ExtensionVertexSeam, string> = {
    position: '',
    alpha: '',
    size: '',
  };
  const fragmentSeams: Record<ExtensionFragmentSeam, string> = { color: '' };

  for (const ext of extensions) {
    const name = ext.name;
    // Marker comments are what makes a driver's compile log point at a named
    // extension rather than at an anonymous line of the assembled shader.
    // Seam markers carry the four-space body indent every seam sits at (all
    // four seams are inside `main()`); declaration markers sit at column 0.
    const mark = (seam: string, indent = '    ') =>
      `${indent}// [stt-ext] ${name} · ${seam}\n`;
    attributes += block(ext.attributes);
    uniforms += block(ext.uniforms);
    varyings += block(ext.varyings);
    const vDecl = block(ext.vertexDeclarations);
    if (vDecl) {
      vertexDeclarations += `${mark('vertex declarations', '')}${vDecl}`;
    }
    const fDecl = block(ext.fragmentDeclarations);
    if (fDecl) {
      fragmentDeclarations += `${mark('fragment declarations', '')}${fDecl}`;
    }
    for (const seam of VERTEX_SEAMS) {
      const body = block(ext.vertex?.[seam]);
      if (body) vertexSeams[seam] += `${mark(seam)}${body}`;
    }
    for (const seam of FRAGMENT_SEAMS) {
      const body = block(ext.fragment?.[seam]);
      if (body) fragmentSeams[seam] += `${mark(seam)}${body}`;
    }
    list.push({
      ext,
      uniformNames: parseDeclaredNames(ext.uniforms, 'uniform'),
      attributeNames: parseDeclaredNames(ext.attributes, 'attribute'),
    });
    keys.push(`${name}#${extensionSourceDigest(ext)}`);
  }

  return Object.freeze({
    attributes,
    uniforms,
    varyings,
    vertexDeclarations,
    fragmentDeclarations,
    vertexSeams: Object.freeze(vertexSeams),
    fragmentSeams: Object.freeze(fragmentSeams),
    // The key covers every extension in ORDER: swapping two extensions swaps
    // their splice order, which is a different program.
    key: `:ext:${keys.join('+')}`,
    list: Object.freeze(list) as readonly ComposedExtension[],
  });
}

/**
 * The `position` seam block, or `''` when nothing was contributed.
 *
 * Emits the canonical `sttExtPosition` around the layer's own position
 * variable, so a snippet written once works on any layer that adopts the seam.
 * Splice it AFTER the position is decoded and BEFORE it is projected — that is
 * what makes a geometry-moving extension move the id-pick shape too.
 */
export function spliceExtensionPosition(
  chunks: ExtensionChunks,
  positionVar: string,
  indent = '    ',
): string {
  const body = chunks.vertexSeams.position;
  if (!body) return '';
  const v = EXTENSION_SEAM_VARS.position;
  return `${indent}vec3 ${v} = ${positionVar};\n${body}${indent}${positionVar} = ${v};\n`;
}

/**
 * The `vAlpha = …;` assignment, with the `alpha` seam composed under the
 * layer's own gate.
 *
 * With no seam this returns EXACTLY `${indent}${alphaVar} = ${modeAlphaExpr};`
 * — the line the layer emitted before this hook existed. With one, the shipped
 * expression is evaluated and multiplied by the CLAMPED extension factor, so
 * the composed alpha can only be ≤ the shipped one (see
 * {@link extensionAlphaJS}), whatever the snippet computes.
 */
export function spliceExtensionAlpha(
  chunks: ExtensionChunks,
  alphaVar: string,
  modeAlphaExpr: string,
  indent = '    ',
): string {
  const body = chunks.vertexSeams.alpha;
  if (!body) return `${indent}${alphaVar} = ${modeAlphaExpr};\n`;
  const v = EXTENSION_SEAM_VARS.alpha;
  return (
    `${indent}float ${v} = 1.0;\n` +
    `${body}` +
    // The shipped gate goes LAST and multiplies: an extension may dim, never
    // reveal. The clamp is what makes that true for any snippet.
    `${indent}${alphaVar} = (${modeAlphaExpr}) * clamp(${v}, 0.0, 1.0);\n`
  );
}

/**
 * The `size` seam block, or `''`. Multiplies the layer's own size variable
 * (radius in px, width in px, …) by the accumulated `sttExtSize` factor.
 *
 * Splice it BEFORE the DataFilter's size transform so a filter-shrunk feature
 * cannot be re-inflated by an extension, and — where the layer has one — after
 * the wake taper, which is part of the shipped look.
 */
export function spliceExtensionSize(
  chunks: ExtensionChunks,
  sizeVar: string,
  indent = '    ',
): string {
  const body = chunks.vertexSeams.size;
  if (!body) return '';
  const v = EXTENSION_SEAM_VARS.size;
  return `${indent}float ${v} = 1.0;\n${body}${indent}${sizeVar} *= ${v};\n`;
}

/**
 * The `gl_FragColor = …;` assignment, with the `color` seam composed under the
 * layer's own alpha gate.
 *
 * With no seam this returns EXACTLY
 * `${indent}gl_FragColor = vec4(${colorExpr}.rgb, ${colorExpr}.a * ${gateExpr});`
 * — again the line the layer emitted before. With one, the snippet gets
 * `sttExtColor` (seeded from `colorExpr`) and the gate multiplies into the
 * alpha channel AFTER it, so an extension colours without un-hiding: the
 * fragment stage's `if (vAlpha <= 0.0) discard;` has already run, and a partly
 * faded feature stays partly faded.
 */
export function spliceExtensionColor(
  chunks: ExtensionChunks,
  colorExpr: string,
  gateExpr: string,
  indent = '    ',
): string {
  const body = chunks.fragmentSeams.color;
  const v = EXTENSION_SEAM_VARS.color;
  if (!body) {
    return `${indent}gl_FragColor = vec4(${colorExpr}.rgb, ${colorExpr}.a * ${gateExpr});\n`;
  }
  return (
    `${indent}vec4 ${v} = ${colorExpr};\n` +
    `${body}` +
    `${indent}gl_FragColor = vec4(${v}.rgb, ${v}.a * ${gateExpr});\n`
  );
}

/**
 * JS reference for the composed vertex alpha — the same relation
 * {@link spliceExtensionAlpha} emits, so a test can assert the "cannot widen"
 * property numerically without a GPU. Mirrors GLSL `clamp`, which is
 * `min(max(x, 0), 1)`.
 */
export function extensionAlphaJS(
  extensionAlpha: number,
  shippedAlpha: number,
): number {
  return shippedAlpha * Math.min(Math.max(extensionAlpha, 0), 1);
}

/**
 * The {@link ExtensionUniformWriter} implementation — one per layer, re-pointed
 * at each (program, extension) instead of allocated per draw.
 *
 * Uniform locations are cached per program (a `WeakMap`, so a program dropped
 * on context loss takes its entry with it) and per name. A name the extension
 * did not declare is refused ONCE with a console warning naming the extension
 * and the name, then silently ignored — the package's `warnCategoricalFilterOnce`
 * policy: a per-frame hot path must never turn a caller's typo into a per-frame
 * console flood or a thrown frame.
 */
export class ExtensionUniformScope implements ExtensionUniformWriter {
  private gl?: WebGLRenderingContext | WebGL2RenderingContext;
  private program?: WebGLProgram;
  private current?: ComposedExtension;
  private readonly uniformLocations = new WeakMap<
    WebGLProgram,
    Map<string, WebGLUniformLocation | null>
  >();
  private readonly attributeLocations = new WeakMap<
    WebGLProgram,
    Map<string, number>
  >();
  /** Attribute locations enabled during the current pass, for cleanup. */
  private readonly enabledAttributes = new Set<number>();
  private readonly warned = new Set<string>();

  /** Point the writer at one extension's uniforms on one linked program. */
  bind(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    program: WebGLProgram,
    ext: ComposedExtension,
  ): this {
    this.gl = gl;
    this.program = program;
    this.current = ext;
    return this;
  }

  /**
   * Drop the GL references once the callbacks have run, so a writer a caller
   * stashed cannot write into a later frame's program.
   */
  release(): void {
    this.gl = undefined;
    this.program = undefined;
    this.current = undefined;
  }

  /**
   * Disable every attribute an extension enabled in this pass. Called by the
   * PICK path, whose binds land on the default VAO and must not leak into the
   * host's state; the visual path records them in the tile's own VAO instead.
   */
  disableAttributes(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    for (const loc of this.enabledAttributes) gl.disableVertexAttribArray(loc);
    this.enabledAttributes.clear();
  }

  private warnOnce(kind: string, name: string): void {
    const key = `${this.current?.ext.name ?? '?'}::${kind}::${name}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(
      `[stt-ext] extension "${this.current?.ext.name ?? '?'}" tried to set ` +
        `${kind} "${name}", which it does not declare. Add it to the ` +
        `extension's \`${kind === 'uniform' ? 'uniforms' : 'attributes'}\` ` +
        `block; an extension may only write its own.`,
    );
  }

  private uniform(name: string): WebGLUniformLocation | null {
    const gl = this.gl;
    const program = this.program;
    const ext = this.current;
    if (!gl || !program || !ext) return null;
    if (!ext.uniformNames.has(name)) {
      this.warnOnce('uniform', name);
      return null;
    }
    let byName = this.uniformLocations.get(program);
    if (!byName) {
      byName = new Map();
      this.uniformLocations.set(program, byName);
    }
    if (byName.has(name)) return byName.get(name)!;
    const loc = gl.getUniformLocation(program, name);
    byName.set(name, loc);
    return loc;
  }

  setFloat(name: string, value: number): void {
    const loc = this.uniform(name);
    if (loc) this.gl!.uniform1f(loc, value);
  }

  setInt(name: string, value: number): void {
    const loc = this.uniform(name);
    if (loc) this.gl!.uniform1i(loc, value);
  }

  setVec2(name: string, value: ArrayLike<number>): void {
    const loc = this.uniform(name);
    if (loc) this.gl!.uniform2fv(loc, value as Float32List);
  }

  setVec3(name: string, value: ArrayLike<number>): void {
    const loc = this.uniform(name);
    if (loc) this.gl!.uniform3fv(loc, value as Float32List);
  }

  setVec4(name: string, value: ArrayLike<number>): void {
    const loc = this.uniform(name);
    if (loc) this.gl!.uniform4fv(loc, value as Float32List);
  }

  setMatrix4(name: string, value: Float32Array | number[]): void {
    const loc = this.uniform(name);
    // `transpose` must be false in WebGL1 — the ES 1.00 spec forbids true.
    if (loc) this.gl!.uniformMatrix4fv(loc, false, value as Float32List);
  }

  setAttributeBuffer(
    name: string,
    buffer: WebGLBuffer,
    layout: ExtensionAttributeLayout,
  ): void {
    const gl = this.gl;
    const program = this.program;
    const ext = this.current;
    if (!gl || !program || !ext) return;
    if (!ext.attributeNames.has(name)) {
      this.warnOnce('attribute', name);
      return;
    }
    let byName = this.attributeLocations.get(program);
    if (!byName) {
      byName = new Map();
      this.attributeLocations.set(program, byName);
    }
    let loc = byName.get(name);
    if (loc === undefined) {
      loc = gl.getAttribLocation(program, name);
      byName.set(name, loc);
    }
    // -1 = the linker stripped it (declared but never read). Not an error.
    if (loc < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(
      loc,
      layout.size,
      layout.type ?? gl.FLOAT,
      layout.normalized ?? false,
      layout.stride ?? 0,
      layout.offset ?? 0,
    );
    this.enabledAttributes.add(loc);
  }
}
