import fs from "node:fs/promises";
import path from "node:path";
import {DATA_DIR, ROOT, rel} from "../src/core/paths.ts";

/**
 * Error geography — where on the stage do layout check findings actually happen?
 *
 * Written to test one question for the region-contract plan (docs/template-system-plan.md):
 * the plan pins only the FRAME (masthead / foot / rail / caption band) and leaves the MIDDLE
 * free, on the strength of docs/region-evidence.md showing the corpus shares a frame and not a
 * middle. That is a claim about *shared structure*. It says nothing yet about where *layout
 * check failures* land. This script measures that, from the studio's own run transcripts.
 *
 * Two independent things are checked and never merged into one number:
 *
 *  1. The canonical check-log line, exactly as `check.ts`'s underlying checker emits it and as
 *     the studio prints it to the thread transcript:
 *       `[error] layout: <message>. at <T>s at x=<X>, y=<Y>, <W>×<H>`
 *     This is the ONLY form that carries pixel geometry. It is searched for across every
 *     `data/threads/*.json` (role: "event", field: "text").
 *
 *  2. A second, unrelated logging path: when a composition fails and a repair sub-agent is
 *     spawned, the studio hands it a "Findings:" list that names a CSS *selector* per finding
 *     instead of a pixel rect (`(selector: p.kicker.on-light)`). No coordinates, but a class
 *     name is itself a location once cross-referenced against docs/region-evidence.json, which
 *     already measured where classes like `kicker`, `folio`, `caption-page` and `word` actually
 *     sit on a rendered stage. This population is small, drawn from only two threads, and
 *     dominated by one video's repeated repair attempts — it is reported as supplementary
 *     evidence, explicitly labelled non-representative, never averaged into population 1.
 *
 * Zone boundaries are not hand-picked: they are computed at run time from the measured element
 * rects already sitting in docs/region-evidence.json (read-only; this script never writes to
 * that file). Re-running `npm run regions:evidence` first will shift the boundaries here too,
 * by design — the two scripts share one source of ground truth for "what is frame."
 *
 * Deterministic: same threads, same evidence file, same numbers. No network, no randomness.
 */

const THREADS_DIR = path.join(DATA_DIR, "threads");
const REGION_EVIDENCE_JSON = path.join(ROOT, "docs", "region-evidence.json");
const MD_OUT = path.join(ROOT, "docs", "error-geography.md");

// -------------------------------------------------------------------------------------------
// Reading region-evidence.json for zone boundaries (read-only — never written to)
// -------------------------------------------------------------------------------------------

interface MeasuredElement {
  classes: string[];
  rect: [number, number, number, number]; // [x, y, w, h] normalised 0..1
  category: "content" | "chrome" | "wrapper";
}

interface RegionEvidence {
  gutter: {min: number; max: number; average: number};
  elements: MeasuredElement[];
}

interface Band {
  top: number;
  bottom: number;
}

interface ZoneBoundaries {
  /** Elements whose x-center sits left of this are the reserved brand-rail lane. */
  railBoundary: number;
  /** Elements whose y-center sits above this are the masthead (kicker / section-number) band. */
  mastheadBottom: number;
  /** One or more y-bands where the folio ("foot line") lockup was actually measured. */
  footBands: Band[];
  /** The reserved caption band, measured from caption-page / word rects. */
  captionBand: Band;
  /** Class names counted as frame chrome for the selector-based classification, by zone. */
  classToZone: Record<string, "rail" | "masthead" | "foot" | "caption">;
}

function boundsForClass(elements: MeasuredElement[], className: string): Band | null {
  const rows = elements.filter((e) => e.classes.includes(className));
  if (rows.length === 0) return null;
  const tops = rows.map((e) => e.rect[1]);
  const bottoms = rows.map((e) => e.rect[1] + e.rect[3]);
  return {top: Math.min(...tops), bottom: Math.max(...bottoms)};
}

/** Groups sorted y-values into bands, splitting wherever a gap exceeds `gapThreshold`. */
function clusterBands(elements: MeasuredElement[], className: string, gapThreshold = 0.1): Band[] {
  const rows = elements.filter((e) => e.classes.includes(className));
  if (rows.length === 0) return [];
  const intervals = rows.map((e): Band => ({top: e.rect[1], bottom: e.rect[1] + e.rect[3]}));
  intervals.sort((a, b) => a.top - b.top);
  const bands: Band[] = [];
  for (const interval of intervals) {
    const last = bands.at(-1);
    if (last && interval.top - last.bottom <= gapThreshold) {
      last.bottom = Math.max(last.bottom, interval.bottom);
    } else {
      bands.push({...interval});
    }
  }
  return bands;
}

