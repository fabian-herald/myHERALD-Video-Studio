import assert from "node:assert/strict";
import {test} from "node:test";
import {unverifiedNumbers, type ProductFact} from "../knowledge/facts.ts";
import {
  assertPlanClaimsAreSourced,
  factIdsUsedByPlan,
  planClaimText,
  planClaimsViolation,
  planCopy,
} from "./claims.ts";
import {videoPlanZ, type VideoPlan} from "./schema.ts";

const fact = (over: Partial<ProductFact> = {}): ProductFact => ({
  id: "f1",
  kind: "proof",
  statement: "Teams cut drafting time by 40%.",
  evidence: "Internal cohort, 120 accounts, Q1 2026.",
  state: "approved",
  source: "https://myherald.io/data",
  updatedAt: "",
  ...over,
});

function plan(over: Partial<VideoPlan> = {}): VideoPlan {
  return videoPlanZ.parse({
    schemaVersion: 1,
    id: "test-1",
    createdAt: "2026-07-30T00:00:00.000Z",
    brief: "b",
    intent: "thought-leadership",
    formats: ["9x16"],
    title: "t",
    thesis: "th",
    narration: {},
    sections: [
      {id: "one", kind: "hook", onScreen: "A", phrases: [{id: "p1", text: "First line."}]},
      {id: "two", kind: "payoff", onScreen: "B", phrases: [{id: "p2", text: "Second line."}]},
    ],
    ...over,
  });
}

test("copy with no figures passes with nothing approved", () => {
  assertPlanClaimsAreSourced(plan(), [], []);
});

test("a figure in the copy with no approved fact behind it is refused", () => {
  const p = plan({
    sections: [
      {id: "one", kind: "hook", onScreen: "40% faster", phrases: [{id: "p1", text: "Teams cut drafting time by 40%."}]},
      {id: "two", kind: "payoff", onScreen: "B", phrases: [{id: "p2", text: "Second line."}]},
    ],
  } as Partial<VideoPlan>);
  assert.throws(() => assertPlanClaimsAreSourced(p, [], []), /no approved fact states it/);
});

test("the same figure passes once a fact with evidence backs it", () => {
  const p = plan({
    sections: [
      {id: "one", kind: "hook", onScreen: "", phrases: [{id: "p1", text: "Teams cut drafting time by 40%."}]},
      {id: "two", kind: "payoff", onScreen: "B", phrases: [{id: "p2", text: "Second line."}]},
    ],
  } as Partial<VideoPlan>);
  assertPlanClaimsAreSourced(p, [fact()], ["Teams cut drafting time by 40%. (evidence: cohort)"]);
});

test("a chart value must cite a fact that exists and is approved", () => {
  const withChart = (factId: string) => plan({
    sections: [
      {
        id: "one", kind: "proof", onScreen: "", phrases: [{id: "p1", text: "Look."}],
        data: {shape: "bars", unit: "%", caption: "Internal cohort, Q1 2026", points: [{label: "Before", value: 40, factId}]},
      },
      {id: "two", kind: "payoff", onScreen: "B", phrases: [{id: "p2", text: "Second line."}]},
    ],
  } as Partial<VideoPlan>);

  const approved = ["Teams cut drafting time by 40%. (evidence: cohort)"];
  assertPlanClaimsAreSourced(withChart("f1"), [fact()], approved);
  assert.throws(() => assertPlanClaimsAreSourced(withChart("invented"), [fact()], approved), /not a usable fact/);
});

/** A one-chart plan, so the value-vs-fact cases below differ only in what they chart. */
const charting = (value: number, factId = "f1") => plan({
  sections: [
    {
      id: "one", kind: "proof", onScreen: "", phrases: [{id: "p1", text: "Look."}],
      data: {shape: "bars", unit: "%", caption: "Internal cohort", points: [{label: "Q1", value, factId}]},
    },
    {id: "two", kind: "payoff", onScreen: "B", phrases: [{id: "p2", text: "Second line."}]},
  ],
} as Partial<VideoPlan>);

