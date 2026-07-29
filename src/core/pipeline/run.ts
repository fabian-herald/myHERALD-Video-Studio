import fs from "node:fs/promises";
import path from "node:path";
import {loadBrandKit} from "../brand/kit.ts";
import {renderTokensCss} from "../brand/tokens.ts";
import {writeBaselineComposition} from "../compose/baseline.ts";
import {FPS, prepareAuthoringDir, sectionSnapshotTimes} from "../compose/workdir.ts";
import {composerFor, type ComposeResult} from "../gen/composer.ts";
import {CostLedger, formatCost, type CostSummary} from "../cost.ts";
import {planVideo} from "../gen/planner.ts";
import {approvedStatements} from "../knowledge/facts.ts";
import {upsertLedgerEntry, similarTheses} from "../ledger.ts";
import {byFamily, FORMATS, type OutputFormat} from "../plan/formats.ts";
import type {ContentLanguage} from "../plan/language.ts";
import {planDurationMs, savePlan, type Intent, type VideoPlan} from "../plan/schema.ts";
import {OUT_DIR, rel, videoDir} from "../paths.ts";
import {buildContactSheet, buildCover, writeProvenance} from "../render/artifacts.ts";
import {checkComposition, formatFindings, type CheckReport} from "../render/check.ts";
import {emitFormat, renderSnapshots, renderVideo, type Quality} from "../render/hyperframes.ts";
import {composerFixableFailures, runQc, writeQc, type QcReport} from "../render/qc.ts";
import {buildCaptions} from "../tts/captions.ts";
import {measureRhythm} from "../plan/rhythm.ts";
import {narrate} from "../tts/narrate.ts";
import {hash} from "../util/exec.ts";

// Registering the adapters here is what keeps every seam swappable from one place.
import "../gen/claudeComposer.ts";
import "../gen/codexComposer.ts";
import "../tts/gemini.ts";

export const MAX_REPAIR_ATTEMPTS = 3;

