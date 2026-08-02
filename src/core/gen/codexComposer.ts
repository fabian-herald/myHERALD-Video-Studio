import {spawn} from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {Cancelled} from "../cancel.ts";
import type {CheckReport} from "../render/check.ts";
import {compatibleNode} from "../render/node.ts";
import {
  actionableRepairFindings,
  assertCompositionWritten,
  registerComposer,
  type ComposeContext,
  type ComposeResult,
  type Composer,
  type VisualReviewRequest,
} from "./composer.ts";
import {codexChildEnv, codexModel, requireCodexSubscription} from "./codexCli.ts";

/** Large multi-scene file writes can legitimately produce no JSONL event for several minutes. */
export const CODEX_IDLE_TIMEOUT_MS = 300_000;

/**
 * The alternate backend. Same contract, same authoring directory, same repair loop —
 * the only difference is which subscription pays for it.
 *
 * Codex writes into an isolated workdir rather than returning files as JSON: a
 * 500-line stylesheet does not survive JSON escaping intact, and the sandbox is
 * scoped to the throwaway directory anyway.
 */
export function codexExecArgs(options: {
  dir: string;
  model: string;
  effort: string;
  imagePaths?: readonly string[];
}): string[] {
  const {dir, model, effort, imagePaths = []} = options;
  return [
    "exec",
    // Keep a following option behind the variadic image list so Clap cannot mistake the
    // final stdin marker (`-`) for another image path.
    ...(imagePaths.length ? ["--image", ...imagePaths] : []),
    "--ignore-user-config",
    "--sandbox", "workspace-write",
    "--cd", dir,
    "--model", model,
    "-c", `model_reasoning_effort="${effort}"`,
    "--json",
    "-",
  ];
}

export function codexComposerEvent(line: string): {log?: string; note?: string; filesChanged?: boolean} {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return {log: line.trim().slice(0, 180) || undefined};
  }
  if (event.type !== "item.completed") return {};
  const item = event.item as Record<string, unknown> | undefined;
  if (!item) return {};

  if (item.type === "agent_message" && typeof item.text === "string") {
    const note = item.text.trim();
    return {note, log: note.split(/\r?\n/).at(-1)?.slice(0, 180)};
  }
  if (item.type === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes as Record<string, unknown>[] : [];
    const files = [...new Set(changes
      .map((change) => typeof change.path === "string" ? path.basename(change.path) : "")
      .filter(Boolean))];
    return {
      log: files.length ? `updated ${files.join(", ")}` : "updated composition files",
      filesChanged: true,
    };
  }
  if (item.type === "command_execution") {
    return {log: `command ${String(item.command ?? "").slice(0, 140)}`};
  }
  if ((item.type === "mcp_tool_call" || item.type === "tool_call") && typeof item.tool === "string") {
    return {log: `tool ${item.tool}`};
  }
  return {};
}

