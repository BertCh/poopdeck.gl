// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `STTMaterialExtension` — the user-extension seam for this backend's TSL
 * materials, the Three analogue of deck.gl's `LayerExtension`.
 *
 * ── WHAT IT IS ────────────────────────────────────────────────────────────────
 * A plain object with four OPTIONAL node-graph hooks, each of which receives the
 * node the shipped material is about to use and returns a node to use instead:
 *
 *   | seam       | stage    | receives                                   |
 *   |------------|----------|--------------------------------------------|
 *   | `position` | vertex   | the primitive's UNGATED model-space position |
 *   | `size`     | vertex   | the primitive's UNGATED scalar size / scale  |
 *   | `color`    | fragment | the final **sRGB** rgb `vec3`, pre-conversion |
 *   | `alpha`    | fragment | the material's base alpha, pre-gate           |
 *
 * plus two declarations — {@link STTMaterialExtension.attributes} and
 * {@link STTMaterialExtension.uniforms} — through which an extension brings its
 * OWN per-feature data and its own live scalars, reached inside a hook as
 * `ctx.attribute(name)` / `ctx.uniform(name)`.
 *
 * That is the whole contract. It is deliberately much smaller than deck's
 * `LayerExtension` (no `getShaders`, no `initializeState`, no `defaultProps`
 * merge, no sublayer prop copying): TSL is a node graph, not a string-injected
 * GLSL program, so "inject a chunk at a named `#define`" has no analogue here.
 * Composing a node at a named seam is the whole of it.
 *
 * ── WHY THE SEAMS ARE WHERE THEY ARE (the gates always win) ───────────────────
 * The single hard requirement is that a user extension can never break the
 * shipped time-filter or data-filter gates. That is guaranteed STRUCTURALLY, not
 * by convention: every hook runs on the PRE-GATE value and the material applies
 * its gates to the hook's result.
 *
 *   • vertex `size`  — the material writes `hooks.size(rawSize).mul(visible)`.
 *     `visible` is the hard `0|1` product of {@link timeFilterVisibleNode} and
 *     {@link dataFilterVisibleNode}; multiplying it in LAST means an out-of-window
 *     or out-of-range primitive still collapses to zero extent no matter what the
 *     extension returned — including a constant.
 *   • vertex `position` — for the kinds that collapse by scaling an offset (column,
 *     polygon) the composition helpers {@link MaterialHooks.offsetPosition} and
 *     {@link MaterialHooks.scaledPosition} re-apply the gate AFTER the hook, so a
 *     gated primitive still degenerates to its anchor / to the local origin even if
 *     the extension re-expanded it. A `position` hook can move a primitive; it
 *     cannot resurrect one the gates killed.
 *   • fragment `alpha` — the material writes
 *     `hooks.alpha(baseAlpha).mul(fragAlpha)…`; the soft time / filter ramps
 *     multiply in after the hook, so an extension can only ever make a feature
 *     MORE transparent than the gates allow, never less.
 *   • fragment `color` — colour carries no gate, so there is nothing to protect;
 *     the seam sits just inside {@link srgbToWorking} so an extension works in the
 *     same sRGB space every shipped colour term (tint, atlas sample, column shade)
 *     is authored in. See `./color-space.ts` for why converting last matters.
 *
 * ── THE `varying()` RULE AT THE HOOK BOUNDARY ────────────────────────────────
 * This package's recurring WGSL crash is a `select()` wrapped in a `varying()`
 * (see `time-filter.ts`, `point-material.ts`, `surfel-material.ts`). The shipped
 * alpha builders ARE `select()`-based, so:
 *
 *   **A fragment-stage hook must never call `varying()` — not on the node it is
 *   given, and not on anything derived from it.**
 *
 * Two things enforce that rather than just asking for it:
 *   1. `ctx.attribute(name)` in a fragment seam hands back an ALREADY-VARIED node
 *      (a `varying()` around the raw attribute, which is varying-safe and is
 *      memoised so repeated reads share one varying). An extension therefore
 *      never has a reason to reach for `varying()` itself.
 *   2. {@link assertVaryingSafe} walks the graph a hook returned and THROWS if any
 *      `VaryingNode` has a conditional in its subtree. It runs at material-build
 *      time only (once per material, never per frame) and only when at least one
 *      extension is composed, so the shipped path pays nothing.
 *
 * ── EMPTY LIST ⇒ BYTE-IDENTICAL ──────────────────────────────────────────────
 * {@link resolveExtensions} returns the shared {@link NO_EXTENSIONS} singleton
 * when nothing is registered or passed, and {@link extensionHooks} then returns
 * the shared identity hooks. Every hook is `(n) => n` returning the SAME node
 * object, and the composition helpers fall back to the material's original
 * expression verbatim (`anchor.add(offset.mul(gate))`, `pos.mul(gate)`), so the
 * emitted node graph, the uniform set and the bundle keys are exactly what they
 * were before this module existed. `test/extensions.test.ts` proves that with a
 * structural graph signature, not by inspection.
 *
 * ── ID MATERIALS ─────────────────────────────────────────────────────────────
 * Every wired `create<Kind>IdMaterial` composes the SAME `position`, `size` and
 * `alpha` seams as its colour sibling, because an extension that moves or resizes
 * geometry would otherwise make picking disagree with what is drawn. The `color`
 * seam is the one deliberate exception: the id pass writes a flat 24-bit index
 * that must decode bit-exact, so `extensionHooks(…, {pass: 'id'})` returns an
 * identity `color` hook and the id materials never call it. `ctx.pass` tells an
 * extension which pass it is being composed into.
 *
 * In the id pass the `alpha` seam receives `float(1)` (the id is opaque) and its
 * result is thresholded against the material's `alphaCutoff` and AND-ed into the
 * hard pick gate. So an extension that MASKS a feature to zero alpha makes it
 * unpickable — matching the eye — while one that merely dims it leaves it
 * pickable, matching the shipped soft-fade posture.
 *
 * ── HOW A USER REACHES A SHIPPED LAYER ───────────────────────────────────────
 * Two doors, both real:
 *   • `create<Kind>Material({ …, extensions: [ext] })` — the direct seam, for
 *     code that builds its own material (or its own layer).
 *   • {@link registerSTTExtension}`(kind, ext)` — a by-kind registry every wired
 *     factory consults. The shipped layer classes construct their own materials
 *     from their own options and do NOT forward an `extensions` option (wiring a
 *     prop through `src/layers/*` is a separate change), so the registry is the
 *     only way to reach a SHIPPED layer's material today. It applies to materials
 *     built AFTER registration; layers cache their material bundle for their
 *     lifetime (the E5 churn rule), so register before mounting.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────
 *  • It does NOT bind your attribute buffers. `attributes` declares what the node
 *    graph READS; the host must still
 *    `geometry.setAttribute(name, new InstancedBufferAttribute(data, itemSize))`
 *    on the layer's live geometry, in the layer's merged draw order. An unbound
 *    attribute reads ZEROS silently — the same hazard every `stt*` attribute has.
 *    {@link ResolvedExtensions.attributes} enumerates what to bind.
 *  • It does NOT let an extension add a render pass, swap the material class,
 *    change blending / depth state, add a sublayer, or run CPU code per frame.
 *    Those are layer concerns, not material-graph concerns.
 *  • It does NOT reach every material. Only the kinds in
 *    {@link STT_MATERIAL_KINDS} are wired, with the per-kind seams in
 *    {@link MATERIAL_SEAM_MATRIX}; a hook for a seam a kind does not expose is
 *    silently unused, which is why the matrix is published and tested rather than
 *    left implicit.
 *  • It is NOT browser-verified. As everywhere in this package, the node graphs
 *    are built and introspected in Node; nothing here has been compiled to WGSL
 *    on a real device.
 */

