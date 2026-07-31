/**
 * Word timings for a finished take.
 *
 * Not used to find out what was said — we wrote the script, so that is already known.
 * It is used to find out *when* each word was said, which is the one thing the API that
 * produced the audio does not return. `align.ts` walks the known script against these
 * timings to recover per-phrase boundaries.
 *
 * Groq rather than a local whisper: `whisper-large-v3-turbo` is multilingual, which the
 * local `small.en` is not, and this studio writes videos in eight languages.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {run} from "../util/exec.ts";
import type {TimedWord} from "./align.ts";

const ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";

/**
 * Full large-v3, not turbo.
 *
 * Turbo is cheaper and faster, but both sit inside the same free allowance — 7,200 audio
 * seconds an hour against a take of about forty — so the saving buys nothing here. What
 * the accuracy buys is real: alignment confidence is the fraction of a phrase's words
 * that were recognised, and it is the signal that decides whether a video gets built on
 * these timings or falls back. 10.3% word error beats 12% at that job.
 */
export const GROQ_TRANSCRIBE_MODEL = process.env.GROQ_TRANSCRIBE_MODEL?.trim()
  || "whisper-large-v3";

/** Free tier caps uploads at 25 MB; 16 kHz mono FLAC keeps a long take far under it. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface Transcript {
  words: TimedWord[];
  model: string;
  /** Groq bills by audio length with a ten second floor, so short takes cost the floor. */
  billedSeconds: number;
}

/**
 * Downsample to what the model uses anyway.
 *
 * Whisper resamples to 16 kHz mono internally, so sending 24 kHz stereo uploads bytes
 * that are discarded on arrival. FLAC keeps it lossless while roughly halving the size.
 */
async function prepare(audioPath: string, scratchDir: string): Promise<string> {
  await fs.mkdir(scratchDir, {recursive: true});
  const prepared = path.join(scratchDir, `${path.basename(audioPath, path.extname(audioPath))}-16k.flac`);
  await run("ffmpeg", ["-y", "-v", "error", "-i", audioPath,
    "-ar", "16000", "-ac", "1", "-c:a", "flac", prepared]);
  return prepared;
}

export async function transcribeWords(
  audioPath: string,
  language: string,
  scratchDir: string,
  onLog: (line: string) => void = () => {},
  signal?: AbortSignal,
): Promise<Transcript> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY is not set. Add it to .env.local. Narration timing needs word "
      + "timestamps for the take, and there is no way to derive them from the audio alone.",
    );
  }

  const prepared = await prepare(audioPath, scratchDir);
  const bytes = await fs.readFile(prepared);
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(
      `${path.basename(prepared)} is ${(bytes.byteLength / 1e6).toFixed(1)} MB, over the `
      + `${MAX_UPLOAD_BYTES / 1e6} MB upload limit.`,
    );
  }

  const form = new FormData();
  form.append("file", new Blob([bytes as unknown as ArrayBuffer]), path.basename(prepared));
  form.append("model", GROQ_TRANSCRIBE_MODEL);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  // Stating the language improves both accuracy and latency, and we always know it.
  form.append("language", language);

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {Authorization: `Bearer ${apiKey}`},
    body: form,
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Groq transcription failed: ${response.status} ${detail.slice(0, 300)}`);
  }

  const body = await response.json() as {
    words?: {word: string; start: number; end: number}[];
    duration?: number;
  };
  const words = (body.words ?? [])
    .filter((word) => typeof word.start === "number" && typeof word.end === "number")
    .map((word) => ({word: word.word, start: word.start, end: word.end}));

  if (!words.length) {
    throw new Error(
      "Groq returned no word timestamps. Without them the take cannot be split into "
      + "phrases, so the plan has nothing to retime against.",
    );
  }

  await fs.rm(prepared, {force: true});
  const billedSeconds = Math.max(10, Math.round(body.duration ?? 0));
  onLog(`narration    ${words.length} word timings · ${GROQ_TRANSCRIBE_MODEL} · ${billedSeconds}s billed`);
  return {words, model: GROQ_TRANSCRIBE_MODEL, billedSeconds};
}

/** What the transcription of one take costs, at the published turbo rate. */
export const transcriptionCostUsd = (billedSeconds: number) =>
  (billedSeconds / 3600) * 0.04;
