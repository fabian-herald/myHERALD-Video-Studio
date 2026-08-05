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
import {attribute, extractElement, openingTagsByClass} from "../compose/html.ts";
import {BLOCK_FILES} from "../compose/workdir.ts";

export type Severity = "error" | "warning" | "info";

/** The three files a composition consists of, and the only ones a finding can point at. */
export type CompositionFile = "index.html" | "styles.css" | "animation.js";

export interface CheckFinding {
  severity: Severity;
  code?: string;
  message: string;
  selector?: string;
  fixHint?: string;
  /** Rendered evidence that shows this finding, when the gate produced it. */
  evidencePaths?: string[];
  source: "hyperframes" | "tokens" | "plan";

  // Location and remedy, structured.
  //
  // Every one of these was already known at the point the finding was raised and was being
  // spent on prose — a line number interpolated into a message, an expected value computed
  // and dropped, a `sourceFile` discarded at the CLI boundary. A model can read prose back;
  // a deterministic fixer cannot, and that is the difference between a mechanical repair
  // costing a regex and costing a model session.
  /** Which of the three files the defect is in. */
  file?: CompositionFile;
  /** 1-indexed line within `file`. */
  line?: number;
  /** `id` of the offending element, without the `#`. */
  elementId?: string;
  /** Plan section this finding belongs to, for `#scene-<id>` lookup. */
  sectionId?: string;
  /** The attribute or custom property to write, when the fix is an attribute. */
  attribute?: string;
  /** The literal value a fixer should write. Present only when fully determined. */
  expected?: string;
  /** The offending open tag or source excerpt, verbatim. */
  snippet?: string;
  dataAttributes?: Record<string, string>;
  bbox?: {x: number; y: number; width: number; height: number};
  timeSeconds?: number;
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
    ...await checkStylesheetLinks(dir),
    ...await checkTokens(dir, kit),
    ...await checkBannedWords(dir, kit),
    ...await checkPlanConformance(dir, plan, fps),
    ...await checkDataBarProportions(dir, plan),
    ...await checkMedia(plan, family),
    ...await checkCanvasLiterals(dir, plan, family),
    ...await checkWordmark(dir, kit),
    ...await checkCanonicalBrandLockups(dir, kit, plan),
    ...await checkPerpetualMotionSource(dir),
    ...await checkTransformOrigin(dir),
    ...await checkLayoutWaivers(dir),
    ...await checkInventedText(dir, plan),
    ...await checkBrandRailPersistence(dir, plan),
    ...await checkNumericTiming(dir),
    ...await checkSceneEntrances(dir, plan),
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
      const geometry = bbox && [bbox.x, bbox.y, bbox.width, bbox.height].every(Number.isFinite)
        ? {x: bbox.x as number, y: bbox.y as number, width: bbox.width as number, height: bbox.height as number}
        : undefined;
      findings.push({
        severity: SEVERITY_PROMOTIONS[finding.code ?? ""]
          ?? (finding.severity as Severity) ?? "warning",
        code: finding.code,
        // Unchanged on purpose: the composers have been repairing against this exact prose,
        // and the structured fields below are an addition to it, not a replacement for it.
        message: `${group}: ${finding.message}`
          + (Number.isFinite(time) ? ` at ${time.toFixed(2)}s` : "")
          + coordinates,
        selector: finding.selector,
        fixHint: sanitizeFixHint(finding.code, finding.fixHint),
        source: "hyperframes",
        file: compositionFile(finding.sourceFile),
        elementId: finding.elementId || undefined,
        snippet: finding.snippet || undefined,
        dataAttributes: finding.dataAttributes as unknown as Record<string, string> | undefined,
        bbox: geometry,
        timeSeconds: Number.isFinite(time) ? time : undefined,
      });
    }
  }
  const snapshots = (report as {snapshots?: {files?: unknown[]; findingFiles?: unknown[]}}).snapshots;
  const evidencePaths = [...(snapshots?.findingFiles ?? []), ...(snapshots?.files ?? [])]
    .filter((file): file is string => typeof file === "string")
    .map((file) => path.resolve(dir, file));
  return {findings, evidencePaths};
}

const COMPOSITION_FILE_NAMES = ["index.html", "styles.css", "animation.js"] as const;

/** Only the three authored files are addressable; anything else is not ours to rewrite. */
function compositionFile(name: string | undefined): CompositionFile | undefined {
  if (!name) return undefined;
  const base = name.split("/").pop() ?? name;
  return COMPOSITION_FILE_NAMES.find((file) => file === base);
}

/**
 * Some upstream fix hints recommend remedies this contract forbids, and they reach the
 * composer verbatim. The `missing_gsap_script` hint names a CDN URL — a remote fetch, which
 * §1.4 rules out and which would make the render non-deterministic. GSAP is already vendored
 * into every authoring directory, so the honest hint is one line away.
 */
const FIX_HINT_OVERRIDES: Record<string, string> = {
  missing_gsap_script:
    "Link the vendored `./vendor/gsap.min.js` already present in this directory."
    + " Never load a script from a remote URL; the render must stay offline and deterministic.",
};

function sanitizeFixHint(code: string | undefined, hint: string | undefined) {
  return (code && FIX_HINT_OVERRIDES[code]) ?? hint;
}

/**
 * Upstream findings this studio holds to a higher standard than the checker that raised them.
 *
 * `rotation_pivot_drift` ships as a warning and its own source says so — "EF promotes this to
 * error separately; keep it a warning here" — so promoting it downstream is the intended seam,
 * not a disagreement with upstream. It earns the promotion: the dial on run 0600 drifted 107px
 * and 162px across its rotation, which is a clock hand sweeping around a point outside the
 * clock. It read as broken to the first person who watched it, and at warning level nothing
 * stopped it reaching a rendered video.
 */
const SEVERITY_PROMOTIONS: Record<string, Severity> = {
  rotation_pivot_drift: "error",
};

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

/**
 * Comments out, line numbers intact.
 *
 * Blanking whole lines would move every finding below the first comment. Strings are left
 * alone on purpose: in `animation.js` a colour literal is almost always *inside* a string —
 * `gsap.to(el, {backgroundColor: "#7B5BF5"})` — so masking non-code would blank precisely
 * the thing being looked for.
 */
const stripJsComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
  .replace(/\/\/[^\n]*/g, (line) => " ".repeat(line.length));

