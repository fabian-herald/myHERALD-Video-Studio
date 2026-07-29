import assert from "node:assert/strict";
import {test} from "node:test";
import {implausibleClip, longestPlausibleMs} from "./plausible.ts";
import {deliveryFor, ENERGY_DIRECTION} from "./energy.ts";
import {ENERGIES} from "../plan/schema.ts";

test("the two clips that shipped the direction aloud are caught", () => {
  // Measured from thought-leadership-42fb0b, where the delivery direction was written
  // as full sentences and the model read it out.
  const lift = implausibleClip("One question stays open until it is answered.", 17_640);
  assert.ok(lift, "17.6s for eight words has to be implausible");
  assert.equal(lift.words, 8);
  assert.ok(lift.extraWords > 20, `should account for tens of extra words, got ${lift.extraWords}`);

  const settled = implausibleClip("Calendars are fine when the thinking is done.", 9_160);
  assert.ok(settled, "9.2s for eight words has to be implausible");
});

test("every good clip from that same run passes", () => {
  const good: [string, number][] = [
    ["A content calendar has thirty boxes.", 2_800],
    ["None of them knows about the others.", 2_600],
    ["A magazine can plan that way.", 2_360],
    ["The argument is decided before the dates.", 3_520],
    ["Independent slots are the point of a grid.", 3_400],
    ["You publish, and someone raises a real objection.", 4_400],
    ["Slots cannot hold something still moving.", 4_800],
    ["Publishing is what falls out of that.", 2_600],
  ];
  for (const [text, ms] of good) {
    assert.equal(implausibleClip(text, ms), null, `${text} at ${ms}ms should pass`);
  }
});

test("a deliberately weighted short line is given room", () => {
  // Four words read slowly with pauses. Real delivery, not a defect.
  assert.equal(implausibleClip("Not the first one.", 3_400), null);
  assert.ok(longestPlausibleMs("Not the first one.") >= 3_500, "short lines get a floor");
});

test("a long line scales rather than tripping the floor", () => {
  const long = "A calendar is a fine production tool and a poor editorial one, which is the whole problem.";
  assert.equal(implausibleClip(long, 8_000), null);
  assert.ok(implausibleClip(long, 20_000), "still catches a runaway on a long line");
});

test("delivery directions stay too terse to be mistaken for a transcript", () => {
  for (const energy of ENERGIES) {
    const direction = ENERGY_DIRECTION[energy];
    const words = direction.split(/\s+/).length;
    assert.ok(words <= 10, `${energy} direction is ${words} words; keep it adjectival`);
    assert.ok(!/[.!?]/.test(direction), `${energy} direction reads as a sentence: "${direction}"`);
  }
});

test("delivery is one line, so it cannot be parsed as more transcript", () => {
  const style = deliveryFor("Warm, credible, founder-to-founder.\nNo hype.", "lift");
  assert.ok(!style.includes("\n"), `delivery must be a single line, got: ${style}`);
  assert.match(style, /Here: warmer and slightly quicker/);
});