import { Vector2, Vector3, Vector4 } from 'three';
import {
  attribute,
  uniform,
  varying,
  type TSLNode,
  type UniformNode,
} from './nodes.js';
import { GLIDE_ATTR } from './motion-glide.js';
import type { TimeFilterUniforms } from './time-filter.js';

// ── Vocabulary ────────────────────────────────────────────────────────────────

/**
 * The material kinds that CALL the extension seams. A closed union on purpose:
 * wiring a new material means widening this list, and `MATERIAL_SEAM_MATRIX`
 * then requires you to declare which seams it actually exposes.
 */
export const STT_MATERIAL_KINDS = [
  'point',
  'icon',
  'column',
  'polygon',
] as const;
export type STTMaterialKind = (typeof STT_MATERIAL_KINDS)[number];

/** The named seams a material composes an extension at. */
export const MATERIAL_SEAMS = ['position', 'size', 'color', 'alpha'] as const;
export type STTMaterialSeam = (typeof MATERIAL_SEAMS)[number];

/** Which shader stage each seam runs in (drives `ctx.attribute` varying-safety). */
export const SEAM_STAGE: Readonly<Record<STTMaterialSeam, STTShaderStage>> = {
  position: 'vertex',
  size: 'vertex',
  color: 'fragment',
  alpha: 'fragment',
};

