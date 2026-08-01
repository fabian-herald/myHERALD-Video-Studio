import assert from "node:assert/strict";
import test from "node:test";
import {settingsZ} from "./settings.ts";

test("old settings files migrate to subscription providers and enabled guidance", () => {
  const settings = settingsZ.parse({contentLanguage: "de", composer: "codex"});
  assert.equal(settings.agent, "claude");
  assert.equal(settings.planner, "claude");
  assert.equal(settings.composer, "codex");
  assert.deepEqual(settings.marketingSkills, {
    adCreative: true,
    social: true,
    marketingPsychology: true,
  });
});
