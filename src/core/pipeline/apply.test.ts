import assert from "node:assert/strict";
import test from "node:test";
import {narrationInputsMatch, sceneDisplaysCopy} from "./apply.ts";
import type {VideoPlan} from "../plan/schema.ts";

test("styled display copy is recognised across line breaks and highlights", () => {
  const html = `
    <section id="scene-false-promise">
      <h1>More drafts.<br>Less <mark>clarity.</mark></h1>
    </section>
  `;

  assert.equal(
    sceneDisplaysCopy(html, "false-promise", "More drafts. Less clarity."),
    true,
  );
});

test("different punctuation is not mistaken for an applied split-copy edit", () => {
  const html = `
    <section id="scene-false-promise">
      <h1>More drafts.<br>Less <mark>clarity.</mark></h1>
    </section>
  `;

  assert.equal(
    sceneDisplaysCopy(html, "false-promise", "More drafts. Less clarity"),
    false,
  );
});

test("display-only edits reuse narration but spoken delivery changes do not", () => {
  const plan = {
    intent: "thought-leadership",
    language: "en",
    narration: {provider: "gemini", voice: "Achird", profile: "thought-leadership"},
    sections: [{
      id: "hook",
      energy: "edge",
      onScreen: "Before",
      phrases: [{id: "line", text: "Spoken words.", startMs: 10, durationMs: 500, gapAfterMs: 0}],
    }],
  } as unknown as VideoPlan;

  assert.equal(narrationInputsMatch(plan, {
    ...plan,
    sections: [{...plan.sections[0]!, onScreen: "After"}],
  }), true);
  assert.equal(narrationInputsMatch(plan, {
    ...plan,
    sections: [{...plan.sections[0]!, energy: "quiet"}],
  }), false);
  assert.equal(narrationInputsMatch(plan, {
    ...plan,
    sections: [{
      ...plan.sections[0]!,
      phrases: [{...plan.sections[0]!.phrases[0]!, text: "Different words."}],
    }],
  }), false);
});
