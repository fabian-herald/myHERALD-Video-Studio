import {query, type Options, type PermissionResult} from "@anthropic-ai/claude-agent-sdk";
import {spawn} from "node:child_process";
import readline from "node:readline";
import {loadBrandKit} from "../core/brand/kit.ts";
import {isCancellation} from "../core/cancel.ts";
import {billingMode} from "../core/cost.ts";
import {ROOT} from "../core/paths.ts";
import {STUDIO_TOOL_NAMES, studioTools} from "../core/tools/index.ts";
import {appendMessage, conversationOnly, saveThread, type Thread} from "../core/threads.ts";
import {codexChildEnv, codexModel, requireCodexSubscription} from "../core/gen/codexCli.ts";
import {registerCodexStudioTools} from "./codexMcp.ts";

export interface AgentEvent {
  type: "message" | "event" | "done" | "error";
  text: string;
  tool?: string;
  videoId?: string;
  /** Split apart deliberately — see core/cost.ts. */
  cost?: {chargedUsd: number; apiEquivalentUsd: number; billingMode: string};
}

const BASE_PROMPT = `You are the myHERALD video studio. You turn one sentence into a
finished video, and you talk to one person — the owner of the brand.

How you work:

- Read the context and search previous videos before planning anything. Repeating a
  thesis you have already published is the failure mode to avoid.
- Research before you plan, without being asked. If the piece would land harder with a
  figure — and a piece about a problem almost always would — go and find one: recall_sources
  first, since a page the studio has already read costs nothing and comes back with its
  quoted sentence; then search_web, read_source on the two or three results worth reading,
  and propose_facts on what survives. Do this as part of making the video, not as a separate
  errand the owner has to request. Then save_brief, including what you could not source.
- Use read_source for every third-party evidence page. research_web is only for the brand's
  own website because it imports page statements as proposed product facts.
- One good figure beats three. A video carrying a single number someone can check is
  stronger than one stacked with statistics, and every extra figure is another claim you
  have to stand behind.
- If the useful figure is new and still proposed, stop after saving the research brief and
  ask the owner to approve or reject it in the Sources/Brand UI. Do not quietly make the
  video without the figure in the same turn and do not treat your proposal as approval.
- Say when you came back empty. "I could not find a defensible number for this, so the
  video argues it without one" is a fine outcome and the owner needs to hear it. Never
  reach for a number you could not source, and never present a figure as covering more
  than it does — a survey of content professionals is not a survey of B2B marketers.
- Once research is complete and any figure decision is settled, make the video. Do not ask
  which format or how long unless the request is
  genuinely ambiguous about what kind of piece it is — the intent presets already
  answer those questions.
- When the owner does name a format or aspect ratio, pass that exact value in make_video's
  formats field. Never announce landscape while silently accepting portrait defaults.
- When it is done, say what you made in two or three sentences: the thesis, the shape,
  and anything you are not happy with. Do not list file paths; the owner sees them.
- For wording or pacing changes on an existing video use edit_video. It is fast and
  free. Only reach for a full rebuild when the *structure* has to change. After an edit,
  QC passing is not sufficient: if edit_video returns any needsCompose entries, say the
  video is stale and name the unresolved visual change. Never describe that edit as
  finished or claim its display copy changed.
- You cannot spend money. Anything paid stops at an approval the owner clicks.

Two languages, kept apart. Reply in whatever language the owner writes to you in. The
language a *video* is written, spoken and captioned in is a separate setting, reported
by read_context; leave it alone unless they ask for one particular video in another
language. Someone writing to you in German has not thereby asked for a German video.

Be direct and brief. This is a working tool, not a chat companion.`;

function permission(toolName: string): PermissionResult {
  const allowed = [...STUDIO_TOOL_NAMES, "TodoWrite"];
  return allowed.includes(toolName)
    ? {behavior: "allow", updatedInput: {}}
    : {behavior: "deny", message: `${toolName} is not available in the studio.`};
}

/**
 * Run one turn of a thread, streaming tool calls and text as they happen.
 *
 * The agent orchestrates; the pipeline stays deterministic underneath. Session ids are
 * persisted on the thread so reopening a video months later keeps its context, while
 * the durable memory of what exists lives in the ledger, not in this transcript.
 */
