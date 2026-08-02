import fs from "node:fs/promises";
import path from "node:path";
import {loadBrandKit} from "../brand/kit.ts";
import {renderTokensCss} from "../brand/tokens.ts";
import {writeBaselineComposition} from "../compose/baseline.ts";
import {FPS, prepareAuthoringDir, sectionReviewTimes, sectionSnapshotTimes} from "../compose/workdir.ts";
import {
  COMPOSITION_FILES,
  composerFor,
  visualReviewRequest,
  type ComposeResult,
} from "../gen/composer.ts";
import {CostLedger, formatCost, type CostSummary} from "../cost.ts";
import {planVideo, type PlannerId} from "../gen/planner.ts";
import {approvedStatements, readFacts} from "../knowledge/facts.ts";
import {isCancellation, throwIfCancelled} from "../cancel.ts";
import {factUsage, upsertLedgerEntry, similarTheses} from "../ledger.ts";
import {aspectOf, DEVICE_PRESETS, mediaForFormat, mediaForPlan} from "../media/library.ts";
import {assertPlanClaimsAreSourced, factIdsUsedByPlan} from "../plan/claims.ts";
import {byFamily, FORMATS, type OutputFormat} from "../plan/formats.ts";
import type {ContentLanguage} from "../plan/language.ts";
import {
  narrationProfileForIntent,
  planDurationMs,
  savePlan,
  type Intent,
  type NarrationProfileId,
  type VideoPlan,
} from "../plan/schema.ts";
import {OUT_DIR, rel, videoDir} from "../paths.ts";
import {buildContactSheet, buildCover, writeProvenance} from "../render/artifacts.ts";
import {checkComposition, formatFindings, type CheckReport} from "../render/check.ts";
import {emitFormat, renderSnapshots, renderVideo, type Quality} from "../render/hyperframes.ts";
import {composerFixableFailures, runQc, writeQc, type QcReport} from "../render/qc.ts";
import {buildCaptions} from "../tts/captions.ts";
import {measureRhythm} from "../plan/rhythm.ts";
import {narrate} from "../tts/narrate.ts";
import {hash} from "../util/exec.ts";
import {readSettings} from "../settings.ts";
import {marketingGuidanceFor} from "../marketing/guidance.ts";

// Registering the adapters here is what keeps every seam swappable from one place.
import "../gen/claudeComposer.ts";
import "../gen/codexComposer.ts";
import "../tts/gemini.ts";

export const MAX_REPAIR_ATTEMPTS = 3;

export interface RunOptions {
  brief: string;
  intent: Intent;
  narrationProfile?: NarrationProfileId;
  formats: OutputFormat[];
  language: ContentLanguage;
  plannerId: PlannerId;
  composerId: string;
  quality: Quality;
  /** Skip the model and use the deterministic diagnostic composition. */
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
  // Reject incompatible intent/profile combinations before planning or TTS.
  const narrationProfile = narrationProfileForIntent(options.intent, options.narrationProfile);
  const kit = await loadBrandKit();
  const settings = await readSettings();
  const marketingGuidance = marketingGuidanceFor(settings, options.intent, narrationProfile);
  const videoId = `${options.intent}-${hash({brief: options.brief, narrationProfile, at: Date.now()}, 6)}`;
  const dir = videoDir(videoId);
  await fs.mkdir(dir, {recursive: true});

  const ledger = new CostLedger();
  let usedBaseline = Boolean(options.baselineOnly);

  // 1 — plan, informed by approved facts and what already exists.
  const facts = await readFacts();
  const knowledge = await approvedStatements();
  const usage = await factUsage();
  const prior = await similarTheses(options.brief);
  if (prior.length) {
    log(`ledger        ${prior.length} related video(s): ${prior.map((entry) => entry.id).join(", ")}`);
  }

  log(`plan          ${options.intent} · ${narrationProfile} · ${options.formats.join(", ")} · ${options.language}`);
  const planned = await planVideo(
    {
      id: videoId,
      brief: options.brief,
      intent: options.intent,
      narrationProfile,
      formats: options.formats,
      language: options.language,
      kit,
      priorTheses: prior.map((entry) => ({id: entry.id, thesis: entry.thesis})),
      knowledge,
      // Ids as well as sentences: a chart cites a fact, and citing needs an id. Filtered
      // to approved-with-evidence here so the planner is never shown a figure it would
      // then be refused for using.
      citableFacts: facts
        .filter((fact) => fact.state === "approved" && fact.evidence.trim().length > 0)
        .map((fact) => ({
          id: fact.id,
          statement: fact.statement,
          source: fact.source,
          used: usage.get(fact.id),
        })),
      media: (await mediaForFormat(options.formats[0] ?? "9x16")).map((item) => ({
        id: item.id,
        aspect: aspectOf(item),
        // The device it was captured on, not just the shape. "Phone, portrait" and
        // "Tablet, portrait" are both portrait and are not interchangeable — a section
        // about a mobile flow needs the phone shot specifically.
        device: item.source.type === "playwright"
          ? DEVICE_PRESETS[item.source.preset]?.label ?? item.source.preset
          : "uploaded",
        caption: item.caption,
        tags: item.tags,
      })),
      plannerId: options.plannerId,
      marketingGuidance,
    },
    log,
    options.signal,
  );
  if (options.plannerId === "codex") {
    ledger.free("codex", "plan", "covered by the local ChatGPT subscription");
  } else {
    ledger.model("claude", "plan", planned.costUsd);
  }
  log(`plan          "${planned.plan.thesis}"`);
  log(`plan          ${planned.plan.sections.length} sections · ${planned.plan.sections.reduce((sum, section) => sum + section.phrases.length, 0)} phrases`);
  await savePlan(planned.plan, path.join(dir, "plan.draft.json"));

