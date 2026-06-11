// One-off verification for the new deck.gl demos (arcs / columns / quadbin).
// Visits each /demo/<id>, captures console errors + a screenshot, and reports
// whether a deck.gl canvas drew anything. Run after `npm run dev` (port 3000).
import { chromium } from "playwright";

const BASE = process.env.STT_BASE_URL ?? "http://localhost:3000";
const OUT = "output/new-layers-verify";

const PAGES = [
  { name: "od-arcs", path: "/demo/nyc-od-arcs", wait: 11000 },
  { name: "earthquake-columns", path: "/demo/earthquake-columns", wait: 11000 },
  { name: "od-quadbin", path: "/demo/nyc-od-quadbin", wait: 11000 },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

let current = "";
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push({ page: current, text: msg.text().slice(0, 300) });
});
page.on("pageerror", (err) => errors.push({ page: current, text: `PAGEERROR ${String(err).slice(0, 300)}` }));

for (const p of PAGES) {
  current = p.name;
  try {
    await page.goto(BASE + p.path, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(p.wait);
    await page.screenshot({ path: `${OUT}/${p.name}.png` });
    // Sample the canvas: count non-transparent, non-background pixels as a
    // crude "did anything render" signal.
    const drew = await page.evaluate(() => {
      const c = document.querySelector("canvas");
      if (!c) return { canvas: false };
      const w = c.width, h = c.height;
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      if (!gl) return { canvas: true, gl: false };
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let lit = 0;
      for (let i = 0; i < px.length; i += 4) {
        // count pixels that aren't near-black/near-transparent
        if (px[i + 3] > 16 && (px[i] > 24 || px[i + 1] > 24 || px[i + 2] > 24)) lit++;
      }
      return { canvas: true, gl: true, w, h, litPct: +((lit / (w * h)) * 100).toFixed(2) };
    });
    console.log(`OK   ${p.name}  →  ${page.url()}  ${JSON.stringify(drew)}`);
  } catch (e) {
    console.log(`FAIL ${p.name}: ${String(e).slice(0, 200)}`);
  }
}

console.log("\n=== console errors ===");
if (errors.length === 0) console.log("(none)");
for (const e of errors) console.log(`[${e.page}] ${e.text}`);

await browser.close();
