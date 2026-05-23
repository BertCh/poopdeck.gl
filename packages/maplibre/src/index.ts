/**
 * @stt/maplibre — MapLibre GL custom-layer adapter for STT archives.
 *
 * This is a minimal scaffold: it streams tiles from `STTArchive` based on the
 * map's viewport + a caller-controlled current time, and draws points with
 * raw WebGL. Paths and polygons are out of scope for the scaffold; the goal
 * is to prove the data path and let users extend the shader.
 *
 * For full GPU time filtering, fading, and per-vertex trails, use
 * `@stt/deck.gl`. This adapter exists for sites that don't want a deck.gl
 * dependency or that need to interleave STT data between native MapLibre
 * layers.
 */

import type { CustomLayerInterface, Map as MaplibreMap, LngLatBounds } from 'maplibre-gl';
import {
  STTArchive,
  SpatiotemporalTileset,
  type BoundingBox,
  type Tile,
  type TileId,
} from '@stt/core';

export interface STTMaplibreLayerOptions {
  /** Layer id (any unique string). */
  id: string;
  /** URL of the .stt archive. */
  url: string;
  /** Current time in Unix milliseconds. Update from outside per frame. */
  currentTime: number;
  /** Half-window for the time filter, in milliseconds. */
  timeWindow: number;
  /** Point color [r, g, b, a] in 0–1 floats. */
  color?: [number, number, number, number];
  /** Point radius in pixels. */
  radius?: number;
}

/**
 * MapLibre custom layer that renders STT point tiles.
 *
 * Usage:
 * ```ts
 * const layer = new STTMaplibreLayer({ id: 'eq', url: '/data/earthquakes.stt',
 *   currentTime: Date.now(), timeWindow: 60_000 });
 * map.addLayer(layer);
 * // Update the time each frame:
 * function tick() { layer.setCurrentTime(performance.now() + offset); map.triggerRepaint(); }
 * ```
 */
