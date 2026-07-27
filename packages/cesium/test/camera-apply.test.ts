// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * The camera-placement oracle, and the ONLY one in this package that is not our
 * own algebra restated.
 *
 * Two previous guards claimed to prove that `longitude`/`latitude` name the
 * ground point under the SCREEN CENTRE, and neither one could fail:
 *
 * 1. The original `ViewState → Cesium → ViewState` round trip converted with
 *    `viewStateToCesiumView` and back with `cesiumViewToViewState`. Both
 *    directions treated lon/lat as a pass-through, so both directions shared the
 *    mistake and the trip closed perfectly while `setView({destination})` was
 *    parking the camera ON the target — the bug this file exists to catch
 *    shipped underneath a green suite.
 * 2. Its replacement built the camera offset with a local `lookAtCameraEnu`
 *    helper and then solved for the ground hit with a local `groundHitEnu`
 *    helper. `lookAtCameraEnu` returns `-range · dir` for exactly the `dir`
 *    `groundHitEnu` rebuilds from the same heading/pitch, so the solve is
 *    `-range·dir + range·dir = 0` — identically zero for ANY range, ANY heading,
 *    ANY pitch. Fed a range 1000× too small, or a positive pitch (a camera
 *    BELOW the ground), it still reported the target dead centre to 1e-12 m.
 *
 * So this file uses real `@cesium/engine`: a real `Camera`, driven by the real
 * `applyViewStateToCamera`, interrogated with Cesium's OWN
 * `Camera.pickEllipsoid` — which at the canvas centre reduces to
 * `IntersectionTests.rayEllipsoid` along `camera.directionWC`. Nothing in the
 * measurement path is code this package wrote. If the placement regresses to
 * `destination`, the miss is thousands of metres and every pitched case below
 * goes red.
 *
 * Cesium DOES load under Node — the package's ESM entry is plain `@cesium/engine`
 * source and the maths modules touch no browser globals. Only a real `Scene`
 * needs WebGL, and `Camera` needs just five fields off it (see `makeCamera`).
 */

import { describe, it, expect } from 'vitest';
import {
  Camera,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Ellipsoid,
  GeographicProjection,
  HeadingPitchRange,
  MapMode2D,
  Math as CesiumMath,
  Matrix4,
  SceneMode,
  type Scene,
} from 'cesium';
import { applyViewStateToCamera } from '../src/camera-apply';
import { viewStateToCesiumView } from '../src/camera';
import type { ViewState } from '@poopdeck.gl/core/geo';

const DEG2RAD = Math.PI / 180;
const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 800;

/**
 * A real `Camera` on a stub `Scene`.
 *
 * `Camera`'s constructor reads only `drawingBufferWidth`/`Height` (for
 * `frustum.aspectRatio`) and `mapProjection`; `lookAt` adds `ellipsoid`, and
 * `pickEllipsoid`/`getPickRay` add `canvas.clientWidth`/`clientHeight` and
 * `mapMode2D`. Everything else on `Scene` is renderer state that this path never
 * touches, which is what makes a genuine Cesium camera testable in Node.
 */
function makeCamera(
  width = CANVAS_WIDTH,
  height = CANVAS_HEIGHT,
): { camera: Camera; width: number; height: number } {
  const scene = {
    canvas: { clientWidth: width, clientHeight: height },
    drawingBufferWidth: width,
    drawingBufferHeight: height,
    pixelRatio: 1,
    mapProjection: new GeographicProjection(Ellipsoid.WGS84),
    ellipsoid: Ellipsoid.WGS84,
    mode: SceneMode.SCENE3D,
    mapMode2D: MapMode2D.INFINITE_SCROLL,
  };
  return { camera: new Camera(scene as unknown as Scene), width, height };
}

/**
 * Where the centre of the canvas lands on the ellipsoid, as Cesium reports it.
 *
 * At the exact centre `getPickRayPerspective`'s NDC terms are both zero, so the
 * ray IS `camera.directionWC` — this asks Cesium "what is the camera aimed at",
 * with no dependence on our fov or viewport-height conventions.
 */
function groundUnderScreenCentre(
  camera: Camera,
  width: number,
  height: number,
): Cartesian3 | undefined {
  return camera.pickEllipsoid(
    new Cartesian2(width / 2, height / 2),
    Ellipsoid.WGS84,
  );
}

/** Ground distance from a picked point to the requested target, metres. */
function missMetres(hit: Cartesian3 | undefined, target: Cartesian3): number {
  return hit === undefined
    ? Number.POSITIVE_INFINITY
    : Cartesian3.distance(hit, target);
}