export type STTShaderStage = 'vertex' | 'fragment';

/** Colour pass vs the GPU id-buffer pick pass. */
export type STTMaterialPass = 'color' | 'id';

/**
 * The seams each wired kind actually exposes. `polygon` has no scalar size (its
 * extent is the merged mesh itself, and its collapse scales about the local
 * origin), so a `size` hook is a no-op there — declared here rather than
 * discovered at runtime. `test/extensions.test.ts` pins this table to the real
 * wiring by building each material with a single-seam extension and checking
 * whether the graph moved.
 */
export const MATERIAL_SEAM_MATRIX: Readonly<
  Record<STTMaterialKind, readonly STTMaterialSeam[]>
> = {
  point: ['position', 'size', 'color', 'alpha'],
  icon: ['position', 'size', 'color', 'alpha'],
  column: ['position', 'size', 'color', 'alpha'],
  polygon: ['position', 'color', 'alpha'],
};

/** The TSL types an extension attribute may declare. */
export type STTExtensionAttributeType = 'float' | 'vec2' | 'vec3' | 'vec4';

/** Item counts per attribute type — what the host must bind. */
export const ATTRIBUTE_ITEM_SIZE: Readonly<
  Record<STTExtensionAttributeType, 1 | 2 | 3 | 4>
> = { float: 1, vec2: 2, vec3: 3, vec4: 4 };

/** One per-feature buffer an extension reads. The HOST binds it (see header). */
export interface STTExtensionAttribute {
  /** GPU attribute name; must match `geometry.setAttribute` EXACTLY. */
  readonly name: string;
  readonly type: STTExtensionAttributeType;
}

/** One live scalar/vector an extension reads, with its initial value. */
export interface STTExtensionUniform {
  /** Local name; addressed globally as `"<extensionName>.<name>"`. */
  readonly name: string;
  /** `number` → float; length-2/3/4 array → vec2/vec3/vec4. */
  readonly value: number | readonly number[];
}

/**
 * Everything a hook is handed besides the node it is transforming. Built fresh
 * per (extension, seam) at material-build time; never live per frame.
 */
export interface STTExtensionContext {
  /** Which material is composing this hook. */
  readonly kind: STTMaterialKind;
  /** `'color'` for the on-screen material, `'id'` for the pick material. */
  readonly pass: STTMaterialPass;
  /** The seam being composed. */
  readonly seam: STTMaterialSeam;
  /** Shader stage of {@link seam} — `SEAM_STAGE[seam]`. */
  readonly stage: STTShaderStage;
  /**
   * The material's live playhead uniforms, read-only by convention — an extension
   * may READ `time.currentTime` to animate, and must not reassign `.value` (the
   * layer owns that push, once per frame).
   */
  readonly time: TimeFilterUniforms;
  /**
   * One of this extension's declared {@link STTMaterialExtension.attributes}, as a
   * node. In a FRAGMENT seam the returned node is already wrapped in a
   * `varying()` (memoised), so a hook never calls `varying()` itself. Throws on
   * an undeclared name — a typo is loud here instead of silently reading zeros.
   */
  attribute(name: string): TSLNode;
  /**
   * One of this extension's declared {@link STTMaterialExtension.uniforms}, as the
   * live uniform node. Throws on an undeclared name.
   */
  uniform(name: string): UniformNode;
}