test("a chart value must be a number the fact it cites actually states", () => {
  // The hole this closes. Resolving the factId proved a fact was named and nothing about the
  // figure, so a bar could read 55 beside a fact that said 40 and every gate passed it.
  const approved = ["Teams cut drafting time by 40%. (evidence: Internal cohort, 120 accounts.)"];
  assertPlanClaimsAreSourced(charting(40), [fact()], approved);
  assert.throws(
    () => assertPlanClaimsAreSourced(charting(55), [fact()], approved),
    /does not state that number/,
  );
});

test("a chart value may come from the evidence note, not only the statement", () => {
  // The evidence carries the source sentence and its denominators, and a chart of the sample
  // size is exactly as citable as a chart of the headline figure.
  const f = fact({statement: "Teams draft faster.", evidence: "Internal cohort, 120 accounts."});
  assertPlanClaimsAreSourced(charting(120), [f], ["Teams draft faster. (evidence: Internal cohort, 120 accounts.)"]);
});

test("a source URL cannot source a chart value", () => {
  // A real fact in the corpus cites kontent.ai/blog/10-insights-from-content-creators-toolbox,
  // and a slug is not a claim — charting 10 off it would be sourcing a number from a filename.
  const f = fact({
    statement: "Teams draft faster.",
    evidence: "Internal cohort.",
    source: "https://myherald.io/blog/10-insights-from-the-toolbox",
  });
  assert.throws(
    () => assertPlanClaimsAreSourced(charting(10), [f], ["Teams draft faster. (evidence: Internal cohort.)"]),
    /does not state that number/,
  );
});

test("a spelled-out number does not source a chart", () => {
  // Mirrors an approved fact in the corpus: "The norm is five rounds before approval." The
  // gate reads numerals, so this is refused — a known limit, and the safe direction to fail.
  const f = fact({statement: "The norm is five rounds before approval.", evidence: "BetterBriefs, 2025."});
  assert.throws(
    () => assertPlanClaimsAreSourced(charting(5), [f], ["The norm is five rounds before approval. (evidence: BetterBriefs, 2025.)"]),
    /does not state that number/,
  );
});

test("a German fact sources the value it prints with a decimal comma", () => {
  const f = fact({statement: "Teams sparen 3,4 Stunden pro Tag.", evidence: "Kontent.ai, 2025."});
  const approved = ["Teams sparen 3,4 Stunden pro Tag. (evidence: Kontent.ai, 2025.)"];
  assertPlanClaimsAreSourced(charting(3.4), [f], approved);
  // And the digits alone are not the figure: 34 is a different claim from 3,4.
  assert.throws(() => assertPlanClaimsAreSourced(charting(34), [f], approved), /does not state that number/);
});

test("a number in a chart caption is a claim like any other", () => {
  // The caption is burned in beside the bars, so a figure invented there reads as sourced.
  const p = plan({
    sections: [
      {
        id: "one", kind: "proof", onScreen: "", phrases: [{id: "p1", text: "Look."}],
        data: {shape: "bars", unit: "%", caption: "Across 900 teams", points: [{label: "Q1", value: 40, factId: "f1"}]},
      },
      {id: "two", kind: "payoff", onScreen: "B", phrases: [{id: "p2", text: "x"}]},
    ],
  } as Partial<VideoPlan>);
  assert.throws(
    () => assertPlanClaimsAreSourced(p, [fact()], ["Teams cut drafting time by 40%. (evidence: cohort)"]),
    /no approved fact states it/,
  );
});

test("planClaimText covers chart text that planCopy deliberately does not", () => {
  // planCopy also feeds factIdsUsedByPlan, where a caption would record facts the video never
  // spent — so the two strings are kept apart on purpose.
  const p = charting(40);
  assert.ok(!planCopy(p).includes("Internal cohort"), "planCopy stays narration and display copy");
  assert.ok(planClaimText(p).includes("Internal cohort"), "the caption is claim text");
  assert.ok(planClaimText(p).includes("Q1"), "so is a point label");
});

