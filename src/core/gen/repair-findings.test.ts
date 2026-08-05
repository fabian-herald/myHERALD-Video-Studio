import assert from "node:assert/strict";
import test from "node:test";
import type {CheckFinding} from "../render/check.ts";
import {formatFindingForRepair} from "./composer.ts";

/**
 * The second party to a collision must reach the composer.
 *
 * `text_occluded` and `content_overlap` are two-element findings. The HyperFrames CLI emits
 * both parties — the flagged element as `selector`, the occluder or the other text block as
 * `containerSelector` — but `runHyperframesCheck` dropped the second one at the CLI boundary,
 * so every repair prompt in this project's history said what broke without saying what broke
 * it. Measured across the corpus in `docs/error-baseline.md`: 68 of 77 layout errors are
 * two-party, and the composer was handed one half of each.
 *
 * These tests pin the repair rendering, which is the only place the composer ever reads a
 * finding from — `formatFindings` renders the message alone, and both the Claude and Codex
 * adapters call `formatFindingForRepair`.
 */

const base: CheckFinding = {
  severity: "error",
  source: "hyperframes",
  message: "layout: Text is hidden beneath an opaque element. at 9.07s",
};

test("an occlusion names the element doing the hiding", () => {
  const line = formatFindingForRepair({
    ...base,
    code: "text_occluded",
    selector: "#scene-hook .kicker",
    containerSelector: "#scene-hook .output-stack",
  });
  assert.match(line, /hidden by: #scene-hook \.output-stack/);
  assert.match(line, /selector: #scene-hook \.kicker/);
});

test("an overlap names the two blocks as peers, not as container and child", () => {
  const line = formatFindingForRepair({
    ...base,
    code: "content_overlap",
    message: "layout: Two text blocks overlap and may render unreadable.",
    selector: "#scene-turn h1",
    containerSelector: "#scene-turn .turn-label",
  });
  assert.match(line, /overlapping: #scene-turn \.turn-label/);
  // "hidden by" would tell the composer to move one specific element; overlap is symmetric.
  assert.doesNotMatch(line, /hidden by/);
});

test("an overflow names the box to fit inside", () => {
  const line = formatFindingForRepair({
    ...base,
    code: "text_box_overflow",
    message: "layout: Text extends outside its nearest visual/container box.",
    selector: "#scene-proof .receipt-note",
    containerSelector: "#scene-proof .receipt-card",
  });
  assert.match(line, /inside: #scene-proof \.receipt-card/);
});

test("a finding with no second party renders exactly as it did before", () => {
  const line = formatFindingForRepair({
    ...base,
    code: "rogue_color",
    selector: "#scene-hook h1",
  });
  assert.equal(
    line,
    "- [error] rogue_color: layout: Text is hidden beneath an opaque element. at 9.07s"
      + " (selector: #scene-hook h1)",
  );
});

test("an unrecognised two-party code still surfaces the second element", () => {
  const line = formatFindingForRepair({
    ...base,
    code: "some_future_code",
    containerSelector: "#scene-x .thing",
  });
  assert.match(line, /other element: #scene-x \.thing/);
});
