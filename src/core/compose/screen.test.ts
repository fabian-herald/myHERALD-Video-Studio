import assert from "node:assert/strict";
import {test} from "node:test";
import {dataBrief, screenBrief} from "./workdir.ts";
import {dataSeriesZ, screenZ} from "../plan/schema.ts";

test("a focus rect reaches the brief as a percentage of the image", () => {
  // Fractions, not pixels: the same composition is re-emitted at four sizes, and an offset
  // that framed a button in 9:16 frames whitespace in 16:9.
  const brief = screenBrief(screenZ.parse({
    mediaId: "dashboard",
    fit: "browser-chrome",
    focus: [{atMs: 2400, rect: [0.1, 0.25, 0.3, 0.2], label: "Publish"}],
  }));
  assert.ok(brief.includes("media/dashboard.png"), "the id must arrive as a media path");
  assert.ok(brief.includes("+2.40s"), "times are seconds into the section");
  assert.ok(brief.includes("x 10.0%") && brief.includes("h 20.0%"));
  assert.ok(brief.includes("`Publish`"));
  assert.ok(brief.includes(".window-url"), "browser chrome must ask for the real URL");
});

test("a screenshot with no focus rects is told to keep moving", () => {
  // Otherwise it is a still image held for the length of a section, which is both the
  // weakest scene in an explainer and a post-render freeze failure.
  const brief = screenBrief(screenZ.parse({mediaId: "shot"}));
  assert.match(brief, /slow drift/);
});

test("the brief never hands the composer a real filesystem path", () => {
  // The composer sees `media/<id>.png` and the assembler copies the file in under that
  // name. That indirection is what stops a model naming a file outside the library.
  const brief = screenBrief(screenZ.parse({mediaId: "shot", fit: "device-frame"}));
  assert.ok(!brief.includes("/Users/") && !brief.includes("data/media"));
});

test("every charted figure and its source note reach the brief", () => {
  const brief = dataBrief(dataSeriesZ.parse({
    shape: "bars",
    unit: "%",
    caption: "Internal cohort, Q1 2026",
    points: [{label: "Before", value: 62, factId: "f1"}, {label: "After", value: 21, factId: "f2"}],
  }));
  // A symbol unit sits against the figure, because the composer types this verbatim and
  // "62 %" on screen is a typographic error the brief would have handed it.
  assert.ok(brief.includes("Before: **62%**"), brief);
  assert.ok(brief.includes("After: **21%**"), brief);
  assert.ok(brief.includes("Internal cohort, Q1 2026"), "the source note must be rendered, so it must be in the brief");
  assert.ok(brief.includes(".data-source"));
});

test("a word unit keeps its space", () => {
  const brief = dataBrief(dataSeriesZ.parse({
    unit: "hours", caption: "src", points: [{label: "Saved", value: 9, factId: "f1"}],
  }));
  assert.ok(brief.includes("**9 hours**"), brief);
});

test("the shape is offered as a suggestion, not an instruction", () => {
  // The reason this is a `data` payload and not a `diagram` section kind: a kind hands the
  // composer a template to fill, which is the failure the whole architecture escapes.
  const brief = dataBrief(dataSeriesZ.parse({
    shape: "counter", caption: "src", points: [{label: "A", value: 1, factId: "f1"}],
  }));
  assert.match(brief, /choose another form/);
});

test("figures are told to animate in rather than cut in", () => {
  const brief = dataBrief(dataSeriesZ.parse({
    shape: "bars", caption: "src", points: [{label: "A", value: 1, factId: "f1"}],
  }));
  assert.ok(brief.includes("--fill") && brief.includes("counts up"));
});

test("a factId is required by the schema, so an unsourced value cannot be planned", () => {
  assert.throws(() => dataSeriesZ.parse({points: [{label: "A", value: 1}]}));
  assert.throws(() => dataSeriesZ.parse({points: [{label: "A", value: 1, factId: ""}]}));
});

test("focus rect fractions are bounded, so a rect cannot sit outside the image", () => {
  assert.throws(() => screenZ.parse({mediaId: "s", focus: [{atMs: 0, rect: [1.5, 0, 1, 1]}]}));
  assert.throws(() => screenZ.parse({mediaId: "s", focus: [{atMs: -1, rect: [0, 0, 1, 1]}]}));
});
