/**
 * Dark palette for the shared `@poopdeck.gl/react` transport bar.
 *
 * `PlaybackControls` is authored in the site's light editorial theme (dark ink
 * on a white surface). Every surface that floats it OVER the dark map canvas —
 * the fullscreen deck viewer, the Cesium globe page, the phone chrome — needs
 * the inverse palette, so they remap its CSS custom properties on the wrapper
 * instead of forking the shared, published component. Values mirror the dark
 * in-map chips in `DemoViewer` (cube / summary controls) and the app's cyan
 * data accent.
 */
import type React from 'react';

export const DARK_CONTROL_THEME = {
  '--ink-900': '#f4f5f7',
  '--ink-700': '#d5d8de',
  '--ink-500': '#a0a7b4',
  '--ink-400': '#7b8494',
  '--surface': '#262a33',
  '--hairline': 'rgba(255, 255, 255, 0.14)',
  '--accent': '#1fbad6',
  '--accent-soft': 'rgba(31, 186, 214, 0.16)',
  '--page-bg': '#15171c',
} as React.CSSProperties;
