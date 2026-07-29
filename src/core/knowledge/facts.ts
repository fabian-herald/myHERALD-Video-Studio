import fs from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {KNOWLEDGE_DIR} from "../paths.ts";

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
export async function approvedStatements(): Promise<string[]> {
  const facts = await readFacts();
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
 * Rejects generated copy that states a number no approved fact backs. Applied after
 * generation as well as before, because a model can invent a figure mid-sentence.
 */
export function assertNoUnverifiedNumericClaims(copy: string, approved: readonly string[]): void {
  const numbers = copy.match(/\b\d[\d.,]*\s*(?:%|percent|prozent|x|×)?/gi) ?? [];
  const backing = approved.join(" ");
  const unverified = numbers
    .map((value) => value.trim())
    .filter((value) => !BARE_YEAR.test(value))
    .filter((value) => value.length > 1 && !backing.includes(value.replace(/\s+/g, "")));
  if (unverified.length) {
    throw new Error(
      `Generated copy states unverified numbers: ${[...new Set(unverified)].join(", ")}. `
      + "Approve a fact with an evidence note, or remove the figure.",
    );
  }
}