/**
 * A user extension. Every field is optional except `name`; an extension that
 * declares no hook is legal (and composes to nothing) but pointless.
 *
 * `name` must be unique within one material build — it namespaces the
 * extension's uniforms (`"<name>.<uniform>"`) and appears in every error message.
 */
export interface STTMaterialExtension {
  readonly name: string;
  /** Per-feature buffers this extension reads. The HOST binds them (see header). */
  readonly attributes?: readonly STTExtensionAttribute[];
  /** Live scalars this extension reads; push values with {@link updateExtensionUniforms}. */
  readonly uniforms?: readonly STTExtensionUniform[];
  /** VERTEX. Ungated model-space position in, position out. Gates re-applied after. */
  transformPosition?(position: TSLNode, ctx: STTExtensionContext): TSLNode;
  /** VERTEX. Ungated scalar size/scale in, scalar out. The hard gate multiplies after. */
  transformSize?(size: TSLNode, ctx: STTExtensionContext): TSLNode;
  /** FRAGMENT. sRGB rgb `vec3` in, `vec3` out — BEFORE `srgbToWorking`. Never in the id pass. */
  transformColor?(color: TSLNode, ctx: STTExtensionContext): TSLNode;
  /** FRAGMENT. Base alpha in, alpha out. The soft time/filter ramps multiply after. */
  transformAlpha?(alpha: TSLNode, ctx: STTExtensionContext): TSLNode;
}

/** Mixed into every wired material's options interface. */
export interface STTExtensionOptions {
  /**
   * User extensions composed into this material, in order, after any registered
   * with {@link registerSTTExtension} for the same kind. Omitted / empty leaves
   * the node graph BYTE-IDENTICAL.
   */
  extensions?: readonly STTMaterialExtension[];
}

/**
 * Attribute names the shipped materials already bind. An extension declaring one
 * of these would re-bind (and possibly re-type) a buffer the time-filter,
 * data-filter, glide, palette or id path depends on, which is exactly the
 * "extension breaks the gates" failure this module exists to prevent — so it is
 * a build-time error, not a warning.
 */
export const RESERVED_ATTRIBUTE_NAMES: ReadonlySet<string> = new Set<string>([
  // three built-ins
  'position',
  'normal',
  'uv',
  // shipped STT attributes across every material in this package
  'sttAnchor',
  'sttAngle',
  'sttBase',
  'sttBasisX',
  'sttBasisY',
  'sttBasisZ',
  'sttBundleT',
  'sttCenter',
  'sttColor',
  'sttColorA',
  'sttColorB',
  'sttColorSource',
  'sttColorTarget',
  'sttDynamic',
  'sttEnd',
  'sttEndpointOffsets',
  'sttFilterValue',
  'sttGlyphExtent',
  'sttGlyphOffset',
  'sttHeight',
  'sttIdColor',
  'sttLift',
  'sttNormal',
  'sttPosA',
  'sttPosB',
  'sttPosSource',
  'sttPosTarget',
  'sttQuat',
  'sttRowV',
  'sttScale',
  'sttSize',
  'sttStart',
  'sttStrokeWidth',
  'sttTimeA',
  'sttTimeB',
  'sttUvRect',
  'sttVisible',
  'sttWidth',
  ...Object.values(GLIDE_ATTR),
]);

// ── Resolution ────────────────────────────────────────────────────────────────

/**
 * A validated extension list plus the uniform nodes built for it, produced once
 * per material build. `NO_EXTENSIONS` is the shared empty instance — identity
 * `===` on it is the fast path every wired material takes when nobody extended
 * anything.
 */
export class ResolvedExtensions {
  /** Composition order: registry entries first, then the material's own option. */
  readonly list: readonly STTMaterialExtension[];
  /** `"<extension>.<uniform>"` → live uniform node. Empty when `list` is empty. */
  readonly uniforms: ReadonlyMap<string, UniformNode>;
  /** Every attribute the composed extensions read — what the HOST must bind. */
  readonly attributes: readonly STTExtensionAttribute[];