export class STTMaplibreLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map?: MaplibreMap;
  private gl?: WebGL2RenderingContext;
  private program?: WebGLProgram | null;
  private vao?: WebGLVertexArrayObject | null;
  private positionBuffer?: WebGLBuffer | null;
  private timeBuffer?: WebGLBuffer | null;
  private uniformLocations: Record<string, WebGLUniformLocation | null> = {};
  private archive: STTArchive;
  private tileset?: SpatiotemporalTileset;
  private loadedTiles = new Map<string, Tile>();
  private opts: Required<STTMaplibreLayerOptions>;

  constructor(opts: STTMaplibreLayerOptions) {
    this.id = opts.id;
    this.opts = {
      color: [0.31, 0.76, 0.97, 1.0],
      radius: 4,
      ...opts,
    } as Required<STTMaplibreLayerOptions>;
    this.archive = new STTArchive({ url: opts.url });
  }

  /** Update the time the next frame's filter compares against. */
  setCurrentTime(t: number): void {
    this.opts.currentTime = t;
  }

  onAdd(map: MaplibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('STTMaplibreLayer requires a WebGL2 context');
    }
    this.map = map;
    this.gl = gl;
    this.compileProgram(gl);
    this.tileset = new SpatiotemporalTileset({
      getAvailableTiles: async (bounds, zoom, timeRange) =>
        this.archive.getTileIdsInBounds(bounds, zoom, timeRange),
      getTileData: async (id: TileId) => this.archive.getTile(id),
      onTileLoad: (tile) => {
        this.loadedTiles.set(`${tile.id.z}/${tile.id.x}/${tile.id.y}/${tile.id.t}`, tile);
        this.map?.triggerRepaint();
      },
      onTileUnload: (tile) => {
        this.loadedTiles.delete(`${tile.id.z}/${tile.id.x}/${tile.id.y}/${tile.id.t}`);
      },
    });
  }

  onRemove(): void {
    this.tileset?.finalize();
    this.archive.finalize();
    const gl = this.gl;
    if (!gl) return;
    if (this.program) gl.deleteProgram(this.program);
    if (this.positionBuffer) gl.deleteBuffer(this.positionBuffer);
    if (this.timeBuffer) gl.deleteBuffer(this.timeBuffer);
    if (this.vao) gl.deleteVertexArray(this.vao);
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, matrix: Iterable<number>): void {
    if (!(gl instanceof WebGL2RenderingContext)) return;
    if (!this.program || !this.tileset || !this.map) return;
    const m = matrix instanceof Float32Array ? matrix : new Float32Array(Array.from(matrix));

    // Drive the tileset from the current viewport + time.
    const bounds = this.map.getBounds();
    const zoom = Math.floor(this.map.getZoom());
    const t = this.opts.currentTime;
    this.tileset.update({
      bounds: toBoundsArray(bounds),
      zoom,
      time: t,
      timeWindow: this.opts.timeWindow,
    });

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniformLocations.uMatrix!, false, m);
    gl.uniform4fv(this.uniformLocations.uColor!, this.opts.color);
    gl.uniform1f(this.uniformLocations.uRadius!, this.opts.radius);
    gl.uniform1f(this.uniformLocations.uCurrentTime!, t);
    gl.uniform1f(this.uniformLocations.uHalfWindow!, this.opts.timeWindow / 2);

    // One draw call per tile — fine for the scaffold; consolidate later.
    for (const tile of this.loadedTiles.values()) {
      for (const layer of tile.layers) {
        const f = layer.features;
        if (!f.positions?.length) continue;
        this.uploadAndDraw(gl, f.positions, f.startTimes, f.endTimes, f.timeOffset);
      }
    }
  }

  private uploadAndDraw(
    gl: WebGL2RenderingContext,
    positions: Float64Array | Float32Array,
    startTimes: Float32Array,
    endTimes: Float32Array,
    timeOffset: number,
  ): void {
    // MapLibre's matrix expects mercator-projected coords. We pass lon/lat and
    // do the projection in the shader for the scaffold; production code should
    // pre-project on the CPU using maplibre's Mercator helpers.
    const lonLat = positions instanceof Float32Array ? positions : new Float32Array(positions);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer!);
    gl.bufferData(gl.ARRAY_BUFFER, lonLat, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    // Pack [startTime, endTime] interleaved.
    const times = new Float32Array(startTimes.length * 2);
    for (let i = 0; i < startTimes.length; i++) {
      times[i * 2] = startTimes[i] + timeOffset;
      times[i * 2 + 1] = endTimes[i] + timeOffset;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.timeBuffer!);
    gl.bufferData(gl.ARRAY_BUFFER, times, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.POINTS, 0, startTimes.length);
  }

  private compileProgram(gl: WebGL2RenderingContext): void {
    const vs = `#version 300 es
      precision highp float;
      layout(location = 0) in vec3 aLngLatAlt;
      layout(location = 1) in vec2 aTime;
      uniform mat4 uMatrix;
      uniform float uRadius;
      uniform float uCurrentTime;
      uniform float uHalfWindow;
      out float vAlpha;
      // Project lon/lat (degrees) to MapLibre's mercator [0,1] then to clip space.
      vec2 toMercator(vec2 ll) {
        float x = ll.x / 360.0 + 0.5;
        float lat = clamp(ll.y, -85.0511, 85.0511);
        float y = 0.5 - log(tan((90.0 + lat) * 3.14159265 / 360.0)) / (2.0 * 3.14159265);
        return vec2(x, y);
      }
      void main() {
        vec2 m = toMercator(aLngLatAlt.xy);
        gl_Position = uMatrix * vec4(m, 0.0, 1.0);
        gl_PointSize = uRadius * 2.0;
        float wStart = uCurrentTime - uHalfWindow;
        float wEnd = uCurrentTime + uHalfWindow;
        vAlpha = (aTime.y < wStart || aTime.x > wEnd) ? 0.0 : 1.0;
      }`;
    const fs = `#version 300 es
      precision highp float;
      uniform vec4 uColor;
      in float vAlpha;
      out vec4 fragColor;
      void main() {
        if (vAlpha <= 0.0) discard;
        vec2 d = gl_PointCoord - vec2(0.5);
        if (dot(d, d) > 0.25) discard;
        fragColor = vec4(uColor.rgb, uColor.a * vAlpha);
      }`;
    const compile = (type: number, source: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, source);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('shader compile failed: ' + gl.getShaderInfoLog(sh));
      }
      return sh;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('program link failed: ' + gl.getProgramInfoLog(program));
    }
    this.program = program;
    this.uniformLocations = {
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uColor: gl.getUniformLocation(program, 'uColor'),
      uRadius: gl.getUniformLocation(program, 'uRadius'),
      uCurrentTime: gl.getUniformLocation(program, 'uCurrentTime'),
      uHalfWindow: gl.getUniformLocation(program, 'uHalfWindow'),
    };
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.positionBuffer = gl.createBuffer()!;
    this.timeBuffer = gl.createBuffer()!;
  }
}

function toBoundsArray(b: LngLatBounds): BoundingBox {
  return {
    minLon: b.getWest(),
    minLat: b.getSouth(),
    maxLon: b.getEast(),
    maxLat: b.getNorth(),
  };
}