export async function* runAgentTurn(options: {
  thread: Thread;
  prompt: string;
  agentId: "claude" | "codex";
  plannerId: "claude" | "codex";
  composerId: string;
  codexMcpUrl: string;
  signal?: AbortSignal;
}): AsyncGenerator<AgentEvent> {
  if (options.agentId === "codex") {
    yield* runCodexAgentTurn(options);
    return;
  }

  const {thread, prompt, plannerId, composerId, signal} = options;
  const kit = await loadBrandKit().catch(() => null);

  let videoId = thread.videoId;
  const pending: AgentEvent[] = [];
  const context = {
    threadId: thread.id,
    onLog: (line: string, tool?: string) => pending.push({type: "event", text: line, tool}),
    getVideoId: () => videoId,
    setVideoId: (next: string) => {
      videoId = next;
    },
    plannerId,
    composerId,
    signal,
  };

  const controller = new AbortController();
  signal?.addEventListener("abort", () => controller.abort(), {once: true});

  const sdkOptions: Options = {
    cwd: ROOT,
    systemPrompt: kit
      ? `${BASE_PROMPT}\n\nThe brand is ${kit.name} — ${kit.tagline} (${kit.website}).`
      : BASE_PROMPT,
    mcpServers: {studio: studioTools(context)},
    allowedTools: [...STUDIO_TOOL_NAMES, "TodoWrite"],
    settingSources: [],
    permissionMode: "default",
    canUseTool: async (toolName) => permission(toolName),
    maxTurns: 40,
    abortController: controller,
    ...(thread.sessions.claude ?? thread.sessionId
      ? {resume: thread.sessions.claude ?? thread.sessionId}
      : {}),
  };

  let sessionId = thread.sessions.claude ?? thread.sessionId;
  let costUsd = 0;

  // Held rather than iterated anonymously, so it can be closed. Aborting the controller
  // stops messages arriving here but leaves the CLI the SDK spawned running: one survived a
  // cancelled run by twenty minutes, and an orphan from two days earlier was still holding
  // the studio's port this morning. `close()` is the SDK's own shutdown, and `finally` runs
  // it on every exit — a normal finish, a thrown error, or the owner pressing stop.
  const session = query({prompt, options: sdkOptions});
  const closeSession = () => session.close();
  signal?.addEventListener("abort", closeSession, {once: true});

  try {
    for await (const message of session) {
      // Tool output queued by the pipeline is flushed before the next model message,
      // so the run log stays in the order things actually happened.
      while (pending.length) yield pending.shift() as AgentEvent;

      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
      } else if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim()) {
            yield {type: "message", text: block.text};
          } else if (block.type === "tool_use") {
            // Studio tools narrate themselves with real numbers, so announcing the
            // call as well would just print every step twice. Anything outside the
            // allowlist is about to be denied and is not worth showing at all.
            const label = describe(block.name);
            if (label) yield {type: "event", text: label, tool: block.name};
          }
        }
      } else if (message.type === "result") {
        costUsd = message.total_cost_usd ?? 0;
        if (message.subtype !== "success") {
          yield {type: "error", text: `The run stopped: ${message.subtype}.`};
        }
      }
    }
    while (pending.length) yield pending.shift() as AgentEvent;
  } catch (error) {
    // A cancelled run is a thing the owner did, not a fault. It still reaches the transcript
    // — a turn that spent twenty minutes and produced nothing should say why — but as a
    // record rather than a warning, and the session is still saved below so the thread can
    // pick up where it stopped.
    if (isCancellation(error) || signal?.aborted) yield {type: "event", text: "run stopped"};
    else yield {type: "error", text: (error as Error).message};
  } finally {
    signal?.removeEventListener("abort", closeSession);
    try {
      session.close();
    } catch {
      // Already closed by the abort listener. Closing twice is not a failure worth
      // surfacing, and throwing here would replace a real error with a cleanup one.
    }
  }

  await saveThread({...thread, sessionId, sessions: {...thread.sessions, claude: sessionId}, videoId});
  const mode = billingMode();
  yield {
    type: "done",
    text: "",
    videoId,
    cost: {
      chargedUsd: mode === "api" ? costUsd : 0,
      apiEquivalentUsd: costUsd,
      billingMode: mode,
    },
  };
}

/**
 * One-turn, bearer-scoped MCP configuration for the subscription-backed Studio agent.
 * Kept as data so the fail-closed and non-interactive approval guarantees are testable
 * without launching Codex.
 */
export function codexStudioMcpConfig(url: string): string[] {
  return [
    "-c", `mcp_servers.studio.url="${url}"`,
    "-c", "mcp_servers.studio.bearer_token_env_var=\"MYHERALD_CODEX_MCP_TOKEN\"",
    // The studio tools are the product, not an optional convenience. Without this,
    // Codex quietly starts with its generic tool set when the bridge fails and can only
    // apologise after the owner has waited for a turn. Required makes startup fail closed.
    "-c", "mcp_servers.studio.required=true",
    // The bearer token scopes this server to one Studio turn, and the server itself
    // exposes only STUDIO_TOOL_NAMES. `codex exec` is non-interactive, so leaving the
    // default at prompt turns every legitimate call into "user cancelled".
    "-c", "mcp_servers.studio.default_tools_approval_mode=\"approve\"",
    "-c", "mcp_servers.studio.tool_timeout_sec=1800",
    "-c", "features.shell_tool=false",
  ];
}

