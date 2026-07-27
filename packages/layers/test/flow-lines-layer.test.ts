/**
 * FlowLinesLayer — tapered half-arrow primitive (flowmap.gl port).
 *
 * The geometry/shaders need a GPU device, so these tests cover the device-free
 * surface: the 9-vertex arrow template, the instanced-attribute wiring
 * (`initializeState`), the default props, the uniforms `draw()` publishes, and
 * — since there is no GLSL runtime under vitest — the load-bearing SHAPE of the
 * vertex shader itself (the zero-width exemption, the clip→CSS-pixel
 * conversion, the picking calls). The deck.gl/luma imports are mocked so the
 * module loads without a real device.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@deck.gl/core', () => ({
  // FlowLinesLayer extends Layer; the test instances are built via
  // Object.create so the base ctor never runs. `getShaders` mirrors deck's
  // pass-through so a test can read the assembled vs/fs.
  Layer: class {
    getShaders(opts: any) {
      return opts;
    }
  },
  project32: { name: 'project32' },
  picking: { name: 'picking' },
}));

vi.mock('@luma.gl/engine', () => ({
  Model: class {},
  Geometry: class {},
}));

import {
  FlowLinesLayer,
  ARROW_TEMPLATE_POSITIONS,
} from '../src/layers/internal/flow-lines-layer';

/** The assembled vertex shader source, without needing a device. */
function vertexShader(): string {
  const layer = Object.create(FlowLinesLayer.prototype);
  return layer.getShaders().vs as string;
}

