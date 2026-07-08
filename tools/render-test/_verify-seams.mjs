// Browser verification of the comprehensive-fix runtime seams.
// (a) drifters loop boundary under throttled net -> brief 'seeking', no freeze
// (b) AIS categorical wake fades (palette alpha composition)
// (c) tab freeze/resume -> no playhead lurch (re-anchor + 250ms delta clamp)
// (e) __sttProbe.playback channel emits events
// Usage: node _verify-seams.mjs [scenario...]  (default: all)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.STT_URL || 'http://localhost:3000';
const OUT = path.resolve(process.cwd(), 'output/verify-seams');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--disable-gpu-sandbox',
    '--disable-dev-shm-usage',
    '--no-sandbox',
  ],
});

async function newPage() {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    globalThis.__sttProbe = { enabled: true };
  });
  const errs = [];
  page.on('pageerror', (e) => errs.push(`[pageerror] ${e.name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(`[console.error] ${m.text()}`);
  });
  return { ctx, page, errs };
}

const setRange = (page, v) =>
  page
    .locator('input[type="range"]')
    .first()
    .evaluate((el, val) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(el, String(val));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, v);
const bounds = (page) =>
  page
    .locator('input[type="range"]')
    .first()
    .evaluate((el) => ({ min: Number(el.min), max: Number(el.max) }));
const rangeVal = (page) =>
  page
    .locator('input[type="range"]')
    .first()
    .evaluate((el) => Number(el.value));
const clickBtn = (page, re) =>
  page.evaluate((src) => {
    const rx = new RegExp(src);
    const b = Array.from(document.querySelectorAll('button')).find((x) =>
      rx.test(x.textContent?.trim() ?? ''),
    );
    if (b) {
      b.click();
      return b.textContent?.trim();
    }
    return null;
  }, re.source);
const drainPlayback = (page) =>
  page.evaluate(() => {
    const p = globalThis.__sttProbe?.playback ?? [];
    globalThis.__sttProbe.playback = [];
    return JSON.parse(JSON.stringify(p));
  });
const open = async (page, url) => {
  await page.goto(`${BASE}${url}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page
    .locator('.map-viewport, canvas')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });
};
const report = (name, obj) =>
  console.log(`\n=== ${name} ===\n` + JSON.stringify(obj, null, 2));