  /** Per-build memo of `varying(attribute(name))`, so one attribute varies once. */
  private readonly varyings = new Map<string, TSLNode>();
  private readonly attributeTypes: ReadonlyMap<
    string,
    STTExtensionAttributeType
  >;

  constructor(list: readonly STTMaterialExtension[]) {
    this.list = list;
    const uniforms = new Map<string, UniformNode>();
    const attributes: STTExtensionAttribute[] = [];
    const attributeTypes = new Map<string, STTExtensionAttributeType>();
    const names = new Set<string>();

    for (const ext of list) {
      if (!ext.name) {
        throw new Error('[stt/three] a material extension must have a `name`');
      }
      if (names.has(ext.name)) {
        throw new Error(
          `[stt/three] duplicate material-extension name "${ext.name}" — ` +
            'names namespace uniforms, so they must be unique per material',
        );
      }
      names.add(ext.name);

      for (const attr of ext.attributes ?? []) {
        if (RESERVED_ATTRIBUTE_NAMES.has(attr.name)) {
          throw new Error(
            `[stt/three] extension "${ext.name}" declares reserved attribute ` +
              `"${attr.name}" — that buffer is bound by the shipped material ` +
              '(time filter / data filter / glide / palette / id), and ' +
              'redeclaring it would break the gates. Pick another name.',
          );
        }
        const seen = attributeTypes.get(attr.name);
        if (seen === undefined) {
          attributeTypes.set(attr.name, attr.type);
          attributes.push(attr);
        } else if (seen !== attr.type) {
          throw new Error(
            `[stt/three] extension "${ext.name}" declares attribute ` +
              `"${attr.name}" as ${attr.type}, but another extension in the ` +
              `same material declares it as ${seen} — one buffer, one type.`,
          );
        }
      }

      for (const u of ext.uniforms ?? []) {
        const key = `${ext.name}.${u.name}`;
        if (uniforms.has(key)) {
          throw new Error(
            `[stt/three] extension "${ext.name}" declares uniform "${u.name}" twice`,
          );
        }
        uniforms.set(key, makeUniformNode(key, u.value));
      }
    }

    this.uniforms = uniforms;
    this.attributes = attributes;
    this.attributeTypes = attributeTypes;
  }

  /** `true` when at least one extension is composed into this material. */
  get active(): boolean {
    return this.list.length > 0;
  }

  /** @internal — stage-correct attribute node for `ctx.attribute`. */
  attributeNode(name: string, stage: STTShaderStage): TSLNode {
    const type = this.attributeTypes.get(name);
    if (type === undefined) {
      throw new Error(
        `[stt/three] extension attribute "${name}" was not declared — ` +
          "add it to the extension's `attributes` list",
      );
    }
    if (stage === 'vertex') return attribute(name, type);
    let varied = this.varyings.get(name);
    if (varied === undefined) {
      // Vary the RAW attribute (never a select()-based node — see the header).
      varied = varying(attribute(name, type));
      this.varyings.set(name, varied);
    }
    return varied;
  }
}

/** The shared empty resolution. Never carries uniforms, attributes or varyings. */
export const NO_EXTENSIONS = new ResolvedExtensions([]);

function makeUniformNode(
  key: string,
  value: number | readonly number[],
): UniformNode {
  if (typeof value === 'number') return uniform(value);
  switch (value.length) {
    case 2:
      return uniform(new Vector2(value[0], value[1]));
    case 3:
      return uniform(new Vector3(value[0], value[1], value[2]));
    case 4:
      return uniform(new Vector4(value[0], value[1], value[2], value[3]));
    default:
      throw new Error(
        `[stt/three] extension uniform "${key}" must be a number or a ` +
          `length-2/3/4 array (got length ${value.length})`,
      );
  }
}

// ── Registry (the door into a SHIPPED layer's material) ───────────────────────

const REGISTRY = new Map<STTMaterialKind, STTMaterialExtension[]>();

