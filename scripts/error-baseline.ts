import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {loadBrandKit, type BrandKit} from "../src/core/brand/kit.ts";
import {videoPlanZ, type VideoPlan} from "../src/core/plan/schema.ts";
import {checkComposition, type CheckFinding, type CheckReport} from "../src/core/render/check.ts";
import {FPS} from "../src/core/compose/workdir.ts";
import {ROOT, VIDEOS_DIR, rel} from "../src/core/paths.ts";
import {captionZone, FORMATS, referenceFormat, type FormatFamily} from "../src/core/plan/formats.ts";
import {compatibleNode} from "../src/core/render/node.ts";
import {run} from "../src/core/util/exec.ts";

/**
 * Regenerates the "61 of 61 are geometry" claim in docs/template-system-plan.md §1 / issue #1,
 * from the only place it can still be checked: the two 2026-08-05 Luna runs' compositions
 * that are still on disk, run back through the same checker (`checkComposition`) that produced
 * the original findings.
 *
 * `data/threads/*.json` stops at 2026-08-01 — neither run is in any transcript — so the 61
 * cannot be recovered from logs (see `scripts/error-geography.ts` for that exhaustive search).
 * This script does not read logs at all. It reconstructs the finding set the only other way
 * available: by re-running the checker against the composition files the two runs actually
 * left behind —
 *
 *   data/videos/2026-08-05-authorship-starts-early-codex-d794/  (attempts/1..4, work/{portrait,landscape})
 *   data/videos/2026-08-05-speed-authorship-codex-0600/         (attempts/1..2, work/{portrait,landscape})
 *
 * A third same-day directory, `2026-08-05-ship-thought-codex-9722`, exists but is deliberately
 * excluded: its composer is recorded as "unknown" in SUMMARY.txt (the other two explicitly
 * credit `codex · gpt-5.6-luna`), both its formats failed outright, and it is not one of the
 * two runs named in the plan or issue. It is reported on separately in the output, not folded
 * into the totals.
 *
 * For each stored attempt and each shipped final composition, this script:
 *  1. copies the matching `work/<family>/` authoring directory into a temp dir (never touches
 *     `data/videos/` itself),
 *  2. for attempts, overwrites `index.html` / `styles.css` / `animation.js` with that attempt's
 *     three files,
 *  3. runs `checkComposition` with the run's own `plan.json` and the current brand kit — the
 *     exact call the production pipeline makes, including motion sampling (a browser and
 *     ffmpeg are both present in this environment; skipping motion sampling would silently
 *     shrink the error count),
 *  4. separately calls the HyperFrames CLI's own `check` command a second time on the same
 *     temp dir, to read its raw JSON before `checkComposition`'s `runHyperframesCheck` drops
 *     the `containerSelector` field. `checkComposition`'s own `CheckFinding` never carries the
 *     second party to an overlap/occlusion; the raw JSON does. This second call answers that
 *     question without modifying `check.ts`.
 *
 * A composition's authored family (portrait vs. landscape) is not asserted — it is read off
 * the composition's own `data-width`/`data-height` on `#stage` (1080×1920 = portrait,
 * 1920×1080 = landscape) and printed, so the classification is checkable rather than assumed.
 *
 * Deterministic modulo the checker itself: same files, same plan, same kit, same HyperFrames
 * version (0.7.88, matching both runs' own SUMMARY.txt) → same findings. Writes only
 * `docs/error-baseline.md` and a results cache under the OS temp dir; never writes under
 * `data/videos/`.
 */

const CLI = path.join(ROOT, "node_modules", "hyperframes", "bin", "hyperframes.mjs");
const MD_OUT = path.join(ROOT, "docs", "error-baseline.md");
const CACHE_FILE = path.join(os.tmpdir(), "herald-error-baseline-results.json");

const RUNS = [
  {id: "2026-08-05-authorship-starts-early-codex-d794", label: "Authorship Starts Early"},
  {id: "2026-08-05-speed-authorship-codex-0600", label: "Speed Is Not Authorship"},
] as const;

// -------------------------------------------------------------------------------------------
// Job discovery
// -------------------------------------------------------------------------------------------

interface JobSpec {
  key: string;
  runId: string;
  runLabel: string;
  kind: "attempt" | "final";
  attemptN?: number;
  family: FormatFamily;
  /** Directory holding index.html/styles.css/animation.js to overlay onto the copied work dir. `null` for a final (use the work dir as shipped). */
  overlayDir: string | null;
}