const scenarios = {
  // (e) playback probe channel emits events on a normal play session.
  async probe() {
    const { ctx, page, errs } = await newPage();
    await open(page, '/demo/nyc-taxi-points');
    await page.waitForTimeout(6000);
    await clickBtn(page, /^▶$/);
    await page.waitForTimeout(10_000);
    const events = await drainPlayback(page);
    const kinds = [...new Set(events.map((e) => e.event))];
    const states = [...new Set(events.map((e) => e.state))];
    const sample = events[0] ?? null;
    report('probe-playback (e)', {
      eventCount: events.length,
      kinds,
      states,
      sample,
      pageErrors: errs.slice(0, 5),
      pass: events.length > 0 && events.every((e) => e.event && e.state),
    });
    await ctx.close();
  },

  // (b) CategoryColor alpha composition: animal-migration colors trips by
  // taxon_group via colorMapping and fades trails. Expect >=3 of the five
  // palette chroma directions on screen plus a brightness spread (fade).
  // (ship-traffic turned out to never be categorical: its tiles carry no
  // properties and its "Vessel Type" legend is decorative — see findings.)
  async category() {
    const { ctx, page, errs } = await newPage();
    await open(page, '/demo/animal-migration');
    await page.waitForTimeout(10_000);
    await clickBtn(page, /^▶$/);
    await page.waitForTimeout(15_000);
    await clickBtn(page, /^⏸$/);
    await page.waitForTimeout(5000);
    const shot = path.join(OUT, 'animals-category.png');
    await page.screenshot({ path: shot });
    const px = await page.evaluate(() => {
      const c =
        document.querySelector('.map-viewport canvas') ||
        document.querySelector('canvas');
      const gl = c?.getContext('webgl2') || c?.getContext('webgl');
      if (!gl) return { reason: 'no gl' };
      const w = c.width,
        h = c.height;
      const buf = new Uint8Array(4 * w * h);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const bg = [36, 39, 48]; // dark slate page/map background
      const palette = {
        bird: [79, 195, 247],
        mammal: [255, 138, 101],
        fish: [77, 182, 172],
        reptile: [174, 213, 129],
        insect: [255, 213, 79],
      };
      // src-over fade shifts chroma toward bg; compare bg-subtracted vectors.
      const norm = (v) => {
        const m = Math.hypot(...v) || 1;
        return v.map((x) => x / m);
      };
      const sub = (v) => norm(v.map((x, i2) => Math.max(x - bg[i2], 0)));
      const pn = Object.fromEntries(
        Object.entries(palette).map(([k, v]) => [k, sub(v)]),
      );
      const counts = Object.fromEntries(
        Object.keys(palette).map((k) => [k, 0]),
      );
      const bright = Object.fromEntries(
        Object.keys(palette).map((k) => [k, []]),
      );
      let lit = 0;
      for (let i = 0; i < buf.length; i += 4) {
        const r = buf[i],
          g = buf[i + 1],
          b = buf[i + 2];
        if (Math.max(r, g, b) < 60) continue;
        if (
          Math.abs(r - bg[0]) < 18 &&
          Math.abs(g - bg[1]) < 18 &&
          Math.abs(b - bg[2]) < 18
        )
          continue;
        lit++;
        const u = sub([r, g, b]);
        let best = null,
          bestDot = 0.97;
        for (const [k, v] of Object.entries(pn)) {
          const dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
          if (dot > bestDot) {
            best = k;
            bestDot = dot;
          }
        }
        if (best) {
          counts[best]++;
          if (bright[best].length < 8000) bright[best].push(Math.max(r, g, b));
        }
      }
      const classes = Object.entries(counts)
        .filter(([, n]) => n > 60)
        .map(([k, n]) => {
          const v = bright[k].sort((a, b2) => a - b2);
          return {
            type: k,
            n,
            p10: v[Math.floor(v.length * 0.1)],
            p90: v[Math.floor(v.length * 0.9)],
          };
        });
      return { w, h, lit, classes };
    });
    const fadeSpread = (px.classes ?? []).some((c2) => c2.p90 - c2.p10 > 50);
    report('category-fades (b)', {
      ...px,
      fadeSpread,
      screenshot: shot,
      pageErrors: errs.slice(0, 5),
      pass: (px.lit ?? 0) > 500 && (px.classes?.length ?? 0) >= 3 && fadeSpread,
    });
    await ctx.close();
  },

  // (c) hard-stop the main thread via Debugger.pause for 4s, resume, and
  // check the playhead advances ~MAX_FRAME_DELTA (250ms) worth, not the
  // full frozen wall-clock worth.
  async refocus() {
    const { ctx, page, errs } = await newPage();
    await open(page, '/demo/nyc-taxi-points');
    await page.waitForTimeout(6000);
    await clickBtn(page, /^▶$/);
    await page.waitForTimeout(3000);
    // Measure sim-rate over 2s of normal playback.
    const t0 = await rangeVal(page);
    await page.waitForTimeout(2000);
    const t1 = await rangeVal(page);
    const simPerMs = (t1 - t0) / 2000;
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Debugger.enable');
    const sample = () =>
      page
        .locator('input[type="range"]')
        .first()
        .evaluate((el) => ({
          v: Number(el.value),
          p: performance.now(),
        }));
    const pre = await sample();
    await cdp.send('Debugger.pause');
    const frozenMs = 4000;
    await new Promise((r) => setTimeout(r, frozenMs)); // main thread parked
    await cdp.send('Debugger.resume');
    await page.waitForTimeout(450); // a few frames after resume
    const post = await sample();
    await cdp.send('Debugger.disable');
    const realElapsed = post.p - pre.p; // wall clock incl. the pause
    const unfrozenReal = realElapsed - frozenMs; // time rAF was actually running
    const simAdvanceMs = (post.v - pre.v) / simPerMs;
    // The frozen gap should contribute <= MAX_FRAME_DELTA (250ms) of sim
    // time; everything else is real playback around the pause.
    const excessMs = simAdvanceMs - unfrozenReal;
    report('tab-refocus (c)', {
      simPerMs,
      realElapsed,
      unfrozenReal,
      simAdvanceMs,
      excessMs,
      clampTarget: 250,
      noFixWouldBe: frozenMs,
      pageErrors: errs.slice(0, 5),
      pass: simPerMs > 0 && excessMs < 900, // 250 clamp + React/range lag slack
    });
    await ctx.close();
  },

  // (a) drifters loop boundary under throttled network: scrub near the end,
  // play through the wrap, expect 'seeking' events and a moving playhead
  // afterwards (no freeze), no lurch.
  async loop() {
    const { ctx, page, errs } = await newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 40,
      downloadThroughput: (8 * 1024 * 1024) / 8, // 8 Mbps
      uploadThroughput: (1 * 1024 * 1024) / 8,
    });
    await open(page, '/demo/ocean-drifters');
    await page.waitForTimeout(8000);
    const b = await bounds(page);
    await setRange(page, b.min + (b.max - b.min) * 0.985);
    await page.waitForTimeout(6000);
    await drainPlayback(page);
    // In-page sampler: no CDP roundtrips while the main thread is busy.
    // Re-query the input each tick — React can replace the node.
    await page.evaluate(() => {
      globalThis.__loopSamples = [];
      globalThis.__loopTimer = setInterval(() => {
        const el = document.querySelector('input[type="range"]');
        globalThis.__loopSamples.push({
          v: el ? Number(el.value) : NaN,
          p: performance.now(),
        });
      }, 500);
    });
    await clickBtn(page, /^▶$/);
    await page.waitForTimeout(120_000);
    const raw = await page.evaluate(() => {
      clearInterval(globalThis.__loopTimer);
      return globalThis.__loopSamples;
    });
    const samples = raw.map((s) => s.v);
    const events = await drainPlayback(page);
    const lastQoe = events.length ? events[events.length - 1] : null;
    const shot = path.join(OUT, 'drifters-loop.png');
    await page.screenshot({ path: shot });
    const span = b.max - b.min;
    const wrapIdx = samples.findIndex(
      (v, i2) => i2 > 0 && samples[i2 - 1] - v > span * 0.5,
    );
    const post = wrapIdx >= 0 ? samples.slice(wrapIdx) : [];
    // Freeze detection: longest run of identical post-wrap samples.
    let frozenMax = 0,
      run = 0;
    for (let i = 1; i < post.length; i++) {
      run = post[i] === post[i - 1] ? run + 1 : 0;
      frozenMax = Math.max(frozenMax, run);
    }
    const states = events.map(
      (e) => `${e.event}:${e.state}${e.degraded ? ':degraded' : ''}`,
    );
    const sawSeeking = events.some(
      (e) =>
        e.state === 'seeking' ||
        e.state === 'buffering' ||
        e.event === 'waiting',
    );
    const movedAfter = post.length > 4 && post[post.length - 1] > post[0];
    const pct = (v) => Math.round(((v - b.min) / span) * 1000) / 10 + '%';
    report('drifters-loop (a)', {
      bounds: b,
      wrapped: wrapIdx >= 0,
      wrapIdx,
      trace: samples.filter((_, i2) => i2 % 8 === 0).map(pct),
      preWrapTail: samples
        .slice(Math.max(0, wrapIdx - 3), wrapIdx + 3)
        .map(pct),
      postWrapHead: post.slice(0, 8).map(pct),
      frozenMaxRunMs: frozenMax * 500,
      sawSeeking,
      movedAfter,
      lastQoe,
      stateTimeline: states.slice(0, 40),
      screenshot: shot,
      pageErrors: errs.slice(0, 5),
      pass: wrapIdx >= 0 && movedAfter && frozenMax * 500 < 15_000,
    });
    await ctx.close();
  },
};

const pick = process.argv.slice(2);
const run = pick.length ? pick : ['probe', 'ais', 'refocus', 'loop'];
for (const name of run) {
  try {
    await scenarios[name]();
  } catch (e) {
    report(`${name} (CRASHED)`, {
      error: String(e?.message || e).slice(0, 300),
    });
  }
}
await browser.close();