async function loadZoneBoundaries(): Promise<ZoneBoundaries> {
  const raw = await fs.readFile(REGION_EVIDENCE_JSON, "utf8");
  const evidence = JSON.parse(raw) as RegionEvidence;
  const els = evidence.elements;

  // Rail lane: the reserved left gutter, read from computed padding-left across the corpus
  // (docs/region-evidence.md §1). Use the narrower of the two measured values (0.062) so the
  // zone stays a strict, conservative "inside the rail chrome" test rather than a generous one.
  const railBoundary = evidence.gutter.min;

  // Masthead: every class that region-evidence.md documents as the top band (kicker,
  // section-number) or as dropped rail/masthead chrome (brand-seal, rail-rule) that sits near
  // the top of the stage. Boundary is the deepest measured bottom edge across all of them.
  const mastheadClasses = ["kicker", "section-number", "brand-seal", "rail-rule"];
  const mastheadBottoms = mastheadClasses
    .map((c) => boundsForClass(els, c))
    .filter((b): b is Band => b !== null)
    .map((b) => b.bottom);
  const mastheadBottom = mastheadBottoms.length > 0 ? Math.max(...mastheadBottoms) : 0.16;

  // Foot: the "folio" lockup. Bimodal in the measured corpus — most scenes carry it around
  // y≈0.69, outro scenes carry it near the true bottom (y≈0.95). Both are the same semantic
  // element (the foot line), so both bands count as FOOT.
  const footBands = clusterBands(els, "folio");

  // Caption band: measured directly from caption-page / word rects.
  const captionTops = ["caption-page", "word"]
    .map((c) => boundsForClass(els, c))
    .filter((b): b is Band => b !== null);
  const captionBand: Band =
    captionTops.length > 0
      ? {top: Math.min(...captionTops.map((b) => b.top)), bottom: Math.max(...captionTops.map((b) => b.bottom))}
      : {top: 0.73, bottom: 0.88};

  const classToZone: ZoneBoundaries["classToZone"] = {
    kicker: "masthead",
    "section-number": "masthead",
    "brand-seal": "masthead",
    "rail-rule": "masthead",
    folio: "foot",
    "brand-rail": "rail",
    "rail-lockup": "rail",
    "signal-spine": "rail",
    "spine-line": "rail",
    "spine-node": "rail",
    "caption-page": "caption",
    word: "caption",
  };

  return {railBoundary, mastheadBottom, footBands, captionBand, classToZone};
}

// -------------------------------------------------------------------------------------------
// Population 1: canonical `[severity] layout: message[. at Ts at x=,y=,WxH]` lines
// -------------------------------------------------------------------------------------------

type Zone = "rail" | "masthead" | "foot" | "caption" | "middle";
type Severity = "error" | "warning";

interface DirectFinding {
  source: string; // thread file basename
  severity: Severity;
  message: string;
  hasCoords: boolean;
  t?: number;
  rect?: [number, number, number, number]; // normalised x, y, w, h
}

const DIRECT_HEAD_RE = /^\[(error|warning)\]\s+layout:\s*(.*)$/;
const COORD_TAIL_RE =
  /^(.*?)\s+at\s+([\d.]+)s\s+at\s+x=(-?[\d.]+),\s*y=(-?[\d.]+),\s*(-?[\d.]+)[×x](-?[\d.]+)\s*$/;

interface ThreadFile {
  id: string;
  videoId: string | null;
  title: string | null;
  messages: {role: string; text?: unknown}[];
}

async function loadThreadFiles(): Promise<{name: string; thread: ThreadFile}[]> {
  const entries = await fs.readdir(THREADS_DIR, {withFileTypes: true});
  const files = entries.filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => e.name).sort();
  const out: {name: string; thread: ThreadFile}[] = [];
  for (const name of files) {
    const raw = await fs.readFile(path.join(THREADS_DIR, name), "utf8");
    out.push({name, thread: JSON.parse(raw) as ThreadFile});
  }
  return out;
}

