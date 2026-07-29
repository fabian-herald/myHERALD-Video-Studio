import {spawn} from "node:child_process";
import {constants as fsConstants} from "node:fs";
import fs from "node:fs/promises";
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
 * The alternate backend. Same contract, same authoring directory, same repair loop —
 * the only difference is which subscription pays for it.
 *
 * Codex writes into an isolated workdir rather than returning files as JSON: a
 * 500-line stylesheet does not survive JSON escaping intact, and the sandbox is
 * scoped to the throwaway directory anyway.
 */
const CODEX_CANDIDATES = [
  process.env.CODEX_CLI_PATH,
  "/Applications/Codex.app/Contents/Resources/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex",
];

async function resolveCodex(): Promise<string> {
  for (const candidate of CODEX_CANDIDATES.filter(Boolean) as string[]) {
    if (await fs.access(candidate, fsConstants.X_OK).then(() => true).catch(() => false)) {
      return candidate;
    }
  }
  const onPath = await new Promise<string | null>((resolve) => {
    const child = spawn("which", ["codex"], {stdio: ["ignore", "pipe", "ignore"]});
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("close", () => resolve(output.trim() || null));
    child.on("error", () => resolve(null));
  });
  if (onPath) return onPath;

  throw new Error(
    "The codex CLI could not be found. Set CODEX_CLI_PATH in .env.local to its absolute "
    + "path, or use the default `--composer claude`.",
  );
}

async function drive(prompt: string, context: ComposeContext, label: string): Promise<ComposeResult> {
  const executable = await resolveCodex();
  const model = process.env.CODEX_MODEL ?? "gpt-5.6-terra";
  const effort = context.effort === "high" ? "high" : "medium";

  const args = [
    "exec",
    "--ignore-user-config",
    "--sandbox", "workspace-write",
    "--cd", context.authoring.dir,
    "--model", model,
    "-c", `model_reasoning_effort="${effort}"`,
    "-",
  ];

  const notes = await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: context.authoring.dir,
      env: {...process.env, HYPERFRAMES_NO_TELEMETRY: "1"},
      stdio: ["pipe", "pipe", "pipe"],
    });

    let tail = "";
    const forward = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      tail = `${tail}${text}`.slice(-4000);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) context.onLog(`  ${label}      ${line.slice(0, 110)}`);
      }
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(tail.trim()) : reject(new Error(`codex exec exited with code ${code}.`)));

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
  "The bar is not that it validates. It is that the eight rendered frames read as eight",
  "structurally different compositions. Six variations of one layout is a failure.",
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
        "When the files are written, run `npx hyperframes check . --json --strict` and fix",
        "every error. Finish with one line per scene naming the archetype you used.",
      ].join("\n"),
      context,
      "compose",
    );
  },

  async repair(context, report: CheckReport, attempt) {
    return drive(
      [
        `The composition in this directory failed validation (attempt ${attempt}).`,
        "Fix it with a minimal diff. Do not re-author it and do not change the design.",
        "",
        "Findings:",
        report.findings
          .map((finding) => `- [${finding.severity}] ${finding.code ?? "issue"}: ${finding.message}`
            + (finding.selector ? ` (selector: ${finding.selector})` : ""))
          .join("\n"),
        "",
        "Re-run `npx hyperframes check . --json --strict` and confirm it is clean.",
      ].join("\n"),
      {...context, effort: "high"},
      "repair",
    );
  },
};

registerComposer(codexComposer);
