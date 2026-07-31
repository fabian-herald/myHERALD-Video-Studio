/**
 * Where does each phrase sit inside one continuous take?
 *
 * The pipeline needs a start and a duration per phrase — captions and scene timing are
 * built from them. Synthesising each phrase separately gave that for free, and cost the
 * thing that mattered: a generative TTS model decides the speaker afresh on every
 * request, so sixteen requests produced sixteen readings spanning an octave and one of
 * them was a woman. Read in one go it is one performance and the question cannot arise.
 *
 * Recovering the boundaries by listening for the pauses we asked for does not work. The
 * fifteenth-longest silence in a real take measured 1.70s against 1.61s for the
 * sixteenth, so there is nothing to threshold on, and one boundary landed inside speech.
 * Asking for the pauses also damages the reading: the take with them ran 1.59 words per
 * second against 2.33 without.
 *
 * So the boundaries come from word timings instead. This is not speech recognition in
 * the usual sense — the transcript is already known, exactly, because we wrote it. All
 * that is needed is to walk the recognised words alongside the words we sent and note
 * where each phrase ends. Recognition errors are tolerable because a misheard word still
 * occupies the right moment in time, which is the only thing being read off it.
 */

/** One word as the transcriber heard it. */
export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

export interface AlignedPhrase {
  sectionId: string;
  phraseId: string;
  startMs: number;
  durationMs: number;
  /** Fraction of this phrase's words that were matched rather than skipped over. */
  confidence: number;
}

export interface AlignmentTarget {
  sectionId: string;
  phraseId: string;
  text: string;
}

/** Lowercase, strip punctuation: "Thursday," and "thursday" are the same word here. */
export const normalise = (word: string) =>
  word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * How far ahead to look for the next expected word before giving up on it.
 *
 * A transcriber drops a word, splits one into two, or hears "four" as "for". Any of
 * those shifts the sequence by one or two, never by ten — a large window would let a
 * phrase match words belonging to a later one and put the boundary in the wrong place.
 */
const LOOKAHEAD = 3;

export function alignPhrases(
  words: readonly TimedWord[],
  targets: readonly AlignmentTarget[],
): AlignedPhrase[] {
  const heard = words.map((word) => ({...word, key: normalise(word.word)}))
    .filter((word) => word.key);
  const out: AlignedPhrase[] = [];
  let cursor = 0;

  for (const target of targets) {
    const expected = target.text.split(/\s+/).map(normalise).filter(Boolean);
    let matched = 0;
    let first: number | null = null;
    let last: number | null = null;

    for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex++) {
      const word = expected[expectedIndex]!;
      if (heard[cursor]?.key === word) {
        first ??= cursor;
        last = cursor;
        cursor += 1;
        matched += 1;
        continue;
      }

      const nextExpected = expected[expectedIndex + 1];
      // A dropped expected word leaves the next expected word at the current heard
      // position. Do not consume it; the next loop iteration owns it.
      if (nextExpected && heard[cursor]?.key === nextExpected) continue;

      // A substitution consumes exactly one heard word. This matters for repeated words:
      // German "den ... den" with the first heard as "dem" used to jump to the second
      // "den", then strand every word between them and move the phrase boundary.
      if (nextExpected && heard[cursor + 1]?.key === nextExpected) {
        first ??= cursor;
        last = cursor;
        cursor += 1;
        continue;
      }

      for (let offset = 1; offset <= LOOKAHEAD && cursor + offset < heard.length; offset++) {
        if (heard[cursor + offset]!.key !== word) continue;
        cursor += offset + 1;
        matched += 1;
        first ??= cursor - 1;
        last = cursor - 1;
        break;
      }
    }

    // A phrase nothing matched gets no timing rather than a guessed one; the caller
    // decides whether the alignment as a whole is trustworthy.
    if (first === null || last === null) {
      out.push({...target, startMs: 0, durationMs: 0, confidence: 0});
      continue;
    }
    out.push({
      sectionId: target.sectionId,
      phraseId: target.phraseId,
      startMs: Math.round(heard[first]!.start * 1000),
      durationMs: Math.round((heard[last]!.end - heard[first]!.start) * 1000),
      confidence: matched / expected.length,
    });
  }
  return out;
}

export interface AlignmentVerdict {
  ok: boolean;
  reasons: string[];
}

/**
 * Is this alignment safe to build a video on?
 *
 * A bad alignment is worse than no alignment: every caption after a misplaced boundary
 * drifts, and nothing downstream would notice. So the answer has to be checked rather
 * than assumed, and a failure falls back to synthesising each phrase separately — worse
 * audio, but timings that cannot be wrong.
 */
export function verifyAlignment(
  aligned: readonly AlignedPhrase[],
  takeDurationMs: number,
  minConfidence = 0.7,
): AlignmentVerdict {
  const reasons: string[] = [];

  for (const phrase of aligned) {
    if (phrase.confidence < minConfidence) {
      reasons.push(
        `${phrase.sectionId}/${phrase.phraseId} matched only `
        + `${Math.round(phrase.confidence * 100)}% of its words`,
      );
    }
    if (phrase.durationMs <= 0) {
      reasons.push(`${phrase.sectionId}/${phrase.phraseId} has no duration`);
    }
  }

  // Phrases must come out in the order they were sent. Out of order means the walk
  // matched the wrong occurrence of a repeated word somewhere.
  for (let i = 1; i < aligned.length; i++) {
    if (aligned[i]!.startMs < aligned[i - 1]!.startMs) {
      reasons.push(`${aligned[i]!.sectionId}/${aligned[i]!.phraseId} starts before the phrase before it`);
    }
  }

  const last = aligned[aligned.length - 1];
  if (last && last.startMs + last.durationMs > takeDurationMs + 500) {
    reasons.push("the last phrase ends after the audio does");
  }

  return {ok: reasons.length === 0, reasons};
}
