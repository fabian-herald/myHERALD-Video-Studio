import fs from "node:fs/promises";
import path from "node:path";
import type {BrandKit} from "../brand/kit.ts";
import {findRogueColors} from "../brand/tokens.ts";
import {captionZone, FORMATS, type FormatFamily, type OutputFormat} from "../plan/formats.ts";
import {checkMediaFit, readMedia} from "../media/library.ts";
import {dataBarGeometry, type VideoPlan} from "../plan/schema.ts";
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
  /** Rendered evidence that shows this finding, when the gate produced it. */
  evidencePaths?: string[];
  source: "hyperframes" | "tokens" | "plan";
}

export interface CheckReport {
  ok: boolean;
  errorCount: number;
  warningCount: number;
  findings: CheckFinding[];
  /** Absolute image paths safe to attach to a composer repair call. */
  evidencePaths?: string[];
  raw?: unknown;
}

const CLI = path.join(ROOT, "node_modules", "hyperframes", "bin", "hyperframes.mjs");

/**
 * Four gates in one report:
 *   1. HyperFrames' own lint / runtime / layout / motion / WCAG contrast pass
 *   2. the token-only colour rule
 *   3. plan conformance — ids, timings and verbatim copy
 *   4. actual visual development where the caption layer has gone quiet
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
  const hyperframes = await runHyperframesCheck(dir, family);
  const findings: CheckFinding[] = [
    ...hyperframes.findings,
    ...await checkTokens(dir, kit),
    ...await checkBannedWords(dir, kit),
    ...await checkPlanConformance(dir, plan, fps),
    ...await checkDataBarProportions(dir, plan),
    ...await checkMedia(plan, family),
    ...await checkCanvasLiterals(dir, plan, family),
    ...await checkWordmark(dir, kit),
    ...await checkCanonicalBrandLockups(dir, kit, plan),
    ...await checkPerpetualMotionSource(dir),
    ...motion ? await checkMotion(dir, plan, onLog) : [],
  ];

  const errorCount = findings.filter((finding) => finding.severity === "error").length;
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;
  const evidencePaths = [...new Set([
    ...hyperframes.evidencePaths,
    ...findings.flatMap((finding) => finding.evidencePaths ?? []),
  ])];
  return {ok: errorCount === 0, errorCount, warningCount, findings, evidencePaths};
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
      "Add one meaningful visual state change inside this span, then hold the resolved state. "
      + "Do not add perpetual drift — see CONTRACT.md §6.",
    evidencePaths: [...frozen.frames],
    source: "plan",
  }));
}

async function runHyperframesCheck(
  dir: string,
  family: FormatFamily,
): Promise<{findings: CheckFinding[]; evidencePaths: string[]}> {
  const zone = captionZone(family);
  const node = await compatibleNode();
  const args = [
    CLI, "check", ".",
    "--json",
    "--snapshots",
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
    return {findings: [{
      severity: "error",
      code: "check_unreadable",
      message: "hyperframes check produced no parseable JSON report.",
      source: "hyperframes",
    }], evidencePaths: []};
  }

  const findings: CheckFinding[] = [];
  for (const group of ["lint", "runtime", "layout", "motion", "contrast"] as const) {
    const section = (report as Record<string, {findings?: unknown[]}>)[group];
    for (const raw of section?.findings ?? []) {
      const finding = raw as Record<string, string>;
      const time = Number(finding.time);
      const bbox = finding.bbox as unknown as {x?: number; y?: number; width?: number; height?: number} | undefined;
      const coordinates = bbox && [bbox.x, bbox.y, bbox.width, bbox.height].every(Number.isFinite)
        ? ` at x=${bbox.x}, y=${bbox.y}, ${bbox.width}×${bbox.height}`
        : "";
      findings.push({
        severity: (finding.severity as Severity) ?? "warning",
        code: finding.code,
        message: `${group}: ${finding.message}`
          + (Number.isFinite(time) ? ` at ${time.toFixed(2)}s` : "")
          + coordinates,
        selector: finding.selector,
        fixHint: finding.fixHint,
        source: "hyperframes",
      });
    }
  }
  const snapshots = (report as {snapshots?: {files?: unknown[]; findingFiles?: unknown[]}}).snapshots;
  const evidencePaths = [...(snapshots?.findingFiles ?? []), ...(snapshots?.files ?? [])]
    .filter((file): file is string => typeof file === "string")
    .map((file) => path.resolve(dir, file));
  return {findings, evidencePaths};
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
      // A standalone brand name is correctly rendered as the supplied image. Treat its
      // alt text as the visual label for conformance without turning every asset alt into
      // ordinary on-screen copy elsewhere in the checker.
      const withImageLabels = element.inner.replace(
        /<img\b[^>]*\balt="([^"]*)"[^>]*>/gi,
        " $1 ",
      );
      const rendered = normalise(stripTags(withImageLabels));
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
  const originalBody = bodyOf(html);
  const body = originalBody.replace(/<\/?(?:span|em|strong|b|i|small|sup|sub|a)\b[^>]*>/gi, "");

  const findings: CheckFinding[] = [];
  // Catch the ordinary mistake directly. The flattened pass below is still needed for
  // hand-built marks split across inline wrappers.
  for (const element of originalBody.matchAll(
    /<(h1|h2|h3|h4|p|div|figcaption|li|td|span|strong|b|em)\b[^>]*>([^<]*)<\/\1>/gi,
  )) {
    if (normalise(stripTags(element[2] ?? "")) === name) {
      findings.push({
        severity: "error",
        code: "typeset_wordmark",
        message: `"${kit.name}" is set as type on its own. Use the supplied wordmark image.`,
        fixHint: `Place the supplied mark instead: <img src="media/logo-${marks[0]?.id}.png" alt="${kit.name}">.`,
        source: "tokens",
      });
      break;
    }
  }
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

/**
 * The persistent identity and a silent brand-signature outro use the complete supplied
 * lockup. A seal plus wordmark is made from real files but is still a reconstructed logo,
 * which is exactly the defect this check prevents.
 */
