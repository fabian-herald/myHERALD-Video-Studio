import assert from "node:assert/strict";
import {test} from "node:test";
import {measureRhythm} from "./rhythm.ts";
import type {Energy, VideoPlan} from "./schema.ts";

const plan = (sections: {energy: Energy; durations: number[]}[]): VideoPlan => ({
  sections: sections.map((section, index) => ({
    id: `s-${index}`,
    energy: section.energy,
    phrases: section.durations.map((durationMs, phraseIndex) => ({
      id: `p-${phraseIndex}`,
      text: "x",
      startMs: 0,
      durationMs,
      gapAfterMs: 120,
    })),
  })),
} as unknown as VideoPlan);

test("the run that prompted this reads as flat", () => {
  // The real measured lengths from thought-leadership-a2ab00.
  const report = measureRhythm(plan([
    {energy: "settled", durations: [3400, 2300]},
    {energy: "settled", durations: [3200, 2600]},
    {energy: "settled", durations: [2100, 3900, 2400]},
    {energy: "settled", durations: [2600, 3200]},
    {energy: "settled", durations: [2800, 2100, 2800]},
    {energy: "settled", durations: [3300, 3300]},
  ]));

  assert.ok(report.variation < 0.22, `variation was ${report.variation}`);
  assert.equal(report.notes.length, 2, "flat lengths and a flat energy curve");
  assert.match(report.notes[0] ?? "", /Every spoken line runs close to 2\.9s/);
  assert.match(report.notes[1] ?? "", /never\s+changes/);
});

test("a script with a genuine short line and a curve passes", () => {
  const report = measureRhythm(plan([
    {energy: "settled", durations: [3400, 2300]},
    {energy: "edge", durations: [1100, 4200]},
    {energy: "quiet", durations: [900]},
    {energy: "lift", durations: [3800, 2600]},
  ]));

  assert.deepEqual(report.notes, []);
  assert.ok(report.variation >= 0.22, `variation was ${report.variation}`);
  assert.deepEqual(report.energies, ["quiet", "settled", "lift", "edge"]);
  assert.equal(report.shortestMs, 900);
  assert.equal(report.longestMs, 4200);
});

test("varied lengths but one energy still flags the delivery", () => {
  const report = measureRhythm(plan([
    {energy: "settled", durations: [900, 4200]},
    {energy: "settled", durations: [1100, 3800]},
    {energy: "settled", durations: [2600]},
  ]));

  assert.equal(report.notes.length, 1);
  assert.match(report.notes[0] ?? "", /Every section is marked `settled`/);
});

test("a two-section piece is not judged on its energy curve", () => {
  const report = measureRhythm(plan([
    {energy: "settled", durations: [900, 4200]},
    {energy: "settled", durations: [1100, 3800]},
  ]));
  assert.deepEqual(report.notes, []);
});

test("too few measured lines to judge reports nothing rather than guessing", () => {
  const report = measureRhythm(plan([{energy: "settled", durations: [0, 0]}]));
  assert.deepEqual(report.notes, []);
  assert.equal(report.meanMs, 0);
});
