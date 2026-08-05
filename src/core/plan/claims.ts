import {containsNumericClaim, isUsableFact, unverifiedNumbers, type ProductFact} from "../knowledge/facts.ts";
import {valueAppearsIn} from "../knowledge/numbers.ts";
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
 * `planCopy` plus the text a `data` block burns in: its source note and every point label.
 *
 * A separate function rather than a wider `planCopy`, because that string is also what
 * `factIdsUsedByPlan` matches statements against. A caption is an attribution, not a claim —
 * folding it in there would record facts a video never actually spent, and fact usage is what
 * the ledger reads to decide a figure has been used too often.
 *
 * `point.value` is deliberately absent. It is checked against the fact it cites, which is
 * strictly stronger than this scan: fold it in here and a charted number would pass because
 * some unrelated approved fact happened to mention it.
 */
export const planClaimText = (plan: VideoPlan): string =>
  plan.sections
    .flatMap((section) => [
      section.onScreen,
      ...section.phrases.map((phrase) => phrase.text),
      section.data?.caption ?? "",
      ...(section.data?.points ?? []).map((point) => point.label),
    ])
    .filter(Boolean)
    .join(" ");

/**
 * Every reason a plan states a figure it cannot source, as prose, or null when it is clean.
 *
 * This is the gate the architecture promised and never had: the numeric check existed since
 * the port and was called from nowhere, so every figure a planner invented went straight to
 * a rendered, captioned, publishable file. It runs right after planning, because that is the
 * cheapest place to fail — one planning call rather than a narration take and a twenty-minute
 * compose.
 *
 * Returning prose rather than throwing, following `copyRulesViolation`: the planner hands the
 * list back to the model for another attempt, and the edit path wraps it in an exception with
 * a remedy that suits an already-rendered video. A plan that invented one number is worth a
 * retry, not a dead run.
 *
 * Two rules, and the second is the one that makes charts trustworthy:
 *
 *  1. Any figure in the copy must appear in an approved fact. A fact carrying a number
 *     with no evidence note is not approved for this purpose — `approvedStatements`
 *     already withholds it, so the figure has nothing to match against and fails here.
 *  2. Every value in a `data` block must name a `factId` that resolves to an approved
 *     fact, *and* the fact must state that number. A chart is the easiest place in a video
 *     to assert a number nobody can source, and it is the place a viewer is least likely to
 *     question one. Checking only the id was the hole this rule shipped with: the citation
 *     resolved, the bar said whatever the planner felt like, and every gate passed.
 */
export function planClaimsViolation(
  plan: VideoPlan,
  facts: readonly ProductFact[],
  approved: readonly string[],
  /**
   * `kit.website`, so third-party research counts as usable here exactly as it does in
   * `approvedStatements` and the planner's `citableFacts` — see `isUsableFact`. Omitted, this
   * falls back to approved-only, which is the safe reading but a *stricter* one than the
   * planner was given: the planner would be shown a figure and then refused for charting it.
   * Every production caller passes it.
   */
  brandHost?: string,
): string | null {
  const problems: string[] = [];
  for (const number of unverifiedNumbers(planClaimText(plan), approved)) {
    problems.push(`- "${number}" appears in the copy and no approved fact states it`);
  }

  const usable = new Map(
    facts
      .filter((fact) => isUsableFact(fact, brandHost))
      .filter((fact) => !containsNumericClaim(fact.statement) || fact.evidence.trim().length > 0)
      .map((fact) => [fact.id, fact]),
  );

  for (const section of plan.sections) {
    if (!section.data) continue;
    for (const point of section.data.points) {
      const fact = usable.get(point.factId);
      if (!fact) {
        problems.push(
          `- §${section.id} charts ${point.label} = ${point.value} against fact "${point.factId}", `
          + "which is not a usable fact with evidence",
        );
        continue;
      }
      // The check the citation only implied. A resolvable factId proves a fact was named; it
      // proves nothing about the number, and a bar labelled 40 beside a fact that says 12 is
      // the most quotable lie this pipeline can produce — sourced-looking, and wrong.
      //
      // The statement and its evidence note, and nothing else. `source` is a URL, and
      // "…/10-insights-from-content-creators-toolbox/" would source a chart of 10 off a slug.
      if (!valueAppearsIn(point.value, `${fact.statement} ${fact.evidence}`)) {
        problems.push(
          `- §${section.id} charts ${point.label} = ${point.value}, but fact "${fact.id}" `
          + `does not state that number: "${fact.statement}"`,
        );
      }
    }
    if (!section.data.caption.trim()) {
      // Enforced rather than defaulted. A figure whose source is not on screen is not
      // citable by anyone watching, and the composer cannot invent the attribution.
      problems.push(`- §${section.id} puts figures on screen with no source note`);
    }
  }

  return problems.length ? problems.join("\n") : null;
}

/** The gate as `run.ts` applies it, once the planner has had its retries. */
export function assertPlanClaimsAreSourced(
  plan: VideoPlan,
  facts: readonly ProductFact[],
  approved: readonly string[],
  brandHost?: string,
): void {
  const violation = planClaimsViolation(plan, facts, approved, brandHost);
  if (violation) {
    throw new Error(
      `Plan states figures it cannot source:\n${violation}\n`
      + "Approve a fact with an evidence note, chart the number the fact actually states, "
      + "or drop the figure.",
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
    // Not `state === "approved"`: research facts reach a video without that step, and a
    // ledger that cannot see them under-reports what the archive has already spent — which
    // is the signal `citableBlock` uses to stop the same figure appearing in nine videos.
    if (fact.state === "rejected") continue;
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
