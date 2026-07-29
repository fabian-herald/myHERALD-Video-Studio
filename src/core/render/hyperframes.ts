import {spawn} from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {FORMATS, type OutputFormat} from "../plan/formats.ts";
import {ROOT} from "../paths.ts";
import {compatibleNode} from "./node.ts";
import {snapshotTimes} from "../compose/workdir.ts";

const CLI = path.join(ROOT, "node_modules", "hyperframes", "bin", "hyperframes.mjs");

export type Quality = "draft" | "standard" | "high";

async function cli(args: string[], cwd: string, onLog?: (line: string) => void) {
  const node = await compatibleNode();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(node, [CLI, ...args], {
      cwd,
      env: {...process.env, HYPERFRAMES_NO_TELEMETRY: "1"},
      stdio: ["ignore", "pipe", "pipe"],
    });
    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) onLog?.(line);
      }
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`hyperframes ${args[0]} exited with code ${code}.`)));
  });
}

/**
 * Re-emit an authored composition at a different canvas size.
 *
 * Only the root element changes: width, height, the CSS custom properties the
 * blocks derive their layout from, and a `data-format` hook for the rare rule
 * that genuinely needs to differ. Everything else is byte-identical, which is why
 * one compose pass can serve a whole format family.
 */
export async function emitFormat(
  authoringDir: string,
  format: OutputFormat,
  targetDir: string,
): Promise<string> {
  const spec = FORMATS[format];
  await fs.rm(targetDir, {recursive: true, force: true});
  await fs.cp(authoringDir, targetDir, {
    recursive: true,
    filter: (source) => !/(^|\/)(snapshots|renders|exemplar|CONTRACT\.md|BRIEF\.md)$/.test(source),
  });

  const indexPath = path.join(targetDir, "index.html");
  const html = await fs.readFile(indexPath, "utf8");
  const rewritten = rewriteRoot(html, spec);
  await fs.writeFile(indexPath, rewritten, "utf8");
  return targetDir;
}

function rewriteRoot(html: string, spec: (typeof FORMATS)[OutputFormat]): string {
  const openEnd = html.indexOf(">", html.indexOf("data-composition-id"));
  const tagStart = html.lastIndexOf("<", html.indexOf("data-composition-id"));
  if (tagStart < 0 || openEnd < 0) {
    throw new Error("Could not locate the composition root element to re-emit.");
  }

  let tag = html.slice(tagStart, openEnd + 1);
  tag = setAttribute(tag, "data-width", String(spec.width));
  tag = setAttribute(tag, "data-height", String(spec.height));
  tag = setAttribute(tag, "data-format", spec.format);
  tag = setAttribute(
    tag,
    "style",
    `--stage-w: ${spec.width}px; --stage-h: ${spec.height}px; --format-unit: ${spec.unit};`,
  );
  return html.slice(0, tagStart) + tag + html.slice(openEnd + 1);
}

function setAttribute(tag: string, name: string, value: string): string {
  const pattern = new RegExp(`\\s${name}="[^"]*"`);
  const attribute = ` ${name}="${value}"`;
  if (pattern.test(tag)) return tag.replace(pattern, attribute);
  return `${tag.slice(0, -1).trimEnd()}${attribute}>`;
}

export async function renderVideo(options: {
  dir: string;
  outputPath: string;
  quality?: Quality;
  onLog?: (line: string) => void;
}): Promise<string> {
  const {dir, outputPath, quality = "high", onLog} = options;
  await fs.mkdir(path.dirname(outputPath), {recursive: true});
  await cli(
    ["render", ".", "--output", outputPath, "--quality", quality, "--workers", "auto", "--strict"],
    dir,
    onLog,
  );
  return outputPath;
}

/** Frames used for the contact sheet and the cover. */
export async function renderSnapshots(options: {
  dir: string;
  durationSeconds: number;
  outputDir: string;
  /** Explicit sample times in seconds; falls back to even spacing when absent. */
  at?: string;
  count?: number;
  onLog?: (line: string) => void;
}): Promise<string[]> {
  const {dir, durationSeconds, outputDir, at, count = 8, onLog} = options;
  await fs.mkdir(outputDir, {recursive: true});
  await cli(
    [
      "snapshot", ".",
      "--at", at || snapshotTimes(durationSeconds, count),
      "--no-end",
      "--describe", "false",
      "--output", outputDir,
    ],
    dir,
    onLog,
  );
  const files = (await fs.readdir(outputDir)).filter((name) => name.endsWith(".png")).sort();
  return files.map((name) => path.join(outputDir, name));
}
