import assert from "node:assert/strict";
import {test} from "node:test";
import {assessPace} from "./narrate.ts";

const SCRIPT = Array.from({length: 100}, () => "word").join(" ");

test("thought leadership accepts the calm raw pace that produced B886-controlled", () => {
  const pace = assessPace("thought-leadership", SCRIPT, 50_000);
  assert.equal(pace.wordsPerSecond, 2);
  assert.equal(pace.fault, false);
});

test("thought leadership rejects an ad-speed take instead of preferring the shorter one", () => {
  const pace = assessPace("thought-leadership", SCRIPT, 38_000);
  assert.ok(pace.wordsPerSecond > 2.6);
  assert.equal(pace.fault, true);
});

test("a quick pace remains valid for the default performance-ad narration", () => {
  assert.equal(assessPace("promotional", SCRIPT, 38_000).fault, false);
});

test("performance ads reject a take that only reaches the social-promotional pace", () => {
  assert.equal(assessPace("promotional", SCRIPT, 44_000).fault, true);
  assert.equal(assessPace("promotional", SCRIPT, 44_000, "social-promotional").fault, false);
});