export async function checkCanonicalBrandLockups(
  dir: string,
  kit: BrandKit,
  plan: VideoPlan,
): Promise<CheckFinding[]> {
  const lockups = kit.logos.filter((logo) => logo.role === "lockup");
  if (!lockups.length) return [];

  const html = await fs.readFile(path.join(dir, "index.html"), "utf8").catch(() => "");
  const lockupPattern = new RegExp(
    `logo-(?:${lockups.map((logo) => escapeRegex(logo.id)).join("|")})\\.[a-z0-9]+`,
    "i",
  );
  const findings: CheckFinding[] = [];
  const rail = extractElement(html, "brand-rail");
  if (!rail || !lockupPattern.test(rail.inner)) {
    findings.push({
      severity: "error",
      code: "canonical_lockup_missing_rail",
      message: "The persistent brand rail does not use one supplied full lockup image.",
      fixHint:
        `Place <img class="rail-lockup" src="media/logo-${lockups[0]?.id}.png" alt="${kit.name}"> `
        + "in #brand-rail. Do not reconstruct it from a seal plus wordmark.",
      selector: "#brand-rail",
      source: "tokens",
    });
  }

  const final = [...plan.sections].reverse().find((section) => section.durationMs > 0);
  const isSilentSignature = final
    && final.kind === "outro"
    && (final.phrases.length === 0 || /brand|signature|cta/i.test(final.id));
  if (final && isSilentSignature) {
    const scene = extractElement(html, `scene-${final.id}`);
    if (!scene || !lockupPattern.test(scene.inner)) {
      findings.push({
        severity: "error",
        code: "canonical_lockup_missing_outro",
        message: `The final scene scene-${final.id} does not use one supplied full lockup image.`,
        fixHint:
          `Place a field-appropriate media/logo-${lockups[0]?.id}.png in the final scene. `
          + "Do not use the wordmark alone.",
        selector: `#scene-${final.id}`,
        source: "tokens",
      });
    }

    // A non-promotional signature still has to tell a new viewer whose work this is.
    // Requiring visible text rather than an href means the website cannot exist only in
    // metadata, and requiring the tagline prevents a bare-logo plate with no context.
    if (scene && !plan.cta) {
      const visible = normalise(stripTags(scene.inner));
      for (const [field, expected] of [
        ["tagline", kit.tagline ?? ""],
        ["website", kit.website ?? ""],
      ] as const) {
        if (expected.trim() && !visible.includes(normalise(expected))) {
          findings.push({
            severity: "error",
            code: `signature_${field}_missing`,
            message: `The silent final scene does not show the brand ${field} as readable text.`,
            fixHint:
              `Show "${expected}" beside the canonical lockup. Keep it factual and non-promotional; `
              + "do not add an imperative call to action.",
            selector: `#scene-${final.id}`,
            source: "tokens",
          });
        }
      }
    }
  }

  return findings;
}