const TORONTO = { longitude: -79.5, latitude: 43.6 };
const target = Cartesian3.fromDegrees(TORONTO.longitude, TORONTO.latitude, 0);

// The shipped demo cameras (storm-4d 55/20, iso3d 62/20, bixi 30/-12) bracketed
// by the flat case and by the steepest tilt `maxPitch: 85` allows.
const MATRIX = [
  [0, 0],
  [30, -12],
  [45, 90],
  [55, 20],
  [62, 20],
  [75, 315],
  [84, 140],
] as const;

describe('applyViewStateToCamera frames the requested lon/lat (real Cesium)', () => {
  for (const [pitch, bearing] of MATRIX) {
    it(`ground under the screen centre is the target at pitch ${pitch} / bearing ${bearing}`, () => {
      const { camera, width, height } = makeCamera();
      const v: ViewState = { ...TORONTO, zoom: 12, pitch, bearing };
      applyViewStateToCamera(camera, v, {
        viewportHeight: height,
        fovRadians: camera.frustum.fovy,
      });

      const hit = groundUnderScreenCentre(camera, width, height);
      expect(hit).toBeDefined();
      const c = Cartographic.fromCartesian(hit!, Ellipsoid.WGS84);
      // One metre of slack on a ~9.6 km range. The measured error is ~2e-5 m;
      // the failure this guards against is ~8000 m, so the threshold is not
      // load-bearing — it only has to sit between "float noise" and "a screen".
      expect(missMetres(hit, target)).toBeLessThan(1);
      // 5e-8° ≈ 5 mm. Measured error across the matrix is ≤3e-10°; the pre-fix
      // placement is off by ≥1e-6° even in its BEST case (pitch 0, where the two
      // placements are otherwise identical), so this still discriminates.
      expect(CesiumMath.toDegrees(c.longitude)).toBeCloseTo(
        TORONTO.longitude,
        7,
      );
      expect(CesiumMath.toDegrees(c.latitude)).toBeCloseTo(TORONTO.latitude, 7);
    });
  }

  it('stands the camera `range` from the target, not `height`', () => {
    // `lookAt` aims at the target for ANY range, so the centre-ray test above
    // cannot see a range/height mix-up — and `HeadingPitchRange(h, p, view.height)`
    // is the natural typo now that `CesiumView` carries both. It would put the
    // camera `cos(pitch)` too close: a whole zoom level of over-fine selection
    // at pitch 60, half a level at 45.
    const { camera, height } = makeCamera();
    const v: ViewState = { ...TORONTO, zoom: 12, pitch: 55, bearing: 20 };
    const view = viewStateToCesiumView(v, {
      viewportHeight: height,
      fovRadians: camera.frustum.fovy,
    });
    applyViewStateToCamera(camera, v, {
      viewportHeight: height,
      fovRadians: camera.frustum.fovy,
    });

    expect(Cartesian3.distance(camera.positionWC, target)).toBeCloseTo(
      view.range,
      6,
    );
    expect(view.height).toBeLessThan(view.range * 0.6); // cos(55°) ≈ 0.574
  });

  it('reports `height` as the ALTITUDE the live camera reads back', () => {
    // The mirror of RC6: `cesiumViewToViewState` is handed
    // `positionCartographic.height`, so `CesiumView.height` has to be that same
    // quantity or the read-back loop drifts by 1/cos(pitch) every frame.
    const { camera, height } = makeCamera();
    const v: ViewState = { ...TORONTO, zoom: 9, pitch: 55, bearing: 20 };
    const opts = { viewportHeight: height, fovRadians: camera.frustum.fovy };
    const view = viewStateToCesiumView(v, opts);
    applyViewStateToCamera(camera, v, opts);

    // 0.5% of slack: `view.height` is the flat-plane leg `range · cos(pitch)`,
    // while Cesium measures altitude against the curved ellipsoid, and the two
    // separate by the sagitta over the ~78 km ground offset at this framing.
    const actual = camera.positionCartographic.height;
    expect(actual).toBeGreaterThan(view.height * 0.995);
    expect(actual).toBeLessThan(view.height * 1.06);
  });

  it('keeps the framing when roll is re-asserted', () => {
    // `HeadingPitchRange` has no roll DOF, so `applyViewStateToCamera` follows
    // `lookAt` with a `setView({orientation})` that re-states heading/pitch read
    // back off the camera. Reading those back in the WRONG frame (the target's
    // ENU rather than the camera's own) would spin the view axis off the target
    // — the roll path has to be measured, not assumed.
    const { camera, width, height } = makeCamera();
    applyViewStateToCamera(
      camera,
      { ...TORONTO, zoom: 12, pitch: 55, bearing: 20, roll: 25 },
      { viewportHeight: height, fovRadians: camera.frustum.fovy },
    );
    expect(
      missMetres(groundUnderScreenCentre(camera, width, height), target),
    ).toBeLessThan(1);
    expect(CesiumMath.toDegrees(camera.roll)).toBeCloseTo(25, 6);
  });
});

