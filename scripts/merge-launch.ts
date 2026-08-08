/**
 * One-off: build the owner's hand-picked merge of the two launch-day videos.
 *
 *   npm run merge-launch -- plan              build the merged plan and narrate one take
 *   npm run merge-launch -- render <family>   check, emit and render an already-spliced family
 *
 * Six scenes come from V1 and two from V2, in an order the owner specified. The
 * compositions are spliced by hand rather than re-authored, so this script deliberately
 * never calls a composer: `plan` stops after narration, and `render` starts from three
 * files that already exist under `spliced/<family>/`.
 *
 * Keeping the spliced files outside the workdir is what makes `render` repeatable:
 * `prepareAuthoringDir` rebuilds the shell from scratch every run, so the authored files
 * are copied in afterwards rather than living somewhere it would overwrite.
 *
 * The narration is one fresh continuous take, not the two source takes cut together.
 * Per AGENTS.md, per-line assembly caused audible speaker drift and is only a fallback,
 * and the two sources are separate takes recorded an hour apart with different scripts.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {loadBrandKit} from "../src/core/brand/kit.ts";
import {
  FPS,
  prepareAuthoringDir,
  sectionSnapshotTimes,
} from "../src/core/compose/workdir.ts";
import {approvedStatements, readFacts} from "../src/core/knowledge/facts.ts";
import {assertPlanClaimsAreSourced} from "../src/core/plan/claims.ts";
import {byFamily, type FormatFamily, type OutputFormat} from "../src/core/plan/formats.ts";
import {loadPlan, planDurationMs, savePlan, type VideoPlan} from "../src/core/plan/schema.ts";
import {ROOT, OUT_DIR, rel, videoDir} from "../src/core/paths.ts";
import {buildContactSheet, buildCover} from "../src/core/render/artifacts.ts";
import {checkComposition, formatFindings} from "../src/core/render/check.ts";
import {emitFormat, renderSnapshots, renderVideo} from "../src/core/render/hyperframes.ts";
import {runQc, writeQc} from "../src/core/render/qc.ts";
import {buildCaptions} from "../src/core/tts/captions.ts";
import {narrate} from "../src/core/tts/narrate.ts";
import "../src/core/tts/gemini.ts";

await loadEnv();

const VIDEO_ID = "2026-08-08-launch-day-merge-claude-m1x8";
const V1 = "2026-08-07-myherald-launch-day-claude-2d30";
const V2 = "2026-08-07-launch-day-approval-gate-claude-96d7";
const COMPOSITION_FILES = ["index.html", "styles.css", "animation.js"] as const;

/** The owner's order. `from` names which source video the section is lifted out of. */
const ORDER: {from: "v1" | "v2"; id: string}[] = [
  {from: "v1", id: "its-live"},
  {from: "v2", id: "what-the-day-costs"},
  {from: "v2", id: "faster-is-not-the-fix"},
  {from: "v1", id: "what-it-is"},
  {from: "v1", id: "verified"},
  {from: "v1", id: "who-its-for"},
  {from: "v1", id: "you-approve"},
  {from: "v1", id: "close"},
];

const command = process.argv[2] ?? "plan";
const dir = videoDir(VIDEO_ID);

if (command === "plan") {
  const v1 = await loadPlan(path.join(videoDir(V1), "plan.json"));
  const v2 = await loadPlan(path.join(videoDir(V2), "plan.json"));
  const byId = (plan: VideoPlan) => new Map(plan.sections.map((section) => [section.id, section]));
  const source = {v1: byId(v1), v2: byId(v2)};

  const sections = ORDER.map(({from, id}) => {
    const section = source[from].get(id);
    if (!section) throw new Error(`no section "${id}" in ${from}`);
    // Timings are zeroed rather than carried over: they came from a video whose running
    // order was different, and the audio is what decides them.
    return {
      ...section,
      startMs: 0,
      durationMs: 0,
      phrases: section.phrases.map((phrase) => ({...phrase, startMs: 0, durationMs: 0})),
    };
  });

  const plan: VideoPlan = {
    ...v1,
    id: VIDEO_ID,
    createdAt: "2026-08-08T00:00:00.000Z",
    title: "Launch day merge",
    thesis: "myHERALD is available today, and the case for it is what doing content by hand"
      + " actually costs: most of a working day, while publishing faster only ships work you"
      + " already know is off-brand.",
    brief: "The owner's hand-picked merge: V1's announcement and product scenes, with V2's"
      + " two evidence scenes inserted after the opening.",
    sections,
  };

  await fs.mkdir(dir, {recursive: true});
  await savePlan(plan, path.join(dir, "plan.draft.json"));

  // The same gate the pipeline runs. Both figures are approved and evidenced, so this
  // should pass, but a merge that quietly dropped a citation is what it exists to catch.
  const kit = await loadBrandKit();
  const facts = await readFacts();
  const knowledge = await approvedStatements(facts, kit.website);
  assertPlanClaimsAreSourced(plan, facts, knowledge, kit.website);
  console.log(
    `claims        ok · ${sections.length} sections · `
    + `${sections.reduce((total, section) => total + section.phrases.length, 0)} phrases`,
  );

  const narration = await narrate(plan, dir, (line) => console.log(line));
  await savePlan(narration.plan, path.join(dir, "plan.json"));
  console.log(`timing        ${(planDurationMs(narration.plan) / 1000).toFixed(2)}s measured from narration`);
  console.log(`narration     ${rel(narration.masterPath)}`);
  console.log("");
  console.log(`Next: put the spliced files in ${rel(path.join(dir, "spliced", "portrait"))}, then`);
  console.log("  npm run merge-launch -- render portrait");
  process.exit(0);
}

