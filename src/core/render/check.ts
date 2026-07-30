import fs from "node:fs/promises";
import path from "node:path";
import type {BrandKit} from "../brand/kit.ts";
import {findRogueColors} from "../brand/tokens.ts";
import {captionZone, FORMATS, type FormatFamily, type OutputFormat} from "../plan/formats.ts";
import {checkMediaFit, readMedia} from "../media/library.ts";
import type {VideoPlan} from "../plan/schema.ts";
import {run} from "../util/exec.ts";
import {compatibleNode} from "./node.ts";
import {describeFrozen, sampleMotion} from "./motionGate.ts";
import {ROOT} from "../paths.ts";

export type Severity = "error" | "warning" | "info";

export interface CheckFinding {
  severity: Severity;
  code?: string;
  message: string;
  selector?: string;
  fixHint?: string;
  source: "hyperframes" | "tokens" | "plan";
}

export interface CheckReport {
  ok: boolean;
  errorCount: number;
  warningCount: number;
  findings: CheckFinding[];
  raw?: unknown;
}

const CLI = path.join(ROOT, "node_modules", "hyperframes", "bin", "hyperframes.mjs");

/**
 * Four gates in one report:
 *   1. HyperFrames' own lint / runtime / layout / motion / WCAG contrast pass
 *   2. the token-only colour rule
 *   3. plan conformance — ids, timings and verbatim copy
 *   4. actual movement where the caption layer has gone quiet
 *
 * Together these are what make it safe to let a model author the composition.
 *
 * The fourth is the only one that renders pixels. It costs 8–17 seconds and it is the only
 * way to catch a composition that satisfies every structural rule and still paints the
 * same frame for two seconds — the failure that otherwise surfaces after a full render,
 * in the post-render freeze check, having already been paid for.
 */
export async function checkComposition(options: {
  dir: string;
  plan: VideoPlan;
  kit: BrandKit;
  family: FormatFamily;
  fps: number;
  /** Off only where there is no browser to render with — never as a shortcut. */
  sampleMotion?: boolean;
  onLog?: (line: string) => void;
}): Promise<CheckReport> {
  const {dir, plan, kit, family, fps, sampleMotion: motion = true, onLog} = options;
  const findings: CheckFinding[] = [
    ...await runHyperframesCheck(dir, family),
    ...await checkTokens(dir, kit),
    ...await checkBannedWords(dir, kit),
    ...await checkPlanConformance(dir, plan, fps),
    ...await checkMedia(plan, family),
    ...await checkCanvasLiterals(dir, plan, family),
    ...await checkWordmark(dir, kit),
    ...motion ? await checkMotion(dir, plan, onLog) : [],
  ];

  const errorCount = findings.filter((finding) => finding.severity === "error").length;
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;
  return {ok: errorCount === 0, errorCount, warningCount, findings};
}

/**
 * A rendering failure here must not fail the composition.
 *
 * The other gates read files that are certainly present. This one drives a headless
 * browser, and a browser that will not start is a fault in the machine, not in the work —
 * reporting it as an error would send the composer off to repair something it did not do.
 * It surfaces as a warning so it is visible in the log without spending a repair pass.
 */
async function checkMotion(
  dir: string,
  plan: VideoPlan,
  onLog?: (line: string) => void,
): Promise<CheckFinding[]> {
  const sample = await sampleMotion({dir, plan, onLog}).catch((error: unknown) => error as Error);
  if (sample instanceof Error) {
    return [{
      severity: "warning",
      code: "motion_unsampled",
      message: `Could not sample motion: ${sample.message}. The post-render freeze check still applies.`,
      source: "plan",
    }];
  }

  return sample.frozen.map((frozen): CheckFinding => ({
    severity: "error",
    code: "frozen_window",
    message: describeFrozen(frozen),
    selector: `#scene-${frozen.window.sectionId}`,
    fixHint:
      "Give this scene one sustained motion with area behind it, running for as long as the "
      + "scene is on screen — see CONTRACT.md §6.",
    source: "plan",
  }));
}