function extractDirectFindings(threadFiles: {name: string; thread: ThreadFile}[]): {
  layout: DirectFinding[];
  otherCategoryLines: number;
} {
  const layout: DirectFinding[] = [];
  let otherCategoryLines = 0;
  const anyBracketRe = /^\[(error|warning)\]\s+([a-zA-Z][a-zA-Z_-]*)\s*:\s*(.*)$/;

  for (const {name, thread} of threadFiles) {
    for (const message of thread.messages) {
      if (message.role !== "event") continue;
      const text = message.text;
      if (typeof text !== "string") continue;
      for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        const bracket = anyBracketRe.exec(line);
        if (!bracket) continue;
        const [, , category] = bracket;
        if (category !== "layout") {
          otherCategoryLines++;
          continue;
        }
        const head = DIRECT_HEAD_RE.exec(line);
        if (!head) continue; // shouldn't happen given the category check above
        const [, sev, rest] = head;
        const severity = sev as Severity;
        const coordMatch = COORD_TAIL_RE.exec(rest ?? "");
        if (coordMatch) {
          const [, message_, t, x, y, w, h] = coordMatch;
          layout.push({
            source: name,
            severity,
            message: message_ ?? "",
            hasCoords: true,
            t: Number(t),
            rect: [Number(x) / 1080, Number(y) / 1920, Number(w) / 1080, Number(h) / 1920],
          });
        } else {
          layout.push({source: name, severity, message: (rest ?? "").trim(), hasCoords: false});
        }
      }
    }
  }
  return {layout, otherCategoryLines};
}

function zoneForRect(rect: [number, number, number, number], b: ZoneBoundaries): Zone {
  const [x, y, w, h] = rect;
  const xCenter = x + w / 2;
  const yCenter = y + h / 2;
  if (xCenter < b.railBoundary) return "rail";
  if (yCenter < b.mastheadBottom) return "masthead";
  for (const band of b.footBands) {
    if (yCenter >= band.top && yCenter <= band.bottom) return "foot";
  }
  if (yCenter >= b.captionBand.top && yCenter <= b.captionBand.bottom) return "caption";
  return "middle";
}

/** The plan's four-way taxonomy (docs/template-system-plan.md §1), plus what it leaves out. */
function planCategory(message: string): "overlap" | "occlusion" | "overflow" | "rotation" | "other" {
  const m = message.toLowerCase();
  if (m.includes("overlap")) return "overlap";
  if (m.includes("hidden beneath")) return "occlusion";
  if (m.includes("extends outside") || m.includes("clipping layout container")) return "overflow";
  if (m.includes("spinning") || m.includes("rotat")) return "rotation";
  return "other";
}

// -------------------------------------------------------------------------------------------
// Population 2: selector-bearing "Findings:" lines handed to repair sub-agents
// -------------------------------------------------------------------------------------------

interface SelectorFinding {
  source: string;
  catId: string;
  message: string;
  selector: string;
  complete: boolean; // false = selector text was cut off before its closing paren
}

