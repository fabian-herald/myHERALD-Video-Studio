import {query, type Options, type PermissionResult} from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import type {CheckReport} from "../render/check.ts";
import {compatibleNode} from "../render/node.ts";
import {
  assertCompositionWritten,
  registerComposer,
  type ComposeContext,
  type ComposeResult,
  type Composer,
} from "./composer.ts";

/**
 * Only these tools reach the model, and Bash is narrowed to the HyperFrames CLI.
 * The composer runs inside a throwaway authoring directory, so the blast radius
 * of a mistake is one composition attempt.
 */
export const ALLOWED_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "TodoWrite"];
export const ALLOWED_BASH = /^(npx\s+)?hyperframes\s+(check|snapshot|lint|docs)\b/;

const SYSTEM_PROMPT = `You are a motion designer who writes code. You author HyperFrames
compositions — deterministic HTML/CSS/GSAP that renders frame by frame to video.

Your working directory contains CONTRACT.md (the framework and brand rules) and BRIEF.md
(this specific video). Read both before writing anything. The contract is binding.

You write exactly three files: index.html, styles.css, animation.js. Nothing else.

The bar you are held to is not "it validates". It is: when the eight rendered frames are
laid out side by side, they must read as eight structurally different compositions. A
sequence of similar centred layouts is a failure even if every check passes.

Verify with \`npx hyperframes check . --json --strict\` and fix every error before you
finish. Look at snapshots and judge the frames honestly.

Run that command exactly as written, on its own. Node is already the right version on
your PATH — do not probe for one, and do not prefix the command with \`cd\`, \`export\` or
anything else. Only a command that *begins* with \`hyperframes\` or \`npx hyperframes\` is
permitted; a prefixed one is refused, and you are already in the right directory.

Reply with a short summary of the scene archetypes you used — one line each.`;

/**
 * A refusal that only states the rule leaves the agent guessing at the cause, and it
 * guessed wrong for thirty-odd turns: it read this as "the CLI is unavailable" and went
 * looking for a runtime. Name the fix, not just the restriction.
 */
const BASH_REFUSAL =
  "Only `hyperframes check|snapshot|lint|docs` may be run, and the command must "
  + "begin with it — no `cd`, `export` or other prefix, since anything before the "
  + "`&&` would run unchecked. You are already in the authoring directory and the "
  + "Node on your PATH already satisfies HyperFrames, so run the bare command: "
  + "`npx hyperframes check . --json --strict`.";

/** One decision, so the hook and the callback can never drift into disagreeing. */
export function bashRefusal(command: string): string | null {
  return ALLOWED_BASH.test(command.trim()) ? null : BASH_REFUSAL;
}

/**
 * Files the composer may write. It writes exactly three, and the rest of the directory is
 * provided — so a write anywhere else is either a mistake or a composition inventing its
 * own inputs, and both are worth stopping.
 */
const WRITABLE = /(^|\/)(index\.html|styles\.css|animation\.js)$/;

export function writeRefusal(dir: string, filePath: string): string | null {
  const target = path.resolve(dir, filePath);
  const inside = target === path.resolve(dir) || target.startsWith(`${path.resolve(dir)}${path.sep}`);
  if (!inside) {
    return `${filePath} is outside the authoring directory. Write only index.html, styles.css `
      + "and animation.js, in the directory you are already in.";
  }
  if (!WRITABLE.test(target)) {
    return `${path.basename(target)} is not one of the three files you author. Everything else `
      + "in this directory is provided and must not be modified.";
  }
  return null;
}

export function permission(toolName: string, input: Record<string, unknown>): PermissionResult {
  if (!ALLOWED_TOOLS.includes(toolName)) {
    return {behavior: "deny", message: `${toolName} is not available while composing.`};
  }
  if (toolName === "Bash") {
    const refusal = bashRefusal(String(input.command ?? ""));
    if (refusal) return {behavior: "deny", message: refusal};
  }
  return {behavior: "allow", updatedInput: input};
}

/**
 * The boundary, in the one place that actually holds it.
 *
 * `canUseTool` above does not run for Bash, and had not been running for a long time. The
 * SDK auto-approves any bare name in `allowedTools` before the callback is consulted — it
 * says so in a startup warning nobody was reading — so the anchored `ALLOWED_BASH` regex
 * was dead code. Observed live: the composer ran `cd` into the project root and grepped
 * the studio's own source for twelve turns, in a run whose comments promise the blast
 * radius of a mistake is one composition attempt.
 *
 * A PreToolUse hook is the only one of the SDK's four permission mechanisms that sees
 * every execution: modes are global, rules are declarative and shadow the callback, and
 * the callback fires only for what the rules did not already settle. So the rule lives
 * here, and `permission()` keeps its copy for the tools the hook does not match.
 */
export function composerHooks(dir: string): Options["hooks"] {
  const deny = (reason: string) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  });

  return {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [async (input) => {
          if (input.hook_event_name !== "PreToolUse") return {};
          const refusal = bashRefusal(String((input.tool_input as {command?: unknown}).command ?? ""));
          return refusal ? deny(refusal) : {};
        }],
      },
      {
        matcher: "Write|Edit",
        hooks: [async (input) => {
          if (input.hook_event_name !== "PreToolUse") return {};
          const target = (input.tool_input as {file_path?: unknown}).file_path;
          if (typeof target !== "string") return {};
          const refusal = writeRefusal(dir, target);
          return refusal ? deny(refusal) : {};
        }],
      },
    ],
  };
}

