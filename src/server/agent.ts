import {query, type Options, type PermissionResult} from "@anthropic-ai/claude-agent-sdk";
import {loadBrandKit} from "../core/brand/kit.ts";
import {billingMode} from "../core/cost.ts";
import {ROOT} from "../core/paths.ts";
import {STUDIO_TOOL_NAMES, studioTools} from "../core/tools/index.ts";
import {appendMessage, saveThread, type Thread} from "../core/threads.ts";

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
  figure — and a piece about a problem almost always would — go and find one: search_web,
  then read_source on the two or three results worth reading, then propose_facts on what
  survives. Do this as part of making the video, not as a separate errand the owner has
  to request. Then save_brief, including what you could not source.
- One good figure beats three. A video carrying a single number someone can check is
  stronger than one stacked with statistics, and every extra figure is another claim you
  have to stand behind.
- Say when you came back empty. "I could not find a defensible number for this, so the
  video argues it without one" is a fine outcome and the owner needs to hear it. Never
  reach for a number you could not source, and never present a figure as covering more
  than it does — a survey of content professionals is not a survey of B2B marketers.
- Then just make the video. Do not ask which format or how long unless the request is
  genuinely ambiguous about what kind of piece it is — the intent presets already
  answer those questions.
- When it is done, say what you made in two or three sentences: the thesis, the shape,
  and anything you are not happy with. Do not list file paths; the owner sees them.
- For wording or pacing changes on an existing video use edit_video. It is fast and
  free. Only reach for a full rebuild when the *structure* has to change.
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
  composerId: string;
  signal?: AbortSignal;
}): AsyncGenerator<AgentEvent> {
  const {thread, prompt, composerId, signal} = options;
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
    ...(thread.sessionId ? {resume: thread.sessionId} : {}),
  };

  let sessionId = thread.sessionId;
  let costUsd = 0;

  try {
    for await (const message of query({prompt, options: sdkOptions})) {
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
    yield {type: "error", text: (error as Error).message};
  }

  await saveThread({...thread, sessionId, videoId});
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