  // Fail here, before a narration take and a twenty-minute compose, if the plan states a
  // figure nothing approved backs. The draft is already on disk, so the rejected plan is
  // readable rather than lost — the fix is usually to approve a fact, not to re-plan.
  assertPlanClaimsAreSourced(planned.plan, facts, knowledge);

  // 2 — narrate, then rebuild every timestamp from the audio that actually exists.
  // Checked between every stage, because each one is minutes long and a cancel that only
  // takes effect at the end of the current stage is not a cancel the owner can feel.
  throwIfCancelled(options.signal, "planning");
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
  throwIfCancelled(options.signal, "narration");
  const outputs: RunResult["outputs"] = [];
  let composeResult: ComposeResult | null = null;
  let attemptsUsed = 0;
  let contactSheet: string | null = null;
  let cover: string | null = null;

  // Resolve every screenshot the plan asked for once, before any family. A missing one is
  // reported rather than ignored: the composer would write an `<img>` at a path with no
  // file behind it, which renders as an empty panel and passes every check we have.
  const media = await mediaForPlan(plan.sections);
  if (media.files.length) log(`media         ${media.files.length} item(s) bound: ${media.files.map((file) => file.id).join(", ")}`);
  if (media.missing.length) {
    log(`media         MISSING ${media.missing.join(", ")} — no approved library item with that id;`
      + " those sections will have no image");
  }

