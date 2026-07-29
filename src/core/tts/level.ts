/**
 * Does the narrator hold his level to the end, or run out of steam?
 *
 * A guardrail, and honest about being one: across twenty-five real takes it has never
 * fired. Read that before tuning it.
 *
 * It was built because a listener called a take "quieter and more difficult to
 * understand" toward the end, and a first measurement appeared to confirm it — drops of
 * up to 6.7 dB. That measurement was wrong. It averaged fixed windows of wall clock, so
 * the silence in a take that pauses more toward the end counted as quietness, and it
 * reported pacing as fading. Measured over speech frames the same takes drift between
 * −1.2 and +3.5 dB, and the one that was complained about is flat to a tenth of a
 * decibel. Whatever that listener heard, it is not the level, and it is still unfound —
 * pitch was checked next and rises rather than falls.
 *
 * So the threshold below is not calibrated to a complaint. It sits just above the widest
 * drift ever observed, which makes this a tripwire for a regression rather than a fix for
 * a known defect.
 *
 * It is still worth keeping, because mastering cannot catch this class of fault:
 * `masterNarration` normalises to −16 LUFS, an *integrated* measurement that scales the
 * whole file by one constant, so a slope survives it untouched. Nothing else downstream
 * looks at the shape of a take at all.
 *
 * Like the pace and register checks, it reads the output instead of instructing the
 * prompt. Every attempt to steer this model with more words has made things worse.
 */

import {execFile} from "node:child_process";
import {promisify} from "node:util";

const run = promisify(execFile);

const SAMPLE_RATE = 8_000;
const FRAME = 512;
const HOP = 256;
/** The same gate `pitch.ts` uses to tell speech from silence and breath. */
const SILENCE_RMS = 0.02;
/** Below this there is not enough speech to compare a beginning against an end. */
const MIN_SPEECH_FRAMES = 40;

/**
 * How far the level may fall before the take is worth re-rolling.
 *
 * Set from the observed envelope, not from a complaint. Across twenty-five takes the
 * widest drift measured 3.5 dB and the median was under 2, so four sits just outside
 * what this model has ever done. Nothing in that sample trips it, which is the point:
 * it exists to catch a change in behaviour, not to correct today's output.
 *
 * If it starts firing, that is information — do not raise it to silence it.
 */
export const MAX_FADE_DB = 4;

export interface LevelFade {
  /** Mean level of the opening fifth of *speech*, in dBFS. */
  startDb: number;
  endDb: number;
  /** How far it fell. Positive means the end is quieter, which is the direction that hurts. */
  fadeDb: number;
}

const dbfs = (rms: number) => 20 * Math.log10(Math.max(rms, 1e-6));

/**
 * Level at the start of the speech against level at the end of it.
 *
 * Deliberately measured over speech frames rather than over wall-clock windows. A take
 * that simply pauses more toward the end has more silence in its final seconds, and
 * averaging that silence in reports it as quieter when nothing about the voice changed —
 * that would measure pacing and call it fading. Only frames above the speech gate count,
 * and the comparison is between the first fifth and last fifth of *those*.
 */
export async function measureFade(file: string): Promise<LevelFade | null> {
  const {stdout} = await run(
    "ffmpeg",
    ["-v", "error", "-i", file, "-f", "s16le", "-ac", "1", "-ar", String(SAMPLE_RATE), "-"],
    {encoding: "buffer", maxBuffer: 1 << 28},
  );
  const pcm = stdout as unknown as Buffer;
  const x = new Float32Array(pcm.length / 2);
  for (let i = 0; i < x.length; i++) x[i] = pcm.readInt16LE(i * 2) / 32768;

  const sample = (i: number) => x[i] ?? 0;
  const speech: number[] = [];
  for (let start = 0; start + FRAME < x.length; start += HOP) {
    let energy = 0;
    for (let i = 0; i < FRAME; i++) energy += sample(start + i) ** 2;
    const rms = Math.sqrt(energy / FRAME);
    if (rms >= SILENCE_RMS) speech.push(rms);
  }
  if (speech.length < MIN_SPEECH_FRAMES) return null;

  const fifth = Math.floor(speech.length / 5);
  const mean = (xs: number[]) => xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const startDb = dbfs(mean(speech.slice(0, fifth)));
  const endDb = dbfs(mean(speech.slice(-fifth)));
  return {startDb, endDb, fadeDb: startDb - endDb};
}

/** Has this take faded far enough that a listener would notice the ending? */
export const fadedOut = (fade: LevelFade | null) =>
  fade !== null && fade.fadeDb > MAX_FADE_DB;