/** The rule that makes palette drift impossible rather than merely discouraged. */
export async function checkTokens(dir: string, kit: BrandKit): Promise<CheckFinding[]> {
  const read = (file: string) => fs.readFile(path.join(dir, file), "utf8").catch(() => "");
  const findings: CheckFinding[] = [];

  // animation.js is the third source, and it was the hole. The token rule was enforced on
  // the two files a designer thinks of as "the design", while a tween is free to animate to
  // an off-palette hex — which lands on screen exactly as a rogue colour in styles.css would,
  // and is harder to see because it is only there for part of a second.
  const sources = [
    ["styles.css", await read("styles.css")],
    ["index.html", await read("index.html")],
    ["animation.js", stripJsComments(await read("animation.js"))],
  ] as const;

  for (const [label, source] of sources) {
    for (const rogue of findRogueColors(source, kit)) {
      findings.push({
        // Warning in animation.js until two real compositions have gone through it. The
        // other two have run as errors for the whole life of the checker; this one has
        // never fired in anger, and an error-level false positive costs a repair round.
        severity: label === "animation.js" ? "warning" : "error",
        code: "rogue_color",
        message: `${label}:${rogue.line} uses \`${rogue.literal}\`, which is not a brand token.`,
        fixHint: "Replace it with the matching var(--brand-*) token, or a neutral rgba(0,0,0,α)/rgba(255,255,255,α) scrim.",
        source: "tokens",
        file: label,
        line: rogue.line,
        snippet: rogue.literal,
      });
    }
  }
  return findings;
}

/**
 * Class names whose rule makes an element invisible without removing it from the DOM.
 *
 * The screen-reader clip — `position:absolute; width:1px; height:1px; overflow:hidden;
 * clip:rect(0 0 0 0)` — is the one that matters here, because it is what a composition
 * reached for when it could not fit the plan's copy and still had to satisfy the copy rule.
 * The others are included because they answer the rule the same way for the same reason.
 *
 * `aria-hidden` is deliberately *not* treated as hidden: it is the correct marking for a
 * decorative shape that is very much on screen.
 */
export function visuallyHiddenClasses(css: string): Set<string> {
  const hidden = new Set<string>();
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g);

  for (const [, selector = "", body = ""] of rules) {
    const collapsed = body.replace(/\s+/g, "");
    const invisible = /display:none/i.test(collapsed)
      || /visibility:hidden/i.test(collapsed)
      || /(^|;)opacity:0(;|$)/i.test(collapsed)
      || /clip:rect\(0[,\s]*0[,\s]*0[,\s]*0\)/i.test(collapsed)
      || /clip-path:inset\(100%\)/i.test(collapsed)
      || (/(^|;)width:1px/i.test(collapsed) && /(^|;)height:1px/i.test(collapsed));
    if (!invisible) continue;
    for (const match of selector.matchAll(/\.([\w-]+)/g)) hidden.add(match[1]!);
  }
  return hidden;
}

