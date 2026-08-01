import assert from "node:assert/strict";
import test from "node:test";
import {codexStudioMcpConfig, parseCodexEvent} from "./agent.ts";

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

test("Codex Studio MCP is required and approves only its bearer-scoped local tools", () => {
  const config = codexStudioMcpConfig("http://127.0.0.1:5174/api/codex-mcp");
  assert.ok(config.includes('mcp_servers.studio.url="http://127.0.0.1:5174/api/codex-mcp"'));
  assert.ok(config.includes('mcp_servers.studio.bearer_token_env_var="MYHERALD_CODEX_MCP_TOKEN"'));
  assert.ok(config.includes("mcp_servers.studio.required=true"));
  assert.ok(config.includes('mcp_servers.studio.default_tools_approval_mode="approve"'));
  assert.ok(config.includes("features.shell_tool=false"));
});