async function runHyperframesCheck(dir: string, family: FormatFamily): Promise<CheckFinding[]> {
  const zone = captionZone(family);
  const node = await compatibleNode();
  const args = [
    CLI, "check", ".",
    "--json",
    "--at-transitions",
    "--caption-zone",
    `x0=${zone.x0};y0=${zone.y0};x1=${zone.x1};y1=${zone.y1};severity=error;seek=.5,1`,
    "--frame-check", "severity=warning;seek=.25,.75",
  ];

  const {stdout} = await run(node, args, {cwd: dir}).catch((error: unknown) => {
    // A non-zero exit is expected when findings exist; the JSON is still on stdout.
    const shell = error as {stdout?: string; stderr?: string};
    if (shell.stdout?.trim()) return {stdout: shell.stdout};
    throw new Error(`hyperframes check could not run: ${shell.stderr ?? String(error)}`);
  });

  const report = parseJson(stdout);
  if (!report) {
    return [{
      severity: "error",
      code: "check_unreadable",
      message: "hyperframes check produced no parseable JSON report.",
      source: "hyperframes",
    }];
  }

  const findings: CheckFinding[] = [];
  for (const group of ["lint", "runtime", "layout", "motion", "contrast"] as const) {
    const section = (report as Record<string, {findings?: unknown[]}>)[group];
    for (const raw of section?.findings ?? []) {
      const finding = raw as Record<string, string>;
      findings.push({
        severity: (finding.severity as Severity) ?? "warning",
        code: finding.code,
        message: `${group}: ${finding.message}`,
        selector: finding.selector,
        fixHint: finding.fixHint,
        source: "hyperframes",
      });
    }
  }
  return findings;
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(trimmed.slice(start));
  } catch {
    return null;
  }
}

/** The rule that makes palette drift impossible rather than merely discouraged. */
async function checkTokens(dir: string, kit: BrandKit): Promise<CheckFinding[]> {
  const css = await fs.readFile(path.join(dir, "styles.css"), "utf8").catch(() => "");
  const html = await fs.readFile(path.join(dir, "index.html"), "utf8").catch(() => "");
  const findings: CheckFinding[] = [];

  for (const [label, source] of [["styles.css", css], ["index.html", html]] as const) {
    for (const rogue of findRogueColors(source, kit)) {
      findings.push({
        severity: "error",
        code: "rogue_color",
        message: `${label}:${rogue.line} uses \`${rogue.literal}\`, which is not a brand token.`,
        fixHint: "Replace it with the matching var(--brand-*) token, or a neutral rgba(0,0,0,α)/rgba(255,255,255,α) scrim.",
        source: "tokens",
      });
    }
  }
  return findings;
}

/**
 * Ties the composition back to the plan. This is what keeps the video editable:
 * as long as ids and copy line up, a text change can be applied without the model.
 */
async function checkPlanConformance(dir: string, plan: VideoPlan, fps: number): Promise<CheckFinding[]> {
  const html = await fs.readFile(path.join(dir, "index.html"), "utf8").catch(() => "");
  const findings: CheckFinding[] = [];
  const frameMs = 1000 / fps;

  for (const section of plan.sections) {
    const element = extractElement(html, `scene-${section.id}`);
    if (!element) {
      findings.push({
        severity: "error",
        code: "missing_scene",
        message: `No element with id="scene-${section.id}" — every plan section needs one.`,
        source: "plan",
      });
      continue;
    }

    if (!/\bclass="[^"]*\bclip\b/.test(element.openTag)) {
      findings.push({
        severity: "error",
        code: "scene_not_clip",
        message: `scene-${section.id} is missing class="clip"; it will stay visible for the whole video.`,
        source: "plan",
      });
    }

    const start = attribute(element.openTag, "data-start");
    const duration = attribute(element.openTag, "data-duration");
    assertTiming(findings, section.id, "data-start", start, section.startMs, frameMs);
    assertTiming(findings, section.id, "data-duration", duration, section.durationMs, frameMs);

    if (section.onScreen.trim()) {
      const rendered = normalise(stripTags(element.inner));
      if (!rendered.includes(normalise(section.onScreen))) {
        findings.push({
          severity: "error",
          code: "copy_drift",
          message:
            `scene-${section.id} does not contain its on-screen copy verbatim. `
            + `Expected "${section.onScreen}".`,
          fixHint: "Render the plan's copy exactly. Use CSS for casing; never paraphrase.",
          source: "plan",
        });
      }
    }

    if (section.slot && !/class="[^"]*presenter-slot/.test(element.inner)) {
      findings.push({
        severity: "error",
        code: "missing_presenter_slot",
        message: `scene-${section.id} declares a presenter slot but renders no .presenter-slot element.`,
        source: "plan",
      });
    }
  }

  return findings;
}

