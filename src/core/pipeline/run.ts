import fs from "node:fs/promises";
import path from "node:path";
import {loadBrandKit} from "../brand/kit.ts";
import {renderTokensCss} from "../brand/tokens.ts";
import {writeBaselineComposition} from "../compose/baseline.ts";
import {
  FPS,
  prepareAuthoringDir,
  restoreSuppliedFiles,
  sectionReviewTimes,
  sectionSnapshotTimes,
} from "../compose/workdir.ts";
import {
  COMPOSITION_FILES,
  composerFor,
  visualReviewRequest,
  type ComposeResult,
} from "../gen/composer.ts";
import {CostLedger, formatCost, type CostSummary} from "../cost.ts";
import {planVideo, type PlannerId} from "../gen/planner.ts";
import {approvedStatements, isUsableFact, readFacts} from "../knowledge/facts.ts";
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
import {renderSummary} from "../render/summary.ts";
import {checkComposition, formatFindings, type CheckReport} from "../render/check.ts";
import {autoFix} from "../render/autofix.ts";
import {emitFormat, renderSnapshots, renderVideo, type Quality} from "../render/hyperframes.ts";
import {composerFixableFailures, runQc, writeQc, type QcReport} from "../render/qc.ts";
import {buildCaptions} from "../tts/captions.ts";
import {measureRhythm} from "../plan/rhythm.ts";
import {narrate} from "../tts/narrate.ts";
import {hash} from "../util/exec.ts";
import {readSettings} from "../settings.ts";
import {marketingGuidanceFor} from "../marketing/guidance.ts";
import {Timeline} from "./timing.ts";
import {uniqueVideoId} from "./videoId.ts";
import {
  editDelta,
  isSubstantive,
  SUBSTANTIVE_LINES,
  compositionSize,
  type CompositionSize,
  type CompositionSnapshot,
} from "../gen/substance.ts";

// Registering the adapters here is what keeps every seam swappable from one place.
import "../gen/claudeComposer.ts";
import "../gen/codexComposer.ts";
import "../tts/gemini.ts";

/**
 * Repairs after the authoring pass, so four model sessions per format family, now six.
 *
 * Raised because a run died converging rather than stalling. Landscape on 9722 went 14
 * errors → 4 → 2 → 2 across its three repairs and ran out of budget two errors from a
 * shippable video; the same run's portrait went 5 → 5 → 4 → 4, which is a genuine stall and
 * would have failed at any budget. Three repairs cannot tell those two apart, and the one
 * that was working is the one that got cut off.
 *
 * The cost of the extra two is bounded — a repair only opens while errors remain, and the
 * no-op guard already ends a run whose composition has stopped changing.
 */
