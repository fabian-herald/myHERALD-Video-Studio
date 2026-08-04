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
  /** Phrases the walk half-recognised. Tolerated, but worth saying out loud in the log. */
  weak: string[];
}

/**
 * How much of a take may be uncertain before the take itself is not worth trusting.
 *
 * One weak phrase among thirteen is a hard-to-align line, and the answer is to bound it by
 * its neighbours. A quarter of the take coming back weak means the audio does not say the
 * script, and no amount of interpolation rescues that.
 */
export const MAX_WEAK_SHARE = 0.25;

/**
 * Is this alignment safe to build a video on?
 *
 * A bad alignment is worse than no alignment: every caption after a misplaced boundary
 * drifts, and nothing downstream would notice. So the answer has to be checked rather
 * than assumed, and a failure falls back to synthesising each phrase separately.
 *
 * The bar used to be every phrase over 70%, and that was too blunt. One line at 67% —
 * "Same voice. Same format. Same schedule.", repetition being exactly what a word walk
 * trips on — discarded a whole usable take and bought a clip per phrase, which re-rolls
 * the speaker on every request and gives a video several narrators. What actually has to
 * hold is that every phrase was found somewhere, that they came out in order, and that
 * uncertainty is a minority; a weak phrase between two firm ones can take its boundaries
 * from them (`boundWeakPhrases`).
 */
export function verifyAlignment(
  aligned: readonly AlignedPhrase[],
  takeDurationMs: number,
  minConfidence = 0.7,
): AlignmentVerdict {
  const reasons: string[] = [];
  const weak: string[] = [];

  for (const phrase of aligned) {
    // A phrase nothing matched has no position at all — there is nothing to trust and
    // nothing to interpolate from. That is a real failure.
    if (phrase.durationMs <= 0 || phrase.confidence === 0) {
      reasons.push(`${phrase.sectionId}/${phrase.phraseId} was not located in the take`);
      continue;
    }
    // A phrase the walk only half-recognised is different in kind. Rhetorical repetition —
    // "Same voice. Same format. Same schedule." — is good writing and is precisely what a
    // word walk struggles with. Discarding the whole take for it cost a one-take reading
    // and replaced it with a clip per phrase, which re-rolls the speaker on every request.
    if (phrase.confidence < minConfidence) {
      weak.push(
        `${phrase.sectionId}/${phrase.phraseId} matched only `
        + `${Math.round(phrase.confidence * 100)}% of its words`,
      );
    }
  }

  if (aligned.length && weak.length / aligned.length > MAX_WEAK_SHARE) {
    reasons.push(
      `${weak.length} of ${aligned.length} phrases matched weakly, so the take does not `
      + `reliably say the script: ${weak.join("; ")}`,
    );
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

  return {ok: reasons.length === 0, reasons, weak};
}

/**
 * Give a weakly-matched phrase the boundaries its neighbours prove.
 *
 * The walk found *some* of its words, so it sits in the right place; what it cannot be
 * trusted about is exactly where it starts and stops. Its neighbours can settle that: a
 * phrase between two confidently-located ones occupies the gap between them, and captions
 * need boundaries rather than word-level certainty. Deterministic, and it cannot drift —
 * every boundary still comes from a word the aligner actually heard.
 *
 * Only interior phrases are rewritten. A weak first or last phrase has no neighbour on one
 * side, so its own match is the only evidence there is and it keeps it.
 */
export function boundWeakPhrases(
  aligned: readonly AlignedPhrase[],
  minConfidence = 0.7,
): AlignedPhrase[] {
  return aligned.map((phrase, index) => {
    const previous = aligned[index - 1];
    const next = aligned[index + 1];
    if (phrase.confidence >= minConfidence || !previous || !next) return phrase;
    if (previous.confidence < minConfidence || next.confidence < minConfidence) return phrase;

    const startMs = previous.startMs + previous.durationMs;
    const durationMs = next.startMs - startMs;
    // Neighbours that leave no room mean the take is denser than the script; keep what the
    // walk found rather than writing a zero or negative span.
    if (durationMs <= 0) return phrase;
    return {...phrase, startMs, durationMs};
  });
}