async function detectFamily(indexHtmlPath: string): Promise<{family: FormatFamily; width: number; height: number}> {
  const html = await fs.readFile(indexHtmlPath, "utf8");
  const width = Number(/data-width="(\d+)"/.exec(html)?.[1]);
  const height = Number(/data-height="(\d+)"/.exec(html)?.[1]);
  const byWidth = Object.values(FORMATS).find((spec) => spec.width === width && spec.height === height);
  if (!byWidth) {
    throw new Error(`${rel(indexHtmlPath)}: data-width=${width} data-height=${height} matches no known FORMATS entry`);
  }
  return {family: byWidth.family, width, height};
}

async function discoverJobs(runId: string, runLabel: string): Promise<{jobs: JobSpec[]; notes: string[]}> {
  const runDir = path.join(VIDEOS_DIR, runId);
  const jobs: JobSpec[] = [];
  const notes: string[] = [];

  const attemptsDir = path.join(runDir, "attempts");
  const entries = await fs.readdir(attemptsDir, {withFileTypes: true}).catch(() => []);
  const attemptNums = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => Number(entry.name))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  for (const n of attemptNums) {
    const dir = path.join(attemptsDir, String(n));
    const {family, width, height} = await detectFamily(path.join(dir, "index.html"));
    notes.push(`${runLabel} attempts/${n}: data-width=${width} data-height=${height} → ${family}`);
    jobs.push({key: `${runId}/attempt-${n}`, runId, runLabel, kind: "attempt", attemptN: n, family, overlayDir: dir});
  }

  for (const family of ["portrait", "landscape"] as const) {
    const workDir = path.join(runDir, "work", family);
    const exists = await fs.access(workDir).then(() => true).catch(() => false);
    if (!exists) continue;
    const indexPath = path.join(workDir, "index.html");
    const hasIndex = await fs.access(indexPath).then(() => true).catch(() => false);
    if (!hasIndex) continue;
    jobs.push({key: `${runId}/final-${family}`, runId, runLabel, kind: "final", family, overlayDir: null});
  }

  return {jobs, notes};
}

// -------------------------------------------------------------------------------------------
// Raw HyperFrames CLI call — the only way to reach `containerSelector`
// -------------------------------------------------------------------------------------------

interface RawFinding {
  code?: string;
  severity?: string;
  time?: number;
  selector?: string;
  containerSelector?: string;
  message?: string;
  rect?: {left: number; top: number; right: number; bottom: number; width: number; height: number};
  containerRect?: {left: number; top: number; right: number; bottom: number; width: number; height: number};
  occurrences?: number;
}

async function rawHyperframesCheck(dir: string, family: FormatFamily): Promise<{
  findings: RawFinding[];
  groups: Record<string, RawFinding[]>;
}> {
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
    const shell = error as {stdout?: string; stderr?: string};
    if (shell.stdout?.trim()) return {stdout: shell.stdout};
    throw new Error(`hyperframes check could not run: ${shell.stderr ?? String(error)}`);
  });
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error("hyperframes check produced no parseable JSON on stdout");
  const report = JSON.parse(stdout.slice(start)) as Record<string, {findings?: RawFinding[]}>;

  const groups: Record<string, RawFinding[]> = {};
  const findings: RawFinding[] = [];
  for (const group of ["lint", "runtime", "layout", "motion", "contrast"]) {
    const list = report[group]?.findings ?? [];
    groups[group] = list;
    findings.push(...list);
  }
  return {findings, groups};
}

// -------------------------------------------------------------------------------------------
// Zone classification for two-party (occlusion/overlap) findings
//
// Thresholds as specified for this investigation: masthead y-center < 0.19, foot y-center in
// [0.63, 0.70], rail x-center < 0.062 — consistent with the rail lane measured in
// docs/region-evidence.md §1 (0.062–0.065) and the masthead/foot bands `scripts/
// error-geography.ts` computes from docs/region-evidence.json. That evidence corpus is
// portrait-only (`render/9x16*`); applying the same fractional thresholds to landscape (16:9)
// compositions here is an approximation, not a re-measurement, and is called out wherever it
// matters below.
// -------------------------------------------------------------------------------------------

type Zone = "rail" | "masthead" | "foot" | "middle";

const MASTHEAD_Y = 0.19;
const FOOT_Y = {min: 0.63, max: 0.70};
const RAIL_X = 0.062;

