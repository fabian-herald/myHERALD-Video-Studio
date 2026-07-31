import assert from "node:assert/strict";
import test from "node:test";
import {controlledSlices, wordErrorRate, WITHIN_SECTION_GAP_MS, BETWEEN_SECTION_GAP_MS} from "./quality.ts";

test("controlled slices preserve speech and impose only the declared boundary gaps", () => {
  const targets = [
    {sectionId: "a", phraseId: "one", text: "One."},
    {sectionId: "a", phraseId: "two", text: "Two."},
    {sectionId: "b", phraseId: "three", text: "Three."},
  ];
  const aligned = [
    {sectionId: "a", phraseId: "one", startMs: 100, durationMs: 500, confidence: 1},
    {sectionId: "a", phraseId: "two", startMs: 1200, durationMs: 400, confidence: 1},
    {sectionId: "b", phraseId: "three", startMs: 3000, durationMs: 600, confidence: 1},
  ];
  const slices = controlledSlices(aligned, targets, 4000);
  assert.deepEqual(slices.map((slice) => slice.gapAfterMs), [WITHIN_SECTION_GAP_MS, BETWEEN_SECTION_GAP_MS, 0]);
  assert.equal(slices[0]?.startMs, 75);
  assert.equal(slices[0]?.durationMs, 585);
});

test("word error rate counts substitutions, insertions, and deletions", () => {
  assert.equal(wordErrorRate("One two three", [
    {word: "one", start: 0, end: 1},
    {word: "too", start: 1, end: 2},
    {word: "three", start: 2, end: 3},
  ]), 1 / 3);
  assert.equal(wordErrorRate("Hello, world!", [
    {word: "hello", start: 0, end: 1},
    {word: "world", start: 1, end: 2},
  ]), 0);
});