test("a fact that is only proposed cannot source a chart", () => {
  // The whole point of the state machine. A proposed fact is a candidate, and a candidate
  // on screen as a bar chart reads exactly as authoritative as an approved one.
  const p = plan({
    sections: [
      {
        id: "one", kind: "proof", onScreen: "", phrases: [{id: "p1", text: "Look."}],
        data: {shape: "bars", unit: "%", caption: "src", points: [{label: "A", value: 40, factId: "f1"}]},
      },
      {id: "two", kind: "payoff", onScreen: "B", phrases: [{id: "p2", text: "x"}]},
    ],
  } as Partial<VideoPlan>);
  assert.throws(() => assertPlanClaimsAreSourced(p, [fact({state: "proposed"})], []), /not a usable fact/);
});

test("a numeric fact with no evidence note cannot source a chart either", () => {
  const p = plan({
    sections: [
      {
        id: "one", kind: "proof", onScreen: "", phrases: [{id: "p1", text: "Look."}],
        data: {shape: "bars", unit: "%", caption: "src", points: [{label: "A", value: 40, factId: "f1"}]},
      },
      {id: "two", kind: "payoff", onScreen: "B", phrases: [{id: "p2", text: "x"}]},
    ],
  } as Partial<VideoPlan>);
  assert.throws(() => assertPlanClaimsAreSourced(p, [fact({evidence: ""})], []), /not a usable fact/);
});

test("figures on screen without a source note are refused", () => {
  // Rendered attribution is not optional: a number nobody watching can trace is a number
  // that makes the whole video unciteable, and the composer cannot invent the source.
  const p = plan({
    sections: [
      {
        id: "one", kind: "proof", onScreen: "", phrases: [{id: "p1", text: "Look."}],
        data: {shape: "bars", unit: "%", caption: "   ", points: [{label: "A", value: 40, factId: "f1"}]},
      },
      {id: "two", kind: "payoff", onScreen: "B", phrases: [{id: "p2", text: "x"}]},
    ],
  } as Partial<VideoPlan>);
  assert.throws(
    () => assertPlanClaimsAreSourced(p, [fact()], ["Teams cut drafting time by 40%. (evidence: c)"]),
    /no source note/,
  );
});

test("a bare year is prose, not a statistic", () => {
  // A gate that rejects every date gets switched off, which costs more than the carve-out.
  assert.deepEqual(unverifiedNumbers("Since 2019 the tooling changed.", []), []);
  assert.deepEqual(unverifiedNumbers("Everything after 1998 assumed scarcity.", []), []);
  // Sentence-final and comma-trailing years too. These threw before the tokenizer stopped
  // swallowing punctuation, so only a year sitting mid-sentence ever survived the carve-out.
  assert.deepEqual(unverifiedNumbers("The tooling changed in 2019.", []), []);
  assert.deepEqual(unverifiedNumbers("In 2019, the tooling changed.", []), []);
  // But a year carrying a unit is a measurement again.
  assert.deepEqual(unverifiedNumbers("Up 2019% since launch.", []), ["2019%"]);
});

test("planClaimsViolation collects every problem instead of throwing on the first", () => {
  // What the planner retry needs. Throwing on the numbers meant the model never saw the
  // chart problem, fixed half the plan, and burned a second attempt discovering the rest.
  const p = plan({
    sections: [
      {
        id: "one", kind: "proof", onScreen: "Up 900 teams", phrases: [{id: "p1", text: "Look."}],
        data: {shape: "bars", unit: "%", caption: "src", points: [{label: "A", value: 40, factId: "invented"}]},
      },
      {id: "two", kind: "payoff", onScreen: "B", phrases: [{id: "p2", text: "x"}]},
    ],
  } as Partial<VideoPlan>);

  assert.equal(planClaimsViolation(plan(), [fact()], []), null, "a clean plan has no violation");

  const violation = planClaimsViolation(p, [fact()], []) ?? "";
  assert.match(violation, /no approved fact states it/, "the invented number");
  assert.match(violation, /not a usable fact with evidence/, "and the unresolvable factId");
  const lines = violation.split("\n");
  assert.ok(lines.length >= 2, "both reported in one pass");
  assert.ok(lines.every((line) => line.startsWith("- ")), "bulleted like copyRulesViolation");
});

