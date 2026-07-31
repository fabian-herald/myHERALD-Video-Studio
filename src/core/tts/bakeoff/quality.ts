import fs from "node:fs/promises";
import path from "node:path";
import {NARRATION_TARGET_LUFS, NARRATION_TRUE_PEAK_DB} from "../../audio/master.ts";
import {probeDuration, run} from "../../util/exec.ts";
import type {AlignedPhrase, AlignmentTarget, TimedWord} from "../align.ts";
import {normalise} from "../align.ts";

export const WITHIN_SECTION_GAP_MS = 250;
export const BETWEEN_SECTION_GAP_MS = 650;
const PRE_ROLL_MS = 25;
const POST_ROLL_MS = 60;

export interface ControlledSlice {
  sectionId: string;
  phraseId: string;
  startMs: number;
  durationMs: number;
  gapAfterMs: number;
}

/** Phrase-word bounds plus a very small breath margin; never stretches or pitch-shifts speech. */
export function controlledSlices(
  aligned: readonly AlignedPhrase[],
  targets: readonly AlignmentTarget[],
  takeDurationMs: number,
): ControlledSlice[] {
  if (aligned.length !== targets.length) throw new Error("Alignment and script phrase counts differ.");
  return aligned.map((phrase, index) => {
    const target = targets[index];
    if (!target || target.sectionId !== phrase.sectionId || target.phraseId !== phrase.phraseId) {
      throw new Error(`Alignment identity mismatch at phrase ${index + 1}.`);
    }
    const next = aligned[index + 1];
    const startMs = Math.max(0, phrase.startMs - PRE_ROLL_MS);
    const spokenEnd = phrase.startMs + phrase.durationMs + POST_ROLL_MS;
    // Never let the tail margin consume speech from the next known phrase.
    const endMs = Math.min(takeDurationMs, next ? next.startMs - PRE_ROLL_MS : spokenEnd, spokenEnd);
    const nextTarget = targets[index + 1];
    const gapAfterMs = !nextTarget
      ? 0
      : nextTarget.sectionId === target.sectionId
        ? WITHIN_SECTION_GAP_MS
        : BETWEEN_SECTION_GAP_MS;
    return {
      sectionId: phrase.sectionId,
      phraseId: phrase.phraseId,
      startMs,
      durationMs: Math.max(1, endMs - startMs),
      gapAfterMs,
    };
  });
}

/** Identical listening treatment for every provider: 48 kHz mono PCM at -16 LUFS. */
export async function masterListeningFile(inputPath: string, outputPath: string) {
  await fs.mkdir(path.dirname(outputPath), {recursive: true});
  await run("ffmpeg", [
    "-y", "-v", "error", "-i", inputPath, "-vn",
    "-af", `aresample=48000,loudnorm=I=${NARRATION_TARGET_LUFS}:TP=${NARRATION_TRUE_PEAK_DB}:LRA=7`,
    "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", outputPath,
  ]);
  return probeDuration(outputPath);
}

export function wordErrorRate(expectedText: string, heard: readonly TimedWord[]) {
  const expected = expectedText.split(/\s+/).map(normalise).filter(Boolean);
  const actual = heard.map((word) => normalise(word.word)).filter(Boolean);
  if (!expected.length) return actual.length ? 1 : 0;
  const previous = Array.from({length: actual.length + 1}, (_, index) => index);
  for (let row = 1; row <= expected.length; row++) {
    const current = [row];
    for (let column = 1; column <= actual.length; column++) {
      const substitution = previous[column - 1]! + (expected[row - 1] === actual[column - 1] ? 0 : 1);
      current[column] = Math.min(previous[column]! + 1, current[column - 1]! + 1, substitution);
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[actual.length]! / expected.length;
}

export async function peakDb(file: string): Promise<number | null> {
  const {stderr} = await run("ffmpeg", [
    "-hide_banner", "-nostats", "-i", file, "-af", "volumedetect", "-f", "null", "-",
  ]).catch(() => ({stderr: ""}));
  const match = stderr.match(/max_volume:\s*(-?[\d.]+) dB/i);
  const value = Number(match?.[1]);
  return Number.isFinite(value) ? value : null;
}

/** Any silence this long is unexplained because the controlled gaps top out at 650 ms. */
export async function unexplainedSilences(file: string, thresholdSeconds = 0.9) {
  const {stderr} = await run("ffmpeg", [
    "-hide_banner", "-nostats", "-i", file,
    "-af", `silencedetect=noise=-42dB:d=${thresholdSeconds}`,
    "-f", "null", "-",
  ]).catch(() => ({stderr: ""}));
  return [...stderr.matchAll(/silence_duration:\s*([\d.]+)/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
}

export const averageConfidence = (aligned: readonly AlignedPhrase[]) =>
  aligned.length ? aligned.reduce((sum, phrase) => sum + phrase.confidence, 0) / aligned.length : 0;