const SELECTOR_RE = /\[(error|warning|info)\]\s+([a-zA-Z_]+):\s*layout:\s*([^(]+?)\s*\(selector:\s*(.*)$/;

function extractSelectorFindings(threadFiles: {name: string; thread: ThreadFile}[]): SelectorFinding[] {
  const out: SelectorFinding[] = [];
  for (const {name, thread} of threadFiles) {
    for (const message of thread.messages) {
      if (message.role !== "event") continue;
      const text = message.text;
      if (typeof text !== "string") continue;
      for (const rawLine of text.split("\n")) {
        const m = SELECTOR_RE.exec(rawLine);
        if (!m) continue;
        const [, , catId, msg, selRaw] = m;
        let sel = (selRaw ?? "").trim();
        const complete = sel.endsWith(")");
        if (complete) sel = sel.slice(0, -1);
        out.push({source: name, catId: catId!, message: (msg ?? "").trim(), selector: sel, complete});
      }
    }
  }
  return out;
}

/** category_id -> canonical severity, reconciled against population 1's own severities for the
 * matching message text (this prompt format sometimes labels the same message "info" in one
 * place and "error" in another — a print-context artifact, not a checker severity change). */
const SELECTOR_CATEGORY_SEVERITY: Record<string, Severity> = {
  text_occluded: "error", // == "Text is hidden beneath an opaque element." (always error, pop. 1)
  content_overlap: "error", // == "Two text blocks overlap and may render unreadable." (always error)
  text_box_overflow: "error", // == "Text extends outside its nearest visual/container box." (always error)
  canvas_overflow: "warning", // == "Text extends outside the composition canvas." (always warning)
  container_overflow: "warning", // == "Element extends outside a clipping layout container." (always warning)
  panel_out_of_canvas: "warning", // == "Painted panel extends outside the composition canvas." (always warning)
};

function leafClass(selector: string): string {
  const classMatch = /^[a-zA-Z0-9]*\.([a-zA-Z0-9_-]+)/.exec(selector);
  if (classMatch?.[1]) return classMatch[1];
  const idMatch = /^#([a-zA-Z0-9_-]+)/.exec(selector);
  if (idMatch?.[1]) return `#${idMatch[1]}`;
  return selector.split(/\s/)[0] ?? selector;
}

function zoneForClass(cls: string, b: ZoneBoundaries): Zone {
  return b.classToZone[cls] ?? "middle";
}

// -------------------------------------------------------------------------------------------
// Report assembly
// -------------------------------------------------------------------------------------------

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`;
}

function fmtRect(rect: [number, number, number, number]): string {
  return `[${rect.map((v) => v.toFixed(3)).join(", ")}]`;
}

async function main() {
  const threadFiles = await loadThreadFiles();
  const boundaries = await loadZoneBoundaries();
  const {layout: direct, otherCategoryLines} = extractDirectFindings(threadFiles);
  const selectorRaw = extractSelectorFindings(threadFiles);
  const selectorComplete = selectorRaw.filter((f) => f.complete);

  const directWithCoords = direct.filter((f) => f.hasCoords);
  const directWithoutCoords = direct.filter((f) => !f.hasCoords);
  const directErrors = direct.filter((f) => f.severity === "error");
  const directWarnings = direct.filter((f) => f.severity === "warning");

  // Zone classification, population 1 (rect-based, only the 3 findings that carry one).
  const zoned1 = directWithCoords.map((f) => ({...f, zone: zoneForRect(f.rect!, boundaries)}));

  // Zone classification, population 2 (class-based, only complete selectors).
  const zoned2 = selectorComplete.map((f) => {
    const cls = leafClass(f.selector);
    const severity = SELECTOR_CATEGORY_SEVERITY[f.catId] ?? "warning";
    return {...f, cls, severity, zone: zoneForClass(cls, boundaries)};
  });

  // Plan-taxonomy tally across the whole available corpus (population 1 — the only form that
  // matches the plan's exact message wording without guesswork).
  const planTally = new Map<string, {error: number; warning: number}>();
  for (const f of direct) {
    const cat = planCategory(f.message);
    const row = planTally.get(cat) ?? {error: 0, warning: 0};
    row[f.severity]++;
    planTally.set(cat, row);
  }

  // Message x severity breakdown (population 1).
  const msgTally = new Map<string, {error: number; warning: number; sources: Set<string>}>();
  for (const f of direct) {
    const row = msgTally.get(f.message) ?? {error: 0, warning: 0, sources: new Set<string>()};
    row[f.severity]++;
    row.sources.add(f.source);
    msgTally.set(f.message, row);
  }

  // Luna-run verification: do the two cited 2026-08-05 threads exist at all?
  const threadDateRanges = threadFiles.map(({name, thread}) => {
    const dates = thread.messages
      .map((m) => (m as {at?: string}).at)
      .filter((d): d is string => typeof d === "string")
      .map((d) => d.slice(0, 10))
      .sort();
    return {name, first: dates[0] ?? null, last: dates.at(-1) ?? null};
  });
  const hasAug05Thread = threadDateRanges.some((r) => r.last === "2026-08-05" || r.first === "2026-08-05");
  const lunaSlugMentioned = threadFiles.some(({thread}) =>
    JSON.stringify(thread.messages).includes("authorship-starts-early") ||
    JSON.stringify(thread.messages).includes("speed-authorship"),
  );
  const rotationMentions = direct.filter((f) => planCategory(f.message) === "rotation").length;

  // -----------------------------------------------------------------------------------------
  // Markdown
  // -----------------------------------------------------------------------------------------

  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  push("# Error geography — where do layout check failures land on the stage?");
  push();
  push(
    "Generated by `npm run errors:geography` (`scripts/error-geography.ts`). Deterministic — " +
      "same threads, same `docs/region-evidence.json`, same numbers. Reads `data/threads/*.json` " +
      "and `docs/region-evidence.json`; writes only this file.",
  );
  push();
  push(
    "**Question:** the region-contract plan pins only the FRAME (masthead / foot / rail / " +
      "caption band) and leaves the MIDDLE free, on the strength of measurement showing the " +
      "corpus shares a frame and not a middle. Does that also describe where layout check " +
      "*failures* happen — or do they happen in the middle, where a frame-only contract has no " +
      "reach?",
  );
  push();

  push("## 1. What was found, and what had to be discarded");
  push();
  push(
    "Two unrelated logging shapes carry layout check findings in `data/threads/*.json`. They " +
      "are reported separately below and never merged into one count.",
  );
  push();
  push("### 1a. Canonical check-log lines (the form this brief was written against)");
  push();
  push(
    "Pattern: `[error|warning] layout: <message>` optionally followed by `. at <T>s at " +
      "x=<X>, y=<Y>, <W>×<H>`. Searched across every thread's `role: \"event\"` messages.",
  );
  push();
  push(`- Total layout findings found: **${direct.length}** (${directErrors.length} error, ${directWarnings.length} warning)`);
  push(`- Findings carrying pixel geometry (\`at Ts at x=,y=,WxH\`): **${directWithCoords.length}**`);
  push(`- Discarded for zone classification — message and severity known, geometry absent: **${directWithoutCoords.length}**`);
  push(
    `- Non-layout \`[error]\`/\`[warning]\` lines seen in the same scan (runtime, contrast, lint, ` +
      `etc.), set aside as out of scope: ${otherCategoryLines}`,
  );
  push();
  push(
    `Every geometry-bearing finding in the entire corpus (${directWithCoords.length} of ${direct.length}, ` +
      `${pct(directWithCoords.length, direct.length)}) comes from a single thread/video: ` +
      "`t-3f1ab696.json` (video `2026-08-01-consistency-cheap-codex-53e1`, \"Consistency Is Cheap\"). " +
      "No other thread in the corpus retains pixel coordinates on a layout finding — the studio's " +
      "condensed summary format drops both the timestamp and the rect for every other run.",
  );
  push();
  push("Message × severity breakdown (population 1, whole corpus):");
  push();
  push("| message | error | warning | source thread(s) |");
  push("|---|---|---|---|");
  for (const [msg, row] of [...msgTally.entries()].sort((a, b) => b[1].error + b[1].warning - (a[1].error + a[1].warning))) {
    push(`| ${msg} | ${row.error} | ${row.warning} | ${[...row.sources].join(", ")} |`);
  }
  push();

  push("### 1b. Selector-bearing repair-prompt lines (supplementary, not part of population 1)");
  push();
  push(
    "When a composition fails, the studio hands a repair sub-agent a `Findings:` list quoting " +
      "the same underlying checker output, but in a different shape: `[severity] category_id: " +
      "layout: <message> (selector: <css selector>)`. No pixel rect, but a real CSS selector — " +
      "which is itself a location once matched against the classes `docs/region-evidence.json` " +
      "already measured. Each such line is its own event; many were truncated mid-selector before " +
      "reaching a closing paren (a per-event storage limit in the transcript, not a checker " +
      "artifact), so only complete selectors are used for classification.",
  );
  push();
  push(`- Selector-format lines found: **${selectorRaw.length}**`);
  push(`- Complete (usable) selector: **${selectorComplete.length}**`);
  push(`- Truncated mid-selector, discarded as unparseable for this purpose: **${selectorRaw.length - selectorComplete.length}**`);
  push(
    `- Source: only 2 of ${threadFiles.length} threads (\`t-2291d9f1.json\`, \`t-5479509f.json\`); ` +
      "the latter is almost entirely one video's repeated repair attempts on the same folio " +
      "positioning defect (`2026-08-01-judgment-has-cost-baseline-159b`). **This population is " +
      "not a representative corpus sample** — it is reported only as corroborating, class-level " +
      "evidence, and every count from it below should be read with that in mind.",
  );
  push();
  push("Complete selectors found, by class and category:");
  push();
  push("| selector class | category_id | reconciled severity | count | zone |");
  push("|---|---|---|---|---|");
  const sel2Tally = new Map<string, {catId: string; severity: Severity; zone: Zone; count: number}>();
  for (const f of zoned2) {
    const key = `${f.cls}|${f.catId}`;
    const row = sel2Tally.get(key) ?? {catId: f.catId, severity: f.severity, zone: f.zone, count: 0};
    row.count++;
    sel2Tally.set(key, row);
  }
  for (const [key, row] of [...sel2Tally.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const cls = key.split("|")[0];
    push(`| \`${cls}\` | ${row.catId} | ${row.severity} | ${row.count} | ${row.zone} |`);
  }
  push();

  push("## 2. Zone boundaries used, and where they came from");
  push();
  push(
    "Computed at run time from `docs/region-evidence.json`'s measured element rects (never " +
      "hand-picked, and never written back to that file):",
  );
  push();
  push(
    `- **RAIL LANE**: element x-center < **${boundaries.railBoundary.toFixed(4)}** — the narrower ` +
      "of the two measured `--gutter` values across the corpus (`docs/region-evidence.md` §1). A " +
      "strict test for \"inside the reserved rail chrome\", not \"starts near it\".",
  );
  push(
    `- **MASTHEAD**: element y-center < **${boundaries.mastheadBottom.toFixed(4)}** — the deepest ` +
      "measured bottom edge across every `kicker`, `section-number`, `brand-seal` and `rail-rule` " +
      "element in the evidence corpus.",
  );
  for (const [i, band] of boundaries.footBands.entries()) {
    push(
      `- **FOOT** (band ${i + 1}): y-center in **[${band.top.toFixed(4)}, ${band.bottom.toFixed(4)}]** — ` +
        "measured from `folio` element rects.",
    );
  }
  push(
    "  The `folio` lockup is bimodal: most scenes place it around y≈0.69, outro scenes place it " +
      "near the true bottom of the canvas (y≈0.95). Both bands are the same semantic element (the " +
      "foot line) and both count as FOOT.",
  );
  push(
    `- **CAPTION BAND**: y-center in **[${boundaries.captionBand.top.toFixed(4)}, ` +
      `${boundaries.captionBand.bottom.toFixed(4)}]** — measured from \`caption-page\` and \`word\` ` +
      "element rects.",
  );
  push(
    "- **MIDDLE**: everything else — any rect (or selector class) that is not decided by one of " +
      "the four zones above.",
  );
  push();
  push(
    "The question's fourth named frame member, the **full-bleed field** (the `.clip`/`.field`/" +
      "`.backdrop` background layer, rect ≈ `[0, -0.01, 1, 1]` per `docs/region-evidence.md`), is " +
      "not treated as a spatial zone here: it covers the entire canvas by construction, so it " +
      "cannot distinguish frame from middle by location — every finding's rect trivially " +
      "\"overlaps\" it. It is a z-order concept (background vs. foreground), not a place on the " +
      "stage, and is left out of the zone test for that reason.",
  );
  push();

  push("## 3. Classified findings");
  push();
  push("### 3a. Population 1 — pixel-geometry findings (n=" + directWithCoords.length + ")");
  push();
  push("| severity | message | t | rect (fraction) | zone |");
  push("|---|---|---|---|---|");
  for (const f of zoned1) {
    push(`| ${f.severity} | ${f.message} | ${f.t}s | ${fmtRect(f.rect!)} | **${f.zone}** |`);
  }
  push();
  push(
    "Both errors are the *same rect* reported twice (an occlusion finding at 9.07s, then an " +
      "overlap finding at 11.87s, once the animation had moved further) — one element, flagged " +
      "twice as the composition's timeline progressed. The repair narration for this exact run " +
      "(same thread) names it explicitly: *\"The failing kicker shares the left column with the " +
      "animated output stack. I've isolated it into the existing right-hand content column.\"* " +
      "The flagged element (`p.kicker`, masthead) sits in the FRAME. What it collided with — " +
      "\"the animated output stack\" — is scene content, not frame chrome. **The check finding's " +
      "own rect only ever describes one side of an overlap or occlusion.** The other party is " +
      "not geometrically recorded anywhere in the transcript; it is known here only because the " +
      "repair agent's prose happened to name it.",
  );
  push();
  push("### 3b. Population 2 — selector-class findings (n=" + selectorComplete.length + ", supplementary, non-representative)");
  push();
  const zone2Tally = new Map<Zone, {error: number; warning: number}>();
  for (const f of zoned2) {
    const row = zone2Tally.get(f.zone) ?? {error: 0, warning: 0};
    row[f.severity]++;
    zone2Tally.set(f.zone, row);
  }
  push("| zone | error | warning |");
  push("|---|---|---|");
  for (const zone of ["rail", "masthead", "foot", "caption", "middle"] as Zone[]) {
    const row = zone2Tally.get(zone) ?? {error: 0, warning: 0};
    push(`| ${zone} | ${row.error} | ${row.warning} |`);
  }
  push();
  push(
    "Read this table with the caveat from §1b already applied: 24 of the 32 classified errors " +
      "here are the *same* `folio.left` / `folio.right` occlusion, re-detected across many repair " +
      "attempts on one 16:9 video. It is one persistent defect, not 24 independent incidents. " +
      "The one MIDDLE error (`div.closing-idea`) and the seven MIDDLE warnings (`div.position-pin`, " +
      "confirmed by its own CSS to be a badge positioned by its content container, not frame " +
      "chrome) are the more informative numbers here: they show middle content does independently " +
      "fail, even in this narrow, two-thread slice.",
  );
  push();

  push("## 4. The key number");
  push();
  const framedZones: Zone[] = ["rail", "masthead", "foot", "caption"];
  const dErrCoords = zoned1.filter((f) => f.severity === "error");
  const dErrFrame = dErrCoords.filter((f) => framedZones.includes(f.zone)).length;
  push(
    `**Population 1 (pixel geometry, the only rigorous sample):** of the ${dErrCoords.length} ` +
      `layout ERRORS with known geometry, ${dErrFrame} of ${dErrCoords.length} ` +
      `(${pct(dErrFrame, dErrCoords.length)}) sit wholly inside a frame zone by their own rect. ` +
      `That is ${dErrCoords.length} errors out of ${directErrors.length} total layout errors in ` +
      `the corpus (${pct(dErrCoords.length, directErrors.length)} coverage) — nowhere near enough ` +
      "to generalise to \"the corpus.\" This is the honest headline: **97.6% of all layout error " +
      "findings in this dataset carry no location at all**, so a geography claim about most of " +
      "them cannot be made from this data, in either direction.",
  );
  push();
  const sErr = zoned2.filter((f) => f.severity === "error");
  const sErrFrame = sErr.filter((f) => framedZones.includes(f.zone)).length;
  push(
    `**Population 2 (selector class, supplementary and non-representative — see §1b/§3b):** of ` +
      `the ${sErr.length} classified errors, ${sErrFrame} (${pct(sErrFrame, sErr.length)}) map to ` +
      "a frame-zone class. This number looks decisive but is inflated by one repeated defect in " +
      "one video; treat it as a single anecdote of a frame element (folio) failing repeatedly, " +
      "not as a corpus rate.",
  );
  push();
  push(
    "**What can be said without qualification:** the one fully-reconstructable overlap/occlusion " +
      "incident in the whole dataset (§3a) is a FRAME element (the masthead kicker) colliding " +
      "with a MIDDLE element (an animated output stack) — a cross-zone collision. A frame-only " +
      "contract pins one party to that collision and has no jurisdiction over the other.",
  );
  push();

  push("## 5. Verifying the 61-error claim (docs/template-system-plan.md §1)");
  push();
  push(
    "The plan states: *\"Every blocking error across the two Luna runs of 2026-08-05\"* totals " +
      "24 overlap + 20 occlusion + 14 overflow + 3 rotation = 61.",
  );
  push();
  push("Checked against the data available in this repository:");
  push();
  push(
    `- **The two cited runs are not in this dataset.** Neither ` +
      "`2026-08-05-authorship-starts-early-codex-d794` nor `2026-08-05-speed-authorship-codex-0600` " +
      "(the two `gpt-5.6-luna`-composed videos from `data/videos/` dated 2026-08-05) is referenced " +
      `by video id, slug, or any substring in any of the ${threadFiles.length} files under ` +
      `\`data/threads/\`. Slug found in any thread text: **${lunaSlugMentioned}**. No thread's ` +
      `timestamp range reaches 2026-08-05 at all — the latest event in any thread file is ` +
      `${[...new Set(threadDateRanges.map((r) => r.last).filter(Boolean))].sort().at(-1) ?? "unknown"}` +
      `. No check log, provenance file, or QC file under \`data/videos/\` or \`out/\` for either run ` +
      "carries layout-check output either (both `out/*/qc-*.json` files there are audio/caption QC, " +
      "not layout QC). **The source material for this specific claim does not exist anywhere in " +
      "this repository's data.**",
  );
  push(
    `- **Rotation: zero findings anywhere.** Not one occurrence of a rotation-drift layout message ` +
      `was found across every thread, in either logging shape (${rotationMentions} in population 1; ` +
      "none in population 2 either). This does not mean the claimed 3 rotation errors are " +
      "fabricated — `src/core/render/check.ts` itself documents a real rotation-pivot incident " +
      "(\"the dial on run 0600 drifted 107px and 162px across its rotation\"), which is plainly " +
      "`2026-08-05-speed-authorship-codex-0600`, one of the two cited runs. That comment " +
      "corroborates the *category* independently of the transcripts. It does not corroborate the " +
      "*count* (3), which appears nowhere in any data file available here.",
  );
  push(
    "- **The number this script can actually produce**, using the canonical log form across " +
      `every thread and every video (not just two runs, and not just 2026-08-05): ` +
      `**${directErrors.length} total layout errors** — ${planTally.get("occlusion")?.error ?? 0} occlusion, ` +
      `${planTally.get("overlap")?.error ?? 0} overlap, ${planTally.get("overflow")?.error ?? 0} overflow, ` +
      `${planTally.get("rotation")?.error ?? 0} rotation` +
      (planTally.has("other") ? `, ${planTally.get("other")?.error ?? 0} uncategorised (a caption-centering message the plan's taxonomy doesn't cover)` : "") +
      ".",
  );
  push();
  push(
    "**Verdict: the 61 figure is not reproducible from this repository's data, and cannot be made " +
      "reproducible — the underlying runs are simply not recorded here.** The full-corpus numbers " +
      "this script can verify are both a different total and a different *shape* from what is " +
      "claimed (occlusion dominates here; the plan claims overlap dominates), which matters " +
      "independently of scope: whatever the real 2026-08-05 numbers were, generalising from them " +
      "to \"the case for constraining geometry\" was already resting on a count nothing in this " +
      "repository can check.",
  );
  push();

  push("## 6. Would a frame-only contract have prevented these failures?");
  push();
  push(
    "**No, not by itself, and the data available says so on two independent grounds.** First, on " +
      "coverage: 97.6% of layout error findings in this corpus (population 1) carry no location " +
      "data at all, so for the overwhelming majority of failures this question cannot be answered " +
      "either way from what the studio recorded — a plan built on the assumption that geometry " +
      "correlates with the frame is a plan built on 2.4% visibility into where geometry actually " +
      "fails. Second, on mechanism: overlap and occlusion are inherently two-party findings, and " +
      "every source in this dataset — the one pixel-located incident, corroborated by its own " +
      "repair narration — records only the flagged element's own box, never its collision " +
      "partner's. The one case fully reconstructable end-to-end is exactly the failure mode a " +
      "frame-only contract cannot reach: a correctly-frame-zoned kicker, occluded and then " +
      "overlapped by a middle-zone \"animated output stack\" that a frame contract has no " +
      "jurisdiction over. Pinning the frame's own elements does not stop a middle element from " +
      "drifting into that reserved space unless the contract also reserves that space *against* " +
      "the middle — which is a materially stronger, different claim than \"pin the frame,\" and " +
      "one the measurement in `docs/region-evidence.md` was never designed to test. The " +
      "supplementary selector evidence (§3b/§4) leans the same direction for a different reason: " +
      "even in a two-thread, single-video slice, middle-zone elements (`position-pin`, " +
      "`closing-idea`) show up as independently failing, not merely as collision partners for " +
      "frame elements. A frame contract is very plausibly necessary — nothing here argues against " +
      "reserving the masthead, foot, rail and caption band — but nothing here shows it is " +
      "sufficient, and the one fully-documented incident is a direct demonstration of why it is " +
      "not.",
  );
  push();

  push("## 7. What could not be determined");
  push();
  push(
    "- **Corpus-wide zone rates for layout errors.** Only 3 findings in the entire dataset carry " +
      "pixel geometry; 121 do not. No amount of re-analysis of the transcripts recovers this — " +
      "the coordinates were simply never written to the log for any run except one.",
  );
  push(
    "- **The 61-error claim**, as stated in §5 — the source runs are absent from this repository's " +
      "data entirely, not merely under-detailed.",
  );
  push(
    "- **Whether population 1's 121 coordinate-less findings skew toward frame or middle.** " +
      "Population 2 offers a same-direction hint (classifiable errors lean frame-heavy, but on a " +
      "non-representative, repeat-dominated sample) — it is evidence, not proof, and the two " +
      "populations were kept separate throughout this report specifically so that hint is never " +
      "mistaken for the rigorous number.",
  );
  push(
    "- **The identity and rect of every collision partner.** Even where a finding's own element is " +
      "geometrically known, the thing it overlapped or was hidden beneath is not recorded anywhere " +
      "in these transcripts except by incidental mention in repair prose (one case, §3a).",
  );
  push();

  await fs.writeFile(MD_OUT, lines.join("\n") + "\n", "utf8");
  console.log(`wrote ${rel(MD_OUT)}`);
  console.log(
    `population 1: ${direct.length} findings (${directErrors.length} error, ${directWarnings.length} warning), ` +
      `${directWithCoords.length} with geometry`,
  );
  console.log(
    `population 2: ${selectorRaw.length} selector lines, ${selectorComplete.length} complete (non-representative sample)`,
  );
  console.log(`2026-08-05 Luna runs found in threads: ${hasAug05Thread || lunaSlugMentioned}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
