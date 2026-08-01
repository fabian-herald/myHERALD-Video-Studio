import {spawn} from "node:child_process";
import fs from "node:fs/promises";
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
import {codexChildEnv, codexModel, requireCodexSubscription} from "./codexCli.ts";

/**
 * The alternate backend. Same contract, same authoring directory, same repair loop —
 * the only difference is which subscription pays for it.
 *
 * Codex writes into an isolated workdir rather than returning files as JSON: a
 * 500-line stylesheet does not survive JSON escaping intact, and the sandbox is
 * scoped to the throwaway directory anyway.
 */
async function drive(prompt: string, context: ComposeContext, label: string): Promise<ComposeResult> {
  const executable = await requireCodexSubscription();
  const model = codexModel();
  const effort = context.effort === "high" ? "high" : "medium";
  const node = await compatibleNode();
  const toolPath = [path.dirname(node), process.env.PATH].filter(Boolean).join(path.delimiter);

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
      env: codexChildEnv({
        HYPERFRAMES_NO_TELEMETRY: "1",
        HYPERFRAMES_NODE_PATH: node,
        PATH: toolPath,
      }),
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
        "After the edit, return immediately. The pipeline reruns the authoritative browser,",
        "layout, motion and strict checks outside this sandbox. Do not run HyperFrames or",
        "open a local server here. Do not install or download Node,",
        "HyperFrames, packages, skills, or registry items.",
      ].join("\n"),
      {...context, effort: "high"},
      "repair",
    );
  },
};

registerComposer(codexComposer);
