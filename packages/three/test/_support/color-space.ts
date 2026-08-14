// @poopdeck.gl/three — test support
// SPDX-License-Identifier: MIT
//
// The sRGB OETF (linear → display), i.e. exactly what Three's output pass runs
// over a fragment colour before it reaches the canvas — three's
// `sRGBTransferOETF`, and the inverse of the package's `srgbToLinear`.
//
// Colour buffers and colour nodes hold LINEAR-light values so that this encode
// hands back the sRGB byte the demo actually authored (see
// `src/tsl/color-space.ts`). Tests therefore assert on `onScreen(value)`, not on
// the raw buffer: it is the one number a user can compare against a legend
// swatch or against what the deck.gl backend draws.

export function onScreen(linear: number): number {
  return linear <= 0.0031308
    ? linear * 12.92
    : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
}
