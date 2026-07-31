import assert from "node:assert/strict";
import {test} from "node:test";
import {buildIntentTakePrompt} from "./gemini.ts";
import {NARRATION_PROFILES} from "./intent-profile.ts";
import {narrationProfileForIntent} from "../plan/schema.ts";
import type {TakeRequest} from "./provider.ts";
import type {VideoPlan} from "../plan/schema.ts";

const request = (intent: VideoPlan["intent"]): TakeRequest => ({
  intent,
  text: Array.from({length: 100}, () => "word").join(" "),
  blocks: [
    {direction: "", lines: ["First section."]},
    {direction: "", lines: ["Second section."]},
    {direction: "", lines: ["Third section."]},
    {direction: "", lines: ["Final section."]},
  ],
  voiceId: "Achird",
  style: "Warm, credible, founder-to-founder.",
  register: "one man, low-to-mid register",
  arc: "",
  language: "en",
  outputPath: "/tmp/intent.wav",
});

test("every video intent owns a profile and promotional owns two distinct deliveries", () => {
  assert.deepEqual(Object.keys(NARRATION_PROFILES).sort(), [
    "announcement", "educational", "performance-ad", "social-promotional", "thought-leadership",
  ]);
  assert.equal(NARRATION_PROFILES["social-promotional"].sectionGapMs, 800);
  assert.equal(NARRATION_PROFILES["performance-ad"].sectionGapMs, 450);
  assert.equal(narrationProfileForIntent("promotional"), "performance-ad");
  assert.equal(narrationProfileForIntent("promotional", "social-promotional"), "social-promotional");
  assert.throws(
    () => narrationProfileForIntent("educational", "performance-ad"),
    /not supported for educational/,
  );
});

test("every intent prompt uses three arc tags and only section pause markers", () => {
  for (const profile of Object.values(NARRATION_PROFILES)) {
    const prompt = buildIntentTakePrompt(request(profile.intent), profile.intent, profile.id);
    assert.match(prompt, new RegExp(`\\[${profile.tags[0]}\\]`));
    assert.match(prompt, new RegExp(`\\[${profile.tags[1]}\\]`));
    assert.match(prompt, new RegExp(`\\[${profile.tags[2]}\\]`));
    assert.equal(prompt.match(/\[short pause\]/g)?.length, 3);
    assert.doesNotMatch(prompt, /\[medium pause\]/);
    assert.ok(prompt.trimEnd().endsWith(`[${profile.tags[2]}] Final section.`));
  }
});

test("promotional is fastest while each approved listening beat remains explicit", () => {
  const social = NARRATION_PROFILES["social-promotional"];
  const performanceAd = NARRATION_PROFILES["performance-ad"];
  const thought = NARRATION_PROFILES["thought-leadership"];
  assert.ok(performanceAd.promptTargetWps > social.promptTargetWps);
  assert.ok(social.promptTargetWps > thought.promptTargetWps);
  assert.equal(social.sectionGapMs, 800);
  assert.equal(performanceAd.sectionGapMs, 450);
  assert.equal(thought.sectionGapMs, 650);
  assert.deepEqual(thought.rawPaceRange, [1.85, 2.25]);
});
