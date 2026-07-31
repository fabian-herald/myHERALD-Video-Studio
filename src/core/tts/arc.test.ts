import assert from "node:assert/strict";
import {test} from "node:test";
import {arcDirection} from "./energy.ts";
import {buildTakePrompt, buildThoughtLeadershipTakePrompt} from "./gemini.ts";
import type {TakeRequest} from "./provider.ts";

const SHIPPED = ["edge", "settled", "settled", "quiet", "lift", "settled"] as const;

test("the arc names where it opens, turns and lands", () => {
  const arc = arcDirection(SHIPPED);
  assert.match(arc, /^He opens cool and a little clipped/);
  assert.match(arc, /Through the middle/);
  assert.match(arc, /Then the last lines/);
});

test("a held energy is one instruction, not four", () => {
  // Four settled sections in a row must not produce "he is explaining" four times over,
  // which reads as an instruction to keep escalating.
  const arc = arcDirection(["edge", "settled", "settled", "settled", "settled", "lift"]);
  const occurrences = arc.match(/he is explaining/g) ?? [];
  assert.equal(occurrences.length, 1);
});

test("only the changes in the middle are described", () => {
  const arc = arcDirection(SHIPPED);
  // settled, then quiet, then lift — three changes between the opening and the landing.
  assert.match(arc, /he is explaining.*he pulls back.*it opens up/);
});

test("a single-section piece still gets an opening and a landing", () => {
  const arc = arcDirection(["settled"]);
  assert.ok(arc.length > 0);
  assert.doesNotMatch(arc, /Through the middle/, "there is no middle to describe");
});

test("no curve produces no direction rather than an empty sentence", () => {
  assert.equal(arcDirection([]), "");
});

test("the landing comes from the last section that is actually spoken", () => {
  // Every plan ends on a wordless signature card. Left in the curve it decided how the
  // piece lands, sending a take out flat when the last thing said was a lift.
  const spoken = arcDirection(["edge", "settled", "quiet", "lift"]);
  assert.match(spoken, /the point he came to make/);
  const withCard = arcDirection(["edge", "settled", "quiet", "lift", "settled"]);
  assert.doesNotMatch(withCard, /the point he came to make/,
    "this is the wrong arc, and narrate.ts filters wordless sections out before calling");
});

test("the arc never asks for a pace", () => {
  for (const curve of [SHIPPED, ["quiet"], ["lift", "edge", "quiet"]] as const) {
    const arc = arcDirection(curve as never);
    // Asking for speed measured slower than not asking, every time it was tried, and
    // "unhurried" counts — it slipped past a narrower version of this test and produced
    // a 59.5 second read of a script that runs 42.8 without it.
    assert.doesNotMatch(
      arc,
      /\b(quick|quicker|fast|faster|slow|slower|slowly|unhurried|hurried|pace|paced|tempo|linger)\b/i,
      arc,
    );
  }
});

const REQUEST: TakeRequest = {
  text: "Your calendar asks a strange thing.\nPromise Monday what you understand by Thursday.",
  blocks: [
    {direction: "Say flatly and precisely, no warmth", lines: ["Your calendar asks a strange thing."]},
    {direction: "Say with motivation, warmer, convinced", lines: ["Promise Monday what you understand by Thursday."]},
  ],
  voiceId: "Achird",
  style: "Warm, credible, founder-to-founder.",
  register: "one man, low-to-mid register, speaking pitch around 140 hertz",
  arc: arcDirection(SHIPPED),
  language: "en",
  outputPath: "/tmp/take.wav",
};

test("the take prompt carries the register, the arc and every line", () => {
  const prompt = buildTakePrompt(REQUEST);
  assert.match(prompt, /one man, low-to-mid register/);
  assert.match(prompt, /same man from the first line to the last/);
  assert.match(prompt, /He opens cool and a little clipped/);
  assert.match(prompt, /Promise Monday what you understand by Thursday\./);
});

test("the transcript uses the header and colon form the model honours", () => {
  const prompt = buildTakePrompt(REQUEST);
  assert.match(prompt, /## Transcript:/);
  // A direction sits on its own line, ending in a colon, above what it governs.
  assert.match(prompt, /Say flatly and precisely, no warmth:\nYour calendar asks a strange thing\./);
});

test("spoken lines are not quoted", () => {
  // Quoting was tried and reads identically, so it is left out rather than carried.
  const prompt = buildTakePrompt(REQUEST);
  assert.doesNotMatch(prompt, /"Your calendar asks a strange thing\."/);
});

test("the transcript is the last thing in the prompt", () => {
  const prompt = buildTakePrompt(REQUEST);
  // Anything after the lines is something the model has to decide not to read.
  assert.ok(prompt.trimEnd().endsWith("Promise Monday what you understand by Thursday."));
});

test("a section with no direction still contributes its lines", () => {
  const prompt = buildTakePrompt({
    ...REQUEST,
    blocks: [{direction: "", lines: ["Those are not the same unit."]}],
  });
  assert.match(prompt, /## Transcript:\nThose are not the same unit\./);
  assert.doesNotMatch(prompt, /^:$/m, "an empty direction must not leave a bare colon");
});

test("a brand with no register stated says nothing about a speaker", () => {
  const prompt = buildTakePrompt({...REQUEST, register: "   "});
  assert.doesNotMatch(prompt, /He is , and it is/, "an empty register must not leave a stub");
  assert.doesNotMatch(prompt, /same man from the first line/);
});

test("the language is named, so a German video is not read in English", () => {
  assert.match(buildTakePrompt({...REQUEST, language: "de"}), /Language: German\./);
});

test("thought leadership uses the approved B886 profile and only section pause tags", () => {
  const request: TakeRequest = {
    ...REQUEST,
    intent: "thought-leadership",
    blocks: [
      {direction: "", lines: ["Opening thought."]},
      {direction: "", lines: ["The argument develops."]},
      {direction: "", lines: ["Here is the turn."]},
      {direction: "", lines: ["The conclusion lands."]},
    ],
  };
  const prompt = buildTakePrompt(request);
  assert.equal(prompt, buildThoughtLeadershipTakePrompt(request));
  assert.match(prompt, /Thought leadership with calm authority/);
  assert.match(prompt, /Measured forward motion/);
  assert.equal(prompt.match(/\[short pause\]/g)?.length, 3);
  assert.deepEqual(prompt.match(/\[(?:observant|conviction|confident)\]/g), [
    "[observant]", "[conviction]", "[confident]",
  ]);
  assert.doesNotMatch(prompt, /Conviction, never enthusiasm/);
  assert.ok(prompt.trimEnd().endsWith("[confident] The conclusion lands."));
});