if (command === "render") {
  const family = (process.argv[3] ?? "portrait") as FormatFamily;
  const plan = await loadPlan(path.join(dir, "plan.json"));
  const kit = await loadBrandKit();
  const authoringDir = path.join(dir, "work", family);
  const splicedDir = path.join(dir, "spliced", family);

  const narrationPath = path.join(dir, "narration-narration-loudnorm-v2.m4a");
  const authoring = await prepareAuthoringDir({
    plan,
    kit,
    family,
    dir: authoringDir,
    narrationPath,
  });

  for (const file of COMPOSITION_FILES) {
    await fs.copyFile(path.join(splicedDir, file), path.join(authoringDir, file));
  }
  console.log(`spliced       ${COMPOSITION_FILES.join(", ")} copied into ${rel(authoringDir)}`);

  const report = await checkComposition({
    dir: authoringDir,
    plan,
    kit,
    family,
    fps: FPS,
    onLog: (line) => console.log(line),
  });
  const findings = formatFindings(report);
  if (findings.trim()) console.log(findings);
  if (!report.ok) {
    console.error(`\ncheck FAILED with ${report.errorCount} error(s). Fix the splice, then re-run.`);
    process.exit(1);
  }
  console.log(`check         clean`);

  const durationMs = planDurationMs(plan);
  const formats = (byFamily(plan.formats).get(family) ?? []) as OutputFormat[];
  const outDir = path.join(OUT_DIR, VIDEO_ID);
  await fs.mkdir(outDir, {recursive: true});

  let cover: string | null = null;
  let contactSheet: string | null = null;
  const results: {format: OutputFormat; path: string; passed: boolean}[] = [];

  for (const format of formats) {
    const renderDir = path.join(dir, "render", format);
    await emitFormat(authoringDir, format, renderDir);
    const outPath = path.join(outDir, `master-${format}.mp4`);
    await renderVideo({dir: renderDir, outputPath: outPath, quality: "high"});

    const frames = await renderSnapshots({
      dir: renderDir,
      durationSeconds: authoring.durationSeconds,
      at: sectionSnapshotTimes(plan),
      outputDir: path.join(renderDir, "snapshots"),
    });
    if (frames.length && format === formats[0]) {
      contactSheet = await buildContactSheet(frames, path.join(outDir, "contact-sheet.png"));
      cover = await buildCover(frames, path.join(outDir, "cover.png"));
    }

    const qc = await runQc({
      videoPath: outPath,
      format,
      expectedDurationMs: durationMs,
      fps: FPS,
      captions: buildCaptions(plan),
      coverPath: cover ?? undefined,
    });
    await writeQc(qc, path.join(outDir, `qc-${format}.json`));
    console.log(`render        ${format} · qc ${qc.passed ? "passed" : "FAILED"} · ${rel(outPath)}`);
    results.push({format, path: outPath, passed: qc.passed});
  }

  if (contactSheet) console.log(`contact sheet ${rel(contactSheet)}`);
  if (results.some((result) => !result.passed)) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}

console.error(`Unknown command "${command}". Use "plan" or "render <family>".`);
process.exit(1);

async function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    const raw = await fs.readFile(path.join(ROOT, file), "utf8").catch(() => null);
    if (!raw) continue;
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!match?.[1]) continue;
      const value = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
      if (value && !process.env[match[1]]) process.env[match[1]] = value;
    }
  }
}
