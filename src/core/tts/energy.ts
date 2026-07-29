import type {Energy} from "../plan/schema.ts";

/**
 * Turns a section's place on the energy curve into a delivery direction for the voice.
 *
 * Written as *changes against the brand's own narration style*, never as a replacement
 * for it. The brand voice stays what it is; what varies is how hard this particular
 * stretch leans. That distinction is the whole point: the ask is more energy without
 * losing the calm, and the way to get both is dynamic range rather than a higher level.
 *
 * Nothing here mentions excitement, enthusiasm or selling. A lift in a thought
 * leadership piece is conviction, not volume.
 */
export const ENERGY_DIRECTION: Record<Energy, string> = {
  quiet: "quieter, a shade slower, weighted",
  settled: "even, unhurried, certain",
  lift: "warmer and slightly quicker, conviction rising, never enthusiastic",
  edge: "sharper and flatter, crisp consonants, no warmth",
};

/**
 * The brand's voice first, then how this stretch differs from it.
 *
 * Kept to a single line of adjectives, on purpose. Written as full sentences these
 * directions get read aloud: a 40-word instruction produced a 17.6s clip for an
 * eight-word line, because the model treated the direction as more transcript. Short
 * adjectival phrases do not look like something to say. The duration guard in
 * `narrate.ts` is the backstop that catches it if this ever slips again.
 */
export function deliveryFor(baseStyle: string, energy: Energy): string {
  const base = baseStyle.trim().replace(/\s+/g, " ");
  const direction = ENERGY_DIRECTION[energy];
  return base ? `${base} Here: ${direction}.` : `${direction}.`;
}

/**
 * The same curve, told to a narrator reading the whole piece in one go.
 *
 * `deliveryFor` above exists because each phrase used to be its own request, and a
 * request containing one sentence can only be told about that sentence. It survives for
 * the fallback path. But a curve is a property of a performance, not of a line — nobody
 * directs an actor by writing "[settled]" beside line three — and a listener confirmed
 * it: bracket labels per line were barely audible, while the same curve given as an arc
 * changed the reading.
 *
 * Deliberately absent: any instruction about pace. Adding "a shade quicker than
 * conversation" measured 1.77 words per second against 2.33 without it. Extra directions
 * compete with the arc rather than adding to it.
 */
const ARC_OPENING: Record<Energy, string> = {
  quiet: "He opens low and deliberate, as though the thought arrived before the recording did",
  settled: "He opens plainly, already sure of the ground he is on",
  lift: "He opens with something he is glad to be saying, warm but not bright",
  edge: "He opens cool and a little clipped, like someone naming a problem he is tired of seeing",
};

const ARC_MIDDLE: Record<Energy, string> = {
  quiet: "he pulls back for the part that has to land",
  settled: "he is explaining, and it evens out",
  lift: "it opens up and gains conviction",
  edge: "he sharpens again",
};

// Note what none of these say: anything about speed. `quiet` first read "quieter and
// slower" and a test rejected it, correctly — asking for slow is what produced a take a
// listener called not engaging, and quiet is a matter of weight, not tempo.
const ARC_LANDING: Record<Energy, string> = {
  quiet: "the last lines drop rather than rise, held low, the weight carried by the words themselves",
  settled: "the last lines simply state it, level and plain, with nothing added at the end",
  lift: "the last lines are the point he came to make, and they arrive warm and certain: conviction, never volume",
  edge: "the last lines land flat and exact, with no softening on the way out",
};

/*
 * There was a per-section direction table here — "Say plainly and evenly", one line
 * stated above each section's copy. It is gone, and the arc below is now the only
 * delivery instruction a take receives.
 *
 * Twenty takes across four schemes decided it. Nothing separated on duration; the
 * medians were a tie and the run-to-run spread was larger than any difference between
 * schemes. What did separate was continuity, measured as the pause at a section boundary
 * against the pause between phrases inside one: 1.26 with a direction per section, 1.09
 * with none. A listener picked the undirected take unprompted as the only one that
 * sounded recorded in a single pass, and judged its pace better too.
 *
 * The two attempts to keep some structure both failed. Grouping sections into three
 * movements cut across the curve — it handed the section that pulls back a direction
 * saying "flatly and precisely, no warmth" — and threw a 143-second take. Phrasing a
 * direction as a transition ("Now say it quieter") was worse still: the model performs
 * the instruction rather than applying it, and boundary pauses reached five times the
 * internal ones.
 *
 * This is the fourth time this file has reached the same conclusion, after bracket
 * labels, after asking for speed, and after "momentum over polish". Every instruction
 * added to this prompt has cost more than it bought. What is left is one arc, and
 * checks on the audio that comes back.
 */

/** Directs a whole take from the curve the plan already carries. */
export function arcDirection(energies: readonly Energy[]): string {
  if (!energies.length) return "";
  const opening = energies[0]!;
  const landing = energies[energies.length - 1]!;

  // Only the changes are worth naming. A middle holding one energy across four sections
  // is a single instruction, and repeating it reads as an instruction to escalate.
  const middle: string[] = [];
  let previous = opening;
  for (const energy of energies.slice(1, -1)) {
    if (energy !== previous) middle.push(ARC_MIDDLE[energy]);
    previous = energy;
  }

  return [
    `${ARC_OPENING[opening]}.`,
    middle.length ? `Through the middle ${middle.join(", then ")}.` : "",
    `Then ${ARC_LANDING[landing]}.`,
  ].filter(Boolean).join(" ");
}

/**
 * A default curve for a piece whose planner did not set one.
 *
 * Opens settled, states the problem with an edge, pulls quiet for the line that has to
 * land, lifts on the turn, and finishes with a lift so the piece ends on a move forward
 * rather than on the diagnosis.
 */
export function defaultCurve(count: number): Energy[] {
  if (count <= 0) return [];
  const curve: Energy[] = ["settled", "edge", "quiet", "lift"];
  return Array.from({length: count}, (_, index) => {
    if (index === 0) return "settled";
    if (index === count - 1) return "lift";
    return curve[index % curve.length] ?? "settled";
  });
}

/**
 * How much a section's motion should push, as a multiplier on the brand's own entrance
 * duration and stagger. Same curve, so picture and voice move together instead of the
 * voice lifting over a picture that does not.
 */
/**
 * How much a section's motion should push, as a multiplier on the brand's own entrance
 * duration and stagger. Same curve as the voice, so picture and narration move together
 * instead of the voice lifting over a picture that does not.
 *
 * Note what `quiet` does *not* say: hold. An earlier version of this table asked for
 * "longer holds", which contradicts the contract's rule that nothing sits still for more
 * than a second, and a composition duly failed the post-render freeze check for doing
 * exactly what it was told. Quiet means slower continuous movement, never stillness.
 */
export const ENERGY_MOTION: Record<Energy, {pace: number; note: string}> = {
  quiet: {pace: 1.35, note: "slower entrances and one slow continuous drift, fewer things moving at once but never nothing"},
  settled: {pace: 1, note: "the brand's default pace"},
  lift: {pace: 0.8, note: "quicker entrances, tighter stagger, upward direction of travel"},
  edge: {pace: 0.66, note: "fast and flat, little easing, cuts rather than glides"},
};
