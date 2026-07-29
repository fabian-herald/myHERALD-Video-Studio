import assert from "node:assert/strict";
import {test} from "node:test";
import {assertNoUnverifiedNumericClaims, type ProductFact} from "../knowledge/facts.ts";
import {assertPlanClaimsAreSourced, planCopy} from "./claims.ts";
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
  assert.throws(() => assertPlanClaimsAreSourced(p, [], []), /unverified numbers/);
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
  assert.throws(() => assertPlanClaimsAreSourced(withChart("invented"), [fact()], approved), /not an approved fact/);
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
  assert.throws(() => assertPlanClaimsAreSourced(p, [fact({state: "proposed"})], []), /not an approved fact/);
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
  assert.throws(() => assertPlanClaimsAreSourced(p, [fact({evidence: ""})], []), /not an approved fact/);
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
  assertNoUnverifiedNumericClaims("Since 2019 the tooling changed.", []);
  assertNoUnverifiedNumericClaims("Everything after 1998 assumed scarcity.", []);
  // But a year carrying a unit is a measurement again.
  assert.throws(() => assertNoUnverifiedNumericClaims("Up 2019% since launch.", []), /unverified/);
});

test("planCopy covers on-screen and spoken text both", () => {
  // Either one is quotable — a caption is burned in, a narration line is transcribed — so
  // checking only one of them leaves half the surface open.
  const copy = planCopy(plan());
  assert.ok(copy.includes("A") && copy.includes("First line."));
  assert.ok(copy.includes("B") && copy.includes("Second line."));
});