function zoneForFraction(xCenter: number, yCenter: number): Zone {
  if (xCenter < RAIL_X) return "rail";
  if (yCenter < MASTHEAD_Y) return "masthead";
  if (yCenter >= FOOT_Y.min && yCenter <= FOOT_Y.max) return "foot";
  return "middle";
}

/** Selector class names this corpus's supplied chrome renders with — same table `error-geography.ts` uses. */
const CHROME_CLASS_ZONE: Record<string, Zone> = {
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
};
/** Reported alongside, not folded into "middle": the reserved caption band has no rect-based
 * threshold given for this investigation, but its selector names are known and it is
 * mandatory supplied chrome, not ordinary scene content. */
const CAPTION_CLASSES = new Set(["caption-page", "word"]);

function leafToken(selector: string): string {
  const classMatch = /^[a-zA-Z0-9]*\.([a-zA-Z0-9_-]+)/.exec(selector);
  if (classMatch?.[1]) return classMatch[1];
  const idMatch = /^#([a-zA-Z0-9_-]+)/.exec(selector);
  if (idMatch?.[1]) return `#${idMatch[1]}`;
  return selector.split(/\s/)[0] ?? selector;
}

function classifySelector(selector: string): Zone | "caption" {
  const token = leafToken(selector);
  if (CAPTION_CLASSES.has(token)) return "caption";
  return CHROME_CLASS_ZONE[token] ?? "middle";
}

// -------------------------------------------------------------------------------------------
// Running one job
// -------------------------------------------------------------------------------------------

interface JobResult {
  job: JobSpec;
  width: number;
  height: number;
  checkOk: boolean | null;
  checkError: string | null;
  errorCount: number;
  warningCount: number;
  findings: {severity: string; code?: string; message: string}[];
  rawError: string | null;
  twoParty: {
    code: string;
    severity: string;
    time: number;
    selector: string;
    selectorZone: Zone | "caption";
    containerSelector: string;
    containerZone: Zone | "caption";
  }[];
  motionUnsampled: boolean;
  durationMs: number;
}

async function runJob(job: JobSpec, plan: VideoPlan, kit: BrandKit, log: (line: string) => void): Promise<JobResult> {
  const started = Date.now();
  const runDir = path.join(VIDEOS_DIR, job.runId);
  const workDir = path.join(runDir, "work", job.family);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "error-baseline-"));
  const result: JobResult = {
    job,
    width: FORMATS[referenceFormat(job.family)].width,
    height: FORMATS[referenceFormat(job.family)].height,
    checkOk: null,
    checkError: null,
    errorCount: 0,
    warningCount: 0,
    findings: [],
    rawError: null,
    twoParty: [],
    motionUnsampled: false,
    durationMs: 0,
  };

  try {
    await fs.cp(workDir, tmp, {recursive: true});
    if (job.overlayDir) {
      for (const file of ["index.html", "styles.css", "animation.js"]) {
        await fs.copyFile(path.join(job.overlayDir, file), path.join(tmp, file));
      }
    }

    // 1 — the production call.
    try {
      const report: CheckReport = await checkComposition({
        dir: tmp, plan, kit, family: job.family, fps: FPS, sampleMotion: true, onLog: log,
      });
      result.checkOk = report.ok;
      result.errorCount = report.errorCount;
      result.warningCount = report.warningCount;
      result.findings = report.findings.map((f: CheckFinding) => ({severity: f.severity, code: f.code, message: f.message}));
      result.motionUnsampled = report.findings.some((f) => f.code === "motion_unsampled");
    } catch (error) {
      result.checkError = (error as Error).message;
    }

    // 2 — the raw CLI call, for containerSelector. checkComposition already ran the CLI once
    // internally; this is a deliberate second pass (see file header) because `runHyperframesCheck`
    // discards that field before it reaches CheckFinding.
    try {
      const raw = await rawHyperframesCheck(tmp, job.family);
      for (const finding of raw.groups.layout ?? []) {
        if (finding.code !== "content_overlap" && finding.code !== "text_occluded") continue;
        if (!finding.selector || !finding.containerSelector) continue;
        result.twoParty.push({
          code: finding.code,
          severity: finding.severity ?? "unknown",
          time: finding.time ?? -1,
          selector: finding.selector,
          selectorZone: classifySelector(finding.selector),
          containerSelector: finding.containerSelector,
          containerZone: classifySelector(finding.containerSelector),
        });
      }
    } catch (error) {
      result.rawError = (error as Error).message;
    }
  } finally {
    await fs.rm(tmp, {recursive: true, force: true});
  }

  result.durationMs = Date.now() - started;
  return result;
}

