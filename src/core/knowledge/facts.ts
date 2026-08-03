import fs from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {KNOWLEDGE_DIR} from "../paths.ts";
import {numbersIn, valueAppearsIn} from "./numbers.ts";

export const factZ = z.object({
  id: z.string(),
  kind: z.enum(["audience", "problem", "outcome", "capability", "proof"]),
  statement: z.string(),
  /** Required whenever the statement contains a number — no evidence, no claim. */
  evidence: z.string().default(""),
  state: z.enum(["proposed", "approved", "rejected"]).default("proposed"),
  source: z.string().default(""),
  updatedAt: z.string().default(""),
});

export type ProductFact = z.infer<typeof factZ>;

const FACTS_PATH = path.join(KNOWLEDGE_DIR, "facts.json");

export async function readFacts(): Promise<ProductFact[]> {
  const raw = await fs.readFile(FACTS_PATH, "utf8").catch(() => "[]");
  const parsed = z.array(factZ).safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : [];
}

export async function writeFacts(facts: readonly ProductFact[]): Promise<void> {
  await fs.mkdir(path.dirname(FACTS_PATH), {recursive: true});
  await fs.writeFile(FACTS_PATH, `${JSON.stringify(facts, null, 2)}\n`, "utf8");
}

export const containsNumericClaim = (statement: string) =>
  /\d/.test(statement) && !/^\s*\D*$/.test(statement);

/**
 * Only approved facts reach a prompt, and an approved fact carrying a number without
 * an evidence note is withheld. The gate lives here, in code — never in a prompt,
 * because a prompt rule is a suggestion and this is not.
 */
export async function approvedStatements(known?: readonly ProductFact[]): Promise<string[]> {
  // Callers that have already read the file pass it back rather than reading twice. The
  // filter and the `(evidence: …)` shape stay owned here: they decide what a figure may be
  // matched against, and a second copy of that rule elsewhere would drift out of step.
  const facts = known ?? await readFacts();
  return facts
    .filter((fact) => fact.state === "approved")
    .filter((fact) => !containsNumericClaim(fact.statement) || fact.evidence.trim().length > 0)
    .map((fact) => `${fact.statement}${fact.evidence ? ` (evidence: ${fact.evidence})` : ""}`);
}

/**
 * A bare four-digit year, which is prose rather than a statistic.
 *
 * Carved out deliberately. "Since 2019 the tooling changed" is a claim, but it is not the
 * kind this gate exists for, and a gate that rejects every date is a gate that gets
 * switched off — which costs more than the exemption. Anything carrying a unit, a percent,
 * a multiplier or a currency is still caught, including a year with one attached.
 */
const BARE_YEAR = /^(19|20)\d{2}$/;

/**
 * A time of day, which is scene-setting rather than a statistic.
 *
 * Same reasoning as BARE_YEAR, and found the same way — by running the gate over the videos
 * already shipped. "Donnerstag, 16 Uhr" and "Thursday, 4pm" are the picture a script paints,
 * not a claim anyone would quote, and a gate that refuses them is a gate that gets switched
 * off. Stripped from the copy before it is read for numbers, so the tokenizer stays free of
 * any opinion about what the digits mean.
 */
const CLOCK_TIME = /\b\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.|Uhr)\b/gi;

/**
 * A named period — "Q1", "H2", "FY24" — which is an axis label, not a measurement.
 *
 * The third of these carve-outs, and the reason there are three: chart point labels are read
 * for numbers too, and "Q1" carries the digit 1 while claiming nothing. A quarter is a date
 * written short, so it belongs with BARE_YEAR rather than beside the value it labels — and
 * the value itself is checked against the fact it cites, which is the stronger rule anyway.
 */
const PERIOD_LABEL = /\b(?:Q[1-4]|H[12]|FY\s?\d{2,4})\b/gi;

/**
 * The numbers in `copy` that no approved fact states.
 *
 * Collects rather than throws, so the planner can hand the list back to the model for a
 * retry the way `copyRulesViolation` does — a plan that invented one figure is worth another
 * attempt, not a dead run.
 *
 * Matching is `valueAppearsIn` rather than a substring test, and that is the whole fix. A
 * substring accepted "40 points" on the strength of "Founded in 1940", and refused "40
 * percent" against a fact that said exactly that, because the token was compared with its
 * spaces removed and the fact's were not. Comparing parsed numbers instead makes "1,200" and
 * "1200", "12%" and "12 percent", "12,5" and "12.5" the same claim — which is what a reader
 * takes them to be.
 */
export function unverifiedNumbers(copy: string, approved: readonly string[]): string[] {
  const backing = approved.join(" ");
  const unverified = numbersIn(copy.replace(CLOCK_TIME, " ").replace(PERIOD_LABEL, " "))
    // The carve-out has to see the unit. After tokenizing, "2019." and "2019%" both carry the
    // digits 2019, and only the bare one is a date — testing the digits alone would exempt a
    // measurement that happens to look like a year.
    .filter((mention) => !(BARE_YEAR.test(mention.text) && !mention.unit))
    .filter((mention) => !valueAppearsIn(mention.value, backing))
    .map((mention) => mention.text + mention.unit);
  return [...new Set(unverified)];
}