/**
 * A landscape screenshot in a vertical video is a letterboxed strip. The shape is
 * checked here so the mismatch is caught before rendering rather than noticed after.
 */
async function checkMedia(plan: VideoPlan, family: FormatFamily): Promise<CheckFinding[]> {
  const bindings = plan.sections
    .filter((section) => section.mediaId)
    .map((section) => ({sectionId: section.id, mediaId: section.mediaId as string}));
  if (!bindings.length) return [];

  const format: OutputFormat = family === "landscape" ? "16x9" : "9x16";
  return checkMediaFit(await readMedia(), bindings, format).map((message): CheckFinding => ({
    severity: "error",
    code: "media_shape",
    message,
    source: "plan",
  }));
}

/**
 * One composition serves every format in its family, re-emitted at a different root
 * size. So any pixel literal equal to a canvas dimension that *varies* across those
 * formats is a latent bug: it is right in the format that was authored against and
 * silently wrong in the others.
 *
 * Only the varying dimension is checked. Portrait shares a 1080 width across 9:16, 4:5
 * and 1:1, so a literal 1080 there is harmless; the height is 1920, 1350 or 1080 and a
 * literal is not. A single-format family has nothing to vary and is skipped.
 */
export async function checkCanvasLiterals(
  dir: string,
  plan: VideoPlan,
  family: FormatFamily,
): Promise<CheckFinding[]> {
  const specs = plan.formats.map((format) => FORMATS[format]).filter((spec) => spec.family === family);
  if (specs.length < 2) return [];

  const axes = ([["height", "dataset.height"], ["width", "dataset.width"]] as const)
    .map(([axis, source]) => ({
      axis,
      source,
      values: [...new Set(specs.map((spec) => spec[axis]))],
    }))
    .filter((entry) => entry.values.length > 1);
  if (!axes.length) return [];

  const source = await fs.readFile(path.join(dir, "animation.js"), "utf8").catch(() => "");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

  return axes.flatMap(({axis, source: accessor, values}) =>
    values
      .filter((value) => new RegExp(`(?<![\\w.])${value}(?![\\w.])`).test(code))
      .map((value): CheckFinding => ({
        severity: "error",
        code: "canvas_literal",
        message:
          `animation.js hardcodes ${value}, which is the canvas ${axis} of one format but not `
          + `of the others in this family (${values.join(", ")}). It will be wrong everywhere else.`,
        fixHint: `Read it once from the stage: parseFloat(stage.${accessor}).`,
        source: "plan",
      })),
  );
}

/**
 * Brand copy rules, enforced on the rendered DOM rather than trusted to the prompt.
 *
 * Only `<body>` counts. The `<title>` is never on screen in a video, and flagging an
 * em-dash there sends the repair pass off to fix something no viewer can see.
 */
export async function checkBannedWords(dir: string, kit: BrandKit): Promise<CheckFinding[]> {
  const html = await fs.readFile(path.join(dir, "index.html"), "utf8").catch(() => "");
  const visible = stripTags(bodyOf(html));
  const text = normalise(visible);

  const findings: CheckFinding[] = kit.voice.bannedWords
    .filter((word) => new RegExp(`\\b${escapeRegex(word.toLowerCase())}`).test(text))
    .map((word): CheckFinding => ({
      severity: "error",
      code: "banned_word",
      message: `On-screen copy contains the banned word "${word}".`,
      fixHint: "Rewrite the line in plain, concrete language.",
      source: "tokens",
    }));

  // The brand guide's one house rule. A spaced en-dash is fine; the em-dash is not.
  if (visible.includes("—")) {
    findings.push({
      severity: "error",
      code: "em_dash",
      message: "On-screen copy contains an em-dash (—), which the brand guide forbids.",
      fixHint: "Use a comma, a parenthesis or a full stop instead.",
      source: "tokens",
    });
  }

  return findings;
}

/**
 * The brand's name, set as type instead of placed as the supplied mark.
 *
 * A composition that hand-sets "myHERALD" gets the two-face lockup subtly wrong every
 * time, and the wrongness is invisible in a checker that only reads text. So the rule
 * is positional: the name may appear inside a sentence, but a standalone occurrence —
 * an element whose entire text is the brand name — has to be the image file.
 */
