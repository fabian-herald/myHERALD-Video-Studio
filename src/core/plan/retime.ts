import type {VideoPlan} from "./schema.ts";

/** A section with no spoken phrases still needs to be on screen long enough to read. */
export const SILENT_SECTION_MIN_MS = 1600;

export interface MeasuredPhrase {
  sectionId: string;
  phraseId: string;
  durationMs: number;
}

/**
 * Rebuild every timestamp in the plan from the narration that was actually
 * synthesised. The audio is the source of truth — the plan's guessed durations
 * never survive contact with a real take, and forcing audio to fit a guess
 * (the old `atempo` correction) is what produced chipmunk narration.
 */
export function retimePlan(plan: VideoPlan, measured: readonly MeasuredPhrase[]): VideoPlan {
  const byKey = new Map(measured.map((item) => [`${item.sectionId}/${item.phraseId}`, item.durationMs]));
  let cursorMs = 0;

  const sections = plan.sections.map((section) => {
    const sectionStartMs = cursorMs;

    const phrases = section.phrases.map((phrase) => {
      const durationMs = byKey.get(`${section.id}/${phrase.id}`);
      if (durationMs === undefined) {
        throw new Error(
          `No measured narration for ${section.id}/${phrase.id}. `
          + "Synthesise every phrase before retiming.",
        );
      }
      const startMs = cursorMs;
      cursorMs += durationMs + phrase.gapAfterMs;
      return {...phrase, startMs: round(startMs), durationMs: round(durationMs)};
    });

    if (!phrases.length) cursorMs += SILENT_SECTION_MIN_MS;

    return {
      ...section,
      phrases,
      startMs: round(sectionStartMs),
      durationMs: round(Math.max(cursorMs - sectionStartMs, SILENT_SECTION_MIN_MS)),
    };
  });

  return {...plan, sections, narration: {...plan.narration, timing: "measured-clips"}};
}

/** A phrase located inside a continuous take, rather than measured as its own file. */
export interface PlacedPhrase {
  sectionId: string;
  phraseId: string;
  startMs: number;
  durationMs: number;
}

/**
 * Rebuild the plan from where each phrase actually falls in one continuous take.
 *
 * `retimePlan` assumes the opposite arrangement: a clip per phrase, laid end to end,
 * with `gapAfterMs` inserted between them. That is why it accumulates a cursor. Here
 * the performance already contains its own pauses — the narrator breathed where he
 * breathed — so accumulating would invent a second set on top of the real ones and
 * drift picture away from voice a little further with every phrase.
 *
 * So positions are taken, not computed, and `gapAfterMs` is written back from the
 * silence that is really there. That keeps the field honest for anything downstream
 * that reads it, without it ever being used to place anything.
 */
export function retimeFromTake(plan: VideoPlan, placed: readonly PlacedPhrase[]): VideoPlan {
  const byKey = new Map(placed.map((item) => [`${item.sectionId}/${item.phraseId}`, item]));
  const takeEndMs = placed.reduce((end, item) => Math.max(end, item.startMs + item.durationMs), 0);

  /** Where the next section that actually speaks begins, or the end of the audio. */
  const nextSpokenStart = (afterIndex: number) => {
    for (const later of plan.sections.slice(afterIndex + 1)) {
      const first = later.phrases[0];
      const found = first && byKey.get(`${later.id}/${first.id}`);
      if (found) return found.startMs;
    }
    return takeEndMs;
  };

  // A section with no phrases of its own has no position in the take to read, so it
  // borrows the moment its neighbours leave free.
  let cursorMs = 0;
  const sections = plan.sections.map((section, index) => {
    const phrases = section.phrases.map((phrase) => {
      const found = byKey.get(`${section.id}/${phrase.id}`);
      if (!found) {
        throw new Error(
          `${section.id}/${phrase.id} was not located in the take. `
          + "Verify the alignment before retiming from it.",
        );
      }
      return {...phrase, startMs: round(found.startMs), durationMs: round(found.durationMs)};
    });

    // Gaps become a description of the take rather than an instruction to the assembler.
    for (let i = 0; i < phrases.length; i++) {
      const next = phrases[i + 1];
      const end = phrases[i]!.startMs + phrases[i]!.durationMs;
      phrases[i] = {...phrases[i]!, gapAfterMs: next ? round(Math.max(0, next.startMs - end)) : 0};
    }

    if (!phrases.length) {
      const startMs = cursorMs;
      cursorMs += SILENT_SECTION_MIN_MS;
      return {...section, phrases, startMs: round(startMs), durationMs: SILENT_SECTION_MIN_MS};
    }

    // Sections tile the timeline: each starts where the last one ended, and the first
    // starts at zero. Starting at the first spoken word instead would leave the take's
    // lead-in silence showing as blank video before scene one appears.
    const startMs = cursorMs;
    // A section runs until the next one starts, so the pause after its last line belongs
    // to it rather than falling into a gap nothing owns.
    const endMs = nextSpokenStart(index);
    // The floor can push a short section past where the next one was measured to begin.
    // The cursor has to follow it, or the tiling opens a hole the width of the clamp.
    const durationMs = round(Math.max(endMs - startMs, SILENT_SECTION_MIN_MS));
    cursorMs = startMs + durationMs;
    return {...section, phrases, startMs: round(startMs), durationMs};
  });

  return {...plan, sections, narration: {...plan.narration, timing: "aligned-take"}};
}

/**
 * Gaps a phrase list should carry before anything is synthesised, so the first
 * narration pass already sounds paced rather than breathless.
 */
export function seedGaps(plan: VideoPlan): VideoPlan {
  const sections = plan.sections.map((section) => ({
    ...section,
    phrases: section.phrases.map((phrase, index) => ({
      ...phrase,
      // A longer beat at a section boundary; a short breath between phrases.
      gapAfterMs: phrase.gapAfterMs || (index === section.phrases.length - 1 ? 340 : 140),
    })),
  }));
  return {...plan, sections};
}

/** Snap a section boundary onto a frame so `check` never sees a sub-frame drift. */
export function snapToFrame(ms: number, fps: number) {
  return Math.round((ms / 1000) * fps) / fps * 1000;
}

const round = (value: number) => Math.round(value);
