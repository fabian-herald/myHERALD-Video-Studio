import fs from "node:fs/promises";
import path from "node:path";
import {chromium} from "playwright";
import {BRAND_DIR, rel} from "../src/core/paths.ts";

/**
 * Renders the wordmark on its own, at video resolution, with the real fonts.
 *
 * The supplied lockup files bundle the seal, the words and the tagline together, which
 * is too much furniture for a corner slug or an outro. This produces just "myHERALD".
 *
 * It goes through headless Chrome rather than an SVG-to-PNG library because the mark is
 * type: `my` set in DM Sans against `HERALD` in DM Serif Display. Rasterising here bakes
 * the correct faces in, so a composition can drop the file straight into an `<img>` and
 * cannot get the typography wrong.
 */

const HEIGHT = 260;
const VARIANTS = [
  {id: "wordmark-light", ink: "#2A1646"},
  {id: "wordmark-dark", ink: "#FFFDF5"},
];

const fontsDir = path.join(BRAND_DIR, "fonts");
const [sans, serif] = await Promise.all([
  fs.readFile(path.join(fontsDir, "dm-sans-latin-500-normal.woff2")),
  fs.readFile(path.join(fontsDir, "dm-serif-display-latin-400-normal.woff2")),
]);

const page = (ink: string) => `<!doctype html>
<meta charset="utf-8">
<style>
  @font-face { font-family: "W Sans"; src: url(data:font/woff2;base64,${sans.toString("base64")}) format("woff2"); }
  @font-face { font-family: "W Serif"; src: url(data:font/woff2;base64,${serif.toString("base64")}) format("woff2"); }
  html, body { margin: 0; background: transparent; }
  #mark {
    display: inline-block;
    padding: 8px 10px;
    color: ${ink};
    white-space: nowrap;
    line-height: 1;
  }
  .my    { font: 500 ${HEIGHT * 0.52}px "W Sans"; letter-spacing: -0.01em; }
  .herald{ font: 400 ${HEIGHT * 0.78}px "W Serif"; letter-spacing: 0.012em; }
</style>
<div id="mark"><span class="my">my</span><span class="herald">HERALD</span></div>`;

const browser = await chromium.launch();
const context = await browser.newContext({deviceScaleFactor: 2});

for (const variant of VARIANTS) {
  const tab = await context.newPage();
  await tab.setContent(page(variant.ink), {waitUntil: "load"});
  await tab.evaluate(() => document.fonts.ready);
  const file = path.join(BRAND_DIR, "logos", `${variant.id}.png`);
  await tab.locator("#mark").screenshot({path: file, omitBackground: true});
  const {width, height} = (await tab.locator("#mark").boundingBox()) ?? {width: 0, height: 0};
  console.log(`${variant.id.padEnd(16)}${Math.round(width * 2)}×${Math.round(height * 2)}  ${rel(file)}`);
  await tab.close();
}

await browser.close();
