import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {figureFactState} from "./trail.ts";
import type {ProductFact} from "./facts.ts";

const PAGE = "https://kontent.ai/blog/10-insights-from-content-creators-toolbox/";

/** The figure the extractor wrote, verbatim from the live run this test exists because of. */
const FIGURE = {
  statement: "Content professionals spend 3.4 hours each day creating content.",
  value: 3.4,
};

const fact = (over: Partial<ProductFact> = {}): ProductFact => ({
  id: "f-1",
  kind: "problem",
  statement: "Content professionals spend an average of 3.4 hours every working day creating content.",
  evidence: "\"On average, content professionals spend 3.4 hours each day creating content.\"",
  source: PAGE,
  state: "proposed",
  updatedAt: "2026-07-30T13:31:56.016Z",
  ...over,
});

test("a figure nobody proposed has no state", () => {
  assert.equal(figureFactState(FIGURE, PAGE, []), null);
});

test("a fact quoting the statement word for word is matched", () => {
  const same = fact({statement: FIGURE.statement});
  assert.equal(figureFactState(FIGURE, PAGE, [same]), "proposed");
});

test("a reworded fact from the same page is still the same claim", () => {
  // The live failure. The agent tightened the extractor's sentence when proposing it, the
  // strings stopped matching, and the tab told the owner nothing had been proposed while
  // the fact sat in the Brand screen. Rewording is the agent doing its job.
  assert.equal(figureFactState(FIGURE, PAGE, [fact()]), "proposed");
});

test("approving that fact flips the figure in the trail", () => {
  assert.equal(figureFactState(FIGURE, PAGE, [fact({state: "approved"})]), "approved");
});

test("the same number from a different page does not count", () => {
  // Two pages can print 3.4 and mean different things. The pair is what carries the match:
  // this figure came off that page, and the fact has to name it.
  const elsewhere = fact({source: "https://example.com/other-survey"});
  assert.equal(figureFactState(FIGURE, PAGE, [elsewhere]), null);
});

test("a neighbouring figure on the same page is not claimed by its neighbour's fact", () => {
  // The page also prints 3.7 for under-35s. Approving the 3.4 fact must not mark 3.7 as
  // approved — that would put a state on a number no one has ever looked at.
  const other = {statement: "People under 35 spend about 3.7 hours per day creating content.", value: 3.7};
  assert.equal(figureFactState(other, PAGE, [fact({state: "approved"})]), null);
});

test("a fact that rounds the page's number does not claim the figure", () => {
  // "about 3 hours" is a different claim from 3.4, and the whole architecture is about not
  // letting a number drift from what a page actually printed.
  const rounded = fact({statement: "Content teams spend about 3 hours a day on content."});
  assert.equal(figureFactState(FIGURE, PAGE, [rounded]), null);
});

test("a trailing slash is not a different page", () => {
  assert.equal(figureFactState(FIGURE, `${PAGE.replace(/\/$/, "")}`, [fact()]), "proposed");
});

test("a hand-typed fact with no source matches nothing", () => {
  // Facts entered in the Brand screen carry an empty `source`. Two empty strings are equal,
  // so without a guard every sourceless fact would claim every figure whose number it names.
  const typed = fact({source: "", statement: "We save teams 3.4 hours a day."});
  assert.equal(figureFactState(FIGURE, "", [typed]), null);
});

test("the trail cannot write a fact", () => {
  // Structural, and the same invariant search.test.ts asserts for figures.ts. This module is
  // imported by the route that renders the Sources tab, which shows fact state and so looks
  // like a place that could set one.
  const source = readFileSync(new URL("./trail.ts", import.meta.url), "utf8");
  for (const forbidden of ["writeFacts", "saveResearch", "recordSource"]) {
    assert.ok(!source.includes(forbidden), `trail.ts reaches for ${forbidden}`);
  }
});
