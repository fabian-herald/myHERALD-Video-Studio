import assert from "node:assert/strict";
import test from "node:test";
import {settingsZ} from "../settings.ts";
import {marketingGuidanceFor} from "./guidance.ts";

test("performance ads receive ad guidance without organic-social rules", () => {
  const result = marketingGuidanceFor(settingsZ.parse({}), "promotional", "performance-ad");
  assert.deepEqual(result.ids, ["ad-creative", "marketing-psychology"]);
  assert.doesNotMatch(result.prompt, /three-second-hook cadence/i);
  assert.match(result.prompt, /Never invent social proof/i);
});

test("ad creative never leaks into organic or thought-leadership planning", () => {
  const organic = marketingGuidanceFor(settingsZ.parse({}), "promotional", "social-promotional");
  const thought = marketingGuidanceFor(settingsZ.parse({}), "thought-leadership", "thought-leadership");
  assert.ok(!organic.ids.includes("ad-creative"));
  assert.ok(!thought.ids.includes("ad-creative"));
  assert.match(thought.prompt, /thought leadership must keep its calm authority/i);
});

test("every marketing aid can be disabled independently", () => {
  const settings = settingsZ.parse({marketingSkills: {
    adCreative: false,
    social: false,
    marketingPsychology: true,
  }});
  const result = marketingGuidanceFor(settings, "promotional", "performance-ad");
  assert.deepEqual(result.ids, ["marketing-psychology"]);
});
