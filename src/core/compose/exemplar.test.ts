import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {test} from "node:test";
import {loadBrandKit} from "../brand/kit.ts";
import {findRogueColors} from "../brand/tokens.ts";
import {compositionSize} from "../gen/substance.ts";
import {videoPlanZ, type VideoPlan} from "../plan/schema.ts";
import {
  checkCanonicalBrandLockups,
  checkCanvasLiterals,
  checkPerpetualMotionSource,
  checkStylesheetLinks,
  checkTransformOrigin,
  checkTokens,
  checkWordmark,
} from "../render/check.ts";
import {extractElement} from "./html.ts";
import {BLOCK_FILES} from "./workdir.ts";

/**
 * The exemplar is the only thing in the prompt that shows rather than tells, and every
 * composer is instructed to match its density. That makes a contract violation in it more
 * expensive than one in a composition: it teaches the violation to every run after it.
 *
 * The previous exemplar demonstrated this. It set the brand name as live type, built a seal
 * by hand and reached outside its directory for media, so `codexComposer` carried four
 * sentences of "do not copy this part of the reference" to work around it — sentences that
 * silently became false the moment the file was replaced.
 *
 * These checks are the ones that need no browser, so they run on every `npm test`.
 */

const EXEMPLAR = fileURLToPath(new URL("./exemplar/", import.meta.url));
const read = (file: string) => fs.readFile(path.join(EXEMPLAR, file), "utf8");

const plan = async (): Promise<VideoPlan> =>
  videoPlanZ.parse(
    JSON.parse(await fs.readFile(new URL("./exemplar-plan.fixture.json", import.meta.url), "utf8")),
  );

test("the exemplar uses brand tokens for every colour", async () => {
  const kit = await loadBrandKit();
  for (const file of ["styles.css", "index.html"]) {
    const rogue = findRogueColors(await read(file), kit);
    assert.deepEqual(rogue, [], `${file}: ${rogue.map((r) => `${r.line}:${r.literal}`).join(", ")}`);
  }
});

test("the exemplar links tokens.css and every block, with styles.css last", async () => {
  const html = await read("index.html");
  const hrefs = [...html.matchAll(/<link\b[^>]*href="([^"]+)"/gi)].map((match) => match[1]!);
  // Asserted against the constant rather than a transcribed list: a block added to
  // BLOCK_FILES and not to the exemplar would otherwise ship a reference that omits it.
  assert.deepEqual(hrefs, [
    "./tokens.css",
    ...BLOCK_FILES.map((file) => `./blocks/${file}`),
    "./styles.css",
  ]);
});

test("the exemplar reaches outside its own directory for nothing", async () => {
  for (const file of ["index.html", "styles.css", "animation.js"]) {
    const body = await read(file);
    assert.equal(/\.\.\//.test(body), false, `${file} contains a ../ path`);
  }
});

test("the exemplar sets the brand name as an image, never as live type", async () => {
  const kit = await loadBrandKit();
  assert.deepEqual(await checkWordmark(EXEMPLAR, kit), []);
});

test("the exemplar uses supplied lockups in the rail and the outro", async () => {
  const kit = await loadBrandKit();
  assert.deepEqual(await checkCanonicalBrandLockups(EXEMPLAR, kit, await plan()), []);
});

test("the exemplar hardcodes no canvas dimension", async () => {
  // The committed plan renders one format, and the check needs two to have an axis that
  // varies. Widen it to the whole portrait family — that is the condition the exemplar has
  // to survive to be safe to copy from, since a composer reading it may render all three.
  const portrait = {...(await plan()), formats: ["9x16", "4x5", "1x1"]} as VideoPlan;
  assert.deepEqual(await checkCanvasLiterals(EXEMPLAR, portrait, "portrait"), []);
});

test("the exemplar animates nothing across the full runtime", async () => {
  assert.deepEqual(await checkPerpetualMotionSource(EXEMPLAR), []);
});

test("the exemplar trips none of the Stage 4a rules", async () => {
  // Each of these was a gap a composition could walk straight through, so each is new. A
  // new rule that fires on the reference every composer is told to copy is worse than no
  // rule: it teaches the violation and then charges a repair round for it.
  const kit = await loadBrandKit();
  assert.deepEqual(await checkStylesheetLinks(EXEMPLAR), [], "stylesheet links");
  assert.deepEqual(await checkTokens(EXEMPLAR, kit), [], "colour literals, animation.js included");

  const portrait = {...(await plan()), formats: ["9x16", "4x5", "1x1"]} as VideoPlan;
  assert.deepEqual(
    await checkCanvasLiterals(EXEMPLAR, portrait, "portrait"), [], "canvas literals in css and js");

  // All twenty of its single-axis scales name the edge they grow from. That is what the
  // rule was written against, and what makes it worth having: the Codex composition that
  // predates this exemplar trips it six times, including on a `.data-bar span`.
  assert.deepEqual(await checkTransformOrigin(EXEMPLAR), [], "transform origins");
});

test("the exemplar is dense enough to be the bar the composers are held to", async () => {
  const size = compositionSize({
    "index.html": await read("index.html"),
    "styles.css": await read("styles.css"),
    "animation.js": await read("animation.js"),
  });

  // The two numbers that actually separate the approved composition from the thin ones:
  // 536 CSS lines against Codex's 27 and 59, and 107 GSAP calls against 40 and 35. A
  // reference that sits on the pass mark cannot teach the pass mark, so these are floors
  // with room, not the exact measurements.
  assert.ok(size.lines["styles.css"]! >= 300, `styles.css ${size.lines["styles.css"]}`);
  assert.ok(size.gsapCalls >= 55, `${size.gsapCalls} gsap calls`);

  // Not `minElementsPerScene`. It reads 11 here against the *old*, thinner exemplar's 13,
  // because a confident scene can be a few large elements. It is worth recording and worth
  // watching for a collapse to 4, but it does not rank compositions and must not gate one.
  assert.ok(size.minElementsPerScene >= 10, `thinnest scene ${size.minElementsPerScene}`);
});

test("the exemplar's plan fixture matches the composition it was rendered from", async () => {
  const parsed = await plan();
  const html = await read("index.html");
  const total = parsed.sections.reduce((sum, section) => sum + section.durationMs, 0);

  // The fixture exists so `checkPlanConformance` is testable at all. If it drifts from the
  // markup it stops testing anything, and the failure is silent — conformance would pass a
  // composition against a plan that describes a different video.
  assert.match(html, new RegExp(`data-duration="${(total / 1000).toFixed(3)}"`));
  let at = 0;
  for (const section of parsed.sections) {
    const scene = extractElement(html, `scene-${section.id}`);
    assert.ok(scene, `missing scene-${section.id}`);
    assert.match(scene.openTag, new RegExp(`data-start="${(at / 1000).toFixed(3)}"`));
    assert.match(scene.openTag, new RegExp(`data-duration="${(section.durationMs / 1000).toFixed(3)}"`));
    at += section.durationMs;
  }
  assert.equal(at, total);
});
