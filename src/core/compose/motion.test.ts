import assert from "node:assert/strict";
import {test} from "node:test";
import {loadBrandKit} from "../brand/kit.ts";
import {INTENT_PRESETS} from "../intents/index.ts";
import {ENERGY_MOTION} from "../tts/energy.ts";
import type {Intent} from "../plan/schema.ts";
import {motionBrief} from "./workdir.ts";

const kit = await loadBrandKit();

/** The entrance in ms the brief prints for one energy of one intent. */
function entranceMs(intent: Intent, energy: string): number {
  const row = motionBrief(kit, intent)
    .split("\n")
    .find((line) => line.startsWith(`| \`${energy}\``));
  assert.ok(row, `no ${energy} row for ${intent}`);
  const match = /\|\s*(\d+)ms\s*\|/.exec(row);
  assert.ok(match, `no entrance figure in: ${row}`);
  return Number(match[1]);
}

test("an ad moves harder than an explainer", () => {
  // The reason this field exists at all. One global dial cannot serve a cold feed and a
  // video someone chose to watch; the ad has three seconds to earn attention it never had.
  assert.ok(entranceMs("promotional", "settled") < entranceMs("thought-leadership", "settled"));
  assert.ok(entranceMs("thought-leadership", "settled") < entranceMs("educational", "settled"));
});

test("educational holds the brand's own baseline exactly", () => {
  // scale 1 must mean untouched, so the kit stays a number you can reason about.
  assert.equal(entranceMs("educational", "settled"), kit.motion.sceneEnterMs);
});

test("the intent scale shifts the curve without flattening it", () => {
  // A faster piece is not a piece where every section is the same speed. Contrast is the
  // point: a lift only reads as a lift because the section before it did not.
  for (const intent of Object.keys(INTENT_PRESETS) as Intent[]) {
    const quiet = entranceMs(intent, "quiet");
    const edge = entranceMs(intent, "edge");
    assert.ok(quiet > edge * 1.5, `${intent}: quiet ${quiet}ms vs edge ${edge}ms is not a curve`);
  }
});

test("every energy in the table reaches the brief", () => {
  // The table used to be hand-copied prose. If an energy is added to ENERGY_MOTION and
  // the composer never hears about it, sections carrying it get no timing at all.
  const brief = motionBrief(kit, "thought-leadership");
  for (const [energy, {note}] of Object.entries(ENERGY_MOTION)) {
    assert.ok(brief.includes(`\`${energy}\``), `${energy} missing from the brief`);
    assert.ok(brief.includes(note), `${energy} description drifted from ENERGY_MOTION`);
  }
});

test("quiet is never described to the composer as holding still", () => {
  // The regression this file exists for. The hand-written table told the composer that
  // quiet meant "long holds" — a composition did exactly that and failed the post-render
  // freeze check, ENERGY_MOTION was corrected, and the prose in the brief was not. It
  // stayed wrong because it was a second copy. Generating it is what makes this hold.
  for (const intent of Object.keys(INTENT_PRESETS) as Intent[]) {
    const brief = motionBrief(kit, intent);
    for (const phrase of ["long hold", "hold still", "no motion"]) {
      assert.ok(!brief.toLowerCase().includes(phrase), `${intent} brief still says "${phrase}"`);
    }
  }
});

test("the simultaneous cap is a delta on the kit, not a second source of truth", () => {
  for (const [intent, preset] of Object.entries(INTENT_PRESETS)) {
    const expected = kit.motion.maxSimultaneous + preset.motion.simultaneousDelta;
    assert.ok(
      motionBrief(kit, intent as Intent).includes(`At most ${expected} things moving at once`),
      `${intent} should cap at ${expected}`,
    );
    assert.ok(expected >= 3, `${intent}: a cap under 3 makes staggered entrances impossible`);
  }
});



test("the brief puts no number on sustained motion", () => {
  // Load-bearing absence. Three renders of one plan specified it — as a total, then as a
  // rate — and both moved LESS than saying nothing (median 0.058 → 0.033 → 0.045) while
  // failing the freeze check the specification was meant to satisfy. §6 asks for "at
  // least one sustained motion" and the post-render check enforces it; a figure in
  // between displaces the composer's judgement and it optimises to the figure.
  for (const intent of Object.keys(INTENT_PRESETS) as Intent[]) {
    const brief = motionBrief(kit, intent);
    const sustainedSection = brief.slice(brief.indexOf("sustained motion of §6"));
    assert.ok(!/\d+(\.\d+)?%/.test(sustainedSection),
      `${intent}: a sustained-motion figure is back in the brief — see the table in intents/index.ts`);
  }
});
