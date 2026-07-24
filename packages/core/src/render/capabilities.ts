// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * STT backend capability contract — the single source of truth for the
 * cross-backend vocabulary (LayerKind / Capability / TimeFilterMode) + the
 * declare-and-prove machinery that replaces the hand-maintained "MUST match"
 * parity table (see docs/roadmap/renderer-architecture.md).
 *
 * Following the repo's proven idiom (palette-parity: plain shared TS unions +
 * `tsc` break-on-rename, NOT a codegen pipeline — the critic flagged codegen as
 * over-machined here), the vocabulary is a frozen `as const` array. Every backend
 * imports these unions, so renaming a token is a compile break everywhere.
 *
 * `TimeFilterMode` is re-exported from `./time-filter` so there is exactly ONE
 * definition of the animation modes.
 */

import type { TimeFilterMode } from './time-filter.js';
import type { ViewState } from '../geo/view-state.js';
import type { SttPickResult } from './picking.js';

export type { TimeFilterMode };

/** The visualization layer families a backend may support. Frozen — a rename breaks tsc everywhere. */
export const LAYER_KINDS = [
  'point',
  'path',
  'polygon',
  'arc',
  'line',
  'icon',
  'column',
  'trips',
  'tripHeads',
  'boundingBox',
  'surfel',
  'heatmap',
  'h3Summary',
  'quadbinSummary',
  'flowmap',
  'flowCorridor',
  'flowStroke',
  'isoLines',
  'ego',
  'text',
  'mesh',
  'pointCloud',
  'hexbin',
] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];

/** Cross-cutting capabilities a backend either has or must degrade. */
export const CAPABILITIES = [
  'globe',
  'picking',
  'extrude3d',
  'metricSizing',
  'gpuHeatmap',
  'liveBundling',
  'timeAsHeight',
  'interleavedBasemap',
  'userExtensions',
  'cameraRoll',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Whether a backend supports a layer kind, and if not, how it degrades. */
export type LayerKindSupport =
  | { supported: true }
  | { supported: false; fallbackKind?: LayerKind; reason: string };

/**
 * A typed, machine-checkable outcome when a request exceeds a backend's
 * capabilities — replacing the silent no-op that hides maplibre's missing
 * wake/cumulative today. Includes a first-class `fallbackMode` axis (§5.5).
 */
export type Degradation =
  | { action: 'fallback'; toKind: LayerKind; lost: Capability[] }
  | {
      action: 'fallbackMode';
      fromMode: TimeFilterMode;
      toMode: TimeFilterMode;
      lost: Capability[];
    }
  | { action: 'skip'; reason: string }
  | { action: 'throw'; reason: string };

/**
 * What a backend DECLARES about itself. `assertDescriptorConsistent` refuses to
 * let it claim a capability/kind/mode with no passing conformance case, so the
 * generated `docs/spec/backend-capabilities.md` cannot lie.
 */
export interface BackendDescriptor {
  readonly id: string;
  readonly capabilities: Readonly<Record<Capability, boolean>>;
  readonly timeFilterModes: readonly TimeFilterMode[];
  readonly layerKinds: Readonly<Record<LayerKind, LayerKindSupport>>;
  /** Does this backend project lon/lat→world on the CPU (three, Cesium) vs on the GPU against a host viewport (deck)? */
  readonly projectsOnCpu: boolean;
  /** One tileset shared across layers (deck/three) vs one archive per layer (maplibre). */
  readonly tilesetOwnership: 'per-layer' | 'shared';
  readonly pickMechanism: 'gpu-id' | 'cpu-ray' | 'id-fbo' | 'host' | 'none';
  /** Can it interleave into the basemap's GL context, or does it need a synced overlay (three/WebGPU)? */
  readonly interleavedBasemap: boolean;
  /** Basemap projection the backend drives against (maplibre v4 = mercator-only). */
  readonly basemapProjection: 'mercator' | 'globe';
}

/**
 * The ONLY shared runtime shape — duck-typed, NOT a base class. A three `SttLayer`,
 * a deck sublayer wrapper, a maplibre `STTBaseLayer`, a Cesium `Primitive` all
 * satisfy it. `index` in a returned {@link SttPickResult} joins to columns via
 * `getFeatureProperties(binary, index)`.
 */
export interface SttRenderNode {
  readonly id: string;
  setTime(absoluteMs: number): void;
  setViewState?(v: ViewState): void;
  pick?(
    cssX: number,
    cssY: number,
    o?: { mode?: 'hover' | 'click' },
  ): SttPickResult | null | Promise<SttPickResult | null>;
  dispose(): void;
}

/**
 * Resolve how a backend handles a requested `(kind, mode)`: `null` when fully
 * supported, else a typed {@link Degradation}. Kind support is checked first
 * (an unsupported kind can't render regardless of mode), then the mode.
 */
export function degradeRequest(
  d: BackendDescriptor,
  kind: LayerKind,
  mode: TimeFilterMode = 'window',
): Degradation | null {
  const support = d.layerKinds[kind];
  if (!support?.supported) {
    const reason =
      support?.reason ?? `backend ${d.id} does not support layer kind ${kind}`;
    if (support && support.supported === false && support.fallbackKind) {
      return { action: 'fallback', toKind: support.fallbackKind, lost: [] };
    }
    return { action: 'skip', reason };
  }
  if (mode !== 'none' && !d.timeFilterModes.includes(mode)) {
    // Fall back to a supported mode (prefer 'window', else the first available).
    const toMode = d.timeFilterModes.includes('window')
      ? 'window'
      : (d.timeFilterModes[0] ?? 'none');
    return { action: 'fallbackMode', fromMode: mode, toMode, lost: [] };
  }
  return null;
}

/** Conformance evidence: the capabilities/kinds/modes a backend has a passing test for. */
export interface ConformanceEvidence {
  capabilities: ReadonlySet<Capability>;
  layerKinds: ReadonlySet<LayerKind>;
  timeFilterModes: ReadonlySet<TimeFilterMode>;
}

/**
 * The over-claim gate (graft from Proposal 3): return the list of violations
 * where a descriptor CLAIMS something with no passing conformance case. Empty ⇒
 * consistent. A backend NOT claiming support is legal (it degrades). Wire into CI
 * so a lying/drifting descriptor fails the build.
 */
export function assertDescriptorConsistent(
  d: BackendDescriptor,
  proven: ConformanceEvidence,
): string[] {
  const violations: string[] = [];
  for (const cap of CAPABILITIES) {
    if (d.capabilities[cap] && !proven.capabilities.has(cap)) {
      violations.push(
        `${d.id}: claims capability "${cap}" but no passing conformance case`,
      );
    }
  }
  for (const kind of LAYER_KINDS) {
    if (d.layerKinds[kind]?.supported && !proven.layerKinds.has(kind)) {
      violations.push(
        `${d.id}: claims layer kind "${kind}" but no passing conformance case`,
      );
    }
  }
  for (const mode of d.timeFilterModes) {
    if (!proven.timeFilterModes.has(mode)) {
      violations.push(
        `${d.id}: claims time-filter mode "${mode}" but no passing conformance case`,
      );
    }
  }
  return violations;
}
