import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {CAPTION_MAX_CHARS, CAPTION_MAX_WORDS} from "../render/qc.ts";

const planner = () => readFileSync(new URL("./planner.ts", import.meta.url), "utf8");

/**
 * Phrases are joined with "\n" and read as one take (`narrate.ts`), so their punctuation is
 * performance direction. A forty-five second script arriving as fourteen full stops was read
 * as fourteen falling sentences: "Optimizely's 2026 survey found 25%." landed as a statistic
 * with nothing attached, and the same full stops held the take at 1.5 words per second
 * against the 1.85 floor its profile requires. Repunctuating the identical words — same
 * voice, same script, only the terminal marks changed — measured 1.85 wps on the first take.
 */
test("the planner is told its phrases are read as one continuous take", () => {
  const source = planner();
  assert.match(source, /read aloud as one continuous take/i);
  assert.match(source, /full stop only where the thought genuinely ends/i);
});

test("the schema no longer calls a caption page a sentence", () => {
  // "<one spoken sentence>" is what produced a full stop per caption page.
  assert.doesNotMatch(planner(), /<one spoken sentence>/);
  assert.match(planner(), /one caption page/);
});

test("repunctuating is not licence to add words", () => {
  // Asking for flow without saying this cost three straight plan rejections: the model
  // added linking words ("so...", "and...") and overran the 52-character caption cap.
  const source = planner();
  assert.match(source, /change of punctuation, not of/i);
  assert.match(source, /Do\s+not add linking words/i);
  assert.match(source, /caps above are hard/i);
});

test("the caption caps still reach the planner from their single source", () => {
  const source = planner();
  assert.match(source, /\$\{CAPTION_MAX_WORDS\} words/);
  assert.match(source, /\$\{CAPTION_MAX_CHARS\} characters/);
  // Interpolated, not transcribed — a hand-copied limit drifts from the checker that enforces it.
  assert.equal(CAPTION_MAX_WORDS, 8);
  assert.equal(CAPTION_MAX_CHARS, 52);
});
