/**
 * Reading numbers out of prose, and deciding whether a number a figure claims is one the
 * prose actually printed.
 *
 * Split out of `figures.ts` rather than exported from it. `figures.ts` imports the agent SDK
 * to run the extraction model, and the numeric gate in `facts.ts` is the lowest layer there
 * is — tools, server and studio all sit on top of it. A gate that cannot run without the
 * model it exists to police is the wrong shape.
 */

/**
 * Scale words, so a page that writes "1.5 million readers" sources the value 1500000.
 *
 * This exists because the first version of the check did not have it, and every scaled figure
 * on a real page was dropped: "$1 million by 1906", "108 million reviews", "1.5 million
 * readers". The prompt asks for 2400000 from "2.4 million" — it has to, or a charted value and
 * a bare count would not be the same kind of number — so a check that looked only for the
 * numeral was rejecting the exact transformation it had asked for.
 *
 * `billion` is read the English way, as 1e9. On a German page it means 1e12, and German has
 * `Milliarde` for 1e9 — so this table is not a language authority. The asymmetry is worth
 * knowing: a German trillion the model scaled correctly is dropped here, which is the safe
 * failure, while one it scaled as an English billion is let through, which is not — and that
 * needs the model to have been wrong first. The sentence sits beside the number in the Brand
 * screen for exactly this kind of reason.
 */
const SCALES = new Map<string, number>([
  ["thousand", 1e3], ["thousands", 1e3], ["tausend", 1e3],
  ["million", 1e6], ["millions", 1e6], ["millionen", 1e6],
  ["billion", 1e9], ["billions", 1e9], ["milliarde", 1e9], ["milliarden", 1e9],
  ["trillion", 1e12], ["trillions", 1e12],
]);

/** A number as the copy printed it, with whatever sits on it. */
export interface NumberMention {
  /** Verbatim, for the error message: "40", "1.5 million", "2019". */
  readonly text: string;
  /** The digits, scaled if a scale word followed. */
  readonly value: number;
  /** A percent, multiplier or currency attached to the number, or "" for a bare numeral. */
  readonly unit: string;
}

/**
 * Every number a piece of copy states, with its unit.
 *
 * Deliberately policy-free: no year carve-out, no clock times, no opinion about which numbers
 * need sourcing. Those are decisions the gate makes, and they belong beside the doc comments
 * that justify them in `facts.ts` — this only reports what the copy printed.
 *
 * The unit is separated rather than dropped because the year carve-out needs it. "2019" is a
 * date and "2019%" is a measurement, and a tokenizer that returned only digits would make
 * those indistinguishable.
 */
export function numbersIn(copy: string): NumberMention[] {
  const mentions: NumberMention[] = [];
  // Three alternatives, and the order is load-bearing. Space-grouped thousands must come
  // first or the second alternative takes "1" out of "1 200" and leaves "200" behind. The
  // second must END in a digit: a greedy [\d.,]* swallows the full stop in "changed in 2019."
  // and the resulting "2019." is not a year any anchored test will recognise.
  const token = /\d{1,3}(?:[\s\u00A0\u202F]\d{3}(?!\d))+(?:[.,]\d+)?|\d[\d.,]*\d|\d/g;
  for (const match of copy.matchAll(token)) {
    const index = match.index ?? 0;
    // Defensive: the grammar above should already end on a digit.
    const printed = (match[0] ?? "").replace(/[.,]+$/, "");
    const value = asNumber(printed);
    if (!Number.isFinite(value)) continue;

    const tail = copy.slice(index + (match[0] ?? "").length);
    let unit = "";
    let text = printed;
    let scaled = value;

    const currency = copy[index - 1] ?? "";
    if ("€$£".includes(currency)) unit = currency;
    if (!unit) {
      // `x` only as a multiplier — "3x faster", never the x in "3 xylophones".
      const suffix = /^[\s\u00A0\u202F]?(%|×|x(?![\p{L}])|percent|prozent)/iu.exec(tail);
      if (suffix) unit = (suffix[1] ?? "").trim();
    }
    if (!unit) {
      const word = /^[\s\u00A0\u202F]{0,2}(\p{L}+)/u.exec(tail);
      const scale = SCALES.get((word?.[1] ?? "").toLowerCase());
      // One mention, not two: the owner needs to see "1.5 million" in the error, and emitting
      // the bare mantissa alongside it would report a number the copy never stated on its own.
      if (scale) {
        scaled = value * scale;
        text = `${printed} ${word?.[1] ?? ""}`;
      }
    }
    mentions.push({text, value: scaled, unit});
  }
  return mentions;
}

/** "1,200", "1.5" and "1,5" all mean what a reader takes them to mean. */
export function asNumber(printed: string): number {
  // A comma with one or two digits after it and nothing following is a decimal comma, as
  // German pages write it. Every other comma is a thousands separator.
  return Number(printed.replace(/,(\d{1,2})$/, ".$1").replace(/[,\s\u00A0\u202F]/g, ""));
}

/**
 * True when `value` is what the page printed in `context` — as a numeral, or as a number
 * followed by a scale word.
 *
 * Thousands separators are normalised away, because "1,200" and 1200 are the same claim.
 * Digit boundaries are not: 7 is not sourced by "17 million", and 7 is not sourced by "0.7".
 * A number the page only implies — "roughly two thirds" — fails here, which is the point.
 */
export function valueAppearsIn(value: number, context: string): boolean {
  // Explicit escapes for the two non-breaking spaces. They are what a page actually uses
  // as a thousands separator, and as literal characters they are invisible to review.
  const normalized = context.replace(/[\s,\u00A0\u202F](?=\d{3}(?!\d))/g, "");
  const candidates = [String(value)];
  // "3" and "3.0" are the same figure written two ways, and only one of them is `String(3)`.
  if (Number.isInteger(value)) candidates.push(`${value}.0`);
  // A German page prints "3,4 Stunden". Same figure, one separator apart — and the
  // normalisation above only strips a comma that groups thousands, so a decimal comma never
  // reaches the numeral pass on its own. Without this, no German figure sources anything.
  else candidates.push(String(value).replace(".", ","));
  const asPrinted = candidates.some((candidate) => {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\d.])${escaped}(?![\\d])`).test(normalized);
  });
  if (asPrinted) return true;

  // A plain mantissa, not a run of digits and separators. A greedy class swallows "2016, 108
  // million" as a single number, and the effect is not a false accept but a false *drop*: the
  // real "108 million" is eaten by the bad match and never tried on its own.
  const scaled = /(\d+(?:[.,]\d+)?)[\s\u00A0\u202F]{0,2}([A-Za-z\u00C4\u00D6\u00DC\u00E4\u00F6\u00FC]+)/g;
  for (const match of context.matchAll(scaled)) {
    const scale = SCALES.get((match[2] ?? "").trim().toLowerCase());
    if (!scale) continue;
    // Rounded on both sides: 2.4 × 1e6 is not exactly 2400000 in binary floating point, and no
    // figure should be dropped over the last bit of a mantissa.
    if (Math.round(asNumber(match[1] ?? "") * scale) === Math.round(value)) return true;
  }
  return false;
}
