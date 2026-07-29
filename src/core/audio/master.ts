import fs from "node:fs/promises";
import path from "node:path";
import {exists, probeDuration, run} from "../util/exec.ts";

export const NARRATION_TARGET_LUFS = -16;
export const NARRATION_TRUE_PEAK_DB = -1.5;
export const NARRATION_BITRATE = "192k";
export const AUDIO_MASTERING_VERSION = "narration-loudnorm-v2";

/**
 * Normalise a narration track to broadcast-ish loudness. Idempotent: an existing
 * output is reused, so re-running the pipeline never re-encodes.
 */
export async function masterNarration(
  inputPath: string,
  outputPath: string,
  volume = 1,
): Promise<number> {
  const boundedVolume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
  if (!await exists(outputPath)) {
    await fs.mkdir(path.dirname(outputPath), {recursive: true});
    await run("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-vn",
      "-af", `loudnorm=I=${NARRATION_TARGET_LUFS}:TP=${NARRATION_TRUE_PEAK_DB}:LRA=7,volume=${boundedVolume}`,
      "-c:a", "aac",
      "-b:a", NARRATION_BITRATE,
      outputPath,
    ]);
  }
  return probeDuration(outputPath);
}

/** A spoken clip, or a stretch of deliberate silence for a wordless section. */
export type NarrationSegment =
  | {kind: "clip"; path: string; gapAfterMs: number}
  | {kind: "silence"; durationMs: number};

/**
 * Assemble the narration track segment by segment, in plan order.
 *
 * Silent sections are materialised as real silence rather than skipped — otherwise
 * a wordless section anywhere but the end would shift every later line out of sync
 * with the picture. The assembled length therefore always equals the plan length.
 */
export async function assembleNarration(
  segments: readonly NarrationSegment[],
  outputPath: string,
): Promise<number> {
  if (!segments.length) throw new Error("Cannot build a narration track from zero segments.");
  await fs.mkdir(path.dirname(outputPath), {recursive: true});

  const inputs: string[] = [];
  const filters: string[] = [];
  const labels: string[] = [];

  segments.forEach((segment, index) => {
    if (segment.kind === "silence") {
      const seconds = Math.max(0.001, segment.durationMs / 1000);
      inputs.push("-f", "lavfi", "-t", seconds.toFixed(3), "-i", "anullsrc=r=48000:cl=mono");
      filters.push(`[${index}:a]aresample=48000[a${index}]`);
    } else {
      inputs.push("-i", segment.path);
      const gapSeconds = Math.max(0, segment.gapAfterMs) / 1000;
      // Pad only — never trim, so the spoken audio always survives intact.
      const pad = gapSeconds > 0 ? `,apad=pad_dur=${gapSeconds.toFixed(3)}` : "";
      filters.push(`[${index}:a]aresample=48000${pad}[a${index}]`);
    }
    labels.push(`[a${index}]`);
  });
  filters.push(`${labels.join("")}concat=n=${segments.length}:v=0:a=1[out]`);

  await run("ffmpeg", [
    "-y",
    ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", "[out]",
    "-c:a", "pcm_s16le",
    outputPath,
  ]);
  return probeDuration(outputPath);
}

/** Cut one segment out of the mastered track — used to drive an avatar's lip-sync. */
export async function extractSegment(
  inputPath: string,
  outputPath: string,
  startMs: number,
  durationMs: number,
): Promise<number> {
  await fs.mkdir(path.dirname(outputPath), {recursive: true});
  await run("ffmpeg", [
    "-y",
    "-ss", (startMs / 1000).toFixed(3),
    "-t", (durationMs / 1000).toFixed(3),
    "-i", inputPath,
    "-vn", "-c:a", "aac", "-b:a", NARRATION_BITRATE,
    outputPath,
  ]);
  return probeDuration(outputPath);
}
