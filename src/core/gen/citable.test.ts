import assert from "node:assert/strict";
import {test} from "node:test";
import {citableBlock, type PlanRequest} from "./planner.ts";

const request = (citableFacts: PlanRequest["citableFacts"]): PlanRequest =>
  ({citableFacts} as PlanRequest);

const FRESH = {id: "f-fresh", statement: "Teams lose 3.4 hours a day to production.", source: "https://a.example"};
const SPENT = {
  id: "f-spent",
  statement: "Only 21% report strong results.",
  source: "https://b.example",
  used: {count: 2, lastAt: "2026-07-12T09:00:00.000Z"},
};

test("a qualitative fact is never offered as a chartable figure", () => {
  // A `data` block against a fact with no number produces invented values wearing a real
  // id, which is worse than no chart: it looks sourced.
  const block = citableBlock(request([{id: "f-q", statement: "Teams feel overloaded.", source: ""}]));
  assert.equal(block, "");
});

test("an unused figure is listed with no usage note", () => {
  const block = citableBlock(request([FRESH]));
  assert.match(block, /f-fresh/);
  assert.ok(!block.includes("already charted"), "an unused figure must not be marked as spent");
});

test("a figure that has been charted says so, with a date", () => {
  const block = citableBlock(request([SPENT]));
  assert.match(block, /already charted in 2 video\(s\), last 2026-07-12/);
});

test("unused figures come first", () => {
  // Order is the whole mechanism. Verifying a number is slow, so the pool is small, and a
  // small pool read top-down is how the same statistic ends up in every video.
  const block = citableBlock(request([SPENT, FRESH]));
  assert.ok(block.indexOf("f-fresh") < block.indexOf("f-spent"));
});

test("among spent figures the least recently used comes first", () => {
  const recent = {...SPENT, id: "f-recent", used: {count: 2, lastAt: "2026-07-28T09:00:00.000Z"}};
  const block = citableBlock(request([recent, SPENT]));
  assert.ok(block.indexOf("f-spent") < block.indexOf("f-recent"));
});

test("the preference is stated only when something has actually been used", () => {
  // A standing instruction to prefer an unused figure, in a list where every figure is
  // unused, is noise the planner has to read past on every run.
  assert.ok(!citableBlock(request([FRESH])).includes("Prefer one that"));
  assert.match(citableBlock(request([FRESH, SPENT])), /Prefer one that\s+has not/);
});

test("repetition is discouraged, never refused", () => {
  // The gate that refuses is assertPlanClaimsAreSourced, and it is about whether a number
  // is sourced. Whether a figure has been used before is a judgement — sometimes the
  // number IS the video, and the second piece about it is the better one.
  const block = citableBlock(request([SPENT]));
  assert.ok(!/refused if.*charted|may not.*reuse|forbidden/i.test(block));
  assert.match(block, /unless this video is specifically about that number/);
});

test("the input list is not reordered in place", () => {
  // citableFacts is built by the caller and read again after planning; sorting it in place
  // would quietly change what the caller sees.
  const facts = [SPENT, FRESH];
  citableBlock(request(facts));
  assert.equal(facts[0]?.id, "f-spent");
});
