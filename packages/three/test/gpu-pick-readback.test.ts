// @poopdeck.gl/three
// SPDX-License-Identifier: MIT

// Unit test for the GpuPicker render/readback PLUMBING (the half of the fixed
// real-readback bug that was previously browser-verify-only). No GPU device: we
// inject a stub `PickRenderer` whose `readRenderTargetPixelsAsync` RETURNS a
// hand-built pixel buffer (the exact seam of the bug — the old code passed a
// buffer as `textureIndex` and read back all-zeros, decoding every pick to 0).
// We drive the pixel -> id resolution and assert: a written id colour decodes
// back to its feature index, the sentinel/clear background resolves to a miss,
// feature index 0 stays a valid hit vs the background, and the cursor pixel
// coords / Y-flip / sync clear-colour save-restore ordering are honoured.

import { describe, it, expect } from 'vitest';
import {
  GpuPicker,
  encodeId,
  decodeId,
  MAX_PICK_ID,
  type PickRenderer,
  type RenderTargetCtor,
} from '../src/lib/gpu-pick';

/** Stand-in for three's `RenderTarget` — the picker only news it + `dispose()`s it. */
class FakeRenderTarget {
  disposed = false;
  constructor(
    public width: number,
    public height: number,
    public options?: unknown,
  ) {}
  dispose(): void {
    this.disposed = true;
  }
}

/**
 * Build an RGBA8 readback buffer of `size * size` texels with a distinct filler
 * everywhere except the CENTRE texel, which carries `rgb`. The filler lets a
 * `size > 1` case prove the picker samples the centre, not texel 0.
 */
function pixelsWithCenter(
  size: number,
  rgb: readonly [number, number, number],
): Uint8Array {
  const buf = new Uint8Array(size * size * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 9;
    buf[i + 1] = 8;
    buf[i + 2] = 7; // filler decodes to a different id than any tested centre
    buf[i + 3] = 255;
  }
  const ci = (Math.floor(size / 2) * size + Math.floor(size / 2)) * 4;
  buf[ci] = rgb[0];
  buf[ci + 1] = rgb[1];
  buf[ci + 2] = rgb[2];
  buf[ci + 3] = 255;
  return buf;
}

interface HarnessOptions {
  dpr?: number;
  canvasWidth?: number;
  canvasHeight?: number;
  pixels: Uint8Array;
  /** Add the optional clear-colour save/restore methods. */
  withClearColor?: boolean;
}

const SAVED_COLOR_MARKER = { savedClearColor: true };
const SAVED_ALPHA = 0.5;

