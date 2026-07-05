// One-off PASS/FAIL verification for the new /how-it-works explainer page:
// route resolves, all sections + diagrams mount, the scrubber drives the
// space-time diagram, TOC chips scroll, header nav link works, no console
// errors. Correctness only — aesthetics are verified in-browser by hand.
import { chromium } from "playwright";

const BASE = process.env.STT_BASE_URL ?? "http://localhost:4173";
const OUT = "output/how-it-works";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text().slice(0, 300));
});
page.on("pageerror", (err) => errors.push(`PAGEERROR ${String(err).slice(0, 300)}`));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

await page.goto(`${BASE}/how-it-works`, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(2000);

check("h1", (await page.locator("h1").textContent())?.includes("How spatiotemporal tiles work") ?? false);

for (const id of ["pipeline", "space-time", "archive", "tile", "playback", "techniques", "parts", "design"]) {
  check(`section #${id}`, (await page.locator(`#${id}`).count()) === 1);
}

const svgCount = await page.locator("svg").count();
check("diagram SVGs mounted", svgCount >= 6, `${svgCount} svg elements`);

// Scrub the space-time playhead to bucket 9 and confirm the address updates.
await page
  .locator('input[type="range"]')
  .first()
  .evaluate((el) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, "900");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
await page.waitForTimeout(300);
const addr = await page.locator("svg text", { hasText: "fetching tile" }).first().textContent();
check("scrubber drives diagram", addr?.includes("t = 09:00") ?? false, addr ?? "no address text");

// TOC chip scrolls to the techniques section.
await page.locator('a[href="#techniques"]').click();
await page.waitForTimeout(900);
const inView = await page.locator("#techniques").evaluate((el) => {
  const r = el.getBoundingClientRect();
  return r.top >= -50 && r.top < 400;
});
check("TOC chip scrolls", inView);

// Header nav from the homepage.
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(1500);
const navLink = page.locator('header nav a[href="/how-it-works"]');
check("header nav link present", (await navLink.count()) === 1);
await navLink.click();
await page.waitForTimeout(1200);
check("nav click lands on page", page.url().endsWith("/how-it-works"));

await page.screenshot({ path: `${OUT}/how-it-works-full.png`, fullPage: true });

console.log("\n=== console errors ===");
if (errors.length === 0) console.log("(none)");
for (const e of errors) console.log(e);
if (errors.length > 0) failures++;

await browser.close();
console.log(failures === 0 ? "\nVERIFY PASS" : `\nVERIFY FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
