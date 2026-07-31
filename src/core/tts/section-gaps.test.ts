import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {test} from "node:test";
import {probeDuration, run} from "../util/exec.ts";
import {compactSectionGaps, sectionGapCuts, shiftPlacedAfterCuts} from "./section-gaps.ts";

const PLACED = [
  {sectionId: "one", phraseId: "a", startMs: 100, durationMs: 900},
  {sectionId: "one", phraseId: "b", startMs: 1400, durationMs: 600},
  {sectionId: "two", phraseId: "c", startMs: 4000, durationMs: 700},
  {sectionId: "two", phraseId: "d", startMs: 5700, durationMs: 500},
  {sectionId: "three", phraseId: "e", startMs: 6800, durationMs: 600},
];

test("only overlong gaps between sections are shortened", () => {
  const cuts = sectionGapCuts(PLACED, 650);
  assert.deepEqual(cuts, [{
    afterSectionId: "one",
    beforeSectionId: "two",
    startMs: 2325,
    endMs: 3675,
    removedMs: 1350,
  }]);
});

test("speech duration is unchanged and later words move by only removed silence", () => {
  const cuts = sectionGapCuts(PLACED, 650);
  const shifted = shiftPlacedAfterCuts(PLACED, cuts);
  assert.deepEqual(shifted.slice(0, 2), PLACED.slice(0, 2));
  assert.deepEqual(shifted[2], {...PLACED[2], startMs: 2650});
  assert.deepEqual(shifted[4], {...PLACED[4], startMs: 5450});
  assert.deepEqual(shifted.map((phrase) => phrase.durationMs), PLACED.map((phrase) => phrase.durationMs));
});

test("a short section boundary and every within-section pause remain untouched", () => {
  const cuts = sectionGapCuts(PLACED, 650);
  assert.equal(cuts.some((cut) => cut.afterSectionId === "two"), false);
  assert.equal(cuts.some((cut) => cut.afterSectionId === cut.beforeSectionId), false);
});

test("the audio edit removes only the planned centre of the section gap", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "section-gap-test-"));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const input = path.join(dir, "input.wav");
  const output = path.join(dir, "output.wav");
  await run("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-t", "5",
    "-i", "anullsrc=r=24000:cl=mono", "-c:a", "pcm_s16le", input,
  ]);
  const result = await compactSectionGaps(input, output, [
    {sectionId: "one", phraseId: "a", startMs: 0, durationMs: 1000},
    {sectionId: "two", phraseId: "b", startMs: 3000, durationMs: 1000},
  ]);
  assert.equal(result.cuts[0]?.removedMs, 1350);
  assert.equal(result.placed[1]?.startMs, 1650);
  assert.ok(Math.abs(await probeDuration(output) - 3.65) < 0.02);
});
