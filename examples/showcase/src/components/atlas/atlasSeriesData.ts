/**
 * Activation-over-token series for the Neural-State Atlas.
 *
 * Transformer depth used to be the map's Z axis, which is what produced the
 * 1,250:1 needles the first build rendered. Depth is now a *chart*: the layer ×
 * token strip below is the same information, legible, at 390 kB, and it costs
 * the geometry nothing.
 *
 * Three products, all on the one token clock:
 *
 *   • {@link decodeGrid}    — layer × token mean activation, quantised u8 over
 *     log1p and carried inline in the sidecar.
 *   • {@link decodeSeries}  — the global activity waveform, same encoding.
 *   • {@link fetchNodeSeries} — one latent's whole session, read with a single
 *     HTTP Range request against a node-indexed CSR blob. 2.6 M events do not
 *     belong in the app bundle, and a click should not wait for them.
 *
 * The quantisation is log1p-companded because activation is heavy-tailed
 * (p50 2.1, p99 32.8, max 173): a linear u8 would spend 98% of its codes on the
 * top 2% of the range and the strip would read as black.
 */
import type { AtlasQuantized, AtlasNodeSeriesSpec } from './atlasTypes';

/** base64 → the bytes it encodes. */
function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Undo the u8/log1p companding. */
function expand(bytes: Uint8Array, scale: number): Float32Array {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    out[i] = Math.expm1((bytes[i] / 255) * scale);
  }
  return out;
}

export interface AtlasGrid {
  rows: number;
  cols: number;
  /** Row-major, `rows × cols`. */
  values: Float32Array;
  max: number;
}

/** Sidecar `series.layer_token` → a row-major grid. */
export function decodeGrid(spec: AtlasQuantized | undefined): AtlasGrid | null {
  if (!spec?.data) return null;
  const values = expand(decodeBase64(spec.data), spec.scale);
  let max = 0;
  for (let i = 0; i < values.length; i += 1) if (values[i] > max) max = values[i];
  return { rows: spec.rows ?? 1, cols: spec.cols ?? values.length, values, max };
}

/** Sidecar `series.activity` → one series. */
export function decodeSeries(spec: AtlasQuantized | undefined): Float32Array | null {
  if (!spec?.data) return null;
  return expand(decodeBase64(spec.data), spec.scale);
}

export interface NodeSeries {
  nodeId: number;
  /** Token index of each event, ascending. */
  tokens: Uint16Array;
  activation: Float32Array;
  attribution: Float32Array;
}

/**
 * The node → offset table. ~1.2 MB, fetched once on the first inspection and
 * then reused; it is deliberately a separate file so the first click pays for
 * the index and a 200-byte range, not for the 16 MB body.
 */
let offsetsPromise: Promise<Uint32Array> | null = null;

function loadOffsets(spec: AtlasNodeSeriesSpec, resolve: (p: string) => string) {
  offsetsPromise ??= fetch(resolve(spec.index_url))
    .then((r) => {
      if (!r.ok) throw new Error(`node index ${r.status}`);
      return r.arrayBuffer();
    })
    .then((b) => new Uint32Array(b));
  return offsetsPromise;
}

/** Reset between builds — the offsets are only valid for one archive. */
export function resetNodeSeriesCache(): void {
  offsetsPromise = null;
}

/**
 * One latent's activation across the whole reading session.
 *
 * Returns `null` rather than throwing when the range request is unsupported or
 * the node has no events: an inspection panel that loses its sparkline is a
 * degraded panel, not a broken page.
 */
export async function fetchNodeSeries(
  nodeId: number,
  spec: AtlasNodeSeriesSpec,
  resolve: (p: string) => string,
  signal?: AbortSignal,
): Promise<NodeSeries | null> {
  try {
    const offsets = await loadOffsets(spec, resolve);
    if (nodeId < 0 || nodeId + 1 >= offsets.length) return null;
    const from = offsets[nodeId];
    const to = offsets[nodeId + 1];
    if (to <= from) {
      return {
        nodeId,
        tokens: new Uint16Array(0),
        activation: new Float32Array(0),
        attribution: new Float32Array(0),
      };
    }
    const rec = spec.record_bytes;
    const res = await fetch(resolve(spec.series_url), {
      signal,
      headers: { Range: `bytes=${from * rec}-${to * rec - 1}` },
    });
    if (!res.ok) throw new Error(`node series ${res.status}`);
    const buf = await res.arrayBuffer();
    // A server that ignores Range answers 200 with the whole body. Slice the
    // window ourselves rather than mis-reading the head of the file as this
    // node's events.
    const view =
      res.status === 206
        ? new DataView(buf)
        : new DataView(buf, from * rec, (to - from) * rec);
    const count = to - from;
    const tokens = new Uint16Array(count);
    const activation = new Float32Array(count);
    const attribution = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      const o = i * rec;
      tokens[i] = view.getUint16(o, true);
      activation[i] = (view.getUint16(o + 2, true) / 65535) * spec.activation_scale;
      attribution[i] = (view.getInt16(o + 4, true) / 32767) * spec.attribution_scale;
    }
    return { nodeId, tokens, activation, attribution };
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return null;
    console.warn('[atlas] node series unavailable', err);
    return null;
  }
}

/** Scatter a sparse node series onto a dense per-token array for drawing. */
export function densify(
  series: NodeSeries,
  cols: number,
  metric: 'activation' | 'attribution',
): Float32Array {
  const out = new Float32Array(cols);
  const src = metric === 'attribution' ? series.attribution : series.activation;
  for (let i = 0; i < series.tokens.length; i += 1) {
    const t = series.tokens[i];
    if (t < cols) out[t] = src[i];
  }
  return out;
}
