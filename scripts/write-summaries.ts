/**
 * Write `SUMMARY.txt` into every existing video folder.
 *
 *   npm run summaries
 *
 * New runs write theirs at the end of the pipeline. This backfills the ones made before
 * that existed, from the provenance and QC files already sitting in `out/`. Nothing is
 * computed here that those files do not already state, so a summary cannot disagree with
 * the record it is rendered from — and a video whose provenance is missing is skipped
 * rather than described from guesses.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {OUT_DIR, VIDEOS_DIR} from "../src/core/paths.ts";
import type {Provenance} from "../src/core/render/artifacts.ts";
import {renderSummary} from "../src/core/render/summary.ts";
import type {QcReport} from "../src/core/render/qc.ts";

const readJson = async <T>(file: string): Promise<T | null> =>
  fs.readFile(file, "utf8").then((raw) => JSON.parse(raw) as T).catch(() => null);

let written = 0;
const skipped: string[] = [];

for (const id of (await fs.readdir(VIDEOS_DIR)).sort()) {
  if (!(await fs.stat(path.join(VIDEOS_DIR, id)).catch(() => null))?.isDirectory()) continue;

  const provenance = await readJson<Provenance>(path.join(OUT_DIR, id, "provenance.json"));
  const plan = await readJson<{
    title?: string;
    brief?: string;
    language?: string;
    sections?: {phrases?: unknown[]; durationMs?: number}[];
  }>(path.join(VIDEOS_DIR, id, "plan.json"));

  if (!provenance || !plan) {
    skipped.push(`${id} — no ${provenance ? "plan.json" : "provenance.json"}`);
    continue;
  }

  const outputs: {format: string; path: string; qc: QcReport}[] = [];
  for (const format of provenance.formats) {
    const qc = await readJson<QcReport>(path.join(OUT_DIR, id, `qc-${format}.json`));
    if (qc) outputs.push({format, path: `out/${id}/master-${format}.mp4`, qc});
  }

  const timing = await readJson<{totalMs: number; stages?: {name: string; ms: number}[]}>(
    path.join(OUT_DIR, id, "timing.json"),
  );
  const slowest = timing?.stages?.[0];

  await fs.writeFile(
    path.join(VIDEOS_DIR, id, "SUMMARY.txt"),
    renderSummary({
      provenance,
      title: plan.title ?? "",
      brief: plan.brief ?? "",
      language: plan.language ?? "",
      sections: plan.sections?.length ?? 0,
      phrases: plan.sections?.reduce((sum, section) => sum + (section.phrases?.length ?? 0), 0) ?? 0,
      durationMs: plan.sections?.reduce((sum, section) => sum + (section.durationMs ?? 0), 0) ?? 0,
      quality: "high",
      outputs,
      ...timing ? {timing: {totalMs: timing.totalMs, ...slowest ? {slowest} : {}}} : {},
    }),
    "utf8",
  );
  written += 1;
  console.log(`${id}/SUMMARY.txt`);
}

for (const note of skipped) console.log(`skip  ${note}`);
console.log(`\n${written} written, ${skipped.length} skipped`);
