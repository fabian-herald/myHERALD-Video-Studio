import assert from "node:assert/strict";
import test from "node:test";
import {parseCodexEvent} from "./agent.ts";

test("Codex JSONL exposes its resumable thread and final message", () => {
  assert.deepEqual(
    parseCodexEvent(JSON.stringify({type: "thread.started", thread_id: "019f-test"})),
    {threadId: "019f-test"},
  );
  assert.deepEqual(
    parseCodexEvent(JSON.stringify({type: "item.completed", item: {type: "agent_message", text: "Done."}})),
    {message: "Done."},
  );
});

test("Codex event parsing ignores non-JSON diagnostic output", () => {
  assert.equal(parseCodexEvent("warning from the CLI"), null);
});