/**
 * PATH with a HyperFrames-capable Node in front, resolved once per process.
 *
 * The composer may only run a command that *begins* with `hyperframes`, because
 * allowing a prefix would let anything through ahead of the `&&`. That gate is right,
 * but it left the agent unable to do the one thing it needed when the default `node`
 * was too old: it ran `npx hyperframes check`, hit a Node 22 error, and then spent
 * turn after turn probing nvm and Homebrew and retrying with `export PATH=...`, every
 * one of which was refused. Thirty-four of fifty-two bash calls in one run were spent
 * that way. The environment is the place to fix it — put the right Node in front and
 * the bare command simply works.
 */
let nodePath: Promise<string> | null = null;
async function composerEnv(): Promise<Record<string, string>> {
  nodePath ??= compatibleNode();
  const binDir = path.dirname(await nodePath);
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    HYPERFRAMES_NO_TELEMETRY: "1",
  } as Record<string, string>;
}

async function baseOptions(context: ComposeContext): Promise<Options> {
  return {
    cwd: context.authoring.dir,
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ALLOWED_TOOLS,
    // Load the user scope so the installed HyperFrames skills are available.
    settingSources: ["user"],
    permissionMode: "default",
    canUseTool: async (toolName, input) => permission(toolName, input as Record<string, unknown>),
    maxTurns: context.effort === "high" ? 90 : 60,
    abortController: toController(context.signal),
    env: await composerEnv(),
    hooks: composerHooks(context.authoring.dir),
  };
}

function toController(signal?: AbortSignal) {
  const controller = new AbortController();
  signal?.addEventListener("abort", () => controller.abort(), {once: true});
  return controller;
}

async function drive(prompt: string, context: ComposeContext, label: string): Promise<ComposeResult> {
  let turns = 0;
  let costUsd = 0;
  let model = "claude";
  let notes = "";

  // Closed on every exit, for the same reason as the studio agent in server/agent.ts:
  // aborting the controller stops messages reaching us but leaves the spawned CLI running.
  // This is the longer session of the two — a compose runs for twenty minutes — so it is
  // the one most likely to be abandoned mid-flight.
  const session = query({prompt, options: await baseOptions(context)});
  const closeSession = () => session.close();
  context.signal?.addEventListener("abort", closeSession, {once: true});

  try {
    for await (const message of session) {
      if (message.type === "assistant") {
        model = message.message.model ?? model;
        for (const block of message.message.content) {
          if (block.type === "tool_use") {
            context.onLog(`  ${label}      ${describeTool(block.name, block.input as Record<string, unknown>, context.authoring.dir)}`);
          }
        }
      } else if (message.type === "result") {
        turns = message.num_turns ?? 0;
        costUsd = message.total_cost_usd ?? 0;
        notes = message.subtype === "success" ? message.result : `(${message.subtype})`;
        if (message.subtype !== "success") {
          throw new Error(`Composer stopped: ${message.subtype}.`);
        }
      }
    }
  } finally {
    context.signal?.removeEventListener("abort", closeSession);
    try {
      session.close();
    } catch {
      // Already closed by the abort listener.
    }
  }

  await assertCompositionWritten(context.authoring.dir);
  return {provider: "claude", model, turns, costUsd, notes: notes.trim()};
}

function describeTool(name: string, input: Record<string, unknown>, dir: string) {
  const relative = (value: unknown) =>
    typeof value === "string" ? path.relative(dir, value) || value : "";
  if (name === "Bash") return `bash · ${String(input.command ?? "").slice(0, 72)}`;
  if (name === "Write" || name === "Edit" || name === "Read") {
    return `${name.toLowerCase()} · ${relative(input.file_path)}`;
  }
  return name.toLowerCase();
}

export const claudeComposer: Composer = {
  id: "claude",
  label: "Claude Agent SDK (claude CLI subscription)",

  async compose(context) {
    return drive(
      [
        "Read CONTRACT.md and BRIEF.md in this directory, then author the composition.",
        "",
        "Work through it in this order:",
        "1. Read both documents and the exemplar under exemplar/.",
        "2. Decide a distinct spatial archetype for every section, and write them down",
        "   before you write markup. Two adjacent scenes must never share an archetype.",
        "3. Write index.html, styles.css and animation.js.",
        "4. Run `npx hyperframes check . --json --strict` and fix every error.",
        "5. Snapshot, look at the frames, and rework anything that reads as a repeat.",
      ].join("\n"),
      context,
      "compose",
    );
  },

  async repair(context, report: CheckReport, attempt) {
    return drive(
      [
        `Composition attempt ${attempt} failed validation. Fix it with a minimal diff —`,
        "do not re-author the composition and do not change the design.",
        "",
        "Findings:",
        "",
        report.findings
          .map((finding) => `- [${finding.severity}] ${finding.code ?? "issue"}: ${finding.message}`
            + (finding.selector ? ` (selector: ${finding.selector})` : "")
            + (finding.fixHint ? `\n  hint: ${finding.fixHint}` : ""))
          .join("\n"),
        "",
        "Re-run `npx hyperframes check . --json --strict` afterwards and confirm it is clean.",
      ].join("\n"),
      {...context, effort: "high"},
      "repair",
    );
  },
};

registerComposer(claudeComposer);