/**
 * Register an extension for every material of `kind` built from now on —
 * including the ones the shipped `STT<Kind>Layer` classes build for themselves,
 * which is the only way to extend a shipped layer until an `extensions` option is
 * plumbed through `src/layers/*`. Registration is process-global and applies at
 * MATERIAL-BUILD time: layers cache their bundle for their lifetime, so register
 * before mounting. Returns an unregister thunk for symmetry with event listeners.
 */
export function registerSTTExtension(
  kind: STTMaterialKind,
  ext: STTMaterialExtension,
): () => void {
  const list = REGISTRY.get(kind) ?? [];
  if (!list.includes(ext)) list.push(ext);
  REGISTRY.set(kind, list);
  return () => {
    unregisterSTTExtension(kind, ext);
  };
}

/** Remove one registered extension. Returns `true` when it was registered. */
export function unregisterSTTExtension(
  kind: STTMaterialKind,
  ext: STTMaterialExtension,
): boolean {
  const list = REGISTRY.get(kind);
  if (!list) return false;
  const i = list.indexOf(ext);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}

/** Drop every registration for `kind`, or for every kind when omitted. */
export function clearSTTExtensions(kind?: STTMaterialKind): void {
  if (kind === undefined) REGISTRY.clear();
  else REGISTRY.delete(kind);
}

/** What is currently registered for `kind`, in composition order. */
export function listSTTExtensions(
  kind: STTMaterialKind,
): readonly STTMaterialExtension[] {
  return REGISTRY.get(kind) ?? [];
}

/**
 * Merge the by-kind registry with a material's own `extensions` option into one
 * validated resolution. Returns the shared {@link NO_EXTENSIONS} when both are
 * empty, which is what keeps the un-extended graph byte-identical.
 */
export function resolveExtensions(
  kind: STTMaterialKind,
  extensions?: readonly STTMaterialExtension[],
): ResolvedExtensions {
  const registered = REGISTRY.get(kind);
  const hasRegistered = registered !== undefined && registered.length > 0;
  const hasExplicit = extensions !== undefined && extensions.length > 0;
  if (!hasRegistered && !hasExplicit) return NO_EXTENSIONS;
  const merged: STTMaterialExtension[] = hasRegistered ? [...registered] : [];
  if (hasExplicit) {
    for (const ext of extensions) if (!merged.includes(ext)) merged.push(ext);
  }
  return new ResolvedExtensions(merged);
}

// ── Composition ───────────────────────────────────────────────────────────────

/** What a material tells {@link extensionHooks} about itself. */
export interface MaterialSeamEnv {
  readonly kind: STTMaterialKind;
  readonly pass: STTMaterialPass;
  /** The material's own playhead uniforms, exposed to hooks read-only. */
  readonly time: TimeFilterUniforms;
}

/**
 * The four seam functions a material calls, plus the two gate-preserving
 * position-composition helpers. Every function is the IDENTITY when no composed
 * extension declares that seam — returning the same node object, so the emitted
 * graph is unchanged.
 */
export interface MaterialHooks {
  /** `true` when at least one extension is composed into this material. */
  readonly active: boolean;
  /** Does any composed extension declare `seam`? Materials branch on this to
   *  keep the un-hooked expression verbatim. */
  has(seam: STTMaterialSeam): boolean;
  /** VERTEX seam: ungated model-space position in, position out. */
  position(node: TSLNode): TSLNode;
  /** VERTEX seam: ungated scalar size/scale in, scalar out. */
  size(node: TSLNode): TSLNode;
  /** FRAGMENT seam: sRGB rgb in, rgb out. Identity in the `id` pass. */
  color(node: TSLNode): TSLNode;
  /** FRAGMENT seam: base alpha in, alpha out. */
  alpha(node: TSLNode): TSLNode;
  /**
   * ADDITIVE collapse form (column-style): the shipped expression is
   * `anchor + offset·gate`. With a `position` hook it becomes
   * `anchor + (hook(anchor + offset) − anchor)·gate`, so a gated primitive still
   * degenerates to `anchor` exactly. Without one it is the shipped expression,
   * node for node.
   */
  offsetPosition(
    anchor: TSLNode,
    offset: TSLNode,
    gate: TSLNode | null,
  ): TSLNode;
  /**
   * SCALED collapse form (polygon-style): the shipped expression is `pos·gate`
   * (collapse toward the local origin), or `pos` when there is no gate. With a
   * `position` hook it becomes `hook(pos)·gate` — the gate still multiplies last,
   * so a gated feature still degenerates.
   */
  scaledPosition(position: TSLNode, gate: TSLNode | null): TSLNode;
}

