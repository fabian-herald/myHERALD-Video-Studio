import assert from "node:assert/strict";
import {test} from "node:test";
import {renderSummary} from "./summary.ts";
import type {QcReport} from "./qc.ts";

const qc = (passed: boolean): QcReport =>
  ({passed, diagnostics: {failed: passed ? [] : ["noLongFreeze"]}, hashes: {}} as unknown as QcReport);

const full = () => renderSummary({
  provenance: {
    videoId: "2026-08-04-month-later-test-codex-9d42",
    createdAt: "2026-08-04T19:54:43.000Z",
    thesis: "Judge it by whether it still sounds like you.",
    intent: "thought-leadership",
    planner: {provider: "codex", model: "gpt-5.6-terra"},
    marketingGuidance: ["social"],
    composer: {
      provider: "codex", model: "gpt-5.6-terra", effort: "xhigh",
      turns: 12, actions: 44, attempts: 2,
      size: {lines: {"styles.css": 550, "index.html": 179, "animation.js": 187}} as never,
      sizeFinal: {
        lines: {"styles.css": 592, "index.html": 179, "animation.js": 187},
        cssRules: 116, gsapCalls: 100,
      } as never,
    },
    narration: {provider: "gemini", model: "gemini-3.1-flash-tts-preview", voice: "Achird", profileId: "thought-leadership"},
    visualEngine: "HyperFrames",
    hyperframesVersion: "0.7.88",
    formats: ["9x16", "16x9"],
    captionAlignment: "phrase boundaries located in one take; word placement estimated",
    cost: {billingMode: "subscription", chargedUsd: 0, apiEquivalentUsd: 0, entries: []},
    knownLimitations: [],
  },
  title: "The Month-Later Test",
  brief: "Most brands measure AI content by how much they can publish.",
  language: "en",
  sections: 6,
  phrases: 9,
  durationMs: 31900,
  quality: "high",
  outputs: [{format: "9x16", path: "", qc: qc(true)}, {format: "16x9", path: "", qc: qc(false)}],
  timing: {totalMs: 2382426, slowest: {name: "compose", ms: 2193220}},
});

test("the summary answers which model did which part", () => {
  const text = full();
  assert.match(text, /strategy & script\s+codex · gpt-5\.6-terra/);
  assert.match(text, /composition\s+codex · gpt-5\.6-terra · xhigh effort/);
  assert.match(text, /narration\s+gemini · gemini-3\.1-flash-tts-preview · voice Achird/);
  assert.match(text, /renderer\s+HyperFrames 0\.7\.88/);
});

test("it shows both composition sizes when the review pass changed one", () => {
  // The pair is the only way to see whether the composer authored a dense frame or the
  // visual-review pass rescued a thin one. A single number cannot answer that.
  assert.match(full(), /592 css/);
  assert.match(full(), /as authored: 550 css/);
});

test("a failed format says so, and names what failed", () => {
  const text = full();
  assert.match(text, /9x16\s+QC passed/);
  assert.match(text, /16x9\s+QC FAILED — noLongFreeze/);
});

test("the alignment note is trimmed to its first clause", () => {
  // The full string runs to 150 characters and destroys the column layout.
  const line = full().split("\n").find((l) => l.includes("word timings"))!;
  assert.ok(line.length < 100, line);
  assert.doesNotMatch(line, /word placement estimated/);
});

test("a provenance file from before a field existed still renders", () => {
  // This renders historical records as much as new ones. The earliest runs recorded no
  // composer effort, no sizes and no marketing guidance, and a summary that throws on them
  // is worse than the JSON nobody was reading.
  const text = renderSummary({
    provenance: {videoId: "old", createdAt: "2026-07-28T00:00:00.000Z"},
    title: "", brief: "", language: "en",
    sections: 0, phrases: 0, durationMs: 0, quality: "high", outputs: [],
  });
  assert.match(text, /strategy & script\s+—/);
  assert.match(text, /composition\s+—/);
  // And it must not claim a model that was never recorded.
  assert.doesNotMatch(text, /gpt-|claude-|gemini/);
});