// -------------------------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------------------------

async function loadCache(): Promise<Record<string, JobResult>> {
  return JSON.parse(await fs.readFile(CACHE_FILE, "utf8").catch(() => "{}")) as Record<string, JobResult>;
}

async function saveCache(cache: Record<string, JobResult>) {
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
}

async function main() {
  const resume = process.argv.includes("--resume");
  const cache = resume ? await loadCache() : {};
  // Debugging aid only: `--only=<substring>` restricts which jobs run, and suppresses the
  // final report (a partial job set must never overwrite docs/error-baseline.md).
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const only = onlyArg?.slice("--only=".length);

  const kit = await loadBrandKit();
  const allNotes: string[] = [];
  let allJobs: JobSpec[] = [];
  const plans = new Map<string, VideoPlan>();

  for (const {id, label} of RUNS) {
    const raw = JSON.parse(await fs.readFile(path.join(VIDEOS_DIR, id, "plan.json"), "utf8"));
    plans.set(id, videoPlanZ.parse(raw));
    const {jobs, notes} = await discoverJobs(id, label);
    allJobs.push(...jobs);
    allNotes.push(...notes);
  }
  if (only) allJobs = allJobs.filter((job) => job.key.includes(only));

  console.log(`${allJobs.length} job(s) discovered${only ? ` (filtered to "${only}")` : ""}:`);
  for (const note of allNotes) console.log(`  ${note}`);
  console.log();

  const results: JobResult[] = [];
  for (const [index, job] of allJobs.entries()) {
    if (cache[job.key]) {
      console.log(`[${index + 1}/${allJobs.length}] ${job.key} — cached, skipping`);
      results.push(cache[job.key]!);
      continue;
    }
    console.log(`[${index + 1}/${allJobs.length}] ${job.key} (${job.family}) — running…`);
    const plan = plans.get(job.runId)!;
    const result = await runJob(job, plan, kit, (line) => console.log(`    ${line}`));
    console.log(
      `    done in ${(result.durationMs / 1000).toFixed(1)}s — `
      + `${result.checkError ? `THREW: ${result.checkError}` : `${result.errorCount} error(s), ${result.warningCount} warning(s)`}`
      + `${result.rawError ? ` — raw CLI pass THREW: ${result.rawError}` : ""}`,
    );
    results.push(result);
    cache[job.key] = result;
    await saveCache(cache);
  }

  if (only) {
    console.log(`--only was set; not writing ${rel(MD_OUT)} from a partial job set.`);
    return;
  }
  await writeReport(results, allNotes);
}

