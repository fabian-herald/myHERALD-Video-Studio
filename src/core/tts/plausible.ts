/**
 * Is this clip's length plausible for the words it was meant to contain?
 *
 * A text-to-speech model handed both a transcript and a delivery direction can read the
 * direction aloud. It is not an error anything downstream would notice: the clip is
 * valid audio, the plan retimes around it happily, and the video ships with a narrator
 * calmly reciting "warmer and slightly quicker, conviction rising" over scene four.
 *
 * The only reliable signal is arithmetic. Speech runs at a knowable rate, so a clip far
 * longer than its word count allows contains something that was not in the transcript.
 */

/**
 * Words per second at the slowest a deliberate narrator plausibly goes. Measured English
 * narration from this pipeline sits at 2.1 to 2.7; 1.1 leaves room for a genuinely
 * weighted delivery with pauses before the guard fires.
 */
const SLOWEST_WORDS_PER_SECOND = 1.1;

/** Even a single word carries lead-in and decay, so short lines get a floor. */
const FLOOR_MS = 3_500;

export const countWords = (text: string) =>
  text.trim().split(/\s+/).filter(Boolean).length;

export function longestPlausibleMs(text: string): number {
  return Math.max(FLOOR_MS, (countWords(text) / SLOWEST_WORDS_PER_SECOND) * 1000);
}

export interface Implausible {
  words: number;
  measuredMs: number;
  ceilingMs: number;
  /** Roughly how many words of unasked-for speech the extra time accounts for. */
  extraWords: number;
}

/** Returns nothing when the clip is a plausible reading of `text`. */
export function implausibleClip(text: string, measuredMs: number): Implausible | null {
  const ceilingMs = longestPlausibleMs(text);
  if (measuredMs <= ceilingMs) return null;
  return {
    words: countWords(text),
    measuredMs: Math.round(measuredMs),
    ceilingMs: Math.round(ceilingMs),
    extraWords: Math.round(((measuredMs - ceilingMs) / 1000) * 2.4),
  };
}