export const MAX_REPAIR_ATTEMPTS = 5;

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
  const ledger = new CostLedger();
  const timeline = new Timeline();
  let usedBaseline = Boolean(options.baselineOnly);

  // 1 — plan, informed by usable facts and what already exists.
  const facts = await readFacts();
  // `kit.website` is what separates third-party research from a claim about this product —
  // see `isUsableFact`. Without it the exemption collapses to approved-only.
  const knowledge = await approvedStatements(facts, kit.website);
  const usage = await factUsage();
  const prior = await similarTheses(options.brief);
  if (prior.length) {
    log(`ledger        ${prior.length} related video(s): ${prior.map((entry) => entry.id).join(", ")}`);
  }

  log(`plan          ${options.intent} · ${narrationProfile} · ${options.formats.join(", ")} · ${options.language}`);
  const planned = await timeline.span("plan", async () => planVideo(
    {
      // Provisional. The folder is named from the plan's own title, which does not exist
      // yet — `normalise()` overwrites `plan.id` from this field anyway, and it is
      // overwritten again below once there is something better to call it.
      id: "pending",
      brief: options.brief,
      intent: options.intent,
      narrationProfile,
      formats: options.formats,
      language: options.language,
      kit,
      priorTheses: prior.map((entry) => ({id: entry.id, thesis: entry.thesis})),
      knowledge,
      facts,
      // Ids as well as sentences: a chart cites a fact, and citing needs an id. Filtered
      // to approved-with-evidence here so the planner is never shown a figure it would
      // then be refused for using.
      citableFacts: facts
        .filter((fact) => isUsableFact(fact, kit.website) && fact.evidence.trim().length > 0)
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
  ));
  if (options.plannerId === "codex") {
    ledger.free("codex", "plan", "covered by the local ChatGPT subscription");
  } else {
    ledger.model("claude", "plan", planned.costUsd);
  }
  // Named now, not before planning: "the-month-later-test" is worth waiting one call for,
  // and nothing has been written to disk yet, so there is nothing to move.
  const videoId = await uniqueVideoId(planned.plan.title, options.composerId);
  const dir = videoDir(videoId);
  await fs.mkdir(dir, {recursive: true});
  planned.plan.id = videoId;
  log(`video         ${videoId}`);
  log(`plan          "${planned.plan.thesis}"`);
  log(`plan          ${planned.plan.sections.length} sections · ${planned.plan.sections.reduce((sum, section) => sum + section.phrases.length, 0)} phrases`);
  await savePlan(planned.plan, path.join(dir, "plan.draft.json"));

  // Fail here, before a narration take and a twenty-minute compose, if the plan states a
  // figure nothing approved backs. The draft is already on disk, so the rejected plan is
  // readable rather than lost — the fix is usually to approve a fact, not to re-plan.
  assertPlanClaimsAreSourced(planned.plan, facts, knowledge, kit.website);

  // 2 — narrate, then rebuild every timestamp from the audio that actually exists.
  // Checked between every stage, because each one is minutes long and a cancel that only
  // takes effect at the end of the current stage is not a cancel the owner can feel.
  throwIfCancelled(options.signal, "planning");
  const narration = await timeline.span(
    "narrate",
    () => narrate(planned.plan, dir, log, options.signal),
  );
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
  let authoredSize: CompositionSize | null = null;
  let finalSize: CompositionSize | null = null;
  const familyFailures: {family: string; message: string}[] = [];

  // Resolve every screenshot the plan asked for once, before any family. A missing one is
  // reported rather than ignored: the composer would write an `<img>` at a path with no
  // file behind it, which renders as an empty panel and passes every check we have.
  const media = await timeline.span("media", () => mediaForPlan(plan.sections));
  if (media.files.length) log(`media         ${media.files.length} item(s) bound: ${media.files.map((file) => file.id).join(", ")}`);
  if (media.missing.length) {
    log(`media         MISSING ${media.missing.join(", ")} — no approved library item with that id;`
      + " those sections will have no image");
  }

  // Portrait first when both are wanted, so the second family has something to re-lay.
  //
  // The two shapes are different enough that one set of coordinates cannot serve both — a
  // five-row vertical stack is a squat band at 1920×1080 — so landscape is still authored.
  // What changed is that it is no longer authored *independently*. Two separate passes on
  // one script produced two different videos that happened to say the same words, and a
  // visual correction to one did nothing for the other. Now the second pass starts from the
  // first pass's three files and re-lays them, so the piece is designed once.
  const families = [...byFamily(plan.formats)]
    .sort(([a], [b]) => (a === "portrait" ? -1 : 0) - (b === "portrait" ? -1 : 0));
  let composedReference: {dir: string; family: string; width: number; height: number} | null = null;

  for (const [family, formats] of families) {
    try {
    const authoringDir = path.join(dir, "work", family);
    await fs.mkdir(authoringDir, {recursive: true});
    const authoring = await prepareAuthoringDir({
      plan,
      kit,
      family,
      dir: authoringDir,
      narrationPath: narration.masterPath,
      // Re-resolved per family so a screenshot with a second capture gets the one that
      // suits this shape. The id does not change, so the composition keeps saying
      // `media/<id>.png` and the adaptation pass never has to think about it.
      mediaFiles: (await mediaForPlan(plan.sections, family)).files,
    });

    const composed = await timeline.span("compose", () => composeWithRepair({
      authoring,
      plan,
      kit,
      family,
      composerId: options.composerId,
      baselineOnly: options.baselineOnly ?? false,
      log,
      signal: options.signal,
      timeline,
      adaptFrom: composedReference ?? undefined,
    }));
    composedReference ??= {
      dir: authoring.dir,
      family,
      width: authoring.width,
      height: authoring.height,
    };
    if (composed.costUsd > 0) ledger.model(composed.result?.provider ?? options.composerId, "compose", composed.costUsd);
    attemptsUsed = Math.max(attemptsUsed, composed.attempts);
    usedBaseline ||= composed.usedBaseline;
    composeResult = composed.result;
    // The reference family is the one authored from scratch. A later family re-lays it, so
    // its size measures how faithfully the source was carried across rather than how much
    // the composer decided to write, and averaging the two would dilute both readings.
    authoredSize ??= composed.size;
    finalSize = compositionSize(await readComposition(authoring.dir));
    log(
      `size          ${finalSize.lines["styles.css"]} css · ${finalSize.lines["index.html"]} html`
      + ` · ${finalSize.lines["animation.js"]} js · ${finalSize.cssRules} rules`
      + ` · ${finalSize.gsapCalls} gsap · min ${finalSize.minElementsPerScene} el/scene`,
    );

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
        const repaired = await timeline.span("compose·qc-repair", () => repairFromQc(fixable));
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
      await timeline.span("render·emit", () => emitFormat(authoring.dir, format, renderDir));

      const outPath = path.join(OUT_DIR, videoId, `master-${format}.mp4`);
      const spec = FORMATS[format];
      log(`render        ${format} · ${spec.width}×${spec.height} · ${options.quality}`);
      await timeline.span(
        "render·video",
        () => renderVideo({dir: renderDir, outputPath: outPath, quality: options.quality}),
      );

      const frames = await timeline.span("render·snapshots", () => renderSnapshots({
        dir: renderDir,
        durationSeconds: authoring.durationSeconds,
        at: sectionSnapshotTimes(plan),
        outputDir: path.join(renderDir, "snapshots"),
      }));

      if (frames.length && (!contactSheet || format === formats[0])) {
        contactSheet = await buildContactSheet(frames, path.join(OUT_DIR, videoId, "contact-sheet.png"));
        cover = await buildCover(frames, path.join(OUT_DIR, videoId, "cover.png"));
      }

      const qc = await timeline.span("render·qc", () => runQc({
        videoPath: outPath,
        format,
        expectedDurationMs: durationMs,
        fps: FPS,
        captions: buildCaptions(plan),
        coverPath: cover ?? undefined,
      }));
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
    } catch (error) {
      if (isCancellation(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      familyFailures.push({family, message});
      log(`compose       ${family} family FAILED — ${message}`);
    }
  }

  const provenance = {
      videoId,
      createdAt: new Date().toISOString(),
      thesis: plan.thesis,
      intent: plan.intent,
      planner: {provider: options.plannerId, model: planned.model},
      marketingGuidance: marketingGuidance.ids,
      composer: {
        provider: usedBaseline ? "baseline" : composeResult?.provider ?? "unknown",
        model: composeResult?.model ?? "n/a",
        effort: composeResult?.effort ?? "n/a",
        turns: composeResult?.turns ?? 0,
        actions: composeResult?.actions ?? 0,
        attempts: attemptsUsed,
        size: authoredSize,
        sizeFinal: finalSize,
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
        ...familyFailures.map(({family, message}) =>
          `${family} format family failed before completion: ${message}`),
      ],
      outputFileHashes: Object.fromEntries(outputs.flatMap((output) => Object.entries(output.qc.hashes))),
  };
  await writeProvenance(provenance, path.join(OUT_DIR, videoId, "provenance.json"));

  // The same facts, next to the video rather than inside `out/`, as something readable.
  // Provenance has held all of this for a long time; nobody opens a 120-line JSON file to
  // find out which model composed a video.
  const slowest = timeline.totals()[0];
  await fs.writeFile(
    path.join(dir, "SUMMARY.txt"),
    renderSummary({
      provenance,
      title: plan.title,
      brief: options.brief,
      language: options.language,
      sections: plan.sections.length,
      phrases: plan.sections.reduce((sum, section) => sum + section.phrases.length, 0),
      durationMs: planDurationMs(plan),
      quality: options.quality,
      outputs,
      timing: {totalMs: timeline.elapsedMs, ...slowest ? {slowest} : {}},
    }),
    "utf8",
  );

  await upsertLedgerEntry({
    id: videoId,
    title: plan.title,
    thesis: plan.thesis,
    intent: plan.intent,
    formats: plan.formats,
    language: plan.language,
    createdAt: new Date().toISOString(),
    status: familyFailures.length === 0 && outputs.length > 0 && outputs.every((output) => output.qc.passed)
      ? "ready"
      : "failed",
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

  // Written before the failure throw below, because a run that died in the landscape
  // family is exactly the one whose stage costs are worth reading.
  await timeline.write(path.join(OUT_DIR, videoId, "timing.json"));
  timeline.report(log);

  if (familyFailures.length) {
    const completed = outputs.map((output) => output.format).join(", ") || "none";
    throw new Error(
      `Video ${videoId} failed in ${familyFailures.map(({family}) => family).join(", ")} `
      + `format family. Completed outputs recorded: ${completed}.`,
    );
  }
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
  /** Optional so `recompose` can call this without owning a run-wide timeline. */
  timeline?: Timeline;
  /**
   * The already-composed family this one is a re-lay of. Its three files are copied in
   * before the composer runs, so the pass edits a finished piece rather than starting over.
   */
  adaptFrom?: {dir: string; family: string; width: number; height: number};
}): Promise<{
  result: ComposeResult | null;
  costUsd: number;
  attempts: number;
  usedBaseline: boolean;
  /** Composition size as the model authored it, before any visual-review edit. */
  size: CompositionSize | null;
}> {
  const {authoring, plan, kit, family, composerId, baselineOnly, log, signal} = options;
  const timeline = options.timeline ?? new Timeline();
  const check = () => timeline.span(
    "compose·check",
    () => checkComposition({dir: authoring.dir, plan, kit, family, fps: FPS, onLog: log}),
  );

  if (baselineOnly) {
    log("compose       baseline (deterministic fallback requested)");
    await writeBaselineComposition(authoring, plan, kit);
    const baselineReport = await check();
    await reportCheck(baselineReport, log, "baseline");
    if (!baselineReport.ok) {
      log(
        `compose       baseline diagnostic continues with ${baselineReport.errorCount} validation `
        + `error${baselineReport.errorCount === 1 ? "" : "s"}; render/QC will record the result`,
      );
    }
    return {
      result: null,
      costUsd: 0,
      attempts: 0,
      usedBaseline: true,
      size: compositionSize(await readComposition(authoring.dir)),
    };
  }

  const composer = composerFor(composerId);
  const adaptFrom = options.adaptFrom;
  if (adaptFrom) {
    // Seed before the first attempt, not as a prompt attachment. A composer that can Read
    // and Edit the actual files makes a smaller, truer change than one working from a
    // description of them — and if it stops early, what is left on disk is the source
    // composition at the wrong size rather than nothing at all.
    for (const file of COMPOSITION_FILES) {
      await fs.copyFile(path.join(adaptFrom.dir, file), path.join(authoring.dir, file));
    }
    log(
      `compose       ${composer.label} · ${family} ${authoring.width}×${authoring.height}`
      + ` · re-laying the ${adaptFrom.family} composition`,
    );
  } else {
    log(`compose       ${composer.label} · ${family} ${authoring.width}×${authoring.height}`);
  }

  let result: ComposeResult | null = null;
  let authoredSize: CompositionSize | null = null;
  let costUsd = 0;
  let report: CheckReport | null = null;
  let visualReviewed = false;

  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS + 1; attempt++) {
    const context = {
      authoring,
      onLog: log,
      signal,
      effort: attempt === 1 ? ("default" as const) : ("high" as const),
      ...adaptFrom
        ? {adaptation: {
          fromFamily: adaptFrom.family,
          fromWidth: adaptFrom.width,
          fromHeight: adaptFrom.height,
        }}
        : {},
    };

    // Before spending an attempt, not only after. The budget is three repairs and each one
    // is a model session, so a run cancelled during attempt two must not open attempt three.
    throwIfCancelled(signal, "compose");

    // Bracketed around the model call alone, deliberately: an auto-fix pass that edits the
    // same files would otherwise disguise a composer that has stopped producing changes.
    const before = attempt === 1 ? null : await compositionFingerprint(authoring.dir);
    const closeAttempt = timeline.open(attempt === 1 ? "compose·author" : "compose·repair");
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
    } finally {
      closeAttempt();
    }

    // Before the no-op guard, because an attempt that edited only supplied files trips that
    // guard and reports "unchanged", which is true of the composition and useless as a
    // diagnosis. Restoring first means the next attempt starts from clean infrastructure and
    // the log names what actually happened.
    const restored = await restoreSuppliedFiles(authoring.dir);
    if (restored.length) {
      log(
        `compose       reverted ${restored.join(", ")} — supplied file(s) are not the `
        + "composition's to edit; the fix belongs in styles.css",
      );
    }

    // A repair that returns the composition it was given has nothing further to offer, and
    // the remaining budget buys only identical sessions. Measured across twelve runs, five
    // repair rounds were byte-identical and one run spent its last two attempts this way.
    if (before !== null && before === await compositionFingerprint(authoring.dir)) {
      await freezeAttempt(authoring.dir, attempt);
      throwIfCancelled(signal, "compose");
      throw new Error(
        `The ${composer.label} composition was unchanged by repair attempt ${attempt}, so the `
        + (restored.length
          ? `remaining ${MAX_REPAIR_ATTEMPTS + 1 - attempt} attempt(s) were not spent. `
            + `The attempt edited ${restored.join(", ")} instead of the composition, and those `
            + "supplied files were reverted, so nothing it did survived. "
          : `remaining ${MAX_REPAIR_ATTEMPTS + 1 - attempt} attempt(s) were not spent `)
        + `(${report?.errorCount ?? "unknown"} error(s) remaining). The attempt was kept for `
        + "inspection; no fallback video was rendered.",
      );
    }

    report = await check();
    await reportCheck(report, log, `attempt ${attempt}`);

    // Before the next repair, not instead of it. A missing `id`, a drifted `data-start` or
    // an em-dash costs a regex here and a whole model session one branch later — and an
    // attempt whose every error is mechanical reaches visual review without a repair at all.
    if (!report.ok) {
      const fixed = await timeline.span("compose·autofix", () => autoFix({
        dir: authoring.dir,
        authoring,
        report: report as CheckReport,
        check,
        log,
      }));
      if (fixed.applied.length) {
        report = fixed.report;
        await reportCheck(report, log, `auto-fix after attempt ${attempt}`);
      }
    }

    if (report.ok) {
      if (!visualReviewed) {
        // Captured here, before the reviewer touches anything: the pair of authored and
        // final size is what distinguishes a composer that writes a dense frame from one
        // whose thin frame the review pass rescues.
        authoredSize ??= compositionSize(await readComposition(authoring.dir));
        // The model sandboxes intentionally do not own the browser process. Rendering here
        // gives Claude and Codex the same frames from the same HyperFrames/Node runtime;
        // only the transport differs (Claude Read versus Codex --image).
        for (let visualPass = 1; visualPass <= 2; visualPass++) {
          throwIfCancelled(signal, "visual review");
          const evidenceDir = path.join(authoring.dir, ".visual-review");
          await fs.rm(evidenceDir, {recursive: true, force: true});
          const closeSnapshots = timeline.open("visual·snapshots");
          const frames = await renderSnapshots({
            dir: authoring.dir,
            durationSeconds: authoring.durationSeconds,
            at: sectionReviewTimes(plan),
            outputDir: path.join(evidenceDir, "frames"),
            onLog: (line) => log(`  snapshots    ${line}`),
          });
          closeSnapshots();
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

          const beforeReview = await readComposition(authoring.dir);
          log(`visual        ${composer.label} · pass ${visualPass} · ${frames.length} section frame(s)`);
          const closeReview = timeline.open("visual·review");
          const reviewed = await composer.review(
            {...context, effort: "high"},
            visualReviewRequest(authoring, [contactSheet, ...frames]),
          );
          closeReview();
          costUsd += reviewed.costUsd;
          result = combineComposeResults(result, reviewed);

          // Whether the reviewer edited at all decides if the composition needs re-checking;
          // whether it edited *substantially* decides if it is worth a second opinion. A
          // retuned padding is a real edit and a poor reason to spend another vision session.
          const delta = editDelta(beforeReview, await readComposition(authoring.dir));
          const changed = delta.files.length > 0;
          const substantive = isSubstantive(delta);
          log(
            `visual        ${changed
              ? `composition adjusted · ${delta.changedLines} line(s)`
                + `${delta.structural ? ", structural" : ""} in ${delta.files.join(", ")}`
              : "approved without edits"}`,
          );
          report = await check();
          await reportCheck(report, log, `visual review ${visualPass}`);
          if (!report.ok || !changed) break;
          if (!substantive) {
            log(
              `visual        edit was cosmetic (${delta.changedLines} line(s), `
              + `threshold ${SUBSTANTIVE_LINES}); accepting without a confirmation pass`,
            );
            break;
          }
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
      return {result, costUsd, attempts: attempt, usedBaseline: false, size: authoredSize};
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

/**
 * The three composed files, keyed by name. One reader, so the hash and the diff agree.
 *
 * A missing file reads as empty rather than throwing. An attempt that died before writing
 * anything is a real state — a killed session, an exhausted limit — and the callers here all
 * want to reason about it rather than crash on it. Two attempts that both produce nothing
 * then fingerprint identically, which is exactly the stagnation the repair loop should stop
 * on. Before this, the second attempt threw ENOENT and took the whole format family with it.
 */
async function readComposition(dir: string): Promise<CompositionSnapshot> {
  const files = await Promise.all(COMPOSITION_FILES.map(async (file) => [
    file,
    await fs.readFile(path.join(dir, file), "utf8").catch(() => ""),
  ] as const));
  return Object.fromEntries(files);
}

async function compositionFingerprint(dir: string): Promise<string> {
  const snapshot = await readComposition(dir);
  return hash(COMPOSITION_FILES.map((file) => ({file, body: snapshot[file]})));
}

export function combineComposeResults(
  authored: ComposeResult | null,
  reviewed: ComposeResult,
): ComposeResult {
  if (!authored) return reviewed;
  // Spread the reviewed result rather than listing its fields. The listed form was
  // exhaustive by construction, so a field added to ComposeResult silently disappeared here
  // the moment a visual-review pass ran — invisible until someone read a provenance file
  // weeks later. Only the fields that genuinely accumulate are named below.
  return {
    ...reviewed,
    turns: authored.turns + reviewed.turns,
    actions: authored.actions + reviewed.actions,
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