const identity = (node: TSLNode): TSLNode => node;

/** The shared no-op hooks — what every un-extended material build gets. */
const IDENTITY_HOOKS: MaterialHooks = {
  active: false,
  has: () => false,
  position: identity,
  size: identity,
  color: identity,
  alpha: identity,
  offsetPosition: (anchor, offset, gate) =>
    gate ? anchor.add(offset.mul(gate)) : anchor.add(offset),
  scaledPosition: (position, gate) => (gate ? position.mul(gate) : position),
};

function hookFor(
  ext: STTMaterialExtension,
  seam: STTMaterialSeam,
): ((node: TSLNode, ctx: STTExtensionContext) => TSLNode) | undefined {
  switch (seam) {
    case 'position':
      return ext.transformPosition;
    case 'size':
      return ext.transformSize;
    case 'color':
      return ext.transformColor;
    case 'alpha':
      return ext.transformAlpha;
  }
}

/**
 * Bind a resolution to one material build. Returns the shared identity hooks
 * when nothing is composed, so the caller pays nothing and emits nothing.
 */
export function extensionHooks(
  resolved: ResolvedExtensions,
  env: MaterialSeamEnv,
): MaterialHooks {
  if (!resolved.active) return IDENTITY_HOOKS;

  const declares = (seam: STTMaterialSeam): boolean => {
    // The id pass never composes colour — the index must decode bit-exact.
    if (seam === 'color' && env.pass === 'id') return false;
    return resolved.list.some((ext) => hookFor(ext, seam) !== undefined);
  };

  const run = (seam: STTMaterialSeam, node: TSLNode): TSLNode => {
    if (!declares(seam)) return node;
    const stage = SEAM_STAGE[seam];
    let out = node;
    for (const ext of resolved.list) {
      const fn = hookFor(ext, seam);
      if (fn === undefined) continue;
      const ctx: STTExtensionContext = {
        kind: env.kind,
        pass: env.pass,
        seam,
        stage,
        time: env.time,
        attribute: (name: string) => resolved.attributeNode(name, stage),
        uniform: (name: string) => {
          const u = resolved.uniforms.get(`${ext.name}.${name}`);
          if (u === undefined) {
            throw new Error(
              `[stt/three] extension "${ext.name}" read undeclared uniform ` +
                `"${name}" — add it to the extension's \`uniforms\` list`,
            );
          }
          return u;
        },
      };
      const next = fn.call(ext, out, ctx);
      if (next === undefined || next === null) {
        throw new Error(
          `[stt/three] extension "${ext.name}" returned ${String(next)} from ` +
            `the "${seam}" seam — a hook must return a node`,
        );
      }
      out = next;
    }
    if (out !== node) {
      assertVaryingSafe(out, `${env.kind}/${env.pass} "${seam}" seam`);
    }
    return out;
  };

  return {
    active: true,
    has: declares,
    position: (node) => run('position', node),
    size: (node) => run('size', node),
    color: (node) => run('color', node),
    alpha: (node) => run('alpha', node),
    offsetPosition: (anchor, offset, gate) => {
      if (!declares('position')) {
        return gate ? anchor.add(offset.mul(gate)) : anchor.add(offset);
      }
      const moved = run('position', anchor.add(offset));
      // Gate LAST: at gate = 0 every vertex lands exactly on `anchor`, so the
      // primitive is degenerate no matter what the extension returned.
      return gate ? anchor.add(moved.sub(anchor).mul(gate)) : moved;
    },
    scaledPosition: (position, gate) => {
      if (!declares('position')) return gate ? position.mul(gate) : position;
      const moved = run('position', position);
      return gate ? moved.mul(gate) : moved;
    },
  };
}