function makeHarness(opts: HarnessOptions) {
  const dpr = opts.dpr ?? 1;
  const canvasWidth = opts.canvasWidth ?? 100;
  const canvasHeight = opts.canvasHeight ?? 100;

  const state = {
    log: [] as string[],
    readbackArgs: null as null | {
      target: unknown;
      x: number;
      y: number;
      w: number;
      h: number;
    },
    readbackArgCount: 0,
    createdTargets: [] as FakeRenderTarget[],
    setClearColorCalls: [] as Array<{
      color: unknown;
      alpha: number | undefined;
    }>,
    // Captured `Camera.setViewOffset(fullW, fullH, offX, offY, w, h)` args — the
    // seam that maps a cursor position to the pick target's sub-region.
    viewOffsetArgs: null as null | {
      fullW: number;
      fullH: number;
      offX: number;
      offY: number;
      w: number;
      h: number;
    },
    viewOffsetCleared: false,
  };

  let currentTarget: unknown = null;

  const renderer: PickRenderer = {
    domElement: {
      width: canvasWidth,
      height: canvasHeight,
    } as unknown as HTMLCanvasElement,
    getPixelRatio: () => dpr,
    getRenderTarget: () => currentTarget,
    setRenderTarget: (t: unknown) => {
      currentTarget = t;
      const label =
        t === null
          ? 'null'
          : t instanceof FakeRenderTarget
            ? 'pickTarget'
            : 'other';
      state.log.push(`setRenderTarget:${label}`);
    },
    render: () => {
      state.log.push('render');
    },
    // The unified renderer RETURNS the pixels; the picker must consume this value
    // (NOT a pre-allocated out buffer). We capture the full arg list so a stray
    // 6th/7th arg (the old bug) would be visible.
    readRenderTargetPixelsAsync: async (...args: unknown[]) => {
      state.log.push('readback');
      state.readbackArgCount = args.length;
      state.readbackArgs = {
        target: args[0],
        x: args[1] as number,
        y: args[2] as number,
        w: args[3] as number,
        h: args[4] as number,
      };
      return opts.pixels;
    },
  };

  if (opts.withClearColor) {
    renderer.getClearColor = () => {
      state.log.push('getClearColor');
      return SAVED_COLOR_MARKER;
    };
    renderer.getClearAlpha = () => SAVED_ALPHA;
    renderer.setClearColor = (color: unknown, alpha?: number) => {
      const label = color === SAVED_COLOR_MARKER ? 'saved' : String(color);
      state.log.push(`setClearColor:${label}`);
      state.setClearColorCalls.push({ color, alpha });
    };
  }

  const TargetCtor = class extends FakeRenderTarget {
    constructor(w: number, h: number, o?: unknown) {
      super(w, h, o);
      state.createdTargets.push(this);
    }
  } as unknown as RenderTargetCtor;

  // Fake camera exposing the `setViewOffset` / `clearViewOffset` seam the picker
  // uses to steer the tiny target at the cursor's sub-region.
  const camera = {
    setViewOffset: (
      fullW: number,
      fullH: number,
      offX: number,
      offY: number,
      w: number,
      h: number,
    ) => {
      state.log.push('setViewOffset');
      state.viewOffsetArgs = { fullW, fullH, offX, offY, w, h };
      state.viewOffsetCleared = false;
    },
    clearViewOffset: () => {
      state.log.push('clearViewOffset');
      state.viewOffsetCleared = true;
    },
  };

  return { renderer, TargetCtor, camera, state };
}

describe('GpuPicker readback: pixel -> id resolution', () => {
  it('(a) resolves a written id colour back to the correct feature index', async () => {
    const id = 0x0130a5; // arbitrary in-range 24-bit index
    const h = makeHarness({ pixels: pixelsWithCenter(1, encodeId(id)) });
    const picker = new GpuPicker(h.renderer, h.TargetCtor);
    const result = await picker.pick({}, {}, 10, 10, { featureCount: id + 1 });
    expect(result).toBe(id);
  });

  it('(a) samples the CENTRE texel of a multi-pixel readback square', async () => {
    // The filler texels around the centre decode to a different id, so a wrong
    // (e.g. texel-0) sample would fail this.
    const id = 4242;
    const h = makeHarness({ pixels: pixelsWithCenter(3, encodeId(id)) });
    const picker = new GpuPicker(h.renderer, h.TargetCtor, 3);
    const result = await picker.pick({}, {}, 50, 50, { featureCount: 10_000 });
    expect(result).toBe(id);
  });

  it('(b) reports the sentinel background (white / 0xffffff) as a miss (null)', async () => {
    // The id pass clears to the white sentinel; white decodes to MAX_PICK_ID,
    // which is >= any real featureCount, so an empty pixel is a miss.
    expect(decodeId([255, 255, 255])).toBe(MAX_PICK_ID);
    const h = makeHarness({ pixels: pixelsWithCenter(1, [255, 255, 255]) });
    const picker = new GpuPicker(h.renderer, h.TargetCtor);
    const result = await picker.pick({}, {}, 10, 10, { featureCount: 500 });
    expect(result).toBeNull();
  });

  it('(c) keeps feature index 0 (black) a valid hit while the white sentinel misses', async () => {
    const featureCount = 10;
    const black = makeHarness({ pixels: pixelsWithCenter(1, [0, 0, 0]) });
    const white = makeHarness({ pixels: pixelsWithCenter(1, [255, 255, 255]) });
    const hit = await new GpuPicker(black.renderer, black.TargetCtor).pick(
      {},
      {},
      0,
      0,
      {
        featureCount,
      },
    );
    const miss = await new GpuPicker(white.renderer, white.TargetCtor).pick(
      {},
      {},
      0,
      0,
      {
        featureCount,
      },
    );
    expect(hit).toBe(0);
    expect(miss).toBeNull();
  });

  it('treats index === featureCount as a miss but featureCount-1 as a hit (>= boundary)', async () => {
    const fc = 100;
    const hitH = makeHarness({ pixels: pixelsWithCenter(1, encodeId(fc - 1)) });
    const missH = makeHarness({ pixels: pixelsWithCenter(1, encodeId(fc)) });
    expect(
      await new GpuPicker(hitH.renderer, hitH.TargetCtor).pick({}, {}, 0, 0, {
        featureCount: fc,
      }),
    ).toBe(fc - 1);
    expect(
      await new GpuPicker(missH.renderer, missH.TargetCtor).pick({}, {}, 0, 0, {
        featureCount: fc,
      }),
    ).toBeNull();
  });

  it('without featureCount, returns the raw decoded index even for the sentinel', async () => {
    // No miss-clamping when the caller does not supply a count.
    const h = makeHarness({ pixels: pixelsWithCenter(1, [255, 255, 255]) });
    const picker = new GpuPicker(h.renderer, h.TargetCtor);
    expect(await picker.pick({}, {}, 0, 0)).toBe(MAX_PICK_ID);
  });
});

