import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
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

test("the area rule never appears without the rule that bounds it", () => {
  // These two sentences are one rule. Given only the first, the composer read "move
  // something large" as licence to sweep an opaque card over a headline and produced
  // twenty `layout: Text is hidden beneath an opaque element` errors in a single pass —
  // against two in the run before the area wording existed. Whoever edits one half has to
  // see the other.
  const contract = readFileSync(new URL("./CONTRACT.md", import.meta.url), "utf8");
  const areaAt = contract.indexOf("What moves has to have area");
  assert.ok(areaAt > 0, "the area rule is gone from the contract");
  const boundedAt = contract.indexOf("behind the type", areaAt);
  assert.ok(boundedAt > areaAt && boundedAt - areaAt < 1200,
    "the area rule is stated without the rule that stops it burying the type");
});

test("the contract names the check that catches an opaque overlap", () => {
  // Naming the finding is what lets the composer connect the rule to the error it is
  // about to read in a repair prompt.
  const contract = readFileSync(new URL("./CONTRACT.md", import.meta.url), "utf8");
  assert.match(contract, /Text is hidden beneath an opaque element/);
  assert.match(contract, /rgba\(0,0,0,α\)|translucent/, "no way out is offered, only a prohibition");
});

test("the brief lists the directory instead of making the composer find it", () => {
  // An attempt died at error_max_turns having spent its budget on `ls -la`, `ls -R`,
  // `find exemplar` and a `cat` — all refused by the sandbox, so it learned nothing and
  // paid a turn each time. This module wrote those files and knows what is there.
  const source = readFileSync(new URL("./workdir.ts", import.meta.url), "utf8");
  const manifest = source.slice(source.indexOf("function directoryManifest"));
  const body = manifest.slice(0, manifest.indexOf("\n}"));
  assert.match(body, /BLOCK_FILES\.map/, "the block list is hand-copied and will drift");
  assert.match(body, /NARRATION_FILE/);
  assert.match(body, /caption-data\.js/);
  assert.match(body, /kit\.logos\.map/, "logos are not listed, so the composer has to go looking");
  assert.match(body, /ls.*cat.*find|refused/, "nothing says why the shell will not help");
});

test("the composer is told to read rather than shell out", () => {
  const source = readFileSync(new URL("../gen/claudeComposer.ts", import.meta.url), "utf8");
  const prompt = source.slice(source.indexOf("const SYSTEM_PROMPT"), source.indexOf("BASH_REFUSAL"));
  assert.match(prompt, /\\`Read\\` and \\`Glob\\`/, "no alternative to the shell is named");
  assert.match(prompt, /manifest/, "the composer is not pointed at the file list");
});