/** Drop every element carrying one of those classes, contents included. */
export function removeHiddenElements(html: string, hidden: ReadonlySet<string>): string {
  if (!hidden.size) return html;
  let out = html;

  for (const className of hidden) {
    const opener = new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*\\bclass="[^"]*\\b${escapeRegex(className)}\\b[^"]*"[^>]*>`);
    for (let match = opener.exec(out); match; match = opener.exec(out)) {
      const tag = match[1]!;
      const from = match.index;
      // Walk balanced tags of the same name, so a nested one does not close the outer.
      const nested = new RegExp(`<${escapeRegex(tag)}\\b|</${escapeRegex(tag)}\\s*>`, "gi");
      nested.lastIndex = from + match[0].length;
      let depth = 1;
      let to = out.length;
      for (let inner = nested.exec(out); inner; inner = nested.exec(out)) {
        depth += inner[0].startsWith("</") ? -1 : 1;
        if (depth === 0) {
          to = inner.index + inner[0].length;
          break;
        }
      }
      out = `${out.slice(0, from)} ${out.slice(to)}`;
    }
  }
  return out;
}

/**
 * Ties the composition back to the plan. This is what keeps the video editable:
 * as long as ids and copy line up, a text change can be applied without the model.
 */
async function checkPlanConformance(dir: string, plan: VideoPlan, fps: number): Promise<CheckFinding[]> {
  const html = await fs.readFile(path.join(dir, "index.html"), "utf8").catch(() => "");
  const css = await fs.readFile(path.join(dir, "styles.css"), "utf8").catch(() => "");
  const hidden = visuallyHiddenClasses(css);
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
        file: "index.html",
        elementId: `scene-${section.id}`,
        sectionId: section.id,
        snippet: element.openTag,
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
      // What the viewer can actually read. A composition that could not fit the plan's copy
      // has been observed satisfying this rule with `position:absolute; width:1px;
      // height:1px; clip:rect(0 0 0 0)` — the screen-reader idiom, invisible on screen. The
      // rule exists to guarantee the copy is *rendered*, so hidden text cannot answer it.
      const expected = normalise(section.onScreen);
      const inMarkup = normalise(stripTags(withImageLabels)).includes(expected);
      const onScreen = normalise(stripTags(removeHiddenElements(withImageLabels, hidden)))
        .includes(expected);

      if (inMarkup && !onScreen) {
        findings.push({
          severity: "error",
          code: "hidden_plan_copy",
          message:
            `scene-${section.id} carries its on-screen copy only inside a visually hidden `
            + "element, so no viewer ever sees it.",
          fixHint:
            "Delete the hidden element and set the copy as real type in the composition. "
            + "If it will not fit, the layout is the thing to change, not the visibility.",
          source: "plan",
          file: "index.html",
          sectionId: section.id,
          selector: `#scene-${section.id}`,
        });
      } else if (!onScreen) {
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

  const js = await fs.readFile(path.join(dir, "animation.js"), "utf8").catch(() => "");
  const code = js.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

  // The same literal is just as wrong in the stylesheet — `height: 1920px` on a scene is
  // right at 9:16 and overflows or underfills 4:5 and 1:1 identically to a JS constant. It
  // needed only a CSS comment stripper and a pattern that admits the `px` suffix, which the
  // JS pattern rejects because `p` is a word character.
  const css = (await fs.readFile(path.join(dir, "styles.css"), "utf8").catch(() => ""))
    .replace(/\/\*[\s\S]*?\*\//g, " ");

  return axes.flatMap(({axis, source: accessor, values}) => [
    ...values
      .filter((value) => new RegExp(`(?<![\\w.])${value}(?![\\w.])`).test(code))
      .map((value): CheckFinding => ({
        severity: "error",
        code: "canvas_literal",
        message:
          `animation.js hardcodes ${value}, which is the canvas ${axis} of one format but not `
          + `of the others in this family (${values.join(", ")}). It will be wrong everywhere else.`,
        fixHint: `Read it once from the stage: parseFloat(stage.${accessor}).`,
        source: "plan",
        file: "animation.js",
      })),
    ...values
      .filter((value) => new RegExp(`(?<![\\w.#-])${value}(?:px)?(?![\\w.%-])`).test(css))
      .map((value): CheckFinding => ({
        // Warning, not error, for its first two compositions. A stylesheet has far more
        // numbers in it than a timeline does, and one axis value can coincide with an
        // unrelated size — portrait's varying heights include 1080, which is also its
        // constant width, so `width: 1080px` reads as a height literal here.
        severity: "warning",
        code: "canvas_literal_css",
        message:
          `styles.css hardcodes ${value}, which is the canvas ${axis} of one format but not `
          + `of the others in this family (${values.join(", ")}).`,
        fixHint:
          `Size it off the canvas instead: var(--stage-${axis === "height" ? "h" : "w"}), `
          + "a percentage, or a multiple of var(--u).",
        source: "plan",
        file: "styles.css",
      })),
  ]);
}

/** The `<link>` set every composition must carry, in order, with its own styles last. */
export const REQUIRED_STYLESHEETS = [
  "./tokens.css",
  ...BLOCK_FILES.map((file) => `./blocks/${file}`),
  "./styles.css",
] as const;

/**
 * The stylesheets a composition is built on, present and in order.
 *
 * Everything downstream assumes them. `var(--brand-*)` resolves only if `tokens.css` is
 * linked; `.clip`, `--u` and the scene shell come from the blocks; and `styles.css` must
 * come last or a block primitive overrides the composition that meant to specialise it.
 * A composition that omits one does not fail loudly — it renders, wrong, and the token
 * check passes because the literals it would have flagged were never written.
 *
 * Order is asserted as a subsequence rather than an exact list: a composition may link an
 * extra sheet of its own, and that is not this rule's business.
 */
export async function checkStylesheetLinks(dir: string): Promise<CheckFinding[]> {
  const html = await fs.readFile(path.join(dir, "index.html"), "utf8").catch(() => "");
  if (!html.trim()) return [];

  const hrefs = [...html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/gi)].map((match) => match[1]!);
  const findings: CheckFinding[] = [];

  const missing = REQUIRED_STYLESHEETS.filter((sheet) => !hrefs.includes(sheet));
  if (missing.length) {
    findings.push({
      severity: "error",
      code: "missing_stylesheet_link",
      message: `index.html does not link ${missing.join(", ")}.`,
      fixHint: `Link all of these in <head>, in this order: ${REQUIRED_STYLESHEETS.join(", ")}.`,
      source: "plan",
      file: "index.html",
      expected: REQUIRED_STYLESHEETS.map((sheet) => `<link rel="stylesheet" href="${sheet}" />`).join("\n  "),
    });
    return findings;
  }

  const positions = REQUIRED_STYLESHEETS.map((sheet) => hrefs.indexOf(sheet));
  const ordered = positions.every((position, index) => index === 0 || position > positions[index - 1]!);
  if (!ordered) {
    findings.push({
      severity: "error",
      code: "stylesheet_link_order",
      message:
        "The stylesheets are linked out of order. Later sheets override earlier ones, so "
        + "styles.css last is what lets the composition specialise a block rather than fight it.",
      fixHint: `Required order: ${REQUIRED_STYLESHEETS.join(", ")}.`,
      source: "plan",
      file: "index.html",
      expected: REQUIRED_STYLESHEETS.map((sheet) => `<link rel="stylesheet" href="${sheet}" />`).join("\n  "),
    });
  }
  return findings;
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
      file: "index.html",
      // A spaced en-dash is the one substitution that needs no judgement about the sentence;
      // choosing a comma or a full stop instead is a copy decision and stays with the model.
      expected: "–",
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
/**
 * Names the assets without choosing between them. Which mark is right depends on the field
 * it sits on, which this gate cannot see — but a hint that names no file at all leaves the
 * composer guessing at paths, so list what was actually supplied.
 */
function wordmarkFixHint(marks: BrandKit["logos"]): string {
  const wordmarks = marks.filter((logo) => logo.role === "wordmark");
  const named = (wordmarks.length ? wordmarks : marks)
    .map((logo) => `media/logo-${logo.id}${path.extname(logo.file)}`)
    .join(", ");
  return "Use a field-appropriate supplied wordmark image for ordinary standalone use"
    + (named ? ` (${named})` : "")
    + ". Inside #brand-rail or a final signature/CTA, use one supplied full lockup image instead.";
}

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
        fixHint: wordmarkFixHint(marks),
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
        fixHint: wordmarkFixHint(marks),
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
/**
 * One source for the rail lockup markup, so the hint the model reads and the literal a
 * fixer writes cannot drift apart. The extension comes from the kit rather than an assumed
 * `.png`, because `prepareAuthoringDir` names the copy after the source file's extension.
 */
function railLockupTag(kit: BrandKit, logo: BrandKit["logos"][number] | undefined): string {
  const file = logo ? `media/logo-${logo.id}${path.extname(logo.file)}` : "media/logo-lockup.png";
  return `<img class="rail-lockup" src="${file}" alt="${kit.name}">`;
}

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
    // The rail declares the field it sits on, so when that class is present the correct
    // asset is determined and the tag can be written without a model. Absent it, picking
    // between the light, dark and plate lockups is a design call and `expected` stays unset.
    const field = /\bon-(light|dark)\b/.exec(rail?.openTag ?? "")?.[1];
    const chosen = field
      ? lockups.find((logo) => logo.theme === field) ?? lockups.find((logo) => logo.theme === "any")
      : undefined;
    findings.push({
      severity: "error",
      code: "canonical_lockup_missing_rail",
      message: "The persistent brand rail does not use one supplied full lockup image.",
      fixHint:
        `Place ${railLockupTag(kit, lockups[0])} `
        + "in #brand-rail, choosing the field-appropriate lockup. "
        + "Do not reconstruct it from a seal plus wordmark.",
      selector: "#brand-rail",
      source: "tokens",
      file: "index.html",
      elementId: "brand-rail",
      expected: chosen ? railLockupTag(kit, chosen) : undefined,
    });
  }

  const final = [...plan.sections].reverse().find((section) => section.durationMs > 0);
  // The rule used to require silence, and silence has nothing to do with it. A narrated
  // call to action is the same end card with a voice over it, and it was free to rebuild
  // the mark out of a seal and a wordmark — the exact failure the rule exists to stop,
  // in the one frame a viewer is most likely to screenshot.
  const isSignature = final
    && (final.kind === "outro" || final.kind === "cta")
    && (final.phrases.length === 0 || /brand|signature|cta/i.test(final.id));
  if (final && isSignature) {
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
    //
    // Unless the lockup already says it. This rule had no way to see inside the image, so
    // it demanded the tagline as type on a card whose lockup renders the same words — and
    // the composer had no legal alternative to putting "Autonomous AI Content Engine" on
    // screen twice. A supplied asset that carries the tagline satisfies the requirement it
    // was written for: the viewer can read it.
    const taglineInLockup = lockups.some((logo) =>
      logo.includesTagline
      && new RegExp(`logo-${escapeRegex(logo.id)}\\.[a-z0-9]+`, "i").test(scene?.inner ?? ""));

    // The mirror of the rule below, and the one the owner actually noticed: the end card
    // showing the tagline twice, once as artwork and once as type under it.
    //
    // Conditioned on the plan, because the plan is usually to blame. Every plan written so
    // far put "<name>\n<tagline>\n<website>" in the final section's `onScreen`, which
    // `copy_drift` then demands verbatim — the composer had no legal alternative. Planner
    // rule 11 stops new plans doing that; this catches the composer that does it anyway.
    const tagline = kit.tagline?.trim() ?? "";
    const planWantsTagline = tagline && normalise(final.onScreen ?? "").includes(normalise(tagline));
    if (scene && tagline && taglineInLockup && !planWantsTagline) {
      const asType = normalise(stripTags(scene.inner)).includes(normalise(tagline));
      if (asType) {
        findings.push({
          severity: "warning",
          code: "tagline_duplicated",
          message:
            `scene-${final.id} sets "${tagline}" as type beside a lockup whose artwork `
            + "already renders it, so the viewer reads the same words twice.",
          fixHint:
            "Delete the tagline text. The lockup carries it; give the space to the website "
            + "or to nothing.",
          source: "tokens",
          file: "index.html",
          sectionId: final.id,
          selector: `#scene-${final.id}`,
        });
      }
    }

    if (scene && !plan.cta) {
      const visible = normalise(stripTags(scene.inner));
      for (const [field, expected] of [
        ["tagline", taglineInLockup ? "" : kit.tagline ?? ""],
        ["website", kit.website ?? ""],
      ] as const) {
        if (expected.trim() && !visible.includes(normalise(expected))) {
          findings.push({
            severity: "error",
            code: `signature_${field}_missing`,
            message: `The final scene does not show the brand ${field} as readable text.`,
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
          file: "index.html",
          sectionId: section.id,
          // The matched tag identifies *which* bar, which the selector alone cannot when a
          // scene holds several. `expected` is present only when data-value pinned the bar
          // to a plan point — without that anchor there is no sound mapping from this bar to
          // a figure, and writing one would put a wrong number on screen.
          snippet: tag,
          expected: expected
            ? JSON.stringify({value: expected.value, max: expected.max, fill: expected.fill})
            : undefined,
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
  const sources = [
    {file: "animation.js", source: await fs.readFile(path.join(dir, "animation.js"), "utf8").catch(() => "")},
    {file: "index.html", source: await fs.readFile(path.join(dir, "index.html"), "utf8").catch(() => "")},
  ];
  const offenders = sources.flatMap(({file, source}) => fullRuntimeSpatialTweens(file, source));

  return offenders.map(({file, excerpt, number}): CheckFinding => ({
    severity: "error",
    code: "perpetual_motion",
    message: `${file}:${number} moves a spatial property for the full video duration: ${excerpt}`,
    fixHint:
      "Remove the full-runtime tween. Use scene-local meaningful visual beats and readable holds; "
      + "a recurring brand accent may remain static.",
    source: "plan",
    file: compositionFile(file),
    line: number,
    snippet: excerpt,
  }));
}

/**
 * The persistent identity strip has to be persistent.
 *
 * `brand-rail.css` calls it MANDATORY and the lockup rule checks it holds the right asset,
 * but nothing checked that it is *on screen* — a rail clipped to the first eight seconds
 * satisfies every existing gate and then leaves four fifths of the video unbranded.
 *
 * Two findings, because they are two different mistakes. Clip attributes that do not span
 * the runtime are an error: the correct values are the root's own, so a fixer can write
 * them. A fade to nothing partway through is a warning, and a narrow one — the exemplar
 * legitimately fades the rail 0.14s before the final section so the outro card can carry
 * the mark alone, and that is the good version of this. Only a fade whose position can be
 * read statically and is demonstrably early is reported; a position this cannot evaluate
 * is left alone rather than guessed at.
 */
export async function checkBrandRailPersistence(
  dir: string,
  plan: VideoPlan,
): Promise<CheckFinding[]> {
  const html = await fs.readFile(path.join(dir, "index.html"), "utf8").catch(() => "");
  const rail = extractElement(html, "brand-rail");
  if (!rail) return [];

  const findings: CheckFinding[] = [];
  const total = Number(/data-duration="([\d.]+)"/.exec(html)?.[1] ?? 0);
  const start = Number(attribute(rail.openTag, "data-start") ?? "0");
  const duration = Number(attribute(rail.openTag, "data-duration") ?? "0");

  // One frame of slack: a composition rounding to 3dp against a 30fps grid is not a defect.
  if (total > 0 && (start > 0.034 || duration <= 0 || start + duration < total - 0.034)) {
    findings.push({
      severity: "error",
      code: "brand_rail_not_persistent",
      message:
        `#brand-rail is on screen from ${start}s for ${duration}s, but the video runs `
        + `${total}s. The identity strip is required for the whole of it.`,
      fixHint: `Set data-start="0" and data-duration="${total}" on #brand-rail.`,
      source: "tokens",
      file: "index.html",
      elementId: "brand-rail",
      attribute: "data-duration",
      expected: String(total),
      snippet: rail.openTag,
    });
  }

  const finalSection = [...plan.sections].reverse().find((section) => section.durationMs > 0);
  const finalStart = finalSection ? finalSection.startMs / 1000 : total;
  // Comments stripped, strings kept. `maskNonCode` is wrong here: the things being read —
  // the "#brand-rail" selector and the scene id inside `at("#scene-payoff")` — are string
  // literals, and masking blanks exactly those.
  const source = stripJsComments(
    await fs.readFile(path.join(dir, "animation.js"), "utf8").catch(() => ""),
  );
  const nonFinal = new Set(plan.sections.slice(0, -1).map((section) => section.id));

  for (const match of source.matchAll(/\.\s*(?:to|set|fromTo)\s*\(\s*["'`]#brand-rail["'`]/g)) {
    const from = match.index ?? 0;
    // Balanced, not a regex: a position argument is routinely `at("#scene-x") + 0.2`, and
    // a `[^)]*` group stops at that inner bracket and then fails to match at all.
    const call = source.slice(from, balancedCallEnd(source, source.indexOf("(", from)));
    if (!/\b(?:autoAlpha|opacity)\s*:\s*0\b/.test(call)) continue;
    const position = lastArgument(call);

    // A number, or a reference to a scene that is not the last one. Anything else — a
    // symbol this cannot resolve — is not reported, because a wrong guess here costs a
    // repair round spent undoing a deliberate hand-off to the outro card.
    const numeric = /^\s*[\d.]+\s*$/.test(position) ? Number(position) : null;
    const named = /at\(\s*["'`]#?(?:scene-)?([\w-]+)/.exec(position)?.[1];
    const early = numeric !== null
      ? numeric < finalStart - 0.5
      : Boolean(named && nonFinal.has(named));
    if (!early) continue;

    findings.push({
      severity: "warning",
      code: "brand_rail_hidden_early",
      message:
        `animation.js hides #brand-rail at ${position.trim() || "0"}, before the final `
        + `section begins at ${finalStart.toFixed(2)}s, so most of the video carries no mark.`,
      fixHint:
        "Fade the rail only into the closing card, where the outro lockup takes over. "
        + "Anywhere earlier and the video is unbranded from that point on.",
      source: "tokens",
      file: "animation.js",
      selector: "#brand-rail",
      snippet: call.replace(/\s+/g, " ").slice(0, 180),
    });
  }

  return findings;
}

/** The last top-level argument of a call, splitting on commas outside brackets and braces. */
function lastArgument(call: string): string {
  const open = call.indexOf("(");
  const body = call.slice(open + 1, call.lastIndexOf(")"));
  let depth = 0;
  let start = 0;
  const args: string[] = [];
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      args.push(body.slice(start, index));
      start = index + 1;
    }
  }
  args.push(body.slice(start));
  return args.length > 1 ? args[args.length - 1]!.trim() : "";
}

const VOID_TAGS = new Set(["br", "img", "input", "meta", "link", "hr", "source", "area", "col"]);

/** `data-layout-allow-overflow` is not here: bleeding off-canvas is a different decision. */
const WAIVER = /data-layout-allow-(?:overlap|occlusion)\b/;

interface MarkupNode {
  tag: string;
  className: string;
  waived: boolean;
  text: string;
  line: number;
  openTag: string;
  parent: MarkupNode | null;
  children: MarkupNode[];
  /** Offset just past the open tag; `text` is filled in when the close tag is reached. */
  textFrom: number;
}

/** A shallow element tree — enough to ask who a node's parent and siblings are. */
function markupTree(html: string): MarkupNode[] {
  const nodes: MarkupNode[] = [];
  const stack: MarkupNode[] = [];
  const tags = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;

  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    const [whole, closing, rawTag = "", attrs = "", selfClosing] = match;
    const tag = rawTag.toLowerCase();
    if (VOID_TAGS.has(tag)) continue;
    if (closing) {
      const open = stack.pop();
      if (open) open.text = stripTags(html.slice(open.textFrom, match.index));
      continue;
    }
    if (selfClosing) continue;

    const node: MarkupNode = {
      tag,
      className: /class="([^"]*)"/.exec(attrs)?.[1] ?? "",
      waived: WAIVER.test(attrs),
      text: "",
      line: html.slice(0, match.index).split("\n").length,
      openTag: whole,
      parent: stack[stack.length - 1] ?? null,
      children: [],
      textFrom: match.index + whole.length,
    };
    node.parent?.children.push(node);
    nodes.push(node);
    stack.push(node);
  }
  return nodes;
}

/**
 * A layout waiver that silences the checker rather than declaring an intention.
 *
 * `data-layout-allow-overlap` and `-occlusion` tell the HyperFrames layout pass that an
 * overlap is deliberate. They are genuinely needed — the approved exemplar's hook is a
 * stack of five sheets deliberately sitting on top of one another, and without the waivers
 * that scene could not exist. But nothing checked *how* they were used, and the difference
 * between the two uses is visible in the markup.
 *
 * A deliberate overlap is a relationship, so it is declared on both parties: in the
 * exemplar, `.sheet-stack` is waived and so is every `.sheet` inside it. A waiver on one
 * element alone says "let anything overlap me", which is not a design decision. That is
 * what put a yellow "VOLUME" chip across the "Th" of a headline and an axis label through
 * the word "measure", with no finding raised, in a composition that passed every gate.
 *
 * Measured across every composition in the repo: dba07c 0 of 6, the approved 7e83b7 0 of 3,
 * and 0 for five more that shipped. The three-of-three composition is the one with the
 * reported overlaps.
 *
 * Promoted to error once and reverted, which is worth recording so it is not promoted again
 * on the same reasoning. The promotion note claimed every composition that shipped scores
 * zero. That was asserted from the four compositions in front of me, not measured, and it is
 * false: run it over all twenty-nine composition families in the repo and eight of them score
 * 1 to 6, including the accepted Terra landscape, which trips it on `.standard-index`. As an
 * error it would have blocked 28% of the work that has shipped, some of it approved by the
 * owner.
 *
 * It stays a warning, and it stays worth having — it named the oversized "02" lying across a
 * headline in a frame the owner rejected on sight. But the distribution says it does not yet
 * separate broken from merely unusual, and a gate that fails a quarter of approved work is
 * measuring the wrong thing however good its individual catches are.
 */
export async function checkLayoutWaivers(dir: string): Promise<CheckFinding[]> {
  const html = await fs.readFile(path.join(dir, "index.html"), "utf8").catch(() => "");
  if (!html.trim()) return [];

  return markupTree(html)
    .filter((node) => node.waived)
    .filter((node) => {
      const siblings = node.parent?.children ?? [];
      const grouped = node.parent?.waived
        || node.children.filter((child) => child.waived).length >= 2
        || siblings.some((sibling) => sibling !== node && sibling.waived);
      // A waiver on a purely decorative shape is a design call about shapes. On live type
      // it is the reader's ability to read that is being waived.
      return !grouped && node.text.trim().length > 0;
    })
    .map((node): CheckFinding => ({
      severity: "warning",
      code: "lone_layout_waiver",
      message:
        `index.html:${node.line} waives the layout check on <${node.tag}`
        + `${node.className ? ` class="${node.className}"` : ""}>, which carries text, and `
        + "nothing it overlaps is waived in return — so this silences the check rather than "
        + "declaring an intention.",
      fixHint:
        "Either move whatever overlaps this text, or declare the overlap on both parties: "
        + "waive the group they both sit in, the way a deliberately stacked set is waived.",
      source: "plan",
      file: "index.html",
      line: node.line,
      selector: node.className ? `.${node.className.split(/\s+/)[0]}` : node.tag,
      snippet: node.openTag.slice(0, 200),
    }));
}

/**
 * A single-axis scale with no transform origin.
 *
 * Narrow on purpose. GSAP's default origin is the centre, and for a card that pops or a
 * mark that spins, the centre is right — flagging those would fire on most of a good
 * composition. `scaleX` and `scaleY` are different: they are how a bar fills, a rule draws
 * and a slab wipes, and from the centre such an element grows in both directions at once.
 * Every one of the twenty single-axis scales in the exemplar names its origin.
 *
 * Satisfied per target, not per call, because the correct idiom the exemplar uses is a
 * `.set(target, {scaleY: 0, transformOrigin: "top center"})` followed by a plain `.to`.
 * A `transform-origin` in the stylesheet counts too — it is the same declaration.
 */
export async function checkTransformOrigin(dir: string): Promise<CheckFinding[]> {
  const source = await fs.readFile(path.join(dir, "animation.js"), "utf8").catch(() => "");
  if (!source.trim()) return [];
  const code = maskNonCode(source);
  const css = await fs.readFile(path.join(dir, "styles.css"), "utf8").catch(() => "");

  const calls = /\b(?:gsap|[A-Za-z_$][\w$]*)\s*\.\s*(?:to|from|fromTo|set)\s*\(/g;
  const declared = new Set<string>();
  const offenders: {target: string; line: number; excerpt: string}[] = [];

  for (const match of code.matchAll(calls)) {
    const start = match.index ?? 0;
    const end = balancedCallEnd(code, code.indexOf("(", start));
    // The target comes from the *unmasked* source — masking blanks string literals, which
    // is exactly where the selector is.
    const call = source.slice(start, end);
    const target = /\(\s*["'`]([^"'`]+)["'`]/.exec(call)?.[1];
    if (!target) continue;

    if (/\btransformOrigin\s*:/.test(call)) declared.add(target);
    else if (/\bscale[XY]\s*:/.test(call)) {
      offenders.push({
        target,
        line: source.slice(0, start).split("\n").length,
        excerpt: call.replace(/\s+/g, " ").trim().slice(0, 180),
      });
    }
  }

  const inCss = (target: string) => {
    const index = css.indexOf(target);
    if (index < 0) return false;
    const block = css.slice(index, css.indexOf("}", index) + 1 || undefined);
    return /transform-origin\s*:/.test(block);
  };

  const seen = new Set<string>();
  return offenders
    .filter((offender) => !declared.has(offender.target) && !inCss(offender.target))
    .filter((offender) => !seen.has(offender.target) && seen.add(offender.target))
    .map((offender): CheckFinding => ({
      // Warning for its first two compositions. Scaling a shape from its centre is a real
      // choice, just a rare one on a single axis, and an error here would cost a repair
      // round every time a composer meant it.
      severity: "warning",
      code: "missing_transform_origin",
      message:
        `animation.js:${offender.line} scales "${offender.target}" on one axis with no `
        + "transformOrigin, so it grows from its centre in both directions.",
      fixHint:
        "Name the edge it grows from — transformOrigin: \"left center\", \"top center\", "
        + "\"bottom center\" — in this call or in the .set that establishes its initial state.",
      source: "plan",
      file: "animation.js",
      line: offender.line,
      selector: offender.target,
      snippet: offender.excerpt,
    }));
}

/**
 * Timings written as numbers instead of read from the DOM.
 *
 * Two findings from one walk, because they are two halves of the same mistake: a duration
 * or a position typed in as a literal is correct only for the runtime it was typed against,
 * and every retime — a re-narration, a trimmed phrase, a longer end card — moves it silently.
 * §3 of the contract already says to derive both from `at()` and `len()`; nothing checked.
 *
 * `checkPerpetualMotionSource` catches the identifier form (`duration: TOTAL`). This is the
 * numeric one it cannot see, plus positions, which nothing looked at.
 *
 * Warning severity, and gap 1 is the reason. A bare number as a timeline position is
 * usually a defect and sometimes a deliberate small offset, and no amount of pattern
 * matching separates those; an error here would cost a repair round on good work.
 */
export async function checkNumericTiming(dir: string): Promise<CheckFinding[]> {
  const raw = await fs.readFile(path.join(dir, "animation.js"), "utf8").catch(() => "");
  if (!raw.trim()) return [];
  const html = await fs.readFile(path.join(dir, "index.html"), "utf8").catch(() => "");
  const total = Number(/data-duration="([\d.]+)"/.exec(html)?.[1] ?? 0);
  const code = stripJsComments(raw);

  const findings: CheckFinding[] = [];
  const calls = /\b(?:gsap|[A-Za-z_$][\w$]*)\s*\.\s*(?:to|from|fromTo|set|call|add)\s*\(/g;

  for (const match of code.matchAll(calls)) {
    const from = match.index ?? 0;
    const call = code.slice(from, balancedCallEnd(code, code.indexOf("(", from)));
    const line = code.slice(0, from).split("\n").length;
    const excerpt = call.replace(/\s+/g, " ").trim().slice(0, 180);

    // Gap 2 — a numeric duration that is effectively the whole video. The identifier form
    // is already a hard error; writing the same number by hand was a way around it.
    const duration = /\bduration\s*:\s*([\d.]+)/.exec(call);
    if (total > 0 && duration && Number(duration[1]) >= total * 0.9) {
      findings.push({
        severity: "warning",
        code: "numeric_full_runtime_tween",
        message:
          `animation.js:${line} runs a tween for ${duration[1]}s against a ${total}s video, `
          + "so it never resolves — the same perpetual motion the TOTAL form is rejected for.",
        fixHint:
          "Give it a scene-local duration and a readable hold. If it genuinely spans the "
          + "piece it is a state change with no state, and CONTRACT §6 rejects it.",
        source: "plan",
        file: "animation.js",
        line,
        snippet: excerpt,
      });
    }

    // Gap 1 — a bare number as the position argument. Zero is the start of the timeline and
    // means what it says; anything derived from at()/len()/TOTAL is correct by construction.
    const position = lastArgument(call);
    if (/^[\d.]+$/.test(position) && Number(position) !== 0) {
      findings.push({
        severity: "warning",
        code: "hardcoded_scene_time",
        message:
          `animation.js:${line} places a tween at ${position}s as a literal. Retiming the `
          + "video — a re-narration, a trimmed phrase — moves the scene and leaves this behind.",
        fixHint:
          'Derive it: at("#scene-<id>") for a scene start, plus len("#scene-<id>") for a '
          + "fraction of its length. See CONTRACT §3.",
        source: "plan",
        file: "animation.js",
        line,
        snippet: excerpt,
      });
    }
  }

  // A composition that hardcodes one position usually hardcodes all of them — one in the
  // repo does it 68 times. With no errors in the report, `actionableRepairFindings` hands
  // the warnings to the composer, and 68 of anything is not a surgical repair brief. Report
  // enough to establish the pattern and say how many were left out; a silent truncation
  // would read as "that is all of them".
  const positions = findings.filter((finding) => finding.code === "hardcoded_scene_time");
  if (positions.length <= HARDCODED_TIME_REPORT_LIMIT) return findings;

  const shown = positions.slice(0, HARDCODED_TIME_REPORT_LIMIT);
  shown[shown.length - 1] = {
    ...shown[shown.length - 1]!,
    message: `${shown[shown.length - 1]!.message} `
      + `(${positions.length - HARDCODED_TIME_REPORT_LIMIT} further literal positions not listed; `
      + "the timing is hardcoded throughout, so derive all of it rather than these alone.)",
  };
  return [...findings.filter((finding) => finding.code !== "hardcoded_scene_time"), ...shown];
}

export const HARDCODED_TIME_REPORT_LIMIT = 5;

/**
 * Adjacent scenes that arrive the same way.
 *
 * `info`, and it stays `info`. This is the only one of the nine gaps that asks the checker
 * to judge rather than verify: a fingerprint of "the properties the first tween animates"
 * is either loose enough to fire on deliberate rhyme or tight enough to miss real repetition,
 * and there is no version that is neither. CONTRACT §6 states the rule and the visual-review
 * rubric checks it against actual pixels, which is the tool that can see the difference.
 *
 * It is here because a cheap signal in the log is worth having when the frames disagree.
 */
export async function checkSceneEntrances(dir: string, plan: VideoPlan): Promise<CheckFinding[]> {
  const raw = await fs.readFile(path.join(dir, "animation.js"), "utf8").catch(() => "");
  if (!raw.trim()) return [];
  const code = stripJsComments(raw);

  // Walk the calls, not the scene references. Searching backwards from `at("#scene-x")` for
  // the enclosing call finds the dot in `duration: .5` long before it finds `.from`.
  const entrances = new Map<string, string>();
  for (const match of code.matchAll(/\b(?:gsap|[A-Za-z_$][\w$]*)\s*\.\s*(?:to|from|fromTo|set)\s*\(/g)) {
    const from = match.index ?? 0;
    const call = code.slice(from, balancedCallEnd(code, code.indexOf("(", from)));
    const scene = /at\(\s*["'`]#?(?:scene-)?([\w-]+)/.exec(lastArgument(call))?.[1];
    // Only the first call at a scene's start is its entrance; later ones are its development.
    if (!scene || entrances.has(scene)) continue;

    const vars = [...call.matchAll(/\b([a-zA-Z]\w*)\s*:/g)]
      .map((varMatch) => varMatch[1]!)
      .filter((name) => name !== "duration" && name !== "ease" && name !== "stagger")
      .sort();
    const ease = /\bease\s*:\s*["'`]([^"'`]+)/.exec(call)?.[1] ?? "";
    if (vars.length) entrances.set(scene, `${vars.join(",")}|${ease}`);
  }

  const fingerprints = plan.sections.map((section) => ({
    id: section.id,
    print: entrances.get(section.id) ?? "",
  }));

  const findings: CheckFinding[] = [];
  for (let index = 1; index < fingerprints.length; index++) {
    const previous = fingerprints[index - 1]!;
    const current = fingerprints[index]!;
    if (!current.print || current.print !== previous.print) continue;
    findings.push({
      severity: "info",
      code: "repeated_scene_entrance",
      message:
        `scene-${current.id} arrives the same way as scene-${previous.id} `
        + `(${current.print.replace("|", " with ease ")}).`,
      fixHint:
        "Two scenes in a row entering identically reads as one long scene. Vary what moves "
        + "and from where — CONTRACT §6.",
      source: "plan",
      file: "animation.js",
      sectionId: current.id,
    });
  }
  return findings;
}

/**
 * The one full-runtime tween that is a readout rather than drift.
 *
 * §5 makes a continuous element mandatory and describes it as "the spine's line grows and
 * its node travels" — a bar showing how far through the video you are. §6 already carves
 * out an object that encodes measured progress, but conditioned it on the brief asking for
 * one, and no brief ever does; this check had no carve-out at all. So the only way to build
 * the spine that passed was to step it scene by scene, and every composition since has.
 *
 * Stepping is worse, and the owner said so on watching one: the continuous version reads as
 * elapsed time, the stepped one reads as six unrelated animations. It is also a different
 * kind of motion from the drifting and bobbing this rule exists to stop — which is exactly
 * what the three conditions below encode.
 *
 * All three must hold. **The spine**, because it is the one element the framework declares
 * continuous. **`ease: "none"`**, because a progress readout that accelerates is not
 * reporting anything — an eased full-runtime tween is decoration wearing a readout's
 * clothes. **Along its own axis**, `scaleY` or `y`: a spine that rotates or scales
 * uniformly for forty-five seconds is drift, whatever it is called.
 *
 * The freeze gate is untouched by this. §5 already says a hairline crossing the canvas
 * alters too few pixels to count as a visual beat, so a continuous spine still cannot be a
 * scene's motion — it never could.
 */
function isProgressReadout(call: string): boolean {
  const target = /\(\s*["'`]([^"'`]+)["'`]/.exec(call)?.[1] ?? "";
  const isSpine = /\bsignal-spine\b|\bspine-line\b|\bspine-node\b|#spine\b/.test(target);
  const linear = /\bease\s*:\s*["'`]none["'`]/.test(call);
  const alongAxis = /\b(?:scaleY|y)\s*:/.test(call)
    && !/\b(?:rotation|rotate|scaleX|scale)\s*:/.test(call);
  return isSpine && linear && alongAxis;
}

function fullRuntimeSpatialTweens(file: string, source: string) {
  const code = maskNonCode(source);
  const durationNames = new Set(["TOTAL"]);
  for (const match of code.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:(?:Number\.)?parseFloat\s*\(\s*)?[^;\n]*?\.dataset\.duration\b/gi,
  )) {
    if (match[1]) durationNames.add(match[1]);
  }

  const timelineNames = new Set(["timeline"]);
  for (const match of code.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:window\.)?gsap\.timeline\s*\(/g,
  )) {
    if (match[1]) timelineNames.add(match[1]);
  }

  const receivers = ["gsap", ...timelineNames].map(escapeRegex).join("|");
  const calls = new RegExp(`\\b(?:${receivers})\\s*\\.\\s*(?:to|fromTo)\\s*\\(`, "g");
  const duration = new RegExp(
    `\\bduration\\s*:\\s*(?:${[...durationNames].map(escapeRegex).join("|")})\\b`,
  );
  const spatial = /\b(?:x|y|scale|scaleX|scaleY|rotation)\s*:/;
  const offenders: {file: string; number: number; excerpt: string}[] = [];

  for (const match of code.matchAll(calls)) {
    const start = match.index ?? 0;
    const end = balancedCallEnd(code, code.indexOf("(", start));
    const call = code.slice(start, end);
    if (!duration.test(call) || !spatial.test(call)) continue;
    // The unmasked slice, because the readout test reads the target selector — and
    // `maskNonCode` blanks string literals, which is where a selector lives.
    if (isProgressReadout(source.slice(start, end))) continue;
    offenders.push({
      file,
      number: source.slice(0, start).split("\n").length,
      excerpt: source.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 220),
    });
  }
  return offenders;
}

function balancedCallEnd(source: string, opening: number): number {
  if (opening < 0) return source.length;
  let depth = 0;
  for (let index = opening; index < source.length; index++) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return source.length;
}

/** Preserve offsets and newlines while hiding strings/comments from source-pattern checks. */
function maskNonCode(source: string): string {
  const chars = [...source];
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  let escaped = false;
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index] ?? "";
    const next = chars[index + 1] ?? "";
    if (state === "code") {
      if (char === "/" && next === "/") state = "line";
      else if (char === "/" && next === "*") state = "block";
      else if (char === "'") state = "single";
      else if (char === '"') state = "double";
      else if (char === "`") state = "template";
      else continue;
    } else if (state === "line" && char === "\n") {
      state = "code";
      continue;
    } else if (state === "block" && char === "*" && next === "/") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 1;
      state = "code";
      continue;
    } else if ((state === "single" && char === "'")
      || (state === "double" && char === '"')
      || (state === "template" && char === "`")) {
      if (!escaped) state = "code";
    }

    if (char !== "\n") chars[index] = " ";
    escaped = state !== "code" && char === "\\" && !escaped;
    if (char !== "\\") escaped = false;
  }
  return chars.join("");
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
  // The plan is the authority for this value, so the correct literal is known here in both
  // branches. Carrying it as `expected` is what lets a fixer write it without a model.
  const expected = (expectedMs / 1000).toFixed(3);

  if (value === null) {
    findings.push({
      severity: "error",
      code: "missing_timing",
      message: `scene-${sectionId} is missing ${attributeName}.`,
      source: "plan",
      file: "index.html",
      elementId: `scene-${sectionId}`,
      sectionId,
      attribute: attributeName,
      expected,
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
      file: "index.html",
      elementId: `scene-${sectionId}`,
      sectionId,
      attribute: attributeName,
      expected,
    });
  }
}

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

/**
 * How much text a scene puts on screen that the plan never asked for.
 *
 * Density was the thing this studio was short of, so the metric added to chase it counts
 * elements — and the cheapest element in HTML is a word in a `<span>`. On run 0600 the
 * composition beat the density target for the first time, at 19 elements in its thinnest
 * scene, and the first person to watch it called it busy and hard to read. Counting again
 * by text run rather than element told the real story: 12.2 runs per scene against the
 * approved exemplar's 8.0. It had cleared the bar by writing labels.
 *
 * So the ceiling is set from what the approved work does, not from a round number. Only text
 * the plan did not supply is counted — a scene may render its `onScreen` line, its data
 * labels, its caption and its unit as freely as it likes, and none of that is charged here.
 * What is charged is `SPEED / JUDGMENT`, `THE TEST`, `EDGE CASE`, `POINT OF VIEW`: eyebrows,
 * tickers and chips that no one wrote and no one reads.
 *
 * Warning rather than error, in line with the plan's promote-after-two-runs rule, and because
 * this is the one finding here that judges rather than verifies. A composition can be dense
 * and readable; the count cannot tell which. What it can do is refuse to let "busy" be
 * invisible in the log again.
 *
 * Measured per scene, distinct: the approved exemplar runs [5, 6, 4, 6, 3, 0] and the approved
 * dba07c the same; the accepted Terra run [4, 3, 3, 2, 4, 2]; the busy run [8, 6, 5, 6, 6, 3].
 * Seven rather than six on purpose — six is exactly the approved peak, and a ceiling sitting
 * on the shoulder of the work it is meant to permit fails the next composition that writes
 * one more chip. Seven still catches the scene that prompted this, which is the whole job.
 */
const INVENTED_TEXT_PER_SCENE = 7;

export async function checkInventedText(dir: string, plan: VideoPlan): Promise<CheckFinding[]> {
  const html = await fs.readFile(path.join(dir, "index.html"), "utf8").catch(() => "");
  const css = await fs.readFile(path.join(dir, "styles.css"), "utf8").catch(() => "");
  if (!html.trim()) return [];
  const hidden = visuallyHiddenClasses(css);
  const findings: CheckFinding[] = [];

  for (const section of plan.sections) {
    const element = extractElement(html, `scene-${section.id}`);
    if (!element) continue;

    // Everything the plan put at this scene's disposal, as one haystack. Matching a run
    // against the whole string rather than a list of fields is deliberate: compositions
    // split a headline across spans — "Shipping is not" / "authorship" — and each fragment
    // has to read as supplied, not as two inventions.
    const supplied = normalise([
      section.onScreen,
      section.data?.caption ?? "",
      section.data?.unit ?? "",
      ...(section.data?.points ?? []).flatMap((point) => [point.label, String(point.value)]),
    ].join(" "));

    // Distinct text, not every occurrence. The first cut of this counted each run and fired
    // on the approved exemplar, for a row of five `POST` chips and a Mon/Wed/Fri strip — the
    // repeated sets that are the exemplar's whole method and the reason its scenes read as
    // designed rather than listed. Five copies of one word is one decision. Five different
    // words is five, and that is the thing worth counting.
    const invented = [...new Set(
      [...removeHiddenElements(element.inner, hidden).matchAll(/>([^<>]+)</g)]
        .map((match) => normalise(match[1] ?? ""))
        // A lone digit or bullet is punctuation with a tag around it, not a label. Counters
        // legitimately render "0" and tick up, and the plan's figure lives in that span.
        .filter((run) => run.replace(/[^a-z]/g, "").length > 1)
        .filter((run) => !supplied.includes(run)),
    )];

    if (invented.length > INVENTED_TEXT_PER_SCENE) {
      findings.push({
        severity: "warning",
        code: "scene_text_crowded",
        message:
          `scene-${section.id} renders ${invented.length} pieces of text the plan did not ask `
          + `for (the ceiling is ${INVENTED_TEXT_PER_SCENE}): `
          + `${invented.slice(0, 6).map((run) => `"${run}"`).join(", ")}`
          + `${invented.length > 6 ? ", …" : ""}.`,
        fixHint:
          "Cut the labels that only restate the scene. Density should come from structure — "
          + "layered fields, rules, plates, repeated sets — not from more words on the frame.",
        source: "plan",
        file: "index.html",
        elementId: `scene-${section.id}`,
        sectionId: section.id,
      });
    }
  }

  return findings;
}

export function formatFindings(report: CheckReport, limit = 12): string {
  return report.findings
    .filter((finding) => finding.severity !== "info")
    .slice(0, limit)
    .map((finding) => `  [${finding.severity}] ${finding.message}`)
    .join("\n");
}
