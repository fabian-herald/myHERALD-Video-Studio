import fs from "node:fs/promises";
import path from "node:path";
import {loadBrandKit} from "../brand/kit.ts";
import {FPS, NARRATION_FILE, sectionSnapshotTimes} from "../compose/workdir.ts";
import {amendLedgerEntry} from "../ledger.ts";
import {byFamily, FORMATS, familyOf, type OutputFormat} from "../plan/formats.ts";
import {assertPlanCopyRules} from "../plan/copyRules.ts";
import {loadPlan, planDurationMs, savePlan, videoPlanZ, type Energy, type VideoPlan} from "../plan/schema.ts";
import {OUT_DIR, rel, videoDir} from "../paths.ts";
import {buildContactSheet, buildCover} from "../render/artifacts.ts";
import {checkComposition} from "../render/check.ts";
import {emitFormat, renderSnapshots, renderVideo, type Quality} from "../render/hyperframes.ts";
import {runQc, writeQc, type QcReport} from "../render/qc.ts";
import {buildCaptions, writeCaptionData} from "../tts/captions.ts";
import {narrate} from "../tts/narrate.ts";

export interface PlanEdit {
  sectionId: string;
  /** New display copy. Only applied when it can be swapped safely (see below). */
  onScreen?: string;
  /** New spoken text, keyed by phrase id. Re-synthesised; unchanged phrases stay cached. */
  phrases?: Record<string, string>;
  /**
   * The section's complete phrase list, which is how lines get added, removed or
   * reordered. An entry without an id is new. Anything the old section had and this
   * list does not is dropped.
   */
  setPhrases?: {id?: string; text: string; gapAfterMs?: number}[];
  /** Extra silence after the section's last phrase, in milliseconds. */
  trailingGapMs?: number;
  /**
   * Where this section sits on the energy curve. Changing it re-synthesises the
   * section's lines, because delivery is part of the narration cache key, but it
   * never touches the composition.
   */
  energy?: Energy;
  /** Remove the section entirely, including its scene element. */
  remove?: boolean;
}

export interface ApplyResult {
  plan: VideoPlan;
  outputs: {format: OutputFormat; path: string; qc: QcReport}[];
  contactSheet: string | null;
  /** Edits that could not be applied mechanically and need the composer. */
  needsCompose: string[];
  durationChanged: boolean;
}

/**
 * The cheap edit path.
 *
 * Copy and timing live in plan.json, and the composition is keyed to it by section id,
 * so a wording or pacing change can be pushed straight through re-narration and
 * re-render without asking a model to redesign anything. This is what keeps iteration
 * free; only a change to the *shape* of a scene needs the composer.
 */
