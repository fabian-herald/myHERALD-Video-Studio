import {allPhrases, ENERGIES, type Energy, type VideoPlan} from "./schema.ts";

/**
 * Measures how monotone a finished script is.
 *
 * "Too monotone" is a real property, not only a matter of taste, and it shows up in two
 * numbers: how much the spoken lines vary in length, and how much the delivery varies
 * across sections. A piece where every line runs 2.9 seconds at one energy setting will
 * sound flat however good the voice is.
 *
 * Both run against measured audio, after synthesis, so they describe the video that
 * actually exists rather than the one that was planned.
 */

export interface RhythmReport {
  /** Standard deviation of phrase length over the mean. Higher is more varied. */
  variation: number;
  shortestMs: number;
  longestMs: number;
  meanMs: number;
  /** Distinct energies used across sections. */
  energies: Energy[];
  /** Human-readable observations. Empty when the piece has a pulse. */
  notes: string[];
}

/**
 * Below this the lines are so close in length that the piece reads as metronomic.
 * Calibrated against the run that prompted this: every line between 2.1s and 3.9s
 * around a 2.9s mean, which is a coefficient of variation of about 0.17.
 */
const FLAT_VARIATION = 0.22;

export function measureRhythm(plan: VideoPlan): RhythmReport {
  const durations = allPhrases(plan)
    .map(({phrase}) => phrase.durationMs)
    .filter((ms) => ms > 0);

  const energies = [...new Set(plan.sections.map((section) => section.energy))]
    .sort((a, b) => ENERGIES.indexOf(a) - ENERGIES.indexOf(b));

  if (durations.length < 3) {
    return {variation: 0, shortestMs: 0, longestMs: 0, meanMs: 0, energies, notes: []};
  }

  const mean = durations.reduce((sum, ms) => sum + ms, 0) / durations.length;
  const spread = Math.sqrt(
    durations.reduce((sum, ms) => sum + (ms - mean) ** 2, 0) / durations.length,
  );
  const variation = mean > 0 ? spread / mean : 0;

  const notes: string[] = [];
  if (variation < FLAT_VARIATION) {
    notes.push(
      `Every spoken line runs close to ${(mean / 1000).toFixed(1)}s `
      + `(variation ${variation.toFixed(2)}, want ${FLAT_VARIATION}+). `
      + "Even lengths back to back are what make a calm piece read as flat. "
      + "One short line of three or four words would fix it.",
    );
  }
  if (energies.length < 2 && plan.sections.length >= 3) {
    notes.push(
      `Every section is marked \`${energies[0] ?? "settled"}\`, so the delivery never `
      + "changes. A lift only reads as a lift against a settled line before it.",
    );
  }

  return {
    variation: Number(variation.toFixed(3)),
    shortestMs: Math.min(...durations),
    longestMs: Math.max(...durations),
    meanMs: Math.round(mean),
    energies,
    notes,
  };
}
