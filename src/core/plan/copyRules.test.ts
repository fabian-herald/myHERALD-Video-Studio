import assert from "node:assert/strict";
import {test} from "node:test";
import {CAPTION_MAX_WORDS} from "../render/qc.ts";
import {assertPlanCopyRules, copyRulesViolation} from "./copyRules.ts";
import {videoPlanZ, type VideoPlan} from "./schema.ts";

const rules = {bannedWords: ["leverage", "world-class"]};

function plan(): VideoPlan {
  return videoPlanZ.parse({
    schemaVersion: 1,
    id: "copy-test",
    createdAt: "2026-08-01T00:00:00Z",
    brief: "test",
    intent: "educational",
    formats: ["9x16"],
    language: "en",
    title: "Copy test",
    thesis: "The edit path uses the planning rules.",
    sections: [
      {id: "one", kind: "hook", onScreen: "One thought", phrases: [{id: "a", text: "A short line."}]},
      {id: "two", kind: "point", onScreen: "Then proof", phrases: [{id: "b", text: "Another short line."}]},
    ],
    narration: {},
  });
}

test("valid edited copy passes the shared planning rules", () => {
  assert.equal(copyRulesViolation(plan(), rules), null);
  assert.doesNotThrow(() => assertPlanCopyRules(plan(), rules));
});

test("banned words and em-dashes are rejected together", () => {
  const edited = plan();
  edited.sections[0]!.phrases[0]!.text = "Leverage this — it is world-class.";
  const violation = copyRulesViolation(edited, rules);
  assert.match(violation ?? "", /banned word "leverage"/);
  assert.match(violation ?? "", /banned word "world-class"/);
  assert.match(violation ?? "", /em-dash/);
});

test("caption and on-screen limits are enforced after an edit", () => {
  const edited = plan();
  edited.sections[0]!.phrases[0]!.text = Array.from(
    {length: CAPTION_MAX_WORDS + 1},
    (_, index) => `word${index}`,
  ).join(" ");
  edited.sections[1]!.onScreen = "one two three four five six seven";
  const violation = copyRulesViolation(edited, rules);
  assert.match(violation ?? "", /one\/a is/);
  assert.match(violation ?? "", /two onScreen copy is longer than six words/);
});

test("the edit-path assertion fails before expensive work can begin", () => {
  const edited = plan();
  edited.sections[0]!.phrases[0]!.text = "A world-class claim.";
  assert.throws(
    () => assertPlanCopyRules(edited, rules),
    /No narration or render was started/,
  );
});
