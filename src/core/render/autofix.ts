import fs from "node:fs/promises";
import path from "node:path";
import {
  addClassToElement,
  attribute,
  extractElement,
  insertIntoElement,
  setElementAttribute,
} from "../compose/html.ts";
import type {AuthoringDir} from "../compose/workdir.ts";
import {REQUIRED_STYLESHEETS, type CheckFinding, type CheckReport, type CompositionFile} from "./check.ts";

/**
 * Repairs that need a regex, not a model session.
 *
 * Measured across twelve runs, five repair rounds returned a byte-identical composition and
 * most of the rest changed six to twenty-two lines. One entire round was spent adding a
 * missing `id` and stripping a `./` from an image path. Those are not judgement calls, and
 * paying minutes of model latency for them is the single largest avoidable cost in a run.
 *
 * What is deliberately *not* here matters as much as what is. A fixer that has to choose
 * wording, placement or a design asset is not mechanical, and a plausible-looking guess
 * trades one finding for another the checker will not catch. Those stay with the composer.
 */

export const COMPOSITION_FILES = ["index.html", "styles.css", "animation.js"] as const;

export type CompositionFiles = Record<CompositionFile, string>;

export interface FixContext {
  authoring: AuthoringDir;
}

/** Returns the edited files, or null to decline — declining is a first-class outcome. */
type Fixer = (
  files: CompositionFiles,
  finding: CheckFinding,
  context: FixContext,
) => CompositionFiles | null;

const edit = (
  files: CompositionFiles,
  file: CompositionFile,
  body: string,
): CompositionFiles | null => (files[file] === body ? null : {...files, [file]: body});

/** Both timing codes carry the element, the attribute and the literal to write. */
const fixTiming: Fixer = (files, finding) => {
  if (!finding.elementId || !finding.attribute || finding.expected === undefined) return null;
  return edit(
    files,
    "index.html",
    setElementAttribute(files["index.html"], finding.elementId, finding.attribute, finding.expected),
  );
};

