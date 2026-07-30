import assert from "node:assert/strict";
import {test} from "node:test";
import {NARRATION_COVERAGE_TOLERANCE_MS, narrationCoverageFault} from "./narrate.ts";
import {videoPlanZ, type VideoPlan} from "../plan/schema.ts";

/** A plan whose phrases sit end to end, so the last one ends at `endMs`. */
const planEndingAt = (endMs: number): VideoPlan => videoPlanZ.parse({
  schemaVersion: 1,
  id: "v",
  createdAt: "2026-07-30T00:00:00.000Z",
  brief: "b",
  title: "t",
  thesis: "th",
  intent: "thought-leadership",
  formats: ["9x16"],
  language: "en",
  narration: {provider: "gemini", voice: "Achird"},
  sections: [
    {
      id: "one",
      kind: "hook",
      phrases: [
        {id: "p1", text: "First line.", startMs: 0, durationMs: Math.round(endMs / 2)},
        {id: "p2", text: "Second line.", startMs: Math.round(endMs / 2), durationMs: Math.round(endMs / 2)},
      ],
      startMs: 0,
      durationMs: endMs,
    },
    // Wordless, and deliberately after the last phrase: a signature card holds the frame
    // once the voice has stopped, so the plan legitimately outlasts the speech. Only the
    // last spoken word may be checked against the audio.
    {id: "signature", kind: "outro", phrases: [], startMs: endMs, durationMs: 1600},
  ],
});

test("audio that outlasts the last phrase is fine", () => {
  // The healthy one-take case: the take runs a little past the final word, and the plan's
  // trailing gap sits inside it.
  assert.equal(narrationCoverageFault(planEndingAt(70_800), 71_100), null);
});

test("audio exactly as long as the speech is fine", () => {
  // The healthy per-phrase case: assembleNarration builds the track from the plan, so the
  // two are equal by construction and must not be flagged.
  assert.equal(narrationCoverageFault(planEndingAt(81_340), 81_340), null);
});

test("the real desync is caught", () => {
  // The numbers off the shipped video: retimed to 81.34s against 71.10s of audio, because
  // a stale master handed back the previous take. QC passed it — plan, captions and render
  // all agreed with each other and none of them had heard the sound.
  const fault = narrationCoverageFault(planEndingAt(79_740), 71_100);
  assert.ok(fault, "an 8.6 second desync went unreported");
  assert.match(fault, /71\.10s/);
  assert.match(fault, /79\.74s/);
  assert.match(fault, /8\.64s/, "must say how far out it is, not just that it is out");
  assert.match(fault, /run it again/, "a fault the owner cannot act on is a stack trace");
});

test("slop inside the tolerance is not a fault", () => {
  const plan = planEndingAt(60_000);
  assert.equal(narrationCoverageFault(plan, 60_000 - NARRATION_COVERAGE_TOLERANCE_MS + 1), null);
});

test("one frame past the tolerance is", () => {
  // The boundary is the point of having one: ASR word timings land within tens of
  // milliseconds, so anything beyond half a second is a real mismatch.
  const plan = planEndingAt(60_000);
  assert.ok(narrationCoverageFault(plan, 60_000 - NARRATION_COVERAGE_TOLERANCE_MS - 1));
});

test("a plan with no phrases cannot fault", () => {
  // narrate() rejects this earlier with a clearer message; the check must not throw on the
  // empty spread it would otherwise take a Math.max over.
  const empty = videoPlanZ.parse({
    schemaVersion: 1,
    id: "v",
    createdAt: "2026-07-30T00:00:00.000Z",
    brief: "b",
    title: "t",
    thesis: "th",
    intent: "thought-leadership",
    formats: ["9x16"],
    language: "en",
    narration: {provider: "gemini", voice: "Achird"},
    sections: [
      {id: "one", kind: "hook", phrases: [], startMs: 0, durationMs: 2000},
      {id: "two", kind: "outro", phrases: [], startMs: 2000, durationMs: 2000},
    ],
  });
  assert.equal(narrationCoverageFault(empty, 0), null);
});
