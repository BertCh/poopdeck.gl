// PASS/FAIL correctness check for the storm-radar demo + storm story.
// NOT an aesthetic baseline diff — just: does it render non-blank, do the three
// storm manifests load as JSON (not the Vite HTML SPA fallback that means a
// missing .stt), and are there any console/page errors? Run after the dev
// server is up (port 3000). One reference screenshot each; no pixel diffing.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.STT_BASE_URL ?? "http://localhost:3000";
const OUT = "output/storm-verify";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
const manifests = {};
let current = "";
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push({ page: current, text: msg.text().slice(0, 300) });
});
page.on("pageerror", (err) =>
  errors.push({ page: current, text: `PAGEERROR ${String(err).slice(0, 300)}` }),
);
page.on("response", (res) => {
  const u = res.url();
  if (u.includes("/data/storm-") && u.endsWith("manifest.json")) {
    manifests[u.split("/data/")[1]] = {
      status: res.status(),
      ct: (res.headers()["content-type"] || "").split(";")[0],
    };
  }
});

async function sampleCanvas() {
  return page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (!c) return { canvas: false };
    const w = c.width, h = c.height;
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    if (!gl) return { canvas: true, gl: false };
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let lit = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] > 16 && (px[i] > 24 || px[i + 1] > 24 || px[i + 2] > 24)) lit++;
    }
    return { canvas: true, gl: true, w, h, litPct: +((lit / (w * h)) * 100).toFixed(2) };
  });
}

// 1) Composite demo
current = "demo";
await page.goto(BASE + "/demo/storm-radar", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(13000);
await page.screenshot({ path: `${OUT}/demo.png` });
console.log("demo  canvas:", JSON.stringify(await sampleCanvas()));

// 2) Story — scroll into the first map act so playback starts.
current = "story";
await page.goto(BASE + "/story/storms", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(3000);
await page.evaluate(() => {
  document.getElementById("morning")?.scrollIntoView({ behavior: "instant", block: "center" });
});
await page.waitForTimeout(11000);
await page.screenshot({ path: `${OUT}/story.png` });
console.log("story canvas:", JSON.stringify(await sampleCanvas()));

console.log("\n=== storm manifests (want 200 application/json) ===");
const keys = Object.keys(manifests);
if (!keys.length) console.log("(none requested!)");
for (const k of keys) console.log(`${k}: ${manifests[k].status} ${manifests[k].ct}`);

console.log("\n=== console / page errors ===");
if (!errors.length) console.log("(none)");
for (const e of errors) console.log(`[${e.page}] ${e.text}`);

await browser.close();