const PLAN_CATEGORIES = [
  {code: "content_overlap", label: "layout: Two text blocks overlap and may render unreadable"},
  {code: "text_occluded", label: "layout: Text is hidden beneath an opaque element"},
  {code: "text_box_overflow", label: "layout: Text extends outside its nearest visual/container box"},
  {code: "rotation_pivot_drift", label: "layout: Rotating element is not spinning about its own center"},
] as const;

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`;
}

async function writeReport(results: JobResult[], jobNotes: string[]) {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  const ran = results.filter((r) => r.checkError === null);
  const threw = results.filter((r) => r.checkError !== null);
  const rawFailed = results.filter((r) => r.rawError !== null);

  push("# Error baseline — regenerating the \"61 of 61 are geometry\" claim");
  push();
  push(
    "Generated by `npm run errors:baseline` (`scripts/error-baseline.ts`). Re-runs "
    + "`checkComposition` (the same call the production pipeline makes) against every stored "
    + "composition from the two runs `docs/template-system-plan.md` §1 and issue #1 cite — not "
    + "against logs, which do not contain either run (see `scripts/error-geography.ts`).",
  );
  push();
  push(
    "**The claim being tested:** \"Every blocking error across the two Luna runs of "
    + "2026-08-05\" totals 24 overlap + 20 occlusion + 14 overflow + 3 rotation = **61**, and "
    + "**61 of 61 are geometry**.",
  );
  push();

  push("## 1. What was checked, and how family was determined");
  push();
  push(
    "The two runs named in the plan and in issue #1: `2026-08-05-authorship-starts-early-codex-d794` "
    + "and `2026-08-05-speed-authorship-codex-0600`. A third same-day directory, "
    + "`2026-08-05-ship-thought-codex-9722`, was found but is **not** included below: its "
    + "`SUMMARY.txt` records composition as `unknown` (the other two explicitly credit "
    + "`codex · gpt-5.6-luna`), both of its formats failed outright with no video rendered, and "
    + "it is not one of the two runs the claim names. It is worth a follow-up look — see §6.",
  );
  push();
  push(
    "Every `attempts/N` directory in both runs holds exactly one composition (index.html/"
    + "styles.css/animation.js). Which family it belongs to is not asserted; it is read from "
    + "the composition's own `data-width`/`data-height` on `#stage` (1080×1920 = portrait, "
    + "1920×1080 = landscape):",
  );
  push();
  for (const note of jobNotes) push(`- ${note}`);
  push();
  push(
    "**Every stored attempt in both runs is landscape.** Portrait never has a frozen attempt "
    + "in either run — `freezeAttempt` (`src/core/pipeline/run.ts`) only writes `attempts/N` "
    + "when a check still has errors after that attempt, so this means portrait passed on its "
    + "very first attempt in both runs and left nothing to reconstruct beyond its final, "
    + "shipped state. (It also means `attempts/N` is shared across families — "
    + "`freezeAttempt`'s target is `videoDir/attempts/<n>`, not `videoDir/work/<family>/"
    + "attempts/<n>` — so if both families had ever failed at the same attempt number, the "
    + "later family's freeze would have overwritten the earlier one's. That did not happen "
    + "here, but it means `attempts/N` is not guaranteed family-stable in general.) Concretely: "
    + "each stored attempt was checked once, against the landscape family only — running it "
    + "against portrait's authoring directory would check a 1920×1080 composition inside a "
    + "1080×1920 canvas, which is not what was authored and not a meaningful check.",
  );
  push();
  const attemptJobCount = results.filter((r) => r.job.kind === "attempt").length;
  const finalJobCount = results.filter((r) => r.job.kind === "final").length;
  push(
    "Each of the two runs' `work/{portrait,landscape}/` final composition was also checked, "
    + `as shipped — ${finalJobCount} jobs. Total: `
    + `**${results.length} check runs** (${attemptJobCount} attempt(s) + ${finalJobCount} finals).`,
  );
  push();
  push(
    "HyperFrames version installed here is **0.7.88** — the exact version both runs' own "
    + "`SUMMARY.txt` record as the renderer, so the underlying layout-audit engine matches what "
    + "actually produced the original findings, not a drifted later version. `check.ts` itself "
    + "has changed since 2026-08-05 (new studio-level gates, severity promotions), so the "
    + "*non-layout* portion of these totals reflects today's checker, not the checker as it "
    + "stood on the day — flagged again in §3.",
  );
  push();

  push("## 2. Availability of the gates that need a browser or ffmpeg");
  push();
  const motionUnsampled = ran.filter((r) => r.motionUnsampled);
  push(
    `- **Motion sampling** (\`sampleMotion\`, needs the HyperFrames-cached headless Chrome and `
    + "\`ffmpeg\` for PSNR): both present in this environment (\`hyperframes doctor\` confirms "
    + `Chrome and FFmpeg; \`ffmpeg 8.0\` at \`/opt/homebrew/bin/ffmpeg\`). Ran for `
    + `**${ran.length - motionUnsampled.length} of ${ran.length}** completed jobs`
    + (motionUnsampled.length
      ? `; ${motionUnsampled.length} reported \`motion_unsampled\` (a warning, not counted as a `
        + "layout error) for: " + motionUnsampled.map((r) => r.job.key).join(", ") + "."
      : ".") ,
  );
  push(
    "- **HyperFrames CLI check** (lint/runtime/layout/motion/contrast — where every `layout:` "
    + `finding comes from): needs Node ≥ 22 (resolved to \`/usr/local/bin/node\` v24 via `
    + "`compatibleNode()`, since the default shell `node` here is v20) and the same Chrome. "
    + `Ran for **${ran.length} of ${results.length}** jobs.`,
  );
  if (threw.length) {
    push();
    push(`**${threw.length} job(s) could not be checked and are excluded from every count below, not folded into a smaller total:**`);
    for (const r of threw) push(`- \`${r.job.key}\`: ${r.checkError}`);
  } else {
    push("- No job's `checkComposition` call threw. All results below are complete, not partial.");
  }
  if (rawFailed.length) {
    push();
    push(
      `**${rawFailed.length} job(s)' supplementary raw-CLI pass (for §5's containerSelector `
      + "question only) failed and are excluded from §5's counts:**",
    );
    for (const r of rawFailed) push(`- \`${r.job.key}\`: ${r.rawError}`);
  }
  push();

  push("## 3. Regenerated findings, per job");
  push();
  push("| job | family | check ran | errors | warnings | layout errors (of the 4 plan categories) |");
  push("|---|---|---|---|---|---|");
  for (const r of results) {
    const layoutOfInterest = r.findings.filter(
      (f) => f.severity === "error" && PLAN_CATEGORIES.some((c) => c.code === f.code),
    ).length;
    push(
      `| \`${r.job.key}\` | ${r.job.family} | ${r.checkError ? "**no**" : "yes"} | `
      + `${r.checkError ? "—" : r.errorCount} | ${r.checkError ? "—" : r.warningCount} | `
      + `${r.checkError ? "—" : layoutOfInterest} |`,
    );
  }
  push();

  push("### 3a. Totals across every job that ran (all gates, not only layout)");
  push();
  const totalErrors = ran.reduce((sum, r) => sum + r.errorCount, 0);
  const totalWarnings = ran.reduce((sum, r) => sum + r.warningCount, 0);
  push(`- Total errors (all gates: lint, runtime, layout, motion, contrast, tokens, plan, wordmark, etc.): **${totalErrors}**`);
  push(`- Total warnings: **${totalWarnings}**`);
  push();
  const codeTally = new Map<string, {error: number; warning: number; info: number}>();
  for (const r of ran) {
    for (const f of r.findings) {
      const key = f.code ?? f.message;
      const row = codeTally.get(key) ?? {error: 0, warning: 0, info: 0};
      if (f.severity === "error") row.error++;
      else if (f.severity === "warning") row.warning++;
      else row.info++;
      codeTally.set(key, row);
    }
  }
  push("Every distinct finding code seen, across all completed jobs:");
  push();
  push("| code | error | warning | info | example message |");
  push("|---|---|---|---|---|");
  const exampleFor = new Map<string, string>();
  for (const r of ran) for (const f of r.findings) if (!exampleFor.has(f.code ?? f.message)) exampleFor.set(f.code ?? f.message, f.message);
  for (const [code, row] of [...codeTally.entries()].sort((a, b) => (b[1].error + b[1].warning) - (a[1].error + a[1].warning))) {
    push(`| \`${code}\` | ${row.error} | ${row.warning} | ${row.info} | ${(exampleFor.get(code) ?? "").slice(0, 100)} |`);
  }
  push();

  push("## 4. Comparison against the claim");
  push();
  push("The plan's exact breakdown:");
  push();
  push("```");
  push("24  layout: Two text blocks overlap and may render unreadable");
  push("20  layout: Text is hidden beneath an opaque element");
  push("14  layout: Text extends outside its nearest visual/container box");
  push(" 3  layout: Rotating element is not spinning about its own center");
  push("```");
  push();
  push("What this run regenerates, matched by the underlying HyperFrames finding `code` (not by message text), error severity only:");
  push();
  push("| category | plan count | regenerated count |  |");
  push("|---|---|---|---|");
  let regenTotal = 0;
  const regenByCategory = new Map<string, number>();
  for (const cat of PLAN_CATEGORIES) {
    const n = ran.reduce((sum, r) => sum + r.findings.filter((f) => f.code === cat.code && f.severity === "error").length, 0);
    regenByCategory.set(cat.code, n);
    regenTotal += n;
  }
  const planTotals: Record<string, number> = {content_overlap: 24, text_occluded: 20, text_box_overflow: 14, rotation_pivot_drift: 3};
  for (const cat of PLAN_CATEGORIES) {
    const n = regenByCategory.get(cat.code) ?? 0;
    const p = planTotals[cat.code] ?? 0;
    push(`| ${cat.label} | ${p} | ${n} | ${n === p ? "match" : n > p ? `+${n - p}` : `${n - p}`} |`);
  }
  push(`| **total** | **61** | **${regenTotal}** | ${regenTotal === 61 ? "**match**" : `**${regenTotal - 61 >= 0 ? "+" : ""}${regenTotal - 61}**`} |`);
  push();
  const otherLayoutErrors = ran.reduce(
    (sum, r) => sum + r.findings.filter(
      (f) => f.severity === "error" && f.message.startsWith("layout:")
        && !PLAN_CATEGORIES.some((c) => c.code === f.code),
    ).length,
    0,
  );
  push(
    `Layout-sourced errors seen outside the plan's four named categories (e.g. \`clipped_text\`, `
    + `\`off_pivot_rotation\`, other codes the HyperFrames layout audit emits): **${otherLayoutErrors}**. `
    + "These are real findings this checker produced on these files; the plan's taxonomy does not "
    + "have a slot for them, so they are reported here and left out of the 61-comparison above "
    + "rather than folded into one side or the other.",
  );
  push();
  push(
    "**Important scope caveat.** This reconstructs only what survives on disk: the failed "
    + "attempts that were frozen, plus each family's final state. It is **not** the full error "
    + "history of either run's repair loop — a family that passed on attempt 1 (both portraits "
    + "did) left nothing frozen at all, and every *passing* intermediate state in the landscape "
    + "repair loop was overwritten by the next attempt before being checked here. So this total "
    + "is a lower bound on \"every blocking error across the two runs\" if the claim means every "
    + "error surfaced during composition, and a same-scale comparison only if the claim means "
    + "errors present in the artifacts that happen to still exist. The claim's own text does not "
    + "say which.",
  );
  push();

  const verdict = regenTotal === 61
    ? `**Verdict: 61 of 61 reproduces exactly** from the compositions still on disk — ${regenTotal} error(s) in the plan's four geometry categories, matching the claim's total, though see the shape/scope caveats above.`
    : `**Verdict: 61 does not reproduce.** The regenerated total from every composition still on disk is **${regenTotal}**, not 61 (${regenTotal > 61 ? `${regenTotal - 61} more` : `${61 - regenTotal} fewer`}), and the per-category shape ${
      PLAN_CATEGORIES.every((c) => regenByCategory.get(c.code) === planTotals[c.code]) ? "matches" : "differs from"
    } what the plan reports. This does not mean the original 61 was fabricated — the checker only sees what survived on disk, and the scope caveat above is real — but the number in the plan cannot be independently confirmed from what this repository still has, and should not be repeated as measured until it can be.`;
  push(`## 5. Verdict`);
  push();
  push(verdict);
  push();

  push("## 6. Two-party collisions: does the checker record both parties?");
  push();
  push(
    "`content_overlap` and `text_occluded` are inherently two-element findings — something "
    + "overlapped or hid the flagged text. `check.ts`'s own `runHyperframesCheck` maps the "
    + "HyperFrames CLI's raw JSON onto `CheckFinding`, and copies `selector`, `bbox`/`rect`, "
    + "`time`, `code`, `message` — **but never reads `containerSelector`**, even though the "
    + "raw JSON has it on every `content_overlap` and `text_occluded` finding. So: **the "
    + "checker does know both parties — the loss happens one layer up, in `check.ts`, not in "
    + "the HyperFrames CLI it wraps.** Nothing downstream of `checkComposition` (the studio "
    + "log, the repair prompt, `data/threads/*.json`) ever sees the second party's identity, "
    + "which is exactly why `scripts/error-geography.ts` could reconstruct only one occlusion/"
    + "overlap pair end-to-end, from incidental prose in a repair turn.",
  );
  push();
  push(
    "What the raw JSON does **not** carry, even so: the second party's own bounding box. "
    + "`overlapIssue`/`occludedTextIssue` (`node_modules/hyperframes/dist/commands/"
    + "layout-audit.browser.js`) set `rect` to the *flagged* element's box only; "
    + "`containerSelector` is a bare CSS selector string. So the flagged element's zone below is "
    + "computed from its own measured rect (precise); the other party's zone is inferred from "
    + "its selector's leaf class against the same chrome-class table `error-geography.ts` uses "
    + "(kicker/section-number/brand-seal/rail-rule → masthead, folio → foot, brand-rail/"
    + "rail-lockup/signal-spine/spine-line/spine-node → rail, caption-page/word → reported "
    + "separately as caption, anything else → middle) — a class-name heuristic, not a "
    + "measurement, and weaker evidence than the flagged side's own rect.",
  );
  push();

  const allTwoParty = ran.flatMap((r) => r.twoParty);
  push(`Two-party findings recovered this way, across every job whose raw pass succeeded: **${allTwoParty.length}** (${allTwoParty.filter((f) => f.severity === "error").length} error, ${allTwoParty.filter((f) => f.severity === "warning").length} warning, ${allTwoParty.filter((f) => f.severity !== "error" && f.severity !== "warning").length} other severity, some findings repeated across the seek grid — see \`occurrences\` is not deduplicated here).`);
  push();
  push("| job | code | severity | flagged element (own rect) | zone | other party (`containerSelector`, class-based) | zone |");
  push("|---|---|---|---|---|---|---|");
  for (const r of ran) {
    for (const f of r.twoParty) {
      push(
        `| \`${r.job.key}\` | ${f.code} | ${f.severity} | \`${f.selector}\` | **${f.selectorZone}** | `
        + `\`${f.containerSelector}\` | **${f.containerZone}** |`,
      );
    }
  }
  push();

  push("### 6a. Frame vs. middle, for the flagged party (measured from its own rect)");
  push();
  const zoneTally = (side: "selectorZone" | "containerZone") => {
    const tally = new Map<string, number>();
    for (const f of allTwoParty) tally.set(f[side], (tally.get(f[side]) ?? 0) + 1);
    return tally;
  };
  const flaggedTally = zoneTally("selectorZone");
  const otherTally = zoneTally("containerZone");
  const isFrameZone = (zone: string) => zone === "rail" || zone === "masthead" || zone === "foot";
  const frameCount = (t: Map<string, number>) =>
    [...t.entries()].reduce((sum, [zone, n]) => sum + (isFrameZone(zone) ? n : 0), 0);
  push("| zone | flagged party (measured) | other party (class-inferred) |");
  push("|---|---|---|");
  for (const zone of ["rail", "masthead", "foot", "caption", "middle"]) {
    push(`| ${zone} | ${flaggedTally.get(zone) ?? 0} | ${otherTally.get(zone) ?? 0} |`);
  }
  push();
  push(
    `Flagged party: **${frameCount(flaggedTally)} of ${allTwoParty.length}** `
    + `(${pct(frameCount(flaggedTally), allTwoParty.length)}) sit in a frame zone by their own `
    + "measured rect.",
  );
  push(
    `Other party (class-inferred): **${frameCount(otherTally)} of ${allTwoParty.length}** `
    + `(${pct(frameCount(otherTally), allTwoParty.length)}) sit in a frame zone by selector `
    + "class; the rest, including everything classified `caption` or `middle`, sit outside the "
    + "three zones a frame-only contract would reserve.",
  );
  push();
  const crossZone = allTwoParty.filter((f) => isFrameZone(f.selectorZone) !== isFrameZone(f.containerZone));
  push(
    `**Cross-zone collisions** (one party in a frame zone, the other not): **${crossZone.length} `
    + `of ${allTwoParty.length}**. A frame-only region contract pins one party in each of these `
    + "and has no jurisdiction over the other — the same structural gap "
    + "`docs/error-geography.md` §4/§6 describes from the one log-reconstructable case, now seen "
    + "directly in the checker's own (still incomplete — no second rect) data rather than "
    + "inferred from repair-turn prose.",
  );
  push();

  push("## 7. What could not be determined");
  push();
  push(
    "- **The exact 61 of the original claim**, as a like-for-like reproduction — see the scope "
    + "caveat in §4. Only the compositions that still exist on disk (failed, frozen attempts "
    + "plus final states) could be re-checked; every passing intermediate state either run's "
    + "repair loop produced before its last attempt is gone.",
  );
  push(
    "- **The other party's own bounding box**, for every two-party finding. The HyperFrames CLI "
    + "records its identity (`containerSelector`) but never its geometry for `content_overlap`/"
    + "`text_occluded` — only for the unrelated overflow codes (`text_box_overflow`, "
    + "`container_overflow`, `canvas_overflow`), which carry a full `containerRect` because "
    + "there the \"container\" is a structural ancestor, not a second colliding element. Getting "
    + "a real second rect for overlap/occlusion would need a HyperFrames change, not a studio-side one.",
  );
  push(
    "- **`2026-08-05-ship-thought-codex-9722`** was not checked here at all — out of the scope "
    + "this investigation was given (the two named runs) and ambiguous on its own terms (composer "
    + "`unknown`, both formats failed outright). It has 4 stored attempts including, unlike the "
    + "two runs above, at least one **portrait** failure — worth a follow-up run with this same "
    + "script if the portrait side of the geometry claim ever needs corroboration.",
  );
  push();

  await fs.writeFile(MD_OUT, lines.join("\n") + "\n", "utf8");
  console.log(`\nwrote ${rel(MD_OUT)}`);
  console.log(`regenerated total (plan's 4 categories, error severity): ${regenTotal} vs. claimed 61`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
