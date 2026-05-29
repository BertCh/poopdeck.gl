/**
 * Density-heatmap adapter — renders POINT-type tiles as a screen-space
 * heatmap. Equivalent to `@stt/deck.gl`'s `HeatmapTimeLayer`.
 *
 * Pipeline (two passes):
 *
 *   1. Accumulate pass: each visible point is splatted into an offscreen
 *      framebuffer as a Gaussian disc with additive blending. The
 *      framebuffer holds the accumulated intensity per screen pixel in the
 *      R channel (and a weighted version in G if a `weightProperty` is
 *      configured — keeping them separate avoids saturating the colour
 *      lookup).
 *
 *   2. Colour-ramp pass: a full-screen quad samples the accumulator with a
 *      256×1 RGBA palette texture (default = OrRd, matches the deck.gl
 *      adapter's `HeatmapLayer` defaults).
 *
 * Performance notes:
 *   - We render directly with `gl.POINTS` and rely on the GPU's `gl_PointSize`
 *     to size each splat. This is the same trick deck.gl's `HeatmapLayer`
 *     uses internally and keeps memory bandwidth low.
 *   - The accumulator texture is allocated lazily and resized whenever the
 *     `drawingBuffer{Width,Height}` changes. The framebuffer is recreated on
 *     resize because some drivers don't support framebuffer texture
 *     reattachment.
 */

import type { Tile, Layer as STTLayer } from '@stt/core';
import { GeometryType } from '@stt/core';
import {
  STTBaseLayer,
  type STTBaseLayerOptions,
  type DrawContext,
  type TileGpuCache,
  type RGBA8,
} from './base-layer';
import { TIME_WINDOW_GLSL } from './shaders/time-window.glsl';

export interface STTHeatmapLayerOptions extends STTBaseLayerOptions {
  /** Splat radius in pixels. */
  radiusPixels?: number;
  /** Intensity multiplier per point. */
  intensity?: number;
  /**
   * 0–255 RGBA colour ramp, sampled by intensity. Length 2–256. Default is a
   * 7-stop OrRd ramp matching the deck.gl adapter.
   */
  colorRange?: ReadonlyArray<RGBA8>;
  /**
   * Per-feature weight property name (defaults to constant 1 per point). Used
   * for analyses where each point has a magnitude/score.
   */
  weightProperty?: string;
  /**
   * Threshold below which accumulated intensity is rendered fully
   * transparent. 0 = no threshold; 0.05 hides faint regions and keeps the
   * heat tightly localised. Default 0.05.
   */
  threshold?: number;
  /**
   * Pinned `[min, max]` accumulated-intensity domain mapped onto the colour
   * ramp. When unset, the layer uses `metadata.heatmapDomain` (class `default`)
   * if the archive carries one (`stt-build --heatmap-weight`), else `[0, 1]`.
   * Mirrors the deck.gl HeatmapLayer's `colorDomain` so a weighted heatmap
   * scales the same on both adapters instead of washing out on maplibre.
   */
  colorDomain?: [number, number];
}

const DEFAULT_COLOR_RANGE: ReadonlyArray<RGBA8> = [
  [255, 255, 178, 255],
  [254, 217, 118, 255],
  [254, 178, 76, 255],
  [253, 141, 60, 255],
  [252, 78, 42, 255],
  [227, 26, 28, 255],
  [177, 0, 38, 255],
];

const ACCUM_VS = `
  precision highp float;
  attribute vec3 aMercator;
  attribute vec2 aTime;
  attribute float aWeight;
  uniform mat4 uMatrix;
  uniform float uRadius;
  uniform float uWindowStart;
  uniform float uWindowEnd;
  uniform float uFadeIn;
  uniform float uFadeOut;
  varying float vWeight;
${TIME_WINDOW_GLSL}
  void main() {
    gl_Position = uMatrix * vec4(aMercator.x, aMercator.y, 0.0, 1.0);
    gl_PointSize = uRadius * 2.0;
    vWeight = aWeight * sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut);
  }
`;

