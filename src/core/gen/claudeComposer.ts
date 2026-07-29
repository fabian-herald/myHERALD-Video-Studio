import {query, type Options, type PermissionResult} from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import type {CheckReport} from "../render/check.ts";
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
const ALLOWED_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "TodoWrite"];
const ALLOWED_BASH = /^(npx\s+)?hyperframes\s+(check|snapshot|lint|docs)\b/;

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

Reply with a short summary of the scene archetypes you used — one line each.`;

function permission(toolName: string, input: Record<string, unknown>): PermissionResult {
  if (!ALLOWED_TOOLS.includes(toolName)) {
    return {behavior: "deny", message: `${toolName} is not available while composing.`};
  }
  if (toolName === "Bash") {
    const command = String(input.command ?? "").trim();
    if (!ALLOWED_BASH.test(command)) {
      return {
        behavior: "deny",
        message: "Only `hyperframes check|snapshot|lint|docs` may be run from here.",
      };
    }
  }
  return {behavior: "allow", updatedInput: input};
}

function baseOptions(context: ComposeContext): Options {
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
    env: {...process.env, HYPERFRAMES_NO_TELEMETRY: "1"} as Record<string, string>,
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

  for await (const message of query({prompt, options: baseOptions(context)})) {
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
