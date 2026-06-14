import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the STT showcase rendering / FPS regression suite.
 *
 * The `webServer` block auto-starts the Vite dev server for `@poopdeck.gl/showcase`.
 * The showcase serves very large .stt data files, so timeouts are generous.
 *
 * Chromium is launched with SwiftShader flags so WebGL works even when no
 * hardware GPU is available (CI, headless containers). deck.gl requires WebGL.
 */

const SHOWCASE_PORT = 3000;
const SHOWCASE_URL = `http://localhost:${SHOWCASE_PORT}`;

export default defineConfig({
  testDir: './tests',
  // A single rendering session is heavy (loads ~17MB+ of tile data); no parallelism.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Each test does real network loading + multi-second FPS sampling.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  outputDir: 'test-results',
  use: {
    baseURL: SHOWCASE_URL,
    headless: true,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-webgl',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            // Software WebGL so deck.gl renders without a real GPU.
            '--use-gl=swiftshader',
            '--enable-unsafe-swiftshader',
            '--enable-webgl',
            '--ignore-gpu-blocklist',
            '--disable-gpu-sandbox',
            // Stable headless rendering.
            '--disable-dev-shm-usage',
            '--no-sandbox',
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'pnpm --filter @poopdeck.gl/showcase dev',
    url: SHOWCASE_URL,
    reuseExistingServer: true,
    // The dev server transpiles a large app and Vite pre-bundles deck.gl/maplibre.
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