async function* runCodexAgentTurn(options: {
  thread: Thread;
  prompt: string;
  agentId: "claude" | "codex";
  plannerId: "claude" | "codex";
  composerId: string;
  codexMcpUrl: string;
  signal?: AbortSignal;
}): AsyncGenerator<AgentEvent> {
  const {thread, plannerId, composerId, signal} = options;
  const executable = await requireCodexSubscription();
  const kit = await loadBrandKit().catch(() => null);
  const pending: AgentEvent[] = [];
  let videoId = thread.videoId;
  let sessionId = thread.sessions.codex;

  const registration = await registerCodexStudioTools({
    threadId: thread.id,
    onLog: (line: string, tool?: string) => pending.push({type: "event", text: line, tool}),
    getVideoId: () => videoId,
    setVideoId: (next: string) => {
      videoId = next;
    },
    plannerId,
    composerId,
    signal,
  });

  const model = await codexModel();
  const mcpConfig = codexStudioMcpConfig(options.codexMcpUrl);
  const args = sessionId
    ? ["exec", "resume", "--ignore-user-config", "--ignore-rules", "--model", model, ...mcpConfig, "--json", sessionId, "-"]
    : ["exec", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only", "--cd", ROOT,
        "--model", model, ...mcpConfig, "--json", "-"];

  const history = !sessionId && conversationOnly(thread).length
    ? `\n\nConversation before this provider was selected:\n${conversationOnly(thread)
        .map((message) => `${message.role === "user" ? "Owner" : "Studio"}: ${message.text}`)
        .join("\n")}`
    : "";
  const system = kit
    ? `${BASE_PROMPT}\n\nThe brand is ${kit.name} — ${kit.tagline} (${kit.website}).`
    : BASE_PROMPT;
  const input = sessionId ? options.prompt : `${system}${history}\n\nOwner: ${options.prompt}`;

  let failure = "";
  try {
    const child = spawn(executable, args, {
      cwd: ROOT,
      env: codexChildEnv({MYHERALD_CODEX_MCP_TOKEN: registration.token}),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, {once: true});
    child.stderr.on("data", (chunk: Buffer) => {
      failure = `${failure}${chunk.toString("utf8")}`.slice(-4000);
    });
    child.stdin.end(input);

    const lines = readline.createInterface({input: child.stdout});
    for await (const line of lines) {
      while (pending.length) yield pending.shift() as AgentEvent;
      const event = parseCodexEvent(line);
      if (!event) continue;
      if (event.threadId) sessionId = event.threadId;
      if (event.message) yield {type: "message", text: event.message};
      if (event.tool) {
        const label = describe(`mcp__studio__${event.tool}`);
        if (label) yield {type: "event", text: label, tool: event.tool};
      }
      if (event.error) failure = event.error;
    }
    const code = await exit;
    while (pending.length) yield pending.shift() as AgentEvent;
    if (code !== 0 && !signal?.aborted) yield {type: "error", text: failure.trim() || `Codex stopped with code ${code}.`};
    else if (signal?.aborted) yield {type: "event", text: "run stopped"};
    signal?.removeEventListener("abort", abort);
  } catch (error) {
    if (isCancellation(error) || signal?.aborted) yield {type: "event", text: "run stopped"};
    else yield {type: "error", text: (error as Error).message};
  } finally {
    await registration.close();
  }

  await saveThread({...thread, sessions: {...thread.sessions, codex: sessionId}, videoId});
  yield {
    type: "done",
    text: "",
    videoId,
    cost: {chargedUsd: 0, apiEquivalentUsd: 0, billingMode: "subscription"},
  };
}

export function parseCodexEvent(line: string): {
  threadId?: string;
  message?: string;
  tool?: string;
  error?: string;
} | null {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (event.type === "thread.started" && typeof event.thread_id === "string") return {threadId: event.thread_id};
  if (event.type === "error") return {error: String(event.message ?? "Codex reported an error.")};
  if (event.type !== "item.completed") return {};
  const item = event.item as Record<string, unknown> | undefined;
  if (item?.type === "agent_message" && typeof item.text === "string") return {message: item.text};
  if ((item?.type === "mcp_tool_call" || item?.type === "tool_call") && typeof item.tool === "string") {
    return {tool: item.tool.replace(/^studio\//, "")};
  }
  return {};
}

/** Only tools that do not narrate their own progress get an announcement line. */
const LABELS: Record<string, string> = {
  read_plan: "reading the plan",
  review_video: "reviewing the result",
};

function describe(toolName: string): string | null {
  if (!toolName.startsWith("mcp__studio__")) return null;
  return LABELS[toolName.replace(/^mcp__studio__/, "")] ?? null;
}

/** Persist a completed exchange so the thread survives a restart. */
export async function recordTurn(
  thread: Thread,
  userText: string,
  events: readonly AgentEvent[],
): Promise<Thread> {
  let next = appendMessage(thread, {role: "user", text: userText});
  for (const event of events) {
    if (event.type === "message") next = appendMessage(next, {role: "assistant", text: event.text});
    else if (event.type === "event") next = appendMessage(next, {role: "event", text: event.text, tool: event.tool});
    else if (event.type === "error") next = appendMessage(next, {role: "assistant", text: `⚠ ${event.text}`});
  }
  return saveThread(next);
}