/**
 * A displayed percentage is a claim in geometry as well as text.
 * The shared bar primitive therefore carries its source value and terminal fill in HTML,
 * where this gate can compare them without trying to infer pixels from a screenshot.
 */
export async function checkDataBarProportions(dir: string, plan: VideoPlan): Promise<CheckFinding[]> {
  const html = await fs.readFile(path.join(dir, "index.html"), "utf8").catch(() => "");
  const findings: CheckFinding[] = [];

  for (const section of plan.sections) {
    if (!section.data) continue;
    const scene = extractElement(html, `scene-${section.id}`);
    if (!scene) continue;
    const bars = openingTagsByClass(scene.inner, "data-bar");
    // The shape is only a suggestion. Counters, figures and other non-bar treatments do
    // not need bar metadata and are judged by the ordinary copy/claim checks.
    if (!bars.length) continue;
    const geometry = dataBarGeometry(section.data);

    for (const tag of bars) {
      const valueAttribute = attribute(tag, "data-value");
      const maxAttribute = attribute(tag, "data-max");
      const value = valueAttribute === null ? Number.NaN : Number(valueAttribute);
      const max = maxAttribute === null ? Number.NaN : Number(maxAttribute);
      const style = attribute(tag, "style") ?? "";
      const fill = Number(/(?:^|;)\s*--fill\s*:\s*([+-]?(?:\d+\.?\d*|\.\d+))/i.exec(style)?.[1]);
      const expected = geometry.find((point) => Number.isFinite(value) && Math.abs(point.value - value) < 1e-9);

      if (!expected || !Number.isFinite(max) || !Number.isFinite(fill)
        || Math.abs(max - (expected?.max ?? 0)) > 1e-6
        || Math.abs(fill - (expected?.fill ?? 0)) > 0.002) {
        findings.push({
          severity: "error",
          code: "data_bar_proportion",
          message:
            `scene-${section.id} has a data bar whose declared value, scale and final fill do not match the plan.`,
          fixHint:
            "Copy data-value, data-max and --fill from BRIEF.md. Animate the child span from 0 "
            + "to that declared final fill; never animate every bar to 1.",
          selector: `#scene-${section.id} .data-bar`,
          source: "plan",
        });
      }
    }
  }

  return findings;
}

/**
 * A global tween that travels for TOTAL is the old freeze-gate workaround in source form.
 * It creates the floating spine/node behaviour the temporal still review can miss because
 * the element is small. Scene-local staged beats use explicit durations and are unaffected.
 */
export async function checkPerpetualMotionSource(dir: string): Promise<CheckFinding[]> {
  const source = await fs.readFile(path.join(dir, "animation.js"), "utf8").catch(() => "");
  const offenders = source
    .split("\n")
    .map((line, index) => ({line, number: index + 1}))
    .filter(({line}) => /duration\s*:\s*TOTAL\b/.test(line))
    .filter(({line}) => /\b(?:x|y|scale|scaleX|scaleY|rotation)\s*:/.test(line));

  return offenders.map(({line, number}): CheckFinding => ({
    severity: "error",
    code: "perpetual_motion",
    message: `animation.js:${number} moves a spatial property for the full video duration: ${line.trim()}`,
    fixHint:
      "Remove the full-runtime tween. Use scene-local meaningful visual beats and readable holds; "
      + "a recurring brand accent may remain static.",
    source: "plan",
  }));
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

const openingTagsByClass = (html: string, className: string) =>
  [...html.matchAll(/<[a-z][^>]*>/gi)]
    .map((match) => match[0])
    .filter((tag) => (attribute(tag, "class") ?? "").split(/\s+/).includes(className));

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