describe('GpuPicker readback: plumbing (regression for the fixed real-readback bug)', () => {
  it('passes exactly (target, x, y, w, h) and consumes the RETURN value — no output-buffer arg', async () => {
    const id = 77;
    const h = makeHarness({ pixels: pixelsWithCenter(1, encodeId(id)) });
    const picker = new GpuPicker(h.renderer, h.TargetCtor);
    const result = await picker.pick({}, {}, 5, 5, { featureCount: 1000 });
    expect(result).toBe(id); // proves the returned buffer was decoded, not zeros
    expect(h.state.readbackArgCount).toBe(5); // no 6th `textureIndex`/`out` arg
    // The pick target (not the restored prevTarget) is read back explicitly.
    expect(h.state.readbackArgs?.target).toBe(h.state.createdTargets[0]);
  });

  it('reads back from origin (0,0) — always in target bounds — and steers the frustum via setViewOffset at the cursor', async () => {
    const h = makeHarness({
      dpr: 1,
      canvasWidth: 160,
      canvasHeight: 100,
      pixels: pixelsWithCenter(1, encodeId(1)),
    });
    await new GpuPicker(h.renderer, h.TargetCtor).pick({}, h.camera, 20, 30, {
      featureCount: 10,
    });
    // The readback origin is (0,0) for the whole size×size target — NOT the raw
    // cursor device coords (which would blow past a 1×1 target's bounds). The
    // cursor is placed in the frustum via setViewOffset instead.
    expect(h.state.readbackArgs).toMatchObject({ x: 0, y: 0, w: 1, h: 1 });
    // Read origin within [0, size): the pre-fix bug read at full-canvas coords.
    expect(h.state.readbackArgs!.x).toBeGreaterThanOrEqual(0);
    expect(h.state.readbackArgs!.x).toBeLessThan(1);
    expect(h.state.readbackArgs!.y).toBeGreaterThanOrEqual(0);
    expect(h.state.readbackArgs!.y).toBeLessThan(1);
    // setViewOffset(fullW=canvas.width, fullH=canvas.height, offX=cursorX,
    // offY=cursorY, size, size). For a 1×1 target half=0 so the offset IS the
    // cursor device pixel (top-left origin, no Y-flip). dpr=1: cursor=(20,30).
    expect(h.state.viewOffsetArgs).toEqual({
      fullW: 160,
      fullH: 100,
      offX: 20,
      offY: 30,
      w: 1,
      h: 1,
    });
    expect(h.state.viewOffsetCleared).toBe(true);
  });

  it('scales the cursor sub-region offset by device-pixel-ratio', async () => {
    const h = makeHarness({
      dpr: 2,
      canvasWidth: 320,
      canvasHeight: 200,
      pixels: pixelsWithCenter(1, encodeId(1)),
    });
    await new GpuPicker(h.renderer, h.TargetCtor).pick({}, h.camera, 20, 30, {
      featureCount: 10,
    });
    // Full drawing buffer = canvas.width/height (already device px); cursor =
    // css * dpr = (40, 60). Readback stays at the in-bounds origin.
    expect(h.state.readbackArgs).toMatchObject({ x: 0, y: 0, w: 1, h: 1 });
    expect(h.state.viewOffsetArgs).toEqual({
      fullW: 320,
      fullH: 200,
      offX: 40,
      offY: 60,
      w: 1,
      h: 1,
    });
  });

  it('centres a multi-pixel sub-region on the cursor and keeps the readback origin in bounds', async () => {
    const size = 3;
    const h = makeHarness({
      dpr: 1,
      canvasWidth: 200,
      canvasHeight: 200,
      pixels: pixelsWithCenter(size, encodeId(1)),
    });
    await new GpuPicker(h.renderer, h.TargetCtor, size).pick(
      {},
      h.camera,
      50,
      50,
      { featureCount: 10 },
    );
    // half = (3-1)/2 = 1, so the size×size window's top-left is cursor - 1, which
    // puts the cursor on the CENTRE texel (the pixel the decode samples).
    expect(h.state.viewOffsetArgs).toEqual({
      fullW: 200,
      fullH: 200,
      offX: 49,
      offY: 49,
      w: size,
      h: size,
    });
    // Reads the FULL target from (0,0); origin + extent stay within [0, size].
    expect(h.state.readbackArgs).toMatchObject({
      x: 0,
      y: 0,
      w: size,
      h: size,
    });
    expect(
      h.state.readbackArgs!.x + h.state.readbackArgs!.w,
    ).toBeLessThanOrEqual(size);
    expect(
      h.state.readbackArgs!.y + h.state.readbackArgs!.h,
    ).toBeLessThanOrEqual(size);
  });

  it('restores render target + clear colour SYNCHRONOUSLY, before the async readback yields', async () => {
    const h = makeHarness({
      pixels: pixelsWithCenter(1, encodeId(3)),
      withClearColor: true,
    });
    const picker = new GpuPicker(h.renderer, h.TargetCtor);
    const result = await picker.pick({}, h.camera, 5, 5, {
      featureCount: 10,
      onBeforeRender: () => h.state.log.push('onBefore'),
      onAfterRender: () => h.state.log.push('onAfter'),
    });
    expect(result).toBe(3);
    // The readback ('readback') is LAST: the view-offset + target + clear-colour
    // restore and onAfterRender all run in the synchronous `finally`, before the
    // await. clearViewOffset MUST precede the readback so the live camera isn't
    // left with the pick offset applied if a concurrent render fires.
    expect(h.state.log).toEqual([
      'getClearColor',
      'setClearColor:16777215', // SENTINEL_CLEAR = 0xffffff
      'onBefore',
      'setViewOffset', // frustum steered onto the cursor sub-region
      'setRenderTarget:pickTarget',
      'render',
      'setRenderTarget:null', // prevTarget restored (was null)
      'clearViewOffset', // view offset cleared before the await
      'setClearColor:saved', // saved clear colour restored
      'onAfter',
      'readback',
    ]);
    expect(h.state.viewOffsetCleared).toBe(true);
    // The saved alpha (0.5), not the sentinel's 1, is what gets restored.
    expect(h.state.setClearColorCalls[0]).toEqual({
      color: 0xffffff,
      alpha: 1,
    });
    expect(h.state.setClearColorCalls[1]).toEqual({
      color: SAVED_COLOR_MARKER,
      alpha: SAVED_ALPHA,
    });
  });

  it('drives the decode path with a minimal renderer lacking clear-colour methods', async () => {
    // getClearColor/setClearColor are optional; a lightweight mock still resolves.
    const id = 512;
    const h = makeHarness({ pixels: pixelsWithCenter(1, encodeId(id)) });
    expect(h.renderer.getClearColor).toBeUndefined();
    const result = await new GpuPicker(h.renderer, h.TargetCtor).pick(
      {},
      {},
      5,
      5,
      {
        featureCount: 1000,
      },
    );
    expect(result).toBe(id);
  });

  it('disposes the lazily-created id render target', async () => {
    const h = makeHarness({ pixels: pixelsWithCenter(1, encodeId(1)) });
    const picker = new GpuPicker(h.renderer, h.TargetCtor);
    await picker.pick({}, {}, 0, 0, { featureCount: 10 });
    expect(h.state.createdTargets).toHaveLength(1);
    expect(h.state.createdTargets[0].disposed).toBe(false);
    picker.dispose();
    expect(h.state.createdTargets[0].disposed).toBe(true);
  });
});
