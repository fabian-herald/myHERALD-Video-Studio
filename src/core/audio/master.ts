import fs from "node:fs/promises";
import path from "node:path";
import {exists, fileHash, probeDuration, run} from "../util/exec.ts";

export const NARRATION_TARGET_LUFS = -16;
export const NARRATION_TRUE_PEAK_DB = -1.5;
export const NARRATION_BITRATE = "192k";
export const AUDIO_MASTERING_VERSION = "narration-loudnorm-v2";

/**
 * Normalise a narration track to broadcast-ish loudness.
 *
 * Reuses an existing master only when it was made from exactly this audio, recorded as a
 * hash beside it. It used to skip whenever the output merely *existed*, and because the
 * output name is fixed per video, a second narration in the same directory got the first
 * one's audio back — along with the first one's duration, which the caller then retimed
 * the whole plan against. That shipped a video whose captions ran eight seconds past the
 * last word and ended in ten seconds of silence, and no check anywhere noticed.
 *
 * The hash rather than a timestamp, which was the first fix and was also wrong: "the input
 * is newer than the output" says nothing about a *different* input that happens to be
 * older, and re-narrating can reach for a take synthesised minutes earlier. Identity is
 * the question being asked, so identity is what gets compared.
 */
export async function masterNarration(
  inputPath: string,
  outputPath: string,
  volume = 1,
  minimumDurationMs = 0,
): Promise<number> {
  const boundedVolume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
  const boundedMinimumMs = Number.isFinite(minimumDurationMs)
    ? Math.max(0, Math.round(minimumDurationMs))
    : 0;
  const stampPath = `${outputPath}.source`;
  const stamp = `${await fileHash(inputPath)} ${boundedVolume} ${boundedMinimumMs}`;

  if (stamp !== await sourceOf(stampPath) || !await exists(outputPath)) {
    await fs.mkdir(path.dirname(outputPath), {recursive: true});
    const inputDurationMs = Math.round(await probeDuration(inputPath) * 1000);
    const padMs = Math.max(0, boundedMinimumMs - inputDurationMs);
    const filters = [
      `loudnorm=I=${NARRATION_TARGET_LUFS}:TP=${NARRATION_TRUE_PEAK_DB}:LRA=7`,
      `volume=${boundedVolume}`,
      ...(padMs > 0 ? [`apad=pad_dur=${(padMs / 1000).toFixed(3)}`] : []),
    ];
    await run("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-vn",
      "-af", filters.join(","),
      "-c:a", "aac",
      "-b:a", NARRATION_BITRATE,
      outputPath,
    ]);
    // After the encode, never before: a stamp written for a master that failed to appear
    // would make the next run skip the work and trust the file that is not there.
    await fs.writeFile(stampPath, stamp, "utf8");
  }
  return probeDuration(outputPath);
}

/** What the master beside this stamp was made from, or null if we cannot say. */
async function sourceOf(stampPath: string): Promise<string | null> {
  return fs.readFile(stampPath, "utf8").then((value) => value.trim()).catch(() => null);
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