export interface RunOptions {
  brief: string;
  intent: Intent;
  formats: OutputFormat[];
  language: ContentLanguage;
  composerId: string;
  quality: Quality;
  /** Skip the model and use the deterministic fallback composition. */
  baselineOnly?: boolean;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

export interface RunResult {
  videoId: string;
  plan: VideoPlan;
  outputs: {format: OutputFormat; path: string; qc: QcReport}[];
  contactSheet: string | null;
  cover: string | null;
  cost: CostSummary;
  usedBaseline: boolean;
}

export async function runPipeline(options: RunOptions): Promise<RunResult> {
  const log = options.onLog ?? ((line: string) => console.log(line));
  const kit = await loadBrandKit();
  const videoId = `${options.intent}-${hash({brief: options.brief, at: Date.now()}, 6)}`;
  const dir = videoDir(videoId);
  await fs.mkdir(dir, {recursive: true});

  const ledger = new CostLedger();
  let usedBaseline = Boolean(options.baselineOnly);

  // 1 — plan, informed by approved facts and what already exists.
  const knowledge = await approvedStatements();
  const prior = await similarTheses(options.brief);
  if (prior.length) {
    log(`ledger        ${prior.length} related video(s): ${prior.map((entry) => entry.id).join(", ")}`);
  }

  log(`plan          ${options.intent} · ${options.formats.join(", ")} · ${options.language}`);
  const planned = await planVideo(
    {
      id: videoId,
      brief: options.brief,
      intent: options.intent,
      formats: options.formats,
      language: options.language,
      kit,
      priorTheses: prior.map((entry) => ({id: entry.id, thesis: entry.thesis})),
      knowledge,
    },
    log,
    options.signal,
  );
  ledger.model(planned.model.split("-")[0] ?? "claude", "plan", planned.costUsd);
  log(`plan          "${planned.plan.thesis}"`);
  log(`plan          ${planned.plan.sections.length} sections · ${planned.plan.sections.reduce((sum, section) => sum + section.phrases.length, 0)} phrases`);
  await savePlan(planned.plan, path.join(dir, "plan.draft.json"));

  // 2 — narrate, then rebuild every timestamp from the audio that actually exists.
  const narration = await narrate(planned.plan, dir, log, options.signal);
  if (narration.costUsd > 0) ledger.metered("gemini", "narrate", narration.costUsd);
  else ledger.free("gemini", "narrate", `${narration.clipCount} phrases on the free tier; Google's quota records are authoritative`);
  const plan = narration.plan;
  await savePlan(plan, path.join(dir, "plan.json"));
  const durationMs = planDurationMs(plan);
  log(`timing        ${(durationMs / 1000).toFixed(2)}s measured from narration`);

  // Reported, never blocking. Whether a piece is too even is a judgement the owner
  // makes, but the numbers behind it are measurable and worth putting in front of them.
  const rhythm = measureRhythm(plan);
  log(
    `rhythm        lines ${(rhythm.shortestMs / 1000).toFixed(1)}s to ${(rhythm.longestMs / 1000).toFixed(1)}s`
    + ` · variation ${rhythm.variation} · energy ${rhythm.energies.join(", ")}`,
  );
  for (const note of rhythm.notes) log(`rhythm        ${note.split(". ")[0]}.`);

  // 3 — compose once per format family, then re-emit per format.
  const outputs: RunResult["outputs"] = [];
  let composeResult: ComposeResult | null = null;
  let attemptsUsed = 0;
  let contactSheet: string | null = null;
  let cover: string | null = null;

  for (const [family, formats] of byFamily(plan.formats)) {
    const authoringDir = path.join(dir, "work", family);
    await fs.mkdir(authoringDir, {recursive: true});
    const authoring = await prepareAuthoringDir({
      plan,
      kit,
      family,
      dir: authoringDir,
      narrationPath: narration.masterPath,
    });

    const composed = await composeWithRepair({
      authoring,
      plan,
      kit,
      family,
      composerId: options.composerId,
      baselineOnly: options.baselineOnly ?? false,
      log,
      signal: options.signal,
    });
    if (composed.costUsd > 0) ledger.model(composed.result?.provider ?? options.composerId, "compose", composed.costUsd);
    attemptsUsed = Math.max(attemptsUsed, composed.attempts);
    usedBaseline ||= composed.usedBaseline;
    composeResult = composed.result;

    // 4 — render every format in this family from the one authored composition.
    let qcRepairsLeft = composed.usedBaseline ? 0 : 1;

    for (const format of formats) {
      let rendered = await renderAndQc(format);

      // Some defects only exist in the finished file — a held still frame is the
      // common one. The composer never saw those findings, so give it exactly one
      // chance to act on them before accepting the result.
      const fixable = composerFixableFailures(rendered.qc);
      if (fixable.length && qcRepairsLeft > 0) {
        qcRepairsLeft -= 1;
        log(`qc            ${format} FAILED — ${fixable.map((item) => item.check).join(", ")}; repairing once`);
        const repaired = await repairFromQc(fixable);
        if (repaired) {
          attemptsUsed += 1;
          if (repaired.costUsd > 0) ledger.model(repaired.provider, "qc-repair", repaired.costUsd);
          rendered = await renderAndQc(format);
        }
      }

      log(`qc            ${format} ${rendered.qc.passed ? "passed" : `FAILED — ${(rendered.qc.diagnostics.failed as string[]).join(", ")}`}`);
      outputs.push({format, path: rendered.outPath, qc: rendered.qc});
    }

    async function renderAndQc(format: OutputFormat) {
      const renderDir = path.join(dir, "render", format);
      await emitFormat(authoring.dir, format, renderDir);

      const outPath = path.join(OUT_DIR, videoId, `master-${format}.mp4`);
      const spec = FORMATS[format];
      log(`render        ${format} · ${spec.width}×${spec.height} · ${options.quality}`);
      await renderVideo({dir: renderDir, outputPath: outPath, quality: options.quality});

      const frames = await renderSnapshots({
        dir: renderDir,
        durationSeconds: authoring.durationSeconds,
        at: sectionSnapshotTimes(plan),
        outputDir: path.join(renderDir, "snapshots"),
      });

      if (frames.length && (!contactSheet || format === formats[0])) {
        contactSheet = await buildContactSheet(frames, path.join(OUT_DIR, videoId, "contact-sheet.png"));
        cover = await buildCover(frames, path.join(OUT_DIR, videoId, "cover.png"));
      }

      const qc = await runQc({
        videoPath: outPath,
        format,
        expectedDurationMs: durationMs,
        fps: FPS,
        captions: buildCaptions(plan),
        coverPath: cover ?? undefined,
      });
      await writeQc(qc, path.join(OUT_DIR, videoId, `qc-${format}.json`));
      return {outPath, qc};
    }

    async function repairFromQc(fixable: {check: string; message: string}[]) {
      const composer = composerFor(options.composerId);
      const report: CheckReport = {
        ok: false,
        errorCount: fixable.length,
        warningCount: 0,
        findings: fixable.map((item) => ({
          severity: "error" as const,
          code: item.check,
          message: `post-render QC: ${item.message}`,
          source: "hyperframes" as const,
        })),
      };
      return composer
        .repair({authoring, onLog: log, signal: options.signal, effort: "high"}, report, MAX_REPAIR_ATTEMPTS + 1)
        .catch((error: unknown) => {
          log(`compose       QC repair failed: ${(error as Error).message}`);
          return null;
        });
    }
  }

  await writeProvenance(
    {
      videoId,
      createdAt: new Date().toISOString(),
      thesis: plan.thesis,
      intent: plan.intent,
      composer: {
        provider: usedBaseline ? "baseline" : composeResult?.provider ?? "unknown",
        model: composeResult?.model ?? "n/a",
        turns: composeResult?.turns ?? 0,
        attempts: attemptsUsed,
      },
      rhythm,
      narration: {
        provider: plan.narration.provider,
        model: narration.model,
        voice: plan.narration.voice,
        cloned: false,
        phrases: narration.clipCount,
      },
      visualEngine: "HyperFrames",
      hyperframesVersion: await hyperframesVersion(),
      planHash: hash(plan, 32),
      tokensHash: hash(renderTokensCss(kit), 32),
      formats: plan.formats,
      cost: ledger.summary(),
      captionAlignment: buildCaptions(plan).alignment,
      knownLimitations: [
        "No product screenshots were bound, so visuals stay conceptual by design.",
        // Only the second half of this was ever a limitation. Page boundaries are exact
        // on both narration paths; it is the placement of words inside a page that is
        // estimated, and saying otherwise understated captions that are in fact aligned.
        "Word placement within a caption page is weighted by character and punctuation, not per-word aligned.",
      ],
      outputFileHashes: Object.fromEntries(outputs.flatMap((output) => Object.entries(output.qc.hashes))),
    },
    path.join(OUT_DIR, videoId, "provenance.json"),
  );

  await upsertLedgerEntry({
    id: videoId,
    title: plan.title,
    thesis: plan.thesis,
    intent: plan.intent,
    formats: plan.formats,
    language: plan.language,
    createdAt: new Date().toISOString(),
    status: outputs.every((output) => output.qc.passed) ? "ready" : "failed",
    spokenScript: plan.sections.flatMap((section) => section.phrases.map((phrase) => phrase.text)).join(" "),
    mediaIds: [],
    outputs: outputs.map((output) => ({format: output.format, path: rel(output.path)})),
  });

  ledger.free("hyperframes", "render", "local render; machine time and electricity excluded");
  const cost = ledger.summary();
  log(`cost          ${formatCost(cost)}`);
  return {videoId, plan, outputs, contactSheet, cover, cost, usedBaseline};
}

/**
 * Compose, validate, and repair with a minimal diff. After the budget is exhausted the
 * attempt is frozen for inspection and the deterministic baseline takes over, so the
 * autopilot always produces a video rather than nothing.
 */
async function composeWithRepair(options: {
  authoring: Awaited<ReturnType<typeof prepareAuthoringDir>>;
  plan: VideoPlan;
  kit: Awaited<ReturnType<typeof loadBrandKit>>;
  family: "portrait" | "landscape";
  composerId: string;
  baselineOnly: boolean;
  log: (line: string) => void;
  signal?: AbortSignal;
}): Promise<{result: ComposeResult | null; costUsd: number; attempts: number; usedBaseline: boolean}> {
  const {authoring, plan, kit, family, composerId, baselineOnly, log, signal} = options;
  const check = () => checkComposition({dir: authoring.dir, plan, kit, family, fps: FPS});

  if (baselineOnly) {
    log("compose       baseline (deterministic fallback requested)");
    await writeBaselineComposition(authoring, plan, kit);
    await reportCheck(await check(), log, "baseline");
    return {result: null, costUsd: 0, attempts: 0, usedBaseline: true};
  }

  const composer = composerFor(composerId);
  log(`compose       ${composer.label} · ${family} ${authoring.width}×${authoring.height}`);

  let result: ComposeResult | null = null;
  let costUsd = 0;
  let report: CheckReport | null = null;

  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS + 1; attempt++) {
    const context = {
      authoring,
      onLog: log,
      signal,
      effort: attempt === 1 ? ("default" as const) : ("high" as const),
    };

    try {
      result = attempt === 1 || !report
        ? await composer.compose(context)
        : await composer.repair(context, report, attempt - 1);
      costUsd += result.costUsd;
    } catch (error) {
      log(`compose       attempt ${attempt} failed: ${(error as Error).message}`);
      await freezeAttempt(authoring.dir, attempt);
      continue;
    }

    report = await check();
    await reportCheck(report, log, `attempt ${attempt}`);
    if (report.ok) {
      if (result.notes) log(`compose       ${result.notes.split("\n")[0]}`);
      return {result, costUsd, attempts: attempt, usedBaseline: false};
    }

    await freezeAttempt(authoring.dir, attempt);
    if (attempt <= MAX_REPAIR_ATTEMPTS) {
      log(`compose       repairing (${report.errorCount} error${report.errorCount === 1 ? "" : "s"})`);
    }
  }