const FIXERS: Partial<Record<string, Fixer>> = {
  timing_drift: fixTiming,
  missing_timing: fixTiming,

  scene_not_clip: (files, finding) => {
    if (!finding.elementId) return null;
    return edit(files, "index.html", addClassToElement(files["index.html"], finding.elementId, "clip"));
  },

  // The real `53e128` repair: the rail existed but carried no id, so the lockup had nowhere
  // to go. Both halves are determined once the finding names the field-appropriate asset.
  canonical_lockup_missing_rail: (files, finding) => {
    if (!finding.expected) return null;
    let html = files["index.html"];
    if (!html.includes('id="brand-rail"')) {
      const opener = /<([a-z][\w-]*)\b([^>]*\bclass="[^"]*\bbrand-rail\b[^"]*"[^>]*)>/i.exec(html);
      if (!opener) return null;
      html = html.slice(0, opener.index)
        + `<${opener[1]} id="brand-rail"${opener[2]}>`
        + html.slice(opener.index + opener[0].length);
    }
    const rail = extractElement(html, "brand-rail");
    if (!rail) return null;
    // Never stack a second lockup on top of one that is already there.
    if (/<img\b[^>]*\bclass="[^"]*\brail-lockup\b/i.test(rail.inner)) {
      return edit(files, "index.html", html);
    }
    return edit(files, "index.html", insertIntoElement(html, "brand-rail", finding.expected, "prepend"));
  },

  // A spaced en-dash is explicitly permitted by the same rule that forbids the em-dash.
  // Choosing a comma or a full stop instead would be rewriting the sentence.
  em_dash: (files) => edit(files, "index.html", files["index.html"].replaceAll("—", "–")),

  data_bar_proportion: (files, finding) => {
    if (!finding.expected || !finding.snippet) return null;
    const target = JSON.parse(finding.expected) as {value: number; max: number; fill: number};
    const fixed = finding.snippet
      .replace(/\sdata-max="[^"]*"/, ` data-max="${target.max}"`)
      .replace(/(--fill\s*:\s*)[^;"]*/, `$1${target.fill}`);
    if (fixed === finding.snippet || !files["index.html"].includes(finding.snippet)) return null;
    return edit(files, "index.html", files["index.html"].replace(finding.snippet, fixed));
  },

  root_missing_composition_id: (files, _finding, {authoring}) => {
    const root = /<div\b[^>]*\bid="stage"/i.test(files["index.html"]) ? "stage" : null;
    if (!root) return null;
    return edit(
      files,
      "index.html",
      setElementAttribute(files["index.html"], root, "data-composition-id", authoring.compositionId),
    );
  },

  timed_element_missing_clip_class: (files, finding) => {
    if (!finding.elementId) return null;
    return edit(files, "index.html", addClassToElement(files["index.html"], finding.elementId, "clip"));
  },

  // Exactly one narration element with the known source has exactly one correct id.
  media_missing_id: (files) => {
    const audio = [...files["index.html"].matchAll(/<audio\b[^>]*>/gi)].map((match) => match[0]);
    const only = audio.length === 1 ? audio[0] : undefined;
    if (!only || attribute(only, "id") !== null) return null;
    if (!/narration\.m4a/.test(attribute(only, "src") ?? "")) return null;
    return edit(
      files,
      "index.html",
      files["index.html"].replace(only, only.replace(/^<audio\b/i, '<audio id="narration"')),
    );
  },

  self_closing_media_tag: (files) => edit(
    files,
    "index.html",
    files["index.html"].replace(/<(audio|video)\b([^>]*?)\s*\/>/gi, "<$1$2></$1>"),
  ),

  video_missing_muted: (files) => edit(
    files,
    "index.html",
    files["index.html"].replace(
      /<video\b(?![^>]*\bmuted\b)([^>]*)>/gi,
      "<video muted$1>",
    ),
  ),

  media_preload_none: (files) => edit(
    files,
    "index.html",
    files["index.html"].replace(/(<(?:audio|video)\b[^>]*?)\spreload="none"/gi, '$1 preload="auto"'),
  ),

  // Both link findings have the same remedy and the same determined answer: the canonical
  // set, in `REQUIRED_STYLESHEETS` order. Nothing here is a design call — which sheets and
  // in what order is fixed by the framework, not by the composition.
  missing_stylesheet_link: fixStylesheetLinks,
  stylesheet_link_order: fixStylesheetLinks,

  missing_gsap_script: (files) => {
    const html = files["index.html"];
    if (/vendor\/gsap\.min\.js/.test(html)) return null;
    const animation = /<script\b[^>]*\bsrc="\.?\/?animation\.js"[^>]*>\s*<\/script>/i.exec(html);
    if (!animation) return null;
    // The vendored copy, never the CDN the upstream hint suggests: the render is offline.
    return edit(
      files,
      "index.html",
      html.slice(0, animation.index)
        + '<script src="./vendor/gsap.min.js"></script>\n    '
        + html.slice(animation.index),
    );
  },
};

/**
 * Lift out every required stylesheet link and re-lay them as one canonical block.
 *
 * Rewriting rather than nudging: a missing sheet and a mis-ordered set are the same defect
 * seen from two sides, and reconstructing the block answers both without a positional edit
 * that would have to reason about what is already there. Links the composition added for
 * itself are left where they are — they are not this fixer's business.
 */
function fixStylesheetLinks(files: CompositionFiles): CompositionFiles | null {
  const html = files["index.html"];
  const required = new Set<string>(REQUIRED_STYLESHEETS);
  const links = [...html.matchAll(/[ \t]*<link\b[^>]*\bhref="([^"]+)"[^>]*>\n?/gi)]
    .filter((match) => required.has(match[1]!));

  // Removed back to front so the earlier offsets stay valid.
  let stripped = html;
  for (const link of [...links].reverse()) {
    stripped = stripped.slice(0, link.index) + stripped.slice(link.index + link[0].length);
  }
  // The first removed link's offset survives the strip — everything before it is untouched.
  // With nothing to remove, the block goes at the end of <head>.
  const at = links[0]?.index ?? stripped.indexOf("</head>");
  if (at < 0) return null;

  const block = REQUIRED_STYLESHEETS
    .map((sheet) => `  <link rel="stylesheet" href="${sheet}" />\n`)
    .join("");
  return edit(files, "index.html", stripped.slice(0, at) + block + stripped.slice(at));
}

/**
 * `./media/x.png` and `media/x.png` resolve identically in a browser, but the checker's
 * asset rule rejects the prefixed form. Restricted to `media/` on purpose: BRIEF.md mandates
 * `./tokens.css`, `./blocks/*`, `./vendor/gsap.min.js` and `./narration.m4a`, so a blanket
 * strip would break four things to fix one.
 */
function normaliseMediaPaths(files: CompositionFiles): CompositionFiles | null {
  const html = files["index.html"].replace(/\b(src|href)="\.\/(media\/)/g, '$1="$2');
  return edit(files, "index.html", html);
}

export interface AutoFixResult {
  /** Finding codes whose fixes were applied and verified. */
  applied: string[];
  /** The report after fixing — the original one when nothing was accepted. */
  report: CheckReport;
}

/** Missing reads as empty: an attempt that died before writing is a state, not a crash. */
async function readFiles(dir: string): Promise<CompositionFiles> {
  const entries = await Promise.all(COMPOSITION_FILES.map(async (file) => [
    file,
    await fs.readFile(path.join(dir, file), "utf8").catch(() => ""),
  ] as const));
  return Object.fromEntries(entries) as CompositionFiles;
}

async function writeFiles(dir: string, files: CompositionFiles) {
  await Promise.all(COMPOSITION_FILES.map((file) =>
    fs.writeFile(path.join(dir, file), files[file], "utf8")));
}

/** Applies every fixer that will act, in a stable order. Pure; touches no disk. */
export function applyFixers(
  files: CompositionFiles,
  findings: readonly CheckFinding[],
  context: FixContext,
): {files: CompositionFiles; applied: string[]} {
  let current = files;
  const applied: string[] = [];

  // Sorted by code so a run is reproducible regardless of the order the gates emitted in.
  const ordered = [...findings]
    .filter((finding) => finding.severity === "error" && finding.code)
    .sort((a, b) => (a.code ?? "").localeCompare(b.code ?? ""));

  for (const finding of ordered) {
    const fixer = FIXERS[finding.code as string];
    if (!fixer) continue;
    const next = fixer(current, finding, context);
    if (!next) continue;
    current = next;
    applied.push(finding.code as string);
  }

  // Rides along with a real repair; never causes one.
  //
  // This used to run first and unconditionally, and the first live run showed the cost:
  // eleven layout errors, none of them mechanical, no fixer willing to act — but a stray
  // `./media/` prefix meant the batch looked non-empty, so the pass wrote the files and
  // spent a full verification check (63s on that run) only to revert everything. A cosmetic
  // normalisation is not worth a checker pass on its own.
  if (applied.length) {
    const normalised = normaliseMediaPaths(current);
    if (normalised) {
      current = normalised;
      applied.push("media_path_prefix");
    }
  }

  return {files: current, applied};
}

/**
 * Fix what can be fixed deterministically, then prove it with the same checker that raised
 * the findings.
 *
 * The acceptance rule is deliberately strict and applied to the batch as a whole. A fix that
 * removes one error while introducing a different one has not helped — it has moved the
 * problem somewhere the composer now has to discover. Rolling the whole batch back on any
 * new code costs one verification pass; bisecting to find the guilty fixer would cost one
 * per fixer, against a saving measured in whole model sessions.
 */
export async function autoFix(options: {
  dir: string;
  authoring: AuthoringDir;
  report: CheckReport;
  check: () => Promise<CheckReport>;
  log?: (line: string) => void;
  /** Guards against two fixers undoing each other indefinitely. */
  maxRounds?: number;
}): Promise<AutoFixResult> {
  const {dir, authoring, check, log, maxRounds = 2} = options;
  let report = options.report;
  const applied: string[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const snapshot = await readFiles(dir);
    const attempt = applyFixers(snapshot, report.findings, {authoring});
    if (!attempt.applied.length) break;

    await writeFiles(dir, attempt.files);
    const verified = await check();

    const known = new Set(
      report.findings.filter((f) => f.severity === "error").map((f) => f.code ?? "issue"),
    );
    const introduced = verified.findings
      .filter((f) => f.severity === "error" && !known.has(f.code ?? "issue"))
      .map((f) => f.code ?? "issue");

    const improved = verified.errorCount < report.errorCount
      && introduced.length === 0
      && verified.warningCount <= report.warningCount;

    if (!improved) {
      // Byte-exact restore. The composer must see the composition it produced, and the
      // report that describes it, not a half-repaired file it never wrote.
      await writeFiles(dir, snapshot);
      log?.(
        `auto-fix      reverted ${attempt.applied.length} fix(es); `
        + `${introduced.length ? `introduced ${[...new Set(introduced)].join(", ")}` : "no net improvement"}`,
      );
      break;
    }

    applied.push(...attempt.applied);
    log?.(
      `auto-fix      ${attempt.applied.length} fix(es) applied · `
      + `${report.errorCount} → ${verified.errorCount} error(s) · ${[...new Set(attempt.applied)].join(", ")}`,
    );
    report = verified;
    if (report.ok) break;
  }

  return {applied, report};
}
