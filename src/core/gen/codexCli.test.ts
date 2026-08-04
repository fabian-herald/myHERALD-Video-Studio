import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {codexChildEnv, codexEffort, codexModel} from "./codexCli.ts";
import {readSettings, settingsZ} from "../settings.ts";

test("Codex child processes never inherit OpenAI API billing keys", () => {
  const beforeOpenAi = process.env.OPENAI_API_KEY;
  const beforeCodex = process.env.CODEX_API_KEY;
  process.env.OPENAI_API_KEY = "must-not-leak";
  process.env.CODEX_API_KEY = "must-not-leak";
  try {
    const env = codexChildEnv({MYHERALD_CODEX_MCP_TOKEN: "short-lived"});
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.CODEX_API_KEY, undefined);
    assert.equal(env.MYHERALD_CODEX_MCP_TOKEN, "short-lived");
  } finally {
    if (beforeOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = beforeOpenAi;
    if (beforeCodex === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = beforeCodex;
  }
});

test("the environment outranks settings, and settings outrank the built-in default", async () => {
  const before = {
    model: process.env.CODEX_MODEL,
    effort: process.env.CODEX_REASONING_EFFORT,
  };
  try {
    // A one-off `CODEX_MODEL=… npm run make` is how a new model gets tried without
    // committing the studio to it, so the environment has to win.
    process.env.CODEX_MODEL = "some-experimental-model";
    process.env.CODEX_REASONING_EFFORT = "medium";
    assert.equal(await codexModel(), "some-experimental-model");
    assert.equal(await codexEffort(), "medium");

    delete process.env.CODEX_MODEL;
    delete process.env.CODEX_REASONING_EFFORT;
    const settings = await readSettings();
    assert.equal(await codexModel(), settings.codexModel || "gpt-5.6-terra");
    assert.equal(await codexEffort(), settings.codexComposeEffort);
  } finally {
    if (before.model === undefined) delete process.env.CODEX_MODEL;
    else process.env.CODEX_MODEL = before.model;
    if (before.effort === undefined) delete process.env.CODEX_REASONING_EFFORT;
    else process.env.CODEX_REASONING_EFFORT = before.effort;
  }
});

test("an empty model setting falls through to the default rather than shipping \"\"", async () => {
  // `??` would have let a saved-then-cleared field reach the CLI as an empty --model.
  const settings = settingsZ.parse({codexModel: ""});
  assert.equal(settings.codexModel, "");
  assert.equal(settings.codexComposeEffort, "xhigh", "the visual default, not the cheap one");
});

test("composing effort is a settings knob; planning and chat are not", async () => {
  // Named codexComposeEffort deliberately. Planning is structured extraction and the studio
  // agent is conversation — neither is where the visual gap against Claude was measured.
  const source = readFileSync(new URL("./planner.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /codexEffort/);
  assert.doesNotMatch(readFileSync(new URL("../../server/agent.ts", import.meta.url), "utf8"), /codexEffort/);
});
