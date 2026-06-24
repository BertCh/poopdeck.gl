import { describe, it, expect } from 'vitest';
import { PerspectiveCamera } from 'three';
import { MercatorProjection } from '../src/projection/mercator';
import { viewStateToCamera } from '../src/projection/view-state';
import { BasemapOverlay, type BasemapLike } from '../src/scene/basemap-overlay';

interface JumpArgs {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

class MockMap implements BasemapLike {
  jumps: JumpArgs[] = [];
  resized = 0;
  removed = 0;
  private canvas = {} as HTMLCanvasElement;
  jumpTo(opts: JumpArgs) {
    this.jumps.push(opts);
    return this;
  }
  getCanvas() {
    return this.canvas;
  }
  resize() {
    this.resized++;
  }
  remove() {
    this.removed++;
  }
  get last(): JumpArgs {
    return this.jumps[this.jumps.length - 1];
  }
}

const anchor = { longitude: -73.98, latitude: 40.75 };

function cameraAt(vs: { longitude: number; latitude: number; zoom: number; pitch?: number; bearing?: number }) {
  const proj = new MercatorProjection(anchor);
  const camera = new PerspectiveCamera(50, 1, 0.1, 1e9);
  camera.up.set(0, 0, 1);
  viewStateToCamera(proj, vs, camera);
  return { proj, camera };
}

describe('BasemapOverlay', () => {
  it('jumpTo receives the camera view state on sync', () => {
    const want = { longitude: -73.98, latitude: 40.75, zoom: 12, pitch: 30, bearing: 45 };
    const { proj, camera } = cameraAt(want);
    const map = new MockMap();
    const overlay = new BasemapOverlay(map, proj, camera);

    overlay.sync();

    expect(map.jumps.length).toBe(1);
    expect(map.last.center[0]).toBeCloseTo(want.longitude, 3);
    expect(map.last.center[1]).toBeCloseTo(want.latitude, 3);
    expect(map.last.zoom).toBeCloseTo(want.zoom, 3);
    expect(map.last.pitch).toBeCloseTo(want.pitch, 3);
    expect(map.last.bearing).toBeCloseTo(want.bearing, 3);
  });

  it('does not sync while detached, and snaps on attach', () => {
    const { proj, camera } = cameraAt({ longitude: -73.98, latitude: 40.75, zoom: 10 });
    const map = new MockMap();
    const overlay = new BasemapOverlay(map, proj, camera, { enabled: false });

    expect(overlay.isAttached).toBe(false);
    overlay.sync();
    expect(map.jumps.length).toBe(0);

    overlay.attach();
    expect(overlay.isAttached).toBe(true);
    expect(map.jumps.length).toBe(1); // attach() snaps immediately

    overlay.detach();
    overlay.sync();
    expect(map.jumps.length).toBe(1); // frozen while detached
  });

  it('tracks the camera as it moves', () => {
    const proj = new MercatorProjection(anchor);
    const camera = new PerspectiveCamera(50, 1, 0.1, 1e9);
    camera.up.set(0, 0, 1);
    viewStateToCamera(proj, { longitude: -73.98, latitude: 40.75, zoom: 11 }, camera);
    const map = new MockMap();
    const overlay = new BasemapOverlay(map, proj, camera);

    overlay.sync();
    const z0 = map.last.zoom;

    // Re-place the camera at a deeper zoom; the next sync should report it.
    viewStateToCamera(proj, { longitude: -73.98, latitude: 40.75, zoom: 14 }, camera);
    overlay.sync();
    expect(map.last.zoom).toBeGreaterThan(z0);
    expect(map.last.zoom).toBeCloseTo(14, 3);
  });

  it('exposes the host canvas and forwards resize', () => {
    const { proj, camera } = cameraAt({ longitude: -73.98, latitude: 40.75, zoom: 10 });
    const map = new MockMap();
    const overlay = new BasemapOverlay(map, proj, camera);

    expect(overlay.getCanvas()).toBe(map.getCanvas());
    overlay.resize();
    expect(map.resized).toBe(1);
  });

  it('dispose detaches and removes the host map (idempotent)', () => {
    const { proj, camera } = cameraAt({ longitude: -73.98, latitude: 40.75, zoom: 10 });
    const map = new MockMap();
    const overlay = new BasemapOverlay(map, proj, camera);

    overlay.dispose();
    expect(overlay.isAttached).toBe(false);
    expect(map.removed).toBe(1);

    overlay.sync();
    expect(map.jumps.length).toBe(0); // disposed → detached, no sync

    overlay.dispose();
    expect(map.removed).toBe(2); // remove() called again, no throw
  });

  it('tolerates a minimal map without optional methods', () => {
    const { proj, camera } = cameraAt({ longitude: -73.98, latitude: 40.75, zoom: 10 });
    const calls: JumpArgs[] = [];
    const bare: BasemapLike = { jumpTo: (o) => calls.push(o) };
    const overlay = new BasemapOverlay(bare, proj, camera);

    expect(overlay.getCanvas()).toBeUndefined();
    overlay.sync();
    expect(calls.length).toBe(1);
    overlay.resize(); // no resize() on bare → no throw
    overlay.dispose(); // no remove() on bare → no throw
  });
});
