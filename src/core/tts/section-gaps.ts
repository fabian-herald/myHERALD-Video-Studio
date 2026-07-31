import fs from "node:fs/promises";
import path from "node:path";
import {probeDuration, run} from "../util/exec.ts";
import type {PlacedPhrase} from "../plan/retime.ts";

export const DEFAULT_SECTION_GAP_MS = 650;

export interface SectionGapCut {
  afterSectionId: string;
  beforeSectionId: string;
  startMs: number;
  endMs: number;
  removedMs: number;
}

/**
 * Remove only the middle of overlong silence between two known spoken sections.
 *
 * Half the target silence stays on either side of the cut. That keeps the last word's
 * release and the next word's intake intact; speech is never stretched, pitch-shifted,
 * or cut at an ASR word boundary. Pauses inside a section are deliberately untouched.
 */
export function sectionGapCuts(
  placed: readonly PlacedPhrase[],
  targetMs = DEFAULT_SECTION_GAP_MS,
): SectionGapCut[] {
  const beforeMs = Math.floor(targetMs / 2);
  const afterMs = targetMs - beforeMs;
  const cuts: SectionGapCut[] = [];

  for (let index = 0; index < placed.length - 1; index++) {
    const current = placed[index]!;
    const next = placed[index + 1]!;
    if (current.sectionId === next.sectionId) continue;
    const currentEndMs = current.startMs + current.durationMs;
    const gapMs = next.startMs - currentEndMs;
    if (gapMs <= targetMs) continue;
    const startMs = currentEndMs + beforeMs;
    const endMs = next.startMs - afterMs;
    if (endMs <= startMs) continue;
    cuts.push({
      afterSectionId: current.sectionId,
      beforeSectionId: next.sectionId,
      startMs,
      endMs,
      removedMs: endMs - startMs,
    });
  }
  return cuts;
}

export function shiftPlacedAfterCuts(
  placed: readonly PlacedPhrase[],
  cuts: readonly SectionGapCut[],
): PlacedPhrase[] {
  return placed.map((phrase) => {
    const removedBeforeMs = cuts
      .filter((cut) => cut.endMs <= phrase.startMs)
      .reduce((sum, cut) => sum + cut.removedMs, 0);
    return {...phrase, startMs: phrase.startMs - removedBeforeMs};
  });
}

export async function compactSectionGaps(
  inputPath: string,
  outputPath: string,
  placed: readonly PlacedPhrase[],
  targetMs = DEFAULT_SECTION_GAP_MS,
) {
  const cuts = sectionGapCuts(placed, targetMs);
  await fs.mkdir(path.dirname(outputPath), {recursive: true});
  if (!cuts.length) {
    await fs.copyFile(inputPath, outputPath);
    return {
      outputPath,
      durationMs: Math.round(await probeDuration(outputPath) * 1000),
      placed: [...placed],
      cuts,
    };
  }

  const durationMs = Math.round(await probeDuration(inputPath) * 1000);
  const intervals: Array<{startMs: number; endMs: number}> = [];
  let cursorMs = 0;
  for (const cut of cuts) {
    intervals.push({startMs: cursorMs, endMs: cut.startMs});
    cursorMs = cut.endMs;
  }
  intervals.push({startMs: cursorMs, endMs: durationMs});

  const filters = intervals.map((interval, index) => {
    const start = (interval.startMs / 1000).toFixed(6);
    const end = (interval.endMs / 1000).toFixed(6);
    return `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${index}]`;
  });
  const labels = intervals.map((_, index) => `[a${index}]`).join("");
  filters.push(`${labels}concat=n=${intervals.length}:v=0:a=1[out]`);

  await run("ffmpeg", [
    "-y", "-v", "error", "-i", inputPath,
    "-filter_complex", filters.join(";"),
    "-map", "[out]", "-c:a", "pcm_s16le", outputPath,
  ]);
  return {
    outputPath,
    durationMs: Math.round(await probeDuration(outputPath) * 1000),
    placed: shiftPlacedAfterCuts(placed, cuts),
    cuts,
  };
}
