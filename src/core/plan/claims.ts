import {assertNoUnverifiedNumericClaims, containsNumericClaim, type ProductFact} from "../knowledge/facts.ts";
import type {VideoPlan} from "./schema.ts";

/**
 * Everything on screen or spoken, as one string.
 *
 * Both matter and for the same reason: a caption is burned in and a narration line is
 * transcribed, so an invented figure is equally quotable either way.
 */
export const planCopy = (plan: VideoPlan): string =>
  plan.sections
    .flatMap((section) => [section.onScreen, ...section.phrases.map((phrase) => phrase.text)])
    .filter(Boolean)
    .join(" ");

/**
 * Refuse a plan that states a number nothing approved stands behind.
 *
 * This is the gate the architecture promised and never had: `assertNoUnverifiedNumericClaims`
 * has existed since the port and was called from nowhere, so every figure a planner
 * invented went straight to a rendered, captioned, publishable file. It runs here, right
 * after planning, because that is the cheapest place to fail — one planning call rather
 * than a narration take and a twenty-minute compose.
 *
 * Two rules, and the second is the one that makes charts trustworthy:
 *
 *  1. Any figure in the copy must appear in an approved fact. A fact carrying a number
 *     with no evidence note is not approved for this purpose — `approvedStatements`
 *     already withholds it, so the figure has nothing to match against and fails here.
 *  2. Every value in a `data` block must name a `factId` that resolves to an approved
 *     fact. A chart is the easiest place in a video to assert a number nobody can source,
 *     and it is the place a viewer is least likely to question one.
 */
export function assertPlanClaimsAreSourced(
  plan: VideoPlan,
  facts: readonly ProductFact[],
  approved: readonly string[],
): void {
  assertNoUnverifiedNumericClaims(planCopy(plan), approved);

  const usable = new Map(
    facts
      .filter((fact) => fact.state === "approved")
      .filter((fact) => !containsNumericClaim(fact.statement) || fact.evidence.trim().length > 0)
      .map((fact) => [fact.id, fact]),
  );

  const problems: string[] = [];
  for (const section of plan.sections) {
    if (!section.data) continue;
    for (const point of section.data.points) {
      const fact = usable.get(point.factId);
      if (!fact) {
        problems.push(
          `§${section.id} charts ${point.label} = ${point.value} against fact "${point.factId}", `
          + "which is not an approved fact with evidence",
        );
      }
    }
    if (!section.data.caption.trim()) {
      // Enforced rather than defaulted. A figure whose source is not on screen is not
      // citable by anyone watching, and the composer cannot invent the attribution.
      problems.push(`§${section.id} puts figures on screen with no source note`);
    }
  }

  if (problems.length) {
    throw new Error(
      `Plan states figures it cannot source:\n- ${problems.join("\n- ")}\n`
      + "Approve a fact with an evidence note, or drop the figure.",
    );
  }
}

/**
 * Facts visibly or audibly used by a plan, including prose proof that is not expressed
 * as a chart. Chart ids remain authoritative; exact statement matching covers a planner
 * that quotes an approved fact in narration or display copy.
 */
export function factIdsUsedByPlan(
  plan: VideoPlan,
  facts: readonly ProductFact[],
): string[] {
  const used = new Set(plan.sections.flatMap((section) =>
    (section.data?.points ?? []).map((point) => point.factId)));
  const copy = normalizeClaimText(planCopy(plan));

  for (const fact of facts) {
    if (fact.state !== "approved") continue;
    const statement = normalizeClaimText(fact.statement);
    if (statement && copy.includes(statement)) used.add(fact.id);
  }
  return [...used];
}

const normalizeClaimText = (value: string) => value
  .toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .replace(/\s+/g, " ")
  .trim();