  log(`compose       repair budget exhausted — falling back to the baseline composition`);
  await writeBaselineComposition(authoring, plan, kit);
  await reportCheck(await check(), log, "baseline");
  return {result, costUsd, attempts: MAX_REPAIR_ATTEMPTS + 1, usedBaseline: true};
}

async function reportCheck(report: CheckReport, log: (line: string) => void, label: string) {
  log(
    `check         ${label}: ${report.ok ? "clean" : `${report.errorCount} error(s)`}`
    + `${report.warningCount ? `, ${report.warningCount} warning(s)` : ""}`,
  );
  if (!report.ok) log(formatFindings(report));
}

/** Keep every failed attempt so a regression can be inspected later. */
async function freezeAttempt(dir: string, attempt: number) {
  const target = path.join(path.dirname(path.dirname(dir)), "attempts", String(attempt));
  await fs.mkdir(target, {recursive: true});
  for (const file of ["index.html", "styles.css", "animation.js"]) {
    await fs.copyFile(path.join(dir, file), path.join(target, file)).catch(() => {});
  }
}

async function hyperframesVersion(): Promise<string> {
  const manifest = await fs
    .readFile(path.join(process.cwd(), "node_modules", "hyperframes", "package.json"), "utf8")
    .catch(() => "{}");
  return (JSON.parse(manifest) as {version?: string}).version ?? "unknown";
}
