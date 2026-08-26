// @poopdeck.gl/three
// SPDX-License-Identifier: MIT

/**
 * The conformance case behind `capabilities.userExtensions` for the three
 * backend — `src/tsl/extensions.ts`, the TSL analogue of deck's
 * `LayerExtension`.
 *
 * A hook that exists but changes nothing would be an over-claim, and a hook that
 * can defeat the shipped time / data-filter gates would be worse than no hook at
 * all. So this file is built around four load-bearing claims, each proved rather
 * than asserted:
 *
 *  1. **Empty ⇒ byte-identical.** A material built with `extensions: []` (or
 *     without the option) emits the SAME node graph, the same uniform set and
 *     the same bundle keys as before the seam existed. Proved with a structural
 *     graph signature — a recursive walk over the real node objects recording
 *     class, `op`/`method`/`components`, attribute names and literal values —
 *     because three's own `getCacheKey()` folds in per-instance node ids and so
 *     differs between two identical builds.
 *  2. **The gates always win.** Two shipped graphs are EXECUTED on the CPU by a
 *     small vector-capable interpreter (the same technique
 *     `tsl-time-filter-conformance.test.ts` uses for the scalar time filter),
 *     with a deliberately HOSTILE extension installed — one that returns a huge
 *     constant position, a huge constant size, or a hard `1` alpha. Out of the
 *     time window the column's prism still collapses EXACTLY onto its base and
 *     the polygon's opacity is still exactly 0. The billboard kinds, whose size
 *     gate lives under the camera matrices, are pinned structurally instead: the
 *     extension's contribution must be an operand of a multiply whose OTHER
 *     operand is the shipped time gate.
 *  3. **Picking cannot disagree with drawing.** The id materials compose the
 *     same `position` / `size` / `alpha` seams as their colour siblings, and
 *     never the `color` seam.
 *  4. **The `varying()` rule is enforced, not requested.** A fragment hook that
 *     wraps a `select()` in a `varying()` — this package's recurring WGSL crash
 *     — fails the material build with a message naming the fix, and
 *     `ctx.attribute()` hands fragment seams a pre-varied raw attribute so a
 *     hook never needs `varying()` in the first place.
 *
 * Everything here is pure Node: TSL graphs are plain-old-data. Nothing is
 * compiled to WGSL or rendered — that stays browser-verified, as everywhere in
 * this package.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, afterEach } from 'vitest';
import { Texture } from 'three';
import {
  MATERIAL_SEAMS,
  MATERIAL_SEAM_MATRIX,
  NO_EXTENSIONS,
  RESERVED_ATTRIBUTE_NAMES,
  ResolvedExtensions,
  STT_MATERIAL_KINDS,
  assertVaryingSafe,
  clearSTTExtensions,
  extensionHooks,
  listSTTExtensions,
  registerSTTExtension,
  resolveExtensions,
  setExtensionUniform,
  unregisterSTTExtension,
  updateExtensionUniforms,
  type STTMaterialExtension,
  type STTMaterialKind,
  type STTMaterialSeam,
} from '../src/tsl/extensions';
import {
  createPointMaterial,
  createPointIdMaterial,
} from '../src/tsl/point-material';
import {
  createColumnMaterial,
  createColumnIdMaterial,
} from '../src/tsl/column-material';
import {
  createIconMaterial,
  createIconIdMaterial,
} from '../src/tsl/icon-material';
import {
  createPolygonMaterial,
  createPolygonIdMaterial,
} from '../src/tsl/polygon-material';
import { updateDataFilterUniforms } from '../src/tsl/data-filter';
import { TimeFilterUniforms } from '../src/tsl/time-filter';
import { float, select, uniform, varying, vec3 } from '../src/tsl/nodes';
import { STTPointLayer } from '../src/layers/point-layer';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { makePointTile } from './_support/features';

// ─────────────────────────────────────────────────────────────────────────────
// Graph tools
// ─────────────────────────────────────────────────────────────────────────────

const WALK_BUDGET = 200_000;

/**
 * A stable structural fingerprint of a TSL graph. Three's `getCacheKey()` mixes
 * in per-instance node ids, so two identical builds hash differently; this walks
 * the same objects and records only what the emitted shader would depend on.
 */
function graphSignature(root: any): string {
  let budget = WALK_BUDGET;
  const walk = (n: any): string => {
    if (budget-- <= 0) throw new Error('graphSignature: walk budget exceeded');
    if (n === null || n === undefined) return '·';
    if (typeof n !== 'object') return String(n);
    const parts: string[] = [n.constructor?.name ?? '?'];
    if (n.nodeType) parts.push(String(n.nodeType));
    if (typeof n.getAttributeName === 'function') {
      parts.push('@' + n.getAttributeName());
    }
    for (const k of ['op', 'method', 'components', 'scope']) {
      if (typeof n[k] === 'string') parts.push(`${k}:${n[k]}`);
    }
    if (n.isConstNode) parts.push('=' + describeValue(n.value));
    if (n.isUniformNode) parts.push('u:' + describeValue(n.value));
    const kids: string[] = [];
    if (typeof n.getChildren === 'function') {
      for (const c of n.getChildren()) kids.push(walk(c));
    }
    return parts.join('|') + (kids.length > 0 ? `(${kids.join(',')})` : '');
  };
  return walk(root);
}