// ── The `varying()` guard ─────────────────────────────────────────────────────

/** Bound on the build-time graph walk; past it the guard gives up silently. */
const GUARD_NODE_BUDGET = 50_000;

/** Duck-typed `select()` detection — survives class-name mangling in a bundler. */
function isConditional(n: Record<string, unknown>): boolean {
  return n.condNode !== undefined && n.ifNode !== undefined;
}

/**
 * Throw if `node`'s graph wraps a conditional (`select()`) inside a `varying()`.
 *
 * That exact shape is this package's recurring WGSL build crash: the shipped
 * alpha builders are `select()`-based, and three's WGSL backend cannot emit a
 * varying whose expression branches. The fix is always the same — vary the RAW
 * scalar attribute and recompute the conditional in the fragment stage — which is
 * why `ctx.attribute()` hands fragment seams a pre-varied raw attribute.
 *
 * Build-time only (once per material) and only over graphs a hook actually
 * touched. Best-effort by design: it bails out past {@link GUARD_NODE_BUDGET}
 * nodes rather than stalling a build, so a clean pass is evidence, not proof.
 */
export function assertVaryingSafe(node: TSLNode, where: string): void {
  // A node reachable both inside and outside a varying must be visited twice, so
  // the visit sets are keyed by that flag.
  const seenPlain = new Set<object>();
  const seenVaried = new Set<object>();
  const stack: Array<{ n: TSLNode; varied: boolean }> = [
    { n: node, varied: false },
  ];
  let budget = GUARD_NODE_BUDGET;

  while (stack.length > 0) {
    if (budget-- <= 0) return;
    const entry = stack.pop()!;
    const n = entry.n as Record<string, unknown> | null | undefined;
    if (n === null || n === undefined || typeof n !== 'object') continue;
    const varied = entry.varied || n.isVaryingNode === true;
    const seen = varied ? seenVaried : seenPlain;
    if (seen.has(n)) continue;
    seen.add(n);

    if (varied && isConditional(n)) {
      throw new Error(
        `[stt/three] ${where}: a select()-based node is wrapped in a varying(). ` +
          'That fails to build on the WGSL backend. Vary the RAW attribute ' +
          '(ctx.attribute(name) already does this in a fragment seam) and ' +
          'recompute the conditional in the fragment stage instead.',
      );
    }

    const children = (n as { getChildren?: () => Iterable<TSLNode> })
      .getChildren;
    if (typeof children !== 'function') continue;
    for (const child of children.call(n)) stack.push({ n: child, varied });
  }
}

// ── Live values ───────────────────────────────────────────────────────────────

/** Push one extension uniform by its global `"<extension>.<uniform>"` key. */
export function setExtensionUniform(
  resolved: ResolvedExtensions | undefined,
  key: string,
  value: number | readonly number[],
): void {
  const node = resolved?.uniforms.get(key);
  if (node === undefined) {
    throw new Error(
      `[stt/three] no extension uniform "${key}" on this material — ` +
        'keys are "<extensionName>.<uniformName>"',
    );
  }
  if (typeof value === 'number') {
    node.value = value;
    return;
  }
  const target = node.value as { fromArray?: (a: readonly number[]) => void };
  if (typeof target?.fromArray !== 'function') {
    throw new Error(
      `[stt/three] extension uniform "${key}" is a scalar; got an array`,
    );
  }
  target.fromArray(value);
}

/**
 * Push a whole `{ "<extension>.<uniform>": value }` map, once per frame. Safe on
 * `undefined` (a bundle built with no extensions has no `extensions` field), so
 * a host's per-frame update can call it unconditionally.
 */
export function updateExtensionUniforms(
  resolved: ResolvedExtensions | undefined,
  values: Readonly<Record<string, number | readonly number[]>> = {},
): void {
  if (resolved === undefined || !resolved.active) return;
  for (const key of Object.keys(values)) {
    setExtensionUniform(resolved, key, values[key]!);
  }
}