async function drive(
  prompt: string,
  context: ComposeContext,
  label: string,
  imagePaths: readonly string[] = [],
): Promise<ComposeResult> {
  const executable = await requireCodexSubscription();
  const model = codexModel();
  const effort = context.effort === "high" ? "high" : "medium";
  const node = await compatibleNode();
  const toolPath = [path.dirname(node), process.env.PATH].filter(Boolean).join(path.delimiter);

  const args = codexExecArgs({dir: context.authoring.dir, model, effort, imagePaths});

  const notes = await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: context.authoring.dir,
      env: codexChildEnv({
        HYPERFRAMES_NO_TELEMETRY: "1",
        HYPERFRAMES_NODE_PATH: node,
        PATH: toolPath,
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let finalNote = "";
    let sawFileChange = false;
    let acceptedIdleExit = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (forceTimer) clearTimeout(forceTimer);
    };
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        acceptedIdleExit = sawFileChange;
        context.onLog(`  ${label}      no output for ${CODEX_IDLE_TIMEOUT_MS / 1000}s; ending the idle Codex session`
          + (acceptedIdleExit ? " and validating its written files" : ""));
        child.kill("SIGTERM");
        forceTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      }, CODEX_IDLE_TIMEOUT_MS);
    };
    armIdleTimer();
    const stdout = readline.createInterface({input: child.stdout});
    stdout.on("line", (line) => {
      armIdleTimer();
      const event = codexComposerEvent(line);
      if (event.note) finalNote = event.note.slice(-4000);
      if (event.filesChanged) sawFileChange = true;
      if (event.log) context.onLog(`  ${label}      ${event.log}`);
    });
    const stderr = readline.createInterface({input: child.stderr});
    stderr.on("line", (line) => {
      armIdleTimer();
      if (line.trim()) context.onLog(`  ${label}      ${line.trim().slice(0, 180)}`);
    });
    child.on("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.on("close", (code) => {
      clearTimers();
      if (context.signal?.aborted) reject(new Cancelled(label));
      else if (code === 0 || acceptedIdleExit) resolve(finalNote.trim());
      else reject(new Error(`codex exec exited with code ${code}.`));
    });

    context.signal?.addEventListener("abort", () => child.kill("SIGTERM"), {once: true});
    child.stdin.write(prompt);
    child.stdin.end();
  });

  await assertCompositionWritten(context.authoring.dir);
  return {provider: "codex", model, turns: 1, costUsd: 0, notes};
}

const PREAMBLE = [
  "You are authoring a HyperFrames composition — deterministic HTML/CSS/GSAP that renders",
  "frame by frame to video.",
  "",
  `Read CONTRACT.md and BRIEF.md in ${path.sep === "/" ? "this directory" : "the working directory"} first. The contract is binding.`,
  "Write exactly three files: index.html, styles.css, animation.js. Nothing else.",
  "",
  "The bar is not that it validates. It is that every rendered scene reads as a deliberate",
  "composition and the sequence does not collapse into variations of one repeated layout.",
].join("\n");

export const codexComposer: Composer = {
  id: "codex",
  label: "Codex CLI (ChatGPT subscription)",

  async compose(context) {
    return drive(
      [
        PREAMBLE,
        "",
        "Decide a distinct spatial archetype for every section before writing markup.",
        "Two adjacent scenes must never share an archetype.",
        "",
        "When the files are written, return immediately. The pipeline runs the authoritative",
        "browser, layout, motion and strict checks outside this sandbox and will send concrete",
        "findings back if a repair is needed. Do not run HyperFrames or open a local server here.",
        "Finish with one line per scene naming the archetype you used.",
        "Do not install or download Node,",
        "HyperFrames, packages, skills, or registry items.",
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
      request.imagePaths,
    );
  },

  async repair(context, report: CheckReport, attempt, evidencePaths = []) {
    const findings = actionableRepairFindings(report);
    return drive(
      [
        `The composition in this directory failed validation (attempt ${attempt}).`,
        "Fix it with a minimal diff. Do not re-author it and do not change the design.",
        "",
        "Findings:",
        findings
          .map((finding) => `- [${finding.severity}] ${finding.code ?? "issue"}: ${finding.message}`
            + (finding.selector ? ` (selector: ${finding.selector})` : "")
            + (finding.fixHint ? `\n  hint: ${finding.fixHint}` : ""))
          .join("\n"),
        ...(evidencePaths.length ? [
          "",
          "The attached images are the checker overview frames and focused finding crops.",
          "Inspect them before editing; use the timestamps and bounding boxes above to identify",
          "the exact failing elements. Do not change warning-only elements.",
        ] : []),
        "",
        "After the edit, return immediately. The pipeline reruns the authoritative browser,",
        "layout, motion and strict checks outside this sandbox. Do not run HyperFrames or",
        "open a local server here. Do not install or download Node,",
        "HyperFrames, packages, skills, or registry items.",
      ].join("\n"),
      {...context, effort: "high"},
      "repair",
      evidencePaths,
    );
  },
};

registerComposer(codexComposer);