function describeValue(v: unknown): string {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof (v as any).toArray === 'function') {
    return JSON.stringify((v as any).toArray());
  }
  // Textures and other opaque uniform payloads: identity is what matters, and
  // both sides of an equality test share the same object.
  return `<${(v as any).constructor?.name ?? typeof v}>`;
}

/** Every node reachable from `root`, deduped. */
function allNodes(root: any): any[] {
  const seen = new Set<any>();
  const out: any[] = [];
  const stack = [root];
  let budget = WALK_BUDGET;
  while (stack.length > 0) {
    if (budget-- <= 0) throw new Error('allNodes: walk budget exceeded');
    const n = stack.pop();
    if (n === null || n === undefined || typeof n !== 'object') continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (typeof n.getChildren === 'function') {
      for (const c of n.getChildren()) stack.push(c);
    }
  }
  return out;
}

const contains = (root: any, target: any): boolean =>
  root !== null && root !== undefined && allNodes(root).includes(target);

const uniformCount = (root: any): number =>
  allNodes(root).filter((n) => n.isUniformNode === true).length;

// ─────────────────────────────────────────────────────────────────────────────
// A vector-capable TSL interpreter.
//
// `tsl-time-filter-conformance.test.ts` owns the scalar version; the graphs here
// (a column's `positionNode`, a polygon's `opacityNode`) carry vec3/vec4
// attributes and swizzles, so this one evaluates `number | number[]`. Unknown
// node classes and ops THROW — a graph rewritten with a new operator fails
// loudly here instead of silently passing.
// ─────────────────────────────────────────────────────────────────────────────

type Val = number | boolean | number[];
type Bindings = Readonly<Record<string, number | number[]>>;

const COMPONENT_INDEX: Record<string, number> = {
  x: 0,
  y: 1,
  z: 2,
  w: 3,
  r: 0,
  g: 1,
  b: 2,
  a: 3,
};

function evalNode(node: any, attrs: Bindings): Val {
  if (node === null || node === undefined) throw new Error('null TSL node');

  if (node.isSplitNode) {
    const base = evalNode(node.node, attrs);
    const arr = Array.isArray(base) ? base : [base as number];
    const comps: string = node.components;
    const picked = [...comps].map((c) => {
      const i = COMPONENT_INDEX[c];
      if (i === undefined) throw new Error(`evalTSL: swizzle "${c}"`);
      const v = arr[i];
      if (v === undefined)
        throw new Error(`evalTSL: swizzle "${c}" out of range`);
      return v;
    });
    return picked.length === 1 ? picked[0]! : picked;
  }

  if (typeof node.getAttributeName === 'function') {
    const name = node.getAttributeName();
    const v = attrs[name];
    if (v === undefined)
      throw new Error(`evalTSL: unbound attribute "${name}"`);
    return Array.isArray(v) ? [...v] : v;
  }

  if (node.isConstNode || node.isUniformNode) {
    const value = node.value;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value?.toArray === 'function') return value.toArray();
    throw new Error(`evalTSL: non-scalar input ${String(value)}`);
  }

  if (node.isOperatorNode) {
    const a = evalNode(node.aNode, attrs);
    const b = evalNode(node.bNode, attrs);
    return applyOperator(node.op, a, b);
  }

  if (node.isMathNode) {
    return applyMath(node, attrs);
  }

  if (node.condNode !== undefined) {
    return evalNode(node.condNode, attrs)
      ? evalNode(node.ifNode, attrs)
      : evalNode(node.elseNode, attrs);
  }

  // JoinNode (`vec3(a, b, c)` from separate nodes).
  if (Array.isArray(node.nodes)) {
    const out: number[] = [];
    for (const child of node.nodes) {
      const v = evalNode(child, attrs);
      if (Array.isArray(v)) out.push(...v);
      else out.push(v as number);
    }
    return out;
  }

  // Transparent wrappers: VarNode, VaryingNode, SubBuildNode, ConvertNode.
  if (node.node !== undefined) return evalNode(node.node, attrs);

  throw new Error(
    `evalTSL: unhandled node class "${node.constructor?.name}" ` +
      `(keys: ${Object.keys(node).join(',')})`,
  );
}

function applyOperator(op: string, a: Val, b: Val): Val {
  const scalarOps: Record<string, (x: number, y: number) => number> = {
    '+': (x, y) => x + y,
    '-': (x, y) => x - y,
    '*': (x, y) => x * y,
    '/': (x, y) => x / y,
  };
  const fn = scalarOps[op];
  if (fn) return broadcast(a, b, fn);
  const x = a as number;
  const y = b as number;
  switch (op) {
    case '>=':
      return x >= y;
    case '<=':
      return x <= y;
    case '>':
      return x > y;
    case '<':
      return x < y;
    case '==':
      return x === y;
    case '&&':
      return Boolean(a) && Boolean(b);
    case '||':
      return Boolean(a) || Boolean(b);
    default:
      throw new Error(`evalTSL: unhandled OperatorNode op "${op}"`);
  }
}