  for (const [family, formats] of byFamily(plan.formats)) {
    const authoringDir = path.join(dir, "work", family);
    await fs.mkdir(authoringDir, {recursive: true});
    const authoring = await prepareAuthoringDir({
      plan,
      kit,
      family,
      dir: authoringDir,
      narrationPath: narration.masterPath,
      mediaFiles: media.files,
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
      // Each format is its own render. Cancelling during the first of four must not sit
      // through the other three.
      throwIfCancelled(options.signal, "render");
      let rendered = await renderAndQc(format);

      // Some defects only exist in the finished file — a held still frame is the
      // common one. The composer never saw those findings, so give it exactly one
      // chance to act on them before accepting the result.
      const fixable = composerFixableFailures(rendered.qc);
      if (fixable.length && qcRepairsLeft > 0 && !options.signal?.aborted) {
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
      planner: {provider: options.plannerId, model: planned.model},
      marketingGuidance: marketingGuidance.ids,
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
        profileId: narration.profileId,
        timingTreatment: narration.timingTreatment,
        sectionGapMs: narration.sectionGapMs,
        sectionGapsShortened: narration.sectionGapsShortened,
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
    // Recorded at the one moment the plan and the finished file are both in hand, and it is
    // what stops the next video reaching for the same figure. Deduped: a fact charted in two
    // sections of one video is still one video.
    factIds: factIdsUsedByPlan(plan, facts),
    outputs: outputs.map((output) => ({format: output.format, path: rel(output.path)})),
  });

  ledger.free("hyperframes", "render", "local render; machine time and electricity excluded");
  const cost = ledger.summary();
  log(`cost          ${formatCost(cost)}`);
  return {videoId, plan, outputs, contactSheet, cover, cost, usedBaseline};
}

/**
 * Compose, validate, and repair with a minimal diff. After the budget is exhausted the
 * attempt is frozen for inspection and the run stops. A deliberately plain diagnostic
 * baseline must never masquerade as the model's finished visual work.
 */
/**
 * Exported so an existing video can be re-authored without re-planning and re-narrating
 * it. Changing the shape of a composition is the one edit `plan-apply` cannot do, and
 * re-running the whole pipeline to see a motion change also changes the script and the
 * voice — which is precisely the comparison you were trying to make.
 */
export async function composeWithRepair(options: {
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
  const check = () => checkComposition({dir: authoring.dir, plan, kit, family, fps: FPS, onLog: log});

  if (baselineOnly) {
    log("compose       baseline (deterministic fallback requested)");
    await writeBaselineComposition(authoring, plan, kit);
    const baselineReport = await check();
    await reportCheck(baselineReport, log, "baseline");
    if (!baselineReport.ok) {
      throw new Error(
        `The requested baseline composition failed validation with `
        + `${baselineReport.errorCount} error(s). Nothing was rendered.`,
      );
    }
    return {result: null, costUsd: 0, attempts: 0, usedBaseline: true};
  }

  const composer = composerFor(composerId);
  log(`compose       ${composer.label} · ${family} ${authoring.width}×${authoring.height}`);

  let result: ComposeResult | null = null;
  let costUsd = 0;
  let report: CheckReport | null = null;
  let visualReviewed = false;

  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS + 1; attempt++) {
    const context = {
      authoring,
      onLog: log,
      signal,
      effort: attempt === 1 ? ("default" as const) : ("high" as const),
    };

    // Before spending an attempt, not only after. The budget is three repairs and each one
    // is a model session, so a run cancelled during attempt two must not open attempt three.
    throwIfCancelled(signal, "compose");

    try {
      result = attempt === 1 || !report
        ? await composer.compose(context)
        : await composer.repair(context, report, attempt - 1, report.evidencePaths);
      costUsd += result.costUsd;
    } catch (error) {
      // A cancelled attempt is not a failed one. Retrying it was the bug: cancelling left
      // this loop composing for an hour, opening a fresh session every few seconds, because
      // the abort surfaced here as an ordinary error and `continue` did what it says.
      if (isCancellation(error)) throw error;
      log(`compose       attempt ${attempt} failed: ${(error as Error).message}`);
      await freezeAttempt(authoring.dir, attempt);
      continue;
    }

    report = await check();
    await reportCheck(report, log, `attempt ${attempt}`);
    if (report.ok) {
      if (!visualReviewed) {
        // The model sandboxes intentionally do not own the browser process. Rendering here
        // gives Claude and Codex the same frames from the same HyperFrames/Node runtime;
        // only the transport differs (Claude Read versus Codex --image).
        for (let visualPass = 1; visualPass <= 2; visualPass++) {
          throwIfCancelled(signal, "visual review");
          const evidenceDir = path.join(authoring.dir, ".visual-review");
          await fs.rm(evidenceDir, {recursive: true, force: true});
          const frames = await renderSnapshots({
            dir: authoring.dir,
            durationSeconds: authoring.durationSeconds,
            at: sectionReviewTimes(plan),
            outputDir: path.join(evidenceDir, "frames"),
            onLog: (line) => log(`  snapshots    ${line}`),
          });
          const expected = plan.sections.filter((section) => section.durationMs > 0).length * 2;
          if (frames.length !== expected) {
            throw new Error(
              `Visual review produced ${frames.length} section frame(s); expected ${expected}.`,
            );
          }
          const contactSheet = await buildContactSheet(
            frames,
            path.join(evidenceDir, "contact-sheet.png"),
          );
          if (!contactSheet) throw new Error("Visual review could not build a contact sheet.");

          const before = await compositionFingerprint(authoring.dir);
          log(`visual        ${composer.label} · pass ${visualPass} · ${frames.length} section frame(s)`);
          const reviewed = await composer.review(
            {...context, effort: "high"},
            visualReviewRequest(authoring, [contactSheet, ...frames]),
          );
          costUsd += reviewed.costUsd;
          result = combineComposeResults(result, reviewed);

          const changed = before !== await compositionFingerprint(authoring.dir);
          log(`visual        ${changed ? "composition adjusted" : "approved without edits"}`);
          report = await check();
          await reportCheck(report, log, `visual review ${visualPass}`);
          if (!report.ok || !changed) break;
          if (visualPass === 1) log("visual        rendering the adjusted composition for confirmation");
        }

        if (!report.ok) {
          await freezeAttempt(authoring.dir, attempt);
          if (attempt <= MAX_REPAIR_ATTEMPTS) {
            log(`compose       repairing visual-review edits (${report.errorCount} error${report.errorCount === 1 ? "" : "s"})`);
          }
          continue;
        }
        visualReviewed = true;
      }
      if (result.notes) log(`compose       ${result.notes.split("\n")[0]}`);
      return {result, costUsd, attempts: attempt, usedBaseline: false};
    }

    await freezeAttempt(authoring.dir, attempt);
    if (attempt <= MAX_REPAIR_ATTEMPTS) {
      log(`compose       repairing (${report.errorCount} error${report.errorCount === 1 ? "" : "s"})`);
    }
  }

  // Do not convert either cancellation or exhausted creative work into a different design.
  throwIfCancelled(signal, "compose");
  throw new Error(
    `The ${composer.label} composition still failed validation after `
    + `${MAX_REPAIR_ATTEMPTS + 1} attempt(s) (${report?.errorCount ?? "unknown"} remaining `
    + `error(s)). The last attempt was kept for inspection; no fallback video was rendered.`,
  );
}

async function compositionFingerprint(dir: string): Promise<string> {
  const files = await Promise.all(COMPOSITION_FILES.map(async (file) => ({
    file,
    body: await fs.readFile(path.join(dir, file), "utf8"),
  })));
  return hash(files);
}

function combineComposeResults(
  authored: ComposeResult | null,
  reviewed: ComposeResult,
): ComposeResult {
  if (!authored) return reviewed;
  return {
    provider: reviewed.provider,
    model: reviewed.model,
    turns: authored.turns + reviewed.turns,
    costUsd: authored.costUsd + reviewed.costUsd,
    notes: [authored.notes, reviewed.notes].filter(Boolean).join("\n"),
  };
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
