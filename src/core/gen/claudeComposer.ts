import {query, type HookInput, type Options, type PermissionResult} from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import type {CheckReport} from "../render/check.ts";
import {compatibleNode} from "../render/node.ts";
import {
  actionableRepairFindings,
  assertCompositionWritten,
  adaptationFraming,
  EXEMPLAR_FRAMING,
  formatFindingForRepair,
  registerComposer,
  type ComposeContext,
  type ComposeResult,
  type Composer,
  type VisualReviewRequest,
} from "./composer.ts";

/**
 * Only these tools reach the model, and Bash is narrowed to the HyperFrames CLI.
 * The composer runs inside a throwaway authoring directory, so the blast radius
 * of a mistake is one composition attempt.
 */
export const ALLOWED_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "TodoWrite", "Skill"];
export const ALLOWED_BASH = /^(npx\s+)?hyperframes\s+(check|snapshot|lint|docs)\b/;
export const ALLOWED_COMPOSER_SKILLS = /^\/?(?:hyperframes(?:-(?:core|animation|keyframes|creative|cli|registry))?|media-use)$/;

const SYSTEM_PROMPT = `You are a motion designer who writes code. You author HyperFrames
compositions — deterministic HTML/CSS/GSAP that renders frame by frame to video.

Your working directory contains CONTRACT.md (the framework and brand rules) and BRIEF.md
(this specific video). Read both before writing anything. The contract is binding.

You write exactly three files: index.html, styles.css, animation.js. Nothing else.

The bar you are held to is not "it validates". It is: when every rendered scene is laid
out side by side, each must read as a deliberate composition and the sequence must not
collapse into similar centred layouts, even if every check passes.

The Studio pipeline runs HyperFrames checks and renders representative snapshots outside
your session after you return. It then opens a separate visual-review turn with those
exact images. Do not run HyperFrames or open a local server while authoring or repairing.

Use \`Read\` and \`Glob\` for supplied files, not shell discovery. Read the manifest at
the top of BRIEF.md first; it lists the directory, so you do not need to explore.

Your turns are finite and mostly want spending on the composition itself. Read what you
need, write the three files, then return so the shared validation pipeline can run.

The read-only Skill tool is available for the installed HyperFrames and media-use skills.
Load hyperframes-core first, then animation, keyframes, creative, CLI or media-use only
when the brief needs them. Skills may describe broader workflows and registry commands,
but this studio has already routed and scaffolded the job. Do not run install, update,
catalog or add commands; author against the provided contract, blocks and media.

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
  if (toolName === "Skill") {
    const skill = String(input.skill ?? input.name ?? "");
    if (!ALLOWED_COMPOSER_SKILLS.test(skill)) {
      return {
        behavior: "deny",
        message: "Only installed HyperFrames and media-use skills are available while composing.",
      };
    }
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

  const guardWrite = async (input: HookInput) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const target = (input.tool_input as {file_path?: unknown}).file_path;
    if (typeof target !== "string") return {};
    const refusal = writeRefusal(dir, target);
    return refusal ? deny(refusal) : {};
  };

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
        matcher: "Skill",
        hooks: [async (input) => {
          if (input.hook_event_name !== "PreToolUse") return {};
          const toolInput = input.tool_input as {skill?: unknown; name?: unknown};
          const skill = String(toolInput.skill ?? toolInput.name ?? "");
          return ALLOWED_COMPOSER_SKILLS.test(skill)
            ? {}
            : deny("Only installed HyperFrames and media-use skills are available while composing.");
        }],
      },
      // One exact matcher per tool rather than `Write|Edit`. Whether the SDK reads a
      // matcher as a regex or as a literal name is not something to find out by shipping
      // a boundary that silently matches nothing, and an exact name is right either way.
      {matcher: "Write", hooks: [guardWrite]},
      {matcher: "Edit", hooks: [guardWrite]},
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
  let actions = 0;
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
            actions += 1;
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
  // Claude's budget is a turn ceiling rather than a reasoning-effort string, so record the
  // ceiling it ran under. Both providers then answer "how much was this allowed to think?".
  const effort = `maxTurns:${context.effort === "high" ? 90 : 60}`;
  return {provider: "claude", model, effort, turns, actions, costUsd, notes: notes.trim()};
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
        // See codexComposer: an adaptation is held to the source composition, not to a
        // reference for a different video.
        context.adaptation ? adaptationFraming(context.adaptation) : EXEMPLAR_FRAMING,
        "",
        "Work through it in this order:",
        context.adaptation
          ? "1. Read both documents and the three existing files you are re-laying."
          : "1. Read both documents and the exemplar under exemplar/.",
        context.adaptation
          ? "2. Note, per scene, what the source does and what the new shape forces to change."
          : "2. Decide a distinct spatial archetype for every section, and write them down\n"
            + "   before you write markup. Two adjacent scenes must never share an archetype.",
        "3. Write index.html, styles.css and animation.js.",
        "4. Return immediately. The pipeline runs authoritative checks and supplies the",
        "   rendered frames in a separate visual-review turn.",
      ].join("\n"),
      context,
      "compose",
    );
  },

  async review(context, request: VisualReviewRequest) {
    return drive(
      request.prompt,
      {...context, effort: "high"},
      "visual",
    );
  },

  async repair(context, report: CheckReport, attempt, evidencePaths = []) {
    const findings = actionableRepairFindings(report);
    return drive(
      [
        `Composition attempt ${attempt} failed validation. Fix it with a minimal diff —`,
        "do not re-author the composition and do not change the design.",
        "",
        "Findings:",
        "",
        findings.map(formatFindingForRepair).join("\n"),
        ...(evidencePaths.length ? [
          "",
          "Rendered checker evidence (overview frames and focused finding crops):",
          ...evidencePaths.map((file) => `- ${file}`),
          "Read these exact images before editing. Do not change warning-only elements.",
        ] : []),
        "",
        "Return after the edit. The shared pipeline reruns all authoritative checks.",
      ].join("\n"),
      {...context, effort: "high"},
      "repair",
    );
  },
};

registerComposer(claudeComposer);