describe('the oracle rejects the pre-fix placement (negative control)', () => {
  /**
   * The shipped-until-Wave-2 placement, reconstructed: `setView` with the view
   * centre as `destination`. In Cesium `destination` IS the camera position, so
   * this parks the camera above the data and aims it `altitude · tan(pitch)`
   * metres past it.
   */
  function applyLegacyDestination(
    camera: Camera,
    v: Required<Pick<ViewState, 'longitude' | 'latitude' | 'zoom'>> & ViewState,
    opts: { viewportHeight: number; fovRadians: number },
  ): void {
    const view = viewStateToCesiumView(v, opts);
    camera.setView({
      destination: Cartesian3.fromDegrees(
        view.longitude,
        view.latitude,
        view.height,
      ),
      orientation: {
        heading: view.headingRad,
        pitch: view.pitchRad,
        roll: view.rollRad,
      },
    });
  }

  it('misses by most of a screen at the storm-4d camera', () => {
    const { camera, width, height } = makeCamera();
    const opts = { viewportHeight: height, fovRadians: camera.frustum.fovy };
    const v: ViewState = { ...TORONTO, zoom: 12, pitch: 55, bearing: 20 };
    applyLegacyDestination(camera, v, opts);

    const miss = missMetres(
      groundUnderScreenCentre(camera, width, height),
      target,
    );
    const { range } = viewStateToCesiumView(v, opts);
    // `range · sin(pitch)` = 9587.5 · 0.819 ≈ 7853 m, plus ~8 m of ellipsoid
    // curvature over that offset. Expressed against the range because that is
    // what makes it a VISIBLE failure: the framed ground is 0.8 screens from
    // the data, i.e. the dataset is off the bottom edge.
    expect(miss).toBeGreaterThan(7000);
    expect(miss / range).toBeGreaterThan(0.75);
  });

  it('is indistinguishable from the fix at pitch 0 — why it hid for so long', () => {
    // Straight down, the camera position and the look-at target are the same
    // ground point, so every flat demo framed correctly and every flat test
    // passed. Only the pitched (volumetric) demos could ever show it.
    const legacy = makeCamera();
    const fixed = makeCamera();
    const v: ViewState = { ...TORONTO, zoom: 12, pitch: 0, bearing: 0 };
    const opts = {
      viewportHeight: legacy.height,
      fovRadians: legacy.camera.frustum.fovy,
    };
    applyLegacyDestination(legacy.camera, v, opts);
    applyViewStateToCamera(fixed.camera, v, opts);

    for (const c of [legacy, fixed]) {
      expect(
        missMetres(
          groundUnderScreenCentre(c.camera, c.width, c.height),
          target,
        ),
      ).toBeLessThan(1);
    }
  });
});

describe('Cesium agrees with the pure bridge on lookAt geometry', () => {
  it('matches Cesium HeadingPitchRange placement built from the same numbers', () => {
    // A second, weaker cross-check that does not go through
    // `applyViewStateToCamera`: hand Cesium's own `lookAt` the bridge's
    // heading/pitch/range and confirm the resulting world position is the one
    // `applyViewStateToCamera` produced. This is what pins the CONVENTION
    // bridge (STT pitch 0 = top-down ⇒ Cesium −90) to Cesium's own reading of
    // `HeadingPitchRange`, rather than to a second copy of our own formula.
    const a = makeCamera();
    const b = makeCamera();
    const v: ViewState = { ...TORONTO, zoom: 11, pitch: 62, bearing: 20 };
    const opts = {
      viewportHeight: a.height,
      fovRadians: a.camera.frustum.fovy,
    };
    const view = viewStateToCesiumView(v, opts);

    applyViewStateToCamera(a.camera, v, opts);
    b.camera.lookAt(
      target,
      new HeadingPitchRange(20 * DEG2RAD, (62 - 90) * DEG2RAD, view.range),
    );
    b.camera.lookAtTransform(Matrix4.IDENTITY);

    expect(
      Cartesian3.distance(a.camera.positionWC, b.camera.positionWC),
    ).toBeLessThan(1e-6);
  });
});
