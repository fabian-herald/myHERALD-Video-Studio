import crypto from "node:crypto";
import type http from "node:http";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {studioTools, type ToolContext} from "../core/tools/index.ts";

const transports = new Map<string, StreamableHTTPServerTransport>();

export async function registerCodexStudioTools(context: ToolContext) {
  const token = crypto.randomBytes(24).toString("base64url");
  // Codex performs the Streamable HTTP handshake over multiple requests: initialize,
  // initialized, then tools/list and calls. A stateless transport is one-request-only;
  // reusing it made the second request fail with HTTP 500. This transport lives exactly
  // as long as the turn's bearer token, so a real MCP session is the correct boundary.
  const transport = new StreamableHTTPServerTransport({sessionIdGenerator: () => crypto.randomUUID()});
  await studioTools(context).instance.connect(transport);
  transports.set(token, transport);
  return {
    token,
    async close() {
      transports.delete(token);
      await transport.close().catch(() => {});
    },
  };
}

export async function handleCodexMcp(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const authorization = request.headers.authorization ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const transport = transports.get(token);
  if (!transport) {
    response.writeHead(401, {"Content-Type": "application/json"});
    response.end(JSON.stringify({error: "Invalid or expired studio tool token."}));
    return;
  }
  await transport.handleRequest(request, response);
}