describe('FlowLinesLayer', () => {
  it('arrow template is 9 vertices (3 triangles) of (mix, perp, travel)', () => {
    expect(ARROW_TEMPLATE_POSITIONS.length).toBe(27); // 9 verts × 3 components
    // The .x (mix) of every vertex is 0 (source) or 1 (target).
    for (let v = 0; v < 9; v++) {
      const mix = ARROW_TEMPLATE_POSITIONS[v * 3];
      expect(mix === 0 || mix === 1).toBe(true);
    }
    // Half-arrow: every perpendicular offset is on one side (≥ 0).
    for (let v = 0; v < 9; v++) {
      expect(ARROW_TEMPLATE_POSITIONS[v * 3 + 1]).toBeGreaterThanOrEqual(0);
    }
    // The arrowhead flares to perp 2 and is pulled back along travel (−3).
    const maxPerp = Math.max(
      ...Array.from(
        { length: 9 },
        (_, v) => ARROW_TEMPLATE_POSITIONS[v * 3 + 1],
      ),
    );
    const minTravel = Math.min(
      ...Array.from(
        { length: 9 },
        (_, v) => ARROW_TEMPLATE_POSITIONS[v * 3 + 2],
      ),
    );
    expect(maxPerp).toBe(2);
    expect(minTravel).toBe(-3);
  });

  it('registers the instanced attributes (positions, width, endpoint offsets)', () => {
    const added: Record<string, any> = {};
    const fakeAM = {
      addInstanced: (attrs: Record<string, any>) => Object.assign(added, attrs),
    };
    const layer = Object.create(FlowLinesLayer.prototype);
    layer.getAttributeManager = () => fakeAM;
    layer.use64bitPositions = () => false;
    layer.initializeState();

    expect(added.instanceSourcePositions.accessor).toBe('getSourcePosition');
    expect(added.instanceTargetPositions.accessor).toBe('getTargetPosition');
    expect(added.instanceSourcePositions.size).toBe(3);
    // Width is a single per-instance pixel value.
    expect(added.instanceWidth.accessor).toBe('getWidth');
    expect(added.instanceWidth.size).toBe(1);
    // Endpoint insets are a vec2 [sourceInset, targetInset].
    expect(added.instanceEndpointOffsets.accessor).toBe('getEndpointOffsets');
    expect(added.instanceEndpointOffsets.size).toBe(2);
  });

  it('defaults: gap 0.5, endpoint offsets [0,0], colors present', () => {
    const dp = FlowLinesLayer.defaultProps as any;
    expect(dp.gap.value).toBe(0.5);
    expect(dp.getEndpointOffsets.value).toEqual([0, 0]);
    expect(dp.sourceColor.value).toHaveLength(4);
    expect(dp.targetColor.value).toHaveLength(4);
    expect(FlowLinesLayer.layerName).toBe('FlowLinesLayer');
  });

  describe('width', () => {
    it('exempts ZERO-width instances from the widthMinPixels clamp', () => {
      // FlowmapLayer writes width 0 for corridors below `minFlow` and BOTH its
      // prop doc and the call site promise they vanish. An unconditional
      // `clamp(instanceWidth, widthMinPixels, ...)` lifted them back to
      // widthMinPixels (≥ 0.6 in every showcase config), so every corridor
      // rendered permanently and scrubbing only modulated thickness on a
      // static full mesh. BundledFlowLinesLayer.edgeWidth() returns 0.0 before
      // clamping; this shader must do the same.
      const vs = vertexShader();
      expect(vs).toMatch(/float w = instanceWidth <= 0\.0\s*\n\s*\?\s*0\.0/);
      // …and there must be no clamp of the raw width outside that guard.
      expect(vs).not.toMatch(/clamp\(\s*instanceWidth\s*,/);
    });

    it('declares widthUnits / widthScale so _subLayerProps can reach them', () => {
      const dp = FlowLinesLayer.defaultProps as any;
      // Absent from defaultProps, deck accepted and silently discarded them.
      expect(dp.widthUnits).toBe('pixels');
      expect(dp.widthScale.value).toBe(1);
      // The shader has to actually consume both.
      expect(vertexShader()).toMatch(
        /project_size_to_pixel\(instanceWidth \* flowLines\.widthScale, flowLines\.widthUnits\)/,
      );
    });

    it('publishes widthScale + the deck UNIT code as uniforms', () => {
      const capture: any[] = [];
      const layer = Object.create(FlowLinesLayer.prototype);
      layer.props = {
        sourceColor: [0, 0, 0, 255],
        targetColor: [255, 255, 255, 255],
        widthScale: 3,
        widthUnits: 'meters',
        widthMinPixels: 2,
        widthMaxPixels: 9,
        gap: 0.5,
      };
      layer.context = { renderPass: {} };
      layer.state = {
        model: {
          shaderInputs: { setProps: (p: any) => capture.push(p) },
          draw: () => {},
        },
      };
      layer.draw();
      const u = capture[0].flowLines;
      expect(u.widthScale).toBe(3);
      expect(u.widthUnits).toBe(1); // UNIT.meters (deck lib/constants.ts)
      expect(u.widthMinPixels).toBe(2);
      expect(u.widthMaxPixels).toBe(9);

      // 'pixels' is the default and must map to UNIT.pixels, not 0.
      capture.length = 0;
      layer.props.widthUnits = 'pixels';
      layer.draw();
      expect(capture[0].flowLines.widthUnits).toBe(2);
    });
  });

  describe('screen-space length', () => {
    // `lenPx` bounds the arrowhead pull-back AND both endpoint insets, so
    // unlike deck's LineLayer (which only normalizes the same delta) its
    // MAGNITUDE has to be right in the units the rest of the shader uses.
    it('perspective-divides both endpoints before measuring', () => {
      const vs = vertexShader();
      expect(vs).toMatch(/source\.xy \/ max\(source\.w, 1e-4\)/);
      expect(vs).toMatch(/target\.xy \/ max\(target\.w, 1e-4\)/);
      // The old undivided form must be gone.
      expect(vs).not.toMatch(
        /\(target\.xy - source\.xy\) \* project\.viewportSize/,
      );
    });

    it('converts DEVICE pixels back to the CSS pixels every other length uses', () => {
      // project.viewportSize is [w·DPR, h·DPR], while widths, travel and
      // instanceEndpointOffsets — and project_pixel_size_to_clipspace's input —
      // are CSS px. Without the DPR divide a 10 CSS-px corridor reported
      // lenPx = 20 on a retina display, so the 0.8·lenPx pull-back guard
      // allowed 16 CSS px of travel on a 10 px line.
      expect(vertexShader()).toMatch(
        /project\.viewportSize \/ \(2\.0 \* project\.devicePixelRatio\)/,
      );
    });

    it('CSS-pixel conversion arithmetic: DPR cancels out', () => {
      // Mirror of the shader expression, evaluated on the CPU: a corridor
      // spanning 10 CSS px must measure 10 at any device pixel ratio.
      const lenPx = (dpr: number): number => {
        const viewportW = 800 * dpr; // project.viewportSize.x
        const cssPxPerNdc = viewportW / (2 * dpr);
        // 10 CSS px of an 800 CSS px viewport = 0.025 of NDC's [-1,1] span.
        const deltaNdc = (10 / 800) * 2;
        return deltaNdc * cssPxPerNdc;
      };
      expect(lenPx(1)).toBeCloseTo(10, 9);
      expect(lenPx(2)).toBeCloseTo(10, 9);
      expect(lenPx(3)).toBeCloseTo(10, 9);
    });
  });

  it('propagates the picking DEPTH as well as the picking color', () => {
    // The docstring claimed both; only the color call existed. Deck injects
    // the depth at vs:DECKGL_FILTER_GL_POSITION, which this custom-Model layer
    // deliberately does not use — so it must call it itself, and (matching
    // deck's order) before the color call.
    const vs = vertexShader();
    const depthAt = vs.indexOf('picking_setPickingAttribute(');
    const colorAt = vs.indexOf('picking_setPickingColor(');
    expect(depthAt).toBeGreaterThan(-1);
    expect(vs).toMatch(
      /picking_setPickingAttribute\(gl_Position\.z \/ gl_Position\.w\)/,
    );
    expect(depthAt).toBeLessThan(colorAt);
  });
});