const ACCUM_FS = `
  precision highp float;
  uniform float uIntensity;
  varying float vWeight;
  void main() {
    if (vWeight <= 0.0) discard;
    vec2 d = gl_PointCoord - vec2(0.5);
    float r2 = dot(d, d) * 4.0;
    if (r2 > 1.0) discard;
    // Gaussian falloff: σ² ≈ 0.15 → tight, bright core.
    float falloff = exp(-r2 / 0.15);
    float v = falloff * vWeight * uIntensity;
    gl_FragColor = vec4(v, v, v, v);
  }
`;

const RAMP_VS = `
  precision highp float;
  attribute vec2 aPos; // -1..1 fullscreen quad
  varying vec2 vUv;
  void main() {
    vUv = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
  }
`;

const RAMP_FS = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uAccum;
  uniform sampler2D uPalette;
  uniform float uThreshold;
  // [min, max] accumulated-intensity range mapped onto the palette. Defaults
  // to [0, 1] (identity). When the archive carries a bake-time heatmap domain
  // (metadata.heatmapDomain) or the caller pins colorDomain, the accumulator
  // is remapped so a weighted heatmap (large weightProperty values) isn't
  // washed-out/saturated — matching the deck.gl adapter's colorDomain.
  uniform float uDomainMin;
  uniform float uDomainMax;
  void main() {
    float intensity = texture2D(uAccum, vUv).r;
    if (intensity <= uThreshold) discard;
    float span = max(uDomainMax - uDomainMin, 1e-6);
    float t = clamp((intensity - uDomainMin) / span, 0.0, 1.0);
    vec4 ramp = texture2D(uPalette, vec2(t, 0.5));
    gl_FragColor = vec4(ramp.rgb, ramp.a * smoothstep(uThreshold, uThreshold + 0.05, intensity));
  }