test("a named period is an axis label, not a measurement", () => {
  // Chart point labels are read for numbers, and "Q1" carries a 1 while claiming nothing.
  assert.deepEqual(unverifiedNumbers("Q1 Q2 Q3 Q4 H1 FY24", []), []);
  // The carve-out is the designator, not the digit: a labelled quantity is still a claim.
  assert.deepEqual(unverifiedNumbers("Q1: 900 teams", []), ["900"]);
});

test("a time of day is scene-setting, not a statistic", () => {
  // Found by running the gate over videos already shipped: one refused a German script on
  // the 16 in "Donnerstag, 16 Uhr", which nobody would quote as a figure.
  assert.deepEqual(unverifiedNumbers("Donnerstag, 16 Uhr", []), []);
  assert.deepEqual(unverifiedNumbers("Thursday, 4pm, still empty", []), []);
  assert.deepEqual(unverifiedNumbers("We meet at 9:30am.", []), []);
  // The carve-out is the clock, not the digits: 16 elsewhere is still a claim.
  assert.deepEqual(unverifiedNumbers("16 teams signed up.", []), ["16"]);
});

test("a figure the copy and the fact punctuate differently is one claim", () => {
  // Every row here threw before, against a fact that stated the number plainly. The gate was
  // comparing a token with its spaces stripped against backing that still had them.
  assert.deepEqual(unverifiedNumbers("Up 40 percent.", ["Drafting fell by 40 percent."]), []);
  assert.deepEqual(unverifiedNumbers("Up 12%.", ["Drafting fell by 12 percent."]), []);
  assert.deepEqual(unverifiedNumbers("1,200 teams joined.", ["1200 teams joined."]), []);
  assert.deepEqual(unverifiedNumbers("It is 3x faster.", ["It is 3 times faster."]), []);
  assert.deepEqual(unverifiedNumbers("1.5 million readers.", ["Reaching 1500000 readers."]), []);
  assert.deepEqual(unverifiedNumbers("Plus 12,5 Prozent.", ["Gestiegen um 12,5 Prozent."]), []);
});

test("a number is not sourced by digits that merely contain it", () => {
  // The other half of the substring bug, and the dangerous half: these passed.
  assert.deepEqual(unverifiedNumbers("Up 40 points.", ["Founded in 1940."]), ["40"]);
  assert.deepEqual(unverifiedNumbers("We saw 10 teams.", ["Across 100 accounts."]), ["10"]);
  // A single digit was exempt outright, on no principle beyond the length of its token.
  assert.deepEqual(unverifiedNumbers("Only 7 teams.", []), ["7"]);
});

test("planCopy covers on-screen and spoken text both", () => {
  // Either one is quotable — a caption is burned in, a narration line is transcribed — so
  // checking only one of them leaves half the surface open.
  const copy = planCopy(plan());
  assert.ok(copy.includes("A") && copy.includes("First line."));
  assert.ok(copy.includes("B") && copy.includes("Second line."));
});

test("an approved fact quoted in narration is recorded even without a chart", () => {
  const cited = fact({
    id: "rounds",
    statement: "The norm is five rounds before approval.",
    evidence: "BetterBriefs source sentence.",
  });
  const p = plan({
    sections: [
      {id: "one", kind: "proof", onScreen: "Five rounds", phrases: [{id: "p1", text: cited.statement}]},
      {id: "two", kind: "payoff", onScreen: "B", phrases: [{id: "p2", text: "Second line."}]},
    ],
  } as Partial<VideoPlan>);

  assert.deepEqual(factIdsUsedByPlan(p, [cited]), ["rounds"]);
});

test("chart citations and exact prose citations are deduplicated", () => {
  const p = plan({
    sections: [
      {
        id: "one", kind: "proof", onScreen: "40% faster",
        phrases: [{id: "p1", text: "Teams cut drafting time by 40%."}],
        data: {shape: "bars", unit: "%", caption: "Source", points: [{label: "After", value: 40, factId: "f1"}]},
      },
      {id: "two", kind: "payoff", onScreen: "B", phrases: [{id: "p2", text: "Second line."}]},
    ],
  } as Partial<VideoPlan>);

  assert.deepEqual(factIdsUsedByPlan(p, [fact()]), ["f1"]);
});