export async function applyPlanEdits(options: {
  videoId: string;
  edits: readonly PlanEdit[];
  quality?: Quality;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}): Promise<ApplyResult> {
  const {videoId, edits, quality = "high", signal} = options;
  const log = options.onLog ?? (() => {});
  const dir = videoDir(videoId);
  const kit = await loadBrandKit();

  const current = await loadPlan(path.join(dir, "plan.json"));
  const beforeDuration = planDurationMs(current);

  const removed = current.sections.filter((section) =>
    edits.some((edit) => edit.sectionId === section.id && edit.remove));
  if (current.sections.length - removed.length < 2) {
    throw new Error("A video needs at least two sections. Remove fewer, or rebuild it in chat.");
  }

  const edited = videoPlanZ.parse({
    ...current,
    sections: current.sections
      .filter((section) => !removed.includes(section))
      .map((section) => {
        const edit = edits.find((candidate) => candidate.sectionId === section.id);
        if (!edit) return section;

        const phrases = edit.setPhrases
          ? edit.setPhrases
            .filter((entry) => entry.text.trim())
            .map((entry, index) => {
              const existing = entry.id
                ? section.phrases.find((phrase) => phrase.id === entry.id)
                : undefined;
              return {
                id: existing?.id ?? freshPhraseId(section.id, index, entry.text),
                text: entry.text,
                startMs: 0,
                durationMs: 0,
                gapAfterMs: entry.gapAfterMs ?? existing?.gapAfterMs ?? 120,
              };
            })
          : section.phrases.map((phrase) => ({
            ...phrase,
            text: edit.phrases?.[phrase.id] ?? phrase.text,
          }));

        const last = phrases.at(-1);
        if (last && edit.trailingGapMs !== undefined) last.gapAfterMs = edit.trailingGapMs;

        return {
          ...section,
          onScreen: edit.onScreen ?? section.onScreen,
          energy: edit.energy ?? section.energy,
          phrases,
        };
      }),
  });

  // `edit_video` is deliberately the cheap copy/timing path. A no-op cannot repair a
  // visual defect, yet it used to re-enter narration and render the same failed frames
  // again. Refuse it before TTS, writes, or machine time are spent, and make the missing
  // composition-repair capability explicit to the calling agent.
  if (JSON.stringify(edited) === JSON.stringify(current)) {
    throw new Error(
      "This edit does not change the plan. edit_video cannot repair layout or motion; "
      + "use a composition repair/recompose action instead.",
    );
  }

  // Edits are user-controlled and bypass the planner retry, so apply the exact same
  // copy contract here before any TTS request, file write, or render can incur cost.
  assertPlanCopyRules(edited, kit.voice);

  // Re-narrate: cached clips make every untouched phrase free.
  const narration = await narrate(edited, dir, log, signal);
  const plan = narration.plan;
  await savePlan(plan, path.join(dir, "plan.json"));

  const durationMs = planDurationMs(plan);
  const durationChanged = Math.abs(durationMs - beforeDuration) > 1;
  log(`timing        ${(durationMs / 1000).toFixed(2)}s${durationChanged ? " (changed)" : " (unchanged)"}`);

  const needsCompose: string[] = [];
  const outputs: ApplyResult["outputs"] = [];
  let contactSheet: string | null = null;
  let cover: string | null = null;

  for (const [family, formats] of byFamily(plan.formats)) {
    const authoringDir = path.join(dir, "work", family);
    if (!await fs.access(path.join(authoringDir, "index.html")).then(() => true).catch(() => false)) {
      throw new Error(`No composition to edit for ${family}. Generate the video first.`);
    }

    await fs.copyFile(narration.masterPath, path.join(authoringDir, NARRATION_FILE));
    await writeCaptionData(buildCaptions(plan), path.join(authoringDir, "caption-data.js"));

    if (durationChanged && !await animationReadsDomTimings(authoringDir)) {
      needsCompose.push(
        "This edit changes the length, but the composition hardcodes its animation "
        + "timings instead of reading them from the DOM. The picture would drift out of "
        + "sync with the narration. Ask the agent to rebuild it before changing pacing.",
      );
    }

    const rewrite = await rewriteComposition(authoringDir, plan, current);
    needsCompose.push(...rewrite.unapplied);

    const report = await checkComposition({dir: authoringDir, plan, kit, family, fps: FPS});
    log(`check         ${family}: ${report.ok ? "clean" : `${report.errorCount} error(s)`}`);
    if (!report.ok) {
      needsCompose.push(
        `The composition no longer matches the plan after this edit `
        + `(${report.findings.filter((finding) => finding.severity === "error").length} error(s)). Ask the agent to adjust it.`,
      );
    }

    for (const format of formats) {
      const renderDir = path.join(dir, "render", format);
      await emitFormat(authoringDir, format, renderDir);

      const outPath = path.join(OUT_DIR, videoId, `master-${format}.mp4`);
      const spec = FORMATS[format];
      log(`render        ${format} · ${spec.width}×${spec.height}`);
      await renderVideo({dir: renderDir, outputPath: outPath, quality});

      const frames = await renderSnapshots({
        dir: renderDir,
        durationSeconds: durationMs / 1000,
        at: sectionSnapshotTimes(plan),
        outputDir: path.join(renderDir, "snapshots"),
      });
      if (frames.length && familyOf(format) === family && !contactSheet) {
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
      outputs.push({format, path: outPath, qc});
    }
  }

  await recordEdit({videoId, plan, outputs, needsCompose, log});
  return {plan, outputs, contactSheet, needsCompose, durationChanged};
}

/**
 * Write the result of an edit back to the studio's memory.
 *
 * Everything here was already known and thrown away. The script was re-narrated, the files
 * were re-rendered, QC ran on each one — and the ledger kept whatever the first build said,
 * so a video repaired by an edit read `failed` for good and the studio's own failure rate
 * was wrong by a third.
 *
 * `stale` rather than `ready` when an edit could not be pushed all the way through: the
 * files rendered and may well pass QC, but the composition no longer says what the plan
 * says, and calling that ready is the same lie one step further along.
 */
async function recordEdit(options: {
  videoId: string;
  plan: VideoPlan;
  outputs: ApplyResult["outputs"];
  needsCompose: readonly string[];
  log: (line: string) => void;
}): Promise<void> {
  const {videoId, plan, outputs, needsCompose, log} = options;
  const passed = outputs.every((output) => output.qc.passed);
  const status = !passed ? "failed" : needsCompose.length ? "stale" : "ready";

  const amended = await amendLedgerEntry(videoId, {
    status,
    formats: plan.formats,
    language: plan.language,
    spokenScript: plan.sections.flatMap((section) => section.phrases.map((phrase) => phrase.text)).join(" "),
    // Recomputed, not merged: removing a section can drop the only chart carrying a figure,
    // and leaving it listed would keep a fact retired that this video no longer spends.
    factIds: [...new Set(plan.sections.flatMap((section) =>
      (section.data?.points ?? []).map((point) => point.factId)))],
    outputs: outputs.map((output) => ({format: output.format, path: rel(output.path)})),
  });

  log(amended
    ? `ledger        ${status}`
    : "ledger        no entry for this video, so nothing was updated");
}

/**
 * Compositions authored before the contract required DOM-derived timings carry absolute
 * numbers, so shifting the plan silently desynchronises them. Detect that rather than
 * shipping a video whose picture and voice have drifted apart.
 */
async function animationReadsDomTimings(dir: string): Promise<boolean> {
  const source = await fs.readFile(path.join(dir, "animation.js"), "utf8").catch(() => "");
  return /dataset\s*\.\s*start|getAttribute\(\s*["']data-start["']\s*\)/.test(source);
}

/**
 * Push the plan's timings and copy back into the authored HTML.
 *
 * Timings are always safe — they are attributes on an element the contract guarantees
 * exists. Copy is only swapped when the old string sits contiguously in the markup;
 * when the composer split it across elements for typographic effect, the edit is
 * reported as needing the composer instead of being mangled.
 */
async function rewriteComposition(
  dir: string,
  plan: VideoPlan,
  previous: VideoPlan,
): Promise<{unapplied: string[]}> {
  const indexPath = path.join(dir, "index.html");
  let html = await fs.readFile(indexPath, "utf8");
  const unapplied: string[] = [];

  const duration = (planDurationMs(plan) / 1000).toFixed(3);
  html = rewriteFullDurationClips(html, duration);

  // Drop the scene elements of removed sections. GSAP tweens whose selector no longer
  // resolves are no-ops, so nothing else has to be touched.
  for (const gone of previous.sections) {
    if (plan.sections.some((section) => section.id === gone.id)) continue;
    html = removeScene(html, gone.id);
  }

  for (const section of plan.sections) {
    const before = previous.sections.find((candidate) => candidate.id === section.id);
    html = rewriteSceneTiming(html, section.id, section.startMs, section.durationMs);

    if (before && before.onScreen !== section.onScreen && before.onScreen.trim()) {
      const swapped = swapCopy(html, section.id, before.onScreen, section.onScreen);
      if (swapped) html = swapped;
      else {
        unapplied.push(
          `"${before.onScreen}" is split across elements in scene-${section.id}, so it cannot be `
          + "swapped mechanically. Ask the agent to change it.",
        );
      }
    }
  }

  await fs.writeFile(indexPath, html, "utf8");
  return {unapplied};
}

function removeScene(html: string, sectionId: string): string {
  const anchor = html.indexOf(`id="scene-${sectionId}"`);
  if (anchor < 0) return html;
  const start = html.lastIndexOf("<", anchor);
  return html.slice(0, start) + html.slice(findSceneEnd(html, start));
}

/** Stable, collision-free id for a line the owner just added. */
function freshPhraseId(sectionId: string, index: number, text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 18);
  return `${slug || "line"}-${index}`;
}

function rewriteSceneTiming(html: string, sectionId: string, startMs: number, durationMs: number): string {
  const anchor = html.indexOf(`id="scene-${sectionId}"`);
  if (anchor < 0) return html;
  const tagStart = html.lastIndexOf("<", anchor);
  const tagEnd = html.indexOf(">", anchor);
  if (tagStart < 0 || tagEnd < 0) return html;

  const tag = html.slice(tagStart, tagEnd + 1)
    .replace(/data-start="[^"]*"/, `data-start="${(startMs / 1000).toFixed(3)}"`)
    .replace(/data-duration="[^"]*"/, `data-duration="${(durationMs / 1000).toFixed(3)}"`);
  return html.slice(0, tagStart) + tag + html.slice(tagEnd + 1);
}

/** The backdrop, brand rail, caption layer and audio all span the whole piece. */
function rewriteFullDurationClips(html: string, duration: string): string {
  return html.replace(
    /(id="(?:stage|backdrop|brand-rail|caption-layer|narration)"[^>]*?data-duration=")[^"]*(")/g,
    `$1${duration}$2`,
  );
}

function swapCopy(html: string, sectionId: string, before: string, after: string): string | null {
  const anchor = html.indexOf(`id="scene-${sectionId}"`);
  if (anchor < 0) return null;
  const sceneStart = html.lastIndexOf("<", anchor);
  const sceneEnd = findSceneEnd(html, sceneStart);
  const scene = html.slice(sceneStart, sceneEnd);

  const escapedBefore = escapeHtml(before);
  const target = scene.includes(before) ? before : scene.includes(escapedBefore) ? escapedBefore : null;
  if (!target) return null;

  const replacement = target === before ? after : escapeHtml(after);
  return html.slice(0, sceneStart) + scene.replace(target, replacement) + html.slice(sceneEnd);
}

function findSceneEnd(html: string, sceneStart: number): number {
  const pattern = /<section\b|<\/section\s*>/gi;
  pattern.lastIndex = sceneStart + 1;
  let depth = 1;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return match.index + match[0].length;
  }
  return html.length;
}

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
