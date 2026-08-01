import assert from "node:assert/strict";
import test from "node:test";
import {codexChildEnv} from "./codexCli.ts";

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
