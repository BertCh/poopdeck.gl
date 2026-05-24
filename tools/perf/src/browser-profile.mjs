/**
 * Chromium launch profiles for the perf harness.
 *
 * Two backends:
 *  - "gpu"        — real hardware GPU via ANGLE. macOS → Metal, Linux → Vulkan
 *                   when available, otherwise OpenGL. This is the only backend
 *                   that produces numbers representative of what real users
 *                   see; the heatmap GPU aggregation and large GPU buffer
 *                   uploads are completely different shapes under SwiftShader.
 *  - "swiftshader"— software WebGL. Use on CI without a GPU, or to compare a
 *                   change's CPU-bound cost without GPU variance.
 *
 * The "gpu" profile uses `--headless=new`, which keeps the GPU process alive
 * (the old `--headless` flag silently fell back to SwiftShader regardless of
 * the other flags).
 */

import os from 'node:os';

/**
 * Build the Chromium launch arguments for a backend.
 *
 * @param {"gpu"|"swiftshader"} backend
 * @returns {string[]}
 */
export function chromiumArgs(backend) {
  if (backend === 'swiftshader') {
    return [
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--disable-gpu-sandbox',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ];
  }

  // GPU backend.
  const platform = os.platform();
  const args = [
    // The "new" headless mode uses the real Chromium browser process and keeps
    // the GPU process alive; the legacy headless mode (the default) forces
    // SwiftShader regardless of GPU flags.
    '--headless=new',
    '--enable-gpu',
    '--enable-unsafe-webgpu',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--disable-gpu-sandbox',
    '--disable-dev-shm-usage',
    '--no-sandbox',
  ];
  if (platform === 'darwin') {
    // ANGLE → Metal is the only backend on macOS that gives realistic numbers
    // for headless Chromium; the default opengl backend is slower than even
    // SwiftShader on Apple Silicon.
    args.push('--use-angle=metal');
  } else if (platform === 'linux') {
    // Vulkan is the most production-like; fall back to opengl if Vulkan is
    // not present (Chromium auto-selects when the requested backend is
    // missing, so this is safe).
    args.push('--use-angle=vulkan');
  }
  return args;
}

/**
 * Launch options forwarded to playwright's chromium.launch().
 *
 * `headless` is undefined here so the chromiumArgs() --headless=new flag is
 * authoritative; passing playwright's own `headless: true` re-adds the legacy
 * --headless flag which forces SwiftShader.
 *
 * @param {"gpu"|"swiftshader"} backend
 */
export function launchOptions(backend) {
  return {
    // Pass headless via the args list (--headless=new) for GPU mode; for
    // swiftshader we accept playwright's default.
    headless: backend === 'swiftshader',
    args: chromiumArgs(backend),
    // Slow tests sometimes wait on the first GPU process init; bump the
    // default 30s connection timeout.
    timeout: 60_000,
  };
}