export async function checkWordmark(dir: string, kit: BrandKit): Promise<CheckFinding[]> {
  const marks = kit.logos.filter((logo) => logo.role === "wordmark" || logo.role === "lockup");
  if (!marks.length) return [];

  const html = await fs.readFile(path.join(dir, "index.html"), "utf8").catch(() => "");
  const name = normalise(kit.name);
  if (!name) return [];

  // Inline wrappers come off first. Splitting the name into `<span>my</span>` plus
  // `<span>HERALD</span>` to style the two faces separately is precisely how a
  // composition hand-sets the mark, so flattening them is what closes that door.
  const body = bodyOf(html).replace(/<\/?(?:span|em|strong|b|i|small|sup|sub|a)\b[^>]*>/gi, "");

  const findings: CheckFinding[] = [];
  // Leaf elements only: a wrapper legitimately contains the name via its children.
  for (const element of body.matchAll(/<(h1|h2|h3|h4|p|div|figcaption|li|td)\b[^>]*>([^<]*)<\/\1>/gi)) {
    const inner = normalise(stripTags(element[2] ?? ""));
    if (inner && inner === name) {
      findings.push({
        severity: "error",
        code: "typeset_wordmark",
        message:
          `"${kit.name}" is set as type on its own. The wordmark is two typefaces at two `
          + "sizes and cannot be reproduced by hand.",
        fixHint: `Place the supplied mark instead: <img src="media/logo-${marks[0]?.id}.png" alt="${kit.name}">.`,
        source: "tokens",
      });
    }
  }
  // One finding is enough to act on; repeating it per occurrence just crowds the report.
  return findings.slice(0, 1);
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The part of the document a viewer can actually see. Falls back to the whole file. */
function bodyOf(html: string): string {
  const opening = html.search(/<body\b[^>]*>/i);
  if (opening < 0) return html;
  const start = html.indexOf(">", opening) + 1;
  const end = html.search(/<\/body\s*>/i);
  return html.slice(start, end < 0 ? undefined : end);
}

function assertTiming(
  findings: CheckFinding[],
  sectionId: string,
  attributeName: string,
  value: string | null,
  expectedMs: number,
  frameMs: number,
) {
  if (value === null) {
    findings.push({
      severity: "error",
      code: "missing_timing",
      message: `scene-${sectionId} is missing ${attributeName}.`,
      source: "plan",
    });
    return;
  }
  const actualMs = Number.parseFloat(value) * 1000;
  if (!Number.isFinite(actualMs) || Math.abs(actualMs - expectedMs) > frameMs) {
    findings.push({
      severity: "error",
      code: "timing_drift",
      message:
        `scene-${sectionId} ${attributeName}="${value}" is ${(actualMs / 1000).toFixed(3)}s, `
        + `but the plan says ${(expectedMs / 1000).toFixed(3)}s.`,
      fixHint: "Copy the timings from BRIEF.md exactly — they come from measured narration.",
      source: "plan",
    });
  }
}

/** Find an element by id and return its open tag plus inner HTML. */
function extractElement(html: string, id: string): {openTag: string; inner: string} | null {
  const idIndex = html.indexOf(`id="${id}"`);
  if (idIndex < 0) return null;

  const tagStart = html.lastIndexOf("<", idIndex);
  const openEnd = html.indexOf(">", idIndex);
  if (tagStart < 0 || openEnd < 0) return null;

  const openTag = html.slice(tagStart, openEnd + 1);
  const tagName = openTag.slice(1).match(/^[a-zA-Z][\w-]*/)?.[0];
  if (!tagName) return null;

  // Walk forward balancing same-name tags so nesting cannot confuse the scan.
  const pattern = new RegExp(`<${tagName}\\b|</${tagName}\\s*>`, "gi");
  pattern.lastIndex = openEnd + 1;
  let depth = 1;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return {openTag, inner: html.slice(openEnd + 1, match.index)};
  }
  return {openTag, inner: html.slice(openEnd + 1)};
}

const attribute = (tag: string, name: string) =>
  tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;

const stripTags = (html: string) =>
  html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]*>/g, " ");

const normalise = (text: string) =>
  text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export function formatFindings(report: CheckReport, limit = 12): string {
  return report.findings
    .filter((finding) => finding.severity !== "info")
    .slice(0, limit)
    .map((finding) => `  [${finding.severity}] ${finding.message}`)
    .join("\n");
}
