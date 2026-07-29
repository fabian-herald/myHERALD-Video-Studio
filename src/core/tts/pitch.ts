/**
 * Does every clip sound like the same person?
 *
 * A generative TTS model re-decides the speaker on every request. Asked sixteen times
 * for the same voice, `gemini-3.1-flash-tts-preview` returned readings spanning 104 to
 * 200 Hz — an octave — and the high one lands squarely in female register. Nothing in
 * the request fixes this: measured across the same script, one continuous take drifted
 * 9.7 semitones against 11.3 for sixteen separate calls, removing the delivery
 * directions changed nothing, and a voice that held to 5.2 semitones on one run gave
 * 14.4 and 12.4 on the next two. The variance between attempts is larger than the
 * difference between any two ways of asking.
 *
 * Correcting the audio afterwards is not the answer either. Pitch-shifting the outliers
 * onto the median collapsed the spread from 11.3 to 1.8 semitones and sounded, in the
 * only test that counts, unintelligible — the shifts needed are up to six semitones and
 * no formant-preserving filter survives that on speech.
 *
 * What is left is asking again. The drift is random, so a second attempt usually lands
 * near the middle, and a re-rolled clip is untouched audio rather than repaired audio.
 */

import {execFile} from "node:child_process";
import {promisify} from "node:util";

const run = promisify(execFile);

const SAMPLE_RATE = 8_000;
const FRAME = 512;
const HOP = 256;
/** Human speech lives here; searching wider invites octave errors, not more accuracy. */
const MIN_HZ = 70;
const MAX_HZ = 330;
/** Below this a frame is silence or breath, and its autocorrelation is noise. */
const SILENCE_RMS = 0.02;
/** How periodic a frame must be to count as voiced rather than a consonant. */
const VOICED_RATIO = 0.35;

/**
 * Going sharp is what gets noticed: the complaint that started this was a line that
 * read as a woman. Going flat reads as weight or emphasis, so the band is deliberately
 * lopsided — it costs a re-roll only where a listener would actually hear a stranger.
 */
export const MAX_ABOVE_ST = 2;
export const MAX_BELOW_ST = 4;

export const semitones = (from: number, to: number) => 12 * Math.log2(to / from);

/** Median fundamental frequency of a clip, or null when there is too little voiced audio. */
export async function medianF0(file: string): Promise<number | null> {
  const {stdout} = await run(
    "ffmpeg",
    ["-v", "error", "-i", file, "-f", "s16le", "-ac", "1", "-ar", String(SAMPLE_RATE), "-"],
    {encoding: "buffer", maxBuffer: 1 << 28},
  );
  const pcm = stdout as unknown as Buffer;
  const x = new Float32Array(pcm.length / 2);
  for (let i = 0; i < x.length; i++) x[i] = pcm.readInt16LE(i * 2) / 32768;

  const minLag = Math.floor(SAMPLE_RATE / MAX_HZ);
  const maxLag = Math.floor(SAMPLE_RATE / MIN_HZ);
  const voiced: number[] = [];

  // `at` on a typed array is the same read with a bounds check the loops already do;
  // going through it keeps the strict-index rule honest without an assertion per access.
  const sample = (i: number) => x[i] ?? 0;

  for (let start = 0; start + FRAME < x.length; start += HOP) {
    let energy = 0;
    for (let i = 0; i < FRAME; i++) energy += sample(start + i) ** 2;
    const power = energy / FRAME;
    if (Math.sqrt(power) < SILENCE_RMS) continue;

    let best = 0;
    let bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i + lag < FRAME; i++) sum += sample(start + i) * sample(start + i + lag);
      const normalised = sum / (FRAME - lag);
      if (normalised > best) {
        best = normalised;
        bestLag = lag;
      }
    }
    if (bestLag && best / power >= VOICED_RATIO) voiced.push(SAMPLE_RATE / bestLag);
  }

  if (voiced.length < 8) return null;
  voiced.sort((a, b) => a - b);
  return voiced[Math.floor(voiced.length / 2)] ?? null;
}

/**
 * The pitch this video sounds like, taken from the clips themselves.
 *
 * Not a fixed number per brand. Which register a voice lands in varies between runs as
 * much as it does between phrases, so pinning an absolute target would reject a whole
 * good take for being a tone lower than the last one. What has to hold is that the
 * clips agree with each other.
 */
export function centreHz(pitches: readonly (number | null)[]): number | null {
  const known = pitches.filter((p): p is number => p !== null).sort((a, b) => a - b);
  if (known.length < 3) return null;
  return known[Math.floor(known.length / 2)] ?? null;
}

export interface PitchOutlier {
  hz: number;
  centreHz: number;
  /** Signed distance from centre; positive means the clip is sharp. */
  st: number;
}

/** Returns nothing when the clip belongs to the same voice as the rest of the track. */
export function pitchOutlier(hz: number | null, centre: number | null): PitchOutlier | null {
  if (hz === null || centre === null) return null;
  const st = semitones(centre, hz);
  if (st <= MAX_ABOVE_ST && st >= -MAX_BELOW_ST) return null;
  return {hz, centreHz: centre, st};
}

/** Of several attempts at one phrase, the one that best matches the rest of the track. */
export function closestToCentre(
  attempts: readonly {pitch: number | null}[],
  centre: number | null,
): number {
  if (centre === null) return 0;
  let bestIndex = 0;
  let bestDistance = Infinity;
  attempts.forEach((attempt, index) => {
    // An unmeasurable attempt is not evidence of a good one; rank it last.
    const distance = attempt.pitch === null
      ? Infinity
      : Math.abs(semitones(centre, attempt.pitch));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}