function broadcast(a: Val, b: Val, fn: (x: number, y: number) => number): Val {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) throw new Error('evalTSL: length mismatch');
    return a.map((v, i) => fn(v, b[i]!));
  }
  if (Array.isArray(a)) return a.map((v) => fn(v, b as number));
  if (Array.isArray(b)) return b.map((v) => fn(a as number, v));
  return fn(a as number, b as number);
}

function applyMath(node: any, attrs: Bindings): Val {
  const a = evalNode(node.aNode, attrs);
  switch (node.method) {
    case 'max':
      return broadcast(a, evalNode(node.bNode, attrs), Math.max);
    case 'min':
      return broadcast(a, evalNode(node.bNode, attrs), Math.min);
    // GLSL/WGSL step(edge, x) = x >= edge ? 1 : 0.
    case 'step': {
      const x = evalNode(node.bNode, attrs);
      return broadcast(a, x, (edge, v) => (v >= edge ? 1 : 0));
    }
    case 'clamp': {
      const lo = evalNode(node.bNode, attrs) as number;
      const hi = evalNode(node.cNode, attrs) as number;
      return broadcast(a, 0, (v) => Math.min(Math.max(v, lo), hi));
    }
    case 'mix': {
      const b = evalNode(node.bNode, attrs);
      const t = evalNode(node.cNode, attrs) as number;
      return broadcast(a, b, (x, y) => x * (1 - t) + y * t);
    }
    case 'negate':
      return broadcast(a, 0, (v) => -v);
    default:
      throw new Error(`evalTSL: unhandled MathNode method "${node.method}"`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const atlas = new Texture();

/** The nodes each wired factory sets, so a comparison misses nothing. */
const MATERIAL_NODES = [
  'vertexNode',
  'positionNode',
  'colorNode',
  'opacityNode',
] as const;

type Bundle = { material: any };

function materialSignature(bundle: Bundle): string {
  return MATERIAL_NODES.map((k) => {
    const node = bundle.material[k];
    return `${k}=${node === null || node === undefined ? 'unset' : graphSignature(node)}`;
  }).join('\n');
}

function materialUniformCount(bundle: Bundle): number {
  return MATERIAL_NODES.reduce((n, k) => {
    const node = bundle.material[k];
    return n + (node === null || node === undefined ? 0 : uniformCount(node));
  }, 0);
}

/** Every wired (kind, pass) factory, built from a plain options object. */
const FACTORIES: ReadonlyArray<{
  label: string;
  kind: STTMaterialKind;
  pass: 'color' | 'id';
  build: (extensions?: readonly STTMaterialExtension[]) => Bundle;
}> = [
  {
    label: 'point/color',
    kind: 'point',
    pass: 'color',
    build: (extensions) => createPointMaterial({ mode: 'window', extensions }),
  },
  {
    label: 'point/id',
    kind: 'point',
    pass: 'id',
    build: (extensions) =>
      createPointIdMaterial({ mode: 'window', extensions }),
  },
  {
    label: 'icon/color',
    kind: 'icon',
    pass: 'color',
    build: (extensions) =>
      createIconMaterial({ mode: 'window', atlas, extensions }),
  },
  {
    label: 'icon/id',
    kind: 'icon',
    pass: 'id',
    build: (extensions) => createIconIdMaterial({ mode: 'window', extensions }),
  },
  {
    label: 'column/color',
    kind: 'column',
    pass: 'color',
    build: (extensions) => createColumnMaterial({ extensions }),
  },
  {
    label: 'column/id',
    kind: 'column',
    pass: 'id',
    build: (extensions) => createColumnIdMaterial({ extensions }),
  },
  {
    label: 'polygon/color',
    kind: 'polygon',
    pass: 'color',
    build: (extensions) =>
      createPolygonMaterial({ mode: 'window', extensions }),
  },
  {
    label: 'polygon/id',
    kind: 'polygon',
    pass: 'id',
    build: (extensions) =>
      createPolygonIdMaterial({ mode: 'window', extensions }),
  },
];

/** A single-seam extension returning a recognisable marker uniform. */
function markerExtension(
  seam: STTMaterialSeam,
  marker = uniform(12345),
): STTMaterialExtension {
  const hook = (): any =>
    seam === 'position' ? vec3(marker, marker, marker) : marker;
  switch (seam) {
    case 'position':
      return { name: 'mark', transformPosition: hook };
    case 'size':
      return { name: 'mark', transformSize: hook };
    case 'color':
      return {
        name: 'mark',
        transformColor: () => vec3(marker, marker, marker),
      };
    case 'alpha':
      return { name: 'mark', transformAlpha: hook };
  }
}

afterEach(() => {
  clearSTTExtensions();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('extension vocabulary', () => {
  it('publishes a seam list for every wired kind, over the frozen seam set', () => {
    expect(Object.keys(MATERIAL_SEAM_MATRIX).sort()).toEqual(
      [...STT_MATERIAL_KINDS].sort(),
    );
    for (const kind of STT_MATERIAL_KINDS) {
      const seams = MATERIAL_SEAM_MATRIX[kind];
      expect(seams.length).toBeGreaterThan(0);
      for (const seam of seams) expect(MATERIAL_SEAMS).toContain(seam);
    }
  });

  it('reserves every shipped attribute name the gates depend on', () => {
    for (const name of ['sttStart', 'sttEnd', 'sttFilterValue', 'sttIdColor']) {
      expect(RESERVED_ATTRIBUTE_NAMES.has(name)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('an empty extension list is structurally invisible', () => {
  it('resolves to the shared singleton, whose hooks are the identity', () => {
    expect(resolveExtensions('point')).toBe(NO_EXTENSIONS);
    expect(resolveExtensions('point', [])).toBe(NO_EXTENSIONS);
    expect(NO_EXTENSIONS.active).toBe(false);

    const node = float(3);
    const hooks = extensionHooks(NO_EXTENSIONS, {
      kind: 'point',
      pass: 'color',
      time: new TimeFilterUniforms(),
    });
    expect(hooks.active).toBe(false);
    // Identity means the SAME node object, not merely an equivalent one.
    expect(hooks.position(node)).toBe(node);
    expect(hooks.size(node)).toBe(node);
    expect(hooks.color(node)).toBe(node);
    expect(hooks.alpha(node)).toBe(node);
    for (const seam of MATERIAL_SEAMS) expect(hooks.has(seam)).toBe(false);
  });

  it.each(FACTORIES.map((f) => [f.label, f] as const))(
    '%s — `extensions: []` emits the same graph, uniforms and bundle keys as no option',
    (_label, factory) => {
      const bare = factory.build();
      const empty = factory.build([]);

      expect(materialSignature(empty)).toBe(materialSignature(bare));
      expect(materialUniformCount(empty)).toBe(materialUniformCount(bare));
      expect(Object.keys(empty as object).sort()).toEqual(
        Object.keys(bare as object).sort(),
      );
      // No `extensions` key at all — the bundle shape is unchanged too.
      expect('extensions' in (bare as object)).toBe(false);
      expect((empty as any).extensions).toBeUndefined();
    },
  );

  it('the composition helpers emit the SHIPPED expression when nobody hooks position', () => {
    // This is what makes claim 1 more than "[] equals undefined": the helpers a
    // material now calls in place of its own arithmetic must emit that exact
    // arithmetic, node for node, on the un-hooked path — including when OTHER
    // seams are active.
    const anchor = uniform(1);
    const offset = uniform(2);
    const gate = uniform(3);
    const shippedOffsetForm = graphSignature(anchor.add(offset.mul(gate)));
    const shippedScaledForm = graphSignature(offset.mul(gate));

    const colorOnly = new ResolvedExtensions([
      { name: 'c', transformColor: (c: any) => c },
    ]);
    for (const resolved of [NO_EXTENSIONS, colorOnly]) {
      const hooks = extensionHooks(resolved, {
        kind: 'column',
        pass: 'color',
        time: new TimeFilterUniforms(),
      });
      expect(hooks.has('position')).toBe(false);
      expect(graphSignature(hooks.offsetPosition(anchor, offset, gate))).toBe(
        shippedOffsetForm,
      );
      expect(graphSignature(hooks.scaledPosition(offset, gate))).toBe(
        shippedScaledForm,
      );
      // No gate at all ⇒ the position node passes straight through, unwrapped.
      expect(hooks.scaledPosition(offset, null)).toBe(offset);
    }
  });

  it('an extension that touches ONE seam leaves every other node byte-identical', () => {
    const colorOnly: STTMaterialExtension = {
      name: 'tint',
      transformColor: (c: any) => c.mul(float(0.5)),
    };
    for (const factory of FACTORIES) {
      const bare: any = factory.build();
      const extended: any = factory.build([colorOnly]);
      for (const key of MATERIAL_NODES) {
        if (key === 'colorNode' && factory.pass === 'color') continue;
        const a = bare.material[key];
        const b = extended.material[key];
        const sigA =
          a === null || a === undefined ? 'unset' : graphSignature(a);
        const sigB =
          b === null || b === undefined ? 'unset' : graphSignature(b);
        expect(sigB, `${factory.label}.${key}`).toBe(sigA);
      }
      // …and the machinery itself introduced no uniform of its own.
      expect(materialUniformCount(extended)).toBe(materialUniformCount(bare));
    }
  });

  it.each(FACTORIES.map((f) => [f.label, f] as const))(
    '%s — a composed extension DOES surface on the bundle',
    (_label, factory) => {
      const bundle = factory.build([markerExtension('position')]) as any;
      expect(bundle.extensions).toBeInstanceOf(ResolvedExtensions);
      expect(bundle.extensions.active).toBe(true);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the published seam matrix is the real wiring', () => {
  const cases = FACTORIES.flatMap((factory) =>
    MATERIAL_SEAMS.map((seam) => [factory.label, seam, factory] as const),
  );

  it.each(cases)('%s — "%s" seam', (_label, seam, factory) => {
    const baseline = materialSignature(factory.build());
    const extended = materialSignature(factory.build([markerExtension(seam)]));

    // The `color` seam is deliberately inert in the id pass (the 24-bit index
    // must decode bit-exact), so it is expected to change nothing there.
    const wired =
      MATERIAL_SEAM_MATRIX[factory.kind].includes(seam) &&
      !(seam === 'color' && factory.pass === 'id');

    if (wired) expect(extended).not.toBe(baseline);
    else expect(extended).toBe(baseline);
  });

  it('a `position` hook installs a positionNode on a polygon that had none', () => {
    const bare = createPolygonMaterial({ mode: 'none' });
    expect(bare.material.positionNode).toBeFalsy();
    const extended = createPolygonMaterial({
      mode: 'none',
      extensions: [markerExtension('position')],
    });
    expect(extended.material.positionNode).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the shipped gates are applied AFTER the user hook, and win', () => {
  // The prism attributes a column material reads. `position` is
  // `positionGeometry` — the unit-prism object position.
  const PRISM: Bindings = {
    sttBase: [10, 20, 30],
    sttBasisX: [2, 0, 0],
    sttBasisY: [0, 3, 0],
    sttBasisZ: [0, 0, 4],
    position: [1, 1, 1],
    sttStart: 0,
    sttEnd: 100,
  };

  function prismAt(bundle: any, currentTime: number): Val {
    bundle.time.currentTime.value = currentTime;
    bundle.time.windowHalf.value = 10;
    return evalNode(bundle.material.positionNode, PRISM);
  }

  it('un-extended: the prism draws in-window and collapses onto its base out of it', () => {
    const bundle = createColumnMaterial();
    expect(prismAt(bundle, 50)).toEqual([12, 23, 34]);
    expect(prismAt(bundle, 10_000)).toEqual([10, 20, 30]);
  });

  it('a HOSTILE position hook moves the prism, but cannot survive the time gate', () => {
    const hostile: STTMaterialExtension = {
      name: 'hostile',
      transformPosition: () => vec3(1e6, 1e6, 1e6),
    };
    const bundle = createColumnMaterial({ extensions: [hostile] });
    // In-window: the hook really did move the geometry (not a decorative hook).
    expect(prismAt(bundle, 50)).toEqual([1e6, 1e6, 1e6]);
    // Out-of-window: every vertex lands EXACTLY on the instance base, so the
    // prism is degenerate and dies at assembly — the gate applied last.
    expect(prismAt(bundle, 10_000)).toEqual([10, 20, 30]);
  });

  it('a HOSTILE size hook inflates the prism, but cannot survive the time gate', () => {
    const hostile: STTMaterialExtension = {
      name: 'hostile',
      transformSize: () => float(1000),
    };
    const bundle = createColumnMaterial({ extensions: [hostile] });
    expect(prismAt(bundle, 50)).toEqual([2010, 3020, 4030]);
    expect(prismAt(bundle, 10_000)).toEqual([10, 20, 30]);
  });

  it('the same holds on the id material, so picking cannot outlive the gate', () => {
    const hostile: STTMaterialExtension = {
      name: 'hostile',
      transformPosition: () => vec3(1e6, 1e6, 1e6),
    };
    const bundle = createColumnIdMaterial({ extensions: [hostile] });
    expect(prismAt(bundle, 50)).toEqual([1e6, 1e6, 1e6]);
    expect(prismAt(bundle, 10_000)).toEqual([10, 20, 30]);
  });

  // ── fragment alpha, on the polygon material ────────────────────────────────
  const FILL: Bindings = {
    sttColor: [0.5, 0.5, 0.5, 0.8],
    sttStart: 0,
    sttEnd: 100,
  };

  function fillAlphaAt(
    bundle: any,
    currentTime: number,
    attrs: Bindings = FILL,
  ): Val {
    bundle.time.currentTime.value = currentTime;
    bundle.time.windowHalf.value = 10;
    return evalNode(bundle.material.opacityNode, attrs);
  }

  it('un-extended: the fill fades to exactly 0 outside its window', () => {
    const bundle = createPolygonMaterial({ mode: 'window' });
    expect(fillAlphaAt(bundle, 50)).toBeCloseTo(0.8, 10);
    expect(fillAlphaAt(bundle, 10_000)).toBe(0);
  });

  it('a HOSTILE alpha hook forcing full opacity still cannot beat the time gate', () => {
    const hostile: STTMaterialExtension = {
      name: 'hostile',
      transformAlpha: () => float(1),
    };
    const bundle = createPolygonMaterial({
      mode: 'window',
      extensions: [hostile],
    });
    // In-window it really does raise the alpha (0.8 → 1): the hook works.
    expect(fillAlphaAt(bundle, 50)).toBeCloseTo(1, 10);
    // Out-of-window the shipped ramp multiplies in after it: exactly 0.
    expect(fillAlphaAt(bundle, 10_000)).toBe(0);
  });

  it('…nor the DATA-filter gate', () => {
    const hostile: STTMaterialExtension = {
      name: 'hostile',
      transformAlpha: () => float(1),
    };
    const bundle = createPolygonMaterial({
      mode: 'window',
      dataFilter: true,
      extensions: [hostile],
    });
    updateDataFilterUniforms(bundle.filter!, { filterRange: [0, 1] });
    const inRange = { ...FILL, sttFilterValue: 0.5 };
    const outOfRange = { ...FILL, sttFilterValue: 5 };
    expect(fillAlphaAt(bundle, 50, inRange)).toBeCloseTo(1, 10);
    expect(fillAlphaAt(bundle, 50, outOfRange)).toBe(0);
  });

  // ── billboard kinds: the size gate lives under the camera matrices, so the
  // proof there is structural — the hook's contribution must be an operand of a
  // multiply whose other operand is the shipped time gate.
  it.each([
    [
      'point',
      (ext: STTMaterialExtension) =>
        createPointMaterial({ mode: 'window', extensions: [ext] }),
    ],
    [
      'point/id',
      (ext: STTMaterialExtension) =>
        createPointIdMaterial({ mode: 'window', extensions: [ext] }),
    ],
    [
      'icon',
      (ext: STTMaterialExtension) =>
        createIconMaterial({ mode: 'window', atlas, extensions: [ext] }),
    ],
    [
      'icon/id',
      (ext: STTMaterialExtension) =>
        createIconIdMaterial({ mode: 'window', extensions: [ext] }),
    ],
  ] as const)(
    '%s — the time gate multiplies the size hook, not the other way round',
    (_label, build) => {
      const marker = uniform(4242);
      const bundle: any = build(markerExtension('size', marker));
      const gate = bundle.time.currentTime;

      const products = allNodes(bundle.material.vertexNode).filter(
        (n) => n.isOperatorNode === true && n.op === '*',
      );
      const gatedAfterHook = products.some(
        (n) =>
          contains(n.aNode, marker) &&
          !contains(n.aNode, gate) &&
          contains(n.bNode, gate),
      );
      expect(gatedAfterHook).toBe(true);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────

describe('id materials compose the same seams as their colour siblings', () => {
  const PAIRS: ReadonlyArray<
    readonly [
      string,
      (e: STTMaterialExtension) => any,
      (e: STTMaterialExtension) => any,
    ]
  > = [
    [
      'point',
      (e) => createPointMaterial({ mode: 'window', extensions: [e] }),
      (e) => createPointIdMaterial({ mode: 'window', extensions: [e] }),
    ],
    [
      'icon',
      (e) => createIconMaterial({ mode: 'window', atlas, extensions: [e] }),
      (e) => createIconIdMaterial({ mode: 'window', extensions: [e] }),
    ],
    [
      'column',
      (e) => createColumnMaterial({ extensions: [e] }),
      (e) => createColumnIdMaterial({ extensions: [e] }),
    ],
    [
      'polygon',
      (e) => createPolygonMaterial({ mode: 'window', extensions: [e] }),
      (e) => createPolygonIdMaterial({ mode: 'window', extensions: [e] }),
    ],
  ];

  it.each(PAIRS)(
    '%s — a `position` hook reaches the id pass (else picking would miss)',
    (kind, colorBuild, idBuild) => {
      const marker = uniform(777);
      const ext = markerExtension('position', marker);
      expect(materialTouches(colorBuild(ext), marker)).toBe(true);
      expect(materialTouches(idBuild(ext), marker)).toBe(true);
      void kind;
    },
  );

  it.each(PAIRS.filter(([k]) => k !== 'polygon'))(
    '%s — a `size` hook reaches the id pass',
    (_kind, colorBuild, idBuild) => {
      const marker = uniform(778);
      const ext = markerExtension('size', marker);
      expect(materialTouches(colorBuild(ext), marker)).toBe(true);
      expect(materialTouches(idBuild(ext), marker)).toBe(true);
    },
  );

  it.each(PAIRS)(
    '%s — an `alpha` hook reaches the id pick gate',
    (_kind, colorBuild, idBuild) => {
      const marker = uniform(779);
      const ext = markerExtension('alpha', marker);
      expect(materialTouches(colorBuild(ext), marker)).toBe(true);
      expect(materialTouches(idBuild(ext), marker)).toBe(true);
    },
  );

  it.each(PAIRS)(
    '%s — a `color` hook NEVER reaches the id pass (the index must decode exact)',
    (_kind, colorBuild, idBuild) => {
      const marker = uniform(780);
      const ext = markerExtension('color', marker);
      expect(materialTouches(colorBuild(ext), marker)).toBe(true);
      expect(materialTouches(idBuild(ext), marker)).toBe(false);
    },
  );

  it('an extension can tell the two passes apart', () => {
    const seen: string[] = [];
    const ext: STTMaterialExtension = {
      name: 'observer',
      transformPosition: (p, ctx) => {
        seen.push(`${ctx.kind}/${ctx.pass}/${ctx.seam}/${ctx.stage}`);
        return p;
      },
    };
    createPointMaterial({ mode: 'window', extensions: [ext] });
    createPointIdMaterial({ mode: 'window', extensions: [ext] });
    expect(seen).toEqual([
      'point/color/position/vertex',
      'point/id/position/vertex',
    ]);
  });
});

function materialTouches(bundle: Bundle, target: any): boolean {
  return MATERIAL_NODES.some((k) => {
    const node = (bundle.material as any)[k];
    return node !== null && node !== undefined && contains(node, target);
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the varying() rule at the hook boundary', () => {
  it('the shipped materials are varying-safe to begin with', () => {
    for (const factory of FACTORIES) {
      const bundle = factory.build();
      for (const key of MATERIAL_NODES) {
        const node = (bundle.material as any)[key];
        if (node === null || node === undefined) continue;
        expect(() =>
          assertVaryingSafe(node, `${factory.label}.${key}`),
        ).not.toThrow();
      }
    }
  });

  it('assertVaryingSafe catches a select() wrapped in a varying()', () => {
    const bad = varying(
      select(float(1).greaterThan(float(0)), float(1), float(0)),
    );
    expect(() => assertVaryingSafe(bad, 'probe')).toThrow(/WGSL/);
    // The inverse shape — a select OVER a varying — is the correct idiom and
    // must stay legal, or every shipped fragment alpha would fail.
    const good = select(
      varying(float(1)).greaterThan(float(0)),
      float(1),
      float(0),
    );
    expect(() => assertVaryingSafe(good, 'probe')).not.toThrow();
  });

  it('a fragment hook that varies a select() fails the material BUILD', () => {
    const ext: STTMaterialExtension = {
      name: 'crasher',
      transformAlpha: (a) =>
        varying(select(a.greaterThan(float(0.5)), float(1), float(0))),
    };
    expect(() =>
      createPointMaterial({ mode: 'window', extensions: [ext] }),
    ).toThrow(/WGSL/);
  });

  it('ctx.attribute() hands a fragment seam a PRE-VARIED raw attribute, memoised', () => {
    const reads: any[] = [];
    const ext: STTMaterialExtension = {
      name: 'reader',
      attributes: [{ name: 'sttUserWeight', type: 'float' }],
      transformAlpha: (a, ctx) => {
        reads.push(ctx.attribute('sttUserWeight'));
        reads.push(ctx.attribute('sttUserWeight'));
        return a.mul(reads[0]);
      },
    };
    createPointMaterial({ mode: 'window', extensions: [ext] });
    expect(reads).toHaveLength(2);
    expect(reads[0].isVaryingNode).toBe(true);
    // One attribute varies ONCE, however many times a hook reads it.
    expect(reads[0]).toBe(reads[1]);
  });

  it('ctx.attribute() in a VERTEX seam hands back the raw attribute', () => {
    let seen: any = null;
    const ext: STTMaterialExtension = {
      name: 'reader',
      attributes: [{ name: 'sttUserOffset', type: 'vec3' }],
      transformPosition: (p, ctx) => {
        seen = ctx.attribute('sttUserOffset');
        return p.add(seen);
      },
    };
    createPointMaterial({ mode: 'window', extensions: [ext] });
    expect(seen.isVaryingNode).toBeUndefined();
    expect(seen.getAttributeName()).toBe('sttUserOffset');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('an extension declares its own attributes and uniforms', () => {
  it('surfaces the attributes a host must bind, deduped across extensions', () => {
    const a: STTMaterialExtension = {
      name: 'a',
      attributes: [{ name: 'sttUserWind', type: 'vec2' }],
      transformColor: (c) => c,
    };
    const b: STTMaterialExtension = {
      name: 'b',
      attributes: [
        { name: 'sttUserWind', type: 'vec2' },
        { name: 'sttUserGain', type: 'float' },
      ],
      transformColor: (c) => c,
    };
    const resolved = new ResolvedExtensions([a, b]);
    expect(resolved.attributes.map((x) => x.name)).toEqual([
      'sttUserWind',
      'sttUserGain',
    ]);
  });

  it('refuses a reserved attribute name — that is how an extension would break a gate', () => {
    const evil: STTMaterialExtension = {
      name: 'evil',
      attributes: [{ name: 'sttStart', type: 'vec4' }],
    };
    expect(() => new ResolvedExtensions([evil])).toThrow(/reserved attribute/);
    expect(() =>
      createPointMaterial({ mode: 'window', extensions: [evil] }),
    ).toThrow(/reserved attribute/);
  });

  it('refuses two extensions disagreeing on one attribute type, or sharing a name', () => {
    const a: STTMaterialExtension = {
      name: 'a',
      attributes: [{ name: 'sttUserX', type: 'float' }],
    };
    const b: STTMaterialExtension = {
      name: 'b',
      attributes: [{ name: 'sttUserX', type: 'vec3' }],
    };
    expect(() => new ResolvedExtensions([a, b])).toThrow(
      /one buffer, one type/,
    );
    expect(() => new ResolvedExtensions([a, { name: 'a' }])).toThrow(
      /duplicate material-extension name/,
    );
  });

  it('builds live uniform nodes, namespaced by extension, and pushes values', () => {
    const ext: STTMaterialExtension = {
      name: 'glow',
      uniforms: [
        { name: 'gain', value: 1 },
        { name: 'tint', value: [1, 0, 0] },
      ],
      transformColor: (c, ctx) => c.mul(ctx.uniform('gain')),
    };
    const bundle = createPointMaterial({ mode: 'window', extensions: [ext] });
    const resolved = bundle.extensions!;
    expect([...resolved.uniforms.keys()].sort()).toEqual([
      'glow.gain',
      'glow.tint',
    ]);
    expect(resolved.uniforms.get('glow.gain')!.value).toBe(1);

    updateExtensionUniforms(resolved, {
      'glow.gain': 0.25,
      'glow.tint': [0, 1, 0],
    });
    expect(resolved.uniforms.get('glow.gain')!.value).toBe(0.25);
    expect(resolved.uniforms.get('glow.tint')!.value.toArray()).toEqual([
      0, 1, 0,
    ]);

    // Tolerant of the un-extended case, so a host can call it unconditionally.
    expect(() =>
      updateExtensionUniforms(undefined, { 'x.y': 1 }),
    ).not.toThrow();
    // …but loud about a typo'd key.
    expect(() => setExtensionUniform(resolved, 'glow.gian', 1)).toThrow(
      /no extension uniform/,
    );
  });

  it('is loud about an undeclared attribute or uniform read', () => {
    const badAttr: STTMaterialExtension = {
      name: 'x',
      transformColor: (c, ctx) => c.mul(ctx.attribute('sttNope')),
    };
    expect(() =>
      createPointMaterial({ mode: 'window', extensions: [badAttr] }),
    ).toThrow(/was not declared/);

    const badUniform: STTMaterialExtension = {
      name: 'x',
      transformColor: (c, ctx) => c.mul(ctx.uniform('nope')),
    };
    expect(() =>
      createPointMaterial({ mode: 'window', extensions: [badUniform] }),
    ).toThrow(/undeclared uniform/);
  });

  it('rejects a hook that returns nothing', () => {
    const ext = {
      name: 'void',
      transformColor: () => undefined,
    } as unknown as STTMaterialExtension;
    expect(() =>
      createPointMaterial({ mode: 'window', extensions: [ext] }),
    ).toThrow(/must return a node/);
  });

  it('composes several extensions in order, folding one hook into the next', () => {
    const order: string[] = [];
    const first: STTMaterialExtension = {
      name: 'first',
      transformAlpha: (a) => {
        order.push('first');
        return a.mul(float(0.5));
      },
    };
    const second: STTMaterialExtension = {
      name: 'second',
      transformAlpha: (a) => {
        order.push('second');
        return a.mul(float(0.5));
      },
    };
    const bundle = createPolygonMaterial({
      mode: 'window',
      extensions: [first, second],
    });
    expect(order).toEqual(['first', 'second']);
    bundle.time.currentTime.value = 50;
    bundle.time.windowHalf.value = 10;
    // 0.8 (colour alpha) × 0.5 × 0.5 — the fold really chained.
    expect(
      evalNode(bundle.material.opacityNode, {
        sttColor: [0, 0, 0, 0.8],
        sttStart: 0,
        sttEnd: 100,
      }),
    ).toBeCloseTo(0.2, 10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the by-kind registry reaches a SHIPPED layer', () => {
  it('registers, lists and unregisters', () => {
    const ext: STTMaterialExtension = { name: 'r', transformColor: (c) => c };
    const off = registerSTTExtension('point', ext);
    expect(listSTTExtensions('point')).toEqual([ext]);
    // Registering twice is idempotent — a double-register cannot duplicate a hook.
    registerSTTExtension('point', ext);
    expect(listSTTExtensions('point')).toHaveLength(1);
    off();
    expect(listSTTExtensions('point')).toEqual([]);
    expect(unregisterSTTExtension('point', ext)).toBe(false);
  });

  it('a registered extension composes into a factory that was passed nothing', () => {
    const marker = uniform(9001);
    registerSTTExtension('column', markerExtension('position', marker));
    expect(materialTouches(createColumnMaterial(), marker)).toBe(true);
    // …including the id material, which the shipped layers build separately.
    expect(materialTouches(createColumnIdMaterial(), marker)).toBe(true);
    // A different kind is untouched.
    expect(
      materialTouches(createPointMaterial({ mode: 'window' }), marker),
    ).toBe(false);
  });

  it('changes what an STTPointLayer actually draws', () => {
    const marker = uniform(9002);
    registerSTTExtension('point', markerExtension('size', marker));

    const layer = new STTPointLayer({ id: 'ext-points', mode: 'window' });
    const projection = new LocalEnuProjection({
      longitude: -73.98,
      latitude: 40.75,
    });
    layer.setTiles([makePointTile(2, [-73.98, 40.75, -73.97, 40.76])], {
      projection,
      timeOrigin: 0,
    });

    const material: any = layer.object.material;
    expect(contains(material.vertexNode, marker)).toBe(true);
    layer.dispose();
  });

  it('a layer built BEFORE registration is not retro-extended (materials are cached)', () => {
    const projection = new LocalEnuProjection({
      longitude: -73.98,
      latitude: 40.75,
    });
    const tiles = [makePointTile(1, [-73.98, 40.75])];
    const layer = new STTPointLayer({ id: 'early', mode: 'window' });
    layer.setTiles(tiles, { projection, timeOrigin: 0 });

    const marker = uniform(9003);
    registerSTTExtension('point', markerExtension('size', marker));
    layer.setTiles(tiles, { projection, timeOrigin: 0 });

    expect(contains((layer.object.material as any).vertexNode, marker)).toBe(
      false,
    );
    layer.dispose();
  });
});
