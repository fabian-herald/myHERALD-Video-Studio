import type {Figure} from "./figures.ts";
import {valueAppearsIn} from "./numbers.ts";
import type {ProductFact} from "./facts.ts";

/**
 * What became of a figure in the trail: the state of the fact that carries it, or `null`
 * when nobody has proposed it.
 *
 * Read-only by construction — it takes facts and returns a string. There is deliberately no
 * writer in this module: the Sources tab shows this annotation, which makes it look like a
 * place that could change a fact's state, and exactly one code path may do that.
 *
 * Two ways a figure and a fact can be the same claim:
 *
 *  1. **The same sentence.** What `propose_facts` dedupes on, so it holds when the agent
 *     proposes the extractor's statement unchanged.
 *  2. **The same number off the same page.** Which is what the first live run needed: the
 *     extractor wrote "Content professionals spend 3.4 hours each day creating content" and
 *     the agent proposed "…an average of 3.4 hours every working day…". One claim, two
 *     wordings, and on strings alone the tab reported that nothing had been proposed while
 *     the fact sat in the Brand screen waiting. Rewording is the agent doing its job.
 *
 * The second rule is deliberately narrow. `valueAppearsIn` rather than a substring test, so
 * 3.4 is not matched by 3.45 and a fact that rounds the page down to "about 3 hours" does
 * not get to claim this figure. Same page *and* same number is a strong pair, and the error
 * it could make is small either way: the fabrication the architecture exists to catch is a
 * number that was never on the page at all, and such a figure has no fact to match.
 */
export function figureFactState(
  figure: Pick<Figure, "statement" | "value">,
  sourceUrl: string,
  facts: readonly ProductFact[],
): ProductFact["state"] | null {
  const said = figure.statement.trim().toLowerCase();
  const worded = facts.find((fact) => fact.statement.trim().toLowerCase() === said);
  if (worded) return worded.state;

  const reworded = facts.find((fact) =>
    sameUrl(fact.source, sourceUrl) && valueAppearsIn(figure.value, fact.statement));
  return reworded?.state ?? null;
}

/**
 * Same page, allowing for a trailing slash.
 *
 * Nothing more than that: the two strings come from the same place — the URL `read_source`
 * was given — so normalising further would be inventing a difference to solve. An empty
 * `source` on a hand-typed fact must never match a real page, hence the length guard.
 */
const sameUrl = (a: string, b: string): boolean => {
  const strip = (url: string) => url.trim().replace(/\/+$/, "");
  return strip(a).length > 0 && strip(a) === strip(b);
};