`;

interface AccumProgramHandles {
  program: WebGLProgram;
  aMercator: number;
  aTime: number;
  aWeight: number;
  uMatrix: WebGLUniformLocation | null;
  uRadius: WebGLUniformLocation | null;
  uIntensity: WebGLUniformLocation | null;
  uWindowStart: WebGLUniformLocation | null;
  uWindowEnd: WebGLUniformLocation | null;
  uFadeIn: WebGLUniformLocation | null;
  uFadeOut: WebGLUniformLocation | null;
}

interface RampProgramHandles {
  program: WebGLProgram;
  aPos: number;
  uAccum: WebGLUniformLocation | null;
  uPalette: WebGLUniformLocation | null;
  uThreshold: WebGLUniformLocation | null;
  uDomainMin: WebGLUniformLocation | null;
  uDomainMax: WebGLUniformLocation | null;
}

interface HeatmapGpuCache extends TileGpuCache {
  weightBuffer?: WebGLBuffer;
}

/** Resolved accumulator-texture format, decided once per layer. */
interface AccumFormat {
  /** internalFormat for texImage2D (RGBA / RGBA16F / RGBA32F). */
  internalFormat: number;
  /** format for texImage2D. */
  format: number;
  /** type for texImage2D (UNSIGNED_BYTE / HALF_FLOAT / FLOAT). */
  type: number;
  /** Pretty label, for logging only. */
  label: 'RGBA8' | 'RGBA16F' | 'RGBA32F';
}

export class STTHeatmapLayer extends STTBaseLayer {
  private heatOpts: Required<
    Pick<STTHeatmapLayerOptions, 'radiusPixels' | 'intensity' | 'threshold'>
  > & {
    colorRange: ReadonlyArray<RGBA8>;
    weightProperty?: string;
    colorDomain?: [number, number];
  };
  private accum?: AccumProgramHandles;
  private ramp?: RampProgramHandles;

  // FBO state — lazily allocated on first frame, resized when the drawing
  // buffer changes.
  private fbo?: WebGLFramebuffer;
  private accumTexture?: WebGLTexture;
  private accumWidth = 0;
  private accumHeight = 0;
  /**
   * Internal format probe result. RGBA8 saturates at ~255 splats per pixel,
   * which is easy to hit on dense events (rideshare in Manhattan, eqs near
   * the Pacific Rim). When the runtime supports a half-float colour buffer
   * (WebGL2 `EXT_color_buffer_half_float` / WebGL1 + OES_texture_half_float),
   * we allocate `RGBA16F` and the additive blend has ~65k headroom per
   * channel. Falls back to `RGBA8` everywhere else — heatmaps still render,
   * just with the historical saturation behaviour.
   *
   * `null` = uninitialized; resolved on first `ensureAccumFramebuffer`.
   */
  private accumFormat: AccumFormat | null = null;

  // 256×1 RGBA palette texture sampled by accumulated intensity.
  private paletteTexture?: WebGLTexture;

  // Fullscreen quad VBO (4 verts, two triangles via triangle-strip).
  private quadBuffer?: WebGLBuffer;

  constructor(opts: STTHeatmapLayerOptions) {
    super(opts);
    this.heatOpts = {
      radiusPixels: opts.radiusPixels ?? 30,
      intensity: opts.intensity ?? 1,
      threshold: opts.threshold ?? 0.05,
      colorRange: opts.colorRange ?? DEFAULT_COLOR_RANGE,
      weightProperty: opts.weightProperty,
      colorDomain: opts.colorDomain,
    };
  }

  /**
   * Resolve the accumulated-intensity domain mapped onto the colour ramp:
   * the explicit `colorDomain` prop, else the archive's bake-time
   * `metadata.heatmapDomain` (class `default`), else the identity `[0, 1]`.
   */
  private resolveColorDomain(): [number, number] {
    if (this.heatOpts.colorDomain) return this.heatOpts.colorDomain;
    const classes = this.metadata?.heatmapDomain?.classes;
    if (classes && classes.length > 0) {
      const def = classes.find((c) => c.id === 'default') ?? classes[0];
      if (def && Number.isFinite(def.min) && Number.isFinite(def.max)) {
        return [def.min, def.max];
      }
    }
    return [0, 1];
  }

  /** Replace the colour ramp at runtime. */
  setColorRange(range: ReadonlyArray<RGBA8>): void {
    this.heatOpts.colorRange = range;
    // Force a palette texture rebuild on next draw.
    if (this.gl && this.paletteTexture) {
      this.uploadPalette(this.gl);
    }
    this.map?.triggerRepaint();
  }

  /** Replace the splat radius (px) at runtime. */
  setRadius(radiusPixels: number): void {
    this.heatOpts.radiusPixels = radiusPixels;
    this.map?.triggerRepaint();
  }

  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.Point;
  }

  protected onContextReady(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    const accumProgram = this.linkProgram(gl, ACCUM_VS, ACCUM_FS);
    this.accum = {
      program: accumProgram,
      aMercator: gl.getAttribLocation(accumProgram, 'aMercator'),
      aTime: gl.getAttribLocation(accumProgram, 'aTime'),
      aWeight: gl.getAttribLocation(accumProgram, 'aWeight'),
      uMatrix: gl.getUniformLocation(accumProgram, 'uMatrix'),
      uRadius: gl.getUniformLocation(accumProgram, 'uRadius'),
      uIntensity: gl.getUniformLocation(accumProgram, 'uIntensity'),
      uWindowStart: gl.getUniformLocation(accumProgram, 'uWindowStart'),
      uWindowEnd: gl.getUniformLocation(accumProgram, 'uWindowEnd'),
      uFadeIn: gl.getUniformLocation(accumProgram, 'uFadeIn'),
      uFadeOut: gl.getUniformLocation(accumProgram, 'uFadeOut'),
    };
    const rampProgram = this.linkProgram(gl, RAMP_VS, RAMP_FS);
    this.ramp = {
      program: rampProgram,
      aPos: gl.getAttribLocation(rampProgram, 'aPos'),
      uAccum: gl.getUniformLocation(rampProgram, 'uAccum'),
      uPalette: gl.getUniformLocation(rampProgram, 'uPalette'),
      uThreshold: gl.getUniformLocation(rampProgram, 'uThreshold'),
      uDomainMin: gl.getUniformLocation(rampProgram, 'uDomainMin'),
      uDomainMax: gl.getUniformLocation(rampProgram, 'uDomainMax'),
    };

    // Fullscreen quad (triangle strip).
    this.quadBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );

    // Palette texture (256×1 RGBA).
    this.paletteTexture = gl.createTexture()!;
    this.uploadPalette(gl);
  }

  protected onContextLost(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (this.accum) {
      gl.deleteProgram(this.accum.program);
      this.accum = undefined;
    }
    if (this.ramp) {
      gl.deleteProgram(this.ramp.program);
      this.ramp = undefined;
    }
    if (this.quadBuffer) {
      gl.deleteBuffer(this.quadBuffer);
      this.quadBuffer = undefined;
    }
    if (this.paletteTexture) {
      gl.deleteTexture(this.paletteTexture);
      this.paletteTexture = undefined;
    }
    if (this.fbo) {
      gl.deleteFramebuffer(this.fbo);
      this.fbo = undefined;
    }
    if (this.accumTexture) {
      gl.deleteTexture(this.accumTexture);
      this.accumTexture = undefined;
    }
    this.accumWidth = 0;
    this.accumHeight = 0;
  }

  /**
   * Pre-multiply each feature's weight and stash it as a Float32 attribute.
   * Falls back to a constant 1.0 buffer when no weightProperty is set.
   */
  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    _tile: Tile,
    layer: STTLayer,
  ): HeatmapGpuCache | null {
    const baseCache = super.buildTileGpuCache(gl, _tile, layer);
    if (!baseCache) return null;
    const cache: HeatmapGpuCache = baseCache as HeatmapGpuCache;
    const f = layer.features;
    const n = f.featureCount;
    const weights = new Float32Array(n);
    if (this.heatOpts.weightProperty) {
      const src = this.getNumericProperty(f, this.heatOpts.weightProperty);
      if (src) {
        for (let i = 0; i < n; i++) weights[i] = src[i];
      } else {
        weights.fill(1);
      }
    } else {
      weights.fill(1);
    }
    cache.weightBuffer = this.uploadArrayBuffer(gl, weights);
    cache.extraBuffers = [
      ...(baseCache.extraBuffers ?? []),
      cache.weightBuffer,
    ];
    return cache;
  }

  /**
   * Heatmap rendering replaces the base render() entirely — we need to wrap
   * the per-tile splats in an FBO bind/unbind and then a fullscreen colour-
   * ramp pass.
   */
  render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    matrix: Iterable<number>,
  ): void {
    if (!this.tileset || !this.map) return;
    if (!this.accum || !this.ramp || !this.paletteTexture || !this.quadBuffer) {
      return;
    }

    const map = this.map;
    const m =
      matrix instanceof Float32Array
        ? matrix
        : new Float32Array(Array.from(matrix));
    const bounds = map.getBounds();
    const zoom = Math.floor(map.getZoom());
    const currentTime = this.opts.currentTime;

    this.tileset.update({
      bounds: {
        minLon: bounds.getWest(),
        minLat: bounds.getSouth(),
        maxLon: bounds.getEast(),
        maxLat: bounds.getNorth(),
      },
      zoom,
      time: currentTime,
      timeWindow: this.opts.timeWindow,
    });

    this.ensureAccumFramebuffer(gl);

    const w = this.accumWidth;
    const h = this.accumHeight;
    if (w === 0 || h === 0) return;

    // ---- Pass 1: accumulate intensity into FBO ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo!);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // additive
    gl.disable(gl.DEPTH_TEST);

    const ah = this.accum;
    gl.useProgram(ah.program);
    gl.uniformMatrix4fv(ah.uMatrix, false, m);
    gl.uniform1f(ah.uRadius, this.heatOpts.radiusPixels);
    gl.uniform1f(ah.uIntensity, this.heatOpts.intensity);
    const { fadeIn, fadeOut } = this.resolveFadeDurations();
    gl.uniform1f(ah.uFadeIn, fadeIn);
    gl.uniform1f(ah.uFadeOut, fadeOut);

    for (const tile of this.loadedTiles.values()) {
      for (const layer of tile.layers) {
        if (!this.acceptsGeometry(layer.features.geometryType)) continue;
        const cache = this.ensureTileGpuCache(gl, tile, layer) as
          | HeatmapGpuCache
          | null;
        if (!cache) continue;
        const ctx: DrawContext = {
          matrix: m,
          currentTime,
          zoom,
          windowStart:
            currentTime - cache.timeOffset - this.opts.timeWindow / 2,
          windowEnd:
            currentTime - cache.timeOffset + this.opts.timeWindow / 2,
        };
        gl.uniform1f(ah.uWindowStart, ctx.windowStart);
        gl.uniform1f(ah.uWindowEnd, ctx.windowEnd);

        // VAO captures position/time/weight attribute state on first frame.
        this.bindVaoOrSetup(cache, () => {
          gl.bindBuffer(gl.ARRAY_BUFFER, cache.positionBuffer);
          gl.enableVertexAttribArray(ah.aMercator);
          gl.vertexAttribPointer(ah.aMercator, 3, gl.FLOAT, false, 0, 0);

          gl.bindBuffer(gl.ARRAY_BUFFER, cache.timeBuffer);
          gl.enableVertexAttribArray(ah.aTime);
          gl.vertexAttribPointer(ah.aTime, 2, gl.FLOAT, false, 0, 0);

          if (cache.weightBuffer && ah.aWeight >= 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, cache.weightBuffer);
            gl.enableVertexAttribArray(ah.aWeight);
            gl.vertexAttribPointer(ah.aWeight, 1, gl.FLOAT, false, 0, 0);
          }
        });

        gl.drawArrays(gl.POINTS, 0, cache.vertexCount);
      }
    }
    // Unbind before pass 2 — the fullscreen quad uses a different VBO and
    // shouldn't inherit any per-tile attribute state.
    this.unbindVao();

    // ---- Pass 2: colour-ramp lookup against the default framebuffer ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const rh = this.ramp;
    gl.useProgram(rh.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(rh.aPos);
    gl.vertexAttribPointer(rh.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accumTexture!);
    gl.uniform1i(rh.uAccum, 0);
    gl.activeTexture(gl.TEXTURE0 + 1);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
    gl.uniform1i(rh.uPalette, 1);
    gl.uniform1f(rh.uThreshold, this.heatOpts.threshold);
    const [domainMin, domainMax] = this.resolveColorDomain();
    gl.uniform1f(rh.uDomainMin, domainMin);
    gl.uniform1f(rh.uDomainMax, domainMax);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.disableVertexAttribArray(rh.aPos);
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * Unused — heatmap overrides `render()` entirely. Declared so the abstract
   * base class is happy.
   */
  protected drawTile(): void {
    /* no-op */
  }

  // --------------------------------------------------------------------------
  // FBO + palette helpers
  // --------------------------------------------------------------------------

  private ensureAccumFramebuffer(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    const w = gl.drawingBufferWidth | 0;
    const h = gl.drawingBufferHeight | 0;
    if (w === this.accumWidth && h === this.accumHeight && this.fbo) return;

    if (!this.accumFormat) this.accumFormat = this.probeAccumFormat(gl);

    // Drop the old FBO + texture.
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.accumTexture) gl.deleteTexture(this.accumTexture);
    this.fbo = gl.createFramebuffer()!;
    this.accumTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.accumTexture);
    const fmt = this.accumFormat;
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      fmt.internalFormat,
      w,
      h,
      0,
      fmt.format,
      fmt.type,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.accumTexture,
      0,
    );
    // Some drivers refuse RGBA16F as colour-renderable even after advertising
    // the extension. Verify completeness and degrade to RGBA8 if the FBO is
    // unusable. Future allocations skip the probe by reusing the demoted
    // accumFormat.
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE && fmt.label !== 'RGBA8') {
      gl.deleteFramebuffer(this.fbo);
      gl.deleteTexture(this.accumTexture);
      this.accumFormat = {
        internalFormat: gl.RGBA,
        format: gl.RGBA,
        type: gl.UNSIGNED_BYTE,
        label: 'RGBA8',
      };
      this.fbo = undefined;
      this.accumTexture = undefined;
      // Recursively retry with the demoted format.
      this.accumWidth = 0;
      this.accumHeight = 0;
      this.ensureAccumFramebuffer(gl);
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.accumWidth = w;
    this.accumHeight = h;
  }

  /**
   * Resolve the best available colour-renderable RGBA format. We prefer
   * RGBA16F (~65k splats/pixel headroom, the deck.gl heatmap default on
   * modern hardware) and fall back through RGBA8 (~255 splats — the legacy
   * behaviour). RGBA32F is intentionally skipped: extra precision is not
   * useful for this accumulator and many drivers either don't expose it as
   * colour-renderable or refuse to blend it.
   */
  private probeAccumFormat(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): AccumFormat {
    const isWebGL2 =
      typeof WebGL2RenderingContext !== 'undefined' &&
      gl instanceof WebGL2RenderingContext;
    if (isWebGL2) {
      // WebGL2 path: requires EXT_color_buffer_half_float (or
      // EXT_color_buffer_float, which is a superset). RGBA16F internalFormat
      // is in core; only the colour-renderable property comes from the ext.
      const gl2 = gl as WebGL2RenderingContext;
      const hasHalf =
        !!gl.getExtension('EXT_color_buffer_half_float') ||
        !!gl.getExtension('EXT_color_buffer_float');
      if (hasHalf) {
        return {
          internalFormat: (gl2 as unknown as { RGBA16F: number }).RGBA16F,
          format: gl.RGBA,
          type: (gl2 as unknown as { HALF_FLOAT: number }).HALF_FLOAT,
          label: 'RGBA16F',
        };
      }
    } else {
      // WebGL1 path: OES_texture_half_float gives us HALF_FLOAT_OES as the
      // texture data type. The colour-renderable property comes from
      // EXT_color_buffer_half_float (separate from the texture ext). When
      // both are present, RGBA + HALF_FLOAT_OES is renderable.
      const halfTex = gl.getExtension('OES_texture_half_float') as {
        HALF_FLOAT_OES: number;
      } | null;
      const halfRender = gl.getExtension('EXT_color_buffer_half_float');
      if (halfTex && halfRender) {
        return {
          internalFormat: gl.RGBA,
          format: gl.RGBA,
          type: halfTex.HALF_FLOAT_OES,
          label: 'RGBA16F',
        };
      }
    }
    return {
      internalFormat: gl.RGBA,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      label: 'RGBA8',
    };
  }

  private uploadPalette(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (!this.paletteTexture) return;
    const range = this.heatOpts.colorRange;
    const data = new Uint8Array(256 * 4);
    // Linear interpolation between stops to fill 256 entries.
    for (let i = 0; i < 256; i++) {
      const t = (i / 255) * (range.length - 1);
      const a = Math.floor(t);
      const b = Math.min(range.length - 1, a + 1);
      const f = t - a;
      const ca = range[a];
      const cb = range[b];
      data[i * 4] = Math.round(ca[0] * (1 - f) + cb[0] * f);
      data[i * 4 + 1] = Math.round(ca[1] * (1 - f) + cb[1] * f);
      data[i * 4 + 2] = Math.round(ca[2] * (1 - f) + cb[2] * f);
      data[i * 4 + 3] = Math.round((ca[3] ?? 255) * (1 - f) + (cb[3] ?? 255) * f);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      256,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
}
